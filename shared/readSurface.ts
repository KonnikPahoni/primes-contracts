/**
 * Quantisation shared by every reader of `getK(n, t)`.
 *
 * `t` is part of the read-proxy's cache key (`ledger:k:{n}:{t}`), so an unquantised
 * per-second `t` would miss the cache on every tick and spend the upstream budget
 * `ops/rate-limit-budget.md` allocates for the whole dashboard. One bucket per 30s keeps the
 * key stable between samples; the on-screen elapsed clock still ticks per second.
 *
 * WHY IT IS IN `shared/` RATHER THAN IN EITHER CONSUMER. FASTLOAD_PLAN.md §1 has the
 * read-proxy compute `k` server-side for `GET /bootstrap`, so that a cold page load does not
 * have to resolve the head before it may even ask for `k`. That only removes the waterfall if
 * the `t` the server resolved is the same `t` the browser's first render asks for — the
 * pre-seeded React Query key must be the key `useK` looks up. Two copies of "30" in two
 * packages is a silent failure mode: they drift, every seeded `k` misses, and the bootstrap
 * still *looks* like it works because the fallback poll quietly covers it. One definition,
 * both ends.
 *
 * This is not an economic parameter (CLAUDE.md rule 3): it changes no payout and appears in
 * no contract. It is the granularity at which the read surface samples a curve the contract
 * computes.
 */
export const K_QUERY_BUCKET_SECONDS = 30;

/** Floors `seconds` to the bucket. Non-finite and negative elapsed times collapse to 0 —
 *  `getK(n, 0)` is `k_min`, the value the clock has in the instant after a mint, which is the
 *  only honest answer when the elapsed time is not known to be positive. */
export function bucketElapsed(seconds: number, bucket: number = K_QUERY_BUCKET_SECONDS): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds / bucket) * bucket;
}
