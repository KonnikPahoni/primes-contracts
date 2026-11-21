/**
 * The mint price and the fee margin — one definition, shared by the webapp, the
 * contract wrappers and any headless client (`AGENTS_PLAN.md` A1, D-131.3).
 *
 * `MINT_VALUE_NANOTON` is CONCEPT.md §4's flat all-in 1 TON, read from `params.json`
 * (CLAUDE.md rule 3) and converted EXACTLY: TON has 9 decimals, so a parameter with more
 * precision cannot be sent on chain and is a parameter error, not something to round.
 *
 * `FEE_MARGIN_NANOTON`: the ledger asserts `in.valueCoins >= MINT_PRICE`, where
 * `in.valueCoins` is what arrives AFTER TON deducts the message's own forward fee —
 * sending exactly the nominal amount undershoots that check and the message reverts
 * (throw 103, confirmed live on testnet). Headroom is not refunded on a successful mint,
 * so this stays a small fixed margin.
 *
 * No `@ton/core` dependency, on purpose: the webapp's always-visible mint button reads
 * these eagerly (GAUNTLET.md S9a) and must not drag the cell builders into its chunk.
 */
import params from "./params.json";

export const NANOTON_PER_TON = 1_000_000_000n;

/**
 * Integer floor square root, `⌊√v⌋` (Newton's method).
 *
 * §3.2's `s`, the per-factor weight term: the mint body submits it and
 * `primes_ledger.tolk` verifies it with two multiplies (`s² ≤ p < (s+1)²`) rather than
 * computing a root on chain. It lives HERE rather than beside the factor codec in
 * `factors.ts` for this file's own stated reason — `factors.ts` imports `@ton/core` for
 * the dictionary serializer, and the webapp needs the same `s` to weight the tribute line
 * on surfaces that must not drag the cell builders into their chunk (GAUNTLET.md S9a).
 * `factors.ts` re-exports it, so there is still one definition and one import path for
 * everything that was already using it.
 */
export function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x0 = v;
  let x1 = (x0 + v / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + v / x0) >> 1n;
  }
  return x0;
}

/** `params.mint.mint_price_ton` — CONCEPT.md §4's flat all-in mint price, in TON. */
export const MINT_PRICE_TON: number = params.mint.mint_price_ton;

export function paramTonToNanoton(ton: number, key: string): bigint {
  const scaled = ton * Number(NANOTON_PER_TON);
  const rounded = Math.round(scaled);
  if (!Number.isFinite(scaled) || Math.abs(scaled - rounded) > 1e-6) {
    throw new Error(`${key} = ${ton} TON is not representable in nanoton (9 decimals)`);
  }
  return BigInt(rounded);
}

export const MINT_PRICE_NANOTON: bigint = paramTonToNanoton(MINT_PRICE_TON, "params.mint.mint_price_ton");
export const MINT_VALUE_NANOTON = MINT_PRICE_NANOTON;
export const FEE_MARGIN_NANOTON = 10000000n; // 0.01 TON

/**
 * GAUNTLET X3 — what a storage top-up is worth, and why it is this figure and not a
 * round number somebody liked.
 *
 * `primes_ledger.tolk`'s `ITEM_DEPLOY_VALUE` is the endowment the mint sends an item, once,
 * and it is the whole of a composite's rent: only primes are ever cited as tribute factors,
 * so no `credit_tribute` tops a composite up again. That endowment is what buys the ~9-year
 * runway `getStorageRunway()` reports — so sending the SAME amount again buys another one of
 * whatever the first bought, at whatever config-18 charges on the day. That is the property
 * that makes it the honest unit for a top-up control: it is a length of time expressed in the
 * only currency the chain takes, and it needs no second get-method to explain.
 *
 * NOT from `params.json`, and the distinction matters under CLAUDE.md rule 3: this is a GAS
 * constant, not a simulated economic parameter. Nothing in `sim/` models it, and its
 * authority is the contract line it mirrors — which is why that line is cited here and any
 * change to it has to move both.
 *
 * Mirrors `primes_ledger.tolk`'s `ITEM_DEPLOY_VALUE`, pinned by `SimCrossCheck.spec.ts`'s constant sweep.
 */
export const ITEM_DEPLOY_VALUE_NANOTON = 25000000n; // 0.025 TON
