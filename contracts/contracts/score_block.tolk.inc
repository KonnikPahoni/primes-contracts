// ---------------------------------------------------------------------------
// D-99 — ONE ADDITIVE SCORE PRICES EVERY NUMBER.
//
// Spec: PRICING_MODEL_PLAN.md §1.1/§1.3, CONCEPT.md §9.6. `scoreOf(n)` returns
// `(score, flags)` — the clamped sum of the weights of every category `n`
// belongs to, and the bitmask of those categories.
//
// THIS BLOCK IS DUPLICATED BYTE-FOR-BYTE into `primes_market.tolk` (which
// prices a lot off `score`) and `primes_ledger.tolk` (which pays the bounty
// vault's per-point rebate off it), for the reason the tier block it replaces
// was duplicated: a settled lot's price and the ledger's rebate must agree
// without either contract calling the other synchronously. The canonical copy
// is `contracts/contracts/score_block.tolk.inc`; `node tools/sync-score-block.mjs`
// writes it into both files between the BEGIN/END markers and `--check` fails
// if either has drifted. `SpecialNumbers.spec.ts` additionally asserts the two
// deployed copies answer identically over a sweep of `n`.
//
// WHAT REPLACES WHAT. `desirabilityScore` (a 0..120 four-layer score in which
// primality weighed 0), `specialNumberTier` / `SPECIAL_TIER_*`,
// `specialPriceMaxOf` / `specialPriceMinOf`, `PRIME_P0_MIN`, `isCuratedYear`
// and `isCuratedNumber` are all deleted. `isCuratedConstantOrTaxicab` survives
// as POSITION bit 32. D-96's `DIRICHLET_*` constants survive as the PRIME
// REBATE FAMILY only (§1.5) — they score no points, set no bit and lift no
// price.
//
// THE FACTOR CATEGORIES (bits 33..38 from phase 3, N6's bit 39, D-162's 48..51).
// Five of the six proposed categories are computable from the factor list a
// composite ALREADY submits at `open_lot` and at head mint; the sixth
// (Ruth-Aaron) needs the neighbour's factorization and is out of scope, as §4
// itself says. They exist for owner answer 6 — "a number with no category at
// all should be rare" — and they are the only part of the score `n` alone
// cannot decide, which is why `scoreOfFrom(n, factors)` is a SECOND entry
// point and not a change to `scoreOf(n)`. N6 appended a seventh at bit 39,
// `carmichael`: Korselt's criterion needs every prime factor, so it belongs to
// this group in everything but its number.
//
// `scoreOf(n)` IS STILL EXACT ABOUT WHAT IT KNOWS AND IS A LOWER BOUND ON THE
// PRICE. It returns the from-`n` score with bits 33..39 and 48..51 clear. That is not a
// rounding error to be papered over in the UI: a caller holding the
// factorization gets a strictly larger score from `scoreOfFrom`, and the two
// answers differ by construction rather than by drift. `getScoreBreakdown` and
// `getLotPrice` take the factors as an argument so a reader can obtain either
// one deliberately.
//
// ABUNDANT AND DEFICIENT PARTITION EVERY NON-PERFECT NUMBER, so this pair adds
// one point to essentially every composite priced with its factors — a
// near-constant offset, not a discriminator. That is deliberate under answer 6
// (it is the "density filler" §4 names itself), and it is stated here because
// a reader comparing a factored price against an unfactored one will see the
// point and should see why. Perfect numbers earn neither: they already carry
// `BIT_PERFECT` at 40.
//
// THE CAP IS THE CEILING. `SCORE_MAX = 87` because
// `MINT_PRICE · 2^(87/10) = 415.87 GRAM` — the highest price this game can ask
// for anything, and it lands just under owner answer 9's 420 GRAM ceiling. (The
// plan's §1.1 says 420.4; that is 2^8.716, and the arithmetic is wrong. The
// conclusion is not: 87 is the largest clamp whose ladder stays under 420, and
// 88 would reach 445.7.) There is no other ceiling anywhere — the same
// one-clamp-over-the-sum discipline §5 gives `K_CEIL`.
// ---------------------------------------------------------------------------

const SCORE_MAX: int = 87;

// ---- LEN: continuous, no bit, no satellite (§8.3) ----
const LEN_REF: int = 9;               // scarcity decays to zero at 9 digits
const LEN_W: int = 2;                 // points per digit under LEN_REF

// ---- category bits. Mirrored in `shared/opcodes.ts` SCORE_BITS and, through
// it, in the webapp's fixed satellite angles (§8.2: angle = 7.5° · bit), so a
// bit number is a PERMANENT identifier — never renumber one, only append. ----
const BIT_REPDIGIT: int = 0;
const BIT_POW10: int = 1;
const BIT_PALINDROME: int = 2;
const BIT_RUN: int = 3;
const BIT_ABAB: int = 4;
const BIT_TRAILING_ZEROS: int = 5;
const BIT_YYYYMMDD: int = 6;
const BIT_DMY8: int = 7;
const BIT_YEAR: int = 8;
const BIT_YYMMDD: int = 9;
const BIT_MMDD: int = 10;
const BIT_MERSENNE: int = 11;
const BIT_FERMAT: int = 12;
const BIT_PERFECT: int = 13;
const BIT_PRIMORIAL: int = 14;
const BIT_FACTORIAL: int = 15;
const BIT_PRIME: int = 16;
const BIT_POW2: int = 17;
const BIT_FIBONACCI: int = 18;
const BIT_CUBE: int = 19;
const BIT_TWIN: int = 20;
const BIT_SOPHIE_GERMAIN: int = 21;
const BIT_SAFE_PRIME: int = 22;
const BIT_EMIRP: int = 23;
const BIT_SQUARE: int = 24;
const BIT_TRIANGULAR: int = 25;
const BIT_HARSHAD: int = 26;
const BIT_HAPPY: int = 27;
const BIT_DIGITSUM_PRIME: int = 28;
const BIT_ICONIC: int = 29;
const BIT_LISTED: int = 30;
const BIT_LANDMARK: int = 31;
const BIT_CONSTANT: int = 32;

// ---- FACTOR bits (§4). Set only by `scoreOfFrom`, never by `scoreOf`. ----
const BIT_SEMIPRIME: int = 33;
const BIT_PRIME_POWER: int = 34;
const BIT_SQUAREFREE: int = 35;
const BIT_SMOOTH: int = 36;
const BIT_ABUNDANT: int = 37;
const BIT_DEFICIENT: int = 38;

// ---- N6's nine, filling 39..47 — the last nine of the original 48-slot
// ring (D-162 below re-pitched it to 54). Composite-first by design: `shared/prime_tags.json` already names 78
// prime families, and the core loop mints COMPOSITES, which had no taxonomy of
// their own. Only `carmichael` needs the factor list; the other eight are
// decided from `n` alone and therefore run on the mint path. ----
const BIT_CARMICHAEL: int = 39;
const BIT_PANDIGITAL: int = 40;
const BIT_NARCISSISTIC: int = 41;
const BIT_AUTOMORPHIC: int = 42;
const BIT_SQUARE_TRIANGULAR: int = 43;
const BIT_KAPREKAR: int = 44;
const BIT_HIGHLY_COMPOSITE: int = 45;
const BIT_KEITH: int = 46;
const BIT_CATALAN: int = 47;

// ---- D-162's six, 48..53 (numbersaplenty.com's families, picked for being
// cheap on chain). The ring re-pitched from 48 slots at 7.5° to 54 at 6.67°,
// so every angle moved once — pre-launch, nothing minted wears one yet.
// SMITH, SPHENIC, POWERFUL and ACHILLES need the factor list, which puts them
// with 33..39: set only by `scoreOfFrom`, so they cost the head mint nothing.
// LUCAS and PRONIC are decided from `n` and ride square roots the from-`n`
// walk already takes (see `fibLucasOf` and the SQUARE line). ----
const BIT_SMITH: int = 48;
const BIT_SPHENIC: int = 49;
const BIT_POWERFUL: int = 50;
const BIT_ACHILLES: int = 51;
const BIT_LUCAS: int = 52;
const BIT_PRONIC: int = 53;

// ---- the weight table (§1.3). OWNER-DECLARED, not sim-derived: it is the
// game designer's demand guess, signed as D-99, and it lives in
// `shared/params.json` under `_provenance: "owner-declared (D-99)"` exactly
// as the tier prices it replaces did. 10 points = 2× price. ----
const W_REPDIGIT: int = 40;
const W_POW10: int = 40;
const W_PALINDROME: int = 25;
const W_RUN: int = 25;
const W_ABAB: int = 12;
const W_TRAILING_ZEROS: int = 8;      // PER zero, capped at TZ_CAP zeros
const TZ_CAP: int = 3;
const W_YYYYMMDD: int = 30;
const W_DMY8: int = 25;
const W_YEAR: int = 25;
const W_YYMMDD: int = 12;
const W_MMDD: int = 5;
const W_MERSENNE: int = 40;
const W_FERMAT: int = 40;
const W_PERFECT: int = 40;
const W_PRIMORIAL: int = 30;
const W_FACTORIAL: int = 25;
const W_PRIME: int = 15;
const W_POW2: int = 15;
const W_FIBONACCI: int = 15;
const W_CUBE: int = 8;
const W_TWIN: int = 6;
const W_SOPHIE_GERMAIN: int = 6;
const W_SAFE_PRIME: int = 6;
const W_EMIRP: int = 5;
const W_SQUARE: int = 4;
const W_TRIANGULAR: int = 2;
const W_HARSHAD: int = 2;
const W_HAPPY: int = 2;
const W_DIGITSUM_PRIME: int = 2;
const W_ICONIC: int = 30;
const W_LISTED: int = 20;
const W_LANDMARK: int = 30;
const W_CONSTANT: int = 20;

// ---- FACTOR weights (§4's table, owner-declared with the rest of §1.3) ----
const W_SEMIPRIME: int = 3;
const W_PRIME_POWER: int = 5;
const W_SQUAREFREE: int = 2;
const W_SMOOTH: int = 3;
const W_ABUNDANT: int = 1;
const W_DEFICIENT: int = 1;

// ---- N6 weights (owner-declared with the rest of §1.3, D-99's scale:
// 10 points = 2x price) ----
const W_CARMICHAEL: int = 30;
const W_PANDIGITAL: int = 40;
const W_NARCISSISTIC: int = 30;
const W_AUTOMORPHIC: int = 25;
const W_SQUARE_TRIANGULAR: int = 25;
const W_KAPREKAR: int = 20;
const W_HIGHLY_COMPOSITE: int = 20;
const W_KEITH: int = 20;
const W_CATALAN: int = 15;

// ---- D-162 weights (owner-declared, same scale). Density sets them: LUCAS
// is as rare as Fibonacci; PRONIC (~√n members) sits between triangular and
// square; POWERFUL (~2.2√n) with square; ACHILLES (powerful minus the perfect
// powers) above it; SMITH (~4% of composites) with harshad's neighbours;
// SPHENIC (~15%) with squarefree. ----
const W_SMITH: int = 3;
const W_SPHENIC: int = 2;
const W_POWERFUL: int = 4;
const W_ACHILLES: int = 6;
const W_LUCAS: int = 15;
const W_PRONIC: int = 3;

// "smooth" is 7-smooth: every prime factor <= 7. §4 fixes the bound at 7 and
// it is not a tuning knob — 7-smooth is the standard humming-distance the
// table means, and moving it would change which numbers are special without
// changing anything a reader can check.
const SMOOTH_BOUND: int = 7;

const YEAR_LO: int = 1900;
const YEAR_HI: int = 2100;

// D-96's two constants, and the only two the family has. Both are OWNER-
// DECLARED. D-99 NARROWS D-96: the `dirichlet_primes` class is now the PRIME
// REBATE FAMILY and nothing else — it scores no points, sets no bit, lifts no
// price and wears no badge. It survives for the reason D-96 gave (a rebate
// that keeps paying along the whole line, never exhausted, 1 in 100 primes at
// every depth by Dirichlet's theorem) and for that reason only. §1.5.
const DIRICHLET_MIN_N: int = 100000;
const DIRICHLET_MOD: int = 101;

// ---------------------------------------------------------------------------
// Integer roots. Tolk has no native sqrt/cbrt, and the FORM group needs both
// exactly (a "nearly square" is not a square). Newton, seeded from a
// bit-length halving so the iteration count is bounded by construction: the
// largest argument any caller passes is `5n² + 4` at n = AUCTIONABLE_MAX,
// ≈ 9.2·10²⁷, which converges in under 60 steps from the seed below.
// ---------------------------------------------------------------------------

fun isPerfectSquare(x: int): bool {
    if (x < 0) { return false; }
    val r = isqrt(x);
    return r * r == x;
}

fun isPerfectCube(x: int): bool {
    if (x < 1) { return false; }
    if (x < 8) { return x == 1; }
    var r = 1;
    var t = x;
    while (t > 0) { t >>= 3; r <<= 1; }
    var i = 0;
    var settled = false;
    while (i < 200 && !settled) {
        val rr = r * r;
        val nr = (2 * r + x / rr) / 3;
        if (nr >= r) { settled = true; } else { r = nr; }
        i += 1;
    }
    // Newton lands on floor(cbrt) or one either side; check the neighbourhood.
    var c = r - 1;
    while (c <= r + 1) {
        if (c > 0 && c * c * c == x) { return true; }
        c += 1;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Calendar validity (§1.3, owner answer 11). REAL Gregorian validity — month
// 1..12, day 1..days-in-month, the 4/100/400 leap rule — because a birthday
// that never happened must not be priced as one.
// ---------------------------------------------------------------------------

fun daysInMonth(y: int, m: int): int {
    if (m == 1 || m == 3 || m == 5 || m == 7 || m == 8 || m == 10 || m == 12) { return 31; }
    if (m == 4 || m == 6 || m == 9 || m == 11) { return 30; }
    if (m != 2) { return 0; }
    val leap = (y % 4 == 0) && ((y % 100 != 0) || (y % 400 == 0));
    return leap ? 29 : 28;
}

fun isValidDate(y: int, m: int, dd: int): bool {
    if (m < 1 || m > 12) { return false; }
    if (dd < 1) { return false; }
    return dd <= daysInMonth(y, m);
}

// ---------------------------------------------------------------------------
// FORM predicates. Everything here is O(digits) or a table; the only
// Miller-Rabin calls are the five inside the `isPrime` branch of `scoreOf`, so
// a composite pays for exactly one MR pass (§2).
// ---------------------------------------------------------------------------

// 2^p − 1 form. Combined with primality by the caller — an unprimed 2^p − 1 is
// not a Mersenne PRIME and scores nothing.
fun isMersenneForm(n: int): bool {
    if (n < 3) { return false; }
    val np1 = n + 1;
    return (np1 & (np1 - 1)) == 0;
}

// The five known Fermat primes. F5 = 4294967297 is composite (641 · 6700417),
// and no larger Fermat number is known to be prime, so this list is the
// complete one — a table, not a truncation.
fun isFermatPrime(n: int): bool {
    return n == 3 || n == 5 || n == 17 || n == 257 || n == 65537;
}

// The six perfect numbers below AUCTIONABLE_MAX. The seventh, 137438691328,
// is 1.37·10¹¹ — inside the cap, so it is here too; the eighth is 2.3·10¹⁸ and
// is not.
fun isPerfectNumber(n: int): bool {
    return n == 6 || n == 28 || n == 496 || n == 8128
        || n == 33550336 || n == 8589869056 || n == 137438691328;
}

// §7 era boundaries — the eight primorials the game is built around
// (`webapp/src/.../primorial.ts` is canonical for the era list: eight, never
// six). A primorial is on NEITHER auction lane at any price and mints only at
// the head; it still SCORES, because the score is also what the ledger's
// rebate and the orb's satellites read.
fun isPrimorial(n: int): bool {
    return n == 6 || n == 30 || n == 210 || n == 2310 || n == 30030
        || n == 510510 || n == 9699690 || n == 223092870;
}

// k! for k = 1..16. 17! = 3.56·10¹⁴ is above AUCTIONABLE_MAX, so the list is
// complete for every number this game can sell.
fun isFactorialN(n: int): bool {
    return n == 1 || n == 2 || n == 6 || n == 24 || n == 120 || n == 720
        || n == 5040 || n == 40320 || n == 362880 || n == 3628800
        || n == 39916800 || n == 479001600 || n == 6227020800
        || n == 87178291200 || n == 1307674368000 || n == 20922789888000;
}

// FIBONACCI AND LUCAS FROM ONE SQUARE ROOT. n is Fibonacci iff 5n² ± 4 is a
// square, and Lucas iff 5n² ± 20 is. For n >= 5 every one of those four roots
// lies within one of s = isqrt(5n²) (the ±20 offset moves √(5n²) by at most
// 20 / (2·√125) < 0.9), so three squarings decide both families — where the
// Fibonacci test alone used to take two Newton roots. n <= 4 is answered
// directly: 1, 2, 3 are Fibonacci, and 1, 2, 3, 4 are Lucas (L₀ = 2).
// `sim/tests/test_desirability.py` checks the window against the four-root
// definition.
//
// A 65-entry TABLE was tried for Fibonacci and is MEASURABLY WORSE: 65
// comparisons against 257-bit literals cost more in TVM than the roots, and
// pushed the primorial mint from 0.0998 to 0.1000 GRAM, over §4.1's gas & ops
// line.
fun fibLucasOf(n: int): (bool, bool) {
    if (n < 1) { return (false, false); }
    if (n <= 4) { return (n <= 3, true); }
    val f = 5 * n * n;
    val s = isqrt(f);
    var fib = false;
    var luc = false;
    var r = s - 1;
    while (r <= s + 1) {
        val gap = r * r - f;
        if (gap == 4 || gap == -4) { fib = true; }
        if (gap == 20 || gap == -20) { luc = true; }
        r += 1;
    }
    return (fib, luc);
}
// Happy: iterate the sum of the squares of the digits. Base 10 has exactly one
// non-trivial cycle and 4 is on it, so reaching 4 is a proof of unhappiness —
// the loop is bounded without a visited set. The bound below is a belt on top
// of that.
fun isHappyN(n: int): bool {
    if (n < 1) { return false; }
    var x = n;
    var i = 0;
    while (i < 100) {
        if (x == 1) { return true; }
        if (x == 4) { return false; }
        var s = 0;
        var t = x;
        while (t > 0) {
            val dg = t % 10;
            s += dg * dg;
            t /= 10;
        }
        x = s;
        i += 1;
    }
    return false;
}

// ---------------------------------------------------------------------------
// CULTURE (§3.1) — the two owner-signed lists. The qualifying rule, for any
// future addition: a reader who is not a mathematician recognises the number
// WITHOUT explanation. Anything needing a footnote is not culture, it is
// FORM or POSITION.
// ---------------------------------------------------------------------------

fun isIconicNumber(n: int): bool {
    return n == 2 || n == 42 || n == 69 || n == 420 || n == 666
        || n == 777 || n == 1337 || n == 1729 || n == 8008;
}

fun isListedNumber(n: int): bool {
    return n == 7 || n == 13 || n == 23 || n == 47 || n == 88 || n == 99
        || n == 101 || n == 108 || n == 404 || n == 418 || n == 451
        || n == 495 || n == 911 || n == 1234 || n == 1984 || n == 2001
        || n == 2049 || n == 4096 || n == 6174 || n == 8086 || n == 9000
        || n == 9001 || n == 24601 || n == 31337 || n == 65536 || n == 80085
        || n == 90210 || n == 142857 || n == 5318008 || n == 8675309;
}

// ---------------------------------------------------------------------------
// POSITION (§3.2) — where a number sits on the line, rather than what shape it
// has. `isCuratedConstantOrTaxicab` is the ONE survivor of the old curated
// list (its year half, 1918..2030, is deleted: LIFE prices years now, and
// properly).
// ---------------------------------------------------------------------------

fun isCuratedConstantOrTaxicab(n: int): bool {
    return n == 3141 || n == 31415 || n == 314159
        || n == 2718 || n == 27182 || n == 271828
        || n == 1618 || n == 16180 || n == 161803
        || n == 1414 || n == 14142 || n == 141421
        || n == 1729;
}

// The landmark table (§3.2): the largest prime below and smallest prime above
// each 10^k for k = 1..14, the m-th prime for m = 10..10^8 by decades, and the
// largest prime below each of the eight primorial era boundaries. SIEVED, not
// estimated — `sim/scripts/landmark_primes.py` generates this function body
// and is the provenance of every constant in it. Do not hand-edit; re-run the
// script.
// LANDMARK TABLE BEGIN
fun isLandmarkPrime(n: int): bool {
    return n == 5 || n == 7 || n == 11
        || n == 29 || n == 97 || n == 101
        || n == 199 || n == 541 || n == 997
        || n == 1009 || n == 2309 || n == 7919
        || n == 9973 || n == 10007 || n == 30029
        || n == 99991 || n == 100003 || n == 104729
        || n == 510481 || n == 999983 || n == 1000003
        || n == 1299709 || n == 9699667 || n == 9999991
        || n == 10000019 || n == 15485863 || n == 99999989
        || n == 100000007 || n == 179424673 || n == 223092827
        || n == 999999937 || n == 1000000007 || n == 2038074743
        || n == 9999999967 || n == 10000000019 || n == 99999999977
        || n == 100000000003 || n == 999999999989 || n == 1000000000039
        || n == 9999999999971 || n == 10000000000037 || n == 99999999999973
        || n == 100000000000031;
}
// LANDMARK TABLE END

// ---------------------------------------------------------------------------
// N6's predicates. Every one of these runs on the MINT path (`scoreOf(n)`), so
// each is written for the shape TVM is cheap at: an early exit on a bound that
// the sequence itself proves, and a membership table bucketed on the digit
// count `d` the caller already walked rather than a flat `||` chain. That last
// point is not a style note — measured, the two tables below cost 1,311,067
// nanoton more as flat chains, 61% of this whole batch's bill against §4.1's
// gas & ops line (0.10 GRAM when measured; 0.20 since D-117).
// ---------------------------------------------------------------------------

// Sum of each digit raised to the digit COUNT. Early-exits the moment the
// running sum passes `n`, which bounds the cost well under d*d multiplies on
// every number that is not narcissistic.
fun isNarcissistic(n: int, d: int): bool {
    if (d < 2) { return false; }
    var s = 0;
    var t = n;
    while (t > 0) {
        val dg = t % 10;
        var p = 1;
        var i = 0;
        while (i < d) { p *= dg; i += 1; }
        s += p;
        if (s > n) { return false; }
        t /= 10;
    }
    return s == n;
}

// Keith: the d-term recurrence seeded by the digits of `n`, reaching `n`. The
// window is a d-slot ring buffer over `array<int>` and the running sum is
// carried, so a step is one add, one subtract and one store rather than a
// re-walk. Terms ascend, so passing `n` is a proof of failure.
fun isKeithNumber(n: int, d: int, digitSum: int): bool {
    if (d < 2) { return false; }
    var w: array<int> = [];
    var t = n;
    while (t > 0) { w.push(t % 10); t /= 10; }
    var pos = d - 1;          // the oldest term: the leading digit
    var sum = digitSum;
    var steps = 0;
    while (steps < 200) {
        if (sum == n) { return true; }
        if (sum > n) { return false; }
        val next = sum;
        sum = sum - w.get(pos) + next;
        w.set(next, pos);
        pos -= 1;
        if (pos < 0) { pos = d - 1; }
        steps += 1;
    }
    return false;
}

// The Catalan numbers to AUCTIONABLE_MAX, bucketed by digit count for the same
// reason as the table above.
fun isCatalanNumber(n: int, d: int): bool {
    if (d < 1 || d > 14) { return false; }
    if (d == 1) { return n == 2 || n == 5; }
    if (d == 2) { return n == 14 || n == 42; }
    if (d == 3) { return n == 132 || n == 429; }
    if (d == 4) { return n == 1430 || n == 4862; }
    if (d == 5) { return n == 16796 || n == 58786; }
    if (d == 6) { return n == 208012 || n == 742900; }
    if (d == 7) { return n == 2674440 || n == 9694845; }
    if (d == 8) { return n == 35357670; }
    if (d == 9) { return n == 129644790 || n == 477638700; }
    if (d == 10) { return n == 1767263190 || n == 6564120420; }
    if (d == 11) { return n == 24466267020 || n == 91482563640; }
    if (d == 12) { return n == 343059613650; }
    if (d == 13) { return n == 1289904147324 || n == 4861946401452; }
    if (d == 14) { return n == 18367353072152; }
    return false;
}

// The complete list of highly composite numbers to AUCTIONABLE_MAX: d(n)
// strictly beats every smaller n. A record is only testable as a table, and a
// 110-entry `||` chain is the wrong shape for one — `d` is already in hand from
// the digit walk, so it selects the bucket and at most 14 comparisons run.
fun isHighlyComposite(n: int, d: int): bool {
    if (d < 1 || d > 14) { return false; }
    if (d == 1) { return n == 2 || n == 4 || n == 6; }
    if (d == 2) { return n == 12 || n == 24 || n == 36
            || n == 48 || n == 60; }
    if (d == 3) { return n == 120 || n == 180 || n == 240
            || n == 360 || n == 720 || n == 840; }
    if (d == 4) { return n == 1260 || n == 1680 || n == 2520
            || n == 5040 || n == 7560; }
    if (d == 5) { return n == 10080 || n == 15120 || n == 20160
            || n == 25200 || n == 27720 || n == 45360
            || n == 50400 || n == 55440 || n == 83160; }
    if (d == 6) { return n == 110880 || n == 166320 || n == 221760
            || n == 277200 || n == 332640 || n == 498960
            || n == 554400 || n == 665280 || n == 720720; }
    if (d == 7) { return n == 1081080 || n == 1441440 || n == 2162160
            || n == 2882880 || n == 3603600 || n == 4324320
            || n == 6486480 || n == 7207200 || n == 8648640; }
    if (d == 8) { return n == 10810800 || n == 14414400 || n == 17297280
            || n == 21621600 || n == 32432400 || n == 36756720
            || n == 43243200 || n == 61261200 || n == 73513440; }
    if (d == 9) { return n == 110270160 || n == 122522400 || n == 147026880
            || n == 183783600 || n == 245044800 || n == 294053760
            || n == 367567200 || n == 551350800 || n == 698377680
            || n == 735134400; }
    if (d == 10) { return n == 1102701600 || n == 1396755360 || n == 2095133040
            || n == 2205403200 || n == 2327925600 || n == 2793510720
            || n == 3491888400 || n == 4655851200 || n == 5587021440
            || n == 6983776800; }
    if (d == 11) { return n == 10475665200 || n == 13967553600 || n == 20951330400
            || n == 27935107200 || n == 41902660800 || n == 48886437600
            || n == 64250746560 || n == 73329656400 || n == 80313433200
            || n == 97772875200; }
    if (d == 12) { return n == 128501493120 || n == 146659312800 || n == 160626866400
            || n == 240940299600 || n == 293318625600 || n == 321253732800
            || n == 481880599200 || n == 642507465600 || n == 963761198400; }
    if (d == 13) { return n == 1124388064800 || n == 1606268664000 || n == 1686582097200
            || n == 1927522396800 || n == 2248776129600 || n == 3212537328000
            || n == 3373164194400 || n == 4497552259200 || n == 6746328388800
            || n == 8995104518400 || n == 9316358251200; }
    if (d == 14) { return n == 13492656777600 || n == 18632716502400 || n == 26985313555200
            || n == 27949074753600 || n == 32607253879200; }
    return false;
}

// ---------------------------------------------------------------------------
// THE SCORE.
//
// `score` is the clamped sum; `flags` is the bitmask of the categories that
// contributed to it, and the two CANNOT disagree because every point added
// here is added on the same line that sets its bit. That is what makes
// `getScoreBreakdown(n)` an audit (§9.1) rather than a second opinion: a
// reader recomputes the sum from `flags` and the published weight table and
// must land on `score`.
//
// DIGIT TAKES A MAX, EVERYTHING ELSE SUMS (§1.1). The six digit-shape
// predicates imply one another — 1111 is a repdigit AND a palindrome AND an
// abab — so summing them compounds one visual property into a runaway score
// and makes the clamp do all the work. Exactly ONE digit bit is ever set: the
// best reason the number looks nice, once. Ties go to the lower bit.
// ---------------------------------------------------------------------------

/**
 * BIT_PRIME out of a flags word.
 *
 * `scoreOf` already ran Miller-Rabin — 13 witnesses, the most expensive thing on the
 * mint and open paths — so a caller that holds the score must never pay for a second
 * pass to ask the same question. Every call site that needs BOTH the score and the
 * class reads the class from here; only a caller that needs the class ALONE
 * (`getLotLane`) calls `isPrimeMR` directly, because for that one the score is the
 * more expensive answer.
 */
fun isPrimeFromFlags(flags: int): bool {
    return ((flags >> BIT_PRIME) & 1) == 1;
}

fun scoreOfUnclamped(n: int): (int, int) {
    if (n <= 0) { return (0, 0); }

    // ---- one least-significant-digit walk: length, trailing zeros, the four
    // shape predicates, the digit sum and the full reversal (for the emirp
    // check). ----
    var d = 0;
    var tz = 0;
    var countingTz = true;
    var allSame = true;
    var ascending = true;      // digits ascend by 1 read most-significant-first
    var descending = true;
    var abab = true;           // digit[i] == digit[i-2] for every i
    var digitSum = 0;
    var dmask = 0;
    var p10 = 1;
    var rev = 0;
    var m = n;
    var prev = -1;
    var prev2 = -1;
    while (m > 0) {
        val dig = m % 10;
        if (countingTz) {
            if (dig == 0) { tz += 1; } else { countingTz = false; }
        }
        if (prev >= 0) {
            if (dig != prev) { allSame = false; }
            // Walking down from the top, the digit AFTER `dig` is `prev`, so
            // "ascending" (1234) means prev == dig + 1.
            if (prev != dig + 1) { ascending = false; }
            if (prev != dig - 1) { descending = false; }
        }
        if (prev2 >= 0 && dig != prev2) { abab = false; }
        prev2 = prev;
        prev = dig;
        digitSum += dig;
        dmask |= (1 << dig);
        p10 *= 10;
        rev = rev * 10 + dig;
        m = m / 10;
        d += 1;
    }
    val topDigit = prev;

    var flags = 0;
    var score = 0;

    // ---- LEN. Continuous, so it has no bit and no satellite (§8.3): a scale
    // is not a category. ----
    if (d < LEN_REF) { score += LEN_W * (LEN_REF - d); }

    // ---- DIGIT (max of six) ----
    var pali = false;
    if (d >= 2) {
        val half = d / 2;
        var rv = 0;
        var rest = n;
        var i = 0;
        while (i < half) {
            rv = rv * 10 + rest % 10;
            rest = rest / 10;
            i += 1;
        }
        if (d % 2 == 1) { rest = rest / 10; }   // drop the middle digit
        pali = (rest == rv);
    }
    val tzCapped = tz < TZ_CAP ? tz : TZ_CAP;
    var abRepeat = (d >= 4 && d % 2 == 0 && abab);
    if (!abRepeat && d == 4) {
        // aabb, which the abab walk does not see
        val e0 = n % 10;
        val e1 = (n / 10) % 10;
        val e2 = (n / 100) % 10;
        val e3 = (n / 1000) % 10;
        abRepeat = (e3 == e2 && e1 == e0 && e3 != e1);
    }
    var digBit = -1;
    var digPts = 0;
    if (d >= 2 && allSame) {
        digBit = BIT_REPDIGIT; digPts = W_REPDIGIT;
    }
    if (d >= 2 && topDigit == 1 && tz == d - 1 && W_POW10 > digPts) {
        digBit = BIT_POW10; digPts = W_POW10;
    }
    if (d >= 2 && pali && W_PALINDROME > digPts) {
        digBit = BIT_PALINDROME; digPts = W_PALINDROME;
    }
    if (d >= 3 && (ascending || descending) && W_RUN > digPts) {
        digBit = BIT_RUN; digPts = W_RUN;
    }
    if (abRepeat && W_ABAB > digPts) {
        digBit = BIT_ABAB; digPts = W_ABAB;
    }
    if (tzCapped > 0 && W_TRAILING_ZEROS * tzCapped > digPts) {
        digBit = BIT_TRAILING_ZEROS; digPts = W_TRAILING_ZEROS * tzCapped;
    }
    if (digBit >= 0) {
        flags |= (1 << digBit);
        score += digPts;
    }

    // ---- LIFE (owner answer 11). A human-life date is a tier of its own.
    //
    // NO DOUBLE COUNT INSIDE THE 8-DIGIT FORMS: an n whose leading four digits
    // are a year in 1900..2100, read instead as DDMMYYYY or MMDDYYYY, has a
    // month of 19, 20 or 21 and fails; the converse fails the same way. The
    // `else` below states that rather than relying on it.
    //
    // NO LEADING ZERO EXISTS. An integer cannot carry one, so `09091972` is
    // not a number this game can sell and the DDMMYYYY/MMDDYYYY forms are
    // reachable only when the leading field is >= 10 — which having exactly 8
    // digits already guarantees. The webapp's date finder is what tells a
    // buyer which of their date's forms are unrepresentable.
    if (d == 8) {
        val y8 = n / 10000;
        val md = n % 10000;
        if (y8 >= YEAR_LO && y8 <= YEAR_HI && isValidDate(y8, md / 100, md % 100)) {
            flags |= (1 << BIT_YYYYMMDD); score += W_YYYYMMDD;
        } else {
            val yTail = n % 10000;
            val f1 = n / 1000000;          // leading pair: day, or month
            val f2 = (n / 10000) % 100;    // second pair: month, or day
            if (yTail >= YEAR_LO && yTail <= YEAR_HI
                && (isValidDate(yTail, f2, f1) || isValidDate(yTail, f1, f2))) {
                flags |= (1 << BIT_DMY8); score += W_DMY8;
            }
        }
    }
    // YYMMDD carries no century, so the leap day is accepted: 000229 is a real
    // 29 February in every century divisible by 400 and the form cannot say
    // which one it means. Validated against 2000 for exactly that reason.
    if (d == 6) {
        val mm6 = (n / 100) % 100;
        val dd6 = n % 100;
        if (isValidDate(2000, mm6, dd6)) {
            flags |= (1 << BIT_YYMMDD); score += W_YYMMDD;
        }
    }
    if (d == 4) {
        if (n >= YEAR_LO && n <= YEAR_HI) {
            flags |= (1 << BIT_YEAR); score += W_YEAR;
        }
        val p1 = n / 100;
        val p2 = n % 100;
        if (isValidDate(2000, p1, p2) || isValidDate(2000, p2, p1)) {
            flags |= (1 << BIT_MMDD); score += W_MMDD;
        }
    }

    // ---- FORM (sum). One Miller-Rabin pass for a composite; five more only
    // inside the prime branch (§2). ----
    val prime = isPrimeMR(n);
    if (prime) {
        flags |= (1 << BIT_PRIME); score += W_PRIME;
        if (isMersenneForm(n)) { flags |= (1 << BIT_MERSENNE); score += W_MERSENNE; }
        if (isFermatPrime(n)) { flags |= (1 << BIT_FERMAT); score += W_FERMAT; }
        if (isPrimeMR(n - 2) || isPrimeMR(n + 2)) {
            flags |= (1 << BIT_TWIN); score += W_TWIN;
        }
        if (isPrimeMR(2 * n + 1)) {
            flags |= (1 << BIT_SOPHIE_GERMAIN); score += W_SOPHIE_GERMAIN;
        }
        if (n > 2 && (n - 1) % 2 == 0 && isPrimeMR((n - 1) / 2)) {
            flags |= (1 << BIT_SAFE_PRIME); score += W_SAFE_PRIME;
        }
        // "a DIFFERENT prime" — a palindromic prime is not an emirp, it
        // already carries BIT_PALINDROME.
        if (rev != n && isPrimeMR(rev)) {
            flags |= (1 << BIT_EMIRP); score += W_EMIRP;
        }
    }
    if (isPerfectNumber(n)) { flags |= (1 << BIT_PERFECT); score += W_PERFECT; }
    if (isPrimorial(n)) { flags |= (1 << BIT_PRIMORIAL); score += W_PRIMORIAL; }
    if (isFactorialN(n)) { flags |= (1 << BIT_FACTORIAL); score += W_FACTORIAL; }
    if (n >= 2 && (n & (n - 1)) == 0) { flags |= (1 << BIT_POW2); score += W_POW2; }
    val (fib, luc) = fibLucasOf(n);
    if (fib) { flags |= (1 << BIT_FIBONACCI); score += W_FIBONACCI; }
    if (luc) { flags |= (1 << BIT_LUCAS); score += W_LUCAS; }
    if (isPerfectCube(n)) { flags |= (1 << BIT_CUBE); score += W_CUBE; }
    // ONE root, two categories: n = r² is SQUARE, n = r(r+1) is PRONIC, and
    // both r are ⌊√n⌋.
    val rn = isqrt(n);
    if (rn * rn == n) { flags |= (1 << BIT_SQUARE); score += W_SQUARE; }
    if (rn * (rn + 1) == n) { flags |= (1 << BIT_PRONIC); score += W_PRONIC; }
    if (isPerfectSquare(8 * n + 1)) { flags |= (1 << BIT_TRIANGULAR); score += W_TRIANGULAR; }
    if (digitSum > 0 && n % digitSum == 0) { flags |= (1 << BIT_HARSHAD); score += W_HARSHAD; }
    if (isHappyN(n)) { flags |= (1 << BIT_HAPPY); score += W_HAPPY; }
    if (isPrimeMR(digitSum)) { flags |= (1 << BIT_DIGITSUM_PRIME); score += W_DIGITSUM_PRIME; }

    // ---- N6's eight from-`n` categories. SUMMED, not folded into DIGIT's
    // max-of-six: none of these is implied by a repdigit or a palindrome, and
    // a number that is both earns both. ----
    if (d == 10 && dmask == 0x3FF) { flags |= (1 << BIT_PANDIGITAL); score += W_PANDIGITAL; }
    if (isNarcissistic(n, d)) { flags |= (1 << BIT_NARCISSISTIC); score += W_NARCISSISTIC; }
    val nsq = n * n;
    val kLow = nsq % p10;
    if (kLow == n) { flags |= (1 << BIT_AUTOMORPHIC); score += W_AUTOMORPHIC; }
    if (kLow > 0 && kLow + nsq / p10 == n) { flags |= (1 << BIT_KAPREKAR); score += W_KAPREKAR; }
    if (((flags >> BIT_SQUARE) & 1) == 1 && ((flags >> BIT_TRIANGULAR) & 1) == 1) {
        flags |= (1 << BIT_SQUARE_TRIANGULAR); score += W_SQUARE_TRIANGULAR;
    }
    if (isHighlyComposite(n, d)) { flags |= (1 << BIT_HIGHLY_COMPOSITE); score += W_HIGHLY_COMPOSITE; }
    if (isKeithNumber(n, d, digitSum)) { flags |= (1 << BIT_KEITH); score += W_KEITH; }
    if (isCatalanNumber(n, d)) { flags |= (1 << BIT_CATALAN); score += W_CATALAN; }

    // ---- CULTURE. The two lists are disjoint by construction. ----
    if (isIconicNumber(n)) { flags |= (1 << BIT_ICONIC); score += W_ICONIC; }
    if (isListedNumber(n)) { flags |= (1 << BIT_LISTED); score += W_LISTED; }

    // ---- POSITION ----
    if (prime && isLandmarkPrime(n)) { flags |= (1 << BIT_LANDMARK); score += W_LANDMARK; }
    if (isCuratedConstantOrTaxicab(n)) { flags |= (1 << BIT_CONSTANT); score += W_CONSTANT; }

    // NO CLAMP HERE. `clampScore` is applied by the two entry points below,
    // ONCE, over the whole sum — including the factor points when there are
    // any. Clamping in this function instead would make
    // `scoreOfFrom(n, factors)` clamp twice and silently drop a factor
    // category on any number already at the ceiling.
    return (score, flags);
}

// THE ONE CLAMP. `flags` is NOT clamped: a number that earned nine categories
// wears nine satellites even when the ninth bought it no points, because the
// orb draws what is true of the number and the price draws what the game will
// charge for it.
@inline
fun clampScore(score: int): int {
    return score > SCORE_MAX ? SCORE_MAX : score;
}

// `1 + p + p^2 + ... + p^e`, the sigma-factor of one prime power. Summed as a
// series rather than as `(p^(e+1) - 1) / (p - 1)` so there is no division and
// no intermediate that overflows for a `p` near the uint256 ceiling: the loop
// runs `e` times and `e` is bounded by the factorization the caller already
// verified against `n`.
@inline
fun sigmaTerm(p: int, e: int): int {
    var term = 1;
    var power = 1;
    var i = 0;
    while (i < e) {
        power *= p;
        term += power;
        i += 1;
    }
    return term;
}

// The five §4 categories, from the aggregates of a VERIFIED factorization.
//
// The caller proves `product == n` before calling — this function trusts that
// and computes nothing about primality. `omega` is Omega(n), the factor count
// WITH multiplicity; `distinct` is the number of entries in the list.
// `(0, 0)` for an unfactored call, which is what keeps `scoreOf` a lower bound
// rather than a different answer.
@inline
fun factorScoreOf(n: int, omega: int, distinct: int, maxExponent: int, minExponent: int,
                  expGcd: int, maxPrime: int, sigma: int, korselt: int,
                  factorDigitSum: int): (int, int) {
    if (distinct <= 0) { return (0, 0); }

    var score = 0;
    var flags = 0;

    // Semiprime is Omega(n) == 2, the standard definition, so `p^2` is one:
    // it therefore carries BOTH this bit and PRIME_POWER, exactly as 64
    // already carries both SQUARE and CUBE. The model is additive and its
    // categories were never a partition.
    if (omega == 2) { flags |= (1 << BIT_SEMIPRIME); score += W_SEMIPRIME; }
    if (distinct == 1 && omega >= 2) {
        flags |= (1 << BIT_PRIME_POWER); score += W_PRIME_POWER;
    }
    if (maxExponent == 1) { flags |= (1 << BIT_SQUAREFREE); score += W_SQUAREFREE; }
    // CARMICHAEL, by Korselt's criterion: squarefree, at least three prime
    // factors, and (p-1) | (n-1) for every one of them. The squarefree half is
    // free — `maxExponent` is already in hand — and `korselt` is one modulo per
    // factor inside the walk `factorSummaryOf` was already making. The first clause is `maxExponent`,
    // which this function already has; the third is accumulated in the same
    // walk that builds sigma.
    if (korselt == 1 && maxExponent == 1 && distinct >= 3) {
        flags |= (1 << BIT_CARMICHAEL); score += W_CARMICHAEL;
    }
    if (maxPrime <= SMOOTH_BOUND) { flags |= (1 << BIT_SMOOTH); score += W_SMOOTH; }

    // ---- D-162's four. SPHENIC: three distinct primes, each once.
    if (omega == 3 && distinct == 3) { flags |= (1 << BIT_SPHENIC); score += W_SPHENIC; }
    // POWERFUL: every prime factor at least squared. ACHILLES: powerful and
    // NOT a perfect power, which is exactly "the exponents share no common
    // factor" — so p^k is powerful and never Achilles.
    if (minExponent >= 2) {
        flags |= (1 << BIT_POWERFUL); score += W_POWERFUL;
        if (expGcd == 1) { flags |= (1 << BIT_ACHILLES); score += W_ACHILLES; }
    }
    // SMITH: a composite whose digit sum equals the digit sums of its prime
    // factors, counted with multiplicity. `omega >= 2` is the composite test.
    if (omega >= 2) {
        var ds = 0;
        var t = n;
        while (t > 0) { ds += t % 10; t /= 10; }
        if (ds == factorDigitSum) { flags |= (1 << BIT_SMITH); score += W_SMITH; }
    }

    // Perfect numbers earn neither, and are already worth 40 as BIT_PERFECT.
    val twiceN = 2 * n;
    if (sigma > twiceN) { flags |= (1 << BIT_ABUNDANT); score += W_ABUNDANT; }
    if (sigma < twiceN) { flags |= (1 << BIT_DEFICIENT); score += W_DEFICIENT; }

    return (score, flags);
}

// Walk a submitted factor list into the aggregates `factorScoreOf` needs:
// `(omega, distinct, maxExponent, minExponent, expGcd, maxPrime, sigma,
// korselt, factorDigitSum)`. Entries are read from
// index 0 up and the walk stops at the first gap, which is how every other
// reader of this dictionary in both contracts walks it.
//
// THIS FUNCTION VERIFIES NOTHING. It is called on a list the contract has
// already checked against `n` (`open_lot`'s product check, the mint's own),
// and on nothing else — a get-method reader who passes a list that does not
// multiply to `n` gets a score for a number that is not theirs, which costs
// them the read and no one else anything.
fun factorSummaryOf(n: int, factors: map<uint8, FactorEntry>): (int, int, int, int, int, int, int, int, int) {
    val n1 = n - 1;
    var omega = 0;
    var distinct = 0;
    var maxExponent = 0;
    var minExponent = 0;
    var expGcd = 0;
    var factorDigitSum = 0;
    var maxPrime = 0;
    var sigma = 1;
    var korselt = 1;
    var idx = 0;
    var more = true;
    while (more) {
        val look = factors.get(idx);
        if (!look.isFound) {
            more = false;
        } else {
            val f = look.loadValue();
            distinct += 1;
            omega += f.exponent;
            if (f.exponent > maxExponent) { maxExponent = f.exponent; }
            if (distinct == 1 || f.exponent < minExponent) { minExponent = f.exponent; }
            // gcd(expGcd, e) by Euclid; gcd(0, e) = e seeds it.
            var ga = expGcd;
            var gb = f.exponent;
            while (gb != 0) { val gr = ga % gb; ga = gb; gb = gr; }
            expGcd = ga;
            var pt = f.primeNumber;
            while (pt > 0) { factorDigitSum += (pt % 10) * f.exponent; pt /= 10; }
            if (f.primeNumber > maxPrime) { maxPrime = f.primeNumber; }
            sigma *= sigmaTerm(f.primeNumber, f.exponent);
            if (f.primeNumber < 2 || (n1 % (f.primeNumber - 1)) != 0) { korselt = 0; }
            idx += 1;
        }
    }
    if (distinct == 0) { return (0, 0, 0, 0, 0, 0, 0, 0, 0); }
    return (omega, distinct, maxExponent, minExponent, expGcd, maxPrime, sigma, korselt, factorDigitSum);
}

// THE FULL SCORE, from aggregates the caller already has.
//
// THIS IS THE ENTRY POINT THE MINT USES, AND THE REASON IT EXISTS IS GAS.
// `primes_ledger.tolk` verifies the factorization on the mint path — it walks
// every entry to check `product == n` and to sum the divisor weights — so it
// can accumulate these five numbers in that same loop for a couple of multiplies
// per exponent step. Calling `scoreOfFrom` there instead would walk the
// dictionary a SECOND time, which measured at ~1,300 gas on the worst-case mint
// and was not affordable when measured: §4.1's gas & ops line was a fixed 0.10
// GRAM with the invite fan-out (D-101) at 99.79 of it. D-117 (2026-09-22) resized
// the line to the measured worst case (0.20 GRAM), which is what this walk must
// still fit inside; the headroom there is ~0.014 GRAM, not a budget for a second walk.
@inline
fun scoreOfWithSummary(n: int, omega: int, distinct: int, maxExponent: int, minExponent: int,
                       expGcd: int, maxPrime: int, sigma: int, korselt: int,
                       factorDigitSum: int): (int, int) {
    if (n <= 0) { return (0, 0); }
    var (score, flags) = scoreOfUnclamped(n);
    val (fScore, fFlags) = factorScoreOf(n, omega, distinct, maxExponent, minExponent, expGcd,
                                         maxPrime, sigma, korselt, factorDigitSum);
    score += fScore;
    flags |= fFlags;
    return (clampScore(score), flags);
}

