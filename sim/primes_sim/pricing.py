"""Starting prices: what a lot opens at -- a prime's descending lot at its turn,
and any number's ascending lot ahead of the head (D-88/D-90).

The model has exactly three layers and they are kept apart on purpose, because
they are three different kinds of claim and a reader is entitled to audit them
separately:

    price(p) = ANCHOR(p) * (1 + kappa * RARITY(p)) * VANITY(p)

  * ANCHOR -- discounted cash flow. Already in this repo: `tribute.prime_tribute_npv`
    sums every tribute payment prime p will actually receive as the head sweeps
    the number line, discounted back to p's own mint. This is a *measurement*,
    not an opinion, and it is the same function `analysis.auction_reference_prices`
    already uses to set the six genesis reserves (CONCEPT.md SS6). Generalising
    it from six primes to every prime is the whole trick: the reserve model the
    project already committed to happens to be defined for all p.

  * RARITY -- structural surprisal in bits (`taxonomy.surprisal_bits`),
    measured against the empirical density of each class below the horizon.
    Enters linearly, so a 20-bit prime costs a bounded multiple of a plain one
    rather than an unbounded one.

  * VANITY -- demand-side, base-10, human. This layer is the only one that is
    a taste judgement, and it is confined to one small table so that the
    argument about it cannot leak into the other two. It is also the only layer
    defined for *composite* n, because D-88's ascending lane opens for every
    number ahead of the head, composites included.

The separation is the point. If someone disputes the price of 1337, they are
disputing one number in VANITY_RULES, not the tribute model.
"""
from __future__ import annotations

from dataclasses import dataclass

# ---------------------------------------------------------------- vanity


@dataclass(frozen=True)
class VanityRule:
    key: str
    label: str
    multiplier: float
    note: str


VANITY_RULES: tuple[VanityRule, ...] = (
    VanityRule("meme", "Culturally loaded", 3.0,
               "A small fixed set with demonstrable willingness-to-pay in "
               "every other digital-scarcity market: 42, 69, 420, 666, 777, "
               "911, 1337, 8008, 80085, 90210, 1234, 12345."),
    VanityRule("repdigit10", "Repdigit", 2.6,
               "All digits equal: 11, 777, 8888. The single most requested "
               "shape in every phone-number and licence-plate market there is."),
    VanityRule("round_neighbour", "Round-number neighbour", 2.2,
               "Within 3 of a power of ten. 1009 is the first prime past 1000 "
               "and that is why anyone wants it."),
    VanityRule("birth_year", "Birth year", 2.0,
               "1930-2026. The largest identifiable cohort of vanity buyers, "
               "and the only one whose size can be estimated from demographics."),
    VanityRule("year", "Year", 1.5,
               "1000-2100 outside the birth-year band. Anniversaries, "
               "foundings, and the numbers people already put on things."),
    VanityRule("sequential", "Sequential digits", 1.9,
               "Strictly ascending or descending by one: 4567, 98765."),
    VanityRule("date", "Date-shaped", 1.8,
               "Six digits that parse as DDMMYY or MMDDYY. This is the single "
               "largest rule-expressible vanity cohort on the line -- roughly "
               "22,000 numbers between 100,000 and 404,000 are somebody's "
               "birthday, anniversary, or the day they shipped something. It is "
               "also the cohort the flat 1 GRAM price gives away for free."),
    VanityRule("palindrome10", "Palindrome", 1.4,
               "Priced again here, separately from its rarity, because "
               "palindromes sell on how they look and not on how rare they are."),
)
# There is deliberately no "short number" rule. Small primes are already the
# most expensive lots in the table by two independent routes -- they collect
# the most tribute (the anchor) and they are the first term of nearly every
# named form (the rarity layer). A third multiplier for the same fact would be
# triple-counting, and it would put 11 above 2, which no defensible model does.

VANITY_BY_KEY = {r.key: r for r in VANITY_RULES}

_MEMES = frozenset({
    42, 69, 420, 666, 777, 911, 1337, 8008, 80085, 90210, 1234, 12345,
    123456, 654321, 1111, 2222, 4444, 5555, 6666, 7777, 8888, 9999,
})

VANITY_CAP = 3.0


_DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _is_date(day: int, month: int) -> bool:
    """Day/month plausibility. February gets 29 days unconditionally -- the
    two-digit year cannot tell us whether it was a leap year, and refusing
    29/02 would drop a real cohort of buyers on a technicality."""
    return 1 <= month <= 12 and 1 <= day <= _DAYS_IN_MONTH[month - 1]


def vanity_keys(n: int) -> list[str]:
    """Applicable vanity rules for *any* n -- prime or composite.

    Defined over composites too because the reservation book (CONCEPT.md SS4.4)
    sells them: someone's birth year is overwhelmingly likely to be composite.
    """
    out: list[str] = []
    s = str(n)
    d = len(s)

    if n in _MEMES:
        out.append("meme")
    if d >= 2 and len(set(s)) == 1:
        out.append("repdigit10")
    for k in range(1, 8):
        if abs(n - 10 ** k) <= 3:
            out.append("round_neighbour")
            break
    if 1930 <= n <= 2026:
        out.append("birth_year")
    elif 1000 <= n <= 2100:
        out.append("year")
    if d >= 3:
        deltas = {int(s[i + 1]) - int(s[i]) for i in range(d - 1)}
        if deltas in ({1}, {-1}):
            out.append("sequential")
    if d == 6 and (_is_date(int(s[:2]), int(s[2:4])) or _is_date(int(s[2:4]), int(s[:2]))):
        out.append("date")
    # A repdigit is already a palindrome. Paying for both is paying twice for
    # one visual fact, and it is exactly what put 11 above 2 in the first cut
    # of this table.
    if d >= 2 and s == s[::-1] and "repdigit10" not in out:
        out.append("palindrome10")
    return out


def vanity_multiplier(n: int) -> float:
    m = 1.0
    for k in vanity_keys(n):
        m *= VANITY_BY_KEY[k].multiplier
    return min(m, VANITY_CAP)


# ---------------------------------------------------------------- price


@dataclass(frozen=True)
class PriceParams:
    """Every dial in the price model, in one place, with its justification.

    `anchor_margin` is inherited unchanged from `analysis.auction_reference_prices`
    (CONCEPT.md SS6, SS10 kill criterion): the reserve sits at half of measured
    NPV so that real tribute income covers it with headroom and the bidder
    keeps the upside. Changing it here would silently re-price the six genesis
    lots the simulation already signed off on, so it is not changed here.
    """
    anchor_margin: float = 0.50
    kappa_per_bit: float = 0.15
    rarity_cap_bits: float = 12.0
    mint_price_ton: float = 1.0
    # No prime ever opens below what anyone pays for a composite at the head.
    # Below this the auction is theatre: a bidder would simply wait for the
    # head to arrive and mint it for 1 GRAM.
    floor_ton: float = 1.0
    # Out-of-table primes: past the horizon the divisor line pays ~0.08/p per
    # mint, which rounds to nothing, and only the flat prime dividend is left.
    # That dividend is identical for every prime, so a single constant is not
    # an approximation -- it is exactly right.
    out_of_table_ton: float = 1.0


def reserve_ton(npv_ton: float, rarity_bits: float, vanity: float,
                pp: PriceParams = PriceParams()) -> float:
    """The anchor is the *larger* of measured tribute NPV and the 1 GRAM anyone
    pays at the head, and the two multipliers apply to that -- not to the NPV
    alone with a floor clamped on afterwards.

    The difference matters and it is the whole reason the tag layer exists.
    Above ~10^4 the discounted tribute of a single prime rounds to nothing, so
    clamping after the multiply would flatten every large prime to exactly
    1 GRAM and the taxonomy would price nothing at all. Anchoring at the floor
    first means a six-digit Sophie Germain palindrome opens above a six-digit
    nobody, which is the entire point of tagging them.
    """
    anchor = max(pp.floor_ton, pp.anchor_margin * npv_ton)
    return anchor * (1.0 + pp.kappa_per_bit * min(rarity_bits, pp.rarity_cap_bits)) * vanity


# The PREMIUM section is DELETED. It modelled `RES_PREMIUM(n) = D(n)*PREMIUM_UNIT`
# as a PRIMES-denominated fee on reserving a number ahead of the head, burned. Three
# decisions took it apart and nothing imported it by the end:
#
#   * D-30/D-33 deleted RES_PREMIUM as a fee -- there is no book to buy a place in, and
#     opening IS the first bid at `P0(n)`, so the clearing price is the auction's, not a
#     formula's. `trophy_auction.py` is the model that replaced this one.
#   * D-90 deleted the reservation escrow, so there is no "1 GRAM escrow plus RES_FEE"
#     first-come race left for a premium to convert into an auction.
#   * D-102 deleted the burn sink this was denominated in. The docstring's claim that
#     "a burn that decrements S raises the floor directly" contradicts the invariant
#     that outlived it: S is cumulative emission plus the genesis vault and is NEVER
#     decremented (CONCEPT.md SS3.3/SS5). Burns are tracked in their own ledger
#     (`getBurnStats`) precisely so they do not touch S.
