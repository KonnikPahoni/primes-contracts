// TON PRIMES — the unified market's four named invariants (P2.A8).
//
// `docs/audit/unified-market-layout.md` names four properties MKT-1..MKT-4 and
// says, of each, that a test must assert it rather than a comment claim it. This
// is that test. It replaces nothing: the four lane suites P2.A7 retired
// (`PrimesAuction`, `PrimesTrophyAuction`, `PrimesReservation`,
// `ReservationPricing`) covered BEHAVIOUR on four contracts that no longer
// exist; the invariants were never asserted anywhere, which is exactly why the
// layout document had to write them down in prose.
//
// The four, in the layout's own words:
//
//   MKT-1  floorOf(MODE_DUTCH_BUYNOW) == MINT_PRICE, exactly — and the lane
//          settles in-transaction, never opening a clock (§9 items 1 and 2).
//          *** The FIRST half is DELETED by DECISIONS.md D-88 point 1: floorOf
//          returns a per-`n` resting price and MINT_PRICE is only its lower
//          bound. D-99 (PRICING_MODEL_PLAN.md §1.2) then widened that price to
//          max(MINT_PRICE, openingPrice/3, NPV(n)/2) — the tier lift it used to
//          carry is deleted along with the tiers themselves. The MKT-1 describe block below now covers that
//          lower-bound case plus what actually survived — write-once from `n`,
//          and the in-transaction settle. See the `C6 (D-88)` test. ***
//   MKT-2  ReservationRecord is safe only while all four `coins` fields stay
//          below ~2^40 nanoton. "A test must assert the packed size, so that a
//          future field addition fails loudly rather than at some magnitude
//          nobody reaches in testing."
//   MKT-3  For any record created by a lot settlement, resPriority == 0 and
//          resPremium == 0, and lotPremiumTotal (router) and totalPremium
//          (shard) never count the same GRAM.
//   MKT-4  DELETED with its subject: D-168 removed `set_stake_uplift` and the
//          ledger's stake leg. The block below is the tripwire that it stays gone.
//
// It also carries GAUNTLET P2.C1's outstanding debt: the 78-digit open
// that used to blow int257 inside Miller-Rabin must now be refused by the
// AUCTIONABLE_MAX cap (`mkt_n_above_cap`, 1020) rather than survive MR.
import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { beginCell, Cell, Dictionary, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import {
    PrimesMarket,
    MODE_ASCENDING,
    MODE_DUTCH_BUYNOW,
} from '../wrappers/PrimesMarket';
import { PrimesItem } from '../wrappers/PrimesItem';
import {
    testMarketConfig,
    RESERVABLE_12,
    RESERVABLE_14,
    RESERVABLE_15,
    RESERVABLE_20014,
    winLot,
} from './helpers/market';
import { SCORE_BITS, SCORE_TERMS } from '../../shared/opcodes';
import { FactorValue } from '../../shared/factors';

const MINT_PRICE = toNano('1');
// `PRIME_P0_MIN` is DELETED (DECISIONS.md D-99, PRICING_MODEL_PLAN.md §1.2). It
// was a flat 5 GRAM floor under a prime's OPENING price, and it existed because
// the tier model had nothing else to say about a prime the finite NPV table
// misses. D-99's additive score prices every number from `n` alone, so the
// opening price on the deep line is `MINT_PRICE · 2^(D(n)/10)` and no separate
// prime clamp is needed — or wanted, since a second clamp is a second pricing
// mechanism and D-89's whole complaint was that two of them disagree.

/**
 * D-99 §1.3 — the bit -> points table, imported rather than retyped. It is the
 * SAME table `shared/opcodes.ts` publishes to the webapp and the same one
 * `getScoreWeights()` returns from the contract; a test that retyped the
 * literals would pass while the two drifted apart, which is the drift the
 * A3.1 block below exists to catch.
 */
const scoreBit = (key: (typeof SCORE_BITS)[number]['key']) =>
    1n << BigInt(SCORE_BITS.find((b) => b.key === key)!.bit);
/** The set bits of a `getLotPrice`/`getScoreBreakdown` mask, as their keys. */
const flagKeys = (flags: bigint) => SCORE_BITS.filter((b) => (flags >> BigInt(b.bit)) & 1n).map((b) => b.key);
/**
 * D-99's ceiling, in money. `SCORE_MAX = 87` and the ladder is
 * `MINT_PRICE · 2^(D/10)`, so 2^8.7 = 416.6 GRAM is the most any number can ever
 * open at — the single clamp on the summed score IS the price ceiling, the same
 * one-clamp-over-the-sum discipline §5 gives `K_CEIL`. 420.5 is the stated
 * owner ceiling the clamp was chosen to sit under.
 */
const SCORE_CEILING_TON = toNano('420.5');

/**
 * D-20 defines the head over COMPOSITES AND UNITY ONLY: after Unity (n = 1),
 * the next number anyone can build is 4, and primes 2 and 3 are already "behind
 * the head" and therefore immediately openable. `OpenHeadLot` reads that as the
 * plain comparison `n < headHint`, so 4 is the opening hint a real deployment
 * carries and the one every lot fixture here depends on.
 */
const OPENING_HEAD = 4n;

/** `mkt_n_above_cap`. */
const EXIT_N_ABOVE_CAP = 1020;
/** `mkt_number_below_head` on the head lane — the prime is not behind the head yet. */
const EXIT_NOT_BEHIND_HEAD = 500;

describe('TON PRIMES — the unified market, invariants MKT-1..MKT-4 (layout §9)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let dedust: SandboxContract<TreasuryContract>;
    let bountyVault: SandboxContract<TreasuryContract>;
    let buyer: SandboxContract<TreasuryContract>;
    let reserver: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;
    let ratchetCode: Cell;
    let registrarCode: Cell;
    let marketCode: Cell;

    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let market: SandboxContract<PrimesMarket>;

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
        dedust = await blockchain.treasury('dedust');
        bountyVault = await blockchain.treasury('bountyVault');
        buyer = await blockchain.treasury('buyer');
        reserver = await blockchain.treasury('reserver');

        const collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
                collectionCode
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        const master = blockchain.openContract(
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
                    dedustNativeVault: dedust.address,
                    dedustPool: dedust.address,
                    primesJettonVault: dedust.address,
                },
                ratchetCode
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        const registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, registrarCode)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });

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

        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            // D-20: the head opens at the FIRST COMPOSITE, and the walk marks 2
            // and 3 on the way. It must match the market's opening `headHint`
            // below, or the two disagree about which primes are past their turn.
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: market.address,
            bountyVaultAddr: bountyVault.address,
            value: toNano('0.05'),
        });
        // CONCEPT §6 point 0: no player money before `ignite`. Every entry point
        // asserted below is gated on `launched`, so this is not setup garnish —
        // without it every test in the file fails on 1022 instead of its subject.
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    /** Opens the D-20 BUYNOW lot on a prime that is already behind the head. */
    async function openHeadLot(n: bigint) {
        return market.sendOpenHeadLot(buyer.getSender(), { n, value: toNano('0.2') });
    }

    /**
     * D-3's ASCENDING lane needs a COMPOSITE, and D-30 deletes the `D(n) >=
     * D_MIN` WORTH gate — but NOT `MIN_AUCTION_DISTANCE`, which is the lane's
     * liveness gate and survives at 20,000 (LAUNCH_FIX_PLAN W8.1's Q26 run
     * clears only with it in place). 10^6 clears that distance from the opening
     * head by a wide margin and is kept as the fixture because it is the
     * clearest scored number in the system (the power-of-ten pattern pays
     * POW10_W on its own — 60, per GAUNTLET N3's D-12/D-21 retune), so a lot
     * on it has a premium worth asserting about.
     */
    const ASCENDING = {
        n: 1_000_000n,
        factors: [
            { prime: 2n, exponent: 6, s: 1n },
            { prime: 5n, exponent: 6, s: 2n },
        ],
    };

    /**
     * D-3: you cannot open a lot you are unwilling to buy, so the open IS the
     * opener's own bid and must carry at least `P0(n)`. That is what deletes the
     * no-bid, expiry, reserve-not-met and refund-the-opener states outright.
     */
    async function openAscendingLot() {
        // Phase 3 (§4): quoted WITH the factors this open sends, which is what
        // `open_lot` prices it at — the from-`n` quote is a lower bound and
        // funds the open short (exit 1003).
        const { p0, score } = await market.getLotPriceFrom(ASCENDING.n, ASCENDING.factors);
        // Guard the fixture itself: if the scorer's weights ever move, this
        // number could stop being the high-premium case the MKT-3 tests below
        // are about, and they would silently start asserting nothing.
        expect(score).toBeGreaterThan(0);
        expect(await market.getLotLane(ASCENDING.n)).toBe(MODE_ASCENDING);

        await market.sendOpenLot(buyer.getSender(), {
            n: ASCENDING.n,
            kind: 0, // composite — the winner inherits this payload
            factors: ASCENDING.factors,
            beneficiary: null,
            referralKey: 0,
            value: p0 + toNano('0.3'),
        });
        expect((await market.getLot(ASCENDING.n)).mode).toBe(MODE_ASCENDING);
    }

    /** Runs the 7-day clock out and closes the lot — permissionless, as D-3 has it. */
    async function closeAscendingLot() {
        const lot = await market.getLot(ASCENDING.n);
        expect(lot.closesAt).toBeGreaterThan(0); // the ascending lane DOES open a clock
        blockchain.now = lot.closesAt + 1;
        await market.sendClose(buyer.getSender(), { n: ASCENDING.n, value: toNano('0.3') });
        // D-196: a sale ahead of `headHint` leaves no row and no sold bit here —
        // the ledger's claim on `n` is the record.
        expect((await market.getLot(ASCENDING.n)).found).toBe(false);
        expect(await ledger.isNumberOffHeadResolved(ASCENDING.n)).toBe(true);
    }

    // =====================================================================
    // THE WINNER OWNS THE NUMBER — the regression for the 2026-09-17 defect.
    //
    // `closeLot` mints to `payload.beneficiary`, and until 2026-09-17 that
    // payload was written once at `open_lot` and never touched again: an
    // ascending lot minted to whoever OPENED it, however many times they had
    // been outbid. Found on live testnet — `K` opened 123456792 at the floor,
    // `C` outbid it and won at 1.2279 GRAM, and the close put the NFT in `K`'s
    // hands. It breaks §4.4/D-90 ("winning MINTS the number") and §4.5 ("every
    // minted number has a real owner from the transaction that minted it") at
    // once, on the ONLY route to a number ahead of the head.
    //
    // Sixty tests in this file passed with the bug in place, which is the other
    // half of the finding: every one of them opened and won with the same
    // wallet, so opener and winner were never distinguishable. This one uses
    // two.
    // =====================================================================
    describe('named refusals: a lot that was never opened (1000), a market not yet launched (1022)', () => {
        it('a bid and a close on a number with no lot, no sold bit and no parked bit refuse 1000', async () => {
            const n = ASCENDING.n;
            expect((await market.getLot(n)).found).toBe(false);
            const bid = await market.sendBid(buyer.getSender(), { n, beneficiary: null, referralKey: 0, value: toNano('5') });
            expect(bid.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 1000 }); // mkt_lot_not_found
            const close = await market.sendClose(buyer.getSender(), { n, value: toNano('0.3') });
            expect(close.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 1000 });
            for (const r of [bid, close]) expect(r.transactions).not.toHaveTransaction({ from: market.address, to: ledger.address });
            expect((await market.getLot(n)).found).toBe(false);
        });

        it('before `launch_open`, open / open-head / bid all refuse 1022 and nothing reaches the ledger', async () => {
            const dark = blockchain.openContract(
                PrimesMarket.createFromConfig(
                    // headHint 5, not 4: the same config would BE the launched fixture market (same address)
                    testMarketConfig({ headHint: 5n, ledgerAddr: ledger.address, ratchetAddr: ratchet.address }),
                    marketCode
                )
            );
            await dark.sendDeploy(deployer.getSender(), toNano('5'));
            expect(dark.address.equals(market.address)).toBe(false);
            expect(await dark.getLaunched()).toBe(false);
            const { p0 } = await market.getLotPriceFrom(ASCENDING.n, ASCENDING.factors);
            const sends = [
                await dark.sendOpenLot(buyer.getSender(), {
                    n: ASCENDING.n, kind: 0, factors: ASCENDING.factors, beneficiary: null, referralKey: 0, value: p0 + toNano('0.3'),
                }),
                await dark.sendOpenHeadLot(buyer.getSender(), { n: 3n, value: toNano('0.2') }),
                await dark.sendBid(buyer.getSender(), { n: 3n, beneficiary: null, referralKey: 0, value: toNano('5') }),
            ];
            for (const r of sends) {
                expect(r.transactions).toHaveTransaction({ to: dark.address, success: false, exitCode: 1022 }); // mkt_not_launched
                expect(r.transactions).not.toHaveTransaction({ from: dark.address, to: ledger.address });
            }
            expect((await dark.getLot(ASCENDING.n)).found).toBe(false);
            expect((await dark.getLot(3n)).found).toBe(false);
        });
    });

    describe('the WINNING bid owns the number, not the opener', () => {
        it('mints to the outbidder after a genuine outbid', async () => {
            const outbidder = await blockchain.treasury('outbidder');
            await openAscendingLot();

            const before = await market.getLot(ASCENDING.n);
            await market.sendBid(outbidder.getSender(), {
                n: ASCENDING.n,
                beneficiary: null,
                referralKey: 0,
                value: before.minPayment + toNano('0.05'),
            });
            const raised = await market.getLot(ASCENDING.n);
            expect(raised.highBidder.equals(outbidder.address)).toBe(true);
            expect(raised.highBidder.equals(buyer.address)).toBe(false);

            blockchain.now = raised.closesAt + 1;
            const closed = await market.sendClose(outbidder.getSender(), {
                n: ASCENDING.n,
                value: toNano('0.3'),
            });

            // Read the beneficiary off the settlement the close actually sends,
            // rather than off a later item read: this is the field the ledger
            // mints from, so it is the one the defect lived in.
            const settle = closed.transactions
                .flatMap((t) => t.outMessages.values())
                .find((m) => {
                    const body = m.body.beginParse();
                    return body.remainingBits >= 32 && body.preloadUint(32) === 0xb0000020;
                });
            expect(settle).toBeDefined();
            const slice = settle!.body.beginParse();
            slice.loadUint(32); // op
            slice.loadUintBig(64); // queryId
            slice.loadUintBig(256); // n
            const beneficiary = slice.loadAddress();
            expect(beneficiary.equals(outbidder.address)).toBe(true);
        });

        it('still honours the OPENER when the opener is the one who wins', async () => {
            await openAscendingLot();
            const lot = await market.getLot(ASCENDING.n);
            blockchain.now = lot.closesAt + 1;
            const closed = await market.sendClose(buyer.getSender(), {
                n: ASCENDING.n,
                value: toNano('0.3'),
            });
            const settle = closed.transactions
                .flatMap((t) => t.outMessages.values())
                .find((m) => {
                    const body = m.body.beginParse();
                    return body.remainingBits >= 32 && body.preloadUint(32) === 0xb0000020;
                });
            const slice = settle!.body.beginParse();
            slice.loadUint(32);
            slice.loadUintBig(64);
            slice.loadUintBig(256);
            expect(slice.loadAddress().equals(buyer.address)).toBe(true);
        });
    });

    // =====================================================================
    // MKT-1 (post-D-88) — MINT_PRICE is the LOWER BOUND on the floor, the
    // floor is write-once from `n`, and the lane never opens a clock.
    // =====================================================================
    // =====================================================================
    // STORAGE CEILING — config 43 caps an account at 65,536 cells. The lot
    // stores the factor entries `open_lot` CHECKED, never the caller's map:
    // a key lookup walks only its own path, so a branch past the first gap
    // could carry thousands of unread cells, and eight such opens (~10 GRAM,
    // refunded when outbid) used to brick every auction.
    // =====================================================================
    describe('storage ceiling · open_lot stores only what it verified', () => {
        async function marketCells(): Promise<number> {
            const acc = (await blockchain.getContract(market.address)).account;
            const state = acc.account!.storage.state;
            if (state.type !== 'active') throw new Error('market not active');
            const seen = new Set<string>();
            const walk = (c: Cell) => {
                const h = c.hash().toString('hex');
                if (seen.has(h)) return;
                seen.add(h);
                c.refs.forEach(walk);
            };
            walk(state.state.data!);
            return seen.size;
        }

        function junkChain(len: number): Cell {
            let c = beginCell().storeUint(0xdead, 16).endCell();
            for (let i = 1; i < len; i++) c = beginCell().storeUint(i, 32).storeRef(c).endCell();
            return c;
        }

        function openLotBody(n: bigint, kind: number, factors: Dictionary<number, Cell>): Cell {
            return beginCell()
                .storeUint(0xf2000001, 32)
                .storeUint(0, 64)
                .storeUint(n, 64)
                .storeUint(kind, 1)
                .storeDict(factors)
                .storeUint(0, 2) // beneficiary: addr_none
                .storeUint(0, 32)
                .endCell();
        }

        const rawValue = {
            serialize: (src: Cell, b: import('@ton/core').Builder) => b.storeSlice(src.beginParse()),
            parse: (s: import('@ton/core').Slice) => s.asCell(),
        };
        const entry = (prime: bigint, exponent: number, sq: bigint, junk?: Cell) => {
            const b = beginCell();
            FactorValue.serialize({ prime, exponent, s: sq }, b);
            if (junk) b.storeRef(junk);
            return b.endCell();
        };

        it('a composite open with a junk branch past the first gap stores no junk', async () => {
            const dict = Dictionary.empty(Dictionary.Keys.Uint(8), rawValue);
            dict.set(0, entry(2n, 6, 1n));
            dict.set(1, entry(5n, 6, 2n));
            // key 9 is never read (the walk stops at the missing key 2)
            dict.set(9, entry(3n, 1, 1n, junkChain(200)));
            const { p0 } = await market.getLotPriceFrom(ASCENDING.n, ASCENDING.factors);
            const before = await marketCells();
            const r = await buyer.send({ to: market.address, value: p0 + toNano('0.5'), body: openLotBody(ASCENDING.n, 0, dict) });
            expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
            expect((await market.getLot(ASCENDING.n)).mode).toBe(MODE_ASCENDING);
            expect((await marketCells()) - before).toBeLessThan(20);
        });

        it('a prime open must carry an EMPTY factor map (201)', async () => {
            const dict = Dictionary.empty(Dictionary.Keys.Uint(8), rawValue);
            dict.set(0, entry(3n, 1, 1n, junkChain(50)));
            const n = 1_000_003n; // prime
            const r = await buyer.send({ to: market.address, value: toNano('100'), body: openLotBody(n, 1, dict) });
            expect(r.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 201 });
        });

        it('a uint8 exponent that overshoots n is refused by name (201), not by a TVM overflow', async () => {
            // 2^255 overflowed the 257-bit product before `product == n` ran (exit 4).
            const r = await market.sendOpenLot(buyer.getSender(), {
                n: ASCENDING.n,
                kind: 0,
                factors: [{ prime: 2n, exponent: 255, s: 1n }],
                beneficiary: null,
                referralKey: 0,
                value: toNano('100'),
            });
            expect(r.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 201 });
        });
    });

    // D-188 points 4-5 (GAUNTLET V21.4): config 43 caps an account at 65,536
    // cells, and the ledger used to add a row per prime the head passed (the
    // dividend bookmark, never deleted) while the market kept every closed lot
    // whole. Both now keep a prime's state only while it has no owner.
    describe('storage ceiling · D-188: a prime passed and sold leaves no row on the ledger or the market', () => {
        async function cellsOf(addr: import('@ton/core').Address): Promise<number> {
            const state = (await blockchain.getContract(addr)).account.account!.storage.state;
            if (state.type !== 'active') throw new Error('not active');
            const seen = new Set<string>();
            const walk = (c: Cell) => {
                const h = c.hash().toString('hex');
                if (seen.has(h)) return;
                seen.add(h);
                c.refs.forEach(walk);
            };
            walk(state.state.data!);
            return seen.size;
        }
        const isqrt = (p: bigint) => { let s = 1n; while ((s + 1n) * (s + 1n) <= p) s += 1n; return s; };
        function factorize(n: bigint) {
            const out: { prime: bigint; exponent: number; s: bigint }[] = [];
            let m = n;
            for (let p = 2n; p * p <= m; p += 1n) {
                let e = 0;
                while (m % p === 0n) { m /= p; e += 1; }
                if (e > 0) out.push({ prime: p, exponent: e, s: isqrt(p) });
            }
            if (m > 1n) out.push({ prime: m, exponent: 1, s: isqrt(m) });
            return out;
        }
        const isPrime = (n: bigint) => n > 1n && factorize(n).length === 1 && factorize(n)[0].exponent === 1;
        const bought = new Set<bigint>();
        beforeEach(() => bought.clear());

        /** Mint the head, then buy every prime it has passed that is still unsold. */
        async function mintHeadAndSell(sell = true) {
            const head = await ledger.getHead();
            const r = await ledger.sendMint(deployer.getSender(), {
                n: head, kind: 0, factors: factorize(head), referralKey: 0, beneficiary: null, value: toNano('1.2'),
            });
            expect(r.transactions).toHaveTransaction({ to: ledger.address, success: true });
            if (!sell) return;
            await ledger.sendSyncHead(buyer.getSender(), { value: toNano('0.1') });
            const newHead = await ledger.getHead();
            for (let p = 2n; p < newHead; p += 1n) {
                if (!isPrime(p) || bought.has(p)) continue;
                expect(await ledger.isPrimeUnsold(p)).toBe(true);
                await openHeadLot(p);
                const lot = await market.getLot(p);
                const b = await market.sendBid(buyer.getSender(), { n: p, beneficiary: null, referralKey: 0, value: lot.minPayment + toNano('0.1') });
                expect(b.transactions).toHaveTransaction({ from: market.address, to: ledger.address, success: true });
                expect(await ledger.isPrimeUnsold(p)).toBe(false);
                bought.add(p);
            }
        }

        it('twenty primes passed and sold move neither account by more than a word', async () => {
            // Warm-up: the first prime-bitmap / sold-bitmap words, the buyer's
            // minterState row, the first dividend on the books.
            while ((await ledger.getHead()) < 10n) await mintHeadAndSell();
            const ledger0 = await cellsOf(ledger.address);
            const market0 = await cellsOf(market.address);
            const sold0 = bought.size;

            while ((await ledger.getHead()) < 90n) await mintHeadAndSell();
            expect(bought.size - sold0).toBeGreaterThanOrEqual(19);
            // Every sold lot answers closed from its bit alone, and none reopens.
            expect((await market.getLot(89n)).closed).toBe(true);
            const again = await openHeadLot(89n);
            expect(again.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 1002 });
            // Before D-188: +~2 cells per prime on the ledger (divEntry) and per sale
            // on the market (the whole closed Lot) — ~40 each here.
            expect((await cellsOf(ledger.address)) - ledger0).toBeLessThanOrEqual(2);
            expect((await cellsOf(market.address)) - market0).toBeLessThanOrEqual(2);
        });

        it('what remains is the unsold backlog: a row per unsold prime, gone at its sale, bookmark on the item', async () => {
            while ((await ledger.getHead()) < 10n) await mintHeadAndSell();
            const ledger0 = await cellsOf(ledger.address);
            // Pass 11 and 13 without buying them.
            while ((await ledger.getHead()) < 14n) await mintHeadAndSell(false);
            expect(await ledger.isPrimeUnsold(11n)).toBe(true);
            expect(await ledger.getClaimableDividendRaw(11n)).toBeGreaterThanOrEqual(0n); // held here
            expect((await cellsOf(ledger.address)) - ledger0).toBeGreaterThan(0);
            const stamp11 = await ledger.getDivEntryRaw(11n);
            // Sell them: the rows go, and the item holds the stamp the walk wrote.
            await mintHeadAndSell();
            expect(await ledger.isPrimeUnsold(11n)).toBe(false);
            expect(await ledger.getDivEntryRaw(11n)).toBe(-1n);
            expect(await ledger.getClaimableDividendRaw(11n)).toBe(-1n);
            const item11 = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(11n)));
            expect(await item11.getDivEntry()).toBe(stamp11);
            expect((await cellsOf(ledger.address)) - ledger0).toBeLessThanOrEqual(2);
        });

        // V26.2 / D-188: the `BOUND:` beside `lots` is written from these figures.
        // A parked Dutch row must cost the market no more cells than the same
        // unsold prime costs the ledger, so in the no-sale case the ledger (not
        // the market) is the contract that reaches config 43's cap first.
        it('V26.2: cells per parked Dutch row and per ascending row', async () => {
            while ((await ledger.getHead()) < 10n) await mintHeadAndSell();
            const ledger0 = await cellsOf(ledger.address);
            while ((await ledger.getHead()) < 200n) await mintHeadAndSell(false);
            await ledger.sendSyncHead(buyer.getSender(), { value: toNano('0.1') });
            const head = await ledger.getHead();
            const unsold: bigint[] = [];
            for (let p = 11n; p < head; p += 1n) if (isPrime(p)) unsold.push(p);
            const ledgerPerPrime = ((await cellsOf(ledger.address)) - ledger0) / unsold.length;

            const market0 = await cellsOf(market.address);
            for (const p of unsold) {
                const r = await openHeadLot(p);
                expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
            }
            const dutchPerRow = ((await cellsOf(market.address)) - market0) / unsold.length;

            const asc: bigint[] = [];
            for (let n = 1_000_000n; asc.length < 8; n += 1n) if (!isPrime(n)) asc.push(n);
            const market1 = await cellsOf(market.address);
            for (const n of asc) {
                const factors = factorize(n);
                const { p0 } = await market.getLotPriceFrom(n, factors);
                const r = await market.sendOpenLot(buyer.getSender(), { n, kind: 0, factors, beneficiary: null, referralKey: 0, value: p0 + toNano('0.5') });
                expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
            }
            const ascPerRow = ((await cellsOf(market.address)) - market1) / asc.length;
            console.log(`V26.2 cells/row: dutch ${dutchPerRow.toFixed(2)} (n=${unsold.length}), ` +
                `ascending ${ascPerRow.toFixed(2)} (n=${asc.length}), ledger per unsold prime ${ledgerPerPrime.toFixed(2)}`);
            expect(dutchPerRow).toBeLessThanOrEqual(ledgerPerPrime);
        });

        // D-200 (GAUNTLET V35): before it, the row above stayed for ever on every
        // unsold prime — ~35k rows near n = 425k filled config 43's cap. A row
        // now lives only while it descends; `park_lots` folds a resting one into
        // a bit, and the folded lot still sells at its write-once resting price.
        it('D-200: resting rows fold into one bit per block, and a folded lot still sells at its resting price', async () => {
            const gasOf = (r: any, op: number) => {
                const t = r.transactions.find((t: any) => {
                    const b = t.inMessage?.body?.beginParse();
                    return b && b.remainingBits >= 32 && b.loadUint(32) === op;
                });
                const c = t?.description.computePhase;
                return c?.type === 'vm' ? c.gasUsed : -1n;
            };
            while ((await ledger.getHead()) < 10n) await mintHeadAndSell();
            while ((await ledger.getHead()) < 520n) await mintHeadAndSell(false);
            await ledger.sendSyncHead(buyer.getSender(), { value: toNano('0.1') });
            const head = await ledger.getHead();
            const unsold: bigint[] = [];
            for (let p = 11n; p < head; p += 1n) if (isPrime(p)) unsold.push(p);
            const floors = new Map<bigint, bigint>();
            for (const p of unsold) floors.set(p, await market.getPrimeFloor(p));

            const market0 = await cellsOf(market.address);
            for (const p of unsold) {
                const r = await openHeadLot(p);
                expect(r.transactions).toHaveTransaction({ to: market.address, success: true });
            }
            const withRows = await cellsOf(market.address);

            // Still descending: nothing to fold, and a call folds nothing.
            expect((await market.getParkScan(0n)).folds).toBe(0);
            const { decaySeconds } = await market.getPrimeDutchTerms();
            blockchain.now = blockchain.now! + decaySeconds + 1;

            let from = 0n;
            let maxGas = 0n;
            let calls = 0;
            for (;;) {
                const scan = await market.getParkScan(from);
                if (scan.folds > 0) {
                    const r = await market.sendParkLots(buyer.getSender(), { from, value: toNano('0.05') });
                    expect(r.transactions).not.toHaveTransaction({ aborted: true });
                    // The change comes back: the float pays nothing.
                    expect(r.transactions).toHaveTransaction({ from: market.address, to: buyer.address });
                    const g = gasOf(r, 0xf2000013);
                    if (g > maxGas) maxGas = g;
                    calls += 1;
                }
                if (scan.next < 0n) break;
                from = scan.next;
            }
            const folded = await cellsOf(market.address);
            const blocks = Number(head >> 8n) + 1;
            console.log(`D-200 cells: ${unsold.length} descending rows +${withRows - market0}, ` +
                `folded +${folded - market0} (${blocks} blocks); park_lots ${calls} calls, worst ${maxGas} gas`);
            // ~2 cells per 256-number block, against ~1.83 per unsold prime before.
            expect(folded - market0).toBeLessThanOrEqual(2 * blocks + 1);
            expect(withRows - folded).toBeGreaterThan(unsold.length);
            expect(maxGas).toBeLessThan(400_000n);

            // A folded lot answers as its row did (openedAt aside), is still open
            // and resting at the price written from `n`, and cannot be reopened or closed.
            for (const p of unsold) {
                const lot = await market.getLot(p);
                expect(lot.found).toBe(true);
                expect(lot.closed).toBe(false);
                expect(lot.mode).toBe(MODE_DUTCH_BUYNOW);
                expect(lot.standingPrice).toBe(floors.get(p));
                expect(lot.openedAt).toBe(0);
                expect((await market.getLotFloor(p)).floor).toBe(floors.get(p));
            }
            const p = unsold[unsold.length - 1];
            const reopen = await openHeadLot(p);
            expect(reopen.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 1001 });
            const close = await market.sendClose(buyer.getSender(), { n: p, value: toNano('0.1') });
            expect(close.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 1005 });

            // The purchase: at the resting price, minted in the same transaction.
            const stats0 = await market.getMarketStats();
            const lot = await market.getLot(p);
            const b = await market.sendBid(buyer.getSender(), { n: p, beneficiary: null, referralKey: 0, value: lot.minPayment + toNano('0.1') });
            expect(b.transactions).not.toHaveTransaction({ aborted: true });
            expect(b.transactions).toHaveTransaction({ from: market.address, to: ledger.address, success: true });
            console.log(`D-200 parked buy: market bid ${gasOf(b, 0xf2000003)} gas at n=${p}`);
            expect(await ledger.isPrimeUnsold(p)).toBe(false);
            expect((await market.getLot(p)).closed).toBe(true);
            const stats1 = await market.getMarketStats();
            expect(stats1.lotPremiumTotal - stats0.lotPremiumTotal).toBe(floors.get(p)! - MINT_PRICE);
            expect(stats1.openLots).toBe(stats0.openLots - 1);
            const again = await market.sendBid(buyer.getSender(), { n: p, beneficiary: null, referralKey: 0, value: lot.minPayment + toNano('0.1') });
            expect(again.transactions).toHaveTransaction({ to: market.address, success: false, exitCode: 1002 });
        });
    });

    describe('MKT-1 · getPrimeDutchTerms() publishes the floor LOWER BOUND', () => {
        /**
         * The layout called `floorOf(MODE_DUTCH_BUYNOW) == MINT_PRICE` "the
         * load-bearing line in this file". D-88 point 1 DELETED that equality:
         * `floorOf` now answers a per-`n` resting price and only a prime past
         * the finite NPV table lands on MINT_PRICE. What `getPrimeDutchTerms`
         * publishes is therefore the LOWER BOUND, the window, and the NPV
         * percentage — enough to recompute any `getPrimeFloor(n)` off chain,
         * which is what §9.1 asks of it.
         */
        it('publishes a floor lower bound of exactly MINT_PRICE, to the nanoton', async () => {
            const terms = await market.getPrimeDutchTerms();
            expect(terms.floorMin).toBe(MINT_PRICE);
            expect(terms.decaySeconds).toBeGreaterThan(0);
        });

        /**
         * The published constant and the price a buyer is actually charged are
         * two different things, and since D-88 they are the same number only for
         * a prime past the NPV table. This walks a real lot to the end of its
         * decay window and asserts the standing price LANDS on its floor rather
         * than merely approaching it — a linear ramp that rounds down by a
         * nanoton would satisfy the get-method and still leave the lane without
         * a real terminus.
         */
        // NOT 37: D-88 point 3 puts a prime the head has not reached on the
        // ASCENDING lane, so `open_head_lot` refuses it (1024) and there is no
        // descending curve to walk. The only primes ALREADY behind genesis's
        // opening head (4) are 2 and 3. 3 is special (2²−1, Mersenne), so its
        // 3 scores heavily (Mersenne, twin, Sophie Germain, Fibonacci... it
        // CLAMPS at SCORE_MAX), so its p0 and floor are large — which under
        // D-88 point 2 and D-99 is a price LIFT on the same one lane, not a
        // lane of its own. Both are read off
        // the contract (`getLotPrice`, `getPrimeFloor`) rather than hardcoded,
        // which is what makes this a test of the curve and not of a constant.
        it('decays a live lot to exactly the floor and never below it', async () => {
            const priceMin = await market.getPrimeFloor(3n);
            const { p0: priceMax } = await market.getLotPrice(3n);
            const { decaySeconds: specialDecaySeconds } = await market.getPrimeDutchTerms();
            await openHeadLot(3n);
            const opened = await market.getLot(3n);
            expect(opened.found).toBe(true);
            expect(opened.mode).toBe(MODE_DUTCH_BUYNOW);
            expect(opened.p0).toBe(priceMax);

            // Mid-ramp: strictly between p0 and the floor, so the decay is real
            // and not a step function that would make the endpoints meaningless.
            blockchain.now = 1_770_000_000 + Math.floor(specialDecaySeconds / 2);
            const mid = await market.getLot(3n);
            expect(mid.standingPrice).toBeLessThan(opened.p0);
            expect(mid.standingPrice).toBeGreaterThan(priceMin);

            // Exactly at the terminus.
            blockchain.now = 1_770_000_000 + specialDecaySeconds;
            expect((await market.getLot(3n)).standingPrice).toBe(priceMin);

            // And far past it — the flat tail. D-20's "it sits at the floor
            // forever if nobody buys" is this assertion and nothing else.
            blockchain.now = 1_770_000_000 + specialDecaySeconds * 10;
            expect((await market.getLot(3n)).standingPrice).toBe(priceMin);
        });

        // ---------------------------------------------------------------- //
        // GAUNTLET C6 — originally §12's "no lane terminates above 1 GRAM",
        // with the §9.6 / D-47 special-prime parked price as the SINGLE named
        // exception. DECISIONS.md D-88 point 1 DELETED that invariant (MKT-1)
        // and the exception with it: every prime's lane now rests at
        // getPrimeFloor(n) = max(MINT_PRICE, p0(n)/3, NPV(n)/2) — D-99 §1.2
        // added the middle term — so a scored prime terminates well above
        // 1 GRAM by design. See the `C6 (D-88)` test below, which is
        // the one that pins the current rule across the lanes.
        //
        // These tests survive as the MINT_PRICE *lower bound* case: ORDINARY_PRIME
        // (541) is past the finite NPV table, so its resting price IS exactly
        // MINT_PRICE and the assertions below still say something true and
        // load-bearing — that the ramp LANDS on its floor and parks there
        // forever. Do not read them as asserting a universal 1 GRAM terminus.
        // ---------------------------------------------------------------- //

        /**
         * The first ORDINARY prime — no CULTURE bit under D-99's scorer, which
         * is harder to find than it looks. 2 is a palindrome, 3 and 7 and 31 are
         * Mersenne, 5/11/13/17/19/29 are twins, 23 is Sophie Germain, 11 is a
         * repunit. D-68's `small_primes` family used to take EVERY prime below
         * 500 that the other predicates missed — 37, 67, 79 and 97 among them —
         * but D-96 deleted it, so those are ordinary again and only the
         * mathematical families remain. 541 is still the constant used here,
         * because it is ordinary under BOTH regimes: not twin (539 = 7·7·11, 543 = 3·181),
         * not Sophie Germain (1083 = 3·19²), not safe (270 is even), not a
         * palindrome, not a repunit, not a curated year.
         *
         * D-99 does still pay 541 for one thing — it is the 100th prime, so
         * POSITION's `landmark` bit fires. That is asserted explicitly below
         * rather than worked around: if a future edit to the scorer changes
         * what 541 is worth, the BREAKDOWN assertion fails rather than the
         * floor assertion, which is the right failure — the test would
         * otherwise silently start measuring a differently priced number.
         */
        const ORDINARY_PRIME = 541n;
        /**
         * Every other ordinary prime near the probe market's head hint, to
         * catch a stored floor that happens to be right for one n. Under D-68
         * the ordinary case starts at 541 and is still the rare one — 563 is a
         * safe prime, 569/571 are twins, 593 is Sophie Germain — which is
         * itself the point: this is the case §12's universal floor is about.
         */
        const ORDINARY_PRIMES = [541n, 547n, 557n, 577n];

        /**
         * A second market whose head hint is already past those primes.
         *
         * D-31 makes this necessary rather than convenient: `open_head_lot`
         * stamps `decayStart = n < headHint ? now : 0`, and a lot with
         * `decayStart == 0` is FLAT at p0 forever, by design. The fixture market
         * opens at head 4, so a lot on 37 there would never decay at all and a
         * test walking its clock would be measuring nothing.
         *
         * Two fixture choices worth naming, because both look like shortcuts:
         *
         *  - `ledgerAddr` is a plain treasury, not the real ledger. `LaunchOpen`
         *    asserts `sender == ledgerAddr` and the real ledger only ever sends
         *    it to the market it was wired to at `set_peers` — so a second market
         *    cannot be launched through the real one, and every entry point here
         *    is gated on `launched` (1022). Nothing under test touches the
         *    ledger: `open_head_lot` is permissionless and local, and the
         *    subject is `dutchPriceOf`, pure arithmetic over the stored lot.
         *  - The lots are never bought. §12 is a claim about the price a lane
         *    comes to rest at, which is a read, so settlement is out of scope
         *    here and covered by the acquisition suites.
         */
        async function marketPastOrdinaryPrimes() {
            const m = blockchain.openContract(
                PrimesMarket.createFromConfig(
                    testMarketConfig({
                        headHint: 600n,
                        ledgerAddr: deployer.address,
                        ratchetAddr: ratchet.address,
                    }),
                    marketCode
                )
            );
            await m.sendDeploy(deployer.getSender(), toNano('5'));
            await m.sendLaunchOpen(deployer.getSender(), { value: toNano('0.05') });
            expect(await m.getLaunched()).toBe(true);
            return m;
        }

        it('C6: an ORDINARY prime opens on MODE_DUTCH_BUYNOW, and its score is fully accounted for', async () => {
            const m = await marketPastOrdinaryPrimes();
            // The premise, asserted rather than assumed. D-99 deletes tiers, so
            // "ordinary" is no longer a tier reading (`tier === -1`) — it is a
            // statement about which BITS `n` sets, and the exact set is pinned
            // here so that a weight or predicate edit that quietly reprices this
            // number fails at the premise rather than three floor assertions
            // further down.
            //
            // 541 is prime (15) and a LANDMARK (30) — it is the 100th prime, and
            // D-99's POSITION group pays for exactly that. It carries no digit
            // shape, no date form, no prime family (not twin, not Sophie
            // Germain, not safe, not an emirp) and nothing from CULTURE. Plus
            // LEN, which is continuous and has no bit at all.
            const { score, flags } = await m.getScoreBreakdown(ORDINARY_PRIME);
            expect(flagKeys(flags)).toEqual(['prime', 'landmark']);
            expect(score).toBe(SCORE_TERMS.LEN_W * (SCORE_TERMS.LEN_REF - 3) + 15 + 30);

            await m.sendOpenHeadLot(buyer.getSender(), { n: ORDINARY_PRIME, value: toNano('0.2') });
            const lot = await m.getLot(ORDINARY_PRIME);
            expect(lot.found).toBe(true);
            expect(lot.mode).toBe(MODE_DUTCH_BUYNOW);
            expect(lot.p0).toBeGreaterThan(MINT_PRICE); // it has somewhere to descend from
        });

        it('C6: an ordinary prime lot decays to EXACTLY its resting price, and parks there forever', async () => {
            // D-99 §1.2 CHANGED THE TERMINUS OF THIS VERY LOT. Under D-88 an
            // ordinary prime past the finite NPV table rested at exactly
            // MINT_PRICE, because `restingPriceOf` was `max(NPV/2, MINT_PRICE)`
            // and the table miss left only the clamp. D-99 adds an `open / 3`
            // term, so the 3x open-to-rest spread now holds for EVERY prime and
            // 541 rests at a third of its own opening price instead of at 1 GRAM.
            // What survives unchanged, and is what this test is really about, is
            // the SHAPE: a real ramp, landing exactly on the floor, parked there
            // for ever. So the floor is read off `getPrimeFloor` rather than
            // written as a constant.
            const m = await marketPastOrdinaryPrimes();
            const { decaySeconds } = await m.getPrimeDutchTerms();
            const t0 = blockchain.now!;
            await m.sendOpenHeadLot(buyer.getSender(), { n: ORDINARY_PRIME, value: toNano('0.2') });
            const p0 = (await m.getLot(ORDINARY_PRIME)).p0;
            const floor = await m.getPrimeFloor(ORDINARY_PRIME);
            // Non-vacuity: the ramp must have somewhere to fall, and the floor
            // must be the `open / 3` term rather than the MINT_PRICE clamp —
            // otherwise this would still be the pre-D-99 test in disguise.
            expect(floor).toBeGreaterThan(MINT_PRICE);
            expect(floor).toBe(p0 / 3n);

            // Mid-ramp: strictly between, so the decay is a real ramp and not a
            // step function that would make both endpoints vacuous.
            blockchain.now = t0 + Math.floor(decaySeconds / 2);
            const mid = await m.getLot(ORDINARY_PRIME);
            expect(mid.standingPrice).toBeLessThan(p0);
            expect(mid.standingPrice).toBeGreaterThan(floor);

            // The terminus. LANDS on the floor — not approaches it. A ramp that
            // rounded a nanoton short would satisfy every other assertion in
            // this file and still leave the lane without a real terminus.
            blockchain.now = t0 + decaySeconds;
            expect((await m.getLot(ORDINARY_PRIME)).standingPrice).toBe(floor);

            // The flat tail. "It sits at the floor forever if nobody buys" is
            // this assertion and nothing else: a lane that dipped below, or
            // drifted back above after its window, would be a terminus that is
            // not a terminus.
            blockchain.now = t0 + decaySeconds * 10;
            expect((await m.getLot(ORDINARY_PRIME)).standingPrice).toBe(floor);
            blockchain.now = t0 + decaySeconds * 1000;
            expect((await m.getLot(ORDINARY_PRIME)).standingPrice).toBe(floor);
        });

        it('C6: what a buyer is CHARGED at the terminus is the resting price plus gas, nothing more', async () => {
            // `standingPrice` is the number; `minPayment` is the bill. What it
            // costs to acquire the number is the bill, so the bill is the one
            // that has to land on the floor — `RES_GAS` aside, which is a gas
            // reimbursement and not part of the price at all.
            //
            // Pre-D-99 this read `MINT_PRICE + resGas`, which was the same
            // identity as LOT_FLOOR only because an ordinary prime's floor
            // happened to BE MINT_PRICE. D-99 §1.2 gives every prime a resting
            // price of its own, so the bill is quoted against `getPrimeFloor`
            // and the "nothing more" half is what is actually asserted.
            const m = await marketPastOrdinaryPrimes();
            const { decaySeconds } = await m.getPrimeDutchTerms();
            const resGas = await m.getResGas();
            const t0 = blockchain.now!;
            await m.sendOpenHeadLot(buyer.getSender(), { n: ORDINARY_PRIME, value: toNano('0.2') });

            blockchain.now = t0 + decaySeconds;
            expect((await m.getLot(ORDINARY_PRIME)).minPayment).toBe(
                (await m.getPrimeFloor(ORDINARY_PRIME)) + resGas
            );
        });

        it('C6: the floor is a STORED field now, so its value is a test obligation, not a structural one', async () => {
            // CONCEPT.md §4.4 USED to say the floor was "derived rather than
            // stored... precisely so that no field exists for anyone to set to
            // something other than 1 GRAM". SS3/D-47 added `Lot.priceFloor` for
            // the special lane and `floorOf` returns it for all three descending
            // modes, so the "no field exists" half stopped being true; §4.4 now
            // reads "stored, but never settable" and names this test as what
            // carries the value. This test is that replacement — a stored
            // floor could be right for one n and wrong for another in a way a
            // derived one could not, so this walks several.
            //
            // C6.1 (iter #114) reconciled the prose: §4.4, §12, `floorOf`'s
            // comment, this wrapper's and GenesisRehearsal's all now say
            // "stored, but never settable" and name this test as what carries
            // the value. The test below pins the "never settable" half.
            const m = await marketPastOrdinaryPrimes();
            const { decaySeconds } = await m.getPrimeDutchTerms();
            const t0 = blockchain.now!;
            //
            // D-99 SHARPENS THIS TEST rather than weakening it. Pre-D-99 all
            // four of these primes rested at the same MINT_PRICE, so a stored
            // floor that was silently recomputed from a constant would have
            // passed. Under D-99 §1.2 each rests at a third of its OWN opening
            // price, and 541/547/557/577 do not all score alike — so "right for
            // one n and wrong for another" is now a failure this loop can
            // actually see.
            for (const p of ORDINARY_PRIMES) {
                // The premise, in D-99 terms: each carries the `prime` bit, and
                // none is a CULTURE number — nothing here is famous outside
                // mathematics, which is what would turn one of these plain
                // primes into a headline lot. (They are NOT all bare: 541 is a
                // landmark, the 100th prime, and 557/577 have prime digit sums.
                // That is deliberate — four primes that score DIFFERENTLY is
                // exactly what makes the floor loop below non-trivial.)
                const keys = flagKeys((await m.getScoreBreakdown(p)).flags);
                expect({ p: p.toString(), keys }).toEqual({
                    p: p.toString(),
                    keys: expect.arrayContaining(['prime']),
                });
                for (const famous of ['iconic', 'listed']) {
                    expect({ p: p.toString(), famous, has: keys.includes(famous as never) }).toEqual({
                        p: p.toString(),
                        famous,
                        has: false,
                    });
                }
                await m.sendOpenHeadLot(buyer.getSender(), { n: p, value: toNano('0.2') });
            }
            blockchain.now = t0 + decaySeconds * 4;
            for (const p of ORDINARY_PRIMES) {
                const lot = await m.getLot(p);
                expect({ p: p.toString(), mode: lot.mode }).toEqual({ p: p.toString(), mode: MODE_DUTCH_BUYNOW });
                expect({ p: p.toString(), floor: lot.standingPrice }).toEqual({
                    p: p.toString(),
                    floor: await m.getPrimeFloor(p),
                });
                // And each is the `open / 3` term, not the MINT_PRICE clamp.
                expect({ p: p.toString(), above: lot.standingPrice > MINT_PRICE }).toEqual({
                    p: p.toString(),
                    above: true,
                });
            }
        });

        it('C6.1: `priceFloor` is WRITE-ONCE — no update path can move a lot off its floor', async () => {
            // What replaced "no field exists for anyone to set to something other
            // than 1 GRAM". SS3/D-47 made the floor a stored field, so the
            // structural claim is narrower now and this is its literal form: the
            // value is written at open, by contract code, from `n` alone, and
            // none of the three paths that later touch a lot can move it.
            //
            // The message side is guaranteed by the wire format rather than here
            // — `OpenLot`, `OpenHeadLot` and `OpenHeadLotComposite` carry no
            // floor field, so there is nothing for a caller to propose. What is
            // NOT guaranteed by the wire format is the update side, because
            // `closeLot`, `StartPrimeDecay` and a bid all write the record back.
            // Each of those is a `var updated = rec` copy today; a future one
            // that rebuilt the struct instead could drop or recompute
            // `priceFloor` and nothing else in the suite would notice.
            const m = await marketPastOrdinaryPrimes();
            const { decaySeconds } = await m.getPrimeDutchTerms();
            const t0 = blockchain.now!;

            // 3 clamps at SCORE_MAX, so its floor is STRICTLY above 1 GRAM and
            // far above it. That is deliberate: a bug that reset `priceFloor`
            // to MINT_PRICE — or dropped it to a zero-initialised field and
            // fell back — is only visible on a lot whose floor differs from the
            // constant. (Under D-99 §1.2 that is now every prime, since
            // `open / 3` is above MINT_PRICE for anything scoring past ~11
            // points; 3 is still chosen because its margin is the widest.)
            await m.sendOpenHeadLot(buyer.getSender(), { n: 3n, value: toNano('0.2') });
            const priceMin = await m.getPrimeFloor(3n);
            expect(priceMin).toBeGreaterThan(MINT_PRICE);

            // Non-vacuity: the clock has only just started, so the lot is at p0
            // and the floor is not yet observable in `standingPrice`. If it were
            // already at the floor, the walk below would prove nothing.
            expect((await m.getLot(3n)).standingPrice).toBeGreaterThan(priceMin);

            // UPDATE PATH 1 — the clock, which D-88 point 3 starts at open (a
            // descending lot can only be opened after the turn, so there is no
            // `start_prime_decay` left to poke it).
            blockchain.now = t0 + decaySeconds * 4;
            expect({ where: 'after the window', floor: (await m.getLot(3n)).standingPrice })
                .toEqual({ where: 'after the window', floor: priceMin });

            // UPDATE PATH 2 — a bid on an ASCENDING lot writes the record back
            // too, and that lane must not disturb its own stored floor either.
            // (An ascending lot never reads `priceFloor` — `floorOf` returns p0
            // — so what this asserts is that the field survives the write, via
            // the lane whose terminus it does not set.)
            // 779 = 19 x 41, ordinary, and AHEAD of this fixture's head hint of
            // 600 — an ascending lot sells the right to a number the head has not
            // reached, so a composite behind the hint is refused outright. (It
            // was 143 against a hint of 100; D-68 moved the hint past 500 so the
            // fixture would still have an ORDINARY prime to be about.)
            const compositeN = 779n;
            const compositeFactors = [
                { prime: 19n, exponent: 1, s: 4n },
                { prime: 41n, exponent: 1, s: 6n },
            ];
            // Phase 3 (PRICING_MODEL_PLAN.md §4): `open_lot` prices a composite
            // off the factorization it is sent, so the quote asks the same way.
            const quote = await m.getLotPriceFrom(compositeN, compositeFactors);
            const opened = await m.sendOpenLot(buyer.getSender(), {
                n: compositeN,
                kind: 0,
                factors: compositeFactors,
                beneficiary: null,
                referralKey: 0,
                value: quote.p0 + toNano('0.3'),
            });
            expect(opened.transactions).toHaveTransaction({ to: m.address, success: true });
            expect((await m.getLot(compositeN)).mode).toBe(MODE_ASCENDING);

            // And the special lot is STILL at its own floor after another
            // contract's worth of traffic — the record was not disturbed by
            // anything that happened to a different lot in the same dictionary.
            expect((await m.getLot(3n)).standingPrice).toBe(priceMin);
        });

        it('C6 (D-88): every prime lane rests at getPrimeFloor(n), and PARKS there', async () => {
            // D-88 point 1 REPLACES §12's "no lane terminates above 1 GRAM" and
            // D-47's one narrow exception to it. What is asserted now is the
            // rule that took their place: a descending lot terminates at
            // `getPrimeFloor(n)`, which D-99 §1.2 widens to
            // `max(MINT_PRICE, p0(n)/3, NPV(n)/2)` — at or above 1 GRAM, never
            // below — and then STAYS there for as long as nobody buys it, with no
            // expiry (D-50's sweep is deleted).
            //
            // Both lots are read off the contract rather than off a constant,
            // which is the whole point: the terminus now varies with `n`.
            const m = await marketPastOrdinaryPrimes();
            const { decaySeconds } = await m.getPrimeDutchTerms();
            const t0 = blockchain.now!;

            // 3 clamps at SCORE_MAX; ORDINARY_PRIME scores an order of
            // magnitude less. Both are behind this fixture's hint, so both are
            // on the descending lane, and their two very different floors are
            // the point.
            await m.sendOpenHeadLot(buyer.getSender(), { n: ORDINARY_PRIME, value: toNano('0.2') });
            await m.sendOpenHeadLot(buyer.getSender(), { n: 3n, value: toNano('0.2') });

            blockchain.now = t0 + decaySeconds * 4; // past the one window there now is

            const ordinary = await m.getLot(ORDINARY_PRIME);
            const special = await m.getLot(3n);
            // D-88 point 2: ONE descending mode. Specialness is price, not lane.
            expect(ordinary.mode).toBe(MODE_DUTCH_BUYNOW);
            expect(special.mode).toBe(MODE_DUTCH_BUYNOW);

            expect(ordinary.standingPrice).toBe(await m.getPrimeFloor(ORDINARY_PRIME));
            expect(special.standingPrice).toBe(await m.getPrimeFloor(3n));
            // Neither may ever rest BELOW the mint price — that bound survives
            // D-88 intact, it is only the equality that is gone.
            expect(ordinary.standingPrice).toBeGreaterThanOrEqual(MINT_PRICE);
            // And the special one is strictly above it, so the raised floor is
            // demonstrably doing something rather than collapsing to the clamp.
            expect(special.standingPrice).toBeGreaterThan(MINT_PRICE);

            // IT PARKS. Ten more windows, unbought, and the price has not moved
            // and the lot has not gone anywhere. This is the assertion D-50's
            // sweep used to contradict.
            blockchain.now = t0 + decaySeconds * 40;
            expect((await m.getLot(ORDINARY_PRIME)).standingPrice).toBe(ordinary.standingPrice);
            expect((await m.getLot(3n)).found).toBe(true);
            expect((await m.getLot(3n)).standingPrice).toBe(special.standingPrice);
        });

        // D-61 option 2 (GAUNTLET.md C6.2b): `getLotFloor` must agree with
        // `floorOf` on every lane it can reach. D-88 point 2 leaves exactly two
        // lanes, so "every lane" is now literally both of them.
        it("C6.2b: getLotFloor(n) answers floorOf's own value, on every lane a lot can be", async () => {
            const m = await marketPastOrdinaryPrimes();

            // No lot yet: same not-found convention as getLot, not a guess.
            expect((await m.getLotFloor(ORDINARY_PRIME)).found).toBe(false);

            // MODE_DUTCH_BUYNOW, ordinary prime. D-88 point 1: the floor is
            // `getPrimeFloor(n)`, and the two get-methods must agree because the
            // contract writes the record from the same `restingPriceOf`.
            await m.sendOpenHeadLot(buyer.getSender(), { n: ORDINARY_PRIME, value: toNano('0.2') });
            const ordinaryFloor = await m.getLotFloor(ORDINARY_PRIME);
            expect(ordinaryFloor.found).toBe(true);
            expect(ordinaryFloor.floor).toBe(await m.getPrimeFloor(ORDINARY_PRIME));
            expect(ordinaryFloor.floor).toBeGreaterThanOrEqual(MINT_PRICE);

            // Same lane, heavily scored prime — the score lifts the floor far
            // above the MINT_PRICE clamp, without a mode of its own (D-88
            // point 2, D-99 §1.2).
            await m.sendOpenHeadLot(buyer.getSender(), { n: 3n, value: toNano('0.2') });
            const specialFloor = await m.getLotFloor(3n);
            expect(specialFloor.found).toBe(true);
            expect(specialFloor.floor).toBe(await m.getPrimeFloor(3n));
            expect(specialFloor.floor).toBeGreaterThan(MINT_PRICE);

            // MODE_ASCENDING — the floor never descends: it IS the opening bid.
            const { p0: ascendingP0 } = await m.getLotPriceFrom(ASCENDING.n, ASCENDING.factors);
            await m.sendOpenLot(buyer.getSender(), {
                n: ASCENDING.n,
                kind: 0,
                factors: ASCENDING.factors,
                beneficiary: null,
                referralKey: 0,
                value: ascendingP0 + toNano('0.3'),
            });
            const ascendingLot = await m.getLot(ASCENDING.n);
            const ascendingFloor = await m.getLotFloor(ASCENDING.n);
            expect(ascendingFloor.found).toBe(true);
            expect(ascendingFloor.floor).toBe(ascendingLot.p0);
        });

        /**
         * D-89, AS D-99 §1.2 LEAVES IT — the open-to-rest spread is exactly 3x
         * for EVERY prime, on both sides of the NPV table.
         *
         * D-89 fixed the spread by deleting D-68's crown curve, so that
         * `p0 = 1.5 x NPV` and `resting = 0.5 x NPV` shared a term and the ratio
         * came out at 3 termwise. But that argument only ever covered the ~930
         * primes the finite NPV ladder carries. Everywhere else the opening
         * price came from a clamp and the resting price collapsed to exactly
         * 1 GRAM, so a prime quoted at 300 GRAM rested at 1 — which is not a
         * descent, it is a giveaway.
         *
         * PRICING_MODEL_PLAN.md §1.2 closes that: `restingPriceOf` is now
         * `max(MINT_PRICE, openingPrice / 3, NPV(n) / 2)`. The `open / 3` term
         * is what makes 3x universal, and it dominates the NPV term by
         * construction wherever the table binds (if `open = 1.5·NPV` then
         * `open/3 = NPV/2` exactly), so the two branches agree rather than race.
         *
         * BOTH branches are asserted below, because they fail independently:
         * a regression that dropped `open / 3` would leave branch A (table hit)
         * green and branch B (table miss) resting at 1 GRAM.
         */
        it('D-99 §1.2: the open-to-rest spread is exactly 3x, whether or not NPV binds', async () => {
            // BRANCH A — the NPV table BINDS. `testMarketConfig` ships no table,
            // so a market with one has to be deployed here; that is the point of
            // the fixture rather than an inconvenience, since a market without a
            // table can only ever exercise branch B and the old version of this
            // test was silently vacuous for exactly that reason.
            //
            // 100 GRAM of NPV on 541 puts `1.5 x NPV = 150 GRAM` well above its
            // ladder price (score 57, so `1 GRAM · 2^5.7` ≈ 52 GRAM), which is
            // what makes NPV demonstrably the term that wins the max.
            const npvTable = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.BigVarUint(4));
            npvTable.set(ORDINARY_PRIME, toNano('100'));
            const withNpv = blockchain.openContract(
                PrimesMarket.createFromConfig(
                    {
                        ...testMarketConfig({
                            headHint: 600n,
                            ledgerAddr: deployer.address,
                            ratchetAddr: ratchet.address,
                        }),
                        npvTable,
                    },
                    marketCode
                )
            );
            await withNpv.sendDeploy(deployer.getSender(), toNano('5'));

            const npv = await withNpv.getNpv(ORDINARY_PRIME);
            expect(npv).toBe(toNano('100')); // the fixture is doing something
            const boundP0 = (await withNpv.getLotPrice(ORDINARY_PRIME)).p0;
            const boundRest = await withNpv.getPrimeFloor(ORDINARY_PRIME);
            expect(boundP0).toBe((npv * 3n) / 2n); // NPV won the max, not the ladder
            expect(boundRest).toBe(npv / 2n);
            expect(boundP0 / boundRest).toBe(3n);

            // BRANCH B — the table MISSES, which is the common case on the deep
            // number line and was the broken one before D-99. The ladder sets
            // the opening price and `open / 3` sets the rest, so the spread is
            // the same 3x and the resting price is nowhere near the 1 GRAM clamp.
            const m = await marketPastOrdinaryPrimes();
            for (const p of [3n, ORDINARY_PRIME, 547n, 557n, 577n]) {
                expect({ p: p.toString(), npv: await m.getNpv(p) }).toEqual({ p: p.toString(), npv: 0n });
                const { p0 } = await m.getLotPrice(p);
                const resting = await m.getPrimeFloor(p);
                expect({ p: p.toString(), resting }).toEqual({ p: p.toString(), resting: p0 / 3n });
                expect({ p: p.toString(), spread: p0 / resting }).toEqual({ p: p.toString(), spread: 3n });
                // Non-vacuity: `open / 3` is what is being read, not MINT_PRICE
                // wearing its costume.
                expect({ p: p.toString(), clamped: resting === MINT_PRICE }).toEqual({
                    p: p.toString(),
                    clamped: false,
                });
            }

            // AND THE QUOTE IS A READING OF THE MECHANISM, not a rival to it —
            // the half of D-89 that survives D-99 unchanged. `getLotPrice` calls
            // `openingPriceOf`; if it re-derived a price of its own, the two
            // could disagree exactly where they used to (a scored prime with an
            // NPV entry). §9.1 also requires the reader to be able to recompute
            // this from `n`, so it is recomputed here from the published FRAC
            // table and the published score rather than compared to a literal.
            const { frac, shift } = await m.getFracTable();
            const ladder = (score: number) =>
                ((MINT_PRICE << BigInt(Math.floor(score / 10))) * frac[score % 10]) >> BigInt(shift);
            for (const p of [3n, 5n, 13n, ORDINARY_PRIME, 503n]) {
                const { p0, score } = await m.getLotPrice(p);
                expect({ p: p.toString(), p0 }).toEqual({ p: p.toString(), p0: ladder(score) });
            }
        });

        it('D-99 §1.5 NARROWS D-96: the prime rebate family is INVISIBLE to the score', async () => {
            // D-96 gave `p > 100,000 && p ≡ 1 mod 101` a place in the SPECIAL
            // TIER table, so a member was priced above an identical non-member.
            // D-99 §1.5 keeps the family for the one reason D-96 actually gave —
            // a bounty-vault rebate that never exhausts, 1 in 100 primes at
            // every depth by Dirichlet's theorem — and strips everything else
            // from it: no points, no bit, no price lift, no badge. It is a
            // REBATE class now and nothing more, which is why it lives in
            // `shared/opcodes.ts` as `REBATE_KIND.PRIME_FAMILY` rather than in
            // the score table.
            //
            // The assertion that says that, and the only one that can: a member
            // must be indistinguishable from a non-member of the same shape.
            const m = await marketPastOrdinaryPrimes();

            // 100193 — prime, past the 100,000 bound, ≡ 1 mod 101, and plain in
            // every other respect (not twin, not Sophie Germain, not safe, not
            // an emirp, digit sum 14, not a landmark).
            const member = await m.getScoreBreakdown(100_193n);
            expect(100_193n % 101n).toBe(1n); // the fixture really is in the family
            // 100069 — a NON-member (100069 mod 101 = 87) of exactly the same
            // shape: six digits, prime, and no other bit.
            const control = await m.getScoreBreakdown(100_069n);
            expect(100_069n % 101n).not.toBe(1n);

            // Same bits, same points, same price. If D-96's lift ever came back
            // — as a bit, a weight or a clamp exemption — this is what breaks.
            expect(member).toEqual(control);
            expect(flagKeys(member.flags)).toEqual(['prime']);
            // LEN (6 digits) + the prime bit, and nothing for the family.
            expect(member.score).toBe(SCORE_TERMS.LEN_W * (SCORE_TERMS.LEN_REF - 6) + 15);
            expect((await m.getLotPrice(100_193n)).p0).toBe((await m.getLotPrice(100_069n)).p0);

            // The same, from the other end of the predicate: 98779 is ≡ 1 mod 101
            // but BELOW the bound, so it is not in the family at all — and it
            // still scores nothing for it. (It carries `emirp` on its own
            // account: 97789 is prime. That is a FORM bit the family did not buy.)
            expect(98_779n % 101n).toBe(1n);
            expect(flagKeys((await m.getScoreBreakdown(98_779n)).flags)).toEqual(['prime', 'emirp']);
        });

        /**
         * Layout §9 item 2, filed as a SAFETY PROPERTY rather than a behaviour:
         * "MODE_DUTCH_BUYNOW settles in-transaction and never opens a clock.
         * Otherwise the head stalls and D-4a's guarantee is void."
         */
        it('opens with no clock, and a purchase closes the lot in the same transaction', async () => {
            // D-88 point 3: the descending lane needs the turn to have passed,
            // so this runs against the fixture whose head hint is already past
            // 541 rather than against the genesis-head market.
            const m = await marketPastOrdinaryPrimes();
            await m.sendOpenHeadLot(buyer.getSender(), { n: ORDINARY_PRIME, value: toNano('0.2') });
            expect((await m.getLot(ORDINARY_PRIME)).closesAt).toBe(0);

            const lot = await m.getLot(ORDINARY_PRIME);
            await m.sendBid(buyer.getSender(), {
                n: ORDINARY_PRIME,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment + toNano('0.2'),
            });

            const after = await m.getLot(ORDINARY_PRIME);
            expect(after.closed).toBe(true);
            // The clock never started, so it cannot have been extended either.
            expect(after.closesAt).toBe(0);
            expect((await m.getMarketStats()).closedLots).toBe(1);
        });

        /**
         * The floor is what makes the lane a price and not a gate, so a bid AT
         * the floor — the worst case a seller ever sees — must be accepted. If
         * this rejected, an unsold prime would be permanently unsellable, which
         * is the exact liveness failure D-20 point 2 exists to close.
         */
        it('accepts a purchase at the floor once the ramp has run out', async () => {
            // Same 2-or-3-only constraint as above. Under D-99 the floor being
            // bid at is `getPrimeFloor(3)` — a third of 3's own opening price,
            // and 3 is a heavily scored number (Mersenne, twin, Sophie Germain,
            // Fibonacci, triangular... it CLAMPS at SCORE_MAX), so this is a
            // large floor rather than 1 GRAM. The point of the test is unchanged
            // and is if anything sharper for it: a bid at the resting price must
            // be accepted however high that price is, or an unsold prime is
            // permanently unsellable.
            const priceMin = await market.getPrimeFloor(3n);
            const { decaySeconds: specialDecaySeconds } = await market.getPrimeDutchTerms();
            await openHeadLot(3n);
            blockchain.now = 1_770_000_000 + specialDecaySeconds + 1;

            const lot = await market.getLot(3n);
            expect(lot.standingPrice).toBe(priceMin);

            await market.sendBid(buyer.getSender(), {
                n: 3n,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment + toNano('0.2'),
            });
            expect((await market.getLot(3n)).closed).toBe(true);
        });
    });

    // =====================================================================
    // MKT-2 — DISCHARGED BY DELETION (D-90)
    // =====================================================================
    //
    // MKT-2 bounded the packed size of `ReservationRecord` — the escrow record a
    // won lot used to create on a shard — because the layout's own arithmetic put
    // it at 1,079 bits worst case against TON's 1,023-bit cell limit, and it fit
    // only because `coins` is variable-width and never reaches its 124-bit
    // maximum at real magnitudes. That was a live hazard rather than a solved
    // problem, which is why it was an invariant with a suite behind it.
    //
    // D-90.3 deletes the record, the shard and the hazard together: a won lot
    // MINTS AT CLOSE, so nothing is written that could overflow a cell. There is
    // no narrower assertion left to make — the risk is gone, not smaller.

    // =====================================================================
    // MKT-3 — the premium is counted once, and now only once anywhere
    // =====================================================================
    describe('MKT-3 · no premium double-count', () => {
        /**
         * MKT-3 promised that the router's `lotPremiumTotal` and the shard's
         * `totalPremium` never counted the same nanoton. D-90 discharges it
         * structurally: the shard is deleted, so there is exactly ONE premium
         * counter in the system and nothing to double-count against.
         *
         * What is still worth asserting is the routing itself — that a lot's
         * premium reaches the ratchet at close, on both lanes, and that the
         * settlement message carries none of it.
         */
        it('books an ascending lot premium to the router total at close', async () => {
            const before = await market.getMarketStats();

            await openAscendingLot();
            await closeAscendingLot();

            const after = await market.getMarketStats();
            expect(after.lotPremiumTotal).toBeGreaterThan(before.lotPremiumTotal);
            expect(after.closedLots - before.closedLots).toBe(1);
        });

        it('books a prime purchase premium the same way, on the descending lane', async () => {
            const before = await market.getMarketStats();

            await openHeadLot(3n);
            const lot = await market.getLot(3n);
            await market.sendBid(buyer.getSender(), {
                n: 3n,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment + toNano('0.2'),
            });

            expect((await market.getMarketStats()).lotPremiumTotal).toBeGreaterThan(before.lotPremiumTotal);
        });

        /**
         * The strongest form of MKT-3 after D-90: there is no second pool. The
         * market holds no refundable customer money at all, so `balance ≈
         * declared liability` has one fewer term than it did — which is why
         * `getTotalEscrow` / `getTotalPremium` / `getEscrowAggregate` are gone
         * rather than pinned at zero.
         */
        it('publishes no escrow aggregate at all (D-90.3)', async () => {
            await winLot({ blockchain, market }, reserver, RESERVABLE_12);
            await expect(
                (market as any).getEscrowAggregate?.() ?? Promise.reject(new Error('no such method'))
            ).rejects.toBeDefined();
        });
    });
    // =====================================================================
    // MKT-4 — no stake uplift writer (D-168)
    // =====================================================================
    describe('MKT-4 · the k_max stake leg is gone', () => {
        // D-168 deleted `set_stake_uplift` with the fifth uplift leg; an
        // unauthenticated uplift would enter the summed `k_max`, so a returning
        // writer fails here rather than silently.
        it('exposes no set_stake_uplift entry point on the ledger or the market', async () => {
            const fs = await import('fs');
            for (const f of ['primes_ledger.tolk', 'primes_market.tolk']) {
                const src = await fs.promises.readFile(require.resolve(`../contracts/${f}`), 'utf8');
                expect(src).not.toMatch(/SetStakeUplift\s*=>/);
            }
        });
    });


    // =====================================================================
    // D-30 / D-31 — the unified acquisition lane
    //
    // CONCEPT §4.4's 2026-08-19 superseding preamble. There is ONE route to a
    // number ahead of the head and it depends only on primality. These are the
    // assertions that the two gates it deletes are really gone, and that the one
    // it moves (the Dutch clock) lands where the decision says it does.
    // =====================================================================
    describe('D-30 · any composite may be opened as an ascending lot', () => {
        /**
         * 46 = 2 · 23 scores 28 on the digit layers — under the OLD `D_MIN` of
         * 30, which is exactly why it is the fixture. Before D-30 this number was
         * refused by `open_lot` with `mkt_not_on_auction_lane` (1006) and sent to
         * the flat-fee `reserve` lane instead; that lane no longer exists, so a
         * refusal here would leave 46 with no route at all.
         */
        const PLAIN = { n: 46n, factors: [{ prime: 2n, exponent: 1, s: 1n }, { prime: 23n, exponent: 1, s: 4n }] };

        it('opens a lot on a composite that scored below the retired D_MIN', async () => {
            const quote = await market.getLotPriceFrom(PLAIN.n, PLAIN.factors);
            expect(quote.score).toBeLessThan(30); // the fixture is still the case it was chosen for

            const opened = await market.sendOpenLot(buyer.getSender(), {
                n: PLAIN.n,
                kind: 0,
                factors: PLAIN.factors,
                beneficiary: null,
                referralKey: 0,
                value: quote.p0 + toNano('0.1'),
            });
            expect(opened.transactions).toHaveTransaction({ to: market.address, success: true });

            const lot = await market.getLot(PLAIN.n);
            expect(lot.found).toBe(true);
            expect(lot.mode).toBe(MODE_ASCENDING);
            // Opening IS the first bid, and it is booked WHOLE — the fee margin
            // rides into the opener's own bid rather than becoming untracked
            // balance on the contract.
            expect(lot.highBid).toBe(quote.p0 + toNano('0.1'));
            expect(lot.closesAt).toBeGreaterThan(0); // the 7-day clock runs from that bid
        });

        /**
         * D-45: NO DISTANCE GATE. `MIN_AUCTION_DISTANCE` is deleted, not
         * widened — a lot may open at any distance ahead of the head,
         * including the very next number, because the head now SKIPS a
         * reserved composite forever rather than ever colliding with one. This
         * block replaces the old "MIN_AUCTION_DISTANCE at the shipped 20,000"
         * describe, which pinned the gate this decision removes.
         */
        describe('D-45 — the auction-distance gate is deleted; the head skips instead', () => {
            it('opens a lot immediately next to the head — no distance gate left to refuse it', async () => {
                // OPENING_HEAD = 4n. Under the deleted gate this would have
                // needed n > 20,004; under D-45, composite 8 — four positions
                // from the head — opens on the first try. (Not 6: 2·3 is a
                // primorial, and primorials are refused on this lane for an
                // unrelated reason — `mkt_primorial_not_auctionable`, 1008.)
                expect(await market.getHeadHint()).toBe(OPENING_HEAD);
                const near = { n: 8n, factors: [{ prime: 2n, exponent: 3, s: 1n }] };
                const opened = await market.sendOpenLot(buyer.getSender(), {
                    n: near.n,
                    kind: 0,
                    factors: near.factors,
                    beneficiary: null,
                    referralKey: 0,
                    value: (await market.getLotPriceFrom(near.n, near.factors)).p0 + toNano('0.1'),
                });
                expect(opened.transactions).toHaveTransaction({ to: market.address, success: true });
                expect((await market.getLot(near.n)).found).toBe(true);
                // D-45's whole point: the ledger now knows about it too.
                expect(await ledger.isNumberOffHead(near.n)).toBe(1);
            });

            it('still refuses n <= headHint — the cheap pre-filter survives, only the distance is gone', async () => {
                const atHead = await market.sendOpenLot(buyer.getSender(), {
                    n: OPENING_HEAD,
                    kind: 0,
                    factors: [{ prime: 2n, exponent: 2, s: 1n }], // 4 = 2^2
                    beneficiary: null,
                    referralKey: 0,
                    value:
                        (await market.getLotPriceFrom(OPENING_HEAD, [{ prime: 2n, exponent: 2, s: 1n }])).p0 +
                        toNano('0.1'),
                });
                expect(atHead.transactions).toHaveTransaction({
                    to: market.address, success: false, exitCode: 1007, // mkt_at_or_behind_head
                });
                expect((await market.getLot(OPENING_HEAD)).found).toBe(false);
            });

            /**
             * THE RACE THE OLD DISTANCE GATE USED TO PREVENT BY MARGIN, D-45
             * NOW HANDLES BY REJECTION-AND-REFUND. The market's `headHint` LAGS
             * the real ledger head; here it lags enough that an open the market
             * thinks is safe lands on a number a direct mint already reached.
             * `mark_off_head`'s ledger-side check is what actually catches it —
             * the whole point of moving the send to `open_lot` and keeping the
             * market's own `n > headHint` check merely a pre-filter.
             */
            it('a stale headHint lets an open through, but the ledger rejects it and the opener is refunded in full', async () => {
                // Mint composite 4 then composite 6 directly — both are the
                // head at the moment they mint, so both succeed — WITHOUT ever
                // syncing the market's `headHint` (no `sync_head`, and
                // settlement no longer pushes one either — see
                // `primes_ledger.tolk`'s `handleSettle` D-45 note). The real
                // ledger head walks 4 -> 5 (prime, skipped) -> 6, then
                // 6 -> 7 (prime, skipped) -> 8: `8` becomes the real head, but
                // the market still believes `4`.
                const mint4 = await ledger.sendMint(buyer.getSender(), {
                    n: 4n, kind: 0,
                    factors: [{ prime: 2n, exponent: 2, s: 1n }],
                    referralKey: 0, beneficiary: null,
                    value: MINT_PRICE + toNano('0.1'),
                });
                expect(mint4.transactions).toHaveTransaction({ to: ledger.address, success: true });
                expect(await ledger.getHead()).toBe(6n);
                const mint6 = await ledger.sendMint(buyer.getSender(), {
                    n: 6n, kind: 0,
                    factors: [{ prime: 2n, exponent: 1, s: 1n }, { prime: 3n, exponent: 1, s: 1n }],
                    referralKey: 0, beneficiary: null,
                    value: MINT_PRICE + toNano('0.1'),
                });
                expect(mint6.transactions).toHaveTransaction({ to: ledger.address, success: true });
                expect(await ledger.getHead()).toBe(8n);
                expect(await market.getHeadHint()).toBe(OPENING_HEAD); // still 4 — genuinely stale

                const beforeBalance = await buyer.getBalance();
                const opened = await market.sendOpenLot(buyer.getSender(), {
                    n: 8n, // the market's stale hint reads this as "ahead"; the real head is already here
                    kind: 0,
                    factors: [{ prime: 2n, exponent: 3, s: 1n }],
                    beneficiary: null,
                    referralKey: 0,
                    value: (await market.getLotPriceFrom(8n, [{ prime: 2n, exponent: 3, s: 1n }])).p0 + toNano('0.5'),
                });
                // The market's own OpenLot handler succeeds (its cheap check
                // passed) — the refusal happens one hop later, on the ledger,
                // and is carried back as `mark_rejected`.
                expect(opened.transactions).toHaveTransaction({ to: market.address, success: true });
                expect(opened.transactions).toHaveTransaction({ to: ledger.address, success: true });
                expect(opened.transactions).toHaveTransaction({ from: ledger.address, to: market.address });
                // The lot never survives the round trip...
                expect((await market.getLot(8n)).found).toBe(false);
                // ...8 was never marked (it was minted directly, not auctioned)...
                expect(await ledger.isNumberOffHead(8n)).toBe(0);
                // ...and the opener is made whole, minus only their own gas.
                expect(opened.transactions).toHaveTransaction({ from: market.address, to: buyer.address });
                const afterBalance = await buyer.getBalance();
                // A generous bound: lost nothing close to the bid itself (>1 GRAM
                // of the ~1.06+0.5 GRAM attached came back), only gas.
                expect(afterBalance).toBeGreaterThan(beforeBalance - toNano('0.2'));
            });

            it('a prime next to the head opens on the ASCENDING lane, at the same P0 (D-88 pt 3)', async () => {
                // D-88 REPLACES this test's original subject. D-45 deleted the
                // DISTANCE gate and D-31 had also deleted the TURN gate, so a
                // prime opened a descending lot at any distance; D-88 point 3
                // puts it back — ahead of the head a prime is a paid ascending
                // auction, and `open_head_lot` refuses it with 1024.
                //
                // 541 is a confirmed-ordinary prime under both the D-68 and the
                // D-96 regimes (see ORDINARY_PRIME above) and it is far ahead of
                // this fixture's head hint of 4.
                const refused = await market.sendOpenHeadLot(buyer.getSender(), {
                    n: 541n, value: toNano('0.2'),
                });
                expect(refused.transactions).toHaveTransaction({
                    to: market.address,
                    success: false,
                    exitCode: 1024, // mkt_decay_not_due — the turn has not come
                });
                expect((await market.getLot(541n)).found).toBe(false);

                // The route that DOES work, at the very price the descending
                // lane would have opened at, which is the whole of point 3.
                const { p0 } = await market.getLotPrice(541n);
                const opened = await market.sendOpenLot(buyer.getSender(), {
                    n: 541n,
                    kind: 1,
                    factors: [],
                    beneficiary: null,
                    referralKey: 0,
                    value: p0 + toNano('0.1'),
                });
                expect(opened.transactions).toHaveTransaction({ to: market.address, success: true });
                const lot = await market.getLot(541n);
                expect(lot.found).toBe(true);
                expect(lot.mode).toBe(MODE_ASCENDING);
                expect(lot.p0).toBe(p0);
                expect(lot.closesAt).toBeGreaterThan(0); // opening IS the first bid (D-3)
            });
        });

        /**
         * The other half of "opening is a paid first bid": an open that does not
         * fund its own bid is refused. Without this, D-30's route is free to
         * open and lot-opening becomes costless griefing.
         */
        it('refuses an open that does not fund its own bid', async () => {
            const quote = await market.getLotPriceFrom(PLAIN.n, PLAIN.factors);
            const short = await market.sendOpenLot(buyer.getSender(), {
                n: PLAIN.n,
                kind: 0,
                factors: PLAIN.factors,
                beneficiary: null,
                referralKey: 0,
                value: quote.p0 - toNano('0.01'),
            });
            expect(short.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: 1003, // mkt_open_below_p0
            });
            expect((await market.getLot(PLAIN.n)).found).toBe(false);
        });

        /** §7 survives untouched: an era boundary is on NEITHER lane, at any price. */
        it('still refuses a primorial, and still answers for it rather than throwing', async () => {
            expect(await market.getIsOpenable(30n)).toBe(false);
            expect(await market.getLotLane(30n)).toBe(-1);

            const opened = await market.sendOpenLot(buyer.getSender(), {
                n: 30n,
                kind: 0,
                factors: [
                    { prime: 2n, exponent: 1, s: 1n },
                    { prime: 3n, exponent: 1, s: 1n },
                    { prime: 5n, exponent: 1, s: 2n },
                ],
                beneficiary: null,
                referralKey: 0,
                value: toNano('130'),
            });
            expect(opened.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: 1008, // mkt_primorial_not_auctionable
            });
        });

        /**
         * D-88 point 3 REVERSES D-22: the ascending lane takes primes now, and
         * this is the test that used to assert the opposite (`exitCode: 1023`,
         * an error code D-88 retires). What replaces the lane gate is a PROOF
         * gate — `kind` selects which proof the handler demands, and lying about
         * it is refused.
         */
        it('takes a prime on the ascending lane, and refuses a lie about `kind`', async () => {
            const { p0 } = await market.getLotPrice(101n);
            const opened = await market.sendOpenLot(buyer.getSender(), {
                n: 101n,
                kind: 1,
                factors: [],
                beneficiary: null,
                referralKey: 0,
                value: p0 + toNano('0.1'),
            });
            expect(opened.transactions).toHaveTransaction({ to: market.address, success: true });
            expect((await market.getLot(101n)).mode).toBe(MODE_ASCENDING);

            // A COMPOSITE claimed as prime fails Miller-Rabin. 561 is a
            // Carmichael number — it passes a Fermat test, so this is the case
            // that would slip through a weaker primality check rather than a
            // trivially composite one.
            const lying = await market.sendOpenLot(buyer.getSender(), {
                n: 561n,
                kind: 1,
                factors: [],
                beneficiary: null,
                referralKey: 0,
                value: toNano('130'),
            });
            expect(lying.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: 201, // bad_factorization — the proof, not the lane
            });
        });
    });

    // =====================================================================
    // D-88 · TWO LANES, SPLIT BY THE HEAD
    //
    // REPLACES this file's D-31 block (a prime openable before its turn at a
    // flat P0) and its D-50 block (sweeping an unbought lot after two decay
    // windows). Both mechanics are deleted; what follows asserts what took
    // their place.
    // =====================================================================
    describe('D-88 · a prime ahead of the head is an ascending auction; behind it, a descending one', () => {
        /**
         * 5 is prime and its turn has NOT come: this fixture's head opens at 4,
         * and 5 is next among not-yet-built numbers only once 4 is minted. It is
         * also a twin prime, a Sophie Germain prime, a safe prime, a Fibonacci
         * number and a landmark, so it scores heavily and its price is lifted —
         * which under D-88 point 2 and D-99 is all that being special does.
         */
        const EARLY = 5n;

        it('refuses the DESCENDING lane before the turn, and names the turn as the reason', async () => {
            expect(await market.getHeadHint()).toBe(OPENING_HEAD);
            expect(EARLY).toBeGreaterThanOrEqual(OPENING_HEAD); // the turn has NOT come

            const refused = await market.sendOpenHeadLot(buyer.getSender(), { n: EARLY, value: toNano('0.2') });
            expect(refused.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: 1024, // mkt_decay_not_due
            });
            // And nothing was written: a refused open must not leave a record
            // behind for the ascending route to collide with.
            expect((await market.getLot(EARLY)).found).toBe(false);
        });

        it('opens the ASCENDING lane at exactly the P0 the descending lane would have quoted', async () => {
            // THIS IS THE SENTENCE D-88 POINT 3 TURNS ON: "it starts with the max
            // price of when it would start by reaching head". Both handlers call
            // the same `openingPriceOf`, so the equality below is structural
            // rather than a coincidence of two formulas that happen to agree.
            const { p0: quoted } = await market.getLotPrice(EARLY);
            expect(quoted).toBeGreaterThan(MINT_PRICE);

            const opened = await market.sendOpenLot(buyer.getSender(), {
                n: EARLY,
                kind: 1,
                factors: [],
                beneficiary: null,
                referralKey: 0,
                value: quoted + toNano('0.1'),
            });
            expect(opened.transactions).toHaveTransaction({ to: market.address, success: true });

            const lot = await market.getLot(EARLY);
            expect(lot.mode).toBe(MODE_ASCENDING);
            expect(lot.p0).toBe(quoted);
            // Opening IS a paid first bid (D-30/D-88), so the whole payment is
            // booked as the standing high and the 7-day clock is already running.
            expect(lot.highBid).toBe(quoted + toNano('0.1'));
            expect(lot.closesAt).toBeGreaterThan(0);
        });

        it('does NOT put the prime on the sequential line — no reservation to settle (D-88 pt 4)', async () => {
            const { p0 } = await market.getLotPrice(EARLY);
            const opened = await market.sendOpenLot(buyer.getSender(), {
                n: EARLY,
                kind: 1,
                factors: [],
                beneficiary: null,
                referralKey: 0,
                value: p0 + toNano('0.1'),
            });
            expect(opened.transactions).toHaveTransaction({ to: market.address, success: true });
            // A prime is not on the line — the head skips it (D-20) — so there is
            // no reservation to settle, and D-22's original objection (an escrow
            // that is cancellable but never settleable) has nothing to attach to.
            // D-196: the open DOES claim `n` on the ledger, for either kind: that
            // claim is the one record that refuses a second lot on it.
            expect(await ledger.isNumberOffHeadResolved(EARLY)).toBe(true);
            expect(await ledger.isKnownPrime(EARLY)).toBe(0); // not sold, not crossed
        });

        it('mints the prime AT CLOSE, on the spot, rather than escrowing a claim (D-88 pt 4)', async () => {
            const { p0 } = await market.getLotPrice(EARLY);
            await market.sendOpenLot(buyer.getSender(), {
                n: EARLY,
                kind: 1,
                factors: [],
                beneficiary: null,
                referralKey: 0,
                value: p0 + toNano('0.1'),
            });
            const lot = await market.getLot(EARLY);
            blockchain.now = lot.closesAt + 1;
            const closed = await market.sendClose(buyer.getSender(), { n: EARLY, value: toNano('0.3') });
            expect(closed.transactions).toHaveTransaction({ to: market.address, success: true });

            // The close settles straight to the LEDGER, which runs the ordinary
            // §4.1 split and clears the prime's forfeiture — no shard hop, no
            // waiting for a head that will never arrive.
            expect(closed.transactions).toHaveTransaction({
                from: market.address,
                to: ledger.address,
                success: true,
            });
            // D-196: settled ahead of `headHint` — no row, no sold bit; the claim is on the ledger.
            expect((await market.getLot(EARLY)).found).toBe(false);
            expect(await ledger.isNumberOffHeadResolved(EARLY)).toBe(true);
        });

        it('a prime sold ahead of the head is not re-listed unsold when the head passes it', async () => {
            const { p0 } = await market.getLotPrice(EARLY);
            await market.sendOpenLot(buyer.getSender(), {
                n: EARLY,
                kind: 1,
                factors: [],
                beneficiary: null,
                referralKey: 0,
                value: p0 + toNano('0.1'),
            });
            blockchain.now = (await market.getLot(EARLY)).closesAt + 1;
            await market.sendClose(buyer.getSender(), { n: EARLY, value: toNano('0.3') });
            const countBefore = await ledger.getPrimesCount();

            await ledger.sendMint(deployer.getSender(), {
                n: 4n,
                kind: 0,
                factors: [{ prime: 2n, exponent: 2, s: 1n }],
                referralKey: 0,
                beneficiary: null,
                value: toNano('1.2'),
            });
            expect(await ledger.getHead()).toBeGreaterThan(EARLY);
            // Counted into π(n) once, when the head reached it -- not at sale.
            expect(await ledger.getPrimesCount()).toBe(countBefore + 1);
            // But it already has an owner: an unsold entry would block its
            // dividend claim for ever (throw 219) and forfeit its tribute share.
            expect(await ledger.isPrimeUnsold(EARLY)).toBe(false);

            // D-188 point 4: its item already exists, so the walk PARKED its stamp
            // on the ledger; the first claim hands it over and pays only what
            // accrued after the head crossed it.
            const stamp = await ledger.getDivEntryRaw(EARLY);
            expect(stamp).toBeGreaterThanOrEqual(0n);
            await ledger.sendMint(deployer.getSender(), {
                n: await ledger.getHead(),
                kind: 0,
                factors: [{ prime: 2n, exponent: 1, s: 1n }, { prime: 3n, exponent: 1, s: 1n }],
                referralKey: 0,
                beneficiary: null,
                value: toNano('1.2'),
            });
            const accrued = (await ledger.getDivAcc()) - stamp;
            expect(accrued).toBeGreaterThan(0n);
            const item = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(EARLY)));
            // Born UNSTAMPED, not at 0: a `credit_dividend` that reaches it
            // without `base` (the bounce/retry_item race) must pay nothing,
            // not the whole history since genesis.
            expect(await item.getDivEntry()).toBe((1n << 120n) - 1n);
            const owedBefore = await item.getOwed();
            await blockchain.sendMessage(internal({
                from: ledger.address,
                to: item.address,
                value: toNano('0.05'),
                body: beginCell()
                    .storeUint(0xb0000036, 32).storeUint(0, 64).storeUint(EARLY, 256)
                    .storeCoins(await ledger.getDivAcc()).storeBit(false)
                    .endCell(),
            }));
            expect(await item.getOwed()).toBe(owedBefore);
            const claim = await ledger.sendClaimDividend(buyer.getSender(), { p: EARLY, value: toNano('0.05') });
            expect(claim.transactions).not.toHaveTransaction({ success: false });
            expect((await item.getOwed()) - owedBefore).toBe(accrued);
            expect(await ledger.getDivEntryRaw(EARLY)).toBe(-1n); // handed to the item
            expect(await item.getDivEntry()).toBe(await ledger.getDivAcc());
        });

        /**
         * The transition, end to end: mint 4, which walks the ledger's head past
         * 5, push the market's lagging hint with `sync_head`, and the SAME prime
         * that was an ascending auction a moment ago is now a descending one.
         * From there D-4's liveness guarantee is asserted — monotone decay,
         * terminating at exactly `getPrimeFloor`, and parking there.
         */
        it('switches lanes at the turn, then decays monotonically and PARKS at its resting price', async () => {
            const { p0: quoted } = await market.getLotPrice(EARLY);
            const priceMin = await market.getPrimeFloor(EARLY);
            const { decaySeconds } = await market.getPrimeDutchTerms();
            expect(priceMin).toBeGreaterThan(MINT_PRICE); // 5's score lifts it (D-99 §1.2)
            expect(await market.getLotLane(EARLY)).toBe(MODE_ASCENDING);

            await ledger.sendMint(deployer.getSender(), {
                n: 4n,
                kind: 0,
                factors: [{ prime: 2n, exponent: 2, s: 1n }],
                referralKey: 0,
                beneficiary: null,
                value: toNano('1.2'),
            });
            // D-20: the head walks past 5 (prime) and lands on 6.
            expect(await ledger.getHead()).toBeGreaterThan(EARLY);
            await ledger.sendSyncHead(buyer.getSender(), { value: toNano('0.1') });
            expect(await market.getHeadHint()).toBeGreaterThan(EARLY);
            expect(await market.getLotLane(EARLY)).toBe(MODE_DUTCH_BUYNOW);

            const t0 = blockchain.now ?? 0;
            const opened = await market.sendOpenHeadLot(buyer.getSender(), { n: EARLY, value: toNano('0.2') });
            expect(opened.transactions).toHaveTransaction({ to: market.address, success: true });

            // D-88 point 3: the clock starts AT OPEN — the turn has passed by
            // construction, so there is no parked state and no second message.
            // At the opening instant the price is still P0: the decay begins at
            // the turn, it does not jump at it.
            expect((await market.getLot(EARLY)).standingPrice).toBe(quoted);

            let previous = quoted;
            for (const frac of [0.1, 0.25, 0.5, 0.75, 0.99]) {
                blockchain.now = t0 + Math.floor(decaySeconds * frac);
                const price = (await market.getLot(EARLY)).standingPrice;
                expect(price).toBeLessThan(previous); // strictly monotone
                expect(price).toBeGreaterThan(priceMin); // never below the resting price
                expect(price).toBeLessThanOrEqual(quoted); // NEVER above P0
                previous = price;
            }

            // The terminus is EXACTLY `getPrimeFloor(n)`, and the lot PARKS
            // there — unbought, undeleted, for as long as it takes. D-50's
            // sweep, which would have deleted it at two windows, is gone.
            blockchain.now = t0 + decaySeconds;
            expect((await market.getLot(EARLY)).standingPrice).toBe(priceMin);
            blockchain.now = t0 + decaySeconds * 40;
            const parked = await market.getLot(EARLY);
            expect(parked.found).toBe(true);
            expect(parked.closed).toBe(false);
            expect(parked.standingPrice).toBe(priceMin);
            // And the payment the contract will actually measure is that resting
            // price plus RES_GAS, still, however long it has stood there.
            // D-113: RES_GAS 0.06 -> 0.07.
            expect(parked.minPayment).toBe(priceMin + toNano('0.07'));
        });

        /**
         * The structural half of "a sold prime is never relisted": `closeLot`
         * MARKS the record rather than deleting it, and D-88 deleted the one
         * message that ever deleted an unsold one. So the second open is
         * refused by the record itself, not by a check somebody could forget.
         */
        it('never relists a prime that has already sold', async () => {
            // A market whose head hint is already past 541, so the descending
            // lane is open for it with no mint/sync_head walk first. 541 is the
            // first confirmed-ordinary prime (D-68 makes every prime below 500
            // heavily scored), which keeps this about relisting rather than
            // about price.
            const SOLD = 541n;
            const m = blockchain.openContract(
                PrimesMarket.createFromConfig(
                    testMarketConfig({
                        headHint: 600n,
                        ledgerAddr: deployer.address,
                        ratchetAddr: ratchet.address,
                    }),
                    marketCode
                )
            );
            await m.sendDeploy(deployer.getSender(), toNano('5'));
            await m.sendLaunchOpen(deployer.getSender(), { value: toNano('0.05') });
            await m.sendOpenHeadLot(buyer.getSender(), { n: SOLD, value: toNano('0.2') });
            const lot = await m.getLot(SOLD);
            await m.sendBid(buyer.getSender(), {
                n: SOLD,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment + toNano('0.1'),
            });
            expect((await m.getLot(SOLD)).closed).toBe(true);

            const again = await m.sendOpenHeadLot(buyer.getSender(), { n: SOLD, value: toNano('0.2') });
            expect(again.transactions).toHaveTransaction({
                to: m.address,
                success: false,
                exitCode: 1002, // mkt_lot_already_closed
            });
        });
    });

    // =====================================================================
    // The cap — GAUNTLET P2.C1's outstanding test
    // =====================================================================
    describe('AUCTIONABLE_MAX · a 78-digit open is refused by the cap (GAUNTLET P2.C1)', () => {
        /**
         * The original bug was diagnosed as a premium overflow and was actually
         * Miller-Rabin: `modpow` squares a residue, so a 78-digit argument needs
         * ~2^518 and blows int257 — which is why it threw exit 4 rather than a
         * bound violation. D-18's fix is structural: `n` is uint64 inside the
         * market and every entry point that accepts one asserts the cap first, so
         * the intermediate stays under 2^92.
         *
         * P2.C1 asks for this as an assertion that the cap REFUSES the number,
         * not that MR survives it. The distinction matters: a test that only
         * checked "no exit 4" would pass on a build where the cap had been
         * removed and MR had merely got luckier.
         */
        it('publishes the cap, and it is below the 2^46 bound the overflow argument needs', async () => {
            const cap = await market.getAuctionableMax();
            expect(cap).toBe(42_949_672_959_999n);
            expect(cap).toBeLessThan(1n << 46n);
        });

        it('refuses an over-cap number on BOTH lot lanes', async () => {
            const cap = await market.getAuctionableMax();

            const opened = await market.sendOpenLot(buyer.getSender(), {
                n: cap + 1n,
                kind: 0,
                factors: [],
                beneficiary: null,
                referralKey: 0,
                value: toNano('2'),
            });
            expect(opened.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: EXIT_N_ABOVE_CAP,
            });

            const head = await market.sendOpenHeadLot(buyer.getSender(), { n: cap + 1n, value: toNano('0.2') });
            expect(head.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: EXIT_N_ABOVE_CAP,
            });
        });

        /**
         * The cap is checked BEFORE the head-position test, and that ordering is
         * the whole point: an over-cap number is refused on the cheap comparison
         * and never reaches `isPrimeMR`. If the two were swapped, a number above
         * the cap but behind the head would still run MR and still overflow.
         */
        it('checks the cap before any test that would run Miller-Rabin', async () => {
            const cap = await market.getAuctionableMax();
            // This n is over the cap AND (being enormous) far ahead of the head,
            // so both guards would fire. The cap must be the one that does.
            const tx = await market.sendOpenHeadLot(buyer.getSender(), { n: cap + 1n, value: toNano('0.2') });
            expect(tx.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: EXIT_N_ABOVE_CAP,
            });
            expect(tx.transactions).not.toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: EXIT_NOT_BEHIND_HEAD,
            });
        });

        /**
         * The read side of the same guarantee. §9.1 requires the UI's button to
         * be driven by a get-method, and the UI is exactly where a 78-digit
         * number gets typed in — so `getIsOpenable` must ANSWER for one rather
         * than throw, and `getLotPrice` must refuse with the cap's own error
         * rather than an arithmetic accident.
         */
        it('answers rather than throws when the UI asks about a 78-digit number', async () => {
            const n78 = 10n ** 77n + 1n;
            expect(n78.toString()).toHaveLength(78);

            // D-30 renames the pair: `getIsOpenable` replaces `getIsReservable`,
            // and `getLotPrice` is the only quote there is now.
            expect(await market.getIsOpenable(n78)).toBe(false);
            await expect(market.getLotPrice(n78)).rejects.toThrow();
        });

        /**
         * P2.C1's reopened half: the get-methods that used to run Miller-Rabin
         * on an UNGUARDED argument.
         */
        it('getLotLane answers -1 and getLotPrice throws the cap error for a 78-digit number', async () => {
            const n78 = 10n ** 77n + 1n;

            // `getLotLane` replaces `getIsAuctionOnly` (deleted with D_MIN —
            // every openable number is auction-only now). It is the predicate the
            // webapp's Pick step calls on numbers the user typed, so it must
            // ANSWER (-1, "not openable at all") rather than throw.
            expect(await market.getLotLane(n78)).toBe(-1);
            await expect(market.getLotPrice(n78)).rejects.toThrow();

            // Just over the cap behaves identically to astronomically over it.
            const cap = await market.getAuctionableMax();
            expect(await market.getLotLane(cap + 1n)).toBe(-1);
            await expect(market.getLotPrice(cap + 1n)).rejects.toThrow();
            // And at the cap both still ANSWER — the guard is >, not >=.
            expect(await market.getLotLane(cap)).toBeGreaterThanOrEqual(0);
            await market.getLotPrice(cap);
        });

        /**
         * GAUNTLET.md C1.4: `open_lot`/`open_head_lot`/`open_head_lot_composite`
         * all refuse a primorial (`mkt_primorial_not_auctionable`, 1008) — it is
         * acquired only at the head, so the era ceremony fires exactly when it
         * mints. `getIsOpenable`/`getLotLane` already agreed (both route through
         * `isOpenable`, which excludes primorials); `getLotPrice` did not, and
         * quoted a price for a number no lane would ever actually sell.
         */
        it('getLotPrice refuses a primorial exactly like every open_* handler does', async () => {
            const primorial = 30n; // 2*3*5, well within AUCTIONABLE_MAX
            expect(await market.getIsOpenable(primorial)).toBe(false);
            expect(await market.getLotLane(primorial)).toBe(-1);
            await expect(market.getLotPrice(primorial)).rejects.toThrow();
        });
    });
    // =====================================================================
    // D-90 — A WON COMPOSITE MINTS AT CLOSE
    // =====================================================================
    //
    // REPLACES the whole `D-32 — release for 90%` block. That block tested the
    // right to hand an escrowed claim back before the head arrived at it; D-90.2
    // deletes the right because D-90 deletes the claim. There is nothing to hand
    // back: the NFT exists from the close transaction onward, and the way out of
    // a number you no longer want is the secondary market.
    //
    // The deletion was not a preference. D-45 had already made `offHeadBitmap`
    // permanent and taught the head-advance walk to skip a reserved position
    // forever, so the head could never arrive at an auctioned composite — the
    // claim was waiting for an event that had been made impossible. The only
    // thing still standing between the close and the mint was the ledger's
    // requirement that every cited factor already be in its prime bitmap, and
    // D-90.1 answers that with Miller-Rabin at settlement.
    //
    // So this block asserts the feature itself, and the factor case is its
    // sharpest form: 20014 = 2 · 10007, won while the head is at 4, where 10007
    // is thousands of positions away and has never been marked.
    describe('D-90 - a won composite mints in the close transaction', () => {
        /** 12 = 2^2 · 3 — a plain composite above the opening head of 4. */
        const CLAIM = RESERVABLE_12;

        it('mints the NFT to the winner in the same transaction the lot closes', async () => {
            const win = await winLot({ blockchain, market }, reserver, CLAIM);

            // The close reached the LEDGER — not a shard, which no longer exists
            // — and the ledger accepted it.
            expect(win.closeResult.transactions).toHaveTransaction({
                to: ledger.address,
                success: true,
            });

            // ...and the item is deployed, owned by the winner, in that same
            // close. This is the assertion the whole change exists for.
            const item = blockchain.openContract(
                PrimesItem.createFromAddress(await ledger.getItemAddress(CLAIM.n))
            );
            const data = await item.getNftData();
            expect(data.init).toBe(-1); // TEP-62 init? is TVM true
            expect(data.index).toBe(CLAIM.n);
            expect(data.ownerAddress.equals(reserver.address)).toBe(true);

            // The head did NOT move: `advanceHead` is false on this path, and
            // D-45's permanent mark keeps the walk off this position forever.
            expect(await ledger.getHead()).toBeLessThan(CLAIM.n);
            expect(await ledger.isNumberOffHead(CLAIM.n)).toBe(1);

            // The premium still went to the ratchet at close, unchanged (D-90.4).
            expect(win.premium).toBeGreaterThan(0n);
            expect((await market.getMarketStats()).lotPremiumTotal).toBeGreaterThanOrEqual(win.premium);
        });

        /**
         * D-90.1 — THE ONE REAL BLOCKER, AND ITS FIX.
         *
         * `executeMint` requires every cited prime factor to be present in
         * `primeBitmap`, and a prime enters that bitmap only when the
         * head-advance walk crosses it. A composite bought ahead of the head can
         * cite a factor that is itself far ahead of the head — 2 · 10007 with the
         * head at 4 — and that factor is unmarked, so an immediate settlement
         * used to throw 201.
         *
         * The fix proves it instead: unmarked factors fall through to
         * Miller-Rabin. π(n), the flat dividend and mint order are untouched —
         * proving a factor prime is not the same as making it ELIGIBLE, and this
         * test pins that distinction.
         */
        it('proves an above-head cited factor by Miller-Rabin rather than refusing (D-90.1)', async () => {
            const { n, factors } = RESERVABLE_20014; // 2 · 10007
            const bigFactor = 10_007n;

            // The premise: 10007 is nowhere near the head and is NOT a known
            // prime as far as the ledger's bitmap is concerned.
            expect(await ledger.getHead()).toBeLessThan(bigFactor);
            expect(await ledger.isKnownPrime(bigFactor)).toBe(0);
            const piBefore = await ledger.getPrimesCount();
            const itemsBefore = (await ledger.getLaunch()).itemsMinted;

            const win = await winLot({ blockchain, market }, reserver, { n, factors });
            // 2026-11-08 audit: the lot's NFT counts into `getLaunch().itemsMinted`.
            expect((await ledger.getLaunch()).itemsMinted).toBe(itemsBefore + 1n);
            expect(win.closeResult.transactions).toHaveTransaction({
                to: ledger.address,
                success: true,
            });

            const item = blockchain.openContract(
                PrimesItem.createFromAddress(await ledger.getItemAddress(n))
            );
            expect((await item.getNftData()).ownerAddress.equals(reserver.address)).toBe(true);

            // The factor is STILL not eligible: proving it prime at settlement
            // does not mark it, does not count it into π(n), and does not put it
            // on the flat dividend line. Mint order is untouched.
            expect(await ledger.isKnownPrime(bigFactor)).toBe(0);
            expect(await ledger.getPrimesCount()).toBe(piBefore);
        });

        /**
         * The consequence D-90 had to record: a cited factor above the head has
         * no item to credit and is not in `unsoldPrimes` either, so today's
         * credit fan-out would send `credit_tribute` to a nonexistent item and
         * bounce. The rule is the one CONCEPT §6 point 2 already states for an
         * unsold prime — its divisor-line share FORFEITS TO THE TREASURY — and
         * `get_forfeited(p)` is where it shows up.
         */
        it('forfeits an above-head factor\'s divisor share to the treasury (§6 point 2)', async () => {
            const { n, factors } = RESERVABLE_20014; // 2 · 10007
            const bigFactor = 10_007n;
            expect(await ledger.getForfeited(bigFactor)).toBe(0n);
            const beyondBefore = await ledger.getForfeitedBeyondWindow();

            const win = await winLot({ blockchain, market }, reserver, { n, factors });
            expect(win.closeResult.transactions).not.toHaveTransaction({ on: ledger.address, aborted: true });

            // 10007 had no owner at settlement, so its whole weighted share of
            // the 80% divisor line forfeited rather than accruing on an item
            // nobody holds. It is the larger factor by weight (w = e·⌊√p⌋, so
            // 100 against 2's 1), which is what makes this a real number rather
            // than a rounding artefact — and it is the WHOLE point of the rule:
            // the big share is the one that would otherwise bounce.
            //
            // D-196: 10007 is beyond the ledger's import frontier, so the share
            // was CREDITED as if owned, bounced off the missing item, and forfeited
            // there — summed into `getForfeitedBeyondWindow`, not a per-prime row.
            expect(await ledger.getForfeited(bigFactor)).toBe(0n);
            const forfeited = (await ledger.getForfeitedBeyondWindow()) - beyondBefore;
            expect(forfeited).toBeGreaterThan(0n);
            expect(forfeited).toBeLessThanOrEqual(toNano('0.08'));

            // 2 forfeits here as well, but for the OTHER reason §6 point 2
            // already named — it is UNSOLD in this fixture, nobody bought it —
            // and by far the smaller amount, since its weight is 1 against
            // 10007's 100. D-90 widened the rule's reading to "a prime with no
            // owner", and these are its two ways of having none.
            expect(await ledger.isPrimeUnsold(2n)).toBe(true);
            expect(await ledger.getForfeited(2n)).toBeLessThan(forfeited);
        });

        it('leaves no route to a second mint on the same number', async () => {
            await winLot({ blockchain, market }, reserver, CLAIM);

            // D-196: the claim `open_lot` made on the ledger is the tombstone. A
            // second lot on the number opens on the market, and the ledger's
            // `mark_rejected` unwinds it at once and refunds it — so an
            // already-minted number is never auctioned again.
            expect((await market.getLot(CLAIM.n)).found).toBe(false);
            const cancelsBefore = (await market.getMarketStats()).forceCancels;
            const { p0 } = await market.getLotPriceFrom(CLAIM.n, CLAIM.factors);
            const reopen = await market.sendOpenLot(reserver.getSender(), {
                n: CLAIM.n,
                kind: 0,
                factors: CLAIM.factors,
                beneficiary: null,
                referralKey: 0,
                value: p0 + toNano('0.1'),
            });
            expect(reopen.transactions).not.toHaveTransaction({ aborted: true });
            expect(reopen.transactions).toHaveTransaction({ from: ledger.address, to: market.address, success: true });
            expect((await market.getLot(CLAIM.n)).found).toBe(false);
            expect((await market.getMarketStats()).forceCancels).toBe(cancelsBefore + 1);

            // and a second close is refused too
            const reclose = await market.sendClose(buyer.getSender(), { n: CLAIM.n, value: toNano('0.3') });
            expect(reclose.transactions).toHaveTransaction({ to: market.address, success: false });
        });

        /**
         * The retired opcodes, asserted as retired. A stale client still holding
         * `release#e0000004` or `settle#e0000003` must land on `wrong_opcode`,
         * never on a live handler that means something else now.
         */
        it('retires the release and settle opcodes rather than reusing them', async () => {
            await winLot({ blockchain, market }, reserver, CLAIM);

            for (const op of [0xe0000004, 0xe0000003]) {
                const stale = await reserver.send({
                    to: market.address,
                    value: toNano('0.2'),
                    bounce: true,
                    body: beginCell().storeUint(op, 32).storeUint(0, 64).storeUint(CLAIM.n, 64).endCell(),
                });
                expect(stale.transactions).toHaveTransaction({
                    to: market.address,
                    success: false,
                    exitCode: 101, // wrong_opcode
                });
            }
            // and nothing was paid out to anybody as a side effect
            expect(await ledger.isNumberOffHead(CLAIM.n)).toBe(1);
        });
    });

    // =====================================================================
    // GAUNTLET A3.1 — three §9.1 numbers the webapp reads
    // (webapp/src/math/marketLane.ts, webapp/src/components/ScoreLadder/,
    // webapp/src/api/lots.ts) had zero contract-side coverage: nothing pinned
    // the returned shape, and nothing would fail if a get-method changed.
    // =====================================================================
    describe('A3.1 · getFracTable / getScoreWeights / getNpv', () => {
        it('getFracTable publishes the exact FRAC[j] = round(2^(j/10)·2^16) table', async () => {
            // §3.1's P0 formula: P0 = ((MINT_PRICE << (D/10)) * FRAC[D%10]) >> 16.
            // These are `primes_market.tolk`'s own `fracAt(0..9)` literals —
            // pinning them here means a future edit to that table (accidental
            // or not) fails this test instead of silently drifting from the
            // webapp math and the sim that derived it.
            const { frac, shift } = await market.getFracTable();
            expect(frac).toEqual([
                65536n, 70240n, 75281n, 80684n, 86475n,
                92682n, 99334n, 106464n, 114105n, 122295n,
            ]);
            expect(shift).toBe(16);
        });

        it('getScoreWeights publishes the exact D-99 weight table', async () => {
            // `getDesirabilityParams` is DELETED with the four-layer D(n) it
            // published (DECISIONS.md D-99, PRICING_MODEL_PLAN.md §1.3). Its
            // replacement is a 33-entry table indexed BY CATEGORY BIT, plus the
            // three continuous terms and the one clamp.
            //
            // The expected values are IMPORTED from `shared/opcodes.ts` rather
            // than retyped, and that is the whole point of the test: the webapp
            // draws a number's satellites and recomputes its score off
            // `SCORE_BITS`, so a contract weight that drifts from the shared
            // table would let the UI show a breakdown that does not add up to
            // the price the chain charges — §9.1's exact failure mode. A bit
            // number is also a PERMANENT identifier (§8.2 fixes a satellite's
            // angle at 7.5° · bit), so the ORDER asserted here is load-bearing:
            // append a bit, never renumber one.
            const weights = await market.getScoreWeights();
            expect(weights.points).toEqual(SCORE_BITS.map((b) => b.points));
            // As many published as declared — a table that grew on one side
            // only would otherwise pass the comparison above by truncation.
            // 33 at D-99; phase 3 (PRICING_MODEL_PLAN.md §4) appended 33..38;
            // GAUNTLET.md N6 appended 39..47 and spent the reserved range.
            expect(weights.points).toHaveLength(SCORE_BITS.length);
            expect(SCORE_BITS.map((b) => b.bit)).toEqual(SCORE_BITS.map((_, i) => i));
            // LEN is continuous and has no bit at all (§8.3: a scale is not a
            // category), TZ_CAP bounds the one bit whose contribution is
            // per-zero, and SCORE_MAX is the single clamp on the SUM — the
            // price ceiling in disguise, since 1 GRAM · 2^(87/10) ≈ 416 GRAM.
            expect({
                LEN_REF: weights.LEN_REF,
                LEN_W: weights.LEN_W,
                TZ_CAP: weights.TZ_CAP,
                SCORE_MAX: weights.SCORE_MAX,
            }).toEqual(SCORE_TERMS);
        });

        it('D-99: no number can open above the 420 GRAM ceiling the clamp encodes', async () => {
            // PRICING_MODEL_PLAN.md §1.3 / DECISIONS.md D-99: `SCORE_MAX = 87`
            // is not a tuning knob, it IS the price ceiling — the ladder is
            // `MINT_PRICE · 2^(D/10)`, so a clamped score prices at
            // `2^8.7 ≈ 416.6 GRAM` and nothing on the number line can go higher.
            // There is no second ceiling anywhere, which is the same
            // one-clamp-over-the-sum discipline §5 gives `K_CEIL`, and this test
            // is what makes that claim checkable rather than asserted in a
            // comment.
            //
            // The sample is the loudest numbers the game has: 3 and 5 clamp on
            // FORM alone (Mersenne/Fibonacci/twin/Sophie Germain/landmark...),
            // 777 is iconic AND a repdigit, 8191 is a Mersenne prime, 1729 is
            // both iconic and a curated taxicab, 1000 is a power of ten with
            // three trailing zeros, and the primorial-adjacent numbers are where
            // the era boundaries sit. If a weight edit ever lifted one of these
            // past the clamp, the ladder would quote a price the owner never
            // signed off on.
            const LOUD = [
                3n, 5n, 7n, 777n, 1729n, 8191n, 1000n, 100000n, 111111n,
                // Both sides of every primorial in range: `getLotPrice` throws
                // 1008 for the boundary itself (it is minted at the head, never
                // auctioned), so the neighbours are what can be quoted.
                5n, 7n, 29n, 31n, 209n, 211n, 2309n, 2311n, 30029n, 30031n,
            ];
            for (const n of LOUD) {
                const { p0, score } = await market.getLotPrice(n);
                expect({ n: n.toString(), overCeiling: p0 > SCORE_CEILING_TON }).toEqual({
                    n: n.toString(),
                    overCeiling: false,
                });
                expect({ n: n.toString(), overClamp: score > SCORE_TERMS.SCORE_MAX }).toEqual({
                    n: n.toString(),
                    overClamp: false,
                });
            }
            // NON-VACUOUS: at least one of them must actually REACH the clamp,
            // or this test would pass just as well against a ladder that never
            // gets near the ceiling. 3 clamps — its raw sum is over 100 points.
            const clamped = await market.getLotPrice(3n);
            expect(clamped.score).toBe(SCORE_TERMS.SCORE_MAX);
            expect(clamped.p0).toBeGreaterThan(toNano('400'));
            // And the ceiling is the clamp's own consequence, not a separate
            // guard: a clamped score prices at exactly the ladder's top rung.
            const { frac, shift } = await market.getFracTable();
            expect(clamped.p0).toBe(
                ((MINT_PRICE << BigInt(Math.floor(SCORE_TERMS.SCORE_MAX / 10))) *
                    frac[SCORE_TERMS.SCORE_MAX % 10]) >>
                    BigInt(shift)
            );
        }, 120_000);

        it('getNpv returns 0 for a prime with no table entry', async () => {
            // `testMarketConfig` deploys with no `npvTable`, so every lookup on
            // this fixture's market must miss.
            expect(await market.getNpv(999_983n)).toBe(0n);
        });

        it('getNpv returns the exact deploy-fixed value for a prime the table carries', async () => {
            const npvTable = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.BigVarUint(4));
            npvTable.set(999_983n, toNano('5.5'));
            const npvMarket = blockchain.openContract(
                PrimesMarket.createFromConfig(
                    {
                        ...testMarketConfig({
                            headHint: OPENING_HEAD,
                            ledgerAddr: ledger.address,
                            ratchetAddr: ratchet.address,
                        }),
                        npvTable,
                    },
                    marketCode
                )
            );
            await npvMarket.sendDeploy(deployer.getSender(), toNano('5'));

            expect(await npvMarket.getNpv(999_983n)).toBe(toNano('5.5'));
            // A different prime, same table: still a miss.
            expect(await npvMarket.getNpv(2n)).toBe(0n);
        });
    });

    // =====================================================================
    // GAUNTLET A3.2 — `RetryPremiumForward` (0xf2000012) had zero test
    // coverage despite being a live, permissionless, money-moving message
    // (it recovers GRAM stranded here by a bounced `ClearingCleared`, and
    // `genesisPipeline.ts` tells the operator to send it). A genuine bounce
    // is not deterministically reproducible in the sandbox — same reasoning
    // `RetryCredit.spec.ts` gives for `retry_credit` — so this reaches the
    // post-bounce state via `seedUnforwarded`, a test-harness-only deploy
    // override mirroring `PrimesLedger`'s `seedUnroutedCredits`. Needs its
    // own full deploy: the seeded market's init data (and so its address)
    // differs from the shared fixture's, and the ledger only accepts
    // `ClearingCleared` from the ONE market address it was pointed at.
    // =====================================================================
    describe('A3.2 · RetryPremiumForward', () => {
        const STUCK_N = 7n;
        const STUCK_AMOUNT = toNano('1');
        const PREMIUM_HOP_GAS = 30_000_000n; // primes_market.tolk's own constant

        async function deploySeededMarket() {
            // Fresh treasuries, not the outer fixture's `deployer`/`genesisScript`/
            // `treasuryWallet`/`dedust`: every address below is address-determining,
            // and reusing the outer ones would deploy this whole stack ON TOP of
            // the already-deployed shared fixture (same config in, same address
            // out) instead of a distinct one, silently colliding with it.
            const seededDeployer = await blockchain.treasury('seededDeployer');
            const seededGenesisScript = await blockchain.treasury('seededGenesisScript');
            const seededTreasury = await blockchain.treasury('seededTreasury');
            const seededDedust = await blockchain.treasury('seededDedust');

            const collection = blockchain.openContract(
                PrimesCollection.createFromConfig(
                    { nextIndex: 2n, itemCode, ledgerAddr: seededDeployer.address, genesisScriptAddr: seededGenesisScript.address },
                    collectionCode
                )
            );
            await collection.sendDeploy(seededDeployer.getSender(), toNano('5'));

            const master = blockchain.openContract(
                PrimesJettonMaster.createFromConfig(
                    { ledgerAddr: seededDeployer.address, genesisScriptAddr: seededGenesisScript.address, walletCode },
                    masterCode
                )
            );
            await master.sendDeploy(seededDeployer.getSender(), toNano('5'));

            const seededLedger = blockchain.openContract(
                PrimesLedger.createFromConfig(
                    {
                        a: {
                            collectionAddr: collection.address,
                            jettonMasterAddr: master.address,
                            treasuryAddr: seededTreasury.address,
                            itemCode,
                        },
                        b: { genesisScriptAddr: seededGenesisScript.address },
                    },
                    ledgerCode
                )
            );
            await seededLedger.sendDeploy(seededDeployer.getSender(), toNano('10'));

            const seededRatchet = blockchain.openContract(
                PrimesRatchet.createFromConfig(
                    {
                        venueTimelockAddr: seededDeployer.address,
                        genesisScriptAddr: seededGenesisScript.address,
                        dedustNativeVault: seededDedust.address,
                        dedustPool: seededDedust.address,
                        primesJettonVault: seededDedust.address,
                    },
                    ratchetCode
                )
            );
            await seededRatchet.sendDeploy(seededDeployer.getSender(), toNano('10'));

            const registrar = blockchain.openContract(
                PrimesRegistrar.createFromConfig({ genesisScriptAddr: seededGenesisScript.address }, registrarCode)
            );
            await registrar.sendDeploy(seededDeployer.getSender(), toNano('5'));

            await seededRatchet.sendSetLedger(seededGenesisScript.getSender(), { ledgerAddr: seededLedger.address, value: toNano('0.05') });
            await registrar.sendSetLedger(seededGenesisScript.getSender(), { ledgerAddr: seededLedger.address, value: toNano('0.05') });
            await seededLedger.sendSetSinks(seededGenesisScript.getSender(), {
                ratchetAddr: seededRatchet.address,
                registrarAddr: registrar.address,
                value: toNano('0.05'),
            });

            const seededMarket = blockchain.openContract(
                PrimesMarket.createFromConfig(
                    {
                        ...testMarketConfig({
                            headHint: OPENING_HEAD,
                            ledgerAddr: seededLedger.address,
                            ratchetAddr: seededRatchet.address,
                        }),
                        seedUnforwarded: [{ n: STUCK_N, amount: STUCK_AMOUNT }],
                    },
                    marketCode
                )
            );
            // Deploy value must actually cover the stuck GRAM the retry re-sends —
            // a real bounce would have left it holding at least that much.
            await seededMarket.sendDeploy(seededDeployer.getSender(), toNano('5'));

            await collection.sendSetLedger(seededGenesisScript.getSender(), { ledgerAddr: seededLedger.address, value: toNano('0.05') });
            await master.sendSetLedger(seededGenesisScript.getSender(), { ledgerAddr: seededLedger.address, value: toNano('0.05') });
            await master.sendSealAuthority(seededGenesisScript.getSender(), { value: toNano('0.05') });
            await seededLedger.sendGenesisSeed(seededGenesisScript.getSender(), {
                seedT: toNano('1000'),
                seedS: 1_200_000_000_000_000n,
                seedHead: OPENING_HEAD,
                value: toNano('0.05'),
            });
            await seededLedger.sendSetPeers(seededGenesisScript.getSender(), {
                marketAddr: seededMarket.address,
                bountyVaultAddr: bountyVault.address,
                value: toNano('0.05'),
            });
            await seededLedger.sendIgnite(seededGenesisScript.getSender(), { owner: seededDeployer.address, value: toNano('0.3') });

            return { seededMarket, seededLedger, seededTreasury };
        }

        it('re-sends exactly what came back, net of the hop gas, and forwards it on to the ledger', async () => {
            const { seededMarket, seededLedger, seededTreasury } = await deploySeededMarket();
            expect((await seededMarket.getMarketStats()).unforwardedPremium).toBe(STUCK_AMOUNT);

            const tBefore = await seededLedger.getFloorNum();
            const treasuryBefore = await seededTreasury.getBalance();
            const r = await seededMarket.sendRetryPremiumForward(buyer.getSender(), { n: STUCK_N, value: toNano('0.1') });

            const credited = STUCK_AMOUNT - PREMIUM_HOP_GAS;
            // D-114: the ledger splits what it receives 50/50 ratchet/treasury,
            // so T only grows by the ratchet's half of `credited`.
            const treasuryShare = credited / 2n; // PREMIUM_TREASURY_BPS = 5000
            const ratchetShare = credited - treasuryShare;
            expect(r.transactions).toHaveTransaction({
                from: seededMarket.address,
                to: seededLedger.address,
                success: true,
            });
            // T grows by exactly the ratchet's half of what was credited —
            // never the pre-bounce figure, and never the whole of `credited`.
            expect(await seededLedger.getFloorNum()).toBe(tBefore + ratchetShare);
            // Close, not exact — same margin as FeeLines.spec.ts's D-114 case
            // (V18): PAY_FEES_SEPARATELY on the ledger's treasury send stops the
            // forward fee from eating into `treasuryShare`, but the receiver's
            // own compute-phase gas for the credit is unavoidable and still
            // comes off its balance.
            const treasuryDelta = (await seededTreasury.getBalance()) - treasuryBefore;
            expect(treasuryDelta).toBeLessThanOrEqual(treasuryShare);
            expect(treasuryShare - treasuryDelta).toBeLessThan(toNano('0.001'));

            // Cleared, permanently: the honesty counter drops to zero and a
            // second retry on the same n is refused as already_processed (104).
            expect((await seededMarket.getMarketStats()).unforwardedPremium).toBe(0n);
            const again = await seededMarket.sendRetryPremiumForward(buyer.getSender(), { n: STUCK_N, value: toNano('0.1') });
            expect(again.transactions).toHaveTransaction({ to: seededMarket.address, success: false, exitCode: 104 });
        });

        it('is permissionless — any sender may trigger the retry', async () => {
            const { seededMarket } = await deploySeededMarket();
            const r = await seededMarket.sendRetryPremiumForward(reserver.getSender(), { n: STUCK_N, value: toNano('0.1') });
            expect(r.transactions).toHaveTransaction({ from: seededMarket.address, success: true });
        });

        it('refuses a retry on a number with nothing stuck', async () => {
            const { seededMarket } = await deploySeededMarket();
            const r = await seededMarket.sendRetryPremiumForward(buyer.getSender(), { n: 999_999n, value: toNano('0.1') });
            expect(r.transactions).toHaveTransaction({ to: seededMarket.address, success: false, exitCode: 104 });
        });
    });
    // =====================================================================
    // GAUNTLET C7 — one route per non-special number, and it depends only on
    // primality (§4.4, D-30/D-31).
    //
    // `getLotLane(n)` IS the route-selection function: it is what the webapp
    // asks before a lot exists, and it shares its value space with
    // `getLot(n).mode` so the answer does not change shape once one does. The
    // coverage it had was four spot values — one ascending composite, one
    // primorial, the cap, one special composite. This sweeps it.
    //
    // The oracle here supplies only PRIMALITY from JS. It never re-ports the
    // scorer, and since D-99 it does not need to read it either: the tier model
    // is deleted, `getSpecialNumberTerms` with it, and a number's score has no
    // say in which lane it takes. What is under test is the ROUTING RULE alone —
    // prime or not, before the turn or after — rather than a second copy of
    // predicates that have their own suites (`SpecialNumbers.spec.ts`). A
    // re-port would fail in the same direction as the thing it checks.
    // =====================================================================
    describe('C7 · getLotLane — exactly one route per number, by primality alone', () => {
        /** Trial division. The sweep is small and this must not share a bug with the contract. */
        function isPrimeJs(n: number): boolean {
            if (n < 2) return false;
            for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
            return true;
        }
        /** `primes_market.tolk`'s list, which deliberately starts at 6 — 2 is an acquirable prime. */
        const PRIMORIALS = [6, 30, 210, 2310, 30030, 510510, 9699690, 223092870];
        const isPrimorialJs = (n: number) => PRIMORIALS.includes(n);

        /** The whole sweep, dense from 2 and then the adversarial tail. */
        const SWEEP: number[] = [];
        for (let n = 2; n <= 300; n++) SWEEP.push(n);
        // Kept from when D-68 put EVERY prime below 500 on the special lane and
        // the 2..300 band contributed no ordinary primes at all. D-96 deleted
        // that family, so the low band carries ordinary primes again — this
        // band stays because it costs nothing and widens the partition sample.
        for (let n = 501; n <= 800; n++) SWEEP.push(n);
        // Carmichael numbers — composites that pass a Fermat test, and the case
        // `getIsOpenable`'s own comment names as the one a dense sample must
        // include. If the contract's Miller-Rabin ever regressed to a weaker
        // test these would route as primes, onto a lane whose settlement demands
        // a factorization they can supply — a wrong route, not a rejection.
        SWEEP.push(561, 1105, 1729, 2465, 2821, 6601, 8911);
        // Squares of primes, prime powers, and a few large primes: the classes
        // most likely to be mis-scored without being mis-classified.
        SWEEP.push(841, 961, 1024, 2048, 3125, 4096, 9973, 10007, 65537);
        // Both sides of every primorial in range, plus the primorials themselves.
        for (const q of [6, 30, 210, 2310, 30030]) SWEEP.push(q - 1, q, q + 1);

        /**
         * The lane the routing rule says `n` takes. Mirrors `getLotLane`'s
         * branch order exactly, and D-88 changed that order: openability, then
         * primality, then — for a prime only — where the head is. Specialness
         * does not appear at all any more (point 2: it lifts the PRICE the lane
         * quotes, it does not choose the lane) — and under D-99 there is no
         * tier left to be a parameter even in principle.
         */
        function expectedLane(n: number, headHint: number): number {
            if (n <= 0 || n > 42_949_672_959_999) return -1;
            if (isPrimorialJs(n)) return -1;
            if (!isPrimeJs(n)) return MODE_ASCENDING;
            return n < headHint ? MODE_DUTCH_BUYNOW : MODE_ASCENDING;
        }

        it('routes every number in a dense sweep exactly as the rule says', async () => {
            const wrong: string[] = [];
            for (const n of SWEEP) {
                const got = await market.getLotLane(BigInt(n));
                const want = expectedLane(n, Number(OPENING_HEAD));
                if (got !== want) wrong.push(`n=${n} got=${got} want=${want}`);
            }
            expect(wrong).toEqual([]);
        }, 180_000);

        it('gives EVERY number exactly one route, and its SCORE never changes it (D-88/D-99)', async () => {
            // The invariant in its literal form, and D-88 makes it stronger than
            // the version it replaces: this no longer has to drop the special
            // numbers first. Partition the sweep by primality and by the head,
            // and each class must map to a SINGLE lane value — not "the right
            // one for each n", but one value for the whole class.
            const aheadPrime = new Set<number>();
            const behindPrime = new Set<number>();
            const compositeLanes = new Set<number>();
            let ahead = 0;
            let behind = 0;
            let composites = 0;
            let scored = 0;
            for (const n of SWEEP) {
                if (isPrimorialJs(n)) continue;
                // D-99 replaces "is it special?" with "how much does it score?".
                // The count is kept for the same reason it existed under the
                // tier model: it is what makes the claim below a STRONG one —
                // the sweep contains a real population of high-scoring numbers
                // and the lane rule ignores every one of them.
                if ((await market.getScoreBreakdown(BigInt(n))).score >= 30) scored++;
                const lane = await market.getLotLane(BigInt(n));
                if (!isPrimeJs(n)) {
                    compositeLanes.add(lane);
                    composites++;
                } else if (BigInt(n) < OPENING_HEAD) {
                    behindPrime.add(lane);
                    behind++;
                } else {
                    aheadPrime.add(lane);
                    ahead++;
                }
            }
            // Non-vacuous in all four ways it needs to be: both parities, both
            // sides of the head, and a real population of special numbers that
            // are NOT being skipped — that last count is what makes this a
            // stronger claim than the pre-D-88 version rather than a weaker one.
            expect(behind).toBe(2); // 2 and 3, the only primes below a head of 4
            expect(ahead).toBeGreaterThanOrEqual(18);
            expect(composites).toBeGreaterThan(100);
            expect(scored).toBeGreaterThan(20);
            expect([...behindPrime]).toEqual([MODE_DUTCH_BUYNOW]);
            expect([...aheadPrime]).toEqual([MODE_ASCENDING]);
            expect([...compositeLanes]).toEqual([MODE_ASCENDING]);
        }, 180_000);

        it('answers -1 for every primorial in range, and a real lane on both sides of each', async () => {
            // §7's era boundaries mint at the head and are on no lane at any
            // price. The neighbours are the control: a blanket -1 around the
            // boundary would satisfy the first half and break the mechanic.
            for (const q of [6, 30, 210, 2310, 30030, 510510, 9699690, 223092870]) {
                expect({ q, lane: await market.getLotLane(BigInt(q)) }).toEqual({ q, lane: -1 });
                expect(await market.getLotLane(BigInt(q - 1))).toBeGreaterThanOrEqual(0);
                expect(await market.getLotLane(BigInt(q + 1))).toBeGreaterThanOrEqual(0);
            }
        }, 120_000);

        it('consults the head for a PRIME and for nothing else (D-88 inverts this test)', async () => {
            // Pre-D-88 this asserted the opposite: primes were head-independent
            // and only a special COMPOSITE moved with the head (SS3's carve-out).
            // D-88 deletes that carve-out and puts the head-dependence exactly
            // where the design now says it belongs — on primes, which have one
            // lane before their turn and another after it. Composites are the
            // invariant class now: ahead of the head or behind it, a composite
            // is an ascending lot, because the only other thing that can happen
            // to it is being minted at the head, which is not a lane.
            //
            // Asking a SECOND market, whose head hint is higher, is what makes
            // this a property of the branch rather than an artefact of asking
            // one contract twice.
            async function marketAt(headHint: bigint) {
                const m = blockchain.openContract(
                    PrimesMarket.createFromConfig(
                        testMarketConfig({
                            headHint,
                            ledgerAddr: deployer.address,
                            ratchetAddr: ratchet.address,
                        }),
                        marketCode
                    )
                );
                await m.sendDeploy(deployer.getSender(), toNano('5'));
                return m;
            }
            const behind = await marketAt(1000n); // every curated year is AHEAD of this head
            const ahead = await marketAt(3000n); // and BEHIND this one

            const moved: number[] = [];
            for (let n = 1918; n <= 1990; n++) {
                const a = await behind.getLotLane(BigInt(n));
                const b = await ahead.getLotLane(BigInt(n));
                if (a !== b) moved.push(n);
            }
            // Everything that moved must be a PRIME strictly between the two
            // hints, and it must have moved from ascending to descending — the
            // turn arriving, and nothing else.
            for (const n of moved) {
                expect({ n, prime: isPrimeJs(n) }).toEqual({ n, prime: true });
                expect(await behind.getLotLane(BigInt(n))).toBe(MODE_ASCENDING);
                expect(await ahead.getLotLane(BigInt(n))).toBe(MODE_DUTCH_BUYNOW);
            }
            // Non-vacuous: the band really does contain primes, so the switch
            // demonstrably fires rather than the whole test reducing to
            // "nothing moved".
            expect(moved.length).toBeGreaterThan(5);
            // And the COMPOSITES in the same band did NOT move — including the
            // high-scoring ones, which is the half that proves D-88 point 2
            // landed: a number's score no longer buys it a lane of its own.
            //
            // 1918..1990 is chosen because D-99 §1.3 pays 25 points for a YEAR
            // in 1900..2100, so every number in this band scores at least
            // `LEN(4 digits) + YEAR = 10 + 25` before anything else it happens
            // to be. It used to be SS3's curated special-composite band, and it
            // is still the densest band of expensive composites in range — which
            // is what makes "the lane ignored all of them" worth asserting.
            let compositesChecked = 0;
            let scoredCompositesChecked = 0;
            for (let n = 1918; n <= 1990; n++) {
                if (isPrimeJs(n)) continue;
                compositesChecked++;
                if ((await behind.getScoreBreakdown(BigInt(n))).score >= 30) scoredCompositesChecked++;
                expect({ n, same: (await behind.getLotLane(BigInt(n))) === (await ahead.getLotLane(BigInt(n))) })
                    .toEqual({ n, same: true });
            }
            expect(scoredCompositesChecked).toBeGreaterThan(20);
            expect(compositesChecked).toBeGreaterThan(30);
        }, 180_000);

        it('the lane it predicts is the mode the lot actually opens in', async () => {
            // `getLotLane` answers before a lot exists and `getLot(n).mode`
            // after; the contract comment says they deliberately share a value
            // space. If they disagreed, "one route" would be true of the
            // prediction and false of the thing.
            //
            // 3 is a special prime (Mersenne), 37 an ordinary one, 12 an
            // ordinary composite — one number per lane the fixture market can
            // actually open at head 4.
            const beforeSpecialPrime = await market.getLotLane(3n);
            await openHeadLot(3n);
            expect((await market.getLot(3n)).mode).toBe(beforeSpecialPrime);

            const beforeComposite = await market.getLotLane(RESERVABLE_12.n);
            await winLot({ blockchain, market }, reserver, RESERVABLE_12);
            expect((await market.getLot(RESERVABLE_12.n)).mode).toBe(beforeComposite);
        }, 120_000);
    });

    // =====================================================================
    // GAUNTLET V8 (2026-09-09) — the market's own gas float, closed lot by
    // closed lot. `closeLot`'s comment block claims a composite close nets
    // +0.005 GRAM (RES_GAS 0.06 carved off, SETTLE_GAS 0.025 + PREMIUM_HOP_GAS
    // 0.03 sent back out) while a prime close nets −0.06 (two PREMIUM_HOP_GAS
    // hops, 0.03 each, and no RES_GAS is ever carved off a prime sale because
    // `minPaymentOn`'s BUYNOW branch already prices RES_GAS INTO what the
    // buyer pays before `closeLot` ever runs — the two legs both leave, none
    // comes back). That accounting is real but partial: a COMPOSITE lot also
    // pays `OPEN_RESERVE_GAS` (0.02 GRAM, `MarkOffHead` to the ledger) the
    // moment it opens, which the item's own +0.005 never nets against. A full
    // composite lifecycle is therefore -0.02 (open) + 0.005 (close) = -0.015
    // GRAM, not a surplus — EVERY closed lot on EVERY lane drains this
    // contract's own balance, and there is no lane, mix or volume of the two
    // that offsets the other. This block proves that arithmetic against a
    // live sandbox balance rather than the comment's claim, which is the
    // finding written up as `DECISIONS.md` D-113.
    // =====================================================================
    describe('V8/V8b · the market no longer drains its own GRAM balance, lane by lane (D-113)', () => {
        const OPEN_HEAD_VALUE = toNano('0.1'); // primes_market.tolk, = shared/messages.ts OPEN_HEAD_LOT_GAS_NANOTON
        // `CloseLot` and the BUYNOW `Bid` both carry NO `in.valueCoins` assert
        // at all (they run entirely off the contract's own, already-held
        // balance — the opening bid stays in storage as `highBid` until close
        // spends it). `winLot`'s and `acquirePrimeAhead`'s fixed
        // `CLOSE_LOT_GAS` (0.3 GRAM) is therefore a caller-side gas MARGIN, not
        // a contract-required fee — and margin nobody asked back is never
        // refunded, so it becomes float that hides the real per-lot deficit.
        // These tests fund every write with the smallest value that still
        // clears the contract's own asserts, so the balance delta they
        // measure is the deficit itself, not a test-fixture subsidy.
        const DUST = 1000000n; // 0.001 GRAM — enough for the tx's own forward fee, no more

        async function closedComposite(n: bigint, factors: { prime: bigint; exponent: number; s: bigint }[]) {
            const quote = await market.getLotPriceFrom(n, factors);
            await market.sendOpenLot(reserver.getSender(), {
                n,
                kind: 0,
                factors,
                beneficiary: null,
                referralKey: 0,
                value: quote.p0, // exactly P0 — no margin left for the contract to keep
            });
            const lot = await market.getLot(n);
            blockchain.now = lot.closesAt + 1;
            await market.sendClose(reserver.getSender(), { n, value: DUST });
        }

        async function closedPrimeAtTurn(p: bigint) {
            // Behind the fixture's headHint (4): the tight BUYNOW lane, one
            // message settles the purchase — no separate close call and so no
            // second margin to hide behind. The open carries exactly the
            // contract's floor (OPEN_HEAD_VALUE, 0.1) and forwards all of it
            // that its compute leaves, so it neither funds nor drains the
            // float. It used to send 0.01 — below the D-196 floor — so the
            // open threw 1003 and this test passed on a lot that never existed.
            await market.sendOpenHeadLot(buyer.getSender(), { n: p, value: OPEN_HEAD_VALUE });
            const lot = await market.getLot(p);
            expect(lot.found).toBe(true);
            await market.sendBid(buyer.getSender(), {
                n: p,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment, // exactly the floor — no margin
            });
        }

        it('a closed COMPOSITE lot no longer costs the market money net (D-113: RES_GAS 0.06 -> 0.07)', async () => {
            const before = (await blockchain.getContract(market.address)).balance;
            await closedComposite(RESERVABLE_12.n, RESERVABLE_12.factors);
            const after = (await blockchain.getContract(market.address)).balance;
            const drained = before - after;
            // D-113: the ascending lane's OPEN_RESERVE_GAS leak (0.02 GRAM,
            // paid at open, from this contract's own float) is now covered by
            // the raised RES_GAS's close-time surplus, with a thin measured
            // margin (~0.0037 GRAM) rather than the wide margin `RES_GAS`
            // theoretically implies — real TVM forward-fee mechanics do not
            // reduce cleanly to the declared-constant arithmetic. Non-negative
            // is the invariant; the exact margin is not.
            expect(drained).toBeLessThanOrEqual(0n);
            expect(drained).toBeGreaterThan(-toNano('0.01'));
        });

        it('a closed PRIME lot (at its turn) no longer costs the market money net (D-113: closeLot stops over-forwarding RES_GAS + PREMIUM_HOP_GAS)', async () => {
            const before = (await blockchain.getContract(market.address)).balance;
            // 3 is already behind the fixture's opening head (4, D-20) and
            // reachable on the tight BUYNOW lane with no separate close call.
            // D-113 stops closeLot handing the ledger a whole extra RES_GAS on
            // top of PREMIUM_HOP_GAS for a leg the ledger's SettlePrimeClearing
            // arm only ever asserted MINT_PRICE against — it now sends
            // MINT_PRICE + SETTLE_GAS, exactly like the composite settle leg.
            await closedPrimeAtTurn(3n);
            const after = (await blockchain.getContract(market.address)).balance;
            const drained = before - after;
            expect(drained).toBeLessThanOrEqual(0n);
            expect(drained).toBeGreaterThan(-toNano('0.05'));
        });

        it('V23: a raise costs the market nothing — the raiser funds its own compute', async () => {
            // `bid_lot` used to book the whole `in.valueCoins` as the bid, so each
            // raise's compute came out of the float (~0.00084 GRAM on a 2-factor
            // lot) and RES_GAS only covers a one-bid lifecycle. BID_GAS is now
            // priced into `minPayment` and kept. The 12-factor lot is the largest
            // payload a raise rewrites.
            const isq = (p: bigint) => { let r = 1n; while ((r + 1n) * (r + 1n) <= p) r++; return r; };
            const ps = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
            const wide = {
                n: ps.reduce((a, p) => a * p, 2n), // 2²·3·…·37: ω = 12, not a primorial
                factors: ps.map((p) => ({ prime: p, exponent: p === 2n ? 2 : 1, s: isq(p) })),
            };
            for (const lotSpec of [RESERVABLE_12, wide]) {
                const quote = await market.getLotPriceFrom(lotSpec.n, lotSpec.factors);
                await market.sendOpenLot(reserver.getSender(), {
                    n: lotSpec.n,
                    kind: 0,
                    factors: lotSpec.factors,
                    beneficiary: null,
                    referralKey: 0,
                    value: quote.p0,
                });
                const bidders = [buyer, reserver];
                for (let i = 0; i < 4; i++) {
                    const before = (await blockchain.getContract(market.address)).balance;
                    const lot = await market.getLot(lotSpec.n);
                    const r = await market.sendBid(bidders[i % 2].getSender(), {
                        n: lotSpec.n,
                        beneficiary: null,
                        referralKey: 0,
                        value: lot.minPayment, // exactly the published minimum, no margin
                    });
                    expect(r.transactions).not.toHaveTransaction({ aborted: true });
                    const after = (await blockchain.getContract(market.address)).balance;
                    const next = await market.getLot(lotSpec.n);
                    // The bid booked still clears the step the ladder asks for...
                    expect(next.highBidder.equals(bidders[i % 2].address)).toBe(true);
                    expect(next.highBid).toBeGreaterThan(lot.highBid);
                    // ...and net of the bid it now holds, the market lost nothing.
                    const raised = next.highBid - lot.highBid;
                    expect(after - before - raised).toBeGreaterThanOrEqual(0n);
                }
            }
        });

        it('N closed lots do not trend the balance toward zero — the market is funded on every lane (D-113)', async () => {
            // Interleaves the market's two paying lanes with the minimal,
            // non-subsidised funding above: three composites and one prime at
            // its turn, fixed opening balance, reading the contract's own
            // balance after every close rather than asserting a computed
            // figure — this is the "drives N closes against a fixed opening
            // balance" proof GAUNTLET.md's V8 item itself asks for. (Only 2
            // and 3 sit behind this fixture's headHint, so one at-turn prime
            // is the most this stack can price tightly.)
            const composites: { n: bigint; factors: { prime: bigint; exponent: number; s: bigint }[] }[] = [
                RESERVABLE_12,
                RESERVABLE_14,
                RESERVABLE_15,
            ];

            const balances: bigint[] = [(await blockchain.getContract(market.address)).balance];
            for (const composite of composites) {
                await closedComposite(composite.n, composite.factors);
                balances.push((await blockchain.getContract(market.address)).balance);
            }
            await closedPrimeAtTurn(3n);
            balances.push((await blockchain.getContract(market.address)).balance);

            // Non-decreasing on EVERY step now — D-113 flips this from the
            // pre-fix "strictly downward" assertion. If the market ever
            // trended toward zero again on some mix, this is the assertion
            // that would need to change, and it would need a stated reason
            // rather than a silent loosening.
            for (let i = 1; i < balances.length; i++) {
                expect(balances[i]).toBeGreaterThanOrEqual(balances[i - 1]);
            }
            const totalDrained = balances[0] - balances[balances.length - 1];
            // 3 composites (~0.0037 each) + 1 prime (~0.0335) ≈ a 0.045 GRAM
            // net GAIN, wide band for forward-fee dust across four lifecycles.
            expect(totalDrained).toBeLessThanOrEqual(0n);
            expect(totalDrained).toBeGreaterThan(-toNano('0.1'));
        }, 60_000);

        it('open_head_lot is caller-funded: a never-bought head lot costs the market nothing, even at the cap', async () => {
            // A head lot holds no bid and may rest for ever, so no RES_GAS ever
            // repays its open. Each minimum-value open used to cost the float
            // ~0.012 GRAM (the open's compute plus a fixed 0.02 hop). Worst case
            // is the priciest score at the cap: the largest primes below
            // AUCTIONABLE_MAX, a twin near it, a Sophie Germain prime and V34's
            // five-pass prime (out of gas before V34; under 700k after).
            // The ledger here is a wallet, so the hop's value is read directly.
            const worst = [42949672959971n, 42949672959953n, 42949672959733n, 21474836477681n, 42949671641939n];
            const far = blockchain.openContract(
                PrimesMarket.createFromConfig(
                    testMarketConfig({ headHint: 42949672959999n, ledgerAddr: deployer.address, ratchetAddr: ratchet.address }),
                    marketCode
                )
            );
            await far.sendDeploy(deployer.getSender(), toNano('5'));
            await deployer.send({
                to: far.address,
                value: toNano('0.05'),
                body: beginCell().storeUint(0xe0000034, 32).storeUint(0, 64).endCell(), // launch_open_market
            });
            // Below the floor is refused, so a cheap open cannot underfund the hop.
            const cheap = await market.sendOpenHeadLot(buyer.getSender(), { n: 3n, value: OPEN_HEAD_VALUE - 1n });
            expect(cheap.transactions).toHaveTransaction({ to: market.address, exitCode: 1003 });
            // The main fixture's at-turn prime goes through the real ledger.
            for (const [m, ps] of [[market, [3n]], [far, worst]] as const) {
                for (const p of ps) {
                    const before = (await blockchain.getContract(m.address)).balance;
                    const r = await m.sendOpenHeadLot(buyer.getSender(), { n: p, value: OPEN_HEAD_VALUE });
                    expect(r.transactions).not.toHaveTransaction({ aborted: true });
                    expect((await m.getLot(p)).found).toBe(true);
                    const after = (await blockchain.getContract(m.address)).balance;
                    // Storage rent only; the fixed hop drained ~0.012 here.
                    expect(before - after).toBeLessThan(toNano('0.0001'));
                    if (m === far) {
                        // ...and the ledger's check is still funded.
                        expect(r.transactions).toHaveTransaction({
                            from: far.address,
                            to: deployer.address,
                            value: (v?: bigint) => (v ?? 0n) >= toNano('0.02'), // OPEN_RESERVE_GAS
                        });
                    }
                }
            }
        }, 60_000);
    });

    // =====================================================================
    // GAUNTLET V9 (2026-09-09) — a bounced settlement no longer half-lands.
    // `closeLot` used to send the premium (`ClearingCleared`) unconditionally,
    // in the SAME transaction as the settle send — so a settle that later
    // bounced (ledger not launched, `isOffHead` false, wrong sender, out of
    // gas) had already given the premium to the ratchet for good, while its
    // own bounce refunded only the settle leg. Fixed by withholding the
    // premium until the ledger's `SettleConfirmed` ack — which it already
    // sends on a successful composite settle, and which this change makes it
    // also send on a successful prime clearing — confirms the mint actually
    // landed; a bounced settle means that ack never arrives, so the premium
    // never leaves and the bounce handler (updated alongside it) can refund
    // it to the winner together with the settle leg's own returned value.
    // Along the way, found `SettlePrimeClearing`'s bounce had NO handler at
    // all (`onBouncedMessage` had no `0xb0000024` arm) — a bounced prime
    // settle refunded NOBODY, worse than the filed composite case — and added
    // one, mirroring the composite arm exactly.
    //
    // A GENUINE bounce needs the ledger to refuse a settle from an otherwise
    // correctly-wired, fully-launched market — and every assert on that path
    // (`peersSet`, `launched`, `senderAddress == marketAddr`, `valueCoins`) is
    // fixed by the SAME wiring that also has to be correct just to open and
    // win a lot in the first place; `isOffHead` is the one state-dependent
    // check, but D-45 sets it permanently and synchronously at OPEN, before a
    // close can ever be reached. There is no way to make ONE of these fail
    // while leaving the stack able to legitimately win a lot at all — forcing
    // one open would need an out-of-gas trigger, which `RetryCredit.spec.ts`
    // already documents as "not deterministically reproducible in the
    // sandbox without forcing a fragile, magic-number gas failure."
    //
    // So, per that same precedent, this proves the FIX rather than the
    // failure: inspects the real transaction chain from a genuinely WON lot
    // and asserts the premium send (`ClearingCleared`) is causally AFTER the
    // ledger's `SettleConfirmed` ack, never in the same settle transaction —
    // which is exactly the property that makes the premium safe to refund on
    // a bounce (a settle that fails never produces that ack, so this ordering
    // is what guarantees the premium never left).
    // =====================================================================
    describe('V9 · the premium send is causally AFTER the settlement ack, never alongside the settle itself', () => {
        const MINT_WON_LOT_OP = 0xb0000020;
        const SETTLE_PRIME_CLEARING_OP = 0xb0000024;
        const SETTLE_CONFIRMED_OP = 0xe0000033;
        const CLEARING_CLEARED_OP = 0xb0000009;

        const opOf = (t: any): number | undefined => {
            if (t.inMessage?.info.type !== 'internal') return undefined;
            const body = t.inMessage.body.beginParse();
            if (body.remainingBits < 32) return undefined;
            return body.loadUint(32);
        };

        it('COMPOSITE lane: ClearingCleared lands only after SettleConfirmed, never in the settle transaction', async () => {
            const composite = RESERVABLE_20014; // scored, so a real premium exists
            const win = await winLot({ blockchain, market }, reserver, composite);
            expect(win.premium).toBeGreaterThan(0n);

            const ops = win.closeResult!.transactions.map(opOf);
            const settleIdx = ops.indexOf(MINT_WON_LOT_OP);
            const ackIdx = ops.indexOf(SETTLE_CONFIRMED_OP);
            const premiumIdx = ops.indexOf(CLEARING_CLEARED_OP);
            expect(settleIdx).toBeGreaterThanOrEqual(0);
            expect(ackIdx).toBeGreaterThan(settleIdx); // the ack is a REPLY to the settle
            expect(premiumIdx).toBeGreaterThan(ackIdx); // the premium waits for the ack
        });

        it('PRIME lane: ClearingCleared lands only after SettleConfirmed, never in the settle transaction', async () => {
            // 3 is heavily scored (Mersenne/twin/Sophie Germain/Fibonacci/
            // triangular), so buying it at its own opening price carries a
            // real premium on the tight BUYNOW lane.
            await market.sendOpenHeadLot(buyer.getSender(), { n: 3n, value: toNano('0.1') }); // D-196: pays the open and the ledger check
            const lot = await market.getLot(3n);
            const premium = lot.minPayment - MINT_PRICE - toNano('0.07'); // RES_GAS (D-113: 0.06 -> 0.07)
            expect(premium).toBeGreaterThan(0n);

            const bidResult = await market.sendBid(buyer.getSender(), {
                n: 3n,
                beneficiary: null,
                referralKey: 0,
                value: lot.minPayment,
            });

            const ops = bidResult.transactions.map(opOf);
            const settleIdx = ops.indexOf(SETTLE_PRIME_CLEARING_OP);
            const ackIdx = ops.indexOf(SETTLE_CONFIRMED_OP);
            const premiumIdx = ops.indexOf(CLEARING_CLEARED_OP);
            expect(settleIdx).toBeGreaterThanOrEqual(0);
            expect(ackIdx).toBeGreaterThan(settleIdx); // this ack didn't exist before V9
            expect(premiumIdx).toBeGreaterThan(ackIdx);
        });

        // NOTE, not a test: `SettleConfirmed` is sent `BounceMode.NoBounce` on
        // both call sites (`handleSettle`, and the `SettlePrimeClearing` arm
        // this gauntlet item added it to) — if it is ever dropped, the
        // premium stays parked in the market's own balance forever rather
        // than being lost, the safe failure direction, and the same one
        // `A3.2 RetryPremiumForward`'s own `unforwardedByN` ledger already
        // exists to recover a stuck premium from. Not driven here: forcing a
        // NoBounce delivery to genuinely fail needs the same fragile gas
        // trigger this block's own header comment already declines to chase.
    });

    // =====================================================================
    // G81 — a forfeit leg too small to pay its receiver's gas is HELD, never sent.
    //
    // Found on testnet (`20260929`): a lot on `2 × 899810617` cited unsold 2 beside
    // a sold large prime, forfeiting 2's ~2,666-nanoGRAM share; both legs landed
    // `compute skipped (no_gas)`, aborted — red. Here 2 × 30011: 2's share is
    // 0.08/(1+173), its 42% is ~0.00019 GRAM, below `RATCHET_HOP_GAS`, so the
    // operator leg is held and the treasury's 58% rides the 5% send.
    // =====================================================================
    describe('G81: dust fee legs are held, and the trace stays green', () => {
        const Q = 30011n; // prime, clear of MIN_AUCTION_DISTANCE from the opening head
        const RATCHET_HOP_GAS = toNano('0.001');

        async function winAscending(n: bigint, kind: number, factors: { prime: bigint; exponent: number; s: bigint }[]) {
            const { p0 } = await market.getLotPriceFrom(n, factors);
            await market.sendOpenLot(buyer.getSender(), {
                n,
                kind,
                factors,
                beneficiary: null,
                referralKey: 0,
                value: p0 + toNano('0.3'),
            });
            const lot = await market.getLot(n);
            blockchain.now = lot.closesAt + 1;
            return market.sendClose(buyer.getSender(), { n, value: toNano('0.3') });
        }

        // GAUNTLET V34: a prime whose score runs five full Miller-Rabin passes
        // (n, n+2, 2n+1, (n-1)/2 and its reversal are all prime) used to hit
        // config 21's 1,000,000-gas ceiling on open, so it could not be bought
        // at all. Fixed by stopping Miller-Rabin at seven bases below psi_7 and
        // reading n's primality off the score instead of testing it twice.
        // Measured after: open 683k, the ledger's settlement 720k.
        it('V34: the costliest prime near the cap opens, closes and mints under the gas ceiling', async () => {
            const p = 42949671641939n;
            const gasOf = (r: any, op: number) => {
                const t = r.transactions.find((t: any) => {
                    const b = t.inMessage?.body?.beginParse();
                    return b && b.remainingBits >= 32 && b.loadUint(32) === op;
                });
                const c = t?.description.computePhase;
                return c?.type === 'vm' ? c.gasUsed : -1n;
            };
            const { p0 } = await market.getLotPriceFrom(p, []);
            const o = await market.sendOpenLot(buyer.getSender(), {
                n: p, kind: 1, factors: [], beneficiary: null, referralKey: 0, value: p0 + toNano('0.3'),
            });
            expect(o.transactions).not.toHaveTransaction({ aborted: true });
            expect(gasOf(o, 0xf2000001)).toBeLessThan(800_000n); // open_lot
            const lot = await market.getLot(p);
            expect(lot.found).toBe(true);
            blockchain.now = lot.closesAt + 1;
            const c = await market.sendClose(buyer.getSender(), { n: p, value: toNano('0.3') });
            expect(c.transactions).not.toHaveTransaction({ aborted: true });
            const settle = gasOf(c, 0xb0000024); // SettlePrimeClearing, on the ledger
            expect(settle).toBeGreaterThan(0n);
            expect(settle).toBeLessThan(800_000n);
        }, 60_000);

        it('holds the operator remainder below one hop, pays the treasury share in the 5% send', async () => {
            await winAscending(Q, 1, []);
            const opsBefore = await ledger.getOperatorTotals();

            const r = await winAscending(2n * Q, 0, [
                { prime: 2n, exponent: 1, s: 1n },
                { prime: Q, exponent: 1, s: 173n },
            ]);
            expect(r.transactions).not.toHaveTransaction({ aborted: true });

            const forfeit = await ledger.getForfeited(2n);
            expect(forfeit).toBe((toNano('0.08') * 1n) / 174n);
            const toTreasury = (forfeit * 5800n) / 10_000n;
            const toOperator = forfeit - toTreasury;
            expect(toOperator).toBeLessThan(RATCHET_HOP_GAS);

            const br = await ledger.getLiabilityBreakdown();
            expect(br.operatorHeld).toBe(toOperator);
            const ops = await ledger.getOperatorTotals();
            expect(ops.operatorPaidTotal).toBe(opsBefore.operatorPaidTotal); // held is not paid
            // the treasury share went out with the 5% line, in one message
            expect(ops.treasuryPaidTotal - opsBefore.treasuryPaidTotal).toBe(toNano('0.05') + toTreasury);

            // declared: the held leg is in the liability, and so outside the sweep
            const sol = await ledger.getSolvency();
            expect(br.tributeOwed + br.unroutedHeld + br.divOutstanding + br.treasuryHeld + br.operatorHeld).toBe(
                sol.liability
            );
            expect(sol.liability).toBeGreaterThanOrEqual(br.operatorHeld);
        });
    });
});
