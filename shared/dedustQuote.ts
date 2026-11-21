/**
 * The swap quote — constant product, the pool's own fee, and the limit that goes on the wire.
 *
 * Every input is a get-method reading (`/market`: `get_reserves` for the two reserves,
 * `get_trade_fee` for the fee), so the figures the form prints are §9.1 numbers like every
 * other number in this app. Nothing here is a vendor's quote endpoint — DeDust's is
 * mainnet-only, which is the same reason `api.dedust.io` left the market card.
 *
 * ALL BIGINT, ON PURPOSE. `minOutRaw` goes on the wire as the swap's `limit`, and a limit
 * computed in floating point is a limit that can be one nanoton away from the number the
 * page showed. `priceImpact` is the one `number` here because it is drawn as a bar and
 * never signed.
 *
 * WHAT THE POOL DOES, in its own order: it takes its fee off the INPUT, then swaps what is
 * left against the reserves. So `out = reserveOut · inNet / (reserveIn + inNet)` with
 * `inNet = in − in·feeNum/feeDen`, and the price impact — the part of the move that is the
 * pool's curve rather than its fee — is `inNet / (reserveIn + inNet)`, which is that same
 * expression rearranged and needs no second reading to compute.
 *
 * ponytail: `Number` for the two display prices only. The wire numbers stay exact.
 *
 * Lives in `shared/` because two callers compute the SAME limit: the app's swap form and
 * `@ton-primes/agent`'s `swap()`. A second copy of a money formula is a second answer to
 * "what did the wallet actually sign".
 */
export type SwapSide = "buy" | "sell";

export interface PoolState {
  /** nanoTON in the pool (`get_reserves`). */
  reserveTonNanoton: bigint;
  /** nano-PRIMES in the pool (`get_reserves`). */
  reservePrimesNano: bigint;
  /** `get_trade_fee` as the pool published it. `null` = this venue cannot be quoted. */
  feeNum: bigint | null;
  feeDen: bigint | null;
}

export interface Quote {
  side: SwapSide;
  /** What the swapper sends, in the input asset's smallest unit. */
  amountInRaw: bigint;
  /** What the pool would pay out right now, before anyone else trades. */
  amountOutRaw: bigint;
  /** `limit` on the wire: `amountOutRaw` less the swapper's slippage tolerance. A fill
   *  under this is REFUSED by the pool and the input comes back (`payout#474f86cf`). */
  minOutRaw: bigint;
  /** The pool's cut, in the INPUT asset — which is where DeDust takes it. */
  feeRaw: bigint;
  /** 0..1. The share of the price move that is the curve, not the fee. */
  priceImpact: number;
  /** TON per PRIMES before the swap, and what this swap actually pays. */
  midPriceTon: number;
  execPriceTon: number;
}

/** 1%. Small enough to catch a real move, wide enough to survive one poll of staleness. */
export const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * `null` when there is nothing honest to say: an empty or unquotable pool, a
 * non-positive amount, or an amount so small the pool would pay out zero.
 */
export function quoteSwap(
  pool: PoolState,
  side: SwapSide,
  amountInRaw: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): Quote | null {
  const { reserveTonNanoton: ton, reservePrimesNano: primes, feeNum, feeDen } = pool;
  if (ton <= 0n || primes <= 0n) return null;
  if (feeNum === null || feeDen === null || feeDen <= 0n || feeNum < 0n || feeNum >= feeDen) return null;
  if (amountInRaw <= 0n) return null;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) return null;

  const [reserveIn, reserveOut] = side === "buy" ? [ton, primes] : [primes, ton];

  const feeRaw = (amountInRaw * feeNum) / feeDen;
  const inNet = amountInRaw - feeRaw;
  if (inNet <= 0n) return null;

  const amountOutRaw = (reserveOut * inNet) / (reserveIn + inNet);
  if (amountOutRaw <= 0n) return null;

  const minOutRaw = (amountOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
  if (minOutRaw <= 0n) return null;

  const midPriceTon = Number(ton) / Number(primes);
  // Always TON per PRIMES, whichever way the trade runs — the form compares it with the
  // spot above it and with `p_f`, and a price that flips its units between the two
  // directions would make that comparison a coin toss.
  const execPriceTon =
    side === "buy" ? Number(amountInRaw) / Number(amountOutRaw) : Number(amountOutRaw) / Number(amountInRaw);

  return {
    side,
    amountInRaw,
    amountOutRaw,
    minOutRaw,
    feeRaw,
    priceImpact: Number(inNet) / Number(reserveIn + inNet),
    midPriceTon,
    execPriceTon,
  };
}

// ===========================================================================
// THE FLOOR GUARD, SOLVED FOR THE AMOUNT — `flush()`'s venue-depth sizing.
// ===========================================================================
//
// `primes_ratchet.tolk`'s `flush()` sizes its tranche off `pending`
// (`min(pending, max(pending·FLUSH_PCT, FLUSH_MIN))`) and prices its guard off
// the POOL (`min_out = amount·S/T`). Nothing connected the two, so a tranche
// larger than the venue could absorb bounced against a guard that was working
// exactly as designed — the swap's AVERAGE execution price ran above `p_f`
// even while the SPOT price sat well below it.
//
// Measured, testnet, 2026-09-19: pool 1.2826 TON / 479,142 PRIMES, spot 2.677
// TON/1M PRIMES against a floor of 5.6875 — market a clear 2.1x below the
// floor — and a 19.733 TON tranche demanded 3,469,538 PRIMES from a pool whose
// ENTIRE PRIMES reserve was 479,142. Refused, correctly, and indistinguishable
// on the dashboard from "the market is above the floor".
//
// No fixed ratio fixes this. 1/10, 1/20 and 1/50 of that same `pending` all
// still bounce, 1/100 clears the curve but is then raised back to 5 TON by
// `FLUSH_MIN`, and whatever ratio is chosen breaks again as `pending` grows
// (the sim has it reaching 210,833 TON). The tranche has to be sized against
// the VENUE, which is what these two functions are for.
//
// `fillsAtFloor` is the predicate — the pool's arithmetic and the contract's,
// in the integer order each performs them, so it answers the question the
// chain will answer and not a floating-point approximation of it. It is what
// the app's flush brief draws its verdict from.
//
// `maxInAtFloor` is the closed form. From
//
//     out = R_p·a(1−f)/(R_t + a(1−f))  >=  a·(S/T)·(1+G)  =  min_out
//
// the `a` cancels on both sides — the curve is a price, and a price does not
// care how the trade is denominated — and it rearranges to
//
//     a_max = T·R_p / (S·(1+G))  −  R_t/(1−f)
//
// which is positive exactly when the market is below the floor net of the
// pool's fee. That is the property the whole exercise is for: BELOW THE FLOOR,
// SOME FLUSH ALWAYS FILLS, and this is its size.
//
// NOTHING HERE IS A NEW ECONOMIC PARAMETER (CLAUDE.md rule 3). `FLUSH_PCT`,
// `FLUSH_MIN` and `FLOOR_GUARD` are unchanged and still come from the sim;
// this is the mechanical consequence of the guard the sim already calibrated,
// solved for its own free variable. Every input is a get-method reading.

/** The contract's fixed-point scale (`primes_ratchet.tolk`'s `K_SCALE`). */
export const RATCHET_K_SCALE = 1_000_000_000n;

/**
 * `min_out` exactly as `primes_ratchet.tolk`'s `computeMinOut` computes it:
 * multiply first, divide once, then apply the premium to the quotient. Doing
 * it in the other order truncates to zero for every realistic flush, which is
 * why the contract's own comment insists on this order.
 *
 * `tCache`/`sCache` are the RATCHET's mirrors of `T` and `S`, pushed on every
 * `PoolInject` and readable with `getFloorCache()` — NOT the ledger's live
 * pair. Between mints the two differ, and it is the cache the guard prices
 * against, so a preview that reads the ledger is previewing a different guard.
 */
export function floorGuardMinOut(
  amountInNanoton: bigint,
  tCacheNanoton: bigint,
  sCacheNanoPrimes: bigint,
  floorGuardFixed: bigint = 0n,
): bigint {
  if (amountInNanoton <= 0n || tCacheNanoton <= 0n || sCacheNanoPrimes <= 0n) return 0n;
  const base = (amountInNanoton * sCacheNanoPrimes) / tCacheNanoton;
  return base + (base * floorGuardFixed) / RATCHET_K_SCALE;
}

/**
 * Would a flush of `amountInNanoton` clear the floor guard against this pool,
 * right now? The pool's constant product and the contract's `computeMinOut`,
 * both in integers, both truncating where the real thing truncates.
 *
 * `null` pool readings (an unquotable venue) answer `false`, not `true`: an
 * unknown venue is not a venue that fills.
 */
export function fillsAtFloor(
  pool: PoolState,
  amountInNanoton: bigint,
  tCacheNanoton: bigint,
  sCacheNanoPrimes: bigint,
  floorGuardFixed: bigint = 0n,
): boolean {
  const quote = quoteSwap(pool, "buy", amountInNanoton, 0);
  if (quote === null) return false;
  return quote.amountOutRaw >= floorGuardMinOut(amountInNanoton, tCacheNanoton, sCacheNanoPrimes, floorGuardFixed);
}

/**
 * The largest swap into this pool whose average execution price still clears
 * the floor guard — the closed form above, then corrected against
 * `fillsAtFloor` so the returned value satisfies the predicate exactly rather
 * than to within the two sides' truncation.
 *
 * The correction is a bounded back-off, not a search: the closed form is
 * derived from the same curve, so the integer answer is within a hair of it
 * and the loop exits on its first test in every case a test has found. It is
 * written anyway because "the largest amount for which `fillsAtFloor` is true"
 * is a promise a caller can lean on, and one that is checkable
 * (`shared/dedustQuote.test.ts`), where "approximately the largest" is not.
 *
 * `null` when the market is at or above the floor (net of the pool's fee) and
 * no flush of any size can fill — which is the guard doing its job, not an
 * error. The caller should say so rather than send a doomed swap.
 */
export function maxInAtFloor(
  pool: PoolState,
  tCacheNanoton: bigint,
  sCacheNanoPrimes: bigint,
  floorGuardFixed: bigint = 0n,
): bigint | null {
  const { reserveTonNanoton: rt, reservePrimesNano: rp, feeNum, feeDen } = pool;
  if (rt <= 0n || rp <= 0n) return null;
  if (feeNum === null || feeDen === null || feeDen <= 0n || feeNum < 0n || feeNum >= feeDen) return null;
  if (tCacheNanoton <= 0n || sCacheNanoPrimes <= 0n) return null;

  // a_max = T·R_p·K / (S·(K+G))  −  R_t·feeDen / (feeDen − feeNum)
  // First term floored, second term CEILED: both roundings shrink `a_max`, so
  // the closed form errs on the side the guard is on.
  const numer = tCacheNanoton * rp * RATCHET_K_SCALE;
  const denom = sCacheNanoPrimes * (RATCHET_K_SCALE + floorGuardFixed);
  const ceiling = numer / denom;
  const feeAdjusted = (rt * feeDen + (feeDen - feeNum) - 1n) / (feeDen - feeNum);
  let amount = ceiling - feeAdjusted;
  if (amount <= 0n) return null;

  // The truncation correction. `S/T` nano-PRIMES per nanoton is ~1e5 in any
  // live configuration, so one nanoton of back-off is worth ~1e5 nano-PRIMES
  // of `min_out` — orders of magnitude more than the single nano-unit either
  // floor can cost us. Stepping by a millionth keeps the loop O(1) even if a
  // degenerate pool ever made the curve flat here.
  const step = amount / 1_000_000n > 0n ? amount / 1_000_000n : 1n;
  for (let i = 0; i < 64 && amount > 0n; i++) {
    if (fillsAtFloor(pool, amount, tCacheNanoton, sCacheNanoPrimes, floorGuardFixed)) return amount;
    amount -= step;
  }
  return null;
}

/**
 * `maxInAtFloor` INVERTED — the venue depth a tranche of `trancheNanoton` needs.
 *
 * GAUNTLET.md G38. `maxInAtFloor` answers "how much can I flush into this pool"; a seeder
 * has the opposite question, "how deep must this pool be before a full-size flush fills",
 * and until now nothing in the repo could answer it. `contracts/scripts/seedDedustLiquidity.ts`
 * is the lever and this is the figure it aims at.
 *
 * THE MARKET'S DISTANCE FROM THE FLOOR IS AN INPUT, NOT A CONSTANT, and it has to be,
 * because `a_max` is a function of the SPOT price and the spot moves with every trade. The
 * caller says how far below `p_f` the market is assumed to sit — `marketOverFloorBps`, where
 * 10,000 is exactly at the floor — and gets the reserves that make the tranche fill AT THAT
 * DISTANCE. There is no single "deep enough": a pool that serves a 5 TON flush at half the
 * floor is nowhere near serving one at 90% of it.
 *
 * Substituting `R_t = d·p_f·R_p` into
 *
 *     a_max = T·R_p·K/(S·(K+G)) − R_t·feeDen/(feeDen−feeNum)
 *
 * makes `R_p` the only unknown, because `a_max` is LINEAR in depth at a fixed ratio:
 *
 *     R_p = tranche · S·(K+G)·BPS·(feeDen−feeNum)
 *           ────────────────────────────────────────────────────
 *           T · [ K·BPS·(feeDen−feeNum) − (K+G)·d_bps·feeDen ]
 *
 * **`null` when that bracket is non-positive, and the most important case is `d = 1`.** A
 * pool opened exactly AT the floor can never be flushed into at any depth whatsoever: the
 * pool takes its fee off the input, so the average execution price of a buy starting at
 * `p_f` is above `p_f` before the curve is even consulted. That is the guard doing its job
 * (§4.3.1 buys a market BELOW the floor, and at the floor there is nothing to buy), and it
 * is why `D-140`'s `market_over_floor_at_open = 1.0` is not a depth that can be fixed by
 * seeding more. A seeder reads this function at the discount they expect the market to
 * reach, not at the one they open it at.
 *
 * Returns the reserves as a PAIR, because both halves are the operator's own capital and
 * the TON side is the one that is usually binding.
 */
export function minReservesForTranche(
  trancheNanoton: bigint,
  marketOverFloorBps: bigint,
  tCacheNanoton: bigint,
  sCacheNanoPrimes: bigint,
  feeNum: bigint,
  feeDen: bigint,
  floorGuardFixed: bigint = 0n,
): { reservePrimesNano: bigint; reserveTonNanoton: bigint } | null {
  if (trancheNanoton <= 0n) return null;
  if (marketOverFloorBps <= 0n) return null;
  if (tCacheNanoton <= 0n || sCacheNanoPrimes <= 0n) return null;
  if (feeDen <= 0n || feeNum < 0n || feeNum >= feeDen) return null;

  const BPS = 10_000n;
  const k = RATCHET_K_SCALE;
  const kg = k + floorGuardFixed;
  const net = feeDen - feeNum;

  // The bracket. Non-positive means no depth fills at this distance from the floor.
  const bracket = k * BPS * net - kg * marketOverFloorBps * feeDen;
  if (bracket <= 0n) return null;

  // Ceiled: a depth rounded DOWN is a depth that does not quite fill.
  const numer = trancheNanoton * sCacheNanoPrimes * kg * BPS * net;
  const denom = tCacheNanoton * bracket;
  let rp = (numer + denom - 1n) / denom;
  if (rp <= 0n) return null;

  // `R_t = d·p_f·R_p`, FLOORED — a smaller TON side is a cheaper market, so both roundings
  // push the answer to the side that fills.
  const rtOf = (primes: bigint) => (marketOverFloorBps * tCacheNanoton * primes) / (BPS * sCacheNanoPrimes);

  // The truncation correction, the same bounded back-off `maxInAtFloor` uses and for the
  // same reason: the closed form is derived from the same curve, so the integer answer is
  // within a hair of it, but "these reserves DO serve that tranche" is a promise a seeder
  // leans on and one that `dedustQuote.test.ts` checks directly.
  const step = rp / 1_000_000n > 0n ? rp / 1_000_000n : 1n;
  for (let i = 0; i < 64; i++) {
    const rt = rtOf(rp);
    if (rt > 0n) {
      const pool: PoolState = {
        reserveTonNanoton: rt,
        reservePrimesNano: rp,
        feeNum,
        feeDen,
      };
      const edge = maxInAtFloor(pool, tCacheNanoton, sCacheNanoPrimes, floorGuardFixed);
      if (edge !== null && edge >= trancheNanoton) return { reservePrimesNano: rp, reserveTonNanoton: rt };
    }
    rp += step;
  }
  return null;
}

/**
 * The haircut every caller takes off `maxInAtFloor` before putting a number on
 * the wire. `maxInAtFloor` is the edge — the amount whose average execution
 * price lands ON the floor — and the edge is exactly where one unrelated trade
 * landing in the same block turns a fill into a refusal. 2% is the width of
 * that block, not an economic parameter: it buys back the difference between
 * the reserves we read and the reserves the swap meets.
 *
 * Applied by the CALLER rather than folded into `maxInAtFloor`, because
 * shrinking the amount can only make `fillsAtFloor` more true — the exec price
 * falls monotonically as the trade gets smaller — so the function keeps its
 * exact promise and each caller keeps its own tolerance.
 */
export const FLOOR_SIZING_HAIRCUT_BPS = 200n;

/** `maxInAtFloor` less `FLOOR_SIZING_HAIRCUT_BPS`. Null propagates: no fillable size. */
export function maxInAtFloorWithHaircut(
  pool: PoolState,
  tCacheNanoton: bigint,
  sCacheNanoPrimes: bigint,
  floorGuardFixed: bigint = 0n,
): bigint | null {
  const edge = maxInAtFloor(pool, tCacheNanoton, sCacheNanoPrimes, floorGuardFixed);
  if (edge === null) return null;
  const cut = (edge * (10_000n - FLOOR_SIZING_HAIRCUT_BPS)) / 10_000n;
  return cut > 0n ? cut : null;
}
