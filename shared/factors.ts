/**
 * TON PRIMES — §3.2's factor dictionary, defined once.
 *
 * Same single-source-of-truth argument as `voucher.ts` and `invites.ts`, and it
 * is the sharpest case of the three: this is the proof a player submits to mint
 * a COMPOSITE for 1 GRAM. `primes_ledger.tolk:2078` parses it as
 *
 *     struct FactorEntry { primeNumber: uint256; exponent: uint8; s: uint128 }
 *
 * keyed `map<uint8, FactorEntry>`, and verifies the submitted `s = ⌊√p⌋` with two
 * multiplies (`s² ≤ p < (s+1)²`) so the contract never computes a square root.
 *
 * Two separate pieces of software build that dictionary: the test/deploy harness
 * (`contracts/wrappers/PrimesLedger.ts`, and `PrimesMarket.ts` through it) and the
 * webapp that attaches it to the mint body the player signs. If they ever disagree
 * the failure mode is not a crash and not a caught test: the sandbox proves the
 * WRAPPER's bytes while the player spends 1 GRAM through the WEBAPP's, so a drifted
 * field width or key order ships green and reverts a real mint on chain.
 *
 * So the codec is built HERE, once, and both importers use it. The wrapper
 * re-exports it rather than re-writing it — `contracts/tests/FactorCrossCheck.spec.ts`
 * fails if a second transcription reappears.
 */

import { beginCell, Dictionary, type Builder, type Cell, type DictionaryValue } from '@ton/core';
import { isqrt } from './values';

/**
 * §3.2: `s = ⌊√p⌋`, submitted per factor and verified on-chain with two
 * multiplies. Optional here — the codec computes it when omitted, so existing
 * call sites keep working while the wire always carries an explicit s. An
 * explicitly WRONG `s` is encoded verbatim: the contract's rejection of it is a
 * tested behaviour, so this codec must never "correct" a caller.
 */
export type FactorEntry = { prime: bigint; exponent: number; s?: bigint };

/**
 * Integer floor square root — the reference for the submitted s. DEFINED in `values.ts`
 * (which has no `@ton/core` dependency, on purpose) and re-exported here so the import
 * path every existing caller uses is unchanged: the webapp weights the tribute line by
 * the same `s` on surfaces that must not pull the cell builders into their chunk.
 */
export { isqrt };

/**
 * The value layout, byte for byte as `primes_ledger.tolk` parses it:
 * `storeUint(prime, 256).storeUint(exponent, 8).storeUint(s, 128)`.
 */
export const FactorValue: DictionaryValue<FactorEntry> = {
  serialize(src: FactorEntry, builder: Builder) {
    builder.storeUint(src.prime, 256).storeUint(src.exponent, 8).storeUint(src.s ?? isqrt(src.prime), 128);
  },
  parse(slice) {
    return { prime: slice.loadUintBig(256), exponent: slice.loadUint(8), s: slice.loadUintBig(128) };
  },
};

/** 8-bit uint keys in insertion order 0, 1, 2, … — the order the contract walks. */
export function encodeFactors(factors: FactorEntry[]): Dictionary<number, FactorEntry> {
  const dict = Dictionary.empty(Dictionary.Keys.Uint(8), FactorValue);
  factors.forEach((f, i) => dict.set(i, f));
  return dict;
}

/**
 * The factor list as a get-method argument: `getLotPriceFrom(n, factors)` and
 * `getScoreBreakdownFrom` take the dictionary as a bare cell, and an EMPTY list as
 * `null` (no dictionary) — which is exactly the from-`n` quote. One builder so the
 * wrapper, the read-proxy and the agent SDK cannot quote a composite differently.
 */
export function factorsCell(factors: FactorEntry[]): Cell | null {
  return factors.length === 0 ? null : beginCell().storeDictDirect(encodeFactors(factors)).endCell();
}
