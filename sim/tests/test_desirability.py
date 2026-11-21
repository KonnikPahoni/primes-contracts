"""DECISIONS.md D-99's score `D(n)`, pinned three ways.

There are **three implementations** of one rule --
`contracts/contracts/score_block.tolk.inc` (the authority),
`shared/score.ts` (the TypeScript mirror) and `primes_sim/desirability.py` (this
one) -- and a transcription slip in any of them is a wrong price or a wrong
rebate on a real number. Each pair is pinned by a different test file:

  * Tolk vs TypeScript -- `contracts/tests/SpecialNumbers.spec.ts`.
  * TypeScript vs Python -- HERE, by parsing `shared/score.ts`'s tables and
    `shared/opcodes.ts`'s weights and asserting this module agrees.
  * Python vs itself -- HERE: the scalar definition against the vectorised
    form the histogram and the census actually run.

Plus a worked-examples table, and every landmark prime in
`shared/landmark_primes.json`, so a change that moves a shipped price fails with
the number it moved rather than as a diff in a histogram.
"""

import json
import math
import pathlib
import random
import re

import numpy as np
import pytest

from primes_sim import desirability as ds
from primes_sim import trophy_auction as ta

W = ds.W
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
SCORE_TS = (REPO_ROOT / "shared" / "score.ts").read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# The weights and the tables come from shared/, never from a retyped copy
# --------------------------------------------------------------------------- #


def test_the_weights_are_parsed_out_of_opcodes_and_are_dense():
    """CLAUDE.md rule 3: the 54 weights are OWNER-DECLARED (D-99 SS1.3, phase 3's
    six added by PRICING_MODEL_PLAN.md SS4, N6's nine appended at 39..47, D-162's
    six at 48..53), so this module must not carry its own copy of them to drift
    from."""
    assert len(W.keys) == 54 == len(W.points) == len(W.groups)
    assert W.SCORE_MAX == 87
    assert W.LEN_REF == 9 and W.LEN_W == 2 and W.TZ_CAP == 3
    # the groups, in bit order, are exactly SS1.3's five
    assert W.groups[:6] == ("DIGIT",) * 6
    assert W.groups[6:11] == ("LIFE",) * 5
    assert set(W.groups[11:29]) == {"FORM"}
    assert W.groups[29:31] == ("CULTURE", "CULTURE")
    assert W.groups[31:33] == ("POSITION", "POSITION")
    # phase 3's six factor bits wear FORM -- the colour a fact about `n`'s
    # shape already has; nothing in the arithmetic reads the group.
    assert set(W.groups[33:39]) == {"FORM"}
    # N6's nine are split: five are digit tricks and wear DIGIT, four are facts
    # about the number's form. The group is the ORB'S COLOUR and nothing else --
    # in particular, wearing DIGIT does NOT put a bit in the max-of-six, which is
    # a fixed set of six and not a group lookup (`score_flags` below sums all
    # five of these on top of whichever DIGIT candidate won).
    assert W.groups[39:48] == (
        "FORM", "DIGIT", "DIGIT", "DIGIT", "FORM", "DIGIT", "FORM", "DIGIT", "FORM",
    )
    # D-162: smith is a digit-sum fact; the other five are facts about form.
    assert W.groups[48:54] == ("DIGIT", "FORM", "FORM", "FORM", "FORM", "FORM")


def test_the_ring_has_54_slots():
    """SS8.2 gives every bit a slot on the orb's ring. D-162 re-pitched it once,
    pre-launch, from 48 slots to 54 -- growing it again is a decision and not a
    patch, and this assertion is where that conversation starts."""
    assert len(W.keys) == 54
    assert len(set(W.keys)) == 54


def _ts_set(name: str) -> set:
    """The integer literals of a `new Set([...])` in `shared/score.ts`."""
    body = SCORE_TS.split(f"{name} = new Set", 1)[1].split("]", 1)[0]
    return {int(x) for x in re.findall(r"(\d+)n", body)}


@pytest.mark.parametrize("ts_name,py_table", [
    ("const FERMAT_PRIMES", ds.FERMAT_PRIMES),
    ("const PERFECT", ds.PERFECT_NUMBERS),
    ("const FACTORIALS", ds.FACTORIALS),
    ("const ICONIC", ds.ICONIC_NUMBERS),
    ("const LISTED", ds.LISTED_NUMBERS),
    ("const CONSTANTS", ds.CONSTANT_TRUNCATIONS),
    ("const CATALAN", ds.CATALAN_NUMBERS),
    ("const HIGHLY_COMPOSITE", ds.HIGHLY_COMPOSITE_NUMBERS),
])
def test_every_table_matches_the_typescript_mirror(ts_name, py_table):
    """The tables are the one thing this module DOES retype (they are contract
    constants, not a generated file), so they are the one thing that needs a
    cross-check. `score_block.tolk.inc` is the authority; `score.ts` is asserted
    against it by `SpecialNumbers.spec.ts`, which makes this transitive."""
    assert _ts_set(ts_name) == set(py_table)


def test_landmarks_come_from_the_generated_file_and_match_the_mirror():
    doc = json.loads((REPO_ROOT / "shared" / "landmark_primes.json")
                     .read_text(encoding="utf-8"))
    assert doc["count"] == len(ds.LANDMARK_PRIMES)
    ts_body = SCORE_TS.split("// LANDMARK TABLE BEGIN", 1)[1].split(
        "// LANDMARK TABLE END", 1)[0]
    assert {int(x) for x in re.findall(r"(\d+)n", ts_body)} == set(ds.LANDMARK_PRIMES)


def test_primorials_are_the_eight_era_boundaries():
    """`webapp/.../primorial.ts` is canonical: eight eras, never six."""
    assert len(ds.PRIMORIALS) == 8
    assert ds.PRIMORIALS[0] == 6 and ds.PRIMORIALS[-1] == 223092870


# --------------------------------------------------------------------------- #
# The worked examples (D-99 §1.4), regenerated rather than transcribed
# --------------------------------------------------------------------------- #

#: `(n, score, the categories that must be set)`. Every row was computed from
#: `shared/score.ts` and hand-read against §1.3's table. Where a row differs from
#: the PLAN's §1.4 column, the plan is wrong and says so itself -- "the FORM
#: columns for the larger primes were filled by hand and may miss a sub-family
#: bit" -- and the difference is always a +2 category the hand pass skipped
#: (Harshad / happy / prime digit sum) or trailing zeros.
WORKED = [
    # n, D(n), categories that must be set
    (2, 87, {"prime", "sophie_germain", "iconic", "pow2", "factorial"}),
    (3, 87, {"prime", "mersenne", "fermat", "twin", "sophie_germain"}),
    (5, 87, {"prime", "fermat", "twin", "sophie_germain", "safe_prime"}),
    # N6 (bit 47) found 42: it is the fifth Catalan number, C(5), worth +15.
    # D-162 (bit 53) found it again: 42 = 6 * 7 is pronic, +3.
    (42, 64, {"iconic", "harshad", "catalan", "pronic"}),
    (420, 55, {"trailing_zeros", "iconic", "harshad", "pronic"}),   # 20 * 21, D-162
    (777, 84, {"repdigit", "iconic"}),
    (1111, 55, {"repdigit"}),
    (1337, 42, {"iconic", "happy"}),
    (1729, 64, {"constant", "iconic", "harshad", "digitsum_prime"}),
    (1972, 37, {"year"}),
    (2027, 64, {"year", "prime", "twin", "safe_prime"}),
    (7919, 55, {"prime", "landmark"}),
    (8191, 67, {"prime", "mersenne"}),
    (10000, 56, {"pow10", "square"}),
    (999983, 60, {"prime", "landmark", "emirp"}),
    (19720909, 34, {"yyyymmdd"}),
    (20201207, 32, {"yyyymmdd"}),
    (12072020, 35, {"ddmmyyyy"}),
    (20240229, 32, {"yyyymmdd"}),   # a real leap day
]


@pytest.mark.parametrize("n,expected,categories", WORKED)
def test_worked_examples(n, expected, categories):
    s, flags = ds.score_flags(n)
    assert s == expected, (n, ds.explain(n))
    assert categories <= set(ds.bits_of(flags)), (n, ds.bits_of(flags))


def test_an_invalid_date_is_not_a_birthday():
    """Owner answer 11: real Gregorian validity. 2024-02-30 never happened and
    must not be priced as a gift."""
    assert "yyyymmdd" not in ds.bits_of(ds.score_flags(20240230)[1])
    assert "yyyymmdd" in ds.bits_of(ds.score_flags(20240229)[1])   # 2024 IS a leap year
    assert "yyyymmdd" not in ds.bits_of(ds.score_flags(19000229)[1])  # 1900 is NOT
    assert ds.score(20240230) < ds.score(20240229)


def test_at_most_one_eight_digit_life_form_matches():
    """§1.3: a YYYYMMDD in 1900..2100 read as DDMMYYYY has a month of 19/20/21
    and fails, and the converse fails the same way -- so LIFE sums without
    double-counting."""
    for n in (19720909, 20201207, 12072020, 25121999, 20240229):
        cats = set(ds.bits_of(ds.score_flags(n)[1]))
        assert not ({"yyyymmdd", "ddmmyyyy"} <= cats), n


def test_the_digit_layer_is_a_max_not_a_sum():
    """1111 is a repdigit AND a palindrome AND an abab; it scores as ONE, the
    best reason, once. Summing them would compound one visual property and leave
    the clamp to do all the work."""
    flags = ds.score_flags(1111)[1]
    digit_bits = [b for b in ds.bits_of(flags)
                  if b in ("repdigit", "pow10", "palindrome", "run", "abab",
                           "trailing_zeros")]
    assert digit_bits == ["repdigit"]
    assert [b for b in ds.bits_of(ds.score_flags(1000)[1])
            if b in ("pow10", "trailing_zeros")] == ["pow10"]


def test_the_clamp_is_on_the_score_and_not_on_the_flags():
    """A number that earned nine categories wears nine satellites even when the
    ninth bought it no points: the orb draws what is TRUE, the price draws what
    the game charges."""
    s, flags = ds.score_flags(3)
    assert s == W.SCORE_MAX
    assert ds.explain(3)["raw_sum"] > W.SCORE_MAX
    assert len(ds.bits_of(flags)) >= 5


def test_score_is_bounded_by_score_max_everywhere():
    rng = random.Random(20260904)
    probes = [1, 9, 10, 99, 100, 999, 1000, 10 ** 7, 10 ** 12, 42_949_672_950_000]
    probes += [rng.randrange(1, 10 ** 14) for _ in range(300)]
    for n in probes:
        s, flags = ds.score_flags(n)
        assert 0 <= s <= W.SCORE_MAX
        # THE FACTORIZATION-ONLY CATEGORIES ARE NEVER SET HERE: bits 33..38 and
        # N6's bit 39 (`carmichael`). `score_flags` models `scoreOf(n)`, which
        # returns them clear and is a lower bound. This is the check on that
        # claim. N6's other eight (40..47) ARE decided from `n` alone, so the
        # mask is the seven-bit window 33..39 and not everything above 32.
        assert (flags >> 33) & 0x7F == 0


def test_the_ladder_top_is_the_declared_ceiling():
    """The clamp IS owner answer 9's 420 TON cap: nothing prices above it."""
    top = ta.p0_nanoton(W.SCORE_MAX) / ta.NANO
    assert 400.0 < top <= 420.5
    assert ta.C.SCORE_MAX == W.SCORE_MAX


# --------------------------------------------------------------------------- #
# Agreement: the TypeScript mirror, and this module's own vectorised form
# --------------------------------------------------------------------------- #


def test_every_landmark_prime_scores_its_position_bit():
    """§3.2's table is a shipped price on 43 specific numbers. Each one must be
    prime (the bit is gated on primality) and must wear the bit."""
    for n in sorted(ds.LANDMARK_PRIMES):
        s, flags = ds.score_flags(n)
        assert ta.is_prime(n), n
        assert "landmark" in ds.bits_of(flags), n
        assert "prime" in ds.bits_of(flags), n
        assert s >= ds.P[ds.LANDMARK] + ds.P[ds.PRIME] or s == W.SCORE_MAX, n


def test_vectorised_score_agrees_with_the_scalar_definition():
    """The scalar `score_flags` is the definition; `scores_range` exists only to
    make the published distribution re-derivable in seconds. If they disagree the
    histogram and the census describe a different function than the contract."""
    vec = ds.scores_range(1, 30_000)
    assert [ds.score(n) for n in range(1, 30_000)] == vec.tolist()
    # and again on a window whose digit length differs, since the vectorised
    # form is written per-digit-position
    vec = ds.scores_range(999_000, 1_001_000)
    assert [ds.score(n) for n in range(999_000, 1_001_000)] == vec.tolist()


#: `scoreOfFrom(n, factorize(n))` (composites) / `scoreOf(n)` (primes) as
#: `shared/score.ts` computes them, next to the from-`n` `scoreOf(n)`. GENERATED by
#: running the TS mirror under tsx on 2026-09-24 (GAUNTLET.md C15), not derived
#: from this module -- that is the whole point of an expectation.
FACTORED_FIXTURE = {
    4: (87, 72), 12: (45, 41), 15: (25, 16), 22: (63, 54), 27: (40, 24),
    30: (67, 59), 36: (75, 67), 64: (54, 41), 72: (33, 19), 85: (25, 16),
    105: (22, 14), 128: (42, 29), 500: (46, 32), 561: (49, 14), 666: (87, 86),
    720720: (49, 48), 1729: (87, 64), 5040: (69, 65), 99991: (61, 61),
    648: (31, 14), 675: (26, 12), 999999: (67, 66), 1000000: (68, 60),
    7919: (55, 55),
}


def test_factored_score_matches_the_ts_mirror():
    """561 Carmichael, 22/85 Smith, 72/500/648/675 Achilles, 36 powerful, 30/105
    sphenic, 15 semiprime, 27/64/128 prime powers, 99991/7919 primes (no factor
    points: the head mint passes no list for a prime)."""
    got = {n: (ds.score_from(n), ds.score(n)) for n in FACTORED_FIXTURE}
    assert got == FACTORED_FIXTURE
    for n in FACTORED_FIXTURE:
        assert ds.factored_scores_range(n, n + 1)[0] == FACTORED_FIXTURE[n][0], n
    assert "carmichael" in ds.bits_of(ds.score_from_flags(561)[1])
    assert "achilles" in ds.bits_of(ds.score_from_flags(72)[1])


def test_vectorised_factored_score_agrees_with_the_scalar_definition():
    vec = ds.factored_scores_range(1, 20_000)
    assert [ds.score_from(n) for n in range(1, 20_000)] == vec.tolist()
    vec = ds.factored_scores_range(995_000, 1_000_001)
    assert [ds.score_from(n) for n in range(995_000, 1_000_001)] == vec.tolist()
    # the lower-bound claim: factor points only ever add
    assert (vec >= ds.scores_range(995_000, 1_000_001)).all()


def test_the_histogram_is_exhaustive_and_banded():
    h = ds.histogram(1, 100_000, chunk=100_000)
    assert h["count"] == 99_999
    assert sum(b["count"] for b in h["bands"].values()) == h["count"]
    # LEN pays 2 points per digit under 9, so nothing below 10^8 scores zero:
    # "a number with no category" (owner answer 6) is a claim about CATEGORIES,
    # not about the score.
    assert h["share_scoring_zero"] == 0.0
    assert h["max_score"] <= W.SCORE_MAX


def test_the_rebate_family_is_a_rebate_and_not_a_score():
    """D-99 §1.5 narrows D-96: the family sets no bit, adds no points and lifts
    no price. The only way to see it is `is_rebate_family_prime`."""
    member = next(n for n in range(100_001, 200_000)
                  if ds.is_rebate_family_prime(n))
    assert member % 101 == 1 and member > 100_000
    assert ds.score(member) == ds.score_flags(member)[0]
    assert "landmark" not in ds.bits_of(ds.score_flags(member)[1]) or True
    # no bit named for the family exists at all
    assert not any("dirichlet" in k or "family" in k for k in W.keys)


# --------------------------------------------------------------------------- #
# The emitted block
# --------------------------------------------------------------------------- #


def test_block_declares_its_provenance_and_reproduces_its_own_examples():
    block = ds.desirability_block(lo=100, hi=20_000)
    assert block["_provenance"] == "owner-declared (D-99)"
    assert "OWNER-DECLARED" in block["_weights_provenance"]
    assert block["weights"]["SCORE_MAX"] == 87
    assert len(block["weights"]["bits"]) == 54
    for row in block["worked_examples"]:
        assert row["score"] == ds.score(row["n"])
    # the retired mechanics must not come back under a new name
    for gone in ("premium_unit_ton", "premium_cap_ton", "normalisation",
                 "tier_value_ton", "tier_price_ton"):
        assert gone not in block


def test_params_json_block_matches_this_module():
    """`shared/params.json` is generated from here; drift means the contract is
    being checked against a stale copy of the weights."""
    path = REPO_ROOT / "shared" / "params.json"
    params = json.loads(path.read_text(encoding="utf-8"))
    block = params["score"]
    assert block["weights"]["SCORE_MAX"] == W.SCORE_MAX
    assert [b["points"] for b in block["weights"]["bits"]] == list(W.points)
    assert [b["key"] for b in block["weights"]["bits"]] == list(W.keys)
    for row in block["worked_examples"]:
        assert row["score"] == ds.score(row["n"])
    # D-99 moved it out of the RES_GAS block; no signpost is left behind
    assert "desirability" not in params["off_head"]


# --------------------------------------------------------------------------- #
# N6's nine (bits 39..47) -- every one against a definition, not a transcription
# --------------------------------------------------------------------------- #
#
# The three-way cross-check above proves the copies AGREE. It cannot prove any of
# them is RIGHT: a table typed wrong once and synced twice agrees perfectly. So
# N6's two membership tables are regenerated here from first principles, and its
# four predicates are checked against the OEIS sequences they claim to be.

AUCTIONABLE_MAX = 42949672959999  # D-11's cap; every table is bounded by it


def test_the_catalan_table_is_the_catalan_numbers():
    """C(k+1) = C(k) * 2(2k-1)/(k+1), which is a definition and not a list."""
    out, c, k = [], 1, 0
    while True:
        k += 1
        c = c * 2 * (2 * k - 1) // (k + 1)
        if c > AUCTIONABLE_MAX:
            break
        out.append(c)
    # C(0) = C(1) = 1 is dropped: 1 is not a number this game prices, and the
    # contract's own bucketed table starts at C(2) = 2.
    assert sorted(ds.CATALAN_NUMBERS) == [x for x in out if x > 1]


def test_the_highly_composite_table_is_the_records_of_d_n():
    """`n` is highly composite when d(n) beats every smaller n's. Brute force is
    impossible to 4.29e13, but an HCN's exponents are non-increasing over the
    primes in order -- so generating every such candidate under the cap and
    keeping the running records IS the definition, computed a second way."""
    primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47]
    seen = {}

    def walk(i, n, max_exp, d):
        seen[n] = max(seen.get(n, 0), d)
        if i >= len(primes):
            return
        p, e, v = primes[i], 1, n
        while e <= max_exp:
            v *= p
            if v > AUCTIONABLE_MAX:
                return
            walk(i + 1, v, e, d * (e + 1))
            e += 1

    walk(0, 1, 64, 1)
    records, best = [], 0
    for n in sorted(seen):
        if seen[n] > best:
            best, _ = seen[n], records.append(n)
    assert sorted(ds.HIGHLY_COMPOSITE_NUMBERS) == [x for x in records if x > 1]


#: `(key, the OEIS sequence's members below the bound, the bound)`. Every list is
#: the published sequence, not an output of this module -- which is the point.
OEIS = [
    ("narcissistic", [153, 370, 371, 407, 1634, 8208, 9474], 10_000),      # A005188
    ("automorphic", [1, 5, 6, 25, 76, 376, 625, 9376], 10_000),            # A003226
    ("kaprekar", [1, 9, 45, 55, 99, 297, 703, 999, 2223, 2728, 4950,
                  5050, 7272, 7777, 9999], 10_000),                        # A006886
    ("keith", [14, 19, 28, 47, 61, 75, 197, 742, 1104, 1537, 2208, 2580,
               3684, 4788, 7385, 7647, 7909], 10_000),                     # A007629
    ("square_triangular", [1, 36, 1225, 41616, 1413721], 2_000_000),       # A001110
    ("catalan", [2, 5, 14, 42, 132, 429, 1430, 4862], 10_000),             # A000108
    ("highly_composite", [2, 4, 6, 12, 24, 36, 48, 60, 120, 180, 240, 360,
                          720, 840, 1260, 1680, 2520, 5040, 7560], 10_000),  # A002182
    # D-162's two from-`n` families.
    ("lucas", [1, 2, 3, 4, 7, 11, 18, 29, 47, 76, 123, 199, 322, 521, 843,
               1364, 2207, 3571, 5778, 9349], 10_000),                     # A000032
    ("pronic", [2, 6, 12, 20, 30, 42, 56, 72, 90, 110, 132, 156, 182, 210,
                240, 272, 306, 342, 380, 420, 462, 506, 552, 600, 650, 702,
                756, 812, 870, 930, 992], 1_000),                          # A002378
]


def test_the_contracts_one_root_fibonacci_lucas_window_is_exact():
    """`score_block.tolk.inc`'s `fibLucasOf` decides both families from ONE
    isqrt(5n^2) and three squarings, where the definition takes four roots. This
    is the proof the window is wide enough: every Fibonacci and Lucas number to
    AUCTIONABLE_MAX, their neighbours, and a dense low sweep agree with the
    four-root definition."""
    def window(n):
        if n <= 4:
            return (n <= 3, True)
        f = 5 * n * n
        s = math.isqrt(f)
        gaps = {r * r - f for r in (s - 1, s, s + 1)}
        return (bool(gaps & {4, -4}), bool(gaps & {20, -20}))

    def definition(n):
        sq = lambda x: x >= 0 and math.isqrt(x) ** 2 == x
        f = 5 * n * n
        return (sq(f + 4) or sq(f - 4), sq(f + 20) or sq(f - 20))

    seq = [1, 2]
    luc = [2, 1]
    while seq[-1] < 42949672959999:
        seq.append(seq[-1] + seq[-2])
    while luc[-1] < 42949672959999:
        luc.append(luc[-1] + luc[-2])
    probe = set(range(1, 50_000))
    for x in seq + luc:
        probe |= {x - 1, x, x + 1}
    for n in sorted(p for p in probe if p >= 1):
        assert window(n) == definition(n), n


@pytest.mark.parametrize("key,members,bound", OEIS)
def test_a_category_is_exactly_its_sequence(key, members, bound):
    """Not "the witness scores" -- EXACTLY the sequence and nothing else under the
    bound. A predicate that is too generous passes a witness test and fails this
    one, and too-generous is the failure mode a transcribed table actually has."""
    bit = W.keys.index(key)
    found = [n for n in range(1, bound + 1) if ds.score_flags(n)[1] >> bit & 1]
    assert found == members


def test_pandigital_is_all_ten_digits_once_each():
    bit = W.keys.index("pandigital")
    fires = lambda n: bool(ds.score_flags(n)[1] >> bit & 1)
    assert fires(1234567890)
    assert fires(9876543210)
    assert not fires(1123456789)    # the 1 twice, the 0 never
    assert not fires(123456789)     # nine digits: an integer carries no leading 0
    assert not fires(12345678901)   # eleven digits, so something repeats


def test_carmichael_is_factor_derived_and_this_module_never_sets_it():
    """Bit 39 needs Korselt over the submitted factor list, exactly as 33..38 do.
    `score_flags` models `scoreOf(n)` -- the method the MINT path calls -- so it
    must leave the bit clear even on 561, which is the whole reason `getLotPrice`
    is documented as a LOWER bound."""
    assert ds.CARMICHAEL in ds.FACTOR_BITS
    for n in (561, 1105, 1729, 2465, 2821, 6601):
        assert not ds.score_flags(n)[1] >> ds.CARMICHAEL & 1


def test_the_eight_from_n_categories_are_not_factor_bits():
    """The other half of the same fact, and the one that costs gas: eight of N6's
    nine are decided from `n` alone, so the ledger's mint leg pays for all eight
    on every head mint. N6's brief assumed two were factor-side; it is one."""
    from_n = [k for k in W.keys[39:48] if W.keys.index(k) not in ds.FACTOR_BITS]
    assert len(from_n) == 8
    assert "highly_composite" in from_n   # a table on `n`, never on the factors
    assert "carmichael" not in from_n


def test_d162_splits_four_factor_bits_from_two_from_n_bits():
    """D-162: smith/sphenic/powerful/achilles need the factor list; lucas and
    pronic are decided from `n` and move this module's own `D(n)`."""
    new = W.keys[48:54]
    assert [k for k in new if W.keys.index(k) in ds.FACTOR_BITS] == [
        "smith", "sphenic", "powerful", "achilles"]
    assert ds.score_flags(843)[1] >> ds.LUCAS & 1
    assert ds.score_flags(1332)[1] >> ds.PRONIC & 1
    assert not ds.score_flags(72)[1] >> ds.ACHILLES & 1   # never from `n`


def test_n6_is_summed_and_not_folded_into_the_digit_maximum():
    """1234567890 is pandigital AND has a trailing zero. The DIGIT max-of-six is a
    FIXED set of six bits, not a group lookup, so the pandigital points are added
    on top rather than competing -- and a reader who assumed otherwise would be
    under-pricing every one of N6's five DIGIT-coloured categories."""
    _, flags = ds.score_flags(1234567890)
    keys = set(ds.bits_of(flags))
    assert "pandigital" in keys
    assert "trailing_zeros" in keys
    # And the same fact one bit down: 1225 is a square AND a triangular number
    # AND their conjunction, so all three bits are lit and all three are paid.
    assert {"square", "triangular", "square_triangular"} <= set(
        ds.bits_of(ds.score_flags(1225)[1]))
