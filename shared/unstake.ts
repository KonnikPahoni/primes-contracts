/**
 * §4.3.2's `unstake()` gate, mirrored from `handleUnstake` in
 * `contracts/contracts/primes_ratchet.tolk` so the keeper never sends a refused
 * exit and the webapp never calls a reserve "short" that no one can refill.
 *
 * The exit is sized at the ratchet's own cost basis, rounded UP so the refill
 * lands on the target and never a nano under it, and it is refused (227) when the
 * tranche is under `harvestDustTston` — `getStakingGates()`'s dust, the sim's
 * `staked_reserve.harvest_dust_tston`, not divided by any deploy divisor.
 */
export function unstakeTranche(s: {
  pending: bigint;
  reserveTarget: bigint;
  stakedCost: bigint;
  tstonHeld: bigint;
}): bigint {
  if (s.pending >= s.reserveTarget || s.stakedCost <= 0n || s.tstonHeld <= 0n) return 0n;
  let needTon = s.reserveTarget - s.pending;
  if (needTon > s.stakedCost) needTon = s.stakedCost;
  const tston = (needTon * s.tstonHeld + s.stakedCost - 1n) / s.stakedCost;
  return tston > s.tstonHeld ? s.tstonHeld : tston;
}

/** `unstake()` would pass its reserve and dust gates (227) on this state. */
export function unstakeCallable(
  s: Parameters<typeof unstakeTranche>[0],
  harvestDustTston: bigint
): boolean {
  const t = unstakeTranche(s);
  return t > 0n && t >= harvestDustTston;
}
