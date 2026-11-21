// ============================================================================
// INTEGER SQUARE ROOT — the shared copy (GAUNTLET.md B29).
//
// Newton, seeded from a bit-length halving so the iteration count is bounded by
// construction rather than by hope: the largest argument any caller passes is
// `5n^2 + 4` at n = AUCTIONABLE_MAX, ~9.2e27, which converges in under 60 steps.
//
// B29 found the four copies were NOT the same function. Three contracts had
// this one; primes_generators_collection.tolk had a naive Newton seeded from
// `n` itself, with no negative guard and no iteration bound -- same answer for
// every argument its caller passes, reached in ~128 halvings instead of ~60
// Newton steps. Unified here, with this one canonical because it is the version
// whose bound is an argument rather than an assumption.
//
// Written into the ledger and the market (the generators collection left with D-165, the registrar with D-202) by tools/sync-score-block.mjs; see the MR block above.
// ============================================================================
fun isqrt(x: int): int {
    if (x < 0) { return -1; }
    if (x < 2) { return x; }
    // seed: the smallest power of two whose square is >= x
    var g = 1;
    var t = x;
    while (t > 0) { t >>= 2; g <<= 1; }
    var r = g;
    var i = 0;
    while (i < 200) {
        val nr = (r + x / r) / 2;
        if (nr >= r) { return r; }
        r = nr;
        i += 1;
    }
    return r;
}
