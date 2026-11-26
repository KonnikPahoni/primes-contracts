import { Address, Dictionary, OpenedContract, toNano } from "@ton/core";
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { FactorEntry } from "../../wrappers/PrimesLedger";
import { MarketConfig, PrimesMarket } from '../../wrappers/PrimesMarket';
import sharedParams from '../../../shared/params.json';

/**
 * ESCROW-CLAIM FIXTURES — composites a lot can be opened on.
 *
 * D-30 deletes the flat-fee `reserve` entry point and the `D_MIN` WORTH gate
 * with it: ANY composite up to `AUCTIONABLE_MAX` that is not a primorial may be
 * opened as an ascending lot, whatever it scores, and winning one is the only
 * way to hold a number ahead of the head.
 *
 * `MIN_AUCTION_DISTANCE` IS DELETED (D-45) — the ascending lane's liveness
 * gate no longer exists, so a lot may open at any distance ahead of the head
 * and these fixtures no longer need to stay small for that reason. They stay
 * small anyway because they are just readable test numbers.
 *
 * Each entry carries its factorization because the market verifies it on the way
 * in (product, primality by Miller-Rabin, and `s = floor(sqrt(p))` per factor).
 */
export const F = (prime: bigint, exponent: number, s: bigint) => ({ prime, exponent, s });

/** 12 = 2^2 · 3, D = 28. */
export const RESERVABLE_12 = { n: 12n, factors: [F(2n, 2, 1n), F(3n, 1, 1n)] };
/** 14 = 2 · 7, D = 28. */
export const RESERVABLE_14 = { n: 14n, factors: [F(2n, 1, 1n), F(7n, 1, 2n)] };
/** 15 = 3 · 5, D = 28. */
export const RESERVABLE_15 = { n: 15n, factors: [F(3n, 1, 1n), F(5n, 1, 2n)] };
/** 20014 = 2 · 10007, D = 16 — well above the others, and its larger factor is
 *  the one an above-head composite can cite before the head has crossed it. */
export const RESERVABLE_20014 = { n: 20_014n, factors: [F(2n, 1, 1n), F(10_007n, 1, 100n)] };

/**
 * D-218 — the rest table genesis ships (`trophy_auction.resting_ladder`), so a
 * test market rests every prime exactly where a real deploy would: 3 at ~29
 * GRAM, every prime past 509 at MINT_PRICE.
 */
export function shippedRestTable(): Dictionary<bigint, bigint> {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.BigVarUint(4));
    const table = (sharedParams as any).trophy_auction.resting_ladder.resting_nanoton_by_prime as Record<string, number>;
    for (const [p, nano] of Object.entries(table)) dict.set(BigInt(p), BigInt(nano));
    return dict;
}

/**
 * P2.A7 — one place to build a test market's deploy config (D-20/D-90 shrank
 * `MarketConfig` to `ledgerAddr`, `ratchetAddr`, `npvTable` and, D-218, `restTable`).
 * Ships NO tables by default — every prime rests at MINT_PRICE and opens at the
 * ladder — so a fixture's storage rent is the bare contract's, which is what the
 * per-lane funding tests (D-113) measure against. `shippedRest: true` adds the
 * genesis rest table for the tests about where a prime comes to rest.
 */
export function testMarketConfig(opts: {
    ledgerAddr: Address;
    ratchetAddr: Address;
    headHint?: bigint;
    /** D-139 — the test clock. Omitted means 1, which is mainnet. */
    clockDivisor?: number;
    /** D-218 — deploy with `shippedRestTable()`. */
    shippedRest?: boolean;
}): MarketConfig {
    return {
        headHint: opts.headHint ?? OPENING_HEAD,
        ledgerAddr: opts.ledgerAddr,
        ratchetAddr: opts.ratchetAddr,
        restTable: opts.shippedRest ? shippedRestTable() : undefined,
        clockDivisor: opts.clockDivisor,
    };
}

// ===========================================================================
// D-20 — ACQUIRING A PRIME
// ===========================================================================
//
// There is no such thing as MINTING a prime any more, and that is the single
// fact every converted test in this repo turns on. Under `DECISIONS.md` D-20 the
// sequential head is defined over COMPOSITES AND UNITY ONLY: after Unity (n = 1)
// the next number anyone can build is 4, and 2 and 3 are already behind the head
// and therefore already open in the market. Every prime from 2 onward is bought
// from the market's `MODE_DUTCH_BUYNOW` lane — a descending price that decays to
// THAT PRIME'S OWN resting price, `min(P0(p), max(MINT_PRICE, restTable[p]))` (D-88
// point 1 deleted the universal-1-GRAM floor; D-218 rests p at the tribute of the
// 5,000 composite mints after its turn),
// and then sits there forever, where a "bid" IS the purchase and settles in the
// same transaction. Read the floor with `getPrimeFloor(p)` / `getLotFloor(p)`;
// `getPrimeDutchTerms().floorMin` is only the lower bound on it.
//
// So `ledger.sendMint(p, kind = 1, [])` is not a prime acquisition and never
// reaches `executeMint`: `p` is not the head, so the ledger refunds it in full
// and the test that "minted a prime" silently asserted nothing. `acquirePrime`
// below is the replacement, and it is deliberately the ONLY one — a second way
// to obtain a prime in the tests would be a second way the tests could disagree
// with the contract about what D-20 says.

/**
 * D-20: the head a real genesis opens at — the FIRST COMPOSITE. `GenesisSeed`
 * walks 2 and 3 on the way here, marking both prime, counting both into π(n) and
 * opening both their forfeit clocks, which is CONCEPT §6 point 1's "after Unity,
 * 2 and 3 both open at once... 4 is the next number available to build".
 *
 * It is the ledger's `seedHead` AND the market's opening `headHint`, and the two
 * must agree: `OpenHeadLot` gates on `n < headHint`, so a market still opening at
 * 2 refuses to open a lot on 2 or 3 (500 `mkt_number_below_head`) while the
 * ledger has already walked past them.
 */
export const OPENING_HEAD = 4n;

/** `primes_market.tolk`'s BID_GAS (V23): an ascending raise keeps this much of
 *  `in.valueCoins` for its own compute and books the rest as the bid. */
export const BID_GAS = toNano('0.002');

/** What `OpenHeadLot` costs to send. It is unpriced — this is gas only. */
export const HEAD_LOT_GAS = toNano('0.2');

export type DutchLane = {
    blockchain: Blockchain;
    market: SandboxContract<PrimesMarket>;
    /**
     * Optional. `OpenHeadLot` gates on the market's `headHint`, which is a
     * LAGGING cache: the ledger pushes it on reservation settlement and on the
     * permissionless `sync_head`, and deliberately not on the mint path (the head
     * cache costs the hot path nothing). So a test that mints composites and then
     * buys the primes the head walked past must push the hint first. Give the
     * lane a ledger and `acquirePrime` sends that `sync_head` for you, exactly as
     * a keeper — or any player — would.
     */
    ledger?: { sendSyncHead: (via: any, opts: { value: bigint }) => Promise<any> };
};

export type AcquireOpts = {
    /** §4.5 — who ends up owning the number. Defaults to the buyer. */
    beneficiary?: Address | null;
    referralKey?: number;
    /**
     * Walk the chain clock to the end of the decay window first, so the purchase
     * happens at exactly this number's resting price (`getPrimeFloor(n)` since
     * D-88 point 1 — NOT a universal 1 GRAM) and the premium is `margin` and
     * nothing else. This MOVES `blockchain.now`, so a test that is also measuring
     * k(t) should either not use it or re-base its clock afterwards.
     */
    atFloor?: boolean;
    /** Advance the clock by this many seconds into the decay before buying. */
    afterSeconds?: number;
    /**
     * Pay exactly this. Overrides `margin`. Anything at or above the standing
     * `minPayment` is accepted; the whole excess over `MINT_PRICE + RES_GAS`
     * becomes premium, which the ledger splits 50/50 between the ratchet (a
     * pure floor step) and the governed treasury (`DECISIONS.md` D-114,
     * amends D-7).
     */
    pay?: bigint;
    /**
     * Added on top of the standing `minPayment`. Defaults to ZERO, because the
     * market charges `in.valueCoins` — not the quoted price — so every nanoton of
     * margin becomes premium (half to `T`, half to the treasury, since D-114),
     * and a test computing a floor step needs that to be a number it chose
     * rather than a fee cushion.
     */
    margin?: bigint;
    /** Who sends `OpenHeadLot`. Permissionless; defaults to the buyer. */
    opener?: SandboxContract<TreasuryContract>;
};

export type Acquisition = {
    /** The `bid` transaction — the one that settles the sale. */
    result: any;
    /** What the buyer actually attached, and therefore what the lot cleared at. */
    price: bigint;
    /**
     * `price − MINT_PRICE − RES_GAS`. Since D-114 (amends D-7) only half of
     * this reaches `T` as a pure floor step; the other half goes to the
     * governed treasury.
     */
    premium: bigint;
    /** The lot as it stood immediately before the purchase. */
    standingPrice: bigint;
};

/**
 * `MINT_PRICE` — the nominal mint price the §4.1 split always runs on. D-88
 * point 1 makes it the LOWER BOUND on a Dutch lot's resting price rather than
 * the resting price itself (`getPrimeFloor(n)` is the real one, at or above it),
 * but it is still what `premium` is measured against on every lane.
 */
const MINT_PRICE = toNano('1');
/** `RES_GAS` from `primes_market.tolk` — added on top of the number's price. D-113: 0.06 -> 0.07. */
const RES_GAS = toNano('0.07');

/**
 * Open the descending BUYNOW lot on `p`. Permissionless and unpriced; separate
 * from `acquirePrime` only so that a test about the decay curve itself can open a
 * lot, drive the clock, and read `getLot` without buying anything.
 */
export async function openHeadLot(
    lane: DutchLane,
    who: SandboxContract<TreasuryContract>,
    p: bigint,
    value: bigint = HEAD_LOT_GAS
) {
    return lane.market.sendOpenHeadLot(who.getSender(), { n: p, value });
}

/**
 * Acquire prime `p` for `who`, exactly as a player does — ON WHICHEVER LANE
 * D-88 PUTS IT.
 *
 * The common case is still `await acquirePrime(lane, alice, 3n)`, and it still
 * hardcodes no price: the figure comes off `getLot`, so a change to `p0Of`, to
 * the decay slope or to the resting price moves these tests without editing
 * them, which is the property that makes this a fixture rather than a second
 * implementation of the curve.
 *
 * D-88 point 3 gives a prime TWO lanes, split by the head, and this helper picks
 * between them the same way the contract does — by comparing `p` to the market's
 * `headHint`:
 *
 *   p <  headHint  the turn has passed → DESCENDING (`open_head_lot`, then `bid`
 *                  IS the purchase, settling in that transaction)
 *   p >= headHint  still ahead of the head → ASCENDING (`open_lot` with kind 1,
 *                  where opening IS a paid first bid at the same P0(p); run the
 *                  7-day clock out and `close`, which mints the prime on the
 *                  spot — D-88 point 4, no escrowed claim, because the head will
 *                  never arrive at a prime to settle one)
 *
 * The returned `price` / `premium` mean the same thing on both: what the buyer
 * actually attached, and the part of it above `MINT_PRICE + RES_GAS`.
 */
export async function acquirePrime(
    lane: DutchLane,
    who: SandboxContract<TreasuryContract>,
    p: bigint,
    opts: AcquireOpts = {}
): Promise<Acquisition> {
    const { blockchain, market } = lane;

    if (!(await market.getLot(p)).found) {
        if (lane.ledger && (await market.getHeadHint()) <= p) {
            await lane.ledger.sendSyncHead((opts.opener ?? who).getSender(), { value: toNano('0.1') });
        }
        if ((await market.getHeadHint()) <= p) {
            return acquirePrimeAhead(lane, who, p, opts);
        }
        const opened = await openHeadLot(lane, opts.opener ?? who, p);
        expectSucceeded(opened, market.address, `OpenHeadLot(${p})`);
    }

    if (opts.atFloor) {
        const { decaySeconds } = await market.getPrimeDutchTerms();
        blockchain.now = (blockchain.now ?? 0) + decaySeconds + 1;
    } else if (opts.afterSeconds) {
        blockchain.now = (blockchain.now ?? 0) + opts.afterSeconds;
    }

    const lot = await market.getLot(p);
    const price = opts.pay ?? lot.minPayment + (opts.margin ?? 0n);

    const result = await market.sendBid(who.getSender(), {
        n: p,
        beneficiary: opts.beneficiary ?? null,
        referralKey: opts.referralKey ?? 0,
        value: price,
    });
    expectSucceeded(result, market.address, `Bid(${p})`);

    // The descending lane books the CLOCK's price, `minPayment`, and refunds the
    // margin above it (audit Low): only that price carries a premium.
    return { result, price, premium: lot.minPayment - MINT_PRICE - RES_GAS, standingPrice: lot.standingPrice };
}

/**
 * D-88 point 3's lane, for a prime the head has NOT passed: a paid ascending
 * auction opening at the very P0(p) the descending lane would have quoted. Split
 * out of `acquirePrime` rather than inlined so the two lanes read as two, and so
 * a test whose subject is this lane can call it directly.
 *
 * MOVES `blockchain.now` past the lot's `closesAt`, like `winLot` — an
 * uncontested 7-day auction has no other termination. `atFloor` / `afterSeconds`
 * are ignored here and say so: this lane has no decay to wait out, its price is
 * flat at P0 and rises only if somebody else bids.
 */
export async function acquirePrimeAhead(
    lane: DutchLane,
    who: SandboxContract<TreasuryContract>,
    p: bigint,
    opts: AcquireOpts = {}
): Promise<Acquisition> {
    const { blockchain, market } = lane;
    const quote = await market.getLotPrice(p);
    const price = opts.pay ?? quote.p0 + (opts.margin ?? 0n);

    const opened = await market.sendOpenLot((opts.opener ?? who).getSender(), {
        n: p,
        kind: 1, // D-88 point 3: the ascending lane takes primes now
        factors: [], // none to submit — the contract proves primality by Miller-Rabin
        beneficiary: opts.beneficiary ?? null,
        referralKey: opts.referralKey ?? 0,
        value: price,
    });
    expectSucceeded(opened, market.address, `OpenLot(${p}, prime)`);

    const lot = await market.getLot(p);
    if (lot.closesAt > 0) blockchain.now = lot.closesAt + 1;
    const result = await market.sendClose(who.getSender(), { n: p, value: CLOSE_LOT_GAS });
    expectSucceeded(result, market.address, `CloseLot(${p}, prime)`);

    return { result, price, premium: price - MINT_PRICE - RES_GAS, standingPrice: quote.p0 };
}

/**
 * A failed acquisition is the failure mode this whole helper exists to make
 * impossible to miss: a refused `bid` leaves the test running against a prime
 * nobody owns, which is EXACTLY the silent-no-op the pre-D-20 `mint(p, 1, [])`
 * calls degenerated into. So it throws here, at the acquisition, rather than five
 * assertions later at a rank that did not move.
 */
function expectSucceeded(result: any, market: Address, what: string) {
    const tx = result.transactions.find(
        (t: any) => t.inMessage?.info?.type === 'internal' && t.inMessage.info.dest?.equals(market)
    );
    const cp = tx?.description?.computePhase;
    const exit = cp?.type === 'vm' ? cp.exitCode : undefined;
    if (!tx || (exit !== 0 && exit !== undefined) || tx.description?.aborted) {
        throw new Error(`${what} was refused by the market (exit ${exit ?? 'n/a'})`);
    }
}

// ===========================================================================
// D-30 — ACQUIRING A COMPOSITE AHEAD OF THE HEAD
// ===========================================================================
//
// The flat-fee `reserve` entry point is DELETED. There is exactly one route to a
// composite before the head reaches it: open an ascending lot (opening IS a paid
// first bid at `P0(n)`), let the 7-day clock run, and close it. D-90: the close
// MINTS THE NFT in its own transaction — there is no escrowed claim and no wait
// for the head, which never arrives at an auctioned position anyway.
//
// `winLot` is that sequence, and it is deliberately the ONLY one in the tests: a
// second way to buy a number ahead of the head would be a second way the tests
// could disagree with the contract about what D-30/D-90 say.

/** What `close(n)` costs to send. Permissionless; gas only. */
export const CLOSE_LOT_GAS = toNano('0.3');

export type LotLane = {
    blockchain: Blockchain;
    /**
     * `SandboxContract` and `@ton/core`'s `OpenedContract` are the same shape;
     * the suites use both spellings, so the helper accepts either.
     */
    market: SandboxContract<PrimesMarket> | OpenedContract<PrimesMarket>;
};

export type WinLotOpts = {
    /** §4.5 — who ends up owning the number. Defaults to the opener. */
    beneficiary?: Address | null;
    referralKey?: number;
    /**
     * Added on top of `P0(n)`. Defaults to a fee margin: the standing repo rule
     * is that a message carries the nominal price PLUS a margin, never the exact
     * nominal, or the contract rejects it once its own compute phase is charged.
     * The whole payment is booked as the opening bid, so the margin lands in the
     * lot's clearing price and, at close, in the ratchet.
     */
    margin?: bigint;
    /** Pay exactly this instead of `p0 + margin`. */
    pay?: bigint;
    /** Who closes the lot. Permissionless; defaults to the opener. */
    closer?: SandboxContract<TreasuryContract>;
    /**
     * Leave the lot OPEN — open it and return without running the clock out.
     * For a test about the auction itself rather than about the claim it becomes.
     */
    openOnly?: boolean;
};

export type LotWin = {
    openResult: any;
    closeResult: any;
    /** What the lot cleared at — the opener's whole payment. */
    price: bigint;
    /**
     * `price − MINT_PRICE − RES_GAS`. Since D-114 (amends D-7) only half of
     * this reaches `T` as a pure floor step; the other half goes to the
     * governed treasury.
     */
    premium: bigint;
    /** `P0(n)` as the contract quoted it at open time. */
    p0: bigint;
};

/**
 * Open an ascending lot on composite `fx.n` and win it uncontested.
 *
 * MOVES `blockchain.now` to just past the lot's `closesAt` (D-3's 7-day clock),
 * because that is the only termination an uncontested lot has short of the head
 * arriving at `n`. A test that is also measuring `k(t)` should re-base its clock
 * afterwards.
 */
export async function winLot(
    lane: LotLane,
    who: SandboxContract<TreasuryContract>,
    fx: { n: bigint; factors: FactorEntry[] },
    opts: WinLotOpts = {}
): Promise<LotWin> {
    const { blockchain, market } = lane;
    // PHASE 3 (PRICING_MODEL_PLAN.md §4): `open_lot` prices a composite off the
    // factorization it is being sent, so the quote has to be asked the same way
    // or it under-quotes by the factor categories and the open is refused
    // (exit 1003, `mkt_open_below_p0`). `getLotPrice(n)` is the LOWER BOUND for
    // a caller who does not yet have the factors; this caller does.
    const quote = await market.getLotPriceFrom(fx.n, fx.factors);
    const price = opts.pay ?? quote.p0 + (opts.margin ?? toNano('0.1'));

    const openResult = await market.sendOpenLot(who.getSender(), {
        n: fx.n,
        kind: 0, // D-22: the ascending lane is the COMPOSITE lane
        factors: fx.factors,
        beneficiary: opts.beneficiary ?? null,
        referralKey: opts.referralKey ?? 0,
        value: price,
    });
    expectSucceeded(openResult, market.address, `OpenLot(${fx.n})`);

    if (opts.openOnly) {
        return { openResult, closeResult: undefined, price, premium: price - MINT_PRICE - RES_GAS, p0: quote.p0 };
    }

    const lot = await market.getLot(fx.n);
    // D-3: opening IS the first bid, so the clock is already running.
    if (lot.closesAt > 0) blockchain.now = lot.closesAt + 1;
    const closeResult = await market.sendClose((opts.closer ?? who).getSender(), {
        n: fx.n,
        value: CLOSE_LOT_GAS,
    });
    expectSucceeded(closeResult, market.address, `CloseLot(${fx.n})`);

    return { openResult, closeResult, price, premium: price - MINT_PRICE - RES_GAS, p0: quote.p0 };
}
