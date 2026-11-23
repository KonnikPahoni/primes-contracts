// TON PRIMES — §3.4 decomposition: the one-get-call solvency property, the
// §4.3.1 floor guard, and get_flush_status (UPGRADE_PLAN_V5.md §4 B1 + B3).
//
// Three things are asserted here that no other suite covers:
//
//   1. **`balance ~= its own declared liability` in ONE get-call**, on every one
//      of the four contracts the decomposition produces. §3.4 calls this the
//      property the separation exists to produce; Phase D renders it (D7). The
//      test deliberately calls exactly one get-method per contract and reads the
//      triple straight out of it — if the property needed two calls and a
//      subtraction, it would not be the property §3.4 asks for.
//
//   2. **The floor guard's arithmetic**, against an independently recomputed
//      `amount * S / T * (1 + FLOOR_GUARD)`. The test also asserts the thing
//      that actually bites (§10): that the multiply happens BEFORE the divide.
//      The naive `(amount / T) * S` order truncates to zero at every realistic
//      (amount, T), which would silently reproduce the `storeCoins(1)` bug the
//      guard exists to fix — so the test computes that wrong order too and
//      requires the contract NOT to match it.
//
//   3. **get_flush_status across all three outcomes** — never / filled /
//      bounced. §12 makes this non-optional: without it a dead venue hides
//      behind months of legitimate-looking non-execution.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet, FlushOutcome, FLUSH_VALUE } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { testMarketConfig, RESERVABLE_12, acquirePrime, OPENING_HEAD, winLot, BID_GAS } from './helpers/market';
import { PrimesItem } from '../wrappers/PrimesItem';

const MINT_PRICE = toNano('1');
const FLUSH_COOLDOWN = 86400;
const K_SCALE = 1_000_000_000n;
// primes_ratchet.tolk's PHASE A placeholder. Kept in sync deliberately: when the
// Phase A agent changes the one line in the contract, this line fails and points
// at itself, rather than the guard silently drifting from its own test.
const FLOOR_GUARD = 0n;
// primes_ratchet.tolk's own FLUSH_PCT/FLUSH_MIN literals. `CHEAP_PRIME`'s actual
// premium (~26 GRAM) sits ABOVE the current 5 GRAM FLUSH_MIN — a hardcoded
// "amount == pending" full-drain assumption is what broke when FLUSH_MIN moved
// from 50 to 5 GRAM (owner directive), so the tests below compute the guard's own
// `amount = min(pending, max(FLUSH_PCT*pending, FLUSH_MIN))` from whichever
// branch the live `pending` actually lands on, instead of assuming one.
const FLUSH_PCT = 200_000_000n; // 0.2, fixed-point
const FLUSH_MIN = toNano('5');
function flushAmount(pending: bigint): bigint {
    const pctAmount = (pending * FLUSH_PCT) / K_SCALE;
    const candidate = pctAmount > FLUSH_MIN ? pctAmount : FLUSH_MIN;
    return pending < candidate ? pending : candidate;
}

describe('TON PRIMES — §3.4 decomposition: solvency, floor guard, flush status', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let timelockWallet: SandboxContract<TreasuryContract>;
    let dedust: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;
    let reserver: SandboxContract<TreasuryContract>;
    /** Stands in for the ratchet's own PRIMES jetton wallet — the one sender whose
     *  transfer_notifications the burn counter is allowed to believe (§3.3). */
    let burnWallet: SandboxContract<TreasuryContract>;

    let codes: Record<string, Cell>;
    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let book: SandboxContract<PrimesMarket>;

    /** When true, the venue is a contract that throws — every flush bounces. */
    async function deployAll(venueThrows: boolean) {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        timelockWallet = await blockchain.treasury('timelock');
        dedust = await blockchain.treasury('dedust');
        burnWallet = await blockchain.treasury('ratchetJettonWallet');
        minter = await blockchain.treasury('minter', { balance: toNano('100000') });
        reserver = await blockchain.treasury('reserver', { balance: toNano('500') });

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                {
                    nextIndex: 2n,
                    itemCode: codes.item,
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                },
                codes.collection
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                {
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    walletCode: codes.jettonWallet,
                },
                codes.jettonMaster
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
                        itemCode: codes.item,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                codes.ledger
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));

        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, codes.registrar)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        // The bounced-flush case needs a venue that actually throws. The
        // registrar is exactly that for any body it does not recognise
        // (`assert (in.body.isEmpty()) throw 101`), it is already deployed, and
        // it is bounceable — so it stands in for a dead or refusing DeDust vault
        // without a bespoke mock whose bounce behaviour we would have to trust.
        const venue = venueThrows ? registrar.address : dedust.address;

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: timelockWallet.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: venue,
                    dedustPool: dedust.address,
                    primesJettonVault: dedust.address,
                },
                codes.ratchet
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        book = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({
                    headHint: OPENING_HEAD,
                    ledgerAddr: ledger.address,
                    ratchetAddr: ratchet.address,
                }),
                codes.market
            )
        );
        await book.sendDeploy(deployer.getSender(), toNano('5'));

        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
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
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: book.address,
            bountyVaultAddr: treasuryWallet.address,
            value: toNano('0.05'),
        });
        // CONCEPT §6 point 0: nothing mints until Unity does. `ignite` mints #1 to the
        // founder and flips the ledger's launch flag; every fixture that mints has to
        // pass through it, exactly as a real deployment does.
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    }

    async function mint(n: bigint, kind: number, factors: FactorEntry[]) {
        return await ledger.sendMint(minter.getSender(), {
            n,
            kind,
            factors,
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
    }

    /**
     * D-20: a prime is BOUGHT off the Dutch lane, never minted at the head. The
     * ledger's `SettlePrimeClearing` handler runs the same §4.1 five-way split on
     * the nominal MINT_PRICE that a composite mint runs, so every ratchet-hop,
     * registrar-hop and `pending` assertion below is measuring exactly what it
     * measured before — it just gets there the way the design now says it does.
     */
    async function acquire(p: bigint) {
        return (await acquirePrime({ blockchain, market: book }, minter, p)).result;
    }

    /**
     * Two ORDINARY primes, for the tests whose subject is the flush guard rather
     * than the price. D-68's crown curve prices 2 at 2500 GRAM and 3 at 1666 GRAM,
     * and D-7 routes the whole premium to `pending` — so `acquire(2n)` now lands
     * `pending` two orders of magnitude ABOVE `FLUSH_MIN` and silently moves any
     * test that assumed the full-drain branch onto the pct branch instead. 541 is
     * the first prime D-68 leaves ordinary, so its premium is the ~4 GRAM these
     * tests always assumed. Where the prime's identity IS the subject (2 as a
     * factor of 4, the registrar's rank), 2 and 3 stay.
     */
    const CHEAP_PRIME = 541n;
    const CHEAP_PRIME_2 = 547n;

    beforeAll(async () => {
        codes = {
            item: await compile('PrimesItem'),
            collection: await compile('PrimesCollection'),
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ledger: await compile('PrimesLedger'),
            ratchet: await compile('PrimesRatchet'),
            registrar: await compile('PrimesRegistrar'),
            market: await compile('PrimesMarket'),
        };
    });

    // -----------------------------------------------------------------------
    // B1 — the one-get-call solvency property, on all four contracts
    // -----------------------------------------------------------------------

    it('B1: every contract answers `balance vs its own declared liability` in ONE get-call', async () => {
        await deployAll(false);
        await acquire(2n);
        blockchain.now! += 60;
        await acquire(3n);
        blockchain.now! += 60;
        await mint(4n, 0, [{ prime: 2n, exponent: 2 }]);

        // A won lot. D-90: this MINTS in the close transaction rather than
        // creating an escrowed claim — which is exactly why the escrow leg is no
        // longer one of the contracts checked below. §3.4's decomposition is two
        // pools now, `pending` and `owed`, and this settlement runs the ordinary
        // §4.1 split into both of them like any other mint.
        //
        // The MARKET is the fourth check: it holds every open lot's standing
        // high bid, so its declared liability must track that bid through
        // open -> outbid -> close, and fall back to zero once the lot mints.
        const opened = await winLot({ blockchain, market: book }, reserver, RESERVABLE_12, { openOnly: true });
        let mkt = await book.getSolvency();
        expect(mkt.liability).toBe(opened.price);
        expect(mkt.delta).toBe(mkt.balance - mkt.liability);
        expect(mkt.delta).toBeGreaterThanOrEqual(0n);

        const outbid = (await book.getLot(RESERVABLE_12.n)).minPayment + toNano('0.1');
        await book.sendBid(minter.getSender(), { n: RESERVABLE_12.n, beneficiary: null, referralKey: 0, value: outbid });
        mkt = await book.getSolvency();
        expect(mkt.liability).toBe(outbid - BID_GAS); // the outbid bid was refunded, not kept on the books; V23 keeps BID_GAS
        expect(mkt.delta).toBeGreaterThanOrEqual(0n);

        blockchain.now = (await book.getLot(RESERVABLE_12.n)).closesAt + 1;
        const closed = await book.sendClose(reserver.getSender(), { n: RESERVABLE_12.n, value: toNano('0.3') });
        expect(closed.transactions).not.toHaveTransaction({ on: book.address, aborted: true });
        mkt = await book.getSolvency();
        expect(mkt.liability).toBe(0n); // minted, premium forwarded on SettleConfirmed
        expect(mkt.delta).toBeGreaterThanOrEqual(0n);

        // ---- ONE get-call per contract. That is the whole point. ----
        const led = await ledger.getSolvency();
        const rat = await ratchet.getSolvency();
        const reg = await registrar.getSolvency();

        for (const [name, s] of [
            ['ledger', led],
            ['ratchet', rat],
            ['registrar', reg],
        ] as const) {
            // the get-method returns the delta itself; the caller does not have
            // to know how to compute it
            expect({ name, delta: s.delta }).toEqual({ name, delta: s.balance - s.liability });
            // solvent: the contract can cover everything it says it owes
            expect({ name, solvent: s.delta >= 0n }).toEqual({ name, solvent: true });
        }

        // and each liability is the RIGHT one, not a placeholder zero.
        // With the commit phase gone the ledger holds no deposits, so its whole
        // declared liability is §3.2's tribute line, in both its halves — and
        // both halves are money the ledger CUSTODIES, not money it forwarded:
        //
        //   * the 80% divisor line (0.08 per composite mint), credited to the
        //     cited prime's item as `owed` while the GRAM stays here. B-1: this
        //     term used to be missing, and this assertion used to read a bare
        //     0.02 — which is precisely how an under-declared liability hides.
        //     `sweep_ops` measures its surplus above this number.
        //   * the 20% flat dividend (0.02 per composite mint), accrued against
        //     `div_acc` and not yet claimed.
        //
        // The flat half is `floor(0.02 / pi) * pi`, not a flat 0.02, and the gap
        // is the point rather than an approximation: §3.2's flat line is divided
        // among the primes eligible for it and the ledger declares only what it
        // can actually pay out. G79: pi is counted BEFORE the mint's head walk, so
        // minting 4 divides by the 2 primes below it (0.02 exactly), and 5 — which
        // that walk crosses — joins pi only afterwards. By 12's close pi = 3, so
        // 0.02 does not divide evenly and 2 nanoton of dust stays with the pool,
        // undeclared because it is owed to nobody.
        //
        // D-90: there are TWO composite mints in this fixture now, not one —
        // minting 4 directly at the head, and winning 12's lot, which mints in
        // its own close transaction instead of parking an escrowed claim.
        //
        // The divisor line has its OWN dust term on the second mint, for the
        // same reason: 12 = 2^2 · 3 weights its two factors 2 and 1, and 0.08
        // does not divide by 3 either, so one more nanoton folds into the pool.
        // Both dust terms are bounded and both are asserted rather than rounded
        // away — a divisor line that lost more than its divisor's worth would be
        // a real leak.
        const pi = BigInt(await ledger.getPrimesCount());
        expect(pi).toBe(3n);
        const flat4 = toNano('0.02'); // pi = 2 at 4's mint
        const flat = (toNano('0.02') / pi) * pi; // pi = 3 at 12's close
        const divisorDust = 2n * toNano('0.08') - (await ledger.getLiabilityBreakdown()).tributeOwed;
        expect(led.liability).toBe(2n * toNano('0.08') + flat4 + flat - divisorDust);
        expect(toNano('0.02') - flat).toBeLessThan(pi); // flat dust, bounded by pi(n)
        expect(divisorDust).toBeLessThan(3n); // divisor dust, bounded by sumWeights
        // and the same number, itemized — the sum is the liability by
        // construction, so this is the get-method a reader reconciles against
        // `Σ_p get_owed(p)` rather than a restatement of the line above.
        const br = await ledger.getLiabilityBreakdown();
        expect(br.tributeOwed + br.unroutedHeld + br.divOutstanding + br.treasuryHeld + br.operatorHeld).toBe(
            led.liability
        );
        expect(br.tributeOwed).toBe(2n * toNano('0.08') - divisorDust);
        expect(br.unroutedHeld).toBe(0n);
        expect(br.divOutstanding).toBe(flat4 + flat);
        expect(rat.liability).toBe(await ratchet.getPending());
        expect(rat.liability).toBeGreaterThan(0n);
        expect(reg.liability).toBe(0n); // registrar custodies no protocol GRAM, structurally
        // THE ESCROW LEG IS GONE (D-90.3), and its absence is the assertion.
        // There is no fourth contract holding refundable customer money, so
        // §3.4's decomposition is `pending` (the ratchet, nobody's) and `owed`
        // (the ledger, the prime owners') — the two checked above.
        // The market's check is above: with no lot open, it owes nobody anything.
        expect((await book.getMarketStats()).closedLots).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // B-1 — the tribute divisor line is a REAL liability on the ledger, and the
    // ledger must say so.
    //
    // §3.2's 80% divisor line is credited to the cited prime's item as a
    // *number* (`credit_tribute` carries CREDIT_TRIBUTE_VALUE of gas and an
    // `amount` field, never the amount itself). The item does `owed += amount`;
    // the GRAM stays here, and `claim_tribute` pays it out of THIS contract's
    // balance. §3.4's table says so in as many words — "Ledger ... GRAM it
    // holds: accrued tribute ... whose it is: the prime owners'".
    //
    // So `Sum_p item.owed` is money owed to named counterparties, and it belongs
    // in the declared liability alongside the bounced-credit retry lane and the
    // accrued flat dividend. These two tests are the pin: the first says the
    // ledger declares it, the second says the ops sweep cannot take it.
    // -----------------------------------------------------------------------

    /** Every prime the fixture below credits tribute to, and what it is owed. */
    async function owedOn(primes: bigint[]) {
        let total = 0n;
        for (const p of primes) {
            const item = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(p)));
            total += await item.getOwed();
        }
        return total;
    }

    /** acquire 2 and 3 off the Dutch lane (so neither forfeits), then mint 4 = 2^2. */
    async function mintOneComposite() {
        await deployAll(false);
        await acquire(2n);
        blockchain.now! += 60;
        await acquire(3n);
        blockchain.now! += 60;
        await mint(4n, 0, [{ prime: 2n, exponent: 2 }]);
    }

    it('B-1: accrued tribute is a DECLARED liability — getSolvency covers every credited `owed`', async () => {
        await mintOneComposite();

        // 4 = 2^2 cites exactly one factor, and 2 is sold, so the whole 80%
        // divisor line lands on item(2) as `owed`. No forfeit, no rounding
        // remainder to share with a second factor.
        const owed = await owedOn([2n]);
        expect(owed).toBe(toNano('0.08'));

        const sol = await ledger.getSolvency();
        // The ledger is holding that 0.08 right now — `credit_tribute` moved a
        // number, not the money. If the liability does not cover it, the
        // contract is telling an auditor it owes less than it owes.
        expect(sol.liability).toBeGreaterThanOrEqual(owed);
        // and it is on top of the flat dividend, not instead of it: the two
        // halves of §3.2's 80/20 split are separate obligations.
        // G79: the accrual divides by pi BEFORE the head walk — the 2 primes below 4.
        expect(sol.liability).toBe(owed + toNano('0.02'));
        expect(sol.delta).toBeGreaterThanOrEqual(0n);
    });

    it('B-1: the ops sweep cannot take accrued tribute — the surplus is measured ABOVE it', async () => {
        await mintOneComposite();
        const owed = await owedOn([2n]);
        expect(owed).toBeGreaterThan(0n);

        // Arm the sweep. `sweep_ops` is permissionless and pays `balance -
        // liability - OPS_RESERVE` into the pool, so an under-declared liability
        // would move player money into the floor.
        await deployer.send({ to: ledger.address, value: toNano('80'), bounce: false });

        const before = await ledger.getSolvency();
        const s = await ledger.getOpsSweep();
        expect(s.sweepable).toBeGreaterThan(0n); // armed, so the assertion below bites
        expect(s.sweepable).toBeLessThanOrEqual(before.balance - owed - s.reserve);

        const tBefore = await ledger.getFloorNum();
        const pendingBefore = await ratchet.getPending();
        const r = await ledger.sendSweepOps(minter.getSender(), { value: toNano('0.05') });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        // D-117: the surplus went to the POOL — T and pending rise together by
        // exactly the quoted amount, so T = seeded + swapped + pending stays exact.
        const tRise = (await ledger.getFloorNum()) - tBefore;
        expect((await ratchet.getPending()) - pendingBefore).toBe(tRise);
        expect(tRise).toBeLessThanOrEqual(s.sweepable); // storage rent may shave the quote
        expect(tRise).toBeGreaterThan(s.sweepable - toNano('0.001'));

        // and after the sweep has taken everything it may, the
        // tribute is still here for the owner of 2 to claim.
        const after = await ledger.getSolvency();
        expect(after.balance).toBeGreaterThanOrEqual(await owedOn([2n]));
        expect(after.delta).toBeGreaterThanOrEqual(0n);
    });

    it('B1: T = swapped + pending holds ACROSS the ledger/ratchet split, per §5', async () => {
        await deployAll(false);
        const t0 = await ledger.getFloorNum();
        await acquire(CHEAP_PRIME);
        blockchain.now! += 60;
        await acquire(CHEAP_PRIME_2);

        const T = await ledger.getFloorNum();
        expect(T).toBeGreaterThan(t0);
        // genesis seeds T without any GRAM on the ratchet (the LP leg put it in
        // the pool, not on this contract), so the identity is over the DELTA
        // since genesis, which is what the dashboard actually renders.
        expect((await ratchet.getSwapped()) + (await ratchet.getPending())).toBe(T - t0);

        const pendingBefore = await ratchet.getPending();
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(await ratchet.getPending()).toBe(pendingBefore - flushAmount(pendingBefore));
        expect((await ratchet.getSwapped()) + (await ratchet.getPending())).toBe(T - t0);
    });

    it("CLAUDE.md invariant #2: S is unchanged immediately before/after a flush() and its burn", async () => {
        // P0.6/P3.2: the T/S cross-check above (and DecompositionSolvency's own WS1/
        // §3.3 burn-wallet tests) prove S is unchanged as a SIDE EFFECT of asserting
        // something else. This test isolates the claim itself, by name, so it survives
        // if those other tests are ever refactored: S must not move across a flush,
        // on either side of it.
        await deployAll(false);
        await acquire(2n);
        blockchain.now! += 60;
        await acquire(3n);

        const sBeforeFlush = await ledger.getFloorDen();
        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(r.transactions).not.toHaveTransaction({ success: false });
        expect(await ledger.getFloorDen()).toBe(sBeforeFlush);

        // The flush's own burn leg (the DeDust-swap proceeds notified back and burned,
        // §3.3) is a separate transaction on the ratchet's jetton wallet — S must stay
        // put across that too, not just across the flush message itself.
        await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
            jettonWalletAddr: burnWallet.address,
            value: toNano('0.05'),
        });
        const sBeforeBurn = await ledger.getFloorDen();
        await burnWallet.send({
            to: ratchet.address,
            value: toNano('0.1'),
            body: beginCell()
                .storeUint(0x7362d09c, 32)
                .storeUint(1n, 64)
                .storeCoins(toNano('50'))
                .storeAddress(burnWallet.address)
                .storeRef(beginCell().endCell())
                .endCell(),
        });
        expect(await ledger.getFloorDen()).toBe(sBeforeBurn);
        expect(await ledger.getFloorDen()).toBe(sBeforeFlush);
    });

    it("CLAUDE.md invariant #3: T moves inside handleMint and is untouched by handleFlush", async () => {
        // P0.6/P3.3: the `T = swapped + pending` IDENTITY is already tested (B1
        // above), but "incremented at mint, not at flush" is a TIMING claim the
        // identity alone doesn't pin down — a build that moved the increment into
        // handleFlush could still satisfy the identity by construction. This test
        // isolates the timing: T must change across a mint, and must NOT change
        // across a flush that follows it, checked as two separate before/after reads.
        await deployAll(false);
        const t0 = await ledger.getFloorNum();

        await acquire(2n);
        const tAfterMint = await ledger.getFloorNum();
        expect(tAfterMint).toBeGreaterThan(t0); // T moves at mint

        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(r.transactions).not.toHaveTransaction({ success: false });
        expect(await ledger.getFloorNum()).toBe(tAfterMint); // T untouched by flush

        // And the reverse holds too: a second mint after the flush moves T again,
        // from wherever the flush left it — the flush is not itself a T-moving event
        // on either side of it.
        blockchain.now! += 60;
        await acquire(3n);
        expect(await ledger.getFloorNum()).toBeGreaterThan(tAfterMint);
    });

    it('B1: the ledger refuses to mint before SetSinks rather than stranding pool backing', async () => {
        await deployAll(false);
        // A second ledger with NO sinks configured. `treasuryAddr` differs from
        // the wired one on purpose: init data determines the address, so an
        // identical config would resolve to the already-wired contract and the
        // test would silently assert nothing.
        const lonely = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: master.address,
                        treasuryAddr: deployer.address,
                        itemCode: codes.item,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                codes.ledger
            )
        );
        await lonely.sendDeploy(deployer.getSender(), toNano('20'));
        expect((await lonely.getSinks()).sinksSet).toBe(0);

        const r = await lonely.sendMint(minter.getSender(), {
            n: 2n,
            kind: 1,
            factors: [],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        // CONCEPT §6 point 0 now refuses one step EARLIER than §3.4 B1's sinks
        // guard did: an unwired ledger is also an unignited one, so the mint dies
        // on `ledger_not_launched` (212) before it can reach the
        // `ledger_sinks_unset` (233) inside `forwardToRatchet`. The guarantee
        // this test exists for — pool backing is never stranded by a mint on an
        // unwired ledger — is unchanged and now doubly enforced.
        expect(r.transactions).toHaveTransaction({ to: lonely.address, success: false, exitCode: 212 });

        // And the launch itself is what carries the sinks guard now: a ledger
        // with no ratchet to inject into cannot be started at all, so 233 is
        // asserted here rather than being left unreachable.
        const ign = await lonely.sendIgnite(genesisScript.getSender(), {
            owner: deployer.address,
            value: toNano('0.3'),
        });
        expect(ign.transactions).toHaveTransaction({ to: lonely.address, success: false, exitCode: 233 });
        expect((await lonely.getLaunch()).launched).toBe(false);
    });

    it('B1: a prime mint names on the item and ranks on the ledger — and sends the registrar nothing (D-202)', async () => {
        await deployAll(false);

        const r2 = await acquire(2n);
        // D-202 deleted `record_mint`: its one reader was the build clock.
        expect(r2.transactions).not.toHaveTransaction({ from: ledger.address, to: registrar.address });
        // D-212: the pen is the item's CURRENT OWNER, read off the item (no namer stored)...
        const item2 = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(2n)));
        expect((await item2.getNamer())!.toString()).toBe(minter.address.toString());
        // ...and the rank is the ledger's own `minterState`, which the registrar used to mirror.
        expect((await ledger.getMinterState(minter.address)).primesMinted).toBe(1);

        blockchain.now! += 60;
        await acquire(3n);
        expect((await ledger.getMinterState(minter.address)).primesMinted).toBe(2);

        // a COMPOSITE must not reach the registrar (the common mint path carries no hop).
        blockchain.now! += 60;
        const r = await mint(4n, 0, [{ prime: 2n, exponent: 2 }]);
        expect(r.transactions).not.toHaveTransaction({ from: ledger.address, to: registrar.address });
        const item4 = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(4n)));
        // D-212: a composite is nameable too — its pen is its owner, like a prime's.
        expect((await item4.getNamer())!.toString()).toBe(minter.address.toString());
    });

    it('B1: only the ledger may inject into the ratchet', async () => {
        await deployAll(false);
        const inject = await ratchet.sendPoolInject(minter.getSender(), {
            amount: toNano('1'),
            tSnapshot: toNano('1'),
            sSnapshot: 1n,
            value: toNano('2'),
        });
        expect(inject.transactions).toHaveTransaction({ to: ratchet.address, success: false, exitCode: 100 });
    });

    // -----------------------------------------------------------------------
    // B3 — the floor guard
    // -----------------------------------------------------------------------

    it('B3: min_out = amount * S / T * (1 + FLOOR_GUARD), multiplied before divided', async () => {
        await deployAll(false);
        await acquire(CHEAP_PRIME);
        blockchain.now! += 60;
        await acquire(CHEAP_PRIME_2);
        blockchain.now! += 60;
        await mint(4n, 0, [{ prime: 2n, exponent: 2 }]);

        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        const cache = await ratchet.getFloorCache();
        // the pushed mirror is the ledger's authoritative pair, not a stale one
        expect(cache.t).toBe(T);
        expect(cache.s).toBe(S);

        const pending = await ratchet.getPending();
        expect(pending).toBeGreaterThan(0n);
        const amount = flushAmount(pending); // whichever branch this pending lands on

        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });

        const base = (amount * S) / T; // multiply FIRST, divide ONCE
        const expected = base + (base * FLOOR_GUARD) / K_SCALE;
        expect(await ratchet.getLastMinOut()).toBe(expected);

        // the guard must be a real reservation price, not the old `storeCoins(1)`
        expect(await ratchet.getLastMinOut()).toBeGreaterThan(1n);

        // ...and specifically NOT the divide-first order, which truncates to
        // zero at every realistic (amount, T) and would silently reproduce the
        // bug. This is the §10 arithmetic warning, as an assertion.
        const wrongOrder = (amount / T) * S;
        expect(wrongOrder).toBe(0n);
        expect(await ratchet.getLastMinOut()).not.toBe(wrongOrder);
    });

    it('B3: the guard is priced from S and T in their own nano-units, with no stray 1e9', async () => {
        await deployAll(false);
        await acquire(CHEAP_PRIME);
        const T = await ledger.getFloorNum();
        const S = await ledger.getFloorDen();
        const amount = flushAmount(await ratchet.getPending());
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        const minOut = await ratchet.getLastMinOut();

        // min_out is denominated in nano-PRIMES: it is `amount` nanotons bought
        // at the floor price p_f = T / S. Equivalently, the implied price
        // amount/min_out must equal T/S to within one unit of rounding. A stray
        // 1e9 in either direction would blow this by nine orders of magnitude.
        expect(minOut * T).toBeLessThanOrEqual(amount * S);
        expect((minOut + 1n) * T).toBeGreaterThan(amount * S);
    });

    // -----------------------------------------------------------------------
    // B3 — get_flush_status, all three outcomes (§12: non-optional)
    // -----------------------------------------------------------------------

    it('B3: get_flush_status reports NEVER before any attempt', async () => {
        await deployAll(false);
        const st = await ratchet.getFlushStatus();
        expect(st.outcome).toBe(FlushOutcome.Never);
        expect(st.lastAttemptTime).toBe(0);
        expect(st.amount).toBe(0n);
        // "never" must not look like "cooling down": a fresh contract whose
        // lastFlushTime is 0 would otherwise report a huge negative cooldown or
        // a full one, and a reader could not tell it apart from a dead venue.
        expect(st.cooldownRemaining).toBe(0);
    });

    it('B3: get_flush_status reports FILLED, with amount and a live cooldown', async () => {
        await deployAll(false);
        await acquire(CHEAP_PRIME);
        const pending = await ratchet.getPending();

        const flushAt = blockchain.now!;
        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(r.transactions).toHaveTransaction({ from: ratchet.address, to: dedust.address, success: true });

        const st = await ratchet.getFlushStatus();
        expect(st.outcome).toBe(FlushOutcome.Filled);
        expect(st.lastAttemptTime).toBe(flushAt);
        expect(st.amount).toBe(flushAmount(pending));
        expect(st.cooldownRemaining).toBe(FLUSH_COOLDOWN);

        // the cooldown counts down against wall time, so a reader can tell
        // "cooling down" from "dead" without a second call
        blockchain.now! += 3600;
        expect((await ratchet.getFlushStatus()).cooldownRemaining).toBe(FLUSH_COOLDOWN - 3600);
        blockchain.now! += FLUSH_COOLDOWN;
        expect((await ratchet.getFlushStatus()).cooldownRemaining).toBe(0);
    });

    it('GAUNTLET B2.1: inFlightFlush clears on the FILLED path once the swap proceeds notify', async () => {
        await deployAll(false);
        await acquire(2n);

        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(r.transactions).toHaveTransaction({ from: ratchet.address, to: dedust.address, success: true });
        expect((await ratchet.getFlushStatus()).outcome).toBe(FlushOutcome.Filled);
        // Before the wired wallet notifies, FILLED is still provisional — non-zero
        // is the "still open" reading the handleFlush comment promises.
        const inFlight = await ratchet.getInFlightFlush();
        expect(inFlight).toBeGreaterThan(0n);

        // `from` is the wallet sending the notification; `jettonSender` is the
        // TEP-74 `sender` field inside it — who moved the PRIMES.
        const notify = (amount: bigint, from: SandboxContract<TreasuryContract>, jettonSender = from.address) =>
            from.send({
                to: ratchet.address,
                value: toNano('0.1'),
                body: beginCell()
                    .storeUint(0x7362d09c, 32)
                    .storeUint(1n, 64)
                    .storeCoins(amount)
                    .storeAddress(jettonSender)
                    .storeRef(beginCell().endCell())
                    .endCell(),
            });
        const minOut = await ratchet.getLastMinOut();

        // An unauthenticated (unwired, or forged) notification must NOT clear it —
        // the opposite failure mode from the one being fixed: a forger flipping a
        // still-open round trip to "closed" ahead of the real fill.
        await notify(minOut, minter, dedust.address);
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);

        await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
            jettonWalletAddr: burnWallet.address,
            value: toNano('0.05'),
        });
        await notify(minOut, minter, dedust.address); // still forged post-wiring: wrong wallet
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);

        // The REAL wallet, carrying a STRANGER's transfer: the wallet is honest, the
        // swap is not ours. This used to clear the tracker, so a refusal landing
        // next was stranded in the gas buffer instead of restored to `pending`.
        const stranger = await blockchain.treasury('primes-stranger');
        const strangerNote = await notify(minOut, burnWallet, stranger.address);
        expect(strangerNote.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);
        // Right vault, but below the swap's own `limit` — DeDust never fills there.
        await notify(minOut - 1n, burnWallet, dedust.address);
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);

        // The real wallet, paid by DeDust's PRIMES vault, at least `limit`: THIS is
        // the fill signal. Closes the round trip; FILLED is no longer provisional.
        await notify(minOut, burnWallet, dedust.address);
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect((await ratchet.getFlushStatus()).outcome).toBe(FlushOutcome.Filled);
    });

    // -----------------------------------------------------------------------
    // GAUNTLET A3.2 — `getFloorOracle`, the one-call external-risk-engine
    // oracle `docs/floor-as-collateral.md` names, had no test pinning its
    // shape or values (its TS wrapper was deliberately dropped from
    // production code by P2.C3, but the on-chain get-method — and now this
    // test-only wrapper — stay).
    // -----------------------------------------------------------------------

    it('A3.2: getFloorOracle mirrors getFloorCache/getPending/getSwapped/getFlushStatus exactly', async () => {
        await deployAll(false);
        await acquire(2n);
        blockchain.now! += 60;
        await acquire(3n);

        const flushAt = blockchain.now!;
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });

        const cache = await ratchet.getFloorCache();
        const pending = await ratchet.getPending();
        const swapped = await ratchet.getSwapped();
        const status = await ratchet.getFlushStatus();
        const oracle = await ratchet.getFloorOracle();

        expect(oracle).toEqual({
            t: cache.t,
            s: cache.s,
            pending,
            swapped,
            lastOutcome: status.outcome,
            lastAttemptTime: status.lastAttemptTime,
        });
        // a filled flush leaves a live signal on every field, not a fixture of zeros
        expect(oracle.t).toBeGreaterThan(0n);
        expect(oracle.s).toBeGreaterThan(0n);
        expect(oracle.swapped).toBeGreaterThan(0n);
        expect(oracle.lastOutcome).toBe(FlushOutcome.Filled);
        expect(oracle.lastAttemptTime).toBe(flushAt);
    });

    it('WS1: the proceeds leg — a transfer_notification is answered with a TEP-74 burn of exactly the notified amount', async () => {
        await deployAll(false);
        await acquire(2n);
        const pendingBefore = await ratchet.getPending();
        const solBefore = await ratchet.getSolvency();

        // the (simulated) jetton wallet notifies the ratchet of swap proceeds
        const notified = toNano('123.456');
        const r = await minter.send({
            to: ratchet.address,
            value: toNano('0.1'),
            body: beginCell()
                .storeUint(0x7362d09c, 32) // TEP-74 transfer_notification
                .storeUint(7n, 64) // queryId
                .storeCoins(notified)
                .storeAddress(minter.address)
                .storeRef(beginCell().endCell())
                .endCell(),
        });

        // outbound: one TEP-74 burn, back to the notifying sender, same amount
        const burnTx = r.transactions.find(
            (t) =>
                t.inMessage?.info.type === 'internal' &&
                t.inMessage.info.src?.toString() === ratchet.address.toString() &&
                t.inMessage.body.beginParse().loadUint(32) === 0x595f07bc
        );
        expect(burnTx).toBeDefined();
        const body = burnTx!.inMessage!.body.beginParse();
        body.loadUint(32); // opcode
        expect(body.loadUintBig(64)).toBe(7n); // queryId passthrough
        expect(body.loadCoins()).toBe(notified); // burn EXACTLY what was notified

        // §3.3: S untouched, pool backing untouched, solvency delta not reduced
        // (the burn rides the notification's own gas, never the balance)
        expect(await ratchet.getPending()).toBe(pendingBefore);
        const solAfter = await ratchet.getSolvency();
        expect(solAfter.delta >= solBefore.delta).toBe(true);
    });

    it('§3.3: the burn counter measures the wired wallet only, and says so when it is not wired', async () => {
        await deployAll(false);
        await acquire(2n);

        // Unwired: the ratchet still burns (the leg above is unchanged), but it counts
        // nothing and reports `counting = 0` — a floor, not a measurement. The dashboard
        // renders that as unavailable rather than as "0 burned", so the two must be
        // distinguishable from outside (CONCEPT §3.3 / §11.21).
        const cold = await ratchet.getBurnStats();
        expect(cold.counting).toBe(0);
        expect(cold.burnedPrimes).toBe(0n);

        // The jetton-level sender is the venue's PRIMES vault (`dedust` here): since the
        // 2026-11-08 audit only swap proceeds count, never a holder's own transfer.
        const notify = (amount: bigint, from: SandboxContract<TreasuryContract>) =>
            from.send({
                to: ratchet.address,
                value: toNano('0.1'),
                body: beginCell()
                    .storeUint(0x7362d09c, 32)
                    .storeUint(1n, 64)
                    .storeCoins(amount)
                    .storeAddress(dedust.address)
                    .storeRef(beginCell().endCell())
                    .endCell(),
            });

        // A forged notification from an arbitrary sender is still answered with a burn
        // order — deliberately, since it can only burn the forger's own tokens — but it
        // must not move a number published as measured.
        await notify(toNano('10'), minter);
        expect((await ratchet.getBurnStats()).burnedPrimes).toBe(0n);

        // Arm it, one-shot, genesis script only.
        const bad = await ratchet.sendSetJettonWallet(minter.getSender(), {
            jettonWalletAddr: minter.address,
            value: toNano('0.05'),
        });
        expect(bad.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 100 });

        await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
            jettonWalletAddr: burnWallet.address,
            value: toNano('0.05'),
        });
        const armed = await ratchet.getBurnWallet();
        expect(armed.walletSet).toBe(1);
        expect(armed.jettonWalletAddr.toString()).toBe(burnWallet.address.toString());

        // Now the real wallet's notifications count, and only those.
        await notify(toNano('123.456'), burnWallet);
        await notify(toNano('7'), minter); // forged again, after arming
        const hot = await ratchet.getBurnStats();
        expect(hot.burnedPrimes).toBe(toNano('123.456'));
        expect(hot.burnEvents).toBe(1);
        expect(hot.counting).toBe(1);

        // §3.3: burning never decrements S, so the ledger's counter is untouched by all of it.
        const sAfter = await ledger.getFloorDen();
        await notify(toNano('50'), burnWallet);
        expect(await ledger.getFloorDen()).toBe(sAfter);
        expect((await ratchet.getBurnStats()).burnedPrimes).toBe(toNano('173.456'));

        // one-shot
        const second = await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
            jettonWalletAddr: minter.address,
            value: toNano('0.05'),
        });
        expect(second.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 104 });
    });

    it('B3: get_flush_status reports BOUNCED, and `pending` is restored unchanged', async () => {
        await deployAll(true); // venue throws
        await acquire(CHEAP_PRIME);
        const pendingBefore = await ratchet.getPending();
        const swappedBefore = await ratchet.getSwapped();
        expect(pendingBefore).toBeGreaterThan(0n);

        const flushAt = blockchain.now!;
        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        // the venue refused; the swap bounced back
        expect(r.transactions).toHaveTransaction({ to: ratchet.address, inMessageBounced: true });

        const st = await ratchet.getFlushStatus();
        expect(st.outcome).toBe(FlushOutcome.Bounced);
        expect(st.lastAttemptTime).toBe(flushAt);
        expect(st.amount).toBe(flushAmount(pendingBefore));

        // §4.3.1: the guard rides the EXISTING bounce path and adds no parallel
        // one, so a refused flush leaves the protocol exactly where it started.
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await ratchet.getSwapped()).toBe(swappedBefore);
        expect(await ratchet.getInFlightFlush()).toBe(0n);

        // and the ratchet is still solvent after the round trip
        const sol = await ratchet.getSolvency();
        expect(sol.liability).toBe(pendingBefore);
        expect(sol.delta >= 0n).toBe(true);

        // a would-be-above-floor refusal and a sandwiched one are the SAME
        // state at contract level — which is exactly why this get-method has to
        // exist (§12). Retrying after the cooldown bounces again, identically.
        blockchain.now! += FLUSH_COOLDOWN;
        await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect((await ratchet.getFlushStatus()).outcome).toBe(FlushOutcome.Bounced);
        expect(await ratchet.getPending()).toBe(pendingBefore);
    });

    // -----------------------------------------------------------------------
    // B5 — the marginal cost of the decomposition's hops
    // -----------------------------------------------------------------------

    it('B5: reports the marginal per-mint cost of the ledger -> ratchet hop', async () => {
        await deployAll(false);
        const r = await acquire(2n);
        const inject = r.transactions.find(
            (t: any) =>
                t.inMessage?.info.type === 'internal' &&
                t.inMessage.info.dest?.toString() === ratchet.address.toString()
        );
        expect(inject).toBeDefined();
        console.log(
            '[B5] decomposition hop cost, per mint: ' +
                `ratchet pool_inject fees=${inject!.totalFees.coins} nanoGRAM ` +
                '(D-202 deleted the registrar record_mint hop)'
        );

        // The hop's forward fee is the only real loss: the attached hop gas
        // (RATCHET_HOP_GAS) lands as the receiving contract's own float and shows
        // up as its getSolvency delta, so it is not spent, only relocated. Assert
        // the loss is small against §4.1's gas & ops line rather than merely printing it.
        expect(inject!.totalFees.coins).toBeLessThan(toNano('0.01'));
    });
});
