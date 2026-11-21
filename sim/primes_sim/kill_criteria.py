"""Phase 1 kill criteria for CONCEPT.md design draft v5
(UPGRADE_PLAN_V5.md SS3, "Kill criteria to report explicitly").

Two, and both are reported whether they pass or fail:

  2. persistent AMM detachment below floor **that the guard's accumulated
     balance cannot close** (SS4.3.1) -- note the second clause: under the guard
     a detachment is only fatal if `pending` is too small to buy it back;
  3. tribute too thin to clear auction reserves under the new `sqrt(p)`
     weighting (SS12 -- "the same lever pulled from opposite ends").

**There were five.**

The THIRD retirement (2026-09-24) is criterion 1, unbounded growth in the
expected wait at a prime head. Under DECISIONS.md D-20 the head never stops at a
prime -- it opens a Dutch lot and walks on -- and the baseline now runs that
model, so there is no prime-head wait to grow. It is deleted, not left to pass
vacuously on an empty distribution.

The SECOND retirement is D-106's. Criterion 3 used to be "activation rate `a`
below 41.5% for locked gifts (SS4.6.2)", and it reported **FAIL** at the
published cost basis for its entire life -- a fixed nominal PATRON_CAP measured
against a cost basis that rises as `k_max(n)` decays, which D-57 showed inverts
at n ~ 1173. D-106 deletes patron mode rather than re-basing the criterion to the
flattering number, so the criterion has nothing left to measure. Note what does
NOT replace it: the recruit ladder D-106 keeps pays in `k_max` uplift and never
in TON, so there is no payer to be underwater and no breakeven to check. It is
bounded by the K_CEIL clamp, which criterion 1's uplift stack already exercises.

The FIRST retirement was blue-chip constellation crowding: does
SS3.2.2's x3/2 multiplier on a boosted set cut the organic (>200) band's share of
the divisor line by more than 10% relative? It PASSED, twice and by a wide
margin: **-2.68%** on this script's own uniform-boost call at a 100,000 horizon,
and **-2.25%** on run_constellations.py's re-run at realistic adoption density,
against the same -10% threshold. D-102 deletes the multiplier outright, so the
criterion has nothing left to measure and is deleted rather than re-tuned
(DECISIONS.md D-102, "the measured -2.25% is being DELETED, not re-tuned"). It
never gated anything the other four gate: no sink, no burn amount and no other
criterion read it, so `all_passed` is
the same verdict over one fewer, still-passing, test. A future weighting
multiplier does not inherit that clearance -- it re-runs the check against
whatever registry shape it proposes.

The concept text names failure *modes*, not numeric thresholds. Every threshold
below is this simulation's judgment call and is labelled as such.
"""
from __future__ import annotations

from . import analysis as an
from .engine import Engine


def check_amm_detachment(e: Engine) -> dict:
    """Kill criterion 2, restated for the floor guard: a detachment is fatal
    only if the ratchet's accumulated balance cannot close it."""
    d = an.amm_vs_floor_detachment(e)
    close = an.guard_can_close_detachment(e)
    threshold_days = 14.0
    threshold_frac = 0.15
    persistent = (
        d["approx_max_consecutive_days_below_floor"] >= threshold_days
        or d["fraction_of_samples_below_floor"] >= threshold_frac
    )
    passed = (not persistent) or bool(close.get("balance_sufficient", False))
    return {
        "name": "amm_detachment_guard_cannot_close",
        "passed": bool(passed),
        "threshold_max_consecutive_days_below_floor": threshold_days,
        "threshold_fraction_of_samples_below_floor": threshold_frac,
        "persistent_detachment_observed": bool(persistent),
        "measured": d,
        "guard_capacity": close,
    }


def check_tribute_justifies_reserve(auction: dict) -> dict:
    """Kill criterion 4 (it was 5 before D-102 retired the crowding check).
    SS12 warns the `sqrt(p)` weighting *sharpens* this risk
    by cutting the first ten primes from 62% to 22% of the line.

    Two thresholds, both this simulation's judgment calls:
      * every auctioned prime's reference value must clear 5 TON, so an auction
        reserve is meaningfully above the 1 TON anyone pays at the head;
      * the six together must clear 100 TON, enough that the genesis LP is not
        moved more than ~1% by a single mint.
    """
    min_ref = 5.0
    min_total = 100.0
    refs = {p: v["reference_reserve_ton"] for p, v in auction["v5_reference_prices"].items()}
    total = sum(refs.values())
    failures = [{"prime": p, "reference_reserve_ton": v} for p, v in refs.items() if v < min_ref]
    passed = not failures and total >= min_total
    return {
        "name": "tribute_justifies_auction_reserve_under_sqrt_p",
        "passed": bool(passed),
        "threshold_min_reference_ton_per_prime": min_ref,
        "threshold_min_total_ton": min_total,
        "measured_total_reference_ton": total,
        "failures": failures,
        "measured": auction,
    }


def run_all(e: Engine, auction: dict) -> list[dict]:
    return [
        check_amm_detachment(e),
        check_tribute_justifies_reserve(auction),
    ]
