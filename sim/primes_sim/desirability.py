"""`D(n)` -- DECISIONS.md D-99's additive score, in Python.

    D(n) = clamp( LEN + max(DIGIT) + LIFE + sum(FORM) + CULTURE + POSITION, 0, 87 )

**THIS IS THE THIRD IMPLEMENTATION, NOT THE AUTHORITY.**
`contracts/contracts/score_block.tolk.inc` is what actually prices a lot and
sizes the vault rebate; `shared/score.ts` is the TypeScript mirror the contract
sweep is asserted against. This module exists so the sim can price and count the
same numbers the chain does, and so a transcription slip shows up as three
implementations disagreeing rather than as a quietly wrong parameter.

What changed under D-99, and why nothing here is "the old score retuned": the
0..120 four-layer score (SCARCITY + max(PATTERN) + CALENDAR + MATH-at-zero) is
DELETED, together with `PREMIUM_UNIT`, `D_MIN`, the three rarity tiers and
`PRIME_W`. There are now 39 category bits (33 from `n` alone; bits 33..38 come only from a
submitted factorization and are set only by `score_from_flags`/
`factored_scores_range` -- see `FACTOR_BITS` below), every
category adds its points (only the six DIGIT patterns take a max, because they
imply one another), and the ONE
clamp is `SCORE_MAX = 87` -- which IS owner answer 9's 420 GRAM ceiling:
`MINT_PRICE * 2^(87/10)` = 415.9 GRAM, just under the declared cap. (D-99 SS1.1
writes `2^(87/10) = 420.4`; that is 2^8.716. The clamp is the ceiling either
way, and 415.9 GRAM is what the shipped integer ladder quotes at the top rung.)

**CLAUDE.md rule 3.** The 39 weights are **OWNER-DECLARED** (D-99 SS1.3, owner
answers 3/6/10), not sim output, and this module refuses to retype them: they
are parsed out of `shared/opcodes.ts`'s `SCORE_BITS`/`SCORE_TERMS` at import
time, so the sim cannot drift from the constants the contract and the webapp
read. What the sim owns is the *distribution* the weights induce
(`histogram`), and the two rates that distribution sizes
(`run_phase1.score_rebate_report`).
"""

from __future__ import annotations

import json
import math
import pathlib
import re
from dataclasses import dataclass

import numpy as np

from .trophy_auction import is_prime

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
OPCODES_TS = REPO_ROOT / "shared" / "opcodes.ts"
LANDMARKS_JSON = REPO_ROOT / "shared" / "landmark_primes.json"


# --------------------------------------------------------------------------- #
# The weights -- parsed, never retyped (owner-declared, D-99 SS1.3)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Weights:
    """The owner-declared weight vector, exactly as `shared/opcodes.ts` carries it.

    Frozen tuples rather than a dict so the block emitted into
    `shared/params.json` has a stable order and so the vector is hashable. The
    dataclass shape is kept from the pre-D-99 module because the params-consuming
    tests still read a `weights` mapping out of the emitted block.
    """

    LEN_REF: int
    LEN_W: int
    TZ_CAP: int
    SCORE_MAX: int
    keys: tuple[str, ...]
    groups: tuple[str, ...]
    points: tuple[int, ...]


def _parse_weights(path: pathlib.Path = OPCODES_TS) -> Weights:
    src = path.read_text(encoding="utf-8")
    body = src.split("export const SCORE_BITS = [", 1)[1].split("] as const", 1)[0]
    rows = re.findall(
        r"\{\s*bit:\s*(\d+),\s*key:\s*'([a-z0-9_]+)',\s*group:\s*'([A-Z]+)',"
        r"\s*points:\s*(\d+)\s*\}",
        body,
    )
    if not rows:
        raise ValueError(f"no SCORE_BITS rows parsed out of {path} -- the parser is stale")
    rows = [(int(b), k, g, int(p)) for b, k, g, p in rows]
    if [b for b, _, _, _ in rows] != list(range(len(rows))):
        raise ValueError("SCORE_BITS is not a dense 0..N bit list")

    terms_body = src.split("export const SCORE_TERMS = {", 1)[1].split("} as const", 1)[0]
    terms = {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+),", terms_body)}
    return Weights(
        LEN_REF=terms["LEN_REF"], LEN_W=terms["LEN_W"], TZ_CAP=terms["TZ_CAP"],
        SCORE_MAX=terms["SCORE_MAX"],
        keys=tuple(k for _, k, _, _ in rows),
        groups=tuple(g for _, _, g, _ in rows),
        points=tuple(p for _, _, _, p in rows),
    )


W = _parse_weights()
P = W.points
N_BITS = len(W.keys)

#: Bit numbers are permanent identifiers (D-99 SS8.2 gives each one a fixed angle
#: on the orb). Positional unpacking of `range` rather than 33 literals so a bit
#: cannot be typed wrong; the assertion below is what pins the ORDER to
#: `shared/opcodes.ts`.
(REPDIGIT, POW10, PALINDROME, RUN, ABAB, TRAILING_ZEROS,
 YYYYMMDD, DMY8, YEAR, YYMMDD, MMDD,
 MERSENNE, FERMAT, PERFECT, PRIMORIAL, FACTORIAL, PRIME, POW2, FIBONACCI, CUBE,
 TWIN, SOPHIE_GERMAIN, SAFE_PRIME, EMIRP, SQUARE, TRIANGULAR, HARSHAD, HAPPY,
 DIGITSUM_PRIME, ICONIC, LISTED, LANDMARK, CONSTANT,
 SEMIPRIME, PRIME_POWER, SQUAREFREE, SMOOTH, ABUNDANT, DEFICIENT,
 CARMICHAEL, PANDIGITAL, NARCISSISTIC, AUTOMORPHIC, SQUARE_TRIANGULAR,
 KAPREKAR, HIGHLY_COMPOSITE, KEITH, CATALAN,
 SMITH, SPHENIC, POWERFUL, ACHILLES, LUCAS, PRONIC) = range(54)

assert W.keys == (
    "repdigit", "pow10", "palindrome", "run", "abab", "trailing_zeros",
    "yyyymmdd", "ddmmyyyy", "year", "yymmdd", "mmdd",
    "mersenne", "fermat", "perfect", "primorial", "factorial", "prime", "pow2",
    "fibonacci", "cube", "twin", "sophie_germain", "safe_prime", "emirp",
    "square", "triangular", "harshad", "happy", "digitsum_prime",
    "iconic", "listed", "landmark", "constant",
    "semiprime", "prime_power", "squarefree", "smooth", "abundant", "deficient",
    "carmichael", "pandigital", "narcissistic", "automorphic",
    "square_triangular", "kaprekar", "highly_composite", "keith", "catalan",
    "smith", "sphenic", "powerful", "achilles", "lucas", "pronic",
), "shared/opcodes.ts SCORE_BITS moved -- the bit constants above are stale"

#: Bits 33..38 (PRICING_MODEL_PLAN.md SS4 phase 3) are the six categories `n`
#: alone cannot decide. On chain they come only from `scoreOfFrom(n, factors)`
#: -- the entry point `getLotPriceFrom`/`getScoreBreakdownFrom` expose -- while
#: `scoreOf(n)` returns them clear and is a documented LOWER BOUND.
#: `score_flags`/`scores_range` model `scoreOf(n)`; `score_from_flags`/
#: `factored_scores_range` model `scoreOfFrom` with the true factorization.
#:
#:   * `run_phase1.score_rebate_report` sizes the head-mint composite rebate on
#:     the FACTORED score: `primes_ledger.tolk`'s mint leg pays per point of
#:     `scoreOfFrom(n, factors)` since GAUNTLET.md C15 (signed 2026-09-24).
#:   * `trophy_auction.price_map` and `market.Cell.score` still quote the from-`n`
#:     `getLotPrice(n)`. Known consequence: `open_lot` prices a COMPOSITE lot on
#:     `scoreOfFrom`, so the sim's composite `P0` is that lower bound and can sit
#:     below what the chain charges. Not switched here: those consumers range
#:     over the 10^2..10^7 window, and repricing the auction model is its own
#:     change.
#: N6 appended nine more (bits 39..47), and only CARMICHAEL is factor-derived --
#: it needs Korselt's criterion over the submitted factor list, exactly as
#: 33..38 do. The other eight are decided from `n` alone and ARE set below, so
#: unlike 33..38 they move `D(n)` in this module's own answer.
#: D-162 appended six more (48..53): SMITH, SPHENIC, POWERFUL and ACHILLES are
#: factor-derived and join this tuple; LUCAS and PRONIC are from `n` and are set
#: below.
FACTOR_BITS = (SEMIPRIME, PRIME_POWER, SQUAREFREE, SMOOTH, ABUNDANT, DEFICIENT,
               CARMICHAEL, SMITH, SPHENIC, POWERFUL, ACHILLES)

#: N6's two membership tables, to AUCTIONABLE_MAX. Both are complete lists, not
#: samples: "highly composite" and "Catalan" are records and closed forms, so a
#: table IS the definition. `test_desirability.py` regenerates both from first
#: principles and asserts these are what the contract's bucketed tables hold.
CATALAN_NUMBERS = frozenset({
    2, 5, 14, 42, 132, 429, 1430, 4862, 16796, 58786, 208012, 742900,
    2674440, 9694845, 35357670, 129644790, 477638700, 1767263190,
    6564120420, 24466267020, 91482563640, 343059613650, 1289904147324,
    4861946401452, 18367353072152
})
HIGHLY_COMPOSITE_NUMBERS = frozenset({
    2, 4, 6, 12, 24, 36, 48, 60, 120, 180, 240, 360, 720, 840, 1260, 1680,
    2520, 5040, 7560, 10080, 15120, 20160, 25200, 27720, 45360, 50400,
    55440, 83160, 110880, 166320, 221760, 277200, 332640, 498960, 554400,
    665280, 720720, 1081080, 1441440, 2162160, 2882880, 3603600, 4324320,
    6486480, 7207200, 8648640, 10810800, 14414400, 17297280, 21621600,
    32432400, 36756720, 43243200, 61261200, 73513440, 110270160, 122522400,
    147026880, 183783600, 245044800, 294053760, 367567200, 551350800,
    698377680, 735134400, 1102701600, 1396755360, 2095133040, 2205403200,
    2327925600, 2793510720, 3491888400, 4655851200, 5587021440, 6983776800,
    10475665200, 13967553600, 20951330400, 27935107200, 41902660800,
    48886437600, 64250746560, 73329656400, 80313433200, 97772875200,
    128501493120, 146659312800, 160626866400, 240940299600, 293318625600,
    321253732800, 481880599200, 642507465600, 963761198400, 1124388064800,
    1606268664000, 1686582097200, 1927522396800, 2248776129600,
    3212537328000, 3373164194400, 4497552259200, 6746328388800,
    8995104518400, 9316358251200, 13492656777600, 18632716502400,
    26985313555200, 27949074753600, 32607253879200
})

#: `maxPrime <= SMOOTH_BOUND` sets SMOOTH. Parsed out of `shared/score.ts`, never retyped.
SMOOTH_BOUND = int(re.search(
    r"export const SMOOTH_BOUND = (\d+)n;",
    (REPO_ROOT / "shared" / "score.ts").read_text(encoding="utf-8"),
).group(1))

YEAR_LO = 1900
YEAR_HI = 2100


# --------------------------------------------------------------------------- #
# The tables. AUTHORITY: `contracts/contracts/score_block.tolk.inc`.
# `test_desirability.py` parses `shared/score.ts` and asserts these are the same
# sets, so a table edited in one place and not the other fails the sim gate.
# --------------------------------------------------------------------------- #

FERMAT_PRIMES = frozenset({3, 5, 17, 257, 65537})
PERFECT_NUMBERS = frozenset({6, 28, 496, 8128, 33550336, 8589869056, 137438691328})
#: The eight era boundaries (webapp `primorial.ts` is canonical -- eight, never six).
PRIMORIALS = (6, 30, 210, 2310, 30030, 510510, 9699690, 223092870)
FACTORIALS = frozenset({
    1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800, 479001600,
    6227020800, 87178291200, 1307674368000, 20922789888000,
})
#: SS3.1, owner-signed (answer 17). Recognised without explanation, or not culture.
ICONIC_NUMBERS = frozenset({2, 42, 69, 420, 666, 777, 1337, 1729, 8008})
LISTED_NUMBERS = frozenset({
    7, 13, 23, 47, 88, 99, 101, 108, 404, 418, 451, 495, 911, 1234, 1984,
    2001, 2049, 4096, 6174, 8086, 9000, 9001, 24601, 31337, 65536, 80085,
    90210, 142857, 5318008, 8675309,
})
CONSTANT_TRUNCATIONS = frozenset({
    3141, 31415, 314159, 2718, 27182, 271828, 1618, 16180, 161803,
    1414, 14142, 141421, 1729,
})


def _load_landmarks(path: pathlib.Path = LANDMARKS_JSON) -> frozenset:
    """SS3.2 -- sieved by `sim/scripts/landmark_primes.py`, read, never retyped."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    return frozenset(int(e["n"]) for e in doc["entries"])


LANDMARK_PRIMES = _load_landmarks()

#: D-96's family, NARROWED by D-99 to a rebate population: it scores no points,
#: sets no bit and lifts no price. `run_phase1.score_rebate_report` sizes it.
DIRICHLET_MIN_N = 100_000
DIRICHLET_MOD = 101


def is_rebate_family_prime(n: int) -> bool:
    return n > DIRICHLET_MIN_N and n % DIRICHLET_MOD == 1 and is_prime(n)


# --------------------------------------------------------------------------- #
# The scalar score -- the definition every other form must reproduce
# --------------------------------------------------------------------------- #

WINDOW_LO = 10 ** 2
WINDOW_HI = 10 ** 7

_DIM = (0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _leap(y: int) -> bool:
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)


def valid_date(y: int, m: int, d: int) -> bool:
    """Real Gregorian validity (owner answer 11): a birthday that never happened
    must not be priced as one."""
    if m < 1 or m > 12 or d < 1:
        return False
    lim = 29 if (m == 2 and _leap(y)) else _DIM[m]
    return d <= lim


def digits(n: int) -> list:
    """Decimal digits of `n`, most significant first."""
    if n < 0:
        raise ValueError("n must be non-negative")
    return [int(c) for c in str(n)]


def _is_happy(n: int) -> bool:
    x = n
    for _ in range(100):
        if x == 1:
            return True
        if x == 4:
            return False
        x = sum(int(c) ** 2 for c in str(x))
    return False


def _is_square(x: int) -> bool:
    if x < 0:
        return False
    r = int(x ** 0.5)
    while r * r > x:
        r -= 1
    while (r + 1) * (r + 1) <= x:
        r += 1
    return r * r == x


def _is_cube(x: int) -> bool:
    if x < 1:
        return False
    r = round(x ** (1 / 3))
    return any(c > 0 and c ** 3 == x for c in (r - 1, r, r + 1))


def _is_narcissistic(n: int, d: int) -> bool:
    """Sum of each digit raised to the digit COUNT. Bails once it passes `n`."""
    if d < 2:
        return False
    s, t = 0, n
    while t > 0:
        s += (t % 10) ** d
        if s > n:
            return False
        t //= 10
    return s == n


def _is_keith(n: int, d: int, digit_sum: int) -> bool:
    """The d-term recurrence seeded by the digits of `n`, reaching `n` exactly.

    Terms ascend, so overshooting is a proof of failure. The 200-step cap is the
    contract's and is never reached below AUCTIONABLE_MAX.
    """
    if d < 2:
        return False
    w = []
    t = n
    while t > 0:
        w.append(t % 10)
        t //= 10
    pos = d - 1                      # the oldest term: the leading digit
    total = digit_sum
    for _ in range(200):
        if total == n:
            return True
        if total > n:
            return False
        nxt = total
        total = total - w[pos] + nxt
        w[pos] = nxt
        pos = d - 1 if pos == 0 else pos - 1
    return False


def score_flags(n: int) -> tuple:
    """`D(n)` and its category bitmask, clamped -- `scoreOf(n)`. See `_score_flags_raw`."""
    raw, flags = _score_flags_raw(n)
    return min(raw, W.SCORE_MAX), flags


def _score_flags_raw(n: int) -> tuple:
    """UNCLAMPED `D(n)` and its category bitmask -- the same rule as `scoreOf` in
    `score_block.tolk.inc` and in `shared/score.ts`.

    THE FROM-`n` SCORE. Bits 33..38 (`FACTOR_BITS`) are never set: they are
    decided by a submitted factorization, which this function is not given, so
    what it returns is the same documented LOWER BOUND `getLotPrice(n)` quotes.

    The clamp is on the SCORE ALONE: a number that earned nine categories wears
    nine satellites even when the ninth bought it no points, because the orb
    draws what is true of the number and the price draws what the game charges.
    """
    if n <= 0:
        return 0, 0

    ds = digits(n)
    d = len(ds)
    tz = 0
    while tz < d and ds[d - 1 - tz] == 0:
        tz += 1
    digit_sum = sum(ds)
    rev = int("".join(str(x) for x in reversed(ds)))

    flags = 0
    score_sum = 0

    def set_bit(bit, pts):
        nonlocal flags, score_sum
        flags |= 1 << bit
        score_sum += pts

    # LEN -- continuous, so no bit and no satellite: a scale is not a category.
    if d < W.LEN_REF:
        score_sum += W.LEN_W * (W.LEN_REF - d)

    # DIGIT -- MAX of six, never a sum: 1111 is a repdigit AND a palindrome AND
    # an abab, and summing them compounds one visual property. Ties go low.
    candidates = []
    if d >= 2 and len(set(ds)) == 1:
        candidates.append((REPDIGIT, P[REPDIGIT]))
    if d >= 2 and ds[0] == 1 and tz == d - 1:
        candidates.append((POW10, P[POW10]))
    if d >= 2 and ds == ds[::-1]:
        candidates.append((PALINDROME, P[PALINDROME]))
    if d >= 3:
        deltas = {ds[i + 1] - ds[i] for i in range(d - 1)}
        if deltas in ({1}, {-1}):
            candidates.append((RUN, P[RUN]))
    abab = d >= 4 and d % 2 == 0 and all(ds[i] == ds[i - 2] for i in range(2, d))
    aabb = d == 4 and ds[0] == ds[1] and ds[2] == ds[3] and ds[0] != ds[2]
    if abab or aabb:
        candidates.append((ABAB, P[ABAB]))
    tz_capped = min(tz, W.TZ_CAP)
    if tz_capped > 0:
        candidates.append((TRAILING_ZEROS, P[TRAILING_ZEROS] * tz_capped))
    if candidates:
        best = candidates[0]
        for c in candidates:
            if c[1] > best[1]:
                best = c
        set_bit(*best)

    # LIFE. At most one 8-digit form can match: a YYYYMMDD in 1900..2100 read as
    # DDMMYYYY has a month of 19/20/21 and fails, and the converse fails the same
    # way. An integer carries no leading zero, so 8 digits already guarantees the
    # leading field is >= 10.
    if d == 8:
        y8, md = divmod(n, 10000)
        if YEAR_LO <= y8 <= YEAR_HI and valid_date(y8, md // 100, md % 100):
            set_bit(YYYYMMDD, P[YYYYMMDD])
        else:
            y_tail = n % 10000
            f1 = n // 1000000
            f2 = (n // 10000) % 100
            if (YEAR_LO <= y_tail <= YEAR_HI
                    and (valid_date(y_tail, f2, f1) or valid_date(y_tail, f1, f2))):
                set_bit(DMY8, P[DMY8])
    # YYMMDD carries no century, so the leap day is accepted -- the form cannot
    # say which century it means. Validated against 2000 for exactly that reason.
    if d == 6 and valid_date(2000, (n // 100) % 100, n % 100):
        set_bit(YYMMDD, P[YYMMDD])
    if d == 4:
        if YEAR_LO <= n <= YEAR_HI:
            set_bit(YEAR, P[YEAR])
        p1, p2 = n // 100, n % 100
        if valid_date(2000, p1, p2) or valid_date(2000, p2, p1):
            set_bit(MMDD, P[MMDD])

    # FORM -- sums. One Miller-Rabin pass for a composite; five more only inside
    # the prime branch.
    prime = is_prime(n)
    if prime:
        set_bit(PRIME, P[PRIME])
        if n >= 3 and ((n + 1) & n) == 0:
            set_bit(MERSENNE, P[MERSENNE])
        if n in FERMAT_PRIMES:
            set_bit(FERMAT, P[FERMAT])
        if is_prime(n - 2) or is_prime(n + 2):
            set_bit(TWIN, P[TWIN])
        if is_prime(2 * n + 1):
            set_bit(SOPHIE_GERMAIN, P[SOPHIE_GERMAIN])
        if n > 2 and (n - 1) % 2 == 0 and is_prime((n - 1) // 2):
            set_bit(SAFE_PRIME, P[SAFE_PRIME])
        # "a DIFFERENT prime" -- a palindromic prime already wears PALINDROME.
        if rev != n and is_prime(rev):
            set_bit(EMIRP, P[EMIRP])
    if n in PERFECT_NUMBERS:
        set_bit(PERFECT, P[PERFECT])
    if n in PRIMORIALS:
        set_bit(PRIMORIAL, P[PRIMORIAL])
    if n in FACTORIALS:
        set_bit(FACTORIAL, P[FACTORIAL])
    if n >= 2 and (n & (n - 1)) == 0:
        set_bit(POW2, P[POW2])
    if _is_square(5 * n * n + 4) or _is_square(5 * n * n - 4):
        set_bit(FIBONACCI, P[FIBONACCI])
    if _is_square(5 * n * n + 20) or _is_square(5 * n * n - 20):
        set_bit(LUCAS, P[LUCAS])
    if _is_cube(n):
        set_bit(CUBE, P[CUBE])
    if _is_square(n):
        set_bit(SQUARE, P[SQUARE])
    rn = math.isqrt(n)
    if rn * (rn + 1) == n:
        set_bit(PRONIC, P[PRONIC])
    if _is_square(8 * n + 1):
        set_bit(TRIANGULAR, P[TRIANGULAR])
    if digit_sum > 0 and n % digit_sum == 0:
        set_bit(HARSHAD, P[HARSHAD])
    if _is_happy(n):
        set_bit(HAPPY, P[HAPPY])
    if is_prime(digit_sum):
        set_bit(DIGITSUM_PRIME, P[DIGITSUM_PRIME])

    # N6's eight from-`n` categories (bits 40..47 plus nothing else -- 39,
    # CARMICHAEL, is factor-derived and this module never sets it). SUMMED, not
    # folded into DIGIT's max-of-six: none is implied by a repdigit or a
    # palindrome.
    if d == 10 and len(set(ds)) == 10:
        set_bit(PANDIGITAL, P[PANDIGITAL])
    if _is_narcissistic(n, d):
        set_bit(NARCISSISTIC, P[NARCISSISTIC])
    nsq = n * n
    p10 = 10 ** d
    k_low = nsq % p10
    if k_low == n:
        set_bit(AUTOMORPHIC, P[AUTOMORPHIC])
    if k_low > 0 and k_low + nsq // p10 == n:
        set_bit(KAPREKAR, P[KAPREKAR])
    if _is_square(n) and _is_square(8 * n + 1):
        set_bit(SQUARE_TRIANGULAR, P[SQUARE_TRIANGULAR])
    if n in HIGHLY_COMPOSITE_NUMBERS:
        set_bit(HIGHLY_COMPOSITE, P[HIGHLY_COMPOSITE])
    if _is_keith(n, d, digit_sum):
        set_bit(KEITH, P[KEITH])
    if n in CATALAN_NUMBERS:
        set_bit(CATALAN, P[CATALAN])

    if n in ICONIC_NUMBERS:
        set_bit(ICONIC, P[ICONIC])
    if n in LISTED_NUMBERS:
        set_bit(LISTED, P[LISTED])
    if prime and n in LANDMARK_PRIMES:
        set_bit(LANDMARK, P[LANDMARK])
    if n in CONSTANT_TRUNCATIONS:
        set_bit(CONSTANT, P[CONSTANT])

    # Unclamped: `scoreOfUnclamped`. The ONE clamp is applied by the callers,
    # once over the whole sum including factor points (`score_from`).
    return score_sum, flags


def _factor_points(n: int, f: dict) -> tuple:
    """`factorScoreOf` -- the factor-derived points and bits of a VERIFIED
    factorization `f = {p: e}` of `n`. `(0, 0)` for an empty one."""
    if not f:
        return 0, 0
    omega = sum(f.values())
    distinct = len(f)
    max_e, min_e = max(f.values()), min(f.values())
    sigma = math.prod((p ** (e + 1) - 1) // (p - 1) for p, e in f.items())
    pts = flags = 0
    for bit, hit in (
        (SEMIPRIME, omega == 2),
        (PRIME_POWER, distinct == 1 and omega >= 2),
        (SQUAREFREE, max_e == 1),
        (CARMICHAEL, max_e == 1 and distinct >= 3 and all((n - 1) % (p - 1) == 0 for p in f)),
        (SMOOTH, max(f) <= SMOOTH_BOUND),
        (SPHENIC, omega == 3 and distinct == 3),
        (POWERFUL, min_e >= 2),
        (ACHILLES, min_e >= 2 and math.gcd(*f.values()) == 1),
        (SMITH, omega >= 2 and sum(digits(n)) == sum(sum(digits(p)) * e for p, e in f.items())),
        (ABUNDANT, sigma > 2 * n),
        (DEFICIENT, sigma < 2 * n),
    ):
        if hit:
            pts += P[bit]
            flags |= 1 << bit
    return pts, flags


def score_from_flags(n: int, factors: dict | None = None) -> tuple:
    """`scoreOfFrom(n, factors)` -- `D(n)` WITH the factor categories, one clamp
    over the whole sum. `factors` defaults to the true factorization of a
    COMPOSITE `n`; a prime (or 1) gets the empty list, exactly as the head mint
    passes none for a prime (it is proved by Miller-Rabin, not factored), so its
    answer is `score_flags(n)`. That default is what C15's head-mint rebate reads."""
    if n <= 0:
        return 0, 0
    if factors is None:
        factors = {} if n < 4 or is_prime(n) else _trial_factor(n)
    raw, flags = _score_flags_raw(n)
    fp, ff = _factor_points(n, factors)
    return min(raw + fp, W.SCORE_MAX), flags | ff


def score_from(n: int, factors: dict | None = None) -> int:
    return score_from_flags(n, factors)[0]


def _trial_factor(n: int) -> dict:
    f, p = {}, 2
    while p * p <= n:
        while n % p == 0:
            f[p] = f.get(p, 0) + 1
            n //= p
        p += 1
    if n > 1:
        f[n] = f.get(n, 0) + 1
    return f


def score(n: int) -> int:
    """`D(n)` alone. The clamped sum -- this is what prices the lot."""
    return score_flags(n)[0]


def bits_of(flags: int) -> list:
    """The set categories of a flags word, by key, ascending."""
    return [k for i, k in enumerate(W.keys) if flags >> i & 1]


def explain(n: int) -> dict:
    """The score with its reasons -- what the AUDITOR view's breakdown renders."""
    s, flags = score_flags(n)
    d = len(digits(n)) if n > 0 else 0
    terms = {}
    if n > 0 and d < W.LEN_REF:
        terms["len"] = W.LEN_W * (W.LEN_REF - d)
    for i, key in enumerate(W.keys):
        if flags >> i & 1:
            pts = P[i]
            if i == TRAILING_ZEROS:
                tz = len(str(n)) - len(str(n).rstrip("0"))
                pts = P[i] * min(tz, W.TZ_CAP)
            terms[key] = pts
    return {
        "n": n,
        "score": s,
        "flags": flags,
        "categories": bits_of(flags),
        "terms": terms,
        "raw_sum": sum(terms.values()),
        "clamped": sum(terms.values()) > W.SCORE_MAX,
        "prime": is_prime(n),
    }


# --------------------------------------------------------------------------- #
# The vectorised score -- the histogram and the census, not the definition
# --------------------------------------------------------------------------- #


def prime_sieve(limit: int) -> np.ndarray:
    """Boolean primality sieve over `[0, limit]`."""
    s = np.ones(limit + 1, dtype=bool)
    s[:2] = False
    for i in range(2, int(limit ** 0.5) + 1):
        if s[i]:
            s[i * i::i] = False
    return s


def sieve_limit_for(hi: int) -> int:
    """How far primality has to be known to score every `n < hi`.

    `2n+1` (Sophie Germain) is the deepest probe; the reversal of a `d`-digit
    number can reach `10^d`, which is the binding term on a short window.
    """
    dmax = len(str(max(hi - 1, 1)))
    return max(2 * hi + 2, 10 ** dmax)


def _vec_valid_date(y, m, d) -> np.ndarray:
    dim = np.array(_DIM, dtype=np.int64)
    mm = np.clip(m, 0, 12)
    lim = dim[mm]
    leap = (y % 4 == 0) & ((y % 100 != 0) | (y % 400 == 0))
    lim = np.where((mm == 2) & leap, 29, lim)
    return (m >= 1) & (m <= 12) & (d >= 1) & (d <= lim)


def _vec_is_square(x: np.ndarray) -> np.ndarray:
    r = np.sqrt(np.maximum(x, 0).astype(np.float64)).astype(np.int64)
    out = np.zeros(x.shape, dtype=bool)
    for c in (r - 1, r, r + 1):
        cc = np.maximum(c, 0)
        out |= (x >= 0) & (cc * cc == x)
    return out


def _vec_is_cube(x: np.ndarray) -> np.ndarray:
    r = np.round(np.maximum(x, 1).astype(np.float64) ** (1 / 3)).astype(np.int64)
    out = np.zeros(x.shape, dtype=bool)
    for c in (r - 1, r, r + 1):
        cc = np.maximum(c, 1)
        out |= (x >= 1) & (cc * cc * cc == x)
    return out


def _vec_is_happy(n: np.ndarray, dmax: int) -> np.ndarray:
    x = n.copy()
    done = np.zeros(n.shape, dtype=bool)
    active = np.ones(n.shape, dtype=bool)
    for _ in range(100):
        hit = active & (x == 1)
        done |= hit
        active &= ~hit
        active &= x != 4
        if not active.any():
            break
        s = np.zeros_like(x)
        t = x.copy()
        for _ in range(max(dmax, 3)):
            dg = t % 10
            s += dg * dg
            t //= 10
        x = np.where(active, s, x)
    return done


def scores_range(lo: int, hi: int, *, sieve=None) -> np.ndarray:
    """`D(n)` -- `scoreOf(n)`, clamped -- for every `n` in `[lo, hi)`, as int64."""
    return np.minimum(_scores_range_raw(lo, hi, sieve=sieve), W.SCORE_MAX)


def factored_scores_range(lo: int, hi: int, *, sieve=None, spf=None) -> np.ndarray:
    """`scoreOfFrom(n, factorize(n))` for every COMPOSITE `n` in `[lo, hi)`, and
    `scoreOf(n)` for primes and 1 (the head mint proves a prime by Miller-Rabin
    and passes no factor list). The factor points are added to the UNCLAMPED
    from-`n` sum and the one clamp is applied over the whole, as the contract
    does. `score_from` is the scalar definition this must reproduce.

    `spf` is a smallest-prime-factor table covering `hi - 1`
    (`tribute.spf_sieve`); built here when not passed.
    """
    from .tribute import spf_sieve

    lo = max(lo, 1)
    n = np.arange(lo, hi, dtype=np.int64)
    if n.size == 0:
        return n
    if spf is None:
        spf = spf_sieve(hi - 1)

    omega = np.zeros_like(n)
    distinct = np.zeros_like(n)
    max_e = np.zeros_like(n)
    min_e = np.full_like(n, 1 << 30)
    exp_gcd = np.zeros_like(n)
    max_p = np.zeros_like(n)
    sigma = np.ones_like(n)
    korselt = np.ones(n.shape, dtype=bool)
    fds = np.zeros_like(n)          # factor digit sum, with multiplicity
    x = n.copy()
    while True:
        live = x > 1
        if not live.any():
            break
        p = np.where(live, spf[np.where(live, x, 0)], 1)
        e = np.zeros_like(n)
        term = np.ones_like(n)
        power = np.ones_like(n)
        div = live.copy()
        while div.any():
            x = np.where(div, x // p, x)
            e += div
            power = np.where(div, power * p, power)
            term += np.where(div, power, 0)
            div = div & (x % p == 0)
        omega += e
        distinct += live
        max_e = np.maximum(max_e, e)
        min_e = np.where(live, np.minimum(min_e, e), min_e)
        exp_gcd = np.where(live, np.gcd(exp_gcd, e), exp_gcd)
        max_p = np.where(live, np.maximum(max_p, p), max_p)   # spf ascends, but be explicit
        sigma *= term
        korselt &= ~live | ((n - 1) % np.maximum(p - 1, 1) == 0)
        pd = np.zeros_like(n)
        t = np.where(live, p, 0)
        while t.any():
            pd += t % 10
            t //= 10
        fds += pd * e

    ds_n = np.zeros_like(n)
    t = n.copy()
    while t.any():
        ds_n += t % 10
        t //= 10

    comp = omega >= 2
    sqf = max_e == 1
    powerful = comp & (min_e >= 2)
    fp = (
        (omega == 2) * P[SEMIPRIME]
        + (comp & (distinct == 1)) * P[PRIME_POWER]
        + (comp & sqf) * P[SQUAREFREE]
        + (comp & sqf & korselt & (distinct >= 3)) * P[CARMICHAEL]
        + (comp & (max_p <= SMOOTH_BOUND)) * P[SMOOTH]
        + ((omega == 3) & (distinct == 3)) * P[SPHENIC]
        + powerful * P[POWERFUL]
        + (powerful & (exp_gcd == 1)) * P[ACHILLES]
        + (comp & (ds_n == fds)) * P[SMITH]
        + (comp & (sigma > 2 * n)) * P[ABUNDANT]
        + (comp & (sigma < 2 * n)) * P[DEFICIENT]
    )
    return np.minimum(_scores_range_raw(lo, hi, sieve=sieve) + fp, W.SCORE_MAX)


def _scores_range_raw(lo: int, hi: int, *, sieve=None) -> np.ndarray:
    """UNCLAMPED `D(n)` for every `n` in `[lo, hi)`, as int64.

    The scalar `score_flags` is the definition and
    `test_desirability.py::test_vectorised_score_agrees_with_the_scalar_definition`
    pins the two together. This exists because the published histogram covers
    10^7 numbers and the rebate sizer weights 10^6 of them, and neither is a
    Python loop over Miller-Rabin anyone will re-run to check the claim.
    """
    lo = max(lo, 1)
    n = np.arange(lo, hi, dtype=np.int64)
    if n.size == 0:
        return n
    # THE INT64 CEILING, made explicit. This function squares `n` in three
    # places -- Fibonacci's 5n^2 +/- 4 since D-99, and N6's automorphic and
    # Kaprekar tests since -- so `hi` cannot approach AUCTIONABLE_MAX here even
    # though the scalar `score_flags` runs to it on Python bigints. The published
    # histogram window tops out at 10^7, and the sieve this needs would not fit
    # in memory long before the arithmetic wrapped, so this guard is a statement
    # of intent rather than a live constraint.
    if (hi - 1) > 1_300_000_000:
        raise ValueError(
            f"scores_range is int64: 5*n*n overflows past ~1.3e9, got hi={hi}. "
            "Use score_flags(n) for a single large n."
        )
    if sieve is None:
        sieve = prime_sieve(sieve_limit_for(hi))

    dmax = len(str(hi - 1))
    pow10 = np.array([10 ** i for i in range(dmax + 2)], dtype=np.int64)
    dig = [(n // pow10[i]) % 10 for i in range(dmax)]      # LSB first
    d = np.zeros_like(n)
    for i in range(dmax):
        d += (n >= pow10[i]).astype(np.int64)

    tz = np.zeros_like(n)
    still = np.ones(n.shape, dtype=bool)
    for i in range(dmax):
        still &= dig[i] == 0
        tz += still.astype(np.int64)

    digit_sum = np.zeros_like(n)
    for i in range(dmax):
        digit_sum += dig[i]

    rev = np.zeros_like(n)
    for i in range(dmax):
        rev += np.where(i < d, dig[i] * pow10[np.clip(d - 1 - i, 0, dmax)], 0)

    same = np.ones(n.shape, dtype=bool)
    asc = np.ones(n.shape, dtype=bool)
    desc = np.ones(n.shape, dtype=bool)
    abab = np.ones(n.shape, dtype=bool)
    for i in range(1, dmax):
        same &= (i >= d) | (dig[i] == dig[0])
    for i in range(dmax - 1):
        active = i < d - 1
        asc &= ~active | (dig[i] == dig[i + 1] + 1)
        desc &= ~active | (dig[i] == dig[i + 1] - 1)
    for i in range(dmax - 2):
        abab &= (i >= d - 2) | (dig[i] == dig[i + 2])
    if dmax >= 4:
        aabb = ((d == 4) & (dig[3] == dig[2]) & (dig[1] == dig[0])
                & (dig[3] != dig[1]))
    else:
        aabb = np.zeros(n.shape, dtype=bool)

    total = W.LEN_W * np.maximum(0, W.LEN_REF - d)

    # DIGIT: the max, in candidate order, ties low.
    tz_capped = np.minimum(tz, W.TZ_CAP)
    candidates = [
        ((d >= 2) & same, np.full(n.shape, P[REPDIGIT], dtype=np.int64)),
        ((d >= 2) & (n == pow10[np.clip(d - 1, 0, dmax)]),
         np.full(n.shape, P[POW10], dtype=np.int64)),
        ((d >= 2) & (rev == n), np.full(n.shape, P[PALINDROME], dtype=np.int64)),
        ((d >= 3) & (asc | desc), np.full(n.shape, P[RUN], dtype=np.int64)),
        (((d >= 4) & (d % 2 == 0) & abab) | aabb,
         np.full(n.shape, P[ABAB], dtype=np.int64)),
        (tz_capped > 0, P[TRAILING_ZEROS] * tz_capped),
    ]
    best = np.zeros(n.shape, dtype=np.int64)
    for mask, pts in candidates:
        take = mask & (pts > best)
        best = np.where(take, pts, best)
    total += best

    # LIFE
    if dmax >= 8:
        y8 = n // 10000
        md = n % 10000
        ymd = ((d == 8) & (y8 >= YEAR_LO) & (y8 <= YEAR_HI)
               & _vec_valid_date(y8, md // 100, md % 100))
        y_tail = n % 10000
        f1 = n // 1000000
        f2 = (n // 10000) % 100
        dmy = ((d == 8) & ~ymd & (y_tail >= YEAR_LO) & (y_tail <= YEAR_HI)
               & (_vec_valid_date(y_tail, f2, f1) | _vec_valid_date(y_tail, f1, f2)))
        total += ymd * P[YYYYMMDD] + dmy * P[DMY8]
    if dmax >= 6:
        y2k = np.full(n.shape, 2000, dtype=np.int64)
        total += ((d == 6) & _vec_valid_date(y2k, (n // 100) % 100, n % 100)) * P[YYMMDD]
    if dmax >= 4:
        y2k = np.full(n.shape, 2000, dtype=np.int64)
        total += ((d == 4) & (n >= YEAR_LO) & (n <= YEAR_HI)) * P[YEAR]
        p1, p2 = n // 100, n % 100
        total += ((d == 4) & (_vec_valid_date(y2k, p1, p2)
                              | _vec_valid_date(y2k, p2, p1))) * P[MMDD]

    # FORM
    prime = sieve[n]
    total += prime * P[PRIME]
    total += (prime & (n >= 3) & (((n + 1) & n) == 0)) * P[MERSENNE]
    total += (prime & np.isin(n, sorted(FERMAT_PRIMES))) * P[FERMAT]
    total += (prime & (sieve[np.maximum(n - 2, 0)] | sieve[n + 2])) * P[TWIN]
    total += (prime & sieve[2 * n + 1]) * P[SOPHIE_GERMAIN]
    total += (prime & (n > 2) & sieve[np.maximum((n - 1) // 2, 0)]) * P[SAFE_PRIME]
    total += (prime & (rev != n) & sieve[rev]) * P[EMIRP]
    total += np.isin(n, sorted(PERFECT_NUMBERS)) * P[PERFECT]
    total += np.isin(n, list(PRIMORIALS)) * P[PRIMORIAL]
    total += np.isin(n, sorted(FACTORIALS)) * P[FACTORIAL]
    total += ((n >= 2) & ((n & (n - 1)) == 0)) * P[POW2]
    total += (_vec_is_square(5 * n * n + 4)
              | _vec_is_square(5 * n * n - 4)) * P[FIBONACCI]
    total += (_vec_is_square(5 * n * n + 20)
              | _vec_is_square(5 * n * n - 20)) * P[LUCAS]
    # PRONIC: n = r(r+1) for r = floor(sqrt(n)); `_vec_is_square(4n + 1)` is the
    # same fact (4r(r+1) + 1 = (2r+1)^2) without a second root helper.
    total += ((n >= 2) & _vec_is_square(4 * n + 1)) * P[PRONIC]
    total += _vec_is_cube(n) * P[CUBE]
    total += _vec_is_square(n) * P[SQUARE]
    total += _vec_is_square(8 * n + 1) * P[TRIANGULAR]
    total += ((digit_sum > 0) & (n % np.maximum(digit_sum, 1) == 0)) * P[HARSHAD]
    total += _vec_is_happy(n, dmax) * P[HAPPY]
    total += sieve[np.minimum(digit_sum, sieve.size - 1)] * P[DIGITSUM_PRIME]

    # ---- N6's eight from-`n` categories (bits 40..47). CARMICHAEL (39) is
    # factor-derived and this function, like `score_flags`, never sets it.
    #
    # SUMMED, not folded into the DIGIT maximum above: that max is over a fixed
    # set of six bits, not over a group, so a pandigital number keeps whichever
    # of the six it also won.
    nsq = n * n
    p10_d = pow10[np.clip(d, 0, dmax + 1)]
    k_low = nsq % p10_d
    total += ((k_low == n) & (d >= 1)) * P[AUTOMORPHIC]
    total += ((k_low > 0) & (k_low + nsq // p10_d == n)) * P[KAPREKAR]
    total += (_vec_is_square(n) & _vec_is_square(8 * n + 1)) * P[SQUARE_TRIANGULAR]
    total += np.isin(n, sorted(HIGHLY_COMPOSITE_NUMBERS)) * P[HIGHLY_COMPOSITE]
    total += np.isin(n, sorted(CATALAN_NUMBERS)) * P[CATALAN]

    # PANDIGITAL: a ten-bit mask of which digits occurred, which is all "each
    # exactly once" needs once `d == 10` has fixed the count.
    dmask = np.zeros_like(n)
    for i in range(dmax):
        dmask |= np.where(i < d, np.left_shift(1, dig[i]), 0)
    total += ((d == 10) & (dmask == 0x3FF)) * P[PANDIGITAL]

    # NARCISSISTIC: sum of each digit raised to the digit COUNT. The inner loop
    # is a per-element exponentiation by a per-element power, so it is written as
    # `dmax` masked multiplies -- 9^14 is 2.3e13 and cannot overflow int64 even
    # when a short number's transient product is carried through the tail of the
    # loop and then discarded.
    narc = np.zeros_like(n)
    for i in range(dmax):
        power = np.ones_like(n)
        for k in range(dmax):
            power = np.where(k < d, power * dig[i], power)
        narc += np.where(i < d, power, 0)
    total += ((d >= 2) & (narc == n)) * P[NARCISSISTIC]

    # KEITH: the d-term recurrence seeded by the digits. `hist[j]` is the j-th
    # most recent term, so `hist[j] = dig[j]` at the start puts the LSB newest
    # and the leading digit oldest, exactly as the contract's ring buffer does.
    # Terms ascend, so an element that passes `n` is finished: it is zeroed,
    # which both proves the failure and keeps the running sums from overflowing
    # in the steps the still-live elements need.
    keith = np.zeros(n.shape, dtype=bool)
    if dmax >= 2:
        alive = d >= 2
        hist = [np.where((j < d) & alive, dig[j], 0) for j in range(dmax)]
        for _ in range(200):
            nxt = np.zeros_like(n)
            for j in range(dmax):
                nxt += np.where(j < d, hist[j], 0)
            nxt = np.where(alive, nxt, 0)
            keith |= alive & (nxt == n)
            alive = alive & (nxt < n)
            if not alive.any():
                break
            hist = [nxt] + hist[:-1]
    total += keith * P[KEITH]

    total += np.isin(n, sorted(ICONIC_NUMBERS)) * P[ICONIC]
    total += np.isin(n, sorted(LISTED_NUMBERS)) * P[LISTED]
    total += (prime & np.isin(n, sorted(LANDMARK_PRIMES))) * P[LANDMARK]
    total += np.isin(n, sorted(CONSTANT_TRUNCATIONS)) * P[CONSTANT]

    return total


def histogram(lo: int = WINDOW_LO, hi: int = WINDOW_HI, *,
              chunk: int = 500_000) -> dict:
    """Exhaustive `D(n)` histogram over `[lo, hi)`, plus the mean.

    Published so that "what does an ordinary number score" is a stated figure
    rather than a surprise the first buyer discovers (owner answer 6: a number
    with no category at all should be rare).
    """
    sieve = prime_sieve(sieve_limit_for(hi))
    counts = {}
    total = 0
    n_count = 0
    for start in range(lo, hi, chunk):
        stop = min(start + chunk, hi)
        s = scores_range(start, stop, sieve=sieve)
        vals, cnt = np.unique(s, return_counts=True)
        for v, c in zip(vals.tolist(), cnt.tolist()):
            counts[v] = counts.get(v, 0) + c
        total += int(s.sum())
        n_count += stop - start
    bands = {"0": 0, "1-10": 0, "11-30": 0, "31+": 0}
    for v, c in counts.items():
        key = "0" if v == 0 else "1-10" if v <= 10 else "11-30" if v <= 30 else "31+"
        bands[key] += c
    return {
        "window": [lo, hi],
        "count": n_count,
        "mean_score": total / n_count,
        "max_score": max(counts),
        "share_scoring_zero": counts.get(0, 0) / n_count,
        "bands": {k: {"count": v, "share": v / n_count} for k, v in bands.items()},
        "counts_by_score": {str(k): counts[k] for k in sorted(counts)},
        "_max_score_note": (
            "REALISED maximum over this window, not the clamp. The clamp is "
            f"SCORE_MAX = {W.SCORE_MAX}, which IS owner answer 9's 420 GRAM "
            "ceiling: MINT_PRICE * 2^(87/10) = 415.9 GRAM on the shipped ladder. "
            "Only a number that is rare in three ways at once reaches it, which "
            "is answer 9 as a measurement rather than a claim."
        ),
    }


# --------------------------------------------------------------------------- #
# The params.json block
# --------------------------------------------------------------------------- #

#: SS1.4's worked examples, the same rows `SpecialNumbers.spec.ts` regenerates
#: from the contract. Emitted computed, never transcribed.
WORKED_EXAMPLES = (2, 3, 5, 42, 420, 777, 1111, 1337, 1729, 1972, 2027, 7919,
                   8191, 10000, 720909, 999983, 19720909, 20201207, 12072020,
                   20240229, 20240230, 123456, 738491, 1000003)


def desirability_block(*, lo: int = WINDOW_LO, hi: int = WINDOW_HI) -> dict:
    """The `score` block of `shared/params.json` (D-99).

    The weights are **owner-declared**, parsed from `shared/opcodes.ts`; the
    histogram and the worked examples are computed here. Nothing in this block
    is a chosen number: rule 3's line runs between the two halves and the
    `_provenance` fields say which is which.
    """
    return {
        "_provenance": "owner-declared (D-99)",
        "_source": "sim/primes_sim/desirability.py, weights parsed from shared/opcodes.ts",
        "_decision": "D-99",
        "_formula": (
            "D(n) = clamp(LEN + max(DIGIT) + LIFE + sum(FORM) + CULTURE + "
            "POSITION, 0, SCORE_MAX). LEN pays LEN_W*(LEN_REF - digits) while "
            "digits < LEN_REF; the six DIGIT patterns take a MAX because they "
            "imply one another; everything else sums. SCORE_MAX = 87 IS owner "
            "answer 9's 420 GRAM ceiling: the ladder tops out at "
            "MINT_PRICE * 2^(87/10) = 415.9 GRAM."
        ),
        "weights": {
            "LEN_REF": W.LEN_REF, "LEN_W": W.LEN_W, "TZ_CAP": W.TZ_CAP,
            "SCORE_MAX": W.SCORE_MAX,
            "bits": [
                {"bit": i, "key": k, "group": g, "points": p}
                for i, (k, g, p) in enumerate(zip(W.keys, W.groups, W.points))
            ],
        },
        "_weights_provenance": (
            "OWNER-DECLARED (D-99 SS1.3, owner answers 3/6/10 signed 2026-09-04). "
            "The sim does not fit these and must not be read as having chosen "
            "them (CLAUDE.md rule 3). They are parsed out of shared/opcodes.ts's "
            "SCORE_BITS/SCORE_TERMS at generation time so the sim, the contract "
            "and the webapp cannot drift. What the SIM owns is the distribution "
            "they induce (`histogram`) and the two rebate rates that "
            "distribution sizes (genesis.score_rebate)."
        ),
        "_score_consumers": {
            "p0": "P0(n) = max(LOT_FLOOR, MINT_PRICE * 2^(D(n)/SCORE_HALVING), "
                  "1.5*NPV(n) if prime) -- trophy_auction.price_map",
            "rebate": "REBATE_PER_POINT * D(n) on a head-minted composite -- "
                      "genesis.score_rebate",
            "min_bid_increment": "a step function of D(n)//SCORE_HALVING -- "
                                 "acquisition.bid_increment_ladder",
        },
        "rebate_family": {
            "_provenance": "owner-declared (D-96, narrowed by D-99 SS1.5)",
            "DIRICHLET_MIN_N": DIRICHLET_MIN_N,
            "DIRICHLET_MOD": DIRICHLET_MOD,
            "_note": (
                "p > 100,000 and p = 1 (mod 101). D-99 strips this family of its "
                "rarity meaning: it is not a bit, it adds no points and it lifts "
                "no price. It selects a REBATE and nothing else."
            ),
        },
        "histogram": histogram(lo, hi),
        "worked_examples": [explain(n) for n in WORKED_EXAMPLES],
    }
