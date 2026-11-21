"""The prime taxonomy: every named class of prime, computed over the number line.

This is the data layer under CONCEPT.md's auction reserves (SS6) and the
reservation premium (SS4.4). It answers one question for every prime p below a
horizon: *what is this prime, mathematically*, and therefore *how rare is it*.

Three things live here:

  * `TAGS` -- the registry. One entry per named class: its family, its
    definition, its OEIS A-number, and whether the computation is exhaustive or
    a curated list of the only known members.
  * `tag_primes` -- one sweep producing a bitmask per prime.
  * `surprisal_bits` -- the empirical rarity of each tag, measured against
    pi(N) rather than asserted. This is what makes the price model defensible:
    no tag's weight is a taste judgement, it is -log2 of how often the tag
    actually occurs below the horizon.

Deliberately *not* here: the vanity layer (`vanity.py`) and the price
assembly (`pricing.py`). Rarity is a fact about the number line; desirability
is a fact about people; price is a decision that combines them. Keeping the
three in separate modules keeps the arguments about the third from
contaminating the first.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

# ---------------------------------------------------------------- registry


@dataclass(frozen=True)
class Tag:
    key: str
    family: str
    label: str
    definition: str
    oeis: str | None = None
    # Exhaustive below this bound; None means "exhaustive everywhere we sweep".
    # A curated tag carries the only members known to mathematics, which is a
    # *stronger* claim than exhaustive-below-N, and the registry says which.
    curated: bool = False
    members: tuple[int, ...] = field(default=(), repr=False)


FAMILIES = (
    "gap",       # where p sits relative to its neighbours
    "chain",     # p's position in a Cunningham/Sophie Germain chain
    "form",      # p is the value of a named algebraic form
    "digit",     # base-10 surface structure
    "index",     # a property of p's ordinal, not its value
    "deep",      # rare congruence / open-problem classes
    "protocol",  # meaning inside TON PRIMES itself
)

# Curated member lists: classes where the complete set known to mathematics is
# small. Listing them is not an approximation, it is the state of the art.
_MERSENNE_EXPONENTS = (
    2, 3, 5, 7, 13, 17, 19, 31, 61, 89, 107, 127, 521, 607, 1279, 2203, 2281,
    3217, 4253, 4423, 9689, 9941, 11213, 19937, 21701, 23209, 44497, 86243,
    110503, 132049, 216091, 756839, 859433,
)
_WIEFERICH = (1093, 3511)
_WILSON = (5, 13, 563)
_WOLSTENHOLME = (16843, 2124679)
_WALL_SUN_SUN: tuple[int, ...] = ()
_STERN = (2, 3, 17, 137, 227, 977, 1187, 1493)
_UNIQUE_PERIOD = (3, 11, 37, 101, 9091, 9901, 333667, 909091)
_FORTUNATE = (3, 5, 7, 13, 23, 17, 19, 23, 37, 61, 67, 61, 71, 47, 107, 59,
              61, 109, 89, 103, 79, 151, 197, 101, 103, 233, 223, 127, 223,
              191, 163, 229, 643, 239, 157, 167, 439, 239, 199, 191, 199, 383,
              233, 751, 313, 773, 607, 389, 337, 293, 641)
_IRREGULAR_LT_2000 = (
    37, 59, 67, 101, 103, 131, 149, 157, 233, 257, 263, 271, 283, 293, 307,
    311, 347, 353, 379, 389, 401, 409, 421, 433, 461, 463, 467, 491, 523, 541,
    547, 557, 577, 587, 593, 607, 613, 617, 619, 631, 647, 653, 659, 673, 677,
    683, 691, 727, 751, 757, 761, 773, 797, 809, 811, 821, 827, 839, 877, 881,
    887, 929, 953, 971, 1061, 1091, 1117, 1129, 1151, 1153, 1193, 1201, 1217,
    1229, 1237, 1279, 1283, 1291, 1297, 1301, 1307, 1319, 1327, 1367, 1381,
    1409, 1429, 1439, 1483, 1499, 1523, 1559, 1597, 1609, 1613, 1619, 1621,
    1637, 1663, 1669, 1721, 1733, 1753, 1759, 1777, 1783, 1789, 1811, 1831,
    1847, 1861, 1867, 1871, 1877, 1879, 1889, 1901, 1933, 1951, 1979, 1987,
    1993, 1997, 1999,
)

TAGS: tuple[Tag, ...] = (
    # ---- gap -----------------------------------------------------------
    Tag("twin", "gap", "Twin prime", "p-2 or p+2 is prime.", "A001097"),
    Tag("cousin", "gap", "Cousin prime", "p-4 or p+4 is prime.", "A023200"),
    Tag("sexy", "gap", "Sexy prime", "p-6 or p+6 is prime.", "A023201"),
    Tag("triplet", "gap", "Prime triplet",
        "p is a member of a (p, p+2, p+6) or (p, p+4, p+6) triplet.", "A098414"),
    Tag("quadruplet", "gap", "Prime quadruplet",
        "p is a member of a (p, p+2, p+6, p+8) quadruplet.", "A007530"),
    Tag("quintuplet", "gap", "Prime quintuplet",
        "p is a member of a densest admissible 5-tuple.", "A022008"),
    Tag("sextuplet", "gap", "Prime sextuplet",
        "p is a member of a (p, p+4, p+6, p+10, p+12, p+16) sextuplet.", "A022008"),
    Tag("balanced", "gap", "Balanced prime",
        "p is the arithmetic mean of its neighbouring primes.", "A006562"),
    Tag("isolated", "gap", "Isolated prime",
        "neither p-2 nor p+2 is prime.", "A007510"),
    Tag("gap_record", "gap", "Maximal-gap prime",
        "p opens a prime gap larger than every gap before it.", "A002386"),
    Tag("strong", "gap", "Strong prime",
        "p exceeds the mean of its neighbouring primes.", "A051634"),
    Tag("weak", "gap", "Weak prime",
        "p falls below the mean of its neighbouring primes.", "A051635"),
    Tag("good", "gap", "Good prime",
        "p_n^2 > p_(n-i)*p_(n+i) for every i in [1, n-1].", "A028388"),

    # ---- chain ---------------------------------------------------------
    Tag("sophie_germain", "chain", "Sophie Germain prime",
        "2p+1 is also prime.", "A005384"),
    Tag("safe", "chain", "Safe prime", "(p-1)/2 is also prime.", "A005385"),
    Tag("cunningham3", "chain", "Cunningham chain (length 3)",
        "p starts a chain p, 2p+1, 4p+3 of primes.", "A005602"),
    Tag("cunningham4", "chain", "Cunningham chain (length 4+)",
        "p starts a Cunningham chain of the first kind of length at least 4.", "A005603"),

    # ---- form ----------------------------------------------------------
    Tag("mersenne", "form", "Mersenne prime", "p = 2^k - 1.", "A000668"),
    Tag("mersenne_exponent", "form", "Mersenne exponent",
        "2^p - 1 is prime. Only 52 are known; this lists those below the horizon.",
        "A000043", curated=True, members=_MERSENNE_EXPONENTS),
    Tag("fermat", "form", "Fermat prime", "p = 2^(2^k) + 1. Only five are known.", "A019434"),
    Tag("double_mersenne", "form", "Double Mersenne prime",
        "p = 2^(2^k - 1) - 1.", "A077586"),
    Tag("wagstaff", "form", "Wagstaff prime", "p = (2^q + 1)/3.", "A000979"),
    Tag("proth", "form", "Proth prime", "p = k*2^n + 1 with k odd and k < 2^n.", "A080076"),
    Tag("thabit", "form", "Thabit prime", "p = 3*2^n - 1.", "A007505"),
    Tag("cullen", "form", "Cullen prime", "p = n*2^n + 1.", "A005849"),
    Tag("woodall", "form", "Woodall prime", "p = n*2^n - 1.", "A050918"),
    Tag("factorial", "form", "Factorial prime", "p = n! +/- 1.", "A088054"),
    Tag("primorial", "form", "Primorial prime", "p = q# +/- 1.", "A228486"),
    Tag("pierpont", "form", "Pierpont prime", "p = 2^u * 3^v + 1.", "A005109"),
    Tag("cuban", "form", "Cuban prime",
        "p = (x^3 - y^3)/(x - y) with y = x - 1 or y = x - 2.", "A002407"),
    Tag("quartan", "form", "Quartan prime", "p = x^4 + y^4.", "A002645"),
    Tag("star", "form", "Star prime", "p = 6n(n-1) + 1.", "A083577"),
    Tag("centered_square", "form", "Centered square prime", "p = n^2 + (n+1)^2.", "A027862"),
    Tag("centered_triangular", "form", "Centered triangular prime",
        "p = (3n^2 + 3n + 2)/2.", "A125602"),
    Tag("fibonacci", "form", "Fibonacci prime", "p is a Fibonacci number.", "A005478"),
    Tag("lucas", "form", "Lucas prime", "p is a Lucas number.", "A005479"),
    Tag("pell", "form", "Pell prime", "p is a Pell number.", "A086383"),
    Tag("motzkin", "form", "Motzkin prime", "p is a Motzkin number.", "A092832"),
    Tag("bell", "form", "Bell prime", "p is a Bell number.", "A051131"),
    Tag("nsw", "form", "Newman-Shanks-Williams prime",
        "p is an NSW number.", "A088165"),
    Tag("repunit", "form", "Repunit prime", "p is a base-10 repunit.", "A004022"),
    Tag("pythagorean", "form", "Pythagorean prime",
        "p = 4k + 1; equivalently p is a sum of two squares.", "A002144"),
    Tag("gaussian_inert", "form", "Gaussian prime",
        "p = 4k + 3; p stays prime in Z[i].", "A002145"),
    Tag("eisenstein_inert", "form", "Eisenstein prime",
        "p = 3k + 2; p stays prime in the Eisenstein integers.", "A003627"),

    # ---- digit ---------------------------------------------------------
    Tag("palindrome", "digit", "Palindromic prime", "p reads the same reversed.", "A002385"),
    Tag("emirp", "digit", "Emirp", "p reversed is a different prime.", "A006567"),
    Tag("circular", "digit", "Circular prime",
        "every cyclic rotation of p's digits is prime.", "A068652"),
    Tag("permutable", "digit", "Permutable prime",
        "every permutation of p's digits is prime.", "A003459"),
    Tag("left_truncatable", "digit", "Left-truncatable prime",
        "deleting leading digits one at a time leaves a prime every time.", "A024785"),
    Tag("right_truncatable", "digit", "Right-truncatable prime",
        "deleting trailing digits one at a time leaves a prime every time.", "A024770"),
    Tag("two_sided", "digit", "Two-sided prime",
        "left- and right-truncatable at once. Exactly 15 exist.", "A020994"),
    Tag("strobogrammatic", "digit", "Strobogrammatic prime",
        "p reads the same rotated 180 degrees.", "A007597"),
    Tag("repdigit", "digit", "Repdigit prime", "all of p's digits are equal.", "A004022"),
    Tag("prime_digits", "digit", "Prime-digit prime",
        "every digit of p is itself prime (2, 3, 5, 7).", "A019546"),
    Tag("additive", "digit", "Additive prime", "p's digit sum is prime.", "A046704"),
    Tag("happy", "digit", "Happy prime",
        "iterating sum-of-squared-digits from p reaches 1.", "A035497"),
    Tag("delicate", "digit", "Delicate prime",
        "changing any single digit of p produces a composite.", "A050249"),
    Tag("undulating", "digit", "Undulating prime",
        "p's digits alternate ababab... with a != b.", "A032758"),
    Tag("plateau", "digit", "Plateau prime",
        "p's interior digits are equal and exceed its equal end digits.", "A032758"),
    Tag("depression", "digit", "Depression prime",
        "p's interior digits are equal and fall below its equal end digits.", "A032759"),

    # ---- index ---------------------------------------------------------
    Tag("super_prime", "index", "Super-prime",
        "p is the n-th prime and n is itself prime.", "A006450"),
    Tag("ramanujan", "index", "Ramanujan prime",
        "the smallest R with pi(x) - pi(x/2) >= n for all x >= R.", "A104272"),
    Tag("chen", "index", "Chen prime",
        "p + 2 is prime or a product of two primes.", "A109611"),
    Tag("lucky", "index", "Lucky prime",
        "p survives the lucky-number sieve as well as the prime sieve.", "A031157"),
    Tag("index_power_of_ten", "index", "Decade prime",
        "p is the 10^k-th prime.", None),
    Tag("first_of_width", "index", "First prime of its digit width",
        "p is the smallest prime with its number of digits.", "A003617"),
    Tag("last_of_width", "index", "Last prime of its digit width",
        "p is the largest prime with its number of digits.", "A003618"),

    # ---- deep ----------------------------------------------------------
    Tag("wieferich", "deep", "Wieferich prime",
        "2^(p-1) = 1 mod p^2. Only two are known below 2^64.",
        "A001220", curated=True, members=_WIEFERICH),
    Tag("wilson", "deep", "Wilson prime",
        "(p-1)! = -1 mod p^2. Only three are known.",
        "A007540", curated=True, members=_WILSON),
    Tag("wolstenholme", "deep", "Wolstenholme prime",
        "binomial(2p-1, p-1) = 1 mod p^4. Only two are known.",
        "A088164", curated=True, members=_WOLSTENHOLME),
    Tag("wall_sun_sun", "deep", "Wall-Sun-Sun prime",
        "p^2 divides the Fibonacci number F(p - (5|p)). None is known to exist.",
        "A244801", curated=True, members=_WALL_SUN_SUN),
    Tag("stern", "deep", "Stern prime",
        "p is not the sum of a smaller prime and twice a nonzero square.",
        "A042978", curated=True, members=_STERN),
    Tag("unique_period", "deep", "Unique-period prime",
        "no other prime shares the period length of 1/p.",
        "A040017", curated=True, members=_UNIQUE_PERIOD),
    Tag("fortunate", "deep", "Fortunate prime",
        "p is the Fortunate number of some primorial.",
        "A005235", curated=True, members=tuple(sorted(set(_FORTUNATE)))),
    Tag("irregular", "deep", "Irregular prime",
        "p divides the numerator of some Bernoulli number B_2k, 2k < p - 1.",
        "A000928", curated=True, members=_IRREGULAR_LT_2000),
    Tag("full_reptend", "deep", "Full reptend prime",
        "10 is a primitive root mod p; 1/p has maximal period p - 1.", "A001913"),

    # ---- protocol ------------------------------------------------------
    Tag("era_generator", "protocol", "Era generator",
        "p generates a primorial era boundary (CONCEPT.md SS7).", None),
)

TAG_INDEX = {t.key: i for i, t in enumerate(TAGS)}
TAG_BY_KEY = {t.key: t for t in TAGS}


# ---------------------------------------------------------------- sieves


def sieve(n_max: int) -> np.ndarray:
    """Boolean primality array over [0, n_max]."""
    s = np.ones(n_max + 1, dtype=bool)
    s[:2] = False
    for i in range(2, int(n_max ** 0.5) + 1):
        if s[i]:
            s[i * i:: i] = False
    return s


def omega_sieve(n_max: int) -> np.ndarray:
    """Omega(n) -- prime factors with multiplicity. Used for the Chen test."""
    om = np.zeros(n_max + 1, dtype=np.int8)
    prime = sieve(n_max)
    for p in range(2, n_max + 1):
        if not prime[p]:
            continue
        k = p
        while True:
            om[k:: k] += 1
            if k > n_max // p:
                break
            k *= p
    return om


def _lucky_numbers(n_max: int) -> np.ndarray:
    """The lucky-number sieve: survivors of repeated positional deletion."""
    nums = np.arange(1, n_max + 1, 2, dtype=np.int64)
    i = 1
    while i < len(nums):
        step = int(nums[i])
        if step > len(nums):
            break
        keep = np.ones(len(nums), dtype=bool)
        keep[step - 1:: step] = False
        nums = nums[keep]
        i += 1
    out = np.zeros(n_max + 1, dtype=bool)
    out[nums] = True
    return out


def _ramanujan(n_max: int, is_prime: np.ndarray) -> np.ndarray:
    """R_n = 1 + max{x : pi(x) - pi(x/2) < n}. Computed in one pass over c(x)."""
    pi = np.cumsum(is_prime)
    x = np.arange(n_max + 1)
    c = pi - pi[x // 2]
    cmax = int(c.max())
    last = np.zeros(cmax + 2, dtype=np.int64)
    np.maximum.at(last, c, x)   # last[v] = largest x with c(x) = v
    # lastbelow[n] = max over v < n of last[v]
    running = 0
    out = np.zeros(n_max + 1, dtype=bool)
    for n in range(1, cmax + 2):
        running = max(running, int(last[n - 1]))
        r = running + 1
        if r <= n_max:
            out[r] = True
    return out


# ---------------------------------------------------------------- helpers


_STROBO = {"0": "0", "1": "1", "8": "8", "6": "9", "9": "6"}


def _is_strobogrammatic(n: int) -> bool:
    s = str(n)
    if any(ch not in _STROBO for ch in s):
        return False
    return "".join(_STROBO[ch] for ch in reversed(s)) == s


def _is_happy(n: int) -> bool:
    seen = set()
    while n != 1 and n not in seen:
        seen.add(n)
        n = sum(int(c) ** 2 for c in str(n))
    return n == 1


def _multiplicative_order_10(p: int, spf: np.ndarray) -> int:
    """ord_p(10) via the factorization of p - 1."""
    if p in (2, 5):
        return 0
    m = p - 1
    order = m
    x = m
    factors = set()
    while x > 1:
        q = int(spf[x])
        factors.add(q)
        while x % q == 0:
            x //= q
    for q in factors:
        while order % q == 0 and pow(10, order // q, p) == 1:
            order //= q
    return order


def _spf_sieve(n_max: int) -> np.ndarray:
    spf = np.arange(n_max + 1, dtype=np.int64)
    for i in range(2, int(n_max ** 0.5) + 1):
        if spf[i] == i:
            blk = spf[i * i:: i]
            np.minimum(blk, i, out=blk)
    return spf


# ---------------------------------------------------------------- the sweep


def tag_primes(table_max: int, prime_max: int | None = None,
               era_generators=(2, 3, 5, 7, 11, 13, 17)) -> dict:
    """Compute the tag bitmask for every prime p <= table_max.

    `prime_max` (default 2*table_max + 2) bounds the primality array, which
    has to reach past the table so that 2p+1 and Cunningham chains can be
    tested without a separate primality routine.

    Returns {"primes": int64[], "mask": uint64[]|object[], "table_max": int}.
    """
    if prime_max is None:
        # 8p + 7 is the deepest lookup (a length-4 Cunningham chain), and the
        # permutations of a 6-digit prime never exceed 999_999.
        prime_max = 8 * table_max + 16

    is_prime = sieve(prime_max)
    spf = _spf_sieve(max(table_max + 2, 1024))
    primes = np.nonzero(is_prime[:table_max + 1])[0].astype(np.int64)
    n = len(primes)
    pset = set(int(x) for x in primes)

    nbits = len(TAGS)
    masks = [0] * n

    def setbit(i: int, key: str) -> None:
        masks[i] |= 1 << TAG_INDEX[key]

    # --- precomputed member sets for form tags --------------------------
    def _seq(gen) -> set[int]:
        return {v for v in gen if 2 <= v <= table_max}

    def _fib():
        a, b = 1, 2
        while a <= table_max:
            yield a
            a, b = b, a + b

    def _lucas():
        a, b = 2, 1
        while a <= table_max:
            yield a
            a, b = b, a + b

    def _pell():
        a, b = 1, 2
        while a <= table_max:
            yield a
            a, b = b, 2 * b + a

    def _motzkin():
        m = [1, 1]
        while m[-1] <= table_max:
            k = len(m) - 1
            m.append(((2 * k + 3) * m[-1] + 3 * k * m[-2]) // (k + 3))
        return m

    def _bell():
        row = [1]
        out = [1]
        while out[-1] <= table_max:
            nxt = [row[-1]]
            for v in row:
                nxt.append(nxt[-1] + v)
            row = nxt
            out.append(row[0])
        return out

    def _nsw():
        a, b = 1, 1
        while a <= table_max:
            yield a
            a, b = b, 2 * b + a

    fib, luc, pel = _seq(_fib()), _seq(_lucas()), _seq(_pell())
    mot, bel, nsw = _seq(_motzkin()), _seq(_bell()), _seq(_nsw())

    mersenne = _seq((1 << k) - 1 for k in range(2, 32))
    fermat = _seq((1 << (1 << k)) + 1 for k in range(0, 6))
    dbl_mers = _seq((1 << ((1 << k) - 1)) - 1 for k in range(1, 6))
    thabit = _seq(3 * (1 << k) - 1 for k in range(0, 32))
    cullen = _seq(k * (1 << k) + 1 for k in range(1, 32))
    woodall = _seq(k * (1 << k) - 1 for k in range(1, 32))

    def _factorials():
        f, k = 1, 1
        while f <= table_max + 1:
            yield f - 1
            yield f + 1
            k += 1
            f *= k
    factorial = _seq(_factorials())

    def _primorials():
        pr = 1
        for q in range(2, table_max + 1):
            if q < len(spf) and spf[q] == q:
                pr *= q
                if pr > table_max + 1:
                    break
                yield pr - 1
                yield pr + 1
    primorial = _seq(_primorials())

    pierpont = _seq(
        (2 ** u) * (3 ** v) + 1
        for u in range(0, 32) for v in range(0, 22)
        if (2 ** u) * (3 ** v) <= table_max
    )
    cuban = _seq(
        3 * x * x + 3 * x + 1 for x in range(0, int(table_max ** 0.5) + 2)
    ) | _seq(
        3 * x * x + 6 * x + 4 for x in range(0, int(table_max ** 0.5) + 2)
    )
    quartan = _seq(
        a ** 4 + b ** 4
        for a in range(1, int(table_max ** 0.25) + 2)
        for b in range(1, int(table_max ** 0.25) + 2)
    )
    star = _seq(6 * k * (k - 1) + 1 for k in range(1, int(table_max ** 0.5) + 2))
    csq = _seq(k * k + (k + 1) ** 2 for k in range(0, int(table_max ** 0.5) + 2))
    ctri = _seq((3 * k * k + 3 * k + 2) // 2 for k in range(0, int(table_max ** 0.5) + 2))
    wagstaff = _seq((2 ** q + 1) // 3 for q in range(3, 32) if (2 ** q + 1) % 3 == 0)
    repunit = _seq((10 ** k - 1) // 9 for k in range(2, 8))
    repdigit = _seq(d * (10 ** k - 1) // 9 for k in range(2, 8) for d in range(1, 10))

    lucky = _lucky_numbers(table_max)
    raman = _ramanujan(table_max, is_prime[:table_max + 1])
    om = omega_sieve(table_max + 4)

    curated = {t.key: set(t.members) for t in TAGS if t.curated}

    # --- gap-structure prerequisites ------------------------------------
    prev_p = np.empty(n, dtype=np.int64)
    next_p = np.empty(n, dtype=np.int64)
    prev_p[0] = 0
    prev_p[1:] = primes[:-1]
    next_p[:-1] = primes[1:]
    # the prime after the table's last one, so the final row is not a special case
    tail = table_max + 1
    while not is_prime[tail]:
        tail += 1
    next_p[-1] = tail

    max_gap = 0
    ten_pow = {10 ** k for k in range(0, 8)}
    width_first: dict[int, int] = {}
    width_last: dict[int, int] = {}

    for i in range(n):
        p = int(primes[i])
        s = str(p)
        d = len(s)
        width_first.setdefault(d, p)
        width_last[d] = p

    for i in range(n):
        p = int(primes[i])
        s = str(p)
        d = len(s)
        dig = [int(c) for c in s]

        # ---- gap
        pv, nx = int(prev_p[i]), int(next_p[i])
        tw = (p > 2 and is_prime[p - 2]) or is_prime[p + 2]
        if tw:
            setbit(i, "twin")
        else:
            setbit(i, "isolated")
        if (p > 4 and is_prime[p - 4]) or is_prime[p + 4]:
            setbit(i, "cousin")
        if (p > 6 and is_prime[p - 6]) or is_prime[p + 6]:
            setbit(i, "sexy")
        if pv and nx and p - pv == nx - p:
            setbit(i, "balanced")
        elif pv and nx:
            if 2 * p > pv + nx:
                setbit(i, "strong")
            else:
                setbit(i, "weak")
        if pv and p - pv > max_gap:
            max_gap = p - pv
            setbit(i, "gap_record")

        # triplets / quadruplets / larger constellations, membership not just start
        for off in (0, 2, 6):
            b = p - off
            if b >= 2 and is_prime[b] and is_prime[b + 2] and is_prime[b + 6]:
                setbit(i, "triplet")
                break
        else:
            for off in (0, 4, 6):
                b = p - off
                if b >= 2 and is_prime[b] and is_prime[b + 4] and is_prime[b + 6]:
                    setbit(i, "triplet")
                    break
        for off in (0, 2, 6, 8):
            b = p - off
            if b >= 2 and is_prime[b] and is_prime[b + 2] and is_prime[b + 6] and is_prime[b + 8]:
                setbit(i, "quadruplet")
                break
        for off in (0, 2, 6, 8, 12):
            b = p - off
            if b >= 2 and all(is_prime[b + k] for k in (0, 2, 6, 8, 12)):
                setbit(i, "quintuplet")
                break
        for off in (0, 4, 6, 10, 12, 16):
            b = p - off
            if b >= 2 and all(is_prime[b + k] for k in (0, 4, 6, 10, 12, 16)):
                setbit(i, "sextuplet")
                break

        # good prime: p_n^2 > p_(n-i) * p_(n+i) for all i. Fails fast in practice.
        if 0 < i < n - 1:
            ok = True
            j = 1
            while j <= i and i + j < n:
                if p * p <= int(primes[i - j]) * int(primes[i + j]):
                    ok = False
                    break
                j += 1
            if ok and j > i:
                setbit(i, "good")

        # ---- chain
        if is_prime[2 * p + 1]:
            setbit(i, "sophie_germain")
            if is_prime[4 * p + 3]:
                setbit(i, "cunningham3")
                if is_prime[8 * p + 7]:
                    setbit(i, "cunningham4")
        if p % 2 == 1 and (p - 1) // 2 >= 2 and is_prime[(p - 1) // 2]:
            setbit(i, "safe")

        # ---- form
        for key, member in (
            ("mersenne", mersenne), ("fermat", fermat), ("double_mersenne", dbl_mers),
            ("wagstaff", wagstaff), ("thabit", thabit), ("cullen", cullen),
            ("woodall", woodall), ("factorial", factorial), ("primorial", primorial),
            ("pierpont", pierpont), ("cuban", cuban), ("quartan", quartan),
            ("star", star), ("centered_square", csq), ("centered_triangular", ctri),
            ("fibonacci", fib), ("lucas", luc), ("pell", pel), ("motzkin", mot),
            ("bell", bel), ("nsw", nsw), ("repunit", repunit), ("repdigit", repdigit),
        ):
            if p in member:
                setbit(i, key)
        # Proth: p - 1 = k * 2^m with k odd and k < 2^m
        m = 0
        t = p - 1
        while t % 2 == 0:
            t //= 2
            m += 1
        if m > 0 and t < (1 << m):
            setbit(i, "proth")
        if p % 4 == 1:
            setbit(i, "pythagorean")
        elif p % 4 == 3:
            setbit(i, "gaussian_inert")
        if p % 3 == 2:
            setbit(i, "eisenstein_inert")

        # ---- digit
        rev = int(s[::-1])
        if rev == p:
            setbit(i, "palindrome")
        elif rev < prime_max and is_prime[rev]:
            setbit(i, "emirp")
        if all(c in "2357" for c in s):
            setbit(i, "prime_digits")
        if is_prime[sum(dig)]:
            setbit(i, "additive")
        if _is_happy(p):
            setbit(i, "happy")
        if _is_strobogrammatic(p):
            setbit(i, "strobogrammatic")
        if d >= 3 and all(dig[k] == dig[0] for k in range(0, d, 2)) \
                and all(dig[k] == dig[1] for k in range(1, d, 2)) and dig[0] != dig[1]:
            setbit(i, "undulating")
        if d >= 3 and dig[0] == dig[-1] and len(set(dig[1:-1])) == 1:
            if dig[1] > dig[0]:
                setbit(i, "plateau")
            elif dig[1] < dig[0]:
                setbit(i, "depression")
        # Rotations and permutations. Past one digit, any prime all of whose
        # rearrangements are prime must be built from {1,3,7,9} -- every other
        # digit puts an even number or a multiple of five somewhere in the
        # orbit. Checking that first turns 720 permutation tests per prime into
        # almost none.
        if d == 1 or all(c in "1379" for c in s):
            rots = [int(s[k:] + s[:k]) for k in range(d)]
            if all(is_prime[r] for r in rots):
                setbit(i, "circular")
                from itertools import permutations
                perms = {int("".join(q)) for q in permutations(s)}
                if all(is_prime[v] for v in perms):
                    setbit(i, "permutable")
        # truncations
        lt = all(is_prime[int(s[k:])] for k in range(d)) if "0" not in s else False
        rt = all(is_prime[int(s[:k + 1])] for k in range(d))
        if lt:
            setbit(i, "left_truncatable")
        if rt:
            setbit(i, "right_truncatable")
        if lt and rt:
            setbit(i, "two_sided")
        # delicate: every single-digit substitution is composite
        # A050249 counts the leading-digit-to-zero substitution, which shortens
        # the number: 929573 fails delicacy only because 029573 = 29573 is
        # prime. Skipping that case silently over-counts the class, and it is
        # the sort of off-by-one a reserve table must not carry.
        delicate = True
        for pos in range(d):
            for nd in range(0, 10):
                if nd == dig[pos]:
                    continue
                v = int(s[:pos] + str(nd) + s[pos + 1:])
                if v > 1 and is_prime[v]:
                    delicate = False
                    break
            if not delicate:
                break
        if delicate:
            setbit(i, "delicate")

        # ---- index
        rank = i + 1
        if rank <= table_max and is_prime[rank]:
            setbit(i, "super_prime")
        if raman[p]:
            setbit(i, "ramanujan")
        if p + 2 <= table_max + 3 and om[p + 2] <= 2:
            setbit(i, "chen")
        if lucky[p]:
            setbit(i, "lucky")
        if rank in ten_pow:
            setbit(i, "index_power_of_ten")
        if width_first.get(d) == p:
            setbit(i, "first_of_width")
        if width_last.get(d) == p and d < len(str(table_max)):
            setbit(i, "last_of_width")

        # ---- deep
        for key, mem in curated.items():
            if p in mem:
                setbit(i, key)
        if _multiplicative_order_10(p, spf) == p - 1:
            setbit(i, "full_reptend")

        # ---- protocol
        if p in era_generators:
            setbit(i, "era_generator")

    return {
        "primes": primes,
        "mask": masks,
        "table_max": table_max,
        "prime_max": prime_max,
        "nbits": nbits,
    }


# ---------------------------------------------------------------- rarity


def tag_counts(tagged: dict) -> dict[str, int]:
    counts = {t.key: 0 for t in TAGS}
    masks = tagged["mask"]
    for i, t in enumerate(TAGS):
        bit = 1 << i
        counts[t.key] = sum(1 for m in masks if m & bit)
    return counts


def band_of(p: int) -> int:
    """Decade band: the number of digits in p. Rarity is measured inside a
    band, never across the whole table."""
    return len(str(p))


def surprisal_bits(tagged: dict, cap: float = 20.0) -> dict[int, dict[str, float]]:
    """-log2 of a tag's empirical density, measured *within each decade*.

    Measuring globally does not work, and the failure is instructive. Small
    primes belong to almost every class -- 2 is a Mersenne exponent, a Fermat
    prime, a factorial prime, a primorial prime, a Sophie Germain prime and the
    start of a length-4 Cunningham chain -- not because 2 is a miracle but
    because the small end of the number line is where every named form has its
    first few terms. A global density makes every one of those look like a
    1-in-78,000 event and prices the first thirty primes identically at the cap.

    Conditioning on the decade asks the only question that discriminates:
    *given a prime of this size, how surprising is this property?* Being a
    Mersenne prime is unremarkable among one-digit primes (3 and 7 of the four)
    and extraordinary among six-digit ones (none). That is the correct pricing
    signal and it falls straight out of the conditional density.

    A tag with no members in a band never gets consulted for that band, so a
    zero count is not a division by zero -- it is simply unreachable.
    """
    primes = tagged["primes"]
    masks = tagged["mask"]
    per_band_total: dict[int, int] = {}
    per_band_count: dict[int, dict[str, int]] = {}
    for i, p in enumerate(primes):
        b = band_of(int(p))
        per_band_total[b] = per_band_total.get(b, 0) + 1
        row = per_band_count.setdefault(b, {})
        m = masks[i]
        for j, t in enumerate(TAGS):
            if m & (1 << j):
                row[t.key] = row.get(t.key, 0) + 1
    out: dict[int, dict[str, float]] = {}
    for b, tot in per_band_total.items():
        out[b] = {}
        for t in TAGS:
            c = per_band_count.get(b, {}).get(t.key, 0)
            out[b][t.key] = cap if c == 0 else min(cap, -math.log2(c / tot))
    return out


def score_bits(p: int, mask: int, bits: dict[int, dict[str, float]],
               cross_family_discount: float = 0.25,
               cap: float = 12.0) -> float:
    """Total structural rarity of one prime, in bits.

    Tags inside a family are heavily correlated -- every twin is a Chen prime,
    every safe prime has a Sophie Germain partner, every quadruplet member is a
    triplet member -- so summing them would pay for the same fact several
    times. Within a family we take the rarest tag in full and 25% of the
    others; across families we sum, because a palindromic Sophie Germain prime
    really is two independent surprises.

    The cap is the pricing decision, stated rather than hidden: past 12 bits we
    stop paying more. It bounds the rarity multiplier at 1 + kappa * 12, so no
    combination of tags can run away with the price of a lot.
    """
    band = bits.get(band_of(p))
    if band is None:
        return 0.0
    per_family: dict[str, list[float]] = {f: [] for f in FAMILIES}
    for i, t in enumerate(TAGS):
        if mask & (1 << i):
            per_family[t.family].append(band[t.key])
    total = 0.0
    for vals in per_family.values():
        if not vals:
            continue
        vals.sort(reverse=True)
        total += vals[0] + cross_family_discount * sum(vals[1:])
    return min(cap, total)


def tags_of(mask: int) -> list[str]:
    return [t.key for i, t in enumerate(TAGS) if mask & (1 << i)]
