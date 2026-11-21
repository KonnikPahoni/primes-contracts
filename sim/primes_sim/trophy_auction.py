"""The trophy lane's price map -- `TROPHY_AUCTION_PLAN.md` SS3.1, SS5, SS6.

`desirability.py` prices the *reservation* ladder: `D(n)` sorted the number line
and `RES_PREMIUM(n) = D(n) * PREMIUM_UNIT` turned that ordering into a few cents
of money. CONCEPT.md SS4.4 point 1a said in terms that this was *"a sorting
mechanism, not a valuation"* and that real price discovery on contested numbers
*"is a challenge-auction layer that composes on top of this"*. This module is the
sim-side authority for that layer.

`D(n)` is **DECISIONS.md D-99's score**: 33 owner-declared categories, summed
(only the six digit patterns take a max), clamped once at `SCORE_MAX = 87`.
The pre-D-99 four-layer 0..120 score, its `PRIME_W`, its rarity tiers and
`PRIME_P0_MIN` are all deleted. What this module owns is the map from that score
to money:

    P0(n) = max(  MINT_PRICE * 2^(D(n) / SCORE_HALVING)              the ladder
                  PRIME_P0_MULTIPLE * NPV(n)      if n prime          SS6's rule
                  RESERVE_FLOOR                                       the lane )

and which numbers the map applies to at all:

    prime                       -> descending Dutch lane, openable early (D-31)
    any other composite         -> ascending auction lane                (D-30)
    SS7 primorial               -> neither; mint at the head only

**SUPERSEDED IN PART, 2026-08-19 (D-30/D-31/D-32/D-33).** The flat-fee
reservation lane this module used to price against is DELETED. There is no
`D_MIN` gate, no `RES_PREMIUM` fee and no `RES_PRIORITY_BASE`. Every reservable
composite may be opened as a lot, opening IS a paid first bid at `P0(n)`, and
the score's second job -- the minimum bid increment -- is derived in
`acquisition.py`, not declared here.

What this module owns and what it does not, stated up front because CLAUDE.md
rule 3 turns on the distinction:

  * **Declared, not derived.** `SCORE_HALVING`, `SCORE_MAX`,
    `PRIME_P0_MULTIPLE`, `AUCTION_WINDOW`, `BID_EXTENSION` are the owner's,
    declared rather than derived, the same way `genesis.prime_dutch_lane`'s
    DECAY_SECONDS and PRIME_P0_MULTIPLE are declared (D-20 retired the K-lot's own
    `auction_min_increment` field along with its ascending bid phase). They are emitted
    with `"_provenance": "declared"` and a stated constraint. Nothing in this
    module fits them and this module will not dress them as outputs.
  * **Derived here.** The `FRAC` table and the exact-integer `P0` reference; the
    `RESERVE_FLOOR` identity check against the measured `RES_GAS` /
    `RES_PRIORITY_BASE` split; the eligible-lot counts recomputed from
    `desirability.histogram`; and the `NPV(p)` ladder (D3), which is
    `tribute.prime_tribute_npv` evaluated at the calibration the Phase 1 engine
    run actually realised.

The `FRAC` table is the likeliest place for silent contract/sim drift, which is
why it is emitted rather than described: `primes_trophy_auction.tolk` computes
`P0 = (MINT_PRICE << (D / 10)) * FRAC[D % 10] / 2^16` and `SimCrossCheck.spec.ts`
reads the same ten integers out of `shared/params.json`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from . import economics as econ

# --------------------------------------------------------------------------- #
# The declared constants (TROPHY_AUCTION_PLAN.md SS3.1, SS2, SS5 -- the owner's)
# --------------------------------------------------------------------------- #

NANO = 1_000_000_000
MINT_PRICE_TON = 1.0
MINT_PRICE_NANOTON = NANO


@dataclass(frozen=True)
class TrophyConstants:
    """Every declared constant of the trophy lane, in one place.

    Mirrored as constants in `primes_trophy_auction.tolk`; `SimCrossCheck.spec.ts`
    asserts the two agree against `shared/params.json`. That cross-check is what
    makes the whole proposal honest -- without it the ladder drifts out of the
    sim's control silently (plan SS9).
    """

    #: Doublings per 10 points of `D(n)`. D2. `2^(D/10)` is exact cheap integer
    #: arithmetic on TVM (one shift, one lookup, one multiply, one divide).
    SCORE_HALVING: int = 10

    #: The bottom of the lane, in TON. **DERIVED, not declared**: under D-30
    #: there is no second lane for it to bound, so it is simply the cheapest
    #: opening price a lot can carry, and `gas.res_gas_derivation` fixes it at
    #: `MINT_PRICE + RES_GAS` exactly. `reserve_floor_identity` checks it.
    #:
    #: `D_MIN` USED TO SIT HERE and is **deleted** (D-30): the `D(n) >= D_MIN`
    #: lane gate is dropped and any reservable composite may be opened as a lot.
    #: Nothing replaces it -- there is no threshold left in the design.
    RESERVE_FLOOR_TON: float = 1.07  # D-113: MINT_PRICE + RES_GAS, RES_GAS 0.06 -> 0.07

    #: `PRIME_P0_MIN_TON` (D12, 5 TON) SAT HERE and is **deleted by D-99**. It
    #: existed because the old score gave a plain deep prime `D(n) = 0`, so both
    #: price branches collapsed to `RESERVE_FLOOR`. Under D-99 primality is a
    #: category worth 15 points on its own (plus twin/Sophie Germain/safe/emirp
    #: on top), so the ladder alone opens a plain prime at `2^(15/10)` = 2.83
    #: TON and there is no collapse left for a floor to prevent.

    #: Inherited verbatim from CONCEPT.md SS6, which anchors a genesis lot's start
    #: price at 1.5x the contest/reference fair value.
    PRIME_P0_MULTIPLE: float = 1.5

    #: D4. 7 days. The mint happens at head arrival regardless, so the window
    #: costs nothing; shorter weakens discovery, longer holds bid capital for no
    #: gain.
    AUCTION_WINDOW_SECONDS: int = 7 * 24 * 3600  # 604800

    #: D10. `closesAt = max(closesAt, now + BID_EXTENSION)` on every bid.
    #: Admissible range ~30 minutes (long enough that a bidder in any timezone
    #: can respond) to ~2 hours (short enough that a lot terminates); anything in
    #: that band satisfies the constraint, so the free choice is spent on a
    #: number that belongs to the project. **67 is prime, and deliberate.**
    BID_EXTENSION_SECONDS: int = 67 * 60  # 4020

    #: Mirrors `desirability.W.SCORE_MAX` (D-99). Kept here too because the
    #: ladder is evaluated over `[0, SCORE_MAX]` and the two must not drift --
    #: `test_trophy_auction.py` asserts they are equal. 87, not the pre-D-99
    #: 120, and the number is load-bearing twice over: it puts the top of the
    #: ladder at `MINT_PRICE * 2^(87/10)` = 415.9 TON, just under owner answer
    #: 9's declared 420 TON ceiling, and `87 // 10 + 1 = 9` makes the
    #: bid-increment ladder nine rungs instead of thirteen.
    SCORE_MAX: int = 87


C = TrophyConstants()

#: How many primes the shipped `NPV(p)` dictionary carries (D3). The bound is not
#: a size guess: the NPV branch of `P0` can only bind while
#: `PRIME_P0_MULTIPLE * NPV(p)` beats the prime's own ladder price, and
#: `npv_branch_last_binding_prime` reports the last prime where it does at the
#: shipped calibration. Everything past it is headroom against a longer horizon
#: or a different discount rate, and beyond the dictionary the contract falls
#: back to the ladder with no change in the price it quotes.
NPV_LADDER_PRIME_COUNT = 2_000


# --------------------------------------------------------------------------- #
# The `2^(D/10)` map -- exact integer, and the float it must agree with
# --------------------------------------------------------------------------- #


def frac_table(halving: int = C.SCORE_HALVING, *, scale_bits: int = 16) -> list[int]:
    """`FRAC[j] = round(2^(j/halving) * 2^scale_bits)`.

    Ten integers. This is the entire fractional part of the ladder: TVM has no
    floats, so the contract shifts by the whole doublings and multiplies by one
    of these, then divides by `2^16`. Emitting the table rather than the formula
    is what lets `SimCrossCheck.spec.ts` compare integers.
    """
    return [round(2 ** (j / halving) * (1 << scale_bits)) for j in range(halving)]


FRAC = frac_table()
FRAC_SCALE_BITS = 16


def ladder_nanoton(d: int, *, frac: list[int] | None = None,
                   halving: int = C.SCORE_HALVING,
                   mint_price_nanoton: int = MINT_PRICE_NANOTON,
                   scale_bits: int = FRAC_SCALE_BITS) -> int:
    """`MINT_PRICE * 2^(D/10)` **exactly as the contract computes it**.

    One shift, one lookup, one multiply, one floor-divide -- no floats anywhere,
    and the floor-divide is TVM's `/` on unsigned integers. If this function and
    `primes_trophy_auction.tolk` ever disagree the ladder has drifted, which is
    the failure `test_trophy_auction.py` and `SimCrossCheck.spec.ts` exist to
    catch between them.
    """
    if d < 0:
        raise ValueError("D(n) must be non-negative")
    tbl = FRAC if frac is None else frac
    return ((mint_price_nanoton << (d // halving)) * tbl[d % halving]) >> scale_bits


def ladder_ton_float(d: int, *, frac: list[int] | None = None,
                     halving: int = C.SCORE_HALVING,
                     scale_bits: int = FRAC_SCALE_BITS) -> float:
    """The float evaluation of the **same expression** `ladder_nanoton` evaluates.

    This is the reference the integer form is checked against to the nanoton
    (plan SS9). It is deliberately *not* `MINT_PRICE * 2**(D/10)`: the two differ
    by the `FRAC` table's own rounding, which is a real approximation of size
    `2^-17` relative and is published separately as
    `frac_table_max_relative_error` rather than hidden inside a tolerance. What
    the nanoton check tests is the thing that actually drifts -- the table, the
    shift, and the order of the multiply and the divide.
    """
    tbl = FRAC if frac is None else frac
    return (2.0 ** (d // halving)) * tbl[d % halving] / float(1 << scale_bits)


def ladder_true_ton(d: int, *, halving: int = C.SCORE_HALVING,
                    mint_price_ton: float = MINT_PRICE_TON) -> float:
    """The mathematical `MINT_PRICE * 2^(D/halving)`, for the error report."""
    return mint_price_ton * 2.0 ** (d / halving)


def frac_table_error(frac: list[int] | None = None,
                     halving: int = C.SCORE_HALVING,
                     score_max: int = C.SCORE_MAX) -> dict:
    """How far the ten-integer table sits from the true exponential, published."""
    worst_d, worst_rel = 0, 0.0
    for d in range(score_max + 1):
        true = ladder_true_ton(d, halving=halving)
        rel = abs(ladder_ton_float(d, frac=frac, halving=halving) - true) / true
        if rel > worst_rel:
            worst_d, worst_rel = d, rel
    return {
        "max_relative_error": worst_rel,
        "at_score": worst_d,
        "bound": 2.0 ** -(FRAC_SCALE_BITS + 1),
        "_note": (
            "The FRAC table rounds 2^(j/10) to 16 fractional bits, so the shipped "
            "ladder differs from the true exponential by at most 2^-17 relative "
            "(~7.6e-6). At the SCORE_MAX rung that is a few tens of milliTON on a "
            "4,096 TON opening bid. Stated rather than absorbed into a tolerance: "
            "the contract and the sim agree to the nanoton on the SHIPPED "
            "expression, and the shipped expression is this close to 2^(D/10)."
        ),
    }


# --------------------------------------------------------------------------- #
# Lane entry (plan SS3) and `P0(n)` (plan SS3.1)
# --------------------------------------------------------------------------- #

#: SS7's era boundaries. Neither reservable nor auctionable -- every argument
#: applies with more force at 128 TON than at 0.075.
PRIMORIALS = (2, 6, 30, 210, 2310, 30030, 510510, 9699690, 223092870,
              6469693230, 200560490130, 7420738134810, 304250263527210,
              13082761331670030, 614889782588491410)


def is_primorial(n: int) -> bool:
    return n in PRIMORIALS


def is_prime(n: int) -> bool:
    """Deterministic Miller-Rabin over the first twelve prime bases.

    Exact for every `n < 3.3e24`, which is far above anything the reservation
    shard's uint32 shard id can address. The contract runs the same test; the
    webapp runs it again in-browser at Pick time, and divergence between the
    three is a live bug class (plan SS3).
    """
    if n < 2:
        return False
    small = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37)
    for p in small:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for a in small:
        x = pow(a, d, n)
        if x == 1 or x == n - 1:
            continue
        for _ in range(r - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


ASCENDING = "ascending"
DUTCH = "dutch"
HEAD_ONLY = "head_only"
#: Retained name so old readers do not silently get `None`; it is never returned.
AUCTION = ASCENDING


def lane(n: int, d_score: int = 0, *, prime: bool | None = None,
         c: TrophyConstants = C) -> str:
    """Which lane `n` belongs to, under CONCEPT.md SS4.4's superseding box.

    **There is exactly one route to a number ahead of the head and it depends
    only on primality** (D-30, D-31). `d_score` is accepted and ignored: it no
    longer selects a lane, which is the whole of D-30's simplification. It is
    kept in the signature because every caller has it to hand and because the
    score still prices the lot -- see `p0_nanoton` and
    `acquisition.bid_increment_ladder`.
    """
    if is_primorial(n):
        return HEAD_ONLY
    if prime is None:
        prime = is_prime(n)
    return DUTCH if prime else ASCENDING


def p0_nanoton(d_score: int, *, prime: bool = False, npv_ton: float | None = None,
               c: TrophyConstants = C, frac: list[int] | None = None) -> int:
    """`P0(n)` in nanoTON -- the opening bid, not a ceiling.

    The `max` of three branches under D-99 SS1.2 -- the ladder, the lane floor,
    and `1.5 * NPV(n)` for a prime. The fourth, `PRIME_P0_MIN`, is deleted.
    `npv_ton` is the D3 dictionary lookup and is `None` past the dictionary's
    bound, where the branch cannot bind anyway (see `NPV_LADDER_PRIME_COUNT`).
    """
    best = ladder_nanoton(d_score, frac=frac, halving=c.SCORE_HALVING)
    best = max(best, round(c.RESERVE_FLOOR_TON * NANO))
    if prime and npv_ton is not None:
        best = max(best, round(c.PRIME_P0_MULTIPLE * npv_ton * NANO))
    return best


def p0_ton(d_score: int, **kw) -> float:
    return p0_nanoton(d_score, **kw) / NANO


def reserve_floor_identity(*, mint_price_ton: float, res_gas_ton: float,
                           c: TrophyConstants = C) -> dict:
    """`RESERVE_FLOOR == MINT_PRICE + RES_GAS`, under D-30/D-37.

    The third term is gone. `RES_PRIORITY_BASE` was the price of a place in a
    book ahead of the head; D-30 deletes the book and D-37 deletes the waiver
    claim that was the last thing citing it. What is left is the identity that
    was always load-bearing: the cheapest lot on the lane is the one whose whole
    premium is its own settlement funding, so the floor is not a chosen number
    and moves the moment the settlement gas moves.
    """
    lhs = c.RESERVE_FLOOR_TON
    rhs = mint_price_ton + res_gas_ton
    return {
        "reserve_floor_ton": lhs,
        "mint_price_ton": mint_price_ton,
        "res_gas_ton": res_gas_ton,
        "sum_ton": round(rhs, 9),
        "holds": abs(lhs - rhs) < 1e-9,
        "_rule": "RESERVE_FLOOR = MINT_PRICE + RES_GAS, exactly (D-30 deleted RES_PRIORITY_BASE).",
    }


def ladder_bounds(c: TrophyConstants = C, frac: list[int] | None = None) -> dict:
    """Plan SS6 item 6: monotonicity, the floor, and the top of the band."""
    vals = [p0_nanoton(d, c=c, frac=frac) for d in range(c.SCORE_MAX + 1)]
    floor_nano = round(c.RESERVE_FLOOR_TON * NANO)
    monotone = all(vals[i] <= vals[i + 1] for i in range(len(vals) - 1))
    return {
        "monotone_in_score": monotone,
        "min_p0_ton": vals[0] / NANO,
        "p0_at_score_30_ton": vals[30] / NANO,
        "p0_at_score_max_ton": vals[c.SCORE_MAX] / NANO,
        "above_reserve_floor_everywhere": all(v >= floor_nano for v in vals),
        "declared_band_at_score_max_ton": [415.0, 420.5],
        "_note": (
            "P0 is weakly monotone in D(n) by construction (the RESERVE_FLOOR "
            "branch is a constant floor under a strictly increasing ladder), and "
            "strictly monotone above the score at which the ladder clears the "
            "floor. Under D-99 the SCORE_MAX rung is not a guard but THE STATED "
            "CEILING: 2^(87/10) = 415.9 TON, which is owner answer 9's 420 TON "
            "cap expressed as a clamp on the score rather than as a second rule. "
            "`declared_band_at_score_max_ton` is that ceiling with the FRAC "
            "table's rounding allowance, and it is what "
            "FuzzInvariants.spec.ts's `ladder(87) <= 420.5 TON` asserts."
        ),
    }


def price_table(rows, c: TrophyConstants = C, npv: dict | None = None) -> list[dict]:
    """Plan SS3.1's two worked tables, computed rather than transcribed.

    `rows` is an iterable of `(n, label)`; the score, the lane and the price are
    all derived, so the table in CONCEPT and the table in `params.json` cannot
    disagree without a regeneration saying so.
    """
    from . import desirability as ds

    out = []
    for n, label in rows:
        d = ds.score(n)
        prime = is_prime(n)
        npv_p = (npv or {}).get(n)
        ln = lane(n, d, prime=prime, c=c)
        row = {
            "n": n,
            "label": label,
            "score": d,
            "class": "prime" if prime else "composite",
            "lane": ln,
            "ladder_ton": round(ladder_nanoton(d) / NANO, 6),
        }
        if prime and npv_p is not None:
            row["npv_ton"] = round(npv_p, 4)
            row["npv_branch_ton"] = round(c.PRIME_P0_MULTIPLE * npv_p, 4)
        if ln == HEAD_ONLY:
            # SS7 primorial: no lot of any kind, at any price.
            row["p0_ton"] = None
            row["binding_branch"] = "head_only_primorial"
        else:
            row["p0_ton"] = round(
                p0_nanoton(d, prime=prime, npv_ton=npv_p, c=c) / NANO, 6
            )
            row["binding_branch"] = _binding_branch(d, prime, npv_p, c)
            row["_lane_note"] = (
                "flat P0 until the prime's turn, then a Dutch decay to exactly "
                "MINT_PRICE (D-31)" if prime else
                "opening the lot IS the first bid, paid at P0 (D-30)"
            )
        out.append(row)
    return out


def _binding_branch(d: int, prime: bool, npv_p: float | None,
                    c: TrophyConstants) -> str:
    cands = {
        "ladder": ladder_nanoton(d),
        "reserve_floor": round(c.RESERVE_FLOOR_TON * NANO),
    }
    if prime and npv_p is not None:
        cands["npv"] = round(c.PRIME_P0_MULTIPLE * npv_p * NANO)
    return max(cands, key=lambda k: cands[k])


# --------------------------------------------------------------------------- #
# How many lots this implies (plan SS3.2)
# --------------------------------------------------------------------------- #


def eligible_composites(histogram: dict, thresholds=(20, 30, 40, 50)) -> dict:
    """How many numbers may be opened as a lot -- under D-30, **all of them**.

    The old form of this function answered "how many pass `D_MIN`". D-30 deletes
    the gate, so the count is the whole window and the historical threshold rows
    are kept only to show the size of what the deletion admitted: the shipped
    gate used to exclude 98.6% of the composite line, and every one of those
    numbers is now openable. That multiple is the input to Q26's open-lot volume
    question, which is why the rows survive the mechanic.
    """
    counts = {int(k): v for k, v in histogram["counts_by_score"].items()}
    total = histogram["count"]
    out = {}
    for t in thresholds:
        c = sum(v for s, v in counts.items() if s >= t)
        out[str(t)] = {"would_have_passed": c, "share": c / total}
    admitted = sum(v for s, v in counts.items() if s < 30)
    return {
        "window": histogram["window"],
        "count": total,
        "openable_under_d30": total,
        "openable_share": 1.0,
        "historical_thresholds": out,
        "newly_admitted_by_dropping_d_min_30": admitted,
        "newly_admitted_share": admitted / total,
        "_note": (
            "D-30 drops the `D(n) >= D_MIN` gate: any reservable composite may "
            "be opened as an ascending lot, up to D-11's 14-digit "
            "AUCTIONABLE_MAX. `historical_thresholds` is what the gate used to "
            "exclude, kept so the size of the change is a published number "
            "rather than an impression. Exhaustive over [10^2, 10^7), from "
            "score.histogram."
        ),
    }


# --------------------------------------------------------------------------- #
# D3 -- `NPV(p)` past 13
# --------------------------------------------------------------------------- #


def npv_ladder(*, horizon: int, mints_per_year: float, exponent: float = 0.5,
               f: float = 0.20, tribute_pct: float = 0.10,
               discount_rate_annual: float = 0.35,
               prime_count: int = NPV_LADDER_PRIME_COUNT,
               c: TrophyConstants = C, spf=None) -> dict:
    """D3: the analytic tribute NPV for the first `prime_count` primes.

    `tribute.prime_tribute_npv` is analytic and generalises to every prime under
    a horizon, so the "closed form vs extended table" question in D3 is answered
    by neither: the table is *generated*, not transcribed, and regenerating it at
    a different horizon is one run of this script.

    The calibration (`horizon`, `mints_per_year`) is taken from the Phase 1
    engine run rather than from the function's own defaults -- see
    `npv_calibration_check` for why that matters and by how much.
    """
    from . import tribute as tr

    if spf is None:
        spf = tr.spf_sieve(horizon)
    npv = tr.prime_tribute_npv(
        horizon, spf, exponent=exponent, f=f, tribute_pct=tribute_pct,
        discount_rate_annual=discount_rate_annual, mints_per_year=mints_per_year,
    )["npv"]
    primes = sorted(npv)[:prime_count]
    table = {p: npv[p] for p in primes}

    # The primes on which the NPV branch of P0 actually binds. Under D-99 the
    # comparison is against the number's OWN ladder price rather than against a
    # flat `PRIME_P0_MIN / PRIME_P0_MULTIPLE` constant: `PRIME_P0_MIN` is
    # deleted, and D(p) is no longer 0 for a plain prime, so the branch binds
    # where `1.5 * NPV(p) > max(LOT_FLOOR, 2^(D(p)/10))` and nowhere else. That
    # is a per-prime test, computed, not a threshold anyone can quote.
    from . import desirability as ds

    binding = [p for p in sorted(npv)
               if round(c.PRIME_P0_MULTIPLE * npv[p] * NANO)
               > max(ladder_nanoton(ds.score(p)), round(c.RESERVE_FLOOR_TON * NANO))]
    return {
        "table": table,
        "binding": binding,
        "_binding_rule": (
            "1.5 * NPV(p) > max(LOT_FLOOR, MINT_PRICE * 2^(D(p)/SCORE_HALVING)), "
            "evaluated per prime. D-99 deletes PRIME_P0_MIN, so the old flat "
            "threshold_ton = PRIME_P0_MIN / PRIME_P0_MULTIPLE (10/3 TON) is "
            "gone with it."
        ),
        "horizon": horizon,
        "mints_per_year": mints_per_year,
    }


def npv_calibration_check(engine_npv: dict, analytic_npv: dict) -> dict:
    """Plan SS9: the extension must reproduce the six known genesis NPVs.

    It does not reproduce them exactly, and pretending otherwise by widening a
    tolerance would be the wrong kind of test. The two are different
    computations:

      * `analysis.discounted_tribute_npv_by_prime` walks the **engine's realised
        mint log**, discounting each cash flow by `1/(1+r)^years` at the mint's
        actual simulated wall-clock time. That is what
        `npv_calibration.by_prime.*.engine_npv_ton` publishes.
      * `tribute.prime_tribute_npv` sweeps the **true factorization of every n**
        up to a horizon, discounting by `exp(-r * n / mints_per_year)` -- mint
        index as the clock, a constant arrival rate, and no declines, no
        reservations and no parked heads.

    Evaluated at the engine run's own horizon and realised mint rate the two
    agree to a **uniform** offset across all six primes, which is the finding
    that matters: the shapes match and only the level differs, so the analytic
    ladder inherits the engine's ordering and relative spacing. The residual is
    the arrival process -- the engine's mints accelerate, so its early mints sit
    further out in wall-clock time and discount harder than a constant-rate
    clock assumes -- plus `(1+r)^t` against `exp(rt)`.
    """
    rows = {}
    for p, ev in sorted(engine_npv.items()):
        av = analytic_npv.get(p)
        rows[str(p)] = {
            "engine_npv_ton": ev,
            "analytic_npv_ton": av,
            "analytic_over_engine": (av / ev) if (av is not None and ev) else None,
        }
    ratios = [r["analytic_over_engine"] for r in rows.values()
              if r["analytic_over_engine"] is not None]
    return {
        "by_prime": rows,
        "ratio_min": min(ratios) if ratios else None,
        "ratio_max": max(ratios) if ratios else None,
        "ratio_spread": (max(ratios) - min(ratios)) if ratios else None,
        "_finding": (
            "DIFFERENT COMPUTATIONS, NOT A BUG, AND NOT RECONCILED AWAY. The six "
            "engine NPVs (by_prime.*.engine_npv_ton) come from the "
            "ENGINE run (analysis.discounted_tribute_npv_by_prime over the "
            "realised mint log, wall-clock discounting). The trophy ladder uses "
            "the ANALYTIC sweep (tribute.prime_tribute_npv, mint-index clock at a "
            "constant rate) because that is the only one that generalises past "
            "13. At the engine's own horizon and realised mint rate the analytic "
            "sweep sits a few percent ABOVE the engine on all six, with a spread "
            "of well under one percentage point -- a level offset, not a shape "
            "disagreement. The offset is the engine's accelerating arrival "
            "process (early mints take more wall-clock time than a constant rate "
            "implies, so they discount harder) plus (1+r)^t vs exp(rt). Both "
            "series are emitted; neither is adjusted to match the other."
        ),
    }


# --------------------------------------------------------------------------- #
# The params.json fragment
# --------------------------------------------------------------------------- #


def trophy_auction_block(*, mint_price_ton: float, res_gas_ton: float,
                         histogram: dict,
                         npv_horizon: int,
                         npv_mints_per_year: float, engine_npv: dict,
                         exponent: float = 0.5, f: float = 0.20,
                         tribute_pct: float = 0.10,
                         discount_rate_annual: float = 0.35,
                         c: TrophyConstants = C) -> dict:
    """The top-level `trophy_auction` block of `shared/params.json`."""
    ladder = npv_ladder(
        horizon=npv_horizon, mints_per_year=npv_mints_per_year, exponent=exponent,
        f=f, tribute_pct=tribute_pct, discount_rate_annual=discount_rate_annual, c=c,
    )
    npv = ladder["table"]
    binding = ladder["binding"]

    # Plan SS3.1's two tables, with three transcription errors in the plan
    # corrected rather than reproduced. They are recorded in `_plan_errata`
    # below so the correction is visible rather than silent (CLAUDE.md rule 2):
    # 4817 and 1000003 are PRIME, not the "plain composites" the plan calls
    # them, and 90000000017 = 23 * 3913043479 is COMPOSITE, not the "plain
    # 11-digit prime" it is used to illustrate. Every row here has its class
    # computed by Miller-Rabin, so the table cannot carry that class of error
    # again.
    composite_rows = [
        (738491, "plain 6-digit composite"),
        (4818, "plain 4-digit composite"),
        (1234, "run"),
        (2023, "year"),
        (10000, "power of ten"),
        (1000, "power of ten"),
        (1111, "repdigit"),
    ]
    prime_rows = [(17, "small prime"), (1009, "4-digit prime"),
                  (1000003, "7-digit prime"),
                  (90000000019, "11-digit prime, D(n) = 0")]

    return {
        "_provenance": "declared",
        "_declared_note": (
            "SCORE_HALVING, PRIME_P0_MULTIPLE, AUCTION_WINDOW and "
            "BID_EXTENSION are DECLARED, the same way "
            "genesis.prime_dutch_lane's DECAY_SECONDS and PRIME_P0_MULTIPLE are "
            "declared: owned by the owner, with "
            "a stated constraint each, and NOT simulation outputs. Nothing in "
            "run_phase1.py fits them and TROPHY_AUCTION_PLAN.md SS6 is explicit "
            "that they must not be dressed as derived. Post-launch they become "
            "calibratable against realised clearing prices; pre-launch they "
            "cannot. What IS derived here: the FRAC table, the RESERVE_FLOOR "
            "identity check (RESERVE_FLOOR itself is DERIVED, = MINT_PRICE + "
            "RES_GAS), the openable-lot counts and the "
            "NPV(p) ladder. The MIN_INCREMENT rule has LEFT this list: D-33 "
            "makes it a sim output and acquisition.bid_increment_ladder owns it."
        ),
        "constants": asdict(c),
        "constraints": {
            "SCORE_HALVING": "10 points of D(n) per doubling (D2).",
            "RESERVE_FLOOR_TON": (
                "DERIVED, not declared. Must equal MINT_PRICE + RES_GAS exactly "
                "(D-30/D-37 deleted the RES_PRIORITY_BASE term); checked in "
                "reserve_floor_identity below."
            ),
            "SCORE_MAX": (
                "87 (D-99, owner-declared). The ONE clamp on the summed "
                "categories, and it IS owner answer 9's 420 TON ceiling: the "
                "ladder tops out at 2^(87/10) = 415.9 TON."
            ),
            "PRIME_P0_MULTIPLE": "1.5, inherited verbatim from CONCEPT.md SS6.",
            "AUCTION_WINDOW_SECONDS": (
                "7 days (D4). The mint happens at head arrival regardless, so "
                "the window costs nothing; shorter weakens discovery, longer "
                "holds bid capital for no gain."
            ),
            "BID_EXTENSION_SECONDS": (
                "67 minutes (D10), applied as closesAt = max(closesAt, now + "
                "BID_EXTENSION). Admissible range ~30 min (a bidder in any "
                "timezone can respond) to ~2 h (the lot terminates); anything in "
                "that band satisfies the constraint, so the free choice is spent "
                "on a prime that belongs to the project. 67 is prime, and the "
                "choice is deliberate."
            ),
        },
        "price_map": {
            "_rule": (
                "P0(n) = max( MINT_PRICE * 2^(D(n)/SCORE_HALVING), "
                "PRIME_P0_MULTIPLE * NPV(n) if n prime, RESERVE_FLOOR ). D(n) is "
                "D-99 33-category additive score, clamped once at SCORE_MAX = "
                "87 -- see the `score` block."
            ),
            "_integer_rule": (
                "P0 = (MINT_PRICE_NANOTON << (D / SCORE_HALVING)) * "
                "FRAC[D % SCORE_HALVING] >> 16, with FRAC[j] = "
                "round(2^(j/SCORE_HALVING) * 2^16). One shift, one lookup, one "
                "multiply, one floor-divide -- exact integer arithmetic on TVM. "
                "It runs on the AUCTION contract, not on reserve(), so it does "
                "not touch SS4.4 point 1's 0.0002 TON scoring headroom."
            ),
            "frac_table": FRAC,
            "frac_scale_bits": FRAC_SCALE_BITS,
            "mint_price_nanoton": MINT_PRICE_NANOTON,
            "frac_table_approximation": frac_table_error(),
            "ladder_by_score_ton": {
                str(d): ladder_nanoton(d) / NANO for d in range(0, c.SCORE_MAX + 1, 10)
            },
            # The exact rungs TROPHY_AUCTION_PLAN.md SS3.1's table quotes, so the
            # document and the shipped map can be diffed rung by rung.
            "plan_rungs_ton": {
                str(d): ladder_nanoton(d) / NANO
                for d in (8, 12, 20, 28, 30, 50, 55, 66, 68, 70, 80, 84, 87)
            },
        },
        "lane_entry": {
            "_rule": {
                "prime": (
                    "descending Dutch lane, openable BEFORE its turn at a flat "
                    "P0(p); the decay clock starts at its turn and terminates at "
                    "exactly MINT_PRICE (D-31)"
                ),
                "composite": (
                    "ascending auction lane, at any D(n) -- opening the lot IS a "
                    "paid first bid at P0(n), 7-day clock, D-8 anti-snipe "
                    "extension, and the won lot becomes a claim that waits for "
                    "the head and never expires (D-30)"
                ),
                "primorial": "neither; mint at the head only (CONCEPT.md SS7)",
            },
            "_one_route_rule": (
                "CONCEPT.md SS4.4 superseding box: there is exactly ONE route to "
                "a number ahead of the head and it depends only on primality. "
                "The `D(n) >= D_MIN` gate, the flat-fee `Reserve` entry points "
                "and `RES_PRIORITY_BASE` are all deleted."
            ),
            "_quoting_consequence": (
                "The lane a number belongs to depends on primality, so "
                "getIsOpenable(n) must run Miller-Rabin itself rather than "
                "trusting a caller-supplied kind. SS4.4 point 1a's cleanest "
                "property -- one price query taking one argument -- is spent "
                "here, deliberately."
            ),
            "primorials_excluded": list(PRIMORIALS[:9]),
        },
        "reserve_floor_identity": reserve_floor_identity(
            mint_price_ton=mint_price_ton, res_gas_ton=res_gas_ton, c=c,
        ),
        "bounds": ladder_bounds(c=c),
        "openable_lots": eligible_composites(histogram),
        "npv_ladder": {
            "_purpose": (
                "D3. The engine NPVs stop at 13 and 17 is the "
                "first number that needs it. NPV/sqrt(p) runs 583, 312, 167, 116, "
                "73, 62 over p = 2..13 -- declining fast and not a clean function "
                "of sqrt(p) -- so no cheap extrapolation is available and the "
                "table is GENERATED by the analytic sweep rather than fitted."
            ),
            "source": "sim/primes_sim/tribute.py prime_tribute_npv (analytic)",
            "horizon": ladder["horizon"],
            "mints_per_year": ladder["mints_per_year"],
            "discount_rate_annual": discount_rate_annual,
            "exponent": exponent,
            "flat_dividend_f": f,
            "tribute_pct": tribute_pct,
            "prime_count": len(npv),
            "max_prime_in_table": max(npv) if npv else None,
            "npv_branch_binding_rule": ladder["_binding_rule"],
            "npv_branch_binding_prime_count": len(binding),
            "npv_branch_last_binding_prime": max(binding) if binding else None,
            "_bound_note": (
                "The dictionary carries the first "
                f"{len(npv)} primes. That bound is not a size guess: under D-99 "
                "the NPV branch of P0 binds only where 1.5 * NPV(p) beats the "
                "prime's OWN ladder price max(LOT_FLOOR, 2^(D(p)/10)), which is "
                f"true for {len(binding)} primes and last true at "
                f"p = {max(binding) if binding else 'n/a'}. Everything past that "
                "is headroom against a longer horizon or a lower discount rate. "
                "Beyond the dictionary the contract falls back to the ladder and "
                "quotes exactly the same price it would have quoted with the "
                "entry present. PRIME_P0_MIN, the old third branch and the old "
                "flat 10/3 TON threshold, is deleted."
            ),
            "npv_ton_by_prime": {str(p): npv[p] for p in sorted(npv)},
        },
        "npv_calibration": npv_calibration_check(
            engine_npv, {p: npv[p] for p in engine_npv if p in npv}
        ),
        "price_table_composites": price_table(
            composite_rows, c=c, npv=npv),
        "price_table_primes": price_table(
            prime_rows, c=c, npv=npv),
        "_plan_errata": [
            "TROPHY_AUCTION_PLAN.md SS3.1 lists 4817 as a 'plain 4-digit "
            "composite' and 1000003 as a composite in the composite table. Both "
            "are PRIME, so both are on the auction lane at any D(n) under D3. "
            "4818 is substituted for the composite row (same D = 20); 1000003 "
            "stays, on the prime table where it belongs.",
            "SS3.1's prime table lists 90000000017 as a 'plain 11-digit prime'. "
            "It is composite: 90000000017 = 23 * 3913043479. 90000000019 is the "
            "next prime and is used instead. Under D-99 it is no longer the "
            "D(n) = 0 case the plan wanted to illustrate: primality alone scores "
            "15, so it prices off the ladder and PRIME_P0_MIN -- the floor that "
            "case existed to motivate -- is deleted.",
            "SS3.1's prime table gives D(1009) = 68 and a 111 TON ladder rung. "
            "That table was written against the pre-D-99 score and neither "
            "number survives it: the plan is superseded by D-99 SS1.4, whose "
            "worked examples are regenerated in the `score` block rather than "
            "transcribed anywhere.",
            "SS3.1's composite table gives 340 TON at D = 84. The shipped map "
            "gives 337.789 TON there (2^8.4 = 337.794); 340 is a rounding, not a "
            "different rule.",
            "SS3.1 calls 84 the 'widest realised score' while CONCEPT.md SS4.4 "
            "gives 88 as the widest ACHIEVABLE score. Both are right and they are "
            "different quantities: 88 is a two-digit repdigit (scarcity 28 + "
            "REPDIGIT_W 60), which sits below the histogram window's 10^2 floor; "
            "84 is the widest score any number in [10^2, 10^7) attains (the "
            "three-digit repdigits). Kept distinct -- see "
            "score.histogram.max_score and "
            "max_score_achievable -- rather than reconciled to one number.",
            "SUPERSEDED 2026-08-19 (D-30): the plan's whole sub-threshold "
            "branch -- 'reservable exactly as today' vs a 'flat 1.05 "
            "reservation' -- is void. There is no sub-threshold branch and no "
            "flat fee. Every composite opens as a lot at P0(n), whose floor is "
            "MINT_PRICE + RES_GAS.",
        ],
        "money": {
            "_rule": (
                "C = 1 TON mint leg (splits per SS4.1 IN THE CLOSE, D-90) + "
                f"RES_GAS {res_gas_ton} (carved BEFORE the premium, funds that "
                "settlement) + premium (C - 1 - RES_GAS). RES_PRIORITY_BASE does "
                "not exist (D-30/D-37): it was the price of a place in a book "
                "ahead of the head, and the auction now IS that price."
            ),
            "mint_leg_ton": mint_price_ton,
            "res_gas_carved_ton": res_gas_ton,
            "treasury_cut_on_premium_pct": econ.PREMIUM_TREASURY_BPS / 100.0,
            "premium_destination": (
                "half to the governed treasury contract, half to ratchet pending "
                "at CLOSE as k = 0 money (D-114)"
            ),
            "_premium_note": (
                "D-114 (owner-set, amends D-6/D-7): the premium splits "
                "`genesis.premium_treasury_bps` to the governed treasury (no key, "
                "D-100 point 7) and the rest to the ratchet as `pending` at close: "
                "T rises by that half, S is untouched. There is no escrow and no "
                "release (D-90), so nothing takes it back out."
            ),
            "settles_at_k": "k_min",
            "_k_note": (
                "An auctioned mint settles at k = k_min, exactly as SS4.4 point 3 "
                "already requires of reservations: a bought-forward number must "
                "not also camp the k(t) curve."
            ),
        },
        "still_owed": [
            "Realised clearing prices -- POST-LAUNCH TELEMETRY, not "
            "launch-blocking (SS11.26 as re-scoped 2026-09-24). Every clearing "
            "figure here rests on a bidder-arrival process no lot has ever "
            "tested; none may be quoted on a public surface until the lane has "
            "run (SS9.1's staleness clause).",
        ],
        "_prefunding_delivered_note": (
            "Prime pre-funding displacement left this list 2026-09-24: it is "
            "`determinations.q26_auction_lane.prime_prefunding_displacement`, "
            "from the lane-aware buyer model in "
            "market.prime_prefunding_displacement."
        ),
        "derivation": (
            "TROPHY_AUCTION_PLAN.md SS3.1. The auction assigns the RIGHT TO BUY, "
            "not the number: the mint is 1 TON at the head for anyone who waits, "
            "and the auction prices the position ahead of the head. Every price "
            "here is therefore bounded above by the value of certainty plus the "
            "value of timing, never by the value of the number, and the bypass is "
            "intended rather than a leak. Must match "
            "contracts/contracts/primes_market.tolk -- "
            "SimCrossCheck.spec.ts asserts it."
        ),
    }
