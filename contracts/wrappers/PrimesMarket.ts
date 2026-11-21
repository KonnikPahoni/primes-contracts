import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractProvider,
    Dictionary,
    TupleItem,
    Sender,
    SendMode,
    contractAddress,
} from '@ton/core';
import { MARKET, SCORE_BITS } from '../../shared/opcodes';
import { FactorEntry } from './PrimesLedger';
import { factorsCell } from '../../shared/factors';
import { buildOpenLotMessage, buildOpenHeadLotMessage, buildBidMessage, buildCloseLotMessage } from '../../shared/messages';

/**
 * A factor list as a get-method ARGUMENT: the dictionary's own root cell, or
 * `null` for the empty list. `encodeFactors` returns a `Dictionary`, which is
 * what a message body wants (`storeDict` writes the maybe-ref); a stack entry
 * wants the root itself, and an empty dictionary has no root — which is exactly
 * the `null` the contract reads as "no factorization supplied".
 */
function factorsArg(factors: FactorEntry[]): TupleItem {
    const cell = factorsCell(factors);
    return cell ? { type: 'cell', cell } : { type: 'null' };
}

/**
 * P2.A7 — the wrapper for the UNIFIED market (D-3).
 *
 * It replaces `PrimesReservationBook`, `PrimesTrophyAuction` and `PrimesAuction`,
 * whose contracts retired with it. Player messages are on 0xF2; the 0xE0 page
 * carries only the ledger's callbacks (D-90 deleted the escrowed-claim lane).
 */

/** D-11 / D-18: 10000 · 2^32 − 1. Also `getAuctionableMax()`. */
export const AUCTIONABLE_MAX = 42949672959999n;

export const MODE_ASCENDING = 0;
// D-20: MODE_DUTCH_CLOCK (1) is DELETED. There was never a genesis-specific
// pre-bid format to fold in a second mode for — every prime, from 2 onward,
// opens on the one MODE_DUTCH_BUYNOW lane below.
export const MODE_DUTCH_BUYNOW = 2;
// D-88 point 2 DELETES MODE_DUTCH_BUYNOW_SPECIAL (3) and
// MODE_DUTCH_BUYNOW_SPECIAL_COMPOSITE (4). Specialness is price, not mechanism:
// a special number rides the same two lanes with its `p0` and `priceFloor`
// lifted to its tier's price_max / price_min. Values 3 and 4 are retired, not
// reassigned — the same treatment D-20 gave 1.

// D-20 DELETES `ClearingCleared.lane` and the CLEARING_LANE_* consts along
// with it — the message now carries only the premium, uniformly, on every
// lane. A prime sale is reported by the separate `SettlePrimeClearing`.

export type MarketConfig = {
    headHint: bigint;
    ledgerAddr: Address;
    ratchetAddr: Address;
    // D-90 DELETES `shardCode` and `treasuryAddr`. There are no escrow shards to
    // derive an address for, and the treasury address existed for exactly one
    // send — D-32's 10% release forfeit — which D-90.2 deletes.
    /**
     * NPV(p) per prime. Ships as a dict so the closed form can replace it
     * later without a wire change — but "later" means a fresh deploy, not a setter.
     */
    npvTable?: Dictionary<bigint, bigint>;
    /**
     * D-139 — THE TEST CLOCK. Divides every wall-clock constant the market
     * enforces: `AUCTION_WINDOW` (604800), `BID_EXTENSION` (4020) and
     * `PRIME_DUTCH_SECONDS` (604800). **1 is mainnet and the identity.** 168
     * turns a 7-day lot into a 1-hour lot, which is the whole reason the field
     * exists: a full-protocol testnet run cannot wait out two 7-day auctions.
     * Deploy-time only — no message reaches it, so a running lot's clock cannot
     * be shortened by anyone. Genesis reads it from `PRIMES_AUCTION_SECONDS`.
     */
    clockDivisor?: number;
    /**
     * TEST-HARNESS ONLY (GAUNTLET A3.2), mirroring `PrimesLedger`'s
     * `seedUnroutedCredits`: a genuine `ClearingCleared` bounce (the ledger
     * out-of-gas or otherwise rejecting it) is not deterministically
     * reproducible in the sandbox, so tests reach `RetryPremiumForward`'s state
     * — `counters.unforwardedByN` / `unforwardedPremium` already populated —
     * by seeding it directly at deploy instead.
     */
    seedUnforwarded?: { n: bigint; amount: bigint }[];
    /**
     * `minAuctionDistance` / `MIN_AUCTION_DISTANCE_DEFAULT` are DELETED (D-45).
     * The ascending lane's old liveness gate — refuse `n <= headHint +
     * minAuctionDistance`, so a lot's 7-day window finishes before the head
     * could arrive and truncate it — no longer has a referent: `open_lot` now
     * takes `n` off the ledger's sequential line the moment it runs
     * (`mark_off_head`), permanently, so a head arrival can never truncate a
     * lot at any distance. See `primes_ledger.tolk` / `primes_market.tolk`'s
     * D-45 notes. A lot may now open at any distance ahead of the head,
     * including the very next number — no test-only "short gate" is needed
     * any more either.
     */
    /**
     * D-33's bid-increment ladder USED TO BE A FIELD HERE, shipped empty and
     * inert while W8.1 was outstanding. The run landed and the ladder is 13
     * small integers, so it is a FILE CONSTANT in `primes_market.tolk` now
     * (`incrementBpsAt` / `MIN_INCREMENT_FLOOR`) and is read with
     * `getIncrementLadder()`. Nothing to pass at deploy, and nothing anybody
     * can pass a wrong version of.
     */
};

/**
 * D-139. Shared by every wrapper that carries a `clockDivisor`, kept here
 * because the market is the contract the field was introduced for. Refuses the
 * two values that would silently break a deploy rather than defaulting them
 * quietly: 0 (the contract reads it as 1, so an accidental 0 is a lie about the
 * clock) and anything past `BID_EXTENSION`, where the anti-snipe extension
 * would floor to zero seconds and the auction would stop extending at all.
 */
export function clockDivisorOf(divisor: number | undefined): number {
    const d = divisor ?? 1;
    if (!Number.isInteger(d) || d < 1 || d > 4020) {
        throw new Error(`clockDivisor must be an integer in 1..4020 (got ${d})`);
    }
    return d;
}

function marketConfigToCell(config: MarketConfig): Cell {
    // D-20 DELETES `MarketLinks` (`collectionAddr`, `treasuryAddr`,
    // `genesisScriptAddr`, `bootstrapped`) entirely — the market no longer
    // mints an item or takes a treasury cut directly (both happen on the
    // ledger's side of `SettlePrimeClearing`), and there is no genesis
    // bootstrap step left to guard with a one-shot flag.
    const cfg = beginCell()
        .storeAddress(config.ledgerAddr)
        .storeAddress(config.ratchetAddr)
        .storeDict(config.npvTable)
        .storeUint(clockDivisorOf(config.clockDivisor), 16)   // D-139
        .endCell();

    // Every counter opens at zero on a fresh market, and all of them are
    // ADDRESS-DETERMINING init data — the same rule the book's four counters
    // followed. Omitting one derives a different address than the scripts deploy to.
    //
    // D-20 DELETES `genesisDecayStart`, `genesisCleared` and `genesisProceeds` —
    // the genesis-specific decay/floor bootstrap they tracked retired with
    // `BootstrapGenesis`; every prime now shares the one universal Dutch curve.
    const seedUnforwarded = config.seedUnforwarded ?? [];
    const seededUnforwardedPremium = seedUnforwarded.reduce((sum, u) => sum + u.amount, 0n);
    let unforwardedByN: Dictionary<bigint, bigint> | undefined;
    if (seedUnforwarded.length > 0) {
        unforwardedByN = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.BigVarUint(4));
        for (const u of seedUnforwarded) unforwardedByN.set(u.n, u.amount);
    }

    const counters = beginCell()
        // D-90 DELETES totalEscrow / totalPremium / escrowedCount — no escrow pool.
        .storeUint(0, 32) // forceCancels
        .storeUint(0, 32) // openLots
        .storeUint(0, 32) // closedLots
        .storeCoins(0) // lotPremiumTotal
        .storeCoins(seededUnforwardedPremium) // unforwardedPremium
        .storeDict(unforwardedByN) // unforwardedByN
        .storeCoins(0) // heldBids
        .storeDict(null) // sold (D-188 point 5: the tombstone bitmap)
        .endCell();

    return (
        beginCell()
            .storeUint(config.headHint, 64)
            // CONCEPT §6 point 0: CLOSED at deploy. Nothing is quoted, escrowed or
            // bid on until the ledger's single `launch_open` arrives.
            .storeUint(0, 1) // launched
            .storeDict(undefined) // lots
            .storeRef(counters)
            .storeRef(cfg)
            .endCell()
    );
}

export class PrimesMarket implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesMarket(address);
    }

    static createFromConfig(config: MarketConfig, code: Cell, workchain = 0) {
        const data = marketConfigToCell(config);
        const init = { code, data };
        return new PrimesMarket(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    // -----------------------------------------------------------------------
    // Lot lane
    // -----------------------------------------------------------------------

    /**
     * D-3: open an ASCENDING lot AND place the opener's own bid, which must be at
     * least `P0(n)`. You cannot open a lot you are unwilling to buy — which is what
     * deletes the no-bid, expiry, reserve-not-met and refund-the-opener states
     * outright. The mint payload (factors, beneficiary, referral) rides HERE, on
     * the open, because the close mints the number to the winner (D-90).
     */
    async sendOpenLot(
        provider: ContractProvider,
        via: Sender,
        opts: {
            n: bigint;
            kind: number;
            factors: FactorEntry[];
            beneficiary: Address | null;
            referralKey: number;
            value: bigint;
            queryID?: number;
        }
    ) {
        const { body } = buildOpenLotMessage({
            n: opts.n,
            kind: opts.kind as 0 | 1,
            factors: opts.factors,
            referralKey: opts.referralKey,
            beneficiary: opts.beneficiary,
            bidNanoton: 0n, // the wrapper attaches `opts.value` itself
            queryId: BigInt(opts.queryID ?? 0),
        });
        await provider.internal(via, { value: opts.value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    /**
     * D-4/D-20: open the descending BUYNOW lot on a prime once `n < headHint` —
     * i.e. once the composite before it has been minted. No upper bound and no
     * expiry (the old `lookaheadH` window is retired). Permissionless, and the
     * lot never blocks the direct mint — primes simply never occupy the head.
     */
    async sendOpenHeadLot(
        provider: ContractProvider,
        via: Sender,
        opts: { n: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buildOpenHeadLotMessage({ n: opts.n, queryId: BigInt(opts.queryID ?? 0) }).body,
        });
    }

    /**
     * One message, two meanings (D-20 deletes the DUTCH_CLOCK pre-bid case
     * with the mode itself), resolved by the lot's mode: a raise on ASCENDING,
     * and THE PURCHASE on DUTCH_BUYNOW — which settles in this same
     * transaction (D-20/D-88).
     *
     * `beneficiary` and `referralKey` are read only on the BUYNOW lane, whose lot
     * carries no payload of its own; the ASCENDING lane ignores them and uses the
     * payload the lot was OPENED with. No `kind`/`factors` here: a BUYNOW lot is
     * prime by Miller-Rabin at open, so there is nothing to factor.
     *
     * `value` must exceed `getLot(n).minPayment` by a fee margin — the contract
     * rejects the exact nominal once its own compute phase is charged.
     */
    async sendBid(
        provider: ContractProvider,
        via: Sender,
        opts: {
            n: bigint;
            beneficiary: Address | null;
            referralKey: number;
            value: bigint;
            queryID?: number;
        }
    ) {
        const { body } = buildBidMessage({
            n: opts.n,
            bidNanoton: 0n, // the wrapper attaches `opts.value` itself
            beneficiary: opts.beneficiary,
            referralKey: opts.referralKey,
            queryId: BigInt(opts.queryID ?? 0),
        });
        await provider.internal(via, { value: opts.value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    /**
     * Permissionless: closes an ASCENDING lot whose clock has run out (or whose
     * head has arrived). D-20: a MODE_DUTCH_BUYNOW lot has no permissionless
     * termination at all — it always throws `mkt_close_too_early` (1005) here;
     * its only termination is a purchase via `sendBid`.
     */
    async sendClose(provider: ContractProvider, via: Sender, opts: { n: bigint; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buildCloseLotMessage({ n: opts.n, queryId: BigInt(opts.queryID ?? 0) }).body,
        });
    }

    /**
     * PERMISSIONLESS, ONE number per call: re-sends a bounced premium forward,
     * for exactly the amount that actually came back (never a recomputed
     * figure). GAUNTLET A3.2.
     */
    async sendRetryPremiumForward(
        provider: ContractProvider,
        via: Sender,
        opts: { n: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MARKET.retry_premium_forward, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.n, 64)
                .endCell(),
        });
    }

    /**
     * D-200, PERMISSIONLESS: folds every resting descending row (decay window over)
     * among the first PARK_SCAN_MAX rows at or above `from` into its `parked` bit.
     * The lot stays open and buyable at its resting price. The handler asserts no
     * value; the compute is bought from `value` and the change rides back.
     */
    async sendParkLots(provider: ContractProvider, via: Sender, opts: { from: bigint; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MARKET.park_lots, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.from, 64)
                .endCell(),
        });
    }

    // D-20 DELETES `sendBootstrapGenesis`. There is no genesis-specific admin
    // bootstrap message left on this contract — every prime opens through the
    // same permissionless `sendOpenHeadLot` above, once eligible.
    //
    // `SettlePrimeClearing` (0xb0000024) is market -> LEDGER, sent internally
    // by `closeLot` on a MODE_DUTCH_BUYNOW close. Its builder lives on
    // `PrimesLedger.ts` (`sendSettlePrimeClearing`) — the same place
    // `sendClearingCleared` lives — because tests construct it addressed AT
    // the ledger, impersonating the market the way `marketStub` already does
    // for `ClearingCleared`, not addressed at this contract.

    // D-90 DELETES `sendRelease` and `sendSettle` with the escrowed-claim lane.
    // A won lot mints in its own close transaction, on both kinds, so there is
    // nothing left to settle later and nothing to hand back — resale is the
    // secondary market. The composite close's `MintWonLot` is sent
    // internally by `closeLot`; like `SettlePrimeClearing`, its test-facing
    // builder lives on `PrimesLedger.ts`, addressed AT the ledger.

    // -----------------------------------------------------------------------
    // Get-methods
    // -----------------------------------------------------------------------

    /** CONCEPT §6 point 0: will this contract take player money at all? */
    async getLaunched(provider: ContractProvider) {
        return (await provider.get('getLaunched', [])).stack.readNumber() === 1;
    }

    async getHeadHint(provider: ContractProvider) {
        return (await provider.get('getHeadHint', [])).stack.readBigNumber();
    }

    // `getShardAddress` is DELETED (D-90.3): there are no shards to address.

    /** D-11 / D-18 — the cap as a checkable contract property. */
    async getAuctionableMax(provider: ContractProvider) {
        return (await provider.get('getAuctionableMax', [])).stack.readBigNumber();
    }

    /**
     * D-30/D-33 — THE quote for opening a lot, and the only one (it replaces the
     * deleted `getReservationPrice` as well as its own old shape).
     *
     *   p0            what opening costs; opening IS the first bid, so send this
     *                 PLUS a fee margin, never the exact nominal.
     *   resGas        the settlement the winner funds (inside p0 on the
     *                 ascending lane, added on top of the standing Dutch price).
     *   minIncrement  what the SECOND bid must clear above p0.
     *   score         D(n), so §9.1's reader can recompute the price.
     *   flags         D-99's 54-bit category bitmask `score` is the weighted sum
     *                 of. The orb's satellites are drawn from this and nothing
     *                 else; `getScoreBreakdown(n)` returns the same pair.
     *
     * Runs Miller-Rabin on chain; never trusts a caller-supplied `kind`.
     */
    async getLotPrice(provider: ContractProvider, n: bigint) {
        const r = await provider.get('getLotPrice', [{ type: 'int', value: n }]);
        return {
            p0: r.stack.readBigNumber(),
            resGas: r.stack.readBigNumber(),
            minIncrement: r.stack.readBigNumber(),
            score: r.stack.readNumber(),
            flags: r.stack.readBigNumber(),
        };
    }

    /**
     * PHASE 3 (PRICING_MODEL_PLAN.md §4) — the same quote, priced off the
     * factorization the caller is about to send to `open_lot`.
     *
     * `getLotPrice(n)` is a LOWER BOUND: bits 33..38 are the categories `n` alone
     * cannot decide (semiprime, prime power, square-free, 7-smooth,
     * abundant/deficient), and GAUNTLET.md N6 added a seventh at bit 39
     * (`carmichael`, by Korselt's criterion). It returns all seven clear. This
     * returns the price
     * `open_lot` will actually charge. Passing `[]` reproduces `getLotPrice`
     * exactly, so the two can be compared directly.
     *
     * A SECOND METHOD AND NOT AN ARGUMENT ON THE FIRST: a TVM get-method has no
     * optional arguments, so growing `getLotPrice` would have broken every
     * existing caller — the read-proxy's live lane quote among them — to buy
     * nothing this does not.
     */
    async getLotPriceFrom(provider: ContractProvider, n: bigint, factors: FactorEntry[]) {
        const r = await provider.get('getLotPriceFrom', [{ type: 'int', value: n }, factorsArg(factors)]);
        return {
            p0: r.stack.readBigNumber(),
            resGas: r.stack.readBigNumber(),
            minIncrement: r.stack.readBigNumber(),
            score: r.stack.readNumber(),
            flags: r.stack.readBigNumber(),
        };
    }

    /**
     * `standingPrice` is the descending price right now on a Dutch lane and `p0` on
     * an ascending one. `minPayment` is exactly what `bid` measures `in.valueCoins`
     * against — callers still add a fee margin. `closesAt` includes every snipe
     * extension applied so far; 0 means the clock has not started.
     */
    async getLot(provider: ContractProvider, n: bigint) {
        const r = await provider.get('getLot', [{ type: 'int', value: n }]);
        return {
            found: r.stack.readNumber() === 1,
            mode: r.stack.readNumber(),
            p0: r.stack.readBigNumber(),
            standingPrice: r.stack.readBigNumber(),
            minPayment: r.stack.readBigNumber(),
            highBid: r.stack.readBigNumber(),
            highBidder: r.stack.readAddress(),
            openedAt: r.stack.readNumber(),
            closesAt: r.stack.readNumber(),
            closed: r.stack.readNumber() === 1,
        };
    }

    /**
     * D-61 option 2 (GAUNTLET.md C6.2b): the same `floorOf` the contract itself
     * prices the lane with, for `n`'s lot — so this cannot answer differently
     * from the mechanism by construction. `found: false` for a number with no
     * lot yet (an ascending lot's floor is its own opening bid, which does not
     * exist before the lot does), same convention as `getLot`.
     */
    async getLotFloor(provider: ContractProvider, n: bigint) {
        const r = await provider.get('getLotFloor', [{ type: 'int', value: n }]);
        return {
            found: r.stack.readNumber() === 1,
            floor: r.stack.readBigNumber(),
        };
    }

    /**
     * D-200: what `park_lots { from }` would do now — the rows it would fold, and
     * the next `from` to page with (-1 at the end of the map).
     */
    async getParkScan(provider: ContractProvider, from: bigint) {
        const r = await provider.get('getParkScan', [{ type: 'int', value: from }]);
        return { folds: r.stack.readNumber(), next: r.stack.readBigNumber() };
    }

    /**
     * D-30 — replaces `getIsReservable`. 1 iff a lot may be opened for n at all,
     * which is now the whole of "can I have this number ahead of the head".
     * Primorials (§7) and anything above the D-11 cap answer false.
     *
     * `getIsAuctionOnly` is DELETED with `D_MIN`: every openable number is
     * auction-only now, so the predicate had no content left.
     */
    async getIsOpenable(provider: ContractProvider, n: bigint) {
        return (await provider.get('getIsOpenable', [{ type: 'int', value: n }])).stack.readNumber() === 1;
    }

    /**
     * WHICH lane, for a number that is openable — and under D-30/D-31 it depends
     * only on primality. Returns the same values `getLot(n).mode` reports:
     * `MODE_ASCENDING` (0) for a composite, `MODE_DUTCH_BUYNOW` (2) for a prime,
     * and -1 for a number that is not openable at all.
     */
    async getLotLane(provider: ContractProvider, n: bigint) {
        return (await provider.get('getLotLane', [{ type: 'int', value: n }])).stack.readNumber();
    }

    /**
     * D-30/D-37: ONE fee survives, so this is one number rather than a split.
     * `RES_PRIORITY_BASE` and `RES_PREMIUM` are deleted as fees; RES_GAS is the
     * settlement a won lot must fund.
     */
    async getResGas(provider: ContractProvider) {
        return (await provider.get('getResGas', [])).stack.readBigNumber();
    }

    /**
     * `(resGas, settleGas)` — the settlement fee and the slice of it that rides
     * to the ledger with the settlement. D-90 moves this from the deleted shard's
     * `getResFeeSplit`, where it published the same pair.
     */
    async getResFeeSplit(provider: ContractProvider) {
        const r = await provider.get('getResFeeSplit', []);
        return { resGas: r.stack.readBigNumber(), settleGas: r.stack.readBigNumber() };
    }

    /**
     * Every declared format constant, checked against params.json by
     * SimCrossCheck.spec.ts. D-20 drops the three trailing Phase 1 fields
     * (`lookaheadH`, `genesisDecaySeconds`, `genesisFloorDivisor`) — all three
     * are retired file constants now (`PRIME_DUTCH_SECONDS`, `MINT_PRICE`),
     * published instead by `getPrimeDutchTerms`.
     */
    async getMarketParams(provider: ContractProvider) {
        const r = await provider.get('getMarketParams', []);
        return {
            scoreHalving: r.stack.readNumber(),
            // D-99 replaces `primeP0Min` in this slot. `PRIME_P0_MIN` existed to
            // make the prime lane EXIST when primality scored zero; the score
            // weighs primality itself now, so what the reader needs here is the
            // CLAMP — it is what makes the 420 TON ceiling checkable, and with
            // `scoreHalving` it also fixes the bid ladder's rung count.
            scoreMax: r.stack.readNumber(),
            primeP0MultPct: r.stack.readNumber(),
            // D-30: `RESERVE_FLOOR` (1.05) is now `LOT_FLOOR`, and D-113's
            // re-derived RES_GAS (0.07, was W8.1's 0.06) puts it at 1.07 by the
            // identity MINT_PRICE + RES_GAS. `dMin` is gone with the worth gate.
            lotFloor: r.stack.readBigNumber(),
            auctionWindow: r.stack.readNumber(),
            bidExtension: r.stack.readNumber(),
            // `minAuctionDistance` DROPPED FROM THIS TUPLE (D-45): the
            // ascending lane's liveness gate is deleted, not merely un-set —
            // see the config type's D-45 note.
            minIncrementFloor: r.stack.readBigNumber(),
        };
    }

    /**
     * D-33's ladder in full — nine basis-point rungs indexed by `D(n) /
     * SCORE_HALVING`, then the shared nanoton floor and the bps denominator.
     * §9.1: the minimum raise on any lot is recomputable off chain from `n`.
     * Checked against params.json `acquisition.bid_increment_ladder` by
     * SimCrossCheck.spec.ts.
     */
    /**
     * §6 point 0's launch gate, as the LEDGER sends it. Only the configured
     * `ledgerAddr` may send it, so this is usable in a test that deploys a market
     * pointed at a plain wallet without the whole genesis stack.
     */
    async sendLaunchOpen(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MARKET.launch_open, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .endCell(),
        });
    }

    async getIncrementLadder(provider: ContractProvider) {
        const r = await provider.get('getIncrementLadder', []);
        const bps: number[] = [];
        // NINE rungs since D-99: the band is `D(n) / SCORE_HALVING` and the clamp is 87,
        // so bands 9..12 are unreachable by construction rather than merely unused.
        for (let i = 0; i < 9; i++) bps.push(r.stack.readNumber());
        return {
            bps,
            minIncrementFloor: r.stack.readBigNumber(),
            bpsDen: r.stack.readNumber(),
        };
    }

    /**
     * The lane's DECLARED terms. `floorMin` equals MINT_PRICE exactly, by
     * construction — not by reading any lot. D-88 point 1 deleted invariant
     * MKT-1 (`floorOf(MODE_DUTCH_BUYNOW) == MINT_PRICE`), so this constant is
     * the LOWER BOUND on a resting price, not the price any lot rests at. Use
     * `getPrimeFloor(n)` or `getLotFloor(n)` for that.
     *
     * GAUNTLET C6.1: this used to add "it is a derived value on the BUYNOW lane,
     * never stored, so this is the only way to audit it". Neither half held after
     * SS3/D-47. The contract returns the CONSTANT `MINT_PRICE` here, but `floorOf`
     * now consults the lot's stored `Lot.priceFloor`, so what this get-method
     * publishes is the lane's declared floor and no longer the value any
     * particular lot actually rests on — the two agree because `open_head_lot`
     * writes `MINT_PRICE` into an ordinary lot, not because this reads it.
     *
     * **D-61 (2026-08-28, GAUNTLET.md C6.2): the outside-checkable witness is
     * `PrimesMarket.spec.ts`'s C6 block**, which runs a specific lot's clock out
     * and reads `getLot(n).standingPrice` off the contract — not this call. A
     * `getLotFloor(n)` reading through `floorOf` per lot is signed (D-61 option 2)
     * and deferred to the next redeploy, since adding a get-method is wire surface.
     */
    async getPrimeDutchTerms(provider: ContractProvider) {
        const r = await provider.get('getPrimeDutchTerms', []);
        return {
            /** D-88 point 1: the LOWER BOUND on a resting price, not the resting
             *  price itself — a prime's lane terminates at `getPrimeFloor(n)`,
             *  which is at or above this. */
            floorMin: r.stack.readBigNumber(),
            decaySeconds: r.stack.readNumber(),
            /** `PRIME_FLOOR_MULT` as a percentage of NPV(n): 50 means the
             *  resting price is `max(NPV(n) / 2, P0(n) / 3, floorMin)` (D-99 §1.2). */
            floorPctOfNpv: r.stack.readNumber(),
        };
    }

    /**
     * D-88 point 1 — where `n`'s descending lot comes to rest and PARKS until
     * bought: `max(NPV(n) / 2, P0(n) / 3, MINT_PRICE)` (D-99 §1.2). Answers from `n` alone, so the UI can draw the
     * whole descent before a lot exists; `getLotFloor(n)` answers the same
     * number for a lot that already does.
     */
    async getPrimeFloor(provider: ContractProvider, n: bigint) {
        return (await provider.get('getPrimeFloor', [{ type: 'int', value: n }])).stack.readBigNumber();
    }

    /**
     * D-99 REPLACES `getSpecialNumberTerms`. There are no tiers and no per-tier
     * price lifts left to publish: a number's specialness IS its score and its
     * score is its price, both already in `getLotPrice`. What this adds is the
     * ability to recompute that score — sum `SCORE_WEIGHTS[bit]` over the set
     * bits of `flags`, add `LEN_W · (LEN_REF − digits)`, clamp at `SCORE_MAX`,
     * and you must land on `score`.
     */
    async getScoreBreakdown(provider: ContractProvider, n: bigint) {
        const r = await provider.get('getScoreBreakdown', [{ type: 'int', value: n }]);
        return { score: r.stack.readNumber(), flags: r.stack.readBigNumber() };
    }

    /**
     * PHASE 3 (§4) — the same breakdown with bits 33..38 decided from a
     * submitted factorization. `[]` reproduces `getScoreBreakdown(n)`.
     */
    async getScoreBreakdownFrom(provider: ContractProvider, n: bigint, factors: FactorEntry[]) {
        const r = await provider.get('getScoreBreakdownFrom', [{ type: 'int', value: n }, factorsArg(factors)]);
        return { score: r.stack.readNumber(), flags: r.stack.readBigNumber() };
    }

    async getFracTable(provider: ContractProvider) {
        const r = await provider.get('getFracTable', []);
        const frac: bigint[] = [];
        for (let i = 0; i < 10; i++) frac.push(r.stack.readBigNumber());
        return { frac, shift: r.stack.readNumber() };
    }

    /**
     * D-99's weight table, in BIT ORDER (`SCORE_BITS` in `shared/opcodes.ts`),
     * then the three LEN/clamp terms. Published so a reader can recompute
     * `getScoreBreakdown(n).score` from `flags` without trusting this contract's
     * arithmetic — same reason `getFracTable` publishes FRAC.
     */
    async getScoreWeights(provider: ContractProvider) {
        const r = await provider.get('getScoreWeights', []);
        const points: number[] = [];
        // Every bit the score has — SCORE_BITS is the arity, not a literal, so
        // the reader cannot fall behind the contract's tuple the way a hardcoded
        // 38 did when N6 appended nine.
        for (let i = 0; i < SCORE_BITS.length; i++) points.push(r.stack.readNumber());
        return {
            points,
            LEN_REF: r.stack.readNumber(),
            LEN_W: r.stack.readNumber(),
            TZ_CAP: r.stack.readNumber(),
            SCORE_MAX: r.stack.readNumber(),
        };
    }

    /**
     * The deploy-fixed peer addresses — the only destinations value can reach
     * from here, and no message changes any of them. D-20 dropped
     * `collectionAddr` and `treasuryAddr`; D-32 brought `treasuryAddr` back for
     * the release forfeit, and D-90.2 deletes the release and the address with
     * it. Two addresses remain.
     *
     * `getReleaseTerms` is DELETED with the right it quoted (D-90.2).
     */
    async getMarketConfig(provider: ContractProvider) {
        const r = await provider.get('getMarketConfig', []);
        return {
            ledgerAddr: r.stack.readAddress(),
            ratchetAddr: r.stack.readAddress(),
        };
    }

    // D-20 DELETES `getBootstrapped` — there is no bootstrap step left to
    // report the status of.

    async getNpv(provider: ContractProvider, n: bigint) {
        return (await provider.get('getNpv', [{ type: 'int', value: n }])).stack.readBigNumber();
    }

    /**
     * `lotPremiumTotal` is the demand signal, and D-90 makes it the ONLY one:
     * premium is injected into the ratchet at close and can never walk back out.
     * `unforwardedPremium` is the honesty term — booked here but not yet accepted
     * by the ledger. `forceCancels` counts lots unwound by a ledger
     * `mark_rejected` race loss; it moved here from the deleted
     * `getEscrowAggregate`.
     */
    async getMarketStats(provider: ContractProvider) {
        const r = await provider.get('getMarketStats', []);
        return {
            openLots: r.stack.readNumber(),
            closedLots: r.stack.readNumber(),
            lotPremiumTotal: r.stack.readBigNumber(),
            unforwardedPremium: r.stack.readBigNumber(),
            headHint: r.stack.readBigNumber(),
            forceCancels: r.stack.readNumber(),
        };
    }

    /** §3.4: (balance, liability, delta). Liability = standing bids on open
     *  lots + premiums awaiting `SettleConfirmed` + `unforwardedPremium`. */
    async getSolvency(provider: ContractProvider) {
        const r = await provider.get('getSolvency', []);
        return {
            balance: r.stack.readBigNumber(),
            liability: r.stack.readBigNumber(),
            delta: r.stack.readBigNumber(),
        };
    }

    // D-20 DELETES `getGenesisStats` — the genesis-specific decay/floor
    // bootstrap it reported retired with `BootstrapGenesis`.
    //
    // D-90 DELETES `getTotalEscrow`, `getTotalPremium` and `getEscrowAggregate`:
    // a won lot mints at close, so there is no escrow pool to report.
}
