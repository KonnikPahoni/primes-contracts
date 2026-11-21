import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano, Transaction } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet, FLUSH_VALUE } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { PrimesItem } from '../wrappers/PrimesItem';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { acquirePrime, OPENING_HEAD, testMarketConfig } from './helpers/market';
import { ITEM } from '../../shared/opcodes';

function gasUsedOf(tx: Transaction): bigint {
    const cp = (tx.description as any).computePhase;
    if (!cp || cp.type !== 'vm') return 0n;
    return cp.gasUsed as bigint;
}

const MINT_PRICE = toNano('1');
// primes_ratchet.tolk's own FLUSH_PCT/FLUSH_MIN literals — see the identical helper's
// comment in DecompositionSolvency.spec.ts. 541+547's combined premium (~29.87 TON) sits
// above the current 5 TON FLUSH_MIN, so this suite computes which branch it lands on
// instead of assuming full-drain.
const FLUSH_PCT = 200_000_000n; // 0.2, fixed-point
const K_SCALE = 1_000_000_000n;
const FLUSH_MIN = toNano('5');
function flushAmount(pending: bigint): bigint {
    const pctAmount = (pending * FLUSH_PCT) / K_SCALE;
    const candidate = pctAmount > FLUSH_MIN ? pctAmount : FLUSH_MIN;
    return pending < candidate ? pending : candidate;
}

describe('TON PRIMES — genesis + mint flow (Phase 3)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let venueTimelock: SandboxContract<TreasuryContract>;
    let dedustVault: SandboxContract<TreasuryContract>;
    let dedustPool: SandboxContract<TreasuryContract>;
    let primesJettonVault: SandboxContract<TreasuryContract>;
    let minter1: SandboxContract<TreasuryContract>;
    let minter2: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;
    let ratchetCode: Cell;
    let registrarCode: Cell;
    let marketCode: Cell;

    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let market: SandboxContract<PrimesMarket>;

    const gasReport: { entrypoint: string; gasUsed: string; tonCost: string }[] = [];

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
        collectionCode = await compile('PrimesCollection');
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        ledgerCode = await compile('PrimesLedger');
        ratchetCode = await compile('PrimesRatchet');
        registrarCode = await compile('PrimesRegistrar');
        marketCode = await compile('PrimesMarket');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        venueTimelock = await blockchain.treasury('venueTimelock');
        dedustVault = await blockchain.treasury('dedustVault');
        dedustPool = await blockchain.treasury('dedustPool');
        primesJettonVault = await blockchain.treasury('primesJettonVault');
        minter1 = await blockchain.treasury('minter1');
        minter2 = await blockchain.treasury('minter2');

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
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
                        itemCode,
                    },
                    b: {
                        genesisScriptAddr: genesisScript.address,
                    },
                },
                ledgerCode
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));

        // ---- §3.4 B1 decomposition -------------------------------------------
        // `pending` / flush() / the DeDust leg live on the RATCHET now, and the
        // ranks + naming on the REGISTRAR. Both have a circular address
        // dependency with the ledger, so both are deployed without it and linked
        // one-shot (SetLedger x2, then SetSinks). Until SetSinks lands the ledger
        // throws 233 on every mint rather than stranding pool backing.
        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: dedustVault.address,
                    dedustPool: dedustPool.address,
                    primesJettonVault: dedustPool.address,
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
        // ----------------------------------------------------------------------

        // D7 bootstrap: resolve the ledger<->collection/jettonMaster circular address
        // dependency (see primes_collection.tolk header comment).
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });

        // D-20: the market is not optional scenery here — every prime in this
        // suite is BOUGHT off its Dutch lane, because there is no longer any
        // path that mints one at the head.
        market = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({
                    headHint: OPENING_HEAD,
                    ledgerAddr: ledger.address,
                    ratchetAddr: ratchet.address,
                }),
                marketCode
            )
        );
        await market.sendDeploy(deployer.getSender(), toNano('5'));

        // Genesis seed: T/S per shared/params.json's genesis floor ratio.
        // DENOMINATION_PLAN P1 + D-42 — 20,000 PRIMES per TON at L = 10,000 with a
        // 50% bounty vault, so 1000 TON of seed is 15M PRIMES. Must move with `deploy_floor_primes_per_ton` and
        // with export_trace.py's `--seed-s` (SimCrossCheck replays this fixture).
        //
        // D-20: `seedHead` is the FIRST COMPOSITE. The walk to it marks 2 and 3
        // prime, counts both into pi(n) and opens both their forfeit clocks —
        // CONCEPT §6 point 1's "after Unity, 2 and 3 both open at once, and 4 is
        // the next number available to build".
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 20_000_000_000_000_000n, // 20M PRIMES (9 decimals)
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: market.address,
            bountyVaultAddr: treasuryWallet.address,
            value: toNano('0.05'),
        });

        // CONCEPT §6 point 0: nothing mints until Unity does. `ignite` mints #1 to the
        // founder and flips the ledger's launch flag; every fixture that mints has to
        // pass through it, exactly as a real deployment does.
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    async function mintNumber(
        minter: SandboxContract<TreasuryContract>,
        opts: {
            n: bigint;
            kind: number;
            factors: { prime: bigint; exponent: number }[];
            referralKey?: number;
            beneficiary?: Address | null;
        }
    ) {
        const result = await ledger.sendMint(minter.getSender(), {
            n: opts.n,
            kind: opts.kind,
            factors: opts.factors,
            referralKey: opts.referralKey ?? 0,
            beneficiary: opts.beneficiary ?? null,
            value: MINT_PRICE,
        });
        return result;
    }

    /**
     * D-20 — the only way to obtain a prime. `mintNumber(p, kind = 1)` no longer
     * has a referent: `p` is never the head, so the ledger refunds it. The buy
     * runs the identical §4.1 five-way split on the nominal MINT_PRICE via
     * `SettlePrimeClearing`, so everything downstream (tribute, dividends, the
     * ratchet hop, `lastMintTime`) is measured exactly where it was.
     */
    async function acquire(who: SandboxContract<TreasuryContract>, p: bigint) {
        return acquirePrime({ blockchain, market }, who, p);
    }

    it('buys primes 2 and 3 off the Dutch lane, then mints composite 4 = 2^2 with tribute + referral + rebate', async () => {
        // D-20: 2 and 3 are behind the opening head from the first block — the
        // genesis walk marked them — so both are open in the market immediately
        // and 4 is the first number anybody can BUILD.
        expect(await ledger.getHead()).toBe(OPENING_HEAD);
        expect(await ledger.isKnownPrime(2n)).toBe(1);

        const a2 = await acquire(minter1, 2n);
        expect(a2.result.transactions).toHaveTransaction({ to: ledger.address, success: true });
        gasReport.push({
            entrypoint: 'dutch buy (prime, n=2)',
            gasUsed: gasUsedOf(a2.result.transactions[1]).toString(),
            tonCost: 'see docs/phase3-report.md',
        });

        // Buying a prime does not move the head. The head is defined over
        // composites and Unity only, so it sat on 4 before the sale and sits on
        // 4 after it — which is the whole of D-20 point 3 in one assertion.
        expect(await ledger.getHead()).toBe(OPENING_HEAD);

        // WS1 invariant (a): a prime NEVER increases S — §5.1, primes emit
        // nothing, k = 0 unconditionally, no jetton-wallet deploy.
        const sBeforePrime = await ledger.getFloorDen();
        blockchain.now! += 3600; // a saturated k(t) would maximize any illegal emission
        const a3 = await acquire(minter1, 3n);
        expect(a3.result.transactions).toHaveTransaction({ to: ledger.address, success: true });
        expect(await ledger.getHead()).toBe(OPENING_HEAD);
        expect(await ledger.getFloorDen()).toBe(sBeforePrime);

        const floorBefore = { T: await ledger.getFloorNum(), S: await ledger.getFloorDen() };
        const pendingBefore = await ratchet.getPending();

        blockchain.now! += 3600; // let k(t) grow before the next mint
        const r4 = await mintNumber(minter2, { n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 2 }], referralKey: 2 });
        expect(r4.transactions).toHaveTransaction({ to: ledger.address, success: true });
        gasReport.push({
            entrypoint: 'mint (composite, n=4, omega=1)',
            gasUsed: gasUsedOf(r4.transactions[1]).toString(),
            tonCost: 'see docs/phase3-report.md',
        });

        // D-20: minting 4 advances the head PAST every prime it crosses — 5 is
        // prime, so the head lands on 6 and 5 opens in the market in the same
        // transaction. The head is never a prime's position.
        expect(await ledger.getHead()).toBe(6n);

        // tribute §3.2: item(2) accrues the 80% divisor line (sole factor, sole
        // recipient → the whole 0.08); the 20% flat line accrues to div_acc,
        // split across π(4) = 2 — the primes BELOW 4 — at 0.01 each (G79). 5,
        // which this mint's head advance walks past, is counted AFTER the
        // accrual and stamped at it, so it takes nothing from a mint below it.
        const item2Addr = await ledger.getItemAddress(2n);
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(item2Addr));
        const owed2 = await item2.getOwed();
        expect(owed2).toBe(toNano('0.08'));
        expect(await ledger.getPrimesCount()).toBe(3);
        const perPrime = toNano('0.02') / 2n;
        expect(await ledger.getDivAcc()).toBe(perPrime);
        expect(await ledger.getClaimableDividend(2n)).toBe(perPrime);
        expect(await ledger.getClaimableDividend(3n)).toBe(perPrime);
        expect(await ledger.getClaimableDividend(5n)).toBe(0n); // G79: crossed by this mint, stamped after it
        expect(await ledger.getClaimableDividend(4n)).toBe(0n); // composites never share the flat line

        // referral: referral key 2 -> owner of item(2) is minter1 -> should have received ~0.1 TON
        const minter1BalanceTx = r4.transactions.find(
            (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest?.toString() === minter1.address.toString()
        );
        // referral relay is two hops (ledger -> item2 -> minter1); assert the item2 account received the relay
        expect(r4.transactions).toHaveTransaction({ from: ledger.address, to: item2Addr, success: true });

        // pool injection + T/S invariant: T increased by exactly the pool injection line
        // (referred composite mint with 1 tribute recipient covering the full 10% line: 550_000_000 since D-117)
        const floorAfter = { T: await ledger.getFloorNum(), S: await ledger.getFloorDen() };
        const pendingAfter = await ratchet.getPending();
        // ...plus the flat line's indivisible remainder, which §4.1 sends to the
        // POOL. π(4) = 2 divides 0.02 exactly, so here it is zero.
        const divDust = toNano('0.02') - perPrime * 2n;
        expect(divDust).toBe(0n);
        expect(floorAfter.T - floorBefore.T).toBe(550000000n + divDust);
        expect(pendingAfter - pendingBefore).toBe(550000000n + divDust);
        expect(floorAfter.S).toBeGreaterThanOrEqual(floorBefore.S);

        // floor monotone non-decreasing: p_f' = T'/S' > T/S (cross-multiply to avoid fractions)
        expect(floorAfter.T * floorBefore.S).toBeGreaterThan(floorBefore.T * floorAfter.S);
    });

    /**
     * GAUNTLET G89 / D-177 / CONCEPT §9.11 — the item records every referral payout its key
     * relays. Two referred mints cite key 2 (4 = 2², then 6 = 2·3), so item(2) must read back
     * exactly the two `forward_to_owner` values the trace delivered to it: each is §4.1's
     * 0.1 TON referral line less the ledger → item hop's forward fee, which is why the figure
     * is read off the trace rather than hardcoded. An uncited key, item(3), reads 0.
     */
    it('G89: getReferralPaid sums every referral a key relays, and an uncited key reads 0', async () => {
        await acquire(minter1, 2n);
        await acquire(minter1, 3n);
        const item2Addr = await ledger.getItemAddress(2n);
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(item2Addr));
        const item3 = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(3n)));
        expect(await item2.getReferralPaid()).toBe(0n);

        const relayed = (txs: Transaction[]) =>
            txs
                .filter((t) => {
                    const m = t.inMessage;
                    if (m?.info.type !== 'internal' || !m.info.dest.equals(item2Addr)) return false;
                    const body = m.body.beginParse();
                    return body.remainingBits >= 32 && body.loadUint(32) === ITEM.forward_to_owner;
                })
                .reduce((sum, t) => sum + (t.inMessage!.info as { value: { coins: bigint } }).value.coins, 0n);

        const r4 = await mintNumber(minter2, { n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 2 }], referralKey: 2 });
        const r6 = await mintNumber(minter2, {
            n: 6n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 1 }, { prime: 3n, exponent: 1 }],
            referralKey: 2,
        });
        for (const r of [r4, r6]) expect(r.transactions).not.toHaveTransaction({ aborted: true });

        const paid = relayed(r4.transactions) + relayed(r6.transactions);
        expect(paid).toBeGreaterThan(toNano('0.19'));
        expect(paid).toBeLessThanOrEqual(toNano('0.2'));
        expect(await item2.getReferralPaid()).toBe(paid);
        expect(await item3.getReferralPaid()).toBe(0n);
    });

    // CONCEPT.md §9.8 / §9.1: the NFT artwork prints the number's mint date, so the date has
    // to BE chain state — every number the UI shows maps to a public get-method, and a date
    // read only out of an indexer would be the one figure on the tile a reader could not
    // check. Days since the Unix epoch, uint24, written once by `Populate`.
    it('stamps the mint date on the item, once, and publishes it', async () => {
        const item2Addr = await ledger.getItemAddress(2n);
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(item2Addr));

        // Before the mint the item is not deployed at all; 0 is what an unpopulated item
        // reports, and it is what the renderer reads as "no date yet" rather than as 1970.
        await acquire(minter1, 2n);
        const day = await item2.getMintedDay();
        expect(day).toBe(Math.floor(blockchain.now! / 86400));
        expect(day).toBeGreaterThan(0);

        // Write-once. A later mint moves the head past this item and must not touch its date;
        // the `populated == 0` assert in `Populate` is what enforces that, and this is the
        // observable consequence.
        blockchain.now! += 3 * 86400;
        await acquire(minter1, 3n);
        expect(await item2.getMintedDay()).toBe(day);

        // ...and the number minted three days later carries the later date, so the field
        // tracks the mint rather than the deployment.
        const item3 = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(3n)));
        expect(await item3.getMintedDay()).toBe(day + 3);
    });

    // CONCEPT.md §9.1 (ceremony mode): `getK(n, t)` is pure, so the origin of `t` has to be
    // published too or the live rebate clock is an indexer's assertion rather than chain
    // state. 0 is the cold-start sentinel the mint path itself uses, not a timestamp.
    it('publishes lastMintTime, the origin of t for getK', async () => {
        expect(await ledger.getLastMintTime()).toBe(0n);

        await acquire(minter1, 2n);
        const first = await ledger.getLastMintTime();
        expect(first).toBe(BigInt(blockchain.now!));

        blockchain.now! += 3600;
        await acquire(minter1, 3n);
        const second = await ledger.getLastMintTime();
        expect(second).toBe(BigInt(blockchain.now!));
        expect(second).toBeGreaterThan(first);

        // The point of publishing it: an outside reader can now reproduce the very k the
        // next mint would settle at — k(head, now − lastMintTime) — which is what the
        // ceremony surface renders.
        blockchain.now! += 1800;
        const elapsed = BigInt(blockchain.now!) - second;
        expect(elapsed).toBe(1800n);
        const kNow = await ledger.getK(await ledger.getHead(), elapsed);
        const kAtZero = await ledger.getK(await ledger.getHead(), 0n);
        expect(kNow).toBeGreaterThan(kAtZero);
        expect(kNow).toBeLessThan(await ledger.getKMax(await ledger.getHead()));
    });

    it('a mint for an already-taken number refunds the attached value in full (lost race)', async () => {
        // D-20: the race is between two COMPOSITE mints now — a prime is never at
        // the head, so it is never a number two minters can collide on. minter1
        // takes 4 and the head walks past 5 to 6.
        await mintNumber(minter1, { n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 2 }] });
        expect(await ledger.getHead()).toBe(6n);

        // minter2's mint for n=4 lands after head moved on. CONCEPT §8's surviving
        // guarantee with the commit phase gone: losing a race costs gas, never
        // principal.

        const balanceBefore = await minter2.getBalance();
        const result = await ledger.sendMint(minter2.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2 }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        expect(result.transactions).toHaveTransaction({ to: ledger.address, success: true });
        // head must NOT have advanced past 6 from this refunded mint
        expect(await ledger.getHead()).toBe(6n);
        const balanceAfter = await minter2.getBalance();
        // refund = the full MINT_PRICE minus gas; within ~0.05 TON of whole
        const netCost = balanceBefore - balanceAfter;
        expect(netCost).toBeLessThan(toNano('0.05'));
    });

    it('flush() respects cooldown/pct/min guards and preserves T = swapped + pending', async () => {
        // 541 and 547, not 2 and 3: D-68's crown curve prices 2 and 3 at 2500 and
        // 1666 TON — their D-7 premium alone would put pending FOUR orders of
        // magnitude over the guard. 541/547's combined premium (~29.87 TON) is
        // still above the current 5 TON FLUSH_MIN (owner directive, down from
        // 50 TON), so `flushAmount` below computes whichever of the guard's two
        // branches that actually lands on, rather than assuming full-drain.
        await acquire(minter1, 541n);
        blockchain.now! += 3600;
        await acquire(minter2, 547n);

        // flush should fail before cooldown (ratchet_flush_cooldown = 207); genesis lastFlushTime=0 so
        // "now - 0 >= FLUSH_COOLDOWN" is true almost immediately in real time terms since blockchain.now
        // starts far in the future — so cooldown is already satisfied. This test instead checks the
        // pct/min guard against the contract's own formula.
        // §3.4 B1: `pending`, the cooldown and the swap all live on the RATCHET
        // now; T stays on the ledger. `T = swapped + pending` is therefore an
        // identity ACROSS the two contracts, which is exactly what §5 asks the
        // dashboard to render.
        const pendingBefore = await ratchet.getPending();
        expect(pendingBefore).toBeGreaterThan(0n);
        const expectedAmount = flushAmount(pendingBefore);

        const swappedBefore = await ratchet.getSwapped();
        const Tbefore = await ledger.getFloorNum();

        const flushResult = await ratchet.sendFlush(minter1.getSender(), { value: FLUSH_VALUE });
        expect(flushResult.transactions).toHaveTransaction({ to: ratchet.address, success: true });

        const pendingAfter = await ratchet.getPending();
        expect(pendingAfter).toBe(pendingBefore - expectedAmount);

        // T is invariant across flush (T counts at mint time, not at flush — math-note.md §2)
        const Tafter = await ledger.getFloorNum();
        expect(Tafter).toBe(Tbefore);

        // second flush within cooldown must fail (207: ratchet_flush_cooldown)
        const secondFlush = await ratchet.sendFlush(minter1.getSender(), { value: FLUSH_VALUE });
        expect(secondFlush.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 207 });
    });

    it('tribute claim pays the owner and zeroes owed (owed conservation)', async () => {
        await acquire(minter1, 2n);
        blockchain.now! += 10;
        await acquire(minter1, 3n);
        blockchain.now! += 10;
        await mintNumber(minter2, { n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 2 }] });

        const item2Addr = await ledger.getItemAddress(2n);
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(item2Addr));
        const owedBefore = await item2.getOwed();
        expect(owedBefore).toBe(toNano('0.08')); // §3.2: the 80% divisor line; the 20% flat line accrues to div_acc
        expect(await item2.getTributeTotal()).toBe(owedBefore); // §3.2.1: nothing claimed yet, so paid-to-date == owed

        const balanceBefore = await minter1.getBalance();
        const claimResult = await item2.sendClaimTribute(minter1.getSender(), { value: toNano('0.05') });
        expect(claimResult.transactions).toHaveTransaction({ to: ledger.address, success: true });
        expect(claimResult.transactions).toHaveTransaction({ from: ledger.address, to: minter1.address, success: true });

        const owedAfter = await item2.getOwed();
        expect(owedAfter).toBe(0n);
        // §3.2.1: the claim settles `owed`; the paid-to-date counter never moves down.
        expect(await item2.getTributeTotal()).toBe(owedBefore);

        const balanceAfter = await minter1.getBalance();
        // net change = -0.05 TON attached to the claim call + 0.08 TON divisor-line
        // payout from the ledger - gas, so roughly +0.03 TON (the attached call
        // value is not fully forwarded back — see item.tolk's ClaimTribute
        // handler, which forwards a fixed 0.02 TON on to the ledger).
        expect(balanceAfter - balanceBefore).toBeGreaterThan(toNano('0.02'));
    });

    it('B-1: an insolvent ledger refuses the claim (216) and the item\'s own bounce arm restores `owed`', async () => {
        await acquire(minter1, 2n);
        blockchain.now! += 10;
        await acquire(minter1, 3n);
        blockchain.now! += 10;
        await mintNumber(minter2, { n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 2 }] });

        const item2 = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(2n)));
        const owedBefore = await item2.getOwed();
        expect(owedBefore).toBe(toNano('0.08'));
        const tributeOwedBefore = (await ledger.getLiabilityBreakdown()).tributeOwed;

        // The sandbox seam for a state no message reaches: the ledger's balance below
        // what it owes. The REFUSAL and the BOUNCE are then the real contracts' own —
        // `handleClaimTribute`'s 216 and TVM's rich bounce into primes_item.tolk.
        const ledgerAcct = await blockchain.getContract(ledger.address);
        const ledgerBalance = ledgerAcct.balance;
        ledgerAcct.balance = toNano('0.01');

        const balanceBefore = await minter1.getBalance();
        const refused = await item2.sendClaimTribute(minter1.getSender(), { value: toNano('0.05') });
        expect(refused.transactions).toHaveTransaction({ from: item2.address, to: ledger.address, success: false, exitCode: 216 });
        expect(refused.transactions).toHaveTransaction({ from: ledger.address, to: item2.address, inMessageBounced: true, success: true });
        expect(refused.transactions).not.toHaveTransaction({ from: ledger.address, to: minter1.address });
        // the only aborted transaction is the ledger's refusal itself
        expect(refused.transactions.filter((t) => (t.description as any).aborted).length).toBe(1);

        expect(await item2.getOwed()).toBe(owedBefore); // restored, not lost
        expect((await ledger.getLiabilityBreakdown()).tributeOwed).toBe(tributeOwedBefore); // ledger never debited
        expect(await minter1.getBalance()).toBeLessThan(balanceBefore); // paid gas, got no tribute

        // Solvent again, the same claim pays in full — the bounce kept it claimable.
        ledgerAcct.balance = ledgerBalance;
        const ok = await item2.sendClaimTribute(minter1.getSender(), { value: toNano('0.05') });
        expect(ok.transactions).not.toHaveTransaction({ aborted: true });
        expect(ok.transactions).toHaveTransaction({ from: ledger.address, to: minter1.address, success: true });
        expect(await item2.getOwed()).toBe(0n);
        expect((await ledger.getLiabilityBreakdown()).tributeOwed).toBe(tributeOwedBefore - owedBefore);
    });

    it('flat dividend: claim_dividend credits the item, re-stamps, and is a no-op when drained (§3.2)', async () => {
        await acquire(minter1, 2n);
        blockchain.now! += 10;
        await acquire(minter1, 3n);
        blockchain.now! += 10;
        await mintNumber(minter2, { n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 2 }] });

        // G79: π(4) = 2 — 2 and 3, the primes below 4 — so each accrued 0.02 / 2.
        const perPrime = toNano('0.02') / 2n;
        expect(await ledger.getClaimableDividend(2n)).toBe(perPrime);

        const item2Addr = await ledger.getItemAddress(2n);
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(item2Addr));
        const owedBefore = await item2.getOwed();

        // permissionless: minter2 (not the owner) may trigger prime 2's claim
        const claim = await ledger.sendClaimDividend(minter2.getSender(), { p: 2n, value: toNano('0.05') });
        expect(claim.transactions).toHaveTransaction({ from: ledger.address, to: item2Addr, success: true });
        expect(await item2.getOwed()).toBe(owedBefore + perPrime);
        expect(await ledger.getClaimableDividend(2n)).toBe(0n); // re-stamped
        expect(await ledger.getClaimableDividend(3n)).toBe(perPrime); // untouched

        // drained claim is a cheap no-op, not an error
        const again = await ledger.sendClaimDividend(minter2.getSender(), { p: 2n, value: toNano('0.05') });
        expect(again.transactions).toHaveTransaction({ to: ledger.address, success: true });
        expect(await item2.getOwed()).toBe(owedBefore + perPrime);

        // a composite (or unminted number) can never claim: throws 201
        const bad = await ledger.sendClaimDividend(minter2.getSender(), { p: 4n, value: toNano('0.05') });
        expect(bad.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 201 });

        // solvency: the accrued-but-unclaimed dividend is a declared liability
        const solvency = await ledger.getSolvency();
        expect(solvency.delta).toBeGreaterThanOrEqual(0n);
    });

    it('claim_dividend refuses a prime whose Dutch lot is still open (219) — no stranded credit', async () => {
        // Only 3 is bought; 2 stays an open lot, so 2 has no item deployed while
        // still being marked, counted into pi(n) and accruing the flat dividend.
        await acquire(minter1, 3n);
        blockchain.now! += 10;
        await mintNumber(minter2, { n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 2 }] });

        const accrued = await ledger.getClaimableDividend(2n);
        expect(accrued).toBeGreaterThan(0n);
        expect(await ledger.isPrimeUnsold(2n)).toBe(true);

        // Without the guard this re-stamps the entry, bounces off a nonexistent
        // item, and files the amount under `p = 0` where `retry_credit` can
        // never route it — the TON would sit in `unroutedHeld` forever.
        const early = await ledger.sendClaimDividend(minter2.getSender(), { p: 2n, value: toNano('0.05') });
        expect(early.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 219 });
        expect(await ledger.getClaimableDividend(2n)).toBe(accrued); // untouched, not lost
        const held = await ledger.getLiabilityBreakdown();
        expect(held.unroutedHeld).toBe(0n);

        // Buying the lot deploys the item; the whole accrual is then claimable
        // by its new owner, exactly as if it had been deferred.
        await acquire(minter1, 2n);
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(2n)));
        const owedBefore = await item2.getOwed();
        const late = await ledger.sendClaimDividend(minter2.getSender(), { p: 2n, value: toNano('0.05') });
        expect(late.transactions).toHaveTransaction({ from: ledger.address, to: item2.address, success: true });
        expect(await item2.getOwed()).toBe(owedBefore + accrued);
    });

    it('GAUNTLET B1.1: claim_dividend refuses an underfunded send instead of draining the ledger', async () => {
        await acquire(minter1, 2n);
        blockchain.now! += 10;
        await acquire(minter1, 3n);
        blockchain.now! += 10;
        await mintNumber(minter2, { n: 4n, kind: 0, factors: [{ prime: 2n, exponent: 2 }] });
        expect(await ledger.getClaimableDividend(2n)).toBeGreaterThan(0n);

        // Below CLAIM_DIVIDEND_MIN_VALUE (0.01 TON): refused before any state changes,
        // never a partial drain of the ledger's own balance.
        const underfunded = await ledger.sendClaimDividend(minter2.getSender(), { p: 2n, value: toNano('0.004') });
        expect(underfunded.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 103 });
        expect(await ledger.getClaimableDividend(2n)).toBeGreaterThan(0n); // untouched — no re-stamp happened

        // Funded at exactly CLAIM_DIVIDEND_MIN_VALUE, the whole D-188 round trip
        // (ledger -> item credit_dividend -> ledger dividend_credited) runs on the
        // claimant's value with a clean trace, and both meters move.
        const before = await ledger.getLiabilityBreakdown();
        const claimable = await ledger.getClaimableDividend(2n);
        const ok = await ledger.sendClaimDividend(minter2.getSender(), { p: 2n, value: toNano('0.01') });
        expect(ok.transactions).not.toHaveTransaction({ success: false });
        expect(ok.transactions).toHaveTransaction({ to: ledger.address, success: true, op: 0xb000000e });
        expect(await ledger.getClaimableDividend(2n)).toBe(0n);
        const after = await ledger.getLiabilityBreakdown();
        expect(after.divOutstanding).toBe(before.divOutstanding - claimable);
        expect(after.tributeOwed).toBe(before.tributeOwed + claimable);
    });

    it('rejects a composite mint with wrong factorization (bank_bad_factorization)', async () => {
        // D-20: the head opens on 4, so 4 is the number to lie about. 2*2*2 = 8,
        // not 4 — the product check has to catch it.
        const result = await ledger.sendMint(minter2.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 3 }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        expect(result.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 201 });
        expect(await ledger.getHead()).toBe(OPENING_HEAD); // unchanged
    });

    it('rejects a composite mint referencing a non-prime number as a "factor" (bank_bad_factorization)', async () => {
        // The head opens on 4 (D-20). Try to mint it by claiming itself (4, never
        // marked prime — it's composite) as its own sole factor. Product check
        // (4^1 == 4) passes, but the prime-bitmap check must reject it.
        const result = await ledger.sendMint(minter1.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 4n, exponent: 1 }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        expect(result.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 201 });
        expect(await ledger.getHead()).toBe(OPENING_HEAD); // unchanged
    });

    it('gas snapshot table', () => {
         
        console.table(gasReport);
        expect(gasReport.length).toBeGreaterThan(0);
    });
});
