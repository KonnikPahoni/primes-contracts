/**
 * The webapp's view of `shared/messages.ts` — every cell builder the app sends is defined
 * THERE, once, and shared with the contract wrappers and headless clients (A1, D-131.3).
 * This file keeps the `@/chain/messages` import path the twenty call sites use and adds
 * the one helper that needs the app's read-proxy client.
 */
export * from "@ton-primes/shared/messages";
// Kept explicit for `contracts/tests/FactorCrossCheck.spec.ts`, which reads this file to
// prove the body a player signs carries `shared/factors.ts`'s dictionary and no other.
export { isqrt, encodeFactors, type FactorEntry } from "@ton-primes/shared/factors";
import { fetchJson, READ_PROXY_URL } from "@/api/client";

// GAUNTLET.md S9a: these two live in modules with no @ton/core dependency so eager call
// sites can import them without dragging the builders along; re-exported here for the
// call sites that still take them from this path.
export { resolveTonNetwork, type TonNetwork } from "@/chain/network";
import { resolveTonNetwork } from "@/chain/network";
import type { TonNetwork } from "@/chain/network";

/** `getItemAddress(n)` via read-proxy's `/item/{n}/address` (GAUNTLET.md P3.G2). */
export async function resolveItemAddress(
  _ledgerAddress: string,
  n: bigint,
  _network: TonNetwork = resolveTonNetwork()
): Promise<string> {
  const { address } = await fetchJson<{ address: string }>(READ_PROXY_URL, `/item/${n}/address`);
  return address;
}
