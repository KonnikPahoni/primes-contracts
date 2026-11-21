import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import * as fs from 'fs';
import * as path from 'path';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger, LedgerOpcodes } from '../wrappers/PrimesLedger';
import { PrimesCollection, CollectionOpcodes, snakeCell } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { PrimesItem } from '../wrappers/PrimesItem';
import sharedParams from '../../shared/params.json';

/**
 * CONCEPT §2 principle 4 — the operator's fee lines, and the standard surface
 * that makes one of them collectable at all.
 *
 * Three things are under test here, and they are grouped because they are the
 * same claim from three angles: the team is paid in fees, those fees are visible
 * on-chain, and none of them is a claim on the ratchet.
 *
 *   1. §3.1's TEP-66 secondary royalty, plus the TEP-62 get-methods it depends
 *      on. A royalty honored by marketplaces earns nothing if no marketplace can
 *      index the collection, so the standard surface is part of the fee line and
 *      not a separate nicety.
 *   2. §4.1's gas-&-ops surplus sweep: permissionless, contract-computed, and
 *      bounded below by a reserve it can never dip into, and since D-117 paid into the ratchet pool, never to a wallet.
 *   3. §6 point 3's genesis-seed guard, which is what makes it safe for minting
 *      to open in the same block as the seed rather than after the auction.
 */

const MINT_PRICE = toNano('1');

const CONTENT_PREFIX = 'https://tonprimes.io/nft/';


/** D-156's cap, from `shared/params.json` — the parameter authority (CLAUDE.md rule 3). */
const S_MAX = BigInt(
    JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'params.json'), 'utf-8'),
    ).rebate.S_MAX_nanoprimes,
);

/**
 * D-156's logistic taper, in the SAME integer order the contract uses — multiply
 * before dividing, one truncation. `donate_floor` is permissionless, so it is a
 * path the cap must not miss; writing the relationship out here rather than a
 * re-measured constant keeps that assertable.
 */
const tapered = (x: bigint, s: bigint): bigint => (s >= S_MAX ? 0n : (x * (S_MAX - s)) / S_MAX);

describe('TON PRIMES — operator fee lines (CONCEPT §2.4, §3.1, §4.1)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    /**
     * D-100 point 6: this now stands in for the GOVERNED TREASURY CONTRACT, not
     * the operator's wallet. The only thing the ledger ever sends it is
     * `forfeit_split_bps` of a §6 point 2 forfeit.
     */
    let treasuryWallet: SandboxContract<TreasuryContract>;
    /**
     * D-100 point 6: the operator's wallet. Since D-152 its only per-mint claim
     * is the 42% remainder of a forfeit (D-166). A THIRD address, distinct from both the
     * treasury and ops, precisely so this suite can tell the fee lines apart by
     * balance delta alone — and so "the operator received nothing" is an
     * assertion this suite can actually make.
     */
    let operatorWallet: SandboxContract<TreasuryContract>;
    let opsWallet: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;
    /** CONCEPT §6: stands in for the auction and the reservation book, which
     *  this suite does not deploy — what it tests is the ledger's own rules. */
    let marketStub: SandboxContract<TreasuryContract>;
    let bookStub: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;
    let ratchetCode: Cell;
    let registrarCode: Cell;

    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
        collectionCode = await compile('PrimesCollection');
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        ledgerCode = await compile('PrimesLedger');
        ratchetCode = await compile('PrimesRatchet');
        registrarCode = await compile('PrimesRegistrar');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        operatorWallet = await blockchain.treasury('operator');
        opsWallet = await blockchain.treasury('ops');
        stranger = await blockchain.treasury('stranger');
        minter = await blockchain.treasury('minter');
        marketStub = await blockchain.treasury("marketStub");
        bookStub = await blockchain.treasury('bookStub');

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                {
                    nextIndex: 2n,
                    itemCode,
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    royaltyNum: 500,
                    royaltyDen: 10000,
                    royaltyDest: treasuryWallet.address,
                    collectionContent: snakeCell('https://tonprimes.io/collection.json'),
                    commonContentPrefix: snakeCell(CONTENT_PREFIX),
                },
                collectionCode
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: master.address,
                        treasuryAddr: treasuryWallet.address,
                        // D-100 point 6: named, and named DIFFERENTLY from the
                        // treasury. The wrapper defaults it to `treasuryAddr`,
                        // which reproduces the pre-D-100 one-wallet behaviour —
                        // and would make every "went to the operator, not the
                        // treasury" assertion below vacuously true.
                        operatorAddr: operatorWallet.address,
                        itemCode,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                ledgerCode
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: deployer.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                },
                ratchetCode
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));
        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, registrarCode)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        await ratchet.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: ledger.address,
            value: toNano('0.05'),
        });
        await registrar.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: ledger.address,
            value: toNano('0.05'),
        });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        await collection.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: ledger.address,
            value: toNano('0.05'),
        });
        await master.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: ledger.address,
            value: toNano('0.05'),
        });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
    });

    /** CONCEPT §6 point 3: T₀ = 200 TON, S₀ = T₀·L·2, p_f0 = 1/20,000 at L = 10,000
     *  (D-41 took the bounty vault to 50% of seeded LP). */
    async function seedGenesis() {
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('200'),
            seedS: 12_000_000_000_000_000n, // 12,000,000 PRIMES at 9 decimals (D-43)
            value: toNano('0.05'),
        });

        // CONCEPT §6 point 0: nothing mints until Unity does. `ignite` mints #1 to the
        // founder and flips the ledger's launch flag; every fixture that mints has to
        // pass through it, exactly as a real deployment does.
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    }

    async function mint(n: bigint, kind: number, factors: { prime: bigint; exponent: number }[]) {
        return ledger.sendMint(minter.getSender(), {
            n,
            kind,
            factors,
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
    }

    // ------------------------------------------------------------------ //
    // 1. §3.1 — the secondary royalty and the surface that makes it real
    // ------------------------------------------------------------------ //

    describe('§3.1 secondary royalty (TEP-66) and the TEP-62 surface it needs', () => {
        it('publishes royalty_params under its EXACT standard name', async () => {
            // The name is the test. Method IDs are derived from the string, so a
            // camelCase getter is invisible to every marketplace on TON.
            const r = await collection.getRoyaltyParams();
            expect(r.numerator).toBe(500);
            expect(r.denominator).toBe(10000);
            expect(r.numerator / r.denominator).toBeCloseTo(0.05, 9);
            // D-128 — the destination is the COLLECTION, because that is where the
            // royalty splits. TEP-66 carries one destination, so pointing it at the
            // operator would make the split undeclarable; `aux.royaltyDest` keeps the
            // operator's half and is what `get_collection_data` still publishes.
            expect(r.destination.toString()).toBe(collection.address.toString());
            expect(r.destination.toString()).not.toBe(treasuryWallet.address.toString());
        });

        it('answers the TEP-66 royalty request message with report_royalty_params', async () => {
            const res = await stranger.send({
                to: collection.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(CollectionOpcodes.GetRoyaltyParams, 32)
                    .storeUint(42, 64)
                    .endCell(),
            });

            expect(res.transactions).toHaveTransaction({
                from: collection.address,
                to: stranger.address,
                success: true,
            });

            const reply = res.transactions
                .flatMap((t) => t.outMessages.values())
                .find((m) => {
                    const s = m.body.beginParse();
                    return s.remainingBits >= 32 && s.preloadUint(32) === CollectionOpcodes.ReportRoyaltyParams;
                });
            expect(reply).toBeDefined();

            const s = reply!.body.beginParse();
            expect(s.loadUint(32)).toBe(CollectionOpcodes.ReportRoyaltyParams);
            expect(s.loadUint(64)).toBe(42); // query id echoed
            expect(s.loadUint(16)).toBe(500);
            expect(s.loadUint(16)).toBe(10000);
            // D-128, and the MESSAGE surface must agree with the get-method above:
            // which of the two a given venue reads is not ours to choose, and a split
            // only half of them route through would be a §9.1 claim that is true on
            // Tuesdays.
            expect(s.loadAddress().toString()).toBe(collection.address.toString());
        });

        it('is a DECLARATION, not an enforced transfer tax — a transfer pays nothing', async () => {
            // §3.1 states this explicitly rather than letting a reader assume the
            // contract enforces it. If this test ever starts failing because a
            // transfer hook was added, §8 has been violated: a hook that can take
            // a cut can also block the transfer, which is an admin lever over
            // other people's property.
            await seedGenesis();
            await mint(2n, 1, []);

            const itemAddr = await collection.getItemAddress(2n);
            const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
            const buyer = await blockchain.treasury('buyer');

            const treasuryBefore = await treasuryWallet.getBalance();
            await item.sendTransfer(minter.getSender(), {
                newOwner: buyer.address,
                value: toNano('0.1'),
            });
            const treasuryAfter = await treasuryWallet.getBalance();

            expect((await item.getNumberData()).owner.toString()).toBe(buyer.address.toString());
            expect(treasuryAfter).toBe(treasuryBefore); // not one nanoTON
        });

        it('exposes get_collection_data / get_nft_address_by_index by their standard names', async () => {
            const cd = await collection.getStandardCollectionData();
            expect(cd.nextItemIndex).toBe(2n);
            // §3.4 / §8: the declared owner is inert — it is the royalty
            // destination and there is no message this contract accepts from it.
            expect(cd.ownerAddress.toString()).toBe(treasuryWallet.address.toString());

            const byIndex = await collection.getNftAddressByIndex(7n);
            const direct = await collection.getItemAddress(7n);
            expect(byIndex.toString()).toBe(direct.toString());
        });

        it('composes get_nft_content from the common prefix and the index', async () => {
            const content = await collection.getNftContent(1234n, beginCell().endCell());
            const s = content.beginParse();
            expect(s.loadUint(8)).toBe(1); // offchain content tag

            const inline = s.loadBuffer(Math.floor(s.remainingBits / 8)).toString('utf8');
            expect(inline).toBe(CONTENT_PREFIX);

            const suffix = s.loadRef().beginParse();
            const suffixText = suffix.loadBuffer(Math.floor(suffix.remainingBits / 8)).toString('utf8');
            expect(suffixText).toBe('1234.json');
        });

        it('generates the index correctly at the digit boundaries', async () => {
            for (const n of [2n, 9n, 10n, 99n, 100n, 1000001n]) {
                const content = await collection.getNftContent(n, beginCell().endCell());
                const s = content.beginParse();
                s.loadUint(8);
                s.loadBuffer(Math.floor(s.remainingBits / 8));
                const suffix = s.loadRef().beginParse();
                const text = suffix.loadBuffer(Math.floor(suffix.remainingBits / 8)).toString('utf8');
                expect(text).toBe(`${n}.json`);
            }
        });

        it('exposes get_nft_data on the item with the collection and owner', async () => {
            await seedGenesis();
            await mint(2n, 1, []);

            const itemAddr = await collection.getItemAddress(2n);
            const item = blockchain.openContract(PrimesItem.createFromAddress(itemAddr));
            const d = await item.getNftData();

            expect(d.init).toBe(-1); // TEP-62 init? is TVM true
            expect(d.index).toBe(2n);
            expect(d.collectionAddress.toString()).toBe(collection.address.toString());
            expect(d.ownerAddress.toString()).toBe(minter.address.toString());
        });
    });

    // ------------------------------------------------------------------ //
    // 2. §4.1 — the gas-&-ops surplus sweep
    // ------------------------------------------------------------------ //

    describe('§4.1 gas-&-ops surplus sweep', () => {
        // Enough to put the ledger over OPS_RESERVE with room to spare, DERIVED from
        // the reserve rather than written down beside it. It was a literal 60 TON,
        // which happened to equal the reserve until D-99 raised the reserve to 92 —
        // `fees.ops_reserve_ton` is a function of the measured per-mint gas draw, and
        // the score put that draw up. Every one of these tests then swept nothing and
        // failed on `expect(quoted).toBeGreaterThan(0n)`, which is a true report of a
        // fixture that had stopped funding what it meant to fund. Deriving it means the
        // next re-derivation moves the fixture with it.
        const OVER_RESERVE = toNano(String(sharedParams.fees.ops_reserve_ton + 20));
        it('reports the sweepable amount and the reserve through a get-method (§9.1)', async () => {
            const s = await ledger.getOpsSweep();
            // OPS_RESERVE is derived (CONCEPT §4.1) — assert against params.json
            // rather than a literal, so the contract and the sim cannot drift.
            expect(s.reserve).toBe(toNano(String(sharedParams.fees.ops_reserve_ton)));
        });

        it('sweeps NOTHING while the balance is under the reserve — and does not throw', async () => {
            // This is the ordinary state, especially early, and it must be a
            // no-op rather than an error: a permissionless function that throws
            // when it has no work invites the caller to read the throw as a
            // broken contract.
            await seedGenesis();
            await mint(2n, 1, []);

            const pendingBefore = await ratchet.getPending();
            expect((await ledger.getOpsSweep()).sweepable).toBe(0n);

            const res = await ledger.sendSweepOps(stranger.getSender(), { value: toNano('0.05') });
            expect(res.transactions).toHaveTransaction({ to: ledger.address, success: true });
            expect(res.transactions).not.toHaveTransaction({ from: ledger.address, to: ratchet.address });
            expect(await ratchet.getPending()).toBe(pendingBefore);
        });

        // D-117 (owner, 2026-09-22): the surplus goes back to the POOL.
        it('D-117: returns the surplus above the reserve to the ratchet pool — pending and T rise by exactly the swept amount, no PRIMES are minted, the reserve survives', async () => {
            await seedGenesis();
            await deployer.send({ to: ledger.address, value: OVER_RESERVE, bounce: false });

            const quoted = (await ledger.getOpsSweep()).sweepable;
            expect(quoted).toBeGreaterThan(0n);
            const pendingBefore = await ratchet.getPending();
            const tBefore = await ledger.getFloorNum();
            const sBefore = await ledger.getFloorDen();
            const sweptBefore = (await ledger.getOperatorTotals()).opsSweptTotal;

            const res = await ledger.sendSweepOps(stranger.getSender(), { value: toNano('0.05') });

            // THE TRACE: one hop to the ratchet, nothing to any wallet, nothing minted, nothing aborted.
            expect(res.transactions).toHaveTransaction({ from: ledger.address, to: ratchet.address, success: true });
            for (const w of [operatorWallet, opsWallet, treasuryWallet, stranger]) {
                expect(res.transactions).not.toHaveTransaction({ from: ledger.address, to: w.address });
            }
            expect(res.transactions).not.toHaveTransaction({ from: ledger.address, to: master.address });
            expect(res.transactions).not.toHaveTransaction({ aborted: true });

            // EXACT: the swept amount lands in `pending` and in `T`, and `S` does not move (k = 0).
            const swept = (await ledger.getOperatorTotals()).opsSweptTotal - sweptBefore;
            // the caller's margin is not folded in (P3.7); only storage rent may shave the quote
            expect(swept).toBeLessThanOrEqual(quoted);
            expect(swept).toBeGreaterThan(quoted - toNano('0.001'));
            expect((await ratchet.getPending()) - pendingBefore).toBe(swept);
            expect((await ledger.getFloorNum()) - tBefore).toBe(swept);
            expect(await ledger.getFloorDen()).toBe(sBefore);

            // and the ledger still holds at least its declared liability + OPS_RESERVE.
            const b = await ledger.getLiabilityBreakdown();
            const balance = (await blockchain.getContract(ledger.address)).balance;
            expect(balance).toBeGreaterThanOrEqual(
                b.tributeOwed + b.unroutedHeld + b.divOutstanding + b.treasuryHeld + b.operatorHeld + toNano(String(sharedParams.fees.ops_reserve_ton))
            );
        });

        /**
         * D-152 (reverses D-100 point 6): the 5% line is the GOVERNED
         * TREASURY's, and the get-method that makes it checkable says where it
         * goes.
         *
         * This is the assertion that would have been vacuous before the
         * operator address existed — with one `treasuryAddr` for both lines,
         * "the 5% went to the operator" and "the 5% went to the treasury" were
         * the same sentence. It is no longer vacuous in the other direction
         * either: the two addresses still differ, and this test is what pins
         * WHICH of them an ordinary mint pays. It is the single assertion that
         * would have caught D-100's re-point drifting away from the documents,
         * and it is the one that must be inverted deliberately — never
         * loosened — if the line is ever re-pointed again.
         */
        it('D-152: the 5% line lands on the GOVERNED TREASURY, and the operator wallet gets nothing from an ordinary mint', async () => {
            await seedGenesis();

            const dests = await ledger.getFeeDests();
            expect(dests.operatorAddr.toString()).toBe(operatorWallet.address.toString());
            expect(dests.treasuryAddr.toString()).toBe(treasuryWallet.address.toString());
            // D-152 moved the 5% line, NOT the forfeit split; D-166 moved the split to 58/42.
            expect(dests.forfeitTreasuryBps).toBe(5800); // params.json genesis.forfeit_split_bps

            const treasuryBefore = await treasuryWallet.getBalance();
            const operatorBefore = await operatorWallet.getBalance();

            // A prime mint cites no factors, so there is no forfeit branch to
            // confuse the two destinations: the ONLY fee send is the 5% line.
            const r = await mint(2n, 1, []);
            const fivePct = toNano(String(sharedParams.mint.treasury_pct));

            expect(r.transactions).toHaveTransaction({
                from: ledger.address,
                to: treasuryWallet.address,
                success: true,
            });
            expect(r.transactions).not.toHaveTransaction({
                from: ledger.address,
                to: operatorWallet.address,
            });
            // V18a: this send now runs SEND_MODE_PAY_FEES_SEPARATELY (the same
            // fix V18 applied to `handleClearingCleared`'s treasury leg), so
            // the network forward fee no longer comes out of the declared
            // 5%. What is left is only the receiving wallet's own
            // compute-phase gas to process the credit — the same
            // unavoidable, much smaller margin V18 documented (measured here
            // at 20,601 nanoton) — so the tolerance tightens from
            // "< 0.001 TON" (which also passed under the old, buggy
            // SEND_MODE_REGULAR forward-fee gap) to an order of magnitude
            // less, tight enough that a regression back to bare
            // SEND_MODE_REGULAR would fail it.
            const treasuryDelta = (await treasuryWallet.getBalance()) - treasuryBefore;
            expect(treasuryDelta).toBeLessThanOrEqual(fivePct);
            expect(fivePct - treasuryDelta).toBeLessThan(toNano('0.00003'));
            // The operator, by contrast, is exact: it received nothing at all.
            // Since D-152 not one nanoTON of an ordinary mint is the
            // operator's — their only per-mint claim is §6 point 2's 42%
            // forfeit remainder, and a prime mint cites no factors to forfeit.
            expect(await operatorWallet.getBalance()).toBe(operatorBefore);
        });

        it('P2.D1: getOperatorTotals is CUMULATIVE — a mint grows operatorPaidTotal, a sweep grows opsSweptTotal, and neither resets or double-counts', async () => {
            await seedGenesis();

            const zero = await ledger.getOperatorTotals();
            expect(zero.operatorPaidTotal).toBe(0n);
            expect(zero.treasuryPaidTotal).toBe(0n);
            expect(zero.opsSweptTotal).toBe(0n);

            // item 4's plain TREASURY_AMOUNT send runs on every mint regardless
            // of kind — a prime mint exercises it with no forfeit-branch noise.
            await mint(2n, 1, []);
            const afterMint = await ledger.getOperatorTotals();
            // D-152: the 5% line is counted under the TREASURY now, and
            // `operatorPaidTotal` stays at zero because nothing was forfeited.
            expect(afterMint.treasuryPaidTotal).toBe(toNano(String(sharedParams.mint.treasury_pct)));
            expect(afterMint.operatorPaidTotal).toBe(0n);
            expect(afterMint.opsSweptTotal).toBe(0n);

            // fund past the reserve and sweep — treasuryPaidTotal must survive
            // untouched, and opsSweptTotal must pick up exactly what the ops
            // wallet actually received (measured by balance delta, not by the
            // pre-sweep quote — `getOpsSweep()` is a view call taken before the
            // sweep's own attached gas lands, so a small forwarding-fee gap is
            // expected here regardless of P3.7's fix below).
            await deployer.send({ to: ledger.address, value: OVER_RESERVE, bounce: false });
            const pendingBefore = await ratchet.getPending();
            await ledger.sendSweepOps(stranger.getSender(), { value: toNano('0.02') });
            const pendingDelta = (await ratchet.getPending()) - pendingBefore;

            const afterSweep = await ledger.getOperatorTotals();
            expect(afterSweep.operatorPaidTotal).toBe(afterMint.operatorPaidTotal);
            expect(afterSweep.treasuryPaidTotal).toBe(afterMint.treasuryPaidTotal);
            // D-117: what the sweep returned to the pool, exactly.
            expect(afterSweep.opsSweptTotal).toBe(pendingDelta);
            expect(pendingDelta).toBeGreaterThan(0n);
        });

        it("P3.7: the swept amount does not depend on the permissionless caller's own attached margin", async () => {
            // Regression for the bug filed as P3.7: `handleSweepOps` used
            // `contract.getOriginalBalance()` as "the balance BEFORE this
            // message's own value was credited", but per the Tolk stdlib that
            // getter returns the balance at the START OF COMPUTE PHASE —
            // which TVM credits the inbound message's value into BEFORE
            // compute phase runs. So the old code swept balance INCLUDING the
            // caller's own attached margin, handing that margin back to the
            // operator instead of leaving it as the caller's change. A caller
            // attaching 1 TON instead of 0.05 TON moved the swept amount by
            // ~0.95 TON. The fix subtracts `in.valueCoins` back out inside
            // `handleSweepOps`; this test proves two sweeps against the same
            // quoted surplus, called with very different margins, pay the
            // same amount to the ops address.
            await seedGenesis();
            await deployer.send({ to: ledger.address, value: OVER_RESERVE, bounce: false });
            const quoted = (await ledger.getOpsSweep()).sweepable;
            expect(quoted).toBeGreaterThan(0n);

            const pendingBefore = await ratchet.getPending();
            // A wildly larger margin than every other sweep test in this file uses.
            await ledger.sendSweepOps(stranger.getSender(), { value: toNano('1') });
            const opsDelta = (await ratchet.getPending()) - pendingBefore;

            // Swept amount tracks the pre-sweep quote, not the quote plus the 1 TON attached.
            expect(opsDelta).toBeLessThanOrEqual(quoted);
            expect(opsDelta).toBeGreaterThan(quoted - toNano('0.001'));

            // The 1 TON margin itself was NOT swept along with the surplus —
            // it sits on the ledger's balance as new sweepable headroom
            // (recoverable by a follow-up call), not lost and not handed to
            // the operator as a side effect of the caller's own gas choice.
            const residual = (await ledger.getOpsSweep()).sweepable;
            expect(residual).toBeGreaterThan(toNano('0.9'));
            expect(residual).toBeLessThan(toNano('1'));
        });

        it('is permissionless — a stranger can call it and it still pays the ratchet pool', async () => {
            await seedGenesis();
            await deployer.send({ to: ledger.address, value: OVER_RESERVE, bounce: false });

            const res = await ledger.sendSweepOps(stranger.getSender(), { value: toNano('0.05') });
            expect(res.transactions).toHaveTransaction({
                from: ledger.address,
                to: ratchet.address,
                success: true,
            });
            // the caller does not get paid for calling; there is no bounty here
            expect(res.transactions).not.toHaveTransaction({
                from: ledger.address,
                to: stranger.address,
            });
        });

        it('carries no amount field — the body is opcode + queryId and nothing else', () => {
            // §8's whole argument rests on this: there is no number in the
            // message for a caller (or an operator) to choose.
            const body = beginCell()
                .storeUint(LedgerOpcodes.SweepOps, 32)
                .storeUint(0, 64)
                .endCell();
            expect(body.bits.length).toBe(96);
        });

        it('reaches no protected pool it could drain: `owed` is on the items, and `pending` only ever RISES by it', async () => {
            // §3.4: `pending` is on the ratchet, `owed` on the items. Since D-117
            // the sweep ADDS to `pending` and can never take from it.
            await seedGenesis();
            await mint(2n, 1, []);
            await deployer.send({ to: ledger.address, value: OVER_RESERVE, bounce: false });

            const pendingBefore = await ratchet.getPending();
            await ledger.sendSweepOps(stranger.getSender(), { value: toNano('0.05') });
            expect(await ratchet.getPending()).toBeGreaterThan(pendingBefore);
    });
    });

    // ------------------------------------------------------------------ //
    // 2b. D-109 — refund a mint's overpayment above the declared margin
    // ------------------------------------------------------------------ //

    describe('D-109 mint overpayment refund', () => {
        const MINT_MARGIN = toNano('0.5');

        it('refunds the overpayment above MINT_PRICE + MINT_MARGIN to the nanoton the contract actually received, and the split on the nominal MINT_PRICE stays byte-identical', async () => {
            await seedGenesis();

            const treasuryBefore = await treasuryWallet.getBalance();
            const operatorBefore = await operatorWallet.getBalance();
            const minterBefore = await minter.getBalance();

            // A fat-fingered 10 TON mint: MINT_PRICE (1) + MINT_MARGIN (0.5) + a
            // 8.5 TON overpayment that must come straight back.
            const overpay = toNano('8.5');
            const sent = MINT_PRICE + MINT_MARGIN + overpay;
            const r = await ledger.sendMint(minter.getSender(), {
                n: 2n,
                kind: 1,
                factors: [],
                referralKey: 0,
                beneficiary: null,
                value: sent,
            });

            // `refund()` sends exactly `valueCoins - MINT_PRICE - MINT_MARGIN`, and
            // `valueCoins` is what the contract receives AFTER TON deducts this
            // message's own forward fee (the same reason `FEE_MARGIN_NANOTON` exists
            // in `webapp/src/chain/values.ts`) — so the refund is a few nanoton under
            // the gross `overpay`, never over it, and the gap is one hop's forward
            // fee, not slippage in the contract's own arithmetic.
            expect(r.transactions).toHaveTransaction({ from: ledger.address, to: minter.address, success: true });
            const minterAfter = await minter.getBalance();
            // The whole 8.5 TON overpayment comes back: the minter's net cost is
            // MINT_PRICE + MINT_MARGIN (what the mint actually keeps) plus dust —
            // one outbound hop's gas and the refund's own forward-fee shortfall —
            // not the full 10 TON sent.
            const netCost = minterBefore - minterAfter;
            expect(netCost).toBeGreaterThanOrEqual(MINT_PRICE + MINT_MARGIN);
            expect(netCost - (MINT_PRICE + MINT_MARGIN)).toBeLessThan(toNano('0.01'));

            // The five-way split still runs on the nominal MINT_PRICE, not on
            // `sent` — the treasury's 5% line is exactly what an ordinary
            // MINT_PRICE mint pays, not 5% of the padded send. V18a: same
            // tightened, receive-compute-only margin as the D-152 test above,
            // now that this send is SEND_MODE_PAY_FEES_SEPARATELY.
            const fivePct = toNano(String(sharedParams.mint.treasury_pct));
            const treasuryDelta = (await treasuryWallet.getBalance()) - treasuryBefore;
            expect(treasuryDelta).toBeLessThanOrEqual(fivePct);
            expect(fivePct - treasuryDelta).toBeLessThan(toNano('0.00003'));
            expect(await operatorWallet.getBalance()).toBe(operatorBefore);
        });

        it('a 1.05 TON send (within the margin) is untouched — no refund at all', async () => {
            await seedGenesis();

            const r = await ledger.sendMint(minter.getSender(), {
                n: 2n,
                kind: 1,
                factors: [],
                referralKey: 0,
                beneficiary: null,
                value: MINT_PRICE + toNano('0.05'), // the webapp's own 1.01 TON, padded further
            });

            expect(r.transactions).not.toHaveTransaction({
                from: ledger.address,
                to: minter.address,
            });
        });

        it('an overpayment too small to pay its own forward fee is dropped, not fatal — the mint still lands (2026-11-20)', async () => {
            // `refund()` sent in mode REGULAR with no IGNORE_ERRORS, so a 1-nanoTON
            // refund failed the ACTION phase: aborted, no bounce, the ledger kept the
            // whole value and the minter card never got its standing back — the same
            // shape as audit R2-L1's invite send, reachable by sending a hair over
            // MINT_PRICE + MINT_MARGIN. The unsendable dust now stays on the ledger,
            // where the gas & ops sweep carries it to the pool like any other.
            await seedGenesis();
            const mint = (value: bigint) =>
                ledger.sendMint(minter.getSender(), { n: 2n, kind: 1, factors: [], referralKey: 0, beneficiary: null, value });
            const arrivedAtLedger = (r: any): bigint =>
                r.transactions.find(
                    (t: any) =>
                        t.inMessage?.info?.type === 'internal' &&
                        t.inMessage.info.dest.equals(ledger.address) &&
                        t.inMessage.body.beginParse().preloadUint(32) === 0x9b000001
                ).inMessage.info.value.coins;

            // The card hop's cost is fixed for a fixed state: measure it, rewind, and aim
            // the ledger's received value at exactly one nanoTON over the kept margin.
            const snap = blockchain.snapshot();
            const probeValue = MINT_PRICE + MINT_MARGIN + toNano('0.1');
            const hop = probeValue - arrivedAtLedger(await mint(probeValue));
            await blockchain.loadFrom(snap);

            const headBefore = await ledger.getHead();
            const r = await mint(MINT_PRICE + MINT_MARGIN + 1n + hop);
            expect(arrivedAtLedger(r)).toBe(MINT_PRICE + MINT_MARGIN + 1n);
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            expect(r.transactions).toHaveTransaction({ to: ledger.address, op: 0x9b000001, success: true });
            expect(r.transactions).not.toHaveTransaction({ from: ledger.address, to: minter.address });
            expect(await ledger.getHead()).toBeGreaterThan(headBefore);
        });
    });

    // ------------------------------------------------------------------ //
    // 3. §6 point 3 — the genesis-seed guard
    // ------------------------------------------------------------------ //

    describe('§6 point 3 genesis seed', () => {
        it('accepts the founder seed once and rejects a second one', async () => {
            await seedGenesis();
            const again = await ledger.sendGenesisSeed(genesisScript.getSender(), {
                seedT: toNano('999'),
                seedS: 1n,
                value: toNano('0.05'),
            });
            expect(again.transactions).toHaveTransaction({
                to: ledger.address,
                success: false,
                exitCode: 104, // already_processed
            });
        });

        it('opens minting in the same block as the seed — no auction required', async () => {
            // The cold start, as a test. Nothing here finalizes an auction lot,
            // and yet the line is open: this is the whole point of CONCEPT §6
            // point 3's founder seed.
            //
            // D-20: `seedGenesis()` here leaves `head` at its deploy default (2),
            // so `mint(2n, ...)` still lands on the ONE race-matched slot the
            // un-walked deploy state happens to leave open. The head is defined
            // over composites (and Unity) only, so a successful mint at n = 2
            // auto-walks past every prime after it — here just 3 — marking each
            // one unsold before landing on the next real composite, 4. This is
            // CONCEPT §6 point 1's "after Unity, 2 and 3 both open at once...
            // 4 is the next number available to build", computed by the walk
            // rather than pre-declared by a K-lot bootstrap.
            await seedGenesis();
            const r = await mint(2n, 1, []);
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            expect(await ledger.getHead()).toBe(4n);
            expect(await ledger.isPrimeUnsold(3n)).toBe(true);
        });

        it('refuses a seed that would erase accrued backing', async () => {
            // Guard on the ASSIGNMENT in GenesisSeed: safe only on a virgin
            // ledger. Under the old ordering that was structural; now that
            // minting opens in the same block, it has to be enforced.
            const led2 = blockchain.openContract(
                PrimesLedger.createFromConfig(
                    {
                        a: {
                            collectionAddr: collection.address,
                            jettonMasterAddr: master.address,
                            treasuryAddr: treasuryWallet.address,
                            itemCode,
                        },
                        b: { genesisScriptAddr: genesisScript.address },
                    },
                    ledgerCode
                )
            );
            await led2.sendDeploy(deployer.getSender(), toNano('10'));
            // T != 0 without going through GenesisSeed is not reachable by a
            // message, so assert the guard's presence via the double-seed path
            // above and the invariant it protects here.
            await seedGenesis();
            expect(await ledger.getFloorNum()).toBe(toNano('200'));
            expect(await ledger.getFloorDen()).toBe(12_000_000_000_000_000n);

            // AND THE FLOOR THE SEED PRODUCES IS THE ONE `params.json` DECLARES.
            //
            // Two things changed here and only one of them is this test's fault.
            // The seed is DERIVED from the file now instead of being a
            // remembered 200 TON: `genesis.deploy_floor_primes_per_ton` moved
            // 60,000 -> 2,857,142.857 when D-100 point 2 replaced D-92's 240 TON
            // genesis donation with 4.20 TON, and a fixture that hard-codes the
            // TON side cannot follow a floor that moves — which is precisely the
            // drift this assertion exists to catch, so it must not itself be a
            // source of it. `seedGenesis()`'s own 200 TON stays where it is: it
            // is a synthetic seed the rest of this file's fee arithmetic is
            // written against, and it never claimed to be the deploy floor.
            // (Real genesis seeds `seedT = 0` and opens `T` with the donation —
            // `genesisPipeline.ts` step 7, D-46.)
            //
            // And the comparison is RELATIVE, not absolute. `toBeCloseTo(x, 6)`
            // asks for six decimal places of ABSOLUTE agreement, which is a
            // meaningful demand at 60,000 and an impossible one at 2.86e6 — the
            // precision happened to fit the old magnitude and said nothing about
            // the property. A ratio against 1 is the same demand at any floor,
            // and it is a stricter one here: 12 places on the ratio is ~1e-6
            // relative, tighter than the old check ever was.
            // The real deploy `S` (D-166's 11,000,000 plus the donation's own mint)
            // against the donation itself: the pair the deploy floor is quoted at.
            const seedS = BigInt(Math.round(sharedParams.genesis.deploy_supply_primes * 1e9));
            const declaredFloorPrimesPerTon = sharedParams.genesis.deploy_floor_primes_per_ton;
            const seedT = toNano(String(sharedParams.genesis.genesis_donation_ton));
            await led2.sendGenesisSeed(genesisScript.getSender(), {
                seedT,
                seedS,
                value: toNano('0.05'),
            });
            const T2 = await led2.getFloorNum();
            const S2 = await led2.getFloorDen();
            expect(T2).toBe(seedT);
            expect(S2).toBe(seedS);
            expect(Number(S2) / Number(T2) / declaredFloorPrimesPerTon).toBeCloseTo(1, 12);

            // The guard itself, on the ledger that was just seeded: a second
            // assignment is refused, which is what "would erase accrued backing"
            // means once `T` and `S` are non-zero.
            const second = await led2.sendGenesisSeed(genesisScript.getSender(), {
                seedT: toNano('999'),
                seedS: 1n,
                value: toNano('0.05'),
            });
            expect(second.transactions).toHaveTransaction({
                to: led2.address,
                success: false,
                exitCode: 104, // already_processed
            });
            expect(await led2.getFloorNum()).toBe(seedT);
            expect(await led2.getFloorDen()).toBe(seedS);
        });
    });

    // ------------------------------------------------------------------ //
    // 4. §6 point 2 — the forfeit clock, and §6 point 3's clearing route
    // ------------------------------------------------------------------ //

    describe('§6 point 2 forfeited tribute / §6 point 3 clearing route', () => {
        // D-20: no longer a fixed pre-deployed set. Named here purely because
        // it is the same six primes a `seedHead: 14n` walk happens to cross —
        // any prime the head has passed and nobody has bought yet forfeits the
        // identical way, six or six hundred.
        const K_LIKE = [2n, 3n, 5n, 7n, 11n, 13n];

        async function expectAllUnsold(unsold: boolean) {
            for (const p of K_LIKE) {
                expect(await ledger.isPrimeUnsold(p)).toBe(unsold);
            }
        }

        /**
         * Genesis as it really deploys: head past the primes below 14, every one
         * of them marked unsold by the walk. D-20 DROPS `unsoldMask` — the walk
         * derives "unsold" from "was crossed and found prime" automatically, so
         * there is nothing left for a caller to declare.
         */
        async function seedWithAuction(seedS: bigint = 4_000_000_000_000_000n) {
            await ledger.sendGenesisSeed(genesisScript.getSender(), {
                seedT: toNano('200'),
                seedS,
                seedHead: 14n,
                value: toNano('0.2'),
            });
            // P2.A7: ONE peer. The book stub and the auction stub used to be two
            // treasuries because they were two contracts; the market is one, so
            // `marketStub` stands in for the whole peer surface.
            await ledger.sendSetPeers(genesisScript.getSender(), {
                marketAddr: marketStub.address,
                bountyVaultAddr: bookStub.address,
                value: toNano('0.05'),
            });
            // CONCEPT §6 point 0: Unity first, then anything mints. Ordered after
            // SetPeers here so the fan-out has somewhere to go, which is the same
            // order a real genesis runs in.
            await ledger.sendIgnite(genesisScript.getSender(), {
                owner: deployer.address,
                value: toNano('0.3'),
            });
        }

        it('sends an unsold prime NOTHING and books the share as forfeited', async () => {
            await seedWithAuction();
            await expectAllUnsold(true);
            expect(await ledger.getForfeited(2n)).toBe(0n);

            const tBefore = await ledger.getFloorNum();
            const sBefore = await ledger.getFloorDen();
            const treasuryBefore = await treasuryWallet.getBalance();
            const operatorBefore = await operatorWallet.getBalance();
            const metersBefore = await ledger.getOperatorTotals();
            // 14 = 2 · 7, so both tribute recipients are unsold genesis primes
            const r = await mint(14n, 0, [
                { prime: 2n, exponent: 1 },
                { prime: 7n, exponent: 1 },
            ]);
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });

            // Not one credit_tribute left the ledger for either prime's item.
            for (const p of [2n, 7n]) {
                expect(r.transactions).not.toHaveTransaction({
                    from: ledger.address,
                    to: await ledger.getItemAddress(p),
                });
            }

            const f2 = await ledger.getForfeited(2n);
            const f7 = await ledger.getForfeited(7n);
            expect(f2).toBeGreaterThan(0n);
            expect(f7).toBeGreaterThan(0n);
            // The whole 80% divisor line is forfeited, nothing is retained: the
            // two shares sum to it, up to the documented rounding remainder that
            // also folds into the pool.
            expect(f2 + f7).toBeGreaterThan(toNano('0.079'));
            expect(f2 + f7).toBeLessThanOrEqual(toNano('0.08'));
            // D-20 point 12: forfeited tribute is REAL FEE REVENUE, sent in the
            // same transaction — it no longer inflates T/the ratchet floor the
            // way it did pre-D-20. T still rises here, but from the mint's OWN
            // pool injection (every composite mint makes one), not from the
            // forfeited share.
            //
            // D-100 point 6 SPLIT IT 80/20 between the governed treasury
            // contract and the operator, D-166 moved it to 58/42 — what
            // D-152 moved is the 5% line, which is why the two meters are read
            // differently here than they used to be: the TREASURY is now the one
            // paid twice (the 5% line and the forfeit's 58%), and the operator's
            // whole meter delta IS its forfeit remainder.
            //
            // The split is asserted on the two CUMULATIVE meters rather than on
            // balances, because the meters are exact: a balance delta is the
            // send value minus the hop's own forwarding fee, so no balance
            // reading can pin a double-paid recipient's share to the nanoTON.
            const forfeitTotal = f2 + f7;
            const meters = await ledger.getOperatorTotals();
            const treasuryTook = meters.treasuryPaidTotal - metersBefore.treasuryPaidTotal;
            const operatorShare = meters.operatorPaidTotal - metersBefore.operatorPaidTotal;
            const fivePct = toNano(String(sharedParams.mint.treasury_pct));
            const treasuryShare = treasuryTook - fivePct;

            // 58% to the treasury contract, as params.json states it (D-166).
            expect(treasuryShare).toBe((forfeitTotal * 5800n) / 10_000n);
            // ...and the remainder — SUBTRACTED, never multiplied a second time,
            // which is why the two sides close to the whole exactly. This is the
            // no-dust-lost assertion: not one nanoTON of the forfeit stayed on
            // the ledger undeclared.
            expect(operatorShare).toBe(forfeitTotal - treasuryShare);
            expect(treasuryShare + operatorShare).toBe(forfeitTotal);
            // and it really is roughly 42%, not merely "whatever is left" of a
            // number that drifted.
            expect(operatorShare * 50n).toBeGreaterThanOrEqual(forfeitTotal * 21n - 50n);
            expect(operatorShare * 50n).toBeLessThanOrEqual(forfeitTotal * 21n + 50n);

            // The money moved to the two real addresses, not just to two
            // counters. V18a: both forfeit legs now run
            // SEND_MODE_PAY_FEES_SEPARATELY too, so the gap left is only the
            // receiving wallet's own compute-phase gas (one hop each,
            // measured at 20,601 nanoton), not a forward fee — the tolerance
            // tightens the same way the operator 5% line's does above, and
            // the treasury leg's forward-fee-era "< 0.001 TON" bound would
            // have passed even a regression back to SEND_MODE_REGULAR, so it
            // was never proof of the fix.
            const treasuryDelta = (await treasuryWallet.getBalance()) - treasuryBefore;
            const operatorDelta = (await operatorWallet.getBalance()) - operatorBefore;
            expect(treasuryTook - treasuryDelta).toBeLessThan(toNano('0.00006')); // two sends, two hops' compute gas
            expect(treasuryDelta).toBeLessThanOrEqual(treasuryTook);
            expect(operatorShare - operatorDelta).toBeLessThan(toNano('0.00003')); // one hop
            expect(operatorDelta).toBeLessThanOrEqual(operatorShare);
            expect(await ledger.getFloorNum()).toBeGreaterThan(tBefore);
            expect(await ledger.getFloorDen()).toBeGreaterThan(sBefore); // the mint's own emission
        });

        it('credits the item normally once the lot has cleared, and stops the counter', async () => {
            await seedWithAuction();
            await mint(14n, 0, [
                { prime: 2n, exponent: 1 },
                { prime: 7n, exponent: 1 },
            ]);
            const forfeitedAt14 = await ledger.getForfeited(2n);

            // D-20: the market reports prime 2's sale with `SettlePrimeClearing`
            // instead of a lane-tagged `ClearingCleared` — this is the message
            // that DEPLOYS item(2) (the ledger mints for every prime now, not
            // just composites) and clears its `unsoldPrimes` entry in the same
            // transaction, both at once, the way a real Dutch-buynow close does.
            const clear = await ledger.sendSettlePrimeClearing(marketStub.getSender(), {
                n: 2n,
                beneficiary: minter.address,
                referralKey: 0,
                value: toNano('1.1'),
            });
            expect(clear.transactions).toHaveTransaction({ to: ledger.address, success: true });
            expect(await ledger.isPrimeUnsold(2n)).toBe(false);
            const item2 = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(2n)));
            expect((await item2.getNumberData()).owner.toString()).toBe(minter.address.toString());

            // 15 = 3 · 5 would not exercise 2; use 16 = 2^4, whose only
            // recipient is the now-sold prime 2.
            await mint(15n, 0, [
                { prime: 3n, exponent: 1 },
                { prime: 5n, exponent: 1 },
            ]);
            const r = await mint(16n, 0, [{ prime: 2n, exponent: 4 }]);
            // The credit is SENT AND SUCCEEDS — item(2) is a real, deployed NFT
            // now (SettlePrimeClearing minted it), unlike the old K-lot design
            // where this suite never deployed the genesis auction's own items.
            expect(r.transactions).toHaveTransaction({
                from: ledger.address,
                to: await ledger.getItemAddress(2n),
                success: true,
            });
            // and the counter froze where it was — a clearing stops the clock,
            // it never rewinds it (§6 point 2, "permanently and visibly").
            // `SettlePrimeClearing` never touches `forfeited` at all, so this is
            // structural rather than merely observed.
            expect(await ledger.getForfeited(2n)).toBe(forfeitedAt14);
            // 3 and 5 are still unsold, so 15's line kept forfeiting
            expect(await ledger.getForfeited(3n)).toBeGreaterThan(0n);
        });

        /**
         * D-91 point 4 — the permissionless floor donation. This is where the
         * DeDust pool's PRIMES side comes from now that D-91 point 1 re-purposed
         * the operator's vest as an operations runway.
         *
         * The claim under test is the one the decision makes: a STRANGER can
         * raise the floor for every holder, with their own TON, and be minted
         * the matching PRIMES to pair with.
         */
        it("a stranger's donation raises p_f for everyone, and mints them the pair side", async () => {
            await seedWithAuction();
            const tBefore = await ledger.getFloorNum();
            const sBefore = await ledger.getFloorDen();
            const seedBefore = await ledger.getSeedT();
            const pendingBefore = await ratchet.getPending();
            // p_f is T/S; compare as a cross-multiplied ratio so no division rounds.
            const donation = toNano('50');
            // D-29's L, params.json genesis.genesis_lp_ratio_primes_per_ton — then
            // D-156's taper, which scales whatever the rate would have emitted.
            const emitted = tapered(donation * 10_000n, sBefore);

            const r = await ledger.sendDonateFloor(stranger.getSender(), {
                amount: donation,
                value: donation + toNano('0.1'),
            });
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });

            const tAfter = await ledger.getFloorNum();
            const sAfter = await ledger.getFloorDen();
            expect(tAfter).toBe(tBefore + donation);
            expect(sAfter).toBe(sBefore + emitted);
            // §5: the floor STRICTLY rose. tAfter/sAfter > tBefore/sBefore.
            expect(tAfter * sBefore).toBeGreaterThan(tBefore * sAfter);
            // The TON really left for the ratchet as `pending` rather than
            // being credited to T and kept here.
            expect(await ratchet.getPending()).toBe(pendingBefore + donation);

            // D-100 point 1 — THE DOUBLE-COUNT, ASSERTED IN THE OTHER
            // DIRECTION. This used to read `expect(getSeedT()).toBe(seedBefore +
            // donation)`, which was the contract's own bug written down as an
            // expectation: the same TON was credited to `seedT` AND forwarded to
            // `pending`, so `T = seedT + swapped + pending` gained 2x the
            // donation on the right against 1x on the left, and the live testnet
            // ratchet panel reported it as `beyond T`. `seedT` is the one-shot
            // genesis credit and nothing else now.
            expect(await ledger.getSeedT()).toBe(seedBefore);
            // ...and the identity itself closes, exactly, after the donation.
            expect(tAfter).toBe(
                (await ledger.getSeedT()) + (await ratchet.getSwapped()) + (await ratchet.getPending())
            );
            // and the donor holds the PRIMES they are meant to pair with.
            const donorWallet = blockchain.openContract(
                PrimesJettonWallet.createFromAddress(await master.getWalletAddress(stranger.address))
            );
            expect((await donorWallet.getWalletData()).balance).toBe(emitted);
        });

        it('the donation is incremental, unlike genesis_seed', async () => {
            await seedWithAuction();
            const seedBefore = await ledger.getSeedT();
            const tBefore = await ledger.getFloorNum();
            const pendingBefore = await ratchet.getPending();
            for (let i = 0; i < 2; i++) {
                const r = await ledger.sendDonateFloor(stranger.getSender(), {
                    amount: toNano('10'),
                    value: toNano('10.1'),
                });
                expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            }
            // D-100 point 1: each tranche lands in `pending`, and `seedT` is
            // untouched however many times the op is called — the incremental
            // claim was the one D-91 made, and it is `T` that is incremental.
            expect(await ledger.getFloorNum()).toBe(tBefore + toNano('20'));
            expect(await ratchet.getPending()).toBe(pendingBefore + toNano('20'));
            expect(await ledger.getSeedT()).toBe(seedBefore);
        });

        /**
         * D-100 point 1 — the rate clamp, at the state that used to throw.
         *
         * `emitted = min(X·L, X·S/T)`. Below `p_f = 1/L` the flat `L` is the
         * smaller of the two and nothing changes; above it, `X·S/T` is smaller
         * and the donor is minted LESS for the same TON. Error 217
         * (`ledger_donation_would_dilute`) used to refuse this transaction
         * outright; D-91's own closing note pre-approved the clamp and D-100
         * point 1 takes it, so the guard has nothing left to guard and is gone.
         *
         * The seed here is the whole setup: `S₀ = 1,000,000 PRIMES` against
         * `T₀ = 200 TON` puts `p_f` at 2e-4, twice `1/L = 1e-4`, which is the
         * side of the boundary the old contract refused to operate on.
         */
        it('D-100 point 1: above 1/L the donation mints at the FLOOR rate instead of throwing 217', async () => {
            await seedWithAuction(1_000_000_000_000_000n);
            const tBefore = await ledger.getFloorNum();
            const sBefore = await ledger.getFloorDen();
            const seedBefore = await ledger.getSeedT();
            // The precondition that used to be fatal, cross-multiplied so no
            // division rounds: p_f = T/S > 1/L  <=>  T·L > S.
            expect(tBefore * 10_000n).toBeGreaterThan(sBefore);

            const donation = toNano('50');
            const flat = tapered(donation * 10_000n, sBefore); // what D-91's fixed rate would have emitted, tapered
            // Rounded DOWN, as the contract does, then tapered by D-156 — the taper is
            // applied AFTER the min(flat, floor) clamp, matching the handler's order.
            const atFloor = tapered((donation * sBefore) / tBefore, sBefore);

            const r = await ledger.sendDonateFloor(stranger.getSender(), {
                amount: donation,
                value: donation + toNano('0.1'),
            });
            // It SUCCEEDS. That is the headline: no 217, no refusal.
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });

            const tAfter = await ledger.getFloorNum();
            const sAfter = await ledger.getFloorDen();
            expect(tAfter).toBe(tBefore + donation);
            // It minted the FLOOR figure, and that is strictly less than the
            // flat rate — the donor pays the current price, not the genesis one.
            expect(sAfter - sBefore).toBe(atFloor);
            expect(atFloor).toBeLessThan(flat);

            // §5's invariant is what the clamp buys: the floor did not fall.
            // Rounding down is why this can be asserted at all — rounding up
            // would emit PRIMES the donation did not back, and this comparison
            // would flip.
            expect(tAfter * sBefore).toBeGreaterThanOrEqual(tBefore * sAfter);

            // Same two D-100 point 1 corrections as the ordinary donation: the
            // TON is `pending`, `seedT` never moves.
            expect(await ledger.getSeedT()).toBe(seedBefore);
            expect(tAfter).toBe(
                (await ledger.getSeedT()) + (await ratchet.getSwapped()) + (await ratchet.getPending())
            );

            // and the donor holds exactly what `S` says was emitted.
            const donorWallet = blockchain.openContract(
                PrimesJettonWallet.createFromAddress(await master.getWalletAddress(stranger.address))
            );
            expect((await donorWallet.getWalletData()).balance).toBe(atFloor);
        });

        it('refuses a donation that did not carry its money (103)', async () => {
            await seedWithAuction();
            const tBefore = await ledger.getFloorNum();
            const r = await ledger.sendDonateFloor(stranger.getSender(), {
                amount: toNano('50'),
                value: toNano('1'),
            });
            expect(r.transactions).toHaveTransaction({ to: ledger.address, exitCode: 103 });
            expect(await ledger.getFloorNum()).toBe(tBefore);
        });

        it('D-114: a clearing splits 50/50 ratchet/treasury — only the ratchet half is backing without emission, S never moves', async () => {
            await seedWithAuction();
            const tBefore = await ledger.getFloorNum();
            const sBefore = await ledger.getFloorDen();
            const pendingBefore = await ratchet.getPending();
            const treasuryBefore = await treasuryWallet.getBalance();

            const amount = toNano('5');
            const ratchetShare = amount / 2n; // PREMIUM_TREASURY_BPS = 5000
            const treasuryShare = amount - ratchetShare;

            await ledger.sendClearingCleared(marketStub.getSender(), {
                prime: 3n,
                amount,
                value: toNano('5.1'),
            });

            // Only the ratchet's half raises T; the treasury half leaves T
            // entirely, the same as a forfeit's treasury share.
            expect(await ledger.getFloorNum()).toBe(tBefore + ratchetShare);
            expect(await ledger.getFloorDen()).toBe(sBefore); // NOT ONE PRIMES EMITTED
            // and the TON really arrived at the ratchet as `pending` (§6 point 3
            // / §11.17), rather than being credited to T and left here.
            expect(await ratchet.getPending()).toBe(pendingBefore + ratchetShare);
            // ...and the other half really left for the governed treasury —
            // close, not exact, the same margin every other send-and-measure
            // assertion in this file allows (see the operator 5% line above).
            // V18: the send now uses PAY_FEES_SEPARATELY so the FORWARD fee no
            // longer comes out of `treasuryShare` (that was a 93935-nanoton
            // leak, not a rounding artefact); what remains is the destination's
            // own unavoidable compute-phase gas for processing the credit,
            // which no send mode can move off the receiver's balance.
            const treasuryDelta = (await treasuryWallet.getBalance()) - treasuryBefore;
            expect(treasuryDelta).toBeLessThanOrEqual(treasuryShare);
            expect(treasuryShare - treasuryDelta).toBeLessThan(toNano('0.001'));
        });

        /**
         * D-20 DELETES `ClearingCleared.lane` — the message is no longer the
         * thing that clears a forfeit entry AT ALL, on any lane. This is the
         * structural replacement for the old lane-gate tests: `clearing_cleared`
         * never touches `unsoldPrimes`, full stop, whether the prime it names
         * is currently unsold (`2`, inside the walked set) or was never marked
         * a prime at all (`9973`, never walked by this suite's `seedHead: 14n`).
         * Only `SettlePrimeClearing` can clear an entry.
         */
        it('a clearing never touches unsold status, for any prime', async () => {
            await seedWithAuction();
            const tBefore = await ledger.getFloorNum();

            await ledger.sendClearingCleared(marketStub.getSender(), {
                prime: 2n,
                amount: toNano('1'),
                value: toNano('1.1'),
            });
            await ledger.sendClearingCleared(marketStub.getSender(), {
                prime: 9973n, // prime, but never walked past by this suite's genesis seed
                amount: toNano('1'),
                value: toNano('1.1'),
            });

            await expectAllUnsold(true);
            expect(await ledger.isPrimeUnsold(9973n)).toBe(false); // never marked in the first place
            // ...and the money half still happened, twice — D-114: only the
            // ratchet's half of each clearing raises T.
            expect(await ledger.getFloorNum()).toBe(tBefore + toNano('1'));
        });

        it('refuses a SettlePrimeClearing from anyone but the market', async () => {
            await seedWithAuction();
            const bad = await ledger.sendSettlePrimeClearing(minter.getSender(), {
                n: 2n,
                beneficiary: minter.address,
                referralKey: 0,
                value: toNano('1.1'),
            });
            expect(bad.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 100 });
            expect(await ledger.isPrimeUnsold(2n)).toBe(true);
        });

        it('refuses a SettlePrimeClearing that did not carry MINT_PRICE', async () => {
            await seedWithAuction();
            const underfunded = await ledger.sendSettlePrimeClearing(marketStub.getSender(), {
                n: 2n,
                beneficiary: minter.address,
                referralKey: 0,
                value: toNano('0.5'),
            });
            expect(underfunded.transactions).toHaveTransaction({
                to: ledger.address,
                success: false,
                exitCode: 103,
            });
            expect(await ledger.isPrimeUnsold(2n)).toBe(true);
        });

        it('refuses a clearing from anyone but the market', async () => {
            await seedWithAuction();
            const tBefore = await ledger.getFloorNum();
            const bad = await ledger.sendClearingCleared(minter.getSender(), {
                prime: 3n,
                amount: toNano('5'),
                value: toNano('5.1'),
            });
            expect(bad.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 100 });
            expect(await ledger.getFloorNum()).toBe(tBefore);
        });

        it('refuses a clearing that did not carry its own money', async () => {
            // The one way this handler could break the §5 ratchet theorem: credit
            // T with backing the ratchet never receives. It is an assert, not a
            // clamp, so the floor can never claim more than it holds.
            await seedWithAuction();
            const tBefore = await ledger.getFloorNum();
            const underfunded = await ledger.sendClearingCleared(marketStub.getSender(), {
                prime: 3n,
                amount: toNano('5'),
                value: toNano('0.2'),
            });
            expect(underfunded.transactions).toHaveTransaction({
                to: ledger.address,
                success: false,
                exitCode: 103,
            });
            expect(await ledger.getFloorNum()).toBe(tBefore);
        });

        /**
         * D-20's headline claim: forfeiture is no longer bounded to a fixed
         * pre-deployed six. `17` was never part of any K-lot — it is simply the
         * next prime the head's forward walk crosses — and it forfeits exactly
         * the same way `2`/`3`/`5`/`7`/`11`/`13` do, the instant a citing
         * composite mints while it is still unsold.
         */
        it('a prime well beyond the old fixed six also forfeits while unsold', async () => {
            // seedHead: 34n walks past every prime below it in ONE genesis
            // message — including 17, 19, 23, 29, 31 — none of which were ever
            // in the retired K = {2,3,5,7,11,13}. 34 = 2 · 17 is composite, so
            // it becomes the new head and the first legal direct mint.
            await ledger.sendGenesisSeed(genesisScript.getSender(), {
                seedT: toNano('200'),
                seedS: 4_000_000_000_000_000n,
                seedHead: 34n,
                value: toNano('0.2'),
            });
            await ledger.sendSetPeers(genesisScript.getSender(), {
                marketAddr: marketStub.address,
                bountyVaultAddr: bookStub.address,
                value: toNano('0.05'),
            });
            await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });

            expect(await ledger.isPrimeUnsold(17n)).toBe(true);
            expect(await ledger.getForfeited(17n)).toBe(0n);

            const r = await mint(34n, 0, [
                { prime: 2n, exponent: 1 },
                { prime: 17n, exponent: 1 },
            ]);
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            // not one credit_tribute left the ledger for 17's (nonexistent) item
            expect(r.transactions).not.toHaveTransaction({
                from: ledger.address,
                to: await ledger.getItemAddress(17n),
            });
            expect(await ledger.getForfeited(17n)).toBeGreaterThan(0n);

            // the market clears it: 17 stops forfeiting, permanently, and the
            // counter it already accrued is untouched (SettlePrimeClearing never
            // writes `forfeited`).
            const forfeitedAt34 = await ledger.getForfeited(17n);
            await ledger.sendSettlePrimeClearing(marketStub.getSender(), {
                n: 17n,
                beneficiary: minter.address,
                referralKey: 0,
                value: toNano('1.1'),
            });
            expect(await ledger.isPrimeUnsold(17n)).toBe(false);
            expect(await ledger.getForfeited(17n)).toBe(forfeitedAt34);
        });
    });
});
