// ============================================================================
// DETERMINISTIC MILLER-RABIN — the shared copy (GAUNTLET.md B29).
//
// CONCEPT.md §3.1's primality claim is reached from an ordinary player
// transaction on TWO contracts: the ledger (a prime mint) and the market (an
// off-head prime lot settling). (The generators collection was a third until
// D-165, and the registrar until D-202 deleted the constellation builds it
// classified.) Neither may call the other synchronously to agree, so the
// algorithm is duplicated on purpose -- exactly like D-99's score block, and for
// the same reason.
//
// What was NOT on purpose is that the copies had drifted. This file is
// written into both between the PRIME MR markers by
// tools/sync-score-block.mjs, and `pnpm check:score-block` (a leg of
// gate:contracts:drift) fails if any copy no longer matches.
//
// 13 deterministic bases {2..41}, exact for n < 3.317e24 (§3.1). Tolk's native
// 257-bit integers, no split precision.
// ============================================================================
fun modpow(base: int, exp: int, mod: int): int {
    var result = 1;
    var b = base % mod;
    var e = exp;
    while (e > 0) {
        if (e % 2 == 1) { result = (result * b) % mod; }
        e = e / 2;
        b = (b * b) % mod;
    }
    return result;
}

fun millerTest(a: int, d: int, r: int, n: int): bool {
    var x = modpow(a, d, n);
    if (x == 1 || x == n - 1) { return true; }
    var i = 0;
    while (i < r - 1) {
        x = (x * x) % n;
        if (x == n - 1) { return true; }
        i += 1;
    }
    return false;
}

fun isPrimeMR(n: int): bool {
    if (n < 2) { return false; }
    if (n == 2 || n == 3) { return true; }
    if (n % 2 == 0) { return false; }
    var d = n - 1;
    var r = 0;
    while (d % 2 == 0) { d = d / 2; r += 1; }
    // The witness set is unchanged: the first 13 primes, deterministic for every
    // n < 3.3e24. It used to live in `mrBaseAt`, a 13-arm if-chain walked once
    // per base — 13 chain walks per call, ~7.4k gas on the omega=3 mint path for
    // nothing but picking a constant. A tuple literal is built once and indexed
    // in O(1), and it is the same idiom `log10Fp` already uses for its log table.
    val bases = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41];
    var i = 0;
    while (i < 13) {
        val a = bases.get(i);
        // The bases ascend, so the first `a >= n` means every remaining base is
        // >= n too. The old loop kept spinning and skipping them via `if (a < n)`;
        // returning here tests exactly the same set of witnesses.
        if (a >= n) { return true; }
        if (!millerTest(a, d, r, n)) { return false; }
        i += 1;
        // GAUNTLET V34: the first seven bases {2..17} are already exact below
        // ψ₇ = 341,550,071,728,321 (Jaeschke 1993). Every argument the market
        // and the ledger's auction path reach is below it (the largest is
        // ~2n+1 ≈ 8.6e13 at AUCTIONABLE_MAX), and the six bases skipped are what
        // pushed a cap prime's open past config 21's 1,000,000-gas ceiling.
        // Above ψ₇ all 13 still run.
        if (i == 7 && n < 341550071728321) { return true; }
    }
    return true;
}
