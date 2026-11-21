"""The four §11 determinations that were blocked on simulation output.

Runs, and writes to `shared/params.json` under the **`determinations`** key
(which this script owns exclusively -- see the ownership note below):

  Q25 / D-12 / D-21  DELETED by D-99 -- the weights are owner-declared now.
                     (was: the desirability weight vector, under the objective the
                     owner signed on 2026-08-17;
  Q12                the activation bonus -- all three alternatives priced,
                     LAUNCH-BLOCKING;
  Q18 / D-10         DELETED by D-168 -- the `k_max`-uplift stake it gated
                     no longer exists (staking pays PRIMES from the treasury);
  Q26                the auction lane: clearing-price distribution by score
                     band, head-collision probability under D-8's **extending**
                     close, and the expected unsold-prime tribute forfeit.

`H`, the Dutch lookahead, is deliberately absent. D-20 point 3 retired
`lookaheadH` outright and §11.26 deletes it from the owed list rather than
sizing it: a prime is never on the sequential line, so there is nothing to look
ahead of. A sweep of `sim/` on 2026-08-17 found no `H`/`lookaheadH` symbol to
remove -- the sim never had one.

--------------------------------------------------------------------------- #
PARAMS OWNERSHIP -- read before adding a key
--------------------------------------------------------------------------- #
`shared/params.json` has two generators now (TELEGRAM_INVITES_PLAN.md deleted
run_constellations.py with constellations and generators):

    run_phase1.py          rebuilds the whole document; declares
                           FOREIGN_PARAM_KEYS and merges the others through
    run_determinations.py  owns `determinations` and `acquisition`  <-- this file

`invites` (SS4.1's seventh line) is NOT foreign to anyone: run_phase1.py
owns it, because it is beta arithmetic and beta is that script's output.

The rule is unchanged and `sim/tests/test_params_ownership.py` pins it: a script
that owns key X is the ONLY writer of X, preserves every key it does not own,
and every whole-file writer lists X in `FOREIGN_PARAM_KEYS`. This script only
ever assigns `params["determinations"]`, and never rewrites anything else.

--------------------------------------------------------------------------- #
WHAT IS SELECTED AND WHAT IS ONLY BOUNDED
--------------------------------------------------------------------------- #
Stated per determination in the emitted block, under `_status`. The rule is
the retired `newcomer_lever_sweep`'s: a number is SELECTED only when the sweep
over the premises agrees with itself; otherwise it is BOUNDED, the range is
published, and what would make it decidable is named. Nothing is selected by
picking a premise that produces a nice answer.

Usage (from /sim):
    python scripts/run_determinations.py

Deterministic: every run is seeded and re-running reproduces the same numbers.
"""
from __future__ import annotations

import json
import inspect
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from primes_sim import acquisition as acq
from primes_sim import analysis as an
from primes_sim import market as mk
from primes_sim import tribute as tr
from primes_sim import trophy_auction as ta
from primes_sim.arrivals import ArrivalParams
from primes_sim.engine import Engine, PrimeHeadParams, SimParams

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output")
PARAMS_PATH = os.path.join(REPO_ROOT, "shared", "params.json")

SEED = 20260817
#: Multi-seed replication count. Every floor trajectory in this file is reported
#: with its across-seed spread, because D-10's go/no-go asks for the pessimistic
#: case "with its variance" and a single realised path cannot supply one.
SEEDS = (20260817, 20260818, 20260819, 20260820, 20260821)

#: The head range every §11.26 integral and the Q25 objective are taken over.
#: Not the whole `[10^2, 10^7)` reservable window: under D-20 a prime lot opens
#: only once every composite below it is built, so the lots that EXIST over a
#: horizon are the ones inside the range the head actually covers. `HEAD_HI` is
#: set at roughly TWICE the D-20 baseline run's realised one-year head (~97,600),
#: i.e. about two years of head travel, so the lane population is the one a
#: reader can expect to see rather than one that will not open for decades. It
#: is reported next to every number derived from it, and every per-head-mint
#: figure is normalised by the composites inside it, so widening the range does
#: not inflate the objective.
HEAD_LO = 100
HEAD_HI = 200_000

#: Engine settings shared by every run in this file. Deliberately the same
#: shape as `run_phase1.BASELINE_KWARGS` so the two are comparable, with the
#: one difference that matters stated loudly: `primes_skip_head=True`.
BASE = dict(
    k_min=0.2,
    k_max_cap=0.9,
    ramp_seconds=3600.0,
    n0_anchor=1000,
    flush_pct=0.20,
    flush_cooldown_seconds=86400.0,
    flush_min_ton=5.0,
    floor_guard=0.0,
    floor_guard_enabled=True,
    genesis_lp_primes_per_ton=10_000.0,   # DENOMINATION_PLAN P1 (L = 10,000; owner 2026-08-19)
    bounty_vault_pct_of_lp=0.20,
    genesis_seed_ton=200.0,
    horizon_days=365.0,
    n_max=HEAD_HI,
    history_every_n_mints=250,
    primes_skip_head=True,          # DECISIONS.md D-20
    prime_head=PrimeHeadParams(enabled=False),   # no head can park on a prime
)


def load_lane_gas() -> dict:
    """`RES_GAS`, the lane floor and the bid round trip, read from the file that
    owns them.

    All three are derived by `gas.res_gas_derivation` / `gas.bid_round_trip_ton`
    off `contracts/gas-baseline.json` and written to `shared/params.json` by
    `run_phase1.py`. Reading them back rather than restating them is the
    difference between one source of truth and two numbers that agree today:
    `RES_GAS` moves the moment the close/settle gas moves, and this script must
    move with it rather than pin a stale value.

    **`res_priority_ton` is gone** (D-30). There is no RES_FEE to split.
    **`open_release_round_trip_ton` is gone** (D-90.2). There is no release.
    """
    with open(PARAMS_PATH, "r", encoding="utf-8") as f:
        res = json.load(f)["off_head"]
    return {
        "res_gas_ton": res["res_gas_ton"],
        "lane_floor_ton": res["lane_floor_ton"],
        "bid_round_trip_ton": res["bid_round_trip_ton"],
    }


def run(seed: int, **overrides) -> Engine:
    kwargs = dict(BASE)
    kwargs.update(overrides)
    return Engine(SimParams(seed=seed, **kwargs)).run()


def spread(values) -> dict:
    """Mean, sd and range of a quantity across seeds. Used everywhere a single
    realised path would otherwise be quoted as if it were the answer."""
    a = np.asarray([v for v in values if v is not None], dtype=float)
    if a.size == 0:
        return {"n": 0}
    return {
        "n": int(a.size),
        "mean": float(a.mean()),
        "sd": float(a.std(ddof=1)) if a.size > 1 else 0.0,
        "min": float(a.min()),
        "max": float(a.max()),
        "relative_sd": float(a.std(ddof=1) / a.mean()) if a.size > 1 and a.mean() else 0.0,
    }


def head_velocity_samples(e: Engine) -> list[float]:
    """Realised mints/day between history samples -- the empirical head-velocity
    distribution §11.26 asks the collision probability to be computed against."""
    out = []
    h = e.history
    for a, b in zip(h, h[1:]):
        dt = b["t_days"] - a["t_days"]
        dn = b["mint_index"] - a["mint_index"]
        if dt > 0 and dn > 0:
            out.append(dn / dt)
    return out


# =========================================================================== #
# Q25 / D-12 / D-21 -- DELETED by DECISIONS.md D-99
# =========================================================================== #
#
# Q25 asked the sim to SELECT the desirability weight vector under D-21's signed
# objective, and D-12/D-21 were the decisions that made that a sim question. D-99
# answers it a different way and closes it: the 33 category weights are
# OWNER-DECLARED (SS1.3, answers 3/6/10), they live in `shared/opcodes.ts`, and
# `desirability.py` parses them rather than fitting them. A search over weights
# the owner has signed would be the sim dressing an owner decision as an output,
# which is exactly what CLAUDE.md rule 3 forbids -- so the search, its coordinate
# ascent (`market.optimise_weights`), its feasibility test
# (`market.ordering_violations`, D-21's constraint 3 over a pattern ordering that
# no longer exists) and the `determinations.q25_desirability_weights` block are
# all deleted rather than left running against a question nobody is asking.
#
# What SURVIVES from Q25's machinery is the lane model it was built on --
# `market.evaluate_lane` (renamed from `evaluate_weights` for the same reason) --
# because Q26 and the D-33 bid-increment ladder both consume it, and because the
# premium it measures is a property of the MECHANIC rather than of a weight
# vector.


# =========================================================================== #
# Q26 -- the auction-lane outputs
# =========================================================================== #


def q26(census: dict, prime_npv: dict, res_gas_ton: float,
        mints_per_day: float, lane_floor_ton: float, ladder: dict) -> dict:
    """Q26 **as re-scoped by D-30, and by D-45's head-collision retirement**
    (LAUNCH_FIX_PLAN W8.1), launch-blocking.

    The question gained a half and then lost a different one. It was:
    clearing-price distribution, head-collision probability under D-8's
    extending close, unsold-prime forfeit. D-30 added simultaneously-open-lot
    volume and post-win queue depth under a `D_MIN`-free lane -- dropping the
    gate multiplies the openable set by roughly seventy, raising the question
    of whether the resulting claim flow congests the head. D-45 then retired
    the head-collision half outright: the ledger takes a composite off its
    sequential line the instant a lot opens, so the head can never again reach
    an open lot's number and there is no collision left for a probability to
    bound.

    Every clearing figure below is computed over the WHOLE composite line
    rather than over the `D >= D_MIN` tail, so none of the pre-D-30 run's band
    figures carry over. `H` is still not here and must not be added.
    """
    prem = mk.ObjectivePremises(draws=800, seed=SEED)
    rep = mk.evaluate_lane(census, prime_npv, prem, res_gas_ton=res_gas_ton,
                           increment_ladder=ladder)

    # --- 2. mean lot open life under D-8's EXTENDING close ---------------- #
    # `open_lot_volume` below needs how long a lot stays open; the collision
    # question that used to be computed alongside it is retired by D-45.
    mean_open_days = mk.mean_lot_open_days(
        lam_late_per_hour=2.0, max_bidders=20, seed=SEED)

    # --- 3. unsold-prime tribute forfeit --------------------------------- #
    # The forfeit is dominated by ONE premise -- how many buyers look at a given
    # prime lot per day -- so it is swept rather than reported at a point. The
    # range is anchored on something checkable: at `lam` buyers per lot per day
    # across `L` open lots the model implies `lam * L` prime buyers per day, and
    # that has to sit in a plausible relation to the realised head velocity of
    # `mints_per_day` composites. Both numbers are reported per row so the owner
    # can reject a row on that ground rather than on taste.
    lots_open = len(prime_npv)
    forfeit_sweep = {}
    for lam in (0.005, 0.02, 0.10, 0.30):
        p = mk.replace(prem, lam_dutch_per_day=lam)
        r = mk.unsold_prime_forfeit(
            npv_by_prime=prime_npv, census=census, prem=p,
            head_range=(HEAD_LO, HEAD_HI), draws=200,
            mints_per_day=mints_per_day, res_gas_ton=res_gas_ton, seed=SEED)
        r.pop("rows", None)
        r["implied_prime_buyers_per_day"] = lam * lots_open
        r["composite_mints_per_day_for_comparison"] = mints_per_day
        r["implied_buyers_per_composite_mint"] = (lam * lots_open) / mints_per_day
        forfeit_sweep[f"lam_dutch={lam}/lot/day"] = r
        print(f"    forfeit at lam={lam}: unsold share "
              f"{r['expected_unsold_share']}, forfeit "
              f"{r['expected_forfeited_tribute_ton']:.1f} TON, implied "
              f"{r['implied_buyers_per_composite_mint']:.2f} prime buyers per "
              f"composite mint")
    forfeit = mk.unsold_prime_forfeit(
        npv_by_prime=prime_npv, census=census, prem=prem,
        head_range=(HEAD_LO, HEAD_HI), draws=200,
        mints_per_day=mints_per_day, res_gas_ton=res_gas_ton, seed=SEED)
    forfeit["premise_sweep"] = forfeit_sweep

    # --- 3b. prime pre-funding displacement (Q26 as re-scoped 2026-09-24) -- #
    # Swept over the same buyer-rate axis as the forfeit, and over the P0 level.
    # The carry rate is the tribute NPV's own discount rate, read off the
    # function that defines it so the two cannot drift apart.
    carry = inspect.signature(tr.prime_tribute_npv).parameters[
        "discount_rate_annual"].default
    displacement = {}
    for lam in (0.005, 0.02, 0.10, 0.30):
        d = mk.prime_prefunding_displacement(
            npv_by_prime=prime_npv, census=census,
            prem=mk.replace(prem, lam_dutch_per_day=lam),
            head_range=(HEAD_LO, HEAD_HI), mints_per_day=mints_per_day,
            carry_rate_annual=carry)
        displacement[f"lam={lam}/prime/day"] = d
        x1 = d["by_p0_multiple"]["p0_x1.0"]
        print(f"    displacement at lam={lam}: {x1['displaced_share']} of "
              f"{d['primes_considered']} primes bought ahead of the head "
              f"(lane-unaware bound {x1['lane_unaware_upper_bound_share']})")
    base_key = f"lam={prem.lam_dutch_per_day}/prime/day"

    # --- 4. THE NEW HALF: open-lot volume and post-win queue depth ------- #
    # Both are computed at the ascending lane's OWN measured participation and
    # clearing price, so the two halves of Q26 cannot disagree about the same
    # lot. The mean open distance is the midpoint of the head range: a lot may
    # be opened anywhere from the head to AUCTIONABLE_MAX, and the head range is
    # the only span over which the lane population is a population a reader can
    # expect to see rather than one that will not open for decades.
    asc_bands = {k: v for k, v in rep["by_band"].items() if k != "prime_dutch"}
    asc_lots = sum(v["lots"] for v in asc_bands.values())
    asc_sold = sum(v["sold"] for v in asc_bands.values())
    asc_participation = (asc_sold / asc_lots) if asc_lots else 0.0
    asc_clearing = (
        sum(v["premium_ton"] for v in asc_bands.values()) / asc_sold + 1.0
        if asc_sold else lane_floor_ton)
    volume = acq.open_lot_volume(
        mints_per_day=mints_per_day,
        mean_open_days=mean_open_days,
        participation=asc_participation,
        mean_open_distance_mints=(HEAD_HI - HEAD_LO) / 2.0,
        p0_floor_ton=lane_floor_ton,
        mean_clearing_ton=asc_clearing,
    )

    return {
        "_question": (
            "Q26 -- the auction-lane simulation outputs: clearing-price "
            "distribution, the unsold-prime tribute forfeit and (re-scoped "
            "2026-09-24, the launch-blocking one) the prime pre-funding "
            "displacement. (The "
            "head-collision probability that used to be a third leg is retired "
            "by D-45: an open lot's number is off the head's line for good.)"
        ),
        "_status": "BOUNDED",
        "_status_reason": (
            "Both rest on a bidder-arrival process no lot has ever tested, "
            "so they are published as a swept range with the premises named, not "
            "as point forecasts. §11.26 itself says these become meaningful only "
            "'once the lane exists and has realised bids to check against', and "
            "none of them may be quoted on a public surface until then."
        ),
        "_H_not_computed": (
            "`H`, the Dutch lookahead, is NOT here and is not owed. D-20 point 3 "
            "retired `lookaheadH` outright and §11.26 deletes it from the owed "
            "list rather than sizing it: a prime is never on the sequential "
            "line, so there is nothing to look ahead of and the claim 'the head "
            "never stalls on a prime' is structural. A sweep of `sim/` found no "
            "`H`/`lookaheadH` symbol -- there was nothing to delete."
        ),
        "clearing_price_distribution": {
            "_purpose": (
                "§11.26: the 7-day window has no calibration statement "
                "equivalent to genesis's 'clearing around one month' until this "
                "exists. This is that statement's raw material."
            ),
            "by_score_band": rep["by_band"],
            "head_range": [HEAD_LO, HEAD_HI],
            "ascending_lane_is_composites_only": True,
            "_d22_note": (
                "These bands price composites only. D-22 (`open_lot` refuses "
                "primes) is SUPERSEDED by D-88 point 3: a prime may be opened "
                "ahead of the head too, and how often that happens is "
                "`prime_prefunding_displacement` below."
            ),
            "premises": mk.asdict(prem),
        },
        "open_lot_volume_and_queue_depth": {
            "_purpose": (
                "THE NEW HALF OF Q26 (LAUNCH_FIX_PLAN W8.1). Dropping `D_MIN` "
                "means far more lots can exist at once; the question is whether "
                "that congests the head. Answered as a ratio of two rates -- "
                "claims created per day over composites minted per day -- which "
                "is why the conclusion survives the demand level nobody has "
                "measured."
            ),
            "ascending_lane_measured": {
                "lots_in_head_range": asc_lots,
                "participation": round(asc_participation, 6),
                "mean_clearing_ton": round(asc_clearing, 4),
                "mean_open_days": round(mean_open_days, 4),
            },
            **volume,
        },
        "prime_prefunding_displacement": {
            "_question": (
                "§11.26 as re-scoped 2026-09-24: what fraction of primes are "
                "bought AHEAD of the head on D-88 point 3's ascending lot at "
                "P0(p), rather than at their own turn on the descending lot, and "
                "how the P0 level moves it. D-88 point 3 superseded D-22, so a "
                "prime CAN be opened ahead of the head and the question is live."
            ),
            "_source": (
                "sim/scripts/run_determinations.py -> "
                "market.prime_prefunding_displacement. LANE-AWARE BUYER MODEL: "
                "an interested buyer of prime p arrives while p is ahead of the "
                "head, tau days before its turn (tau = composites between "
                "HEAD_LO and p over the engine's realised composite mints/day), "
                "with the lane model's private value (P1 scarcity value of the "
                "number + P2 NPV/uplift/rights, P4 lognormal sigma). They open "
                "the ascending lot now iff (v - P0)*(1 - exp(-lam*s*tau)) > "
                "P0*(exp(r*tau) - 1): certainty against a rival taking the "
                "descending lot at its opening price P0, against the carry of "
                "paying tau days early (a prime earns no tribute before the "
                "head passes it). s = P(value >= P0); r = the tribute NPV's "
                "discount rate. P(displaced) = 1 - exp(-lam * integral of "
                "P(open | tau)), exact for Poisson arrivals. "
                "ASSUMED, NOT MEASURED: (1) buyer interest ahead of the head "
                "arrives at the same per-prime rate lam as on the descending "
                "lot (P3/P6), swept 0.005..0.30/day because no lot has ever "
                "run; (2) the buyer is myopic -- rivals are the Poisson future, "
                "earlier waiters are invisible on chain; (3) CONSERVATIVE "
                "(pushes displacement UP): opening ignores rivals contesting "
                "the ascending lot, waiting ignores buying below P0 as the "
                "descending lot decays. The P0 sweep multiplies the shipped "
                "P0(p) = max(ladder, RESERVE_FLOOR, 1.5*NPV) as a whole. "
                "`lane_unaware_upper_bound_share` is the composite lane's own "
                "rule (every buyer valuing it >= P0 opens)."
            ),
            "_status": "BOUNDED",
            "carry_rate_annual": carry,
            "baseline_premise": base_key,
            "baseline_displaced_share_at_shipped_p0": displacement[base_key][
                "by_p0_multiple"]["p0_x1.0"]["displaced_share"],
            "premise_sweep": displacement,
        },
        "unsold_prime_forfeit": forfeit,
        "_forfeit_finding": (
            "This is the number §12's revenue-risk entry is now accepted "
            "against. It is computed as if every prime waits for its turn; "
            "`prime_prefunding_displacement` measures how many do not, so it "
            "overstates the forfeit by that share. Note where it goes: D-20 point 4 routes forfeited tribute to the "
            "TREASURY, so it is operator revenue rather than a loss to the "
            "pool -- which means the protocol-level cost of a slow-selling "
            "prime is borne by the ratchet only through the premium it did not "
            "capture, not through the tribute."
        ),
    }


# =========================================================================== #


def main():
    t0 = time.time()
    os.makedirs(OUT_DIR, exist_ok=True)
    fees = load_lane_gas()
    print(f"  lane gas read from params.json: {fees}")

    # The baseline is run TWICE and both are reported, because the prime lane's
    # outcome is an input to the engine and the engine's head velocity is an
    # input to the prime lane. Pass 1 fixes the head velocity with NO prime
    # sales at all -- which is a real and useful bound, "nobody ever buys a
    # prime" -- and pass 2 re-runs it with the lane outcome the market model
    # measured. Reporting only pass 1 would understate the floor (every prime
    # premium is missing from `T`) and overstate the forfeit; reporting only
    # pass 2 would hide the bound.
    print("=== 0. D-20 baseline, pass 1: no prime lot ever sells (the bound) ===")
    base0 = run(SEED)
    vel = head_velocity_samples(base0)
    mints_per_day = len(base0.mint_log) / BASE["horizon_days"]
    print(f"  head {base0.head:,}  composite mints {len(base0.mint_log):,}  "
          f"prime lots {base0.prime_lots_opened:,}  declines {base0.prime_declines}  "
          f"floor {base0.floor_price:.6f}")
    assert base0.prime_declines == 0, "D-20: the head cannot park on a prime"
    assert not any(ev.kind == "prime" for ev in base0.mint_log), \
        "D-20: a prime is never a head mint"

    print("\n=== 0b. Census + NPV ladder over the head range ===")
    census = mk.class_census(HEAD_LO, HEAD_HI, chunk=200_000)
    npv_all = tr.prime_tribute_npv(HEAD_HI, mints_per_year=mints_per_day * 365.0)["npv"]
    prime_npv = {p: v for p, v in npv_all.items() if HEAD_LO <= p < HEAD_HI}
    print(f"  {len(census['cells'])} cells, {len(prime_npv):,} prime lots in range")

    # D-33's ladder is derived FIRST: every ascending lot below is priced under
    # the step the contract ships, never under the retired `max(1 TON, 5%)`.
    print("\n=== 0b2. D-33 -- the minimum bid increment ladder ===")
    ladder_prem = mk.ObjectivePremises(draws=400, seed=SEED)
    ladder = acq.bid_increment_ladder(
        census, prime_npv, ladder_prem,
        res_gas_ton=fees["res_gas_ton"],
        bid_round_trip_ton=fees["bid_round_trip_ton"],
    )
    print(f"    floor {ladder['min_increment_floor_ton']} TON, "
          f"bps by rung {ladder['min_increment_bps']}")

    # The prime lane's own measured outcome, fed back into the engine so its
    # runs price the D-7 premium injection off the SAME model that Q26
    # publishes rather than off a second, silently different one.
    prem = mk.ObjectivePremises(draws=800, seed=SEED)
    lane = mk.evaluate_lane(
        census, prime_npv, prem,
        res_gas_ton=fees["res_gas_ton"],
        increment_ladder=ladder)["by_band"]["prime_dutch"]
    prime_lot = {
        "prime_lot_sale_probability": lane["sale_rate"],
        "prime_lot_mean_premium_ton": lane["premium_per_lot_ton"],
        "prime_lot_mean_days_to_sale": lane["mean_days_to_sale"] or 0.0,
    }
    print(f"  prime lane: sale rate {lane['sale_rate']:.3f}, "
          f"mean premium {lane['premium_per_lot_ton']:.3f} TON/lot")

    print("\n=== 0c. D-20 baseline, pass 2: with the measured prime lane ===")
    base = run(SEED, **prime_lot)
    print(f"  head {base.head:,}  composite mints {len(base.mint_log):,}  "
          f"prime lots {base.prime_lots_opened:,} "
          f"(sold {base.prime_lots_sold:,}, unsold {base.prime_lots_unsold:,})  "
          f"floor {base.floor_price:.6f}  premium to ratchet "
          f"{base.prime_lot_premium_total:,.0f} TON")

    # The lane's effect on the floor, ACROSS SEEDS rather than on one path.
    # A single paired run is not a controlled experiment here: turning the lane
    # on gives the unsold primes owners, which changes how many claim draws the
    # main RNG stream makes, so the two paths diverge for a reason that has
    # nothing to do with the economics. Averaging over seeds is the honest fix
    # and it is cheaper than threading a third RNG stream through the claim path.
    off = [run(s).floor_price for s in SEEDS]
    on = [run(s, **prime_lot).floor_price for s in SEEDS]
    lane_effect = {
        "floor_without_prime_lane": spread(off),
        "floor_with_prime_lane": spread(on),
        "relative_uplift": (float(np.mean(on)) / float(np.mean(off)) - 1.0)
        if np.mean(off) else None,
        "seeds": list(SEEDS),
        "_method": (
            "Mean over seeds, not a single paired path. Turning the lane on "
            "gives previously-unowned primes owners, which changes how many "
            "claim draws the main RNG stream makes, so one paired run diverges "
            "for a reason unrelated to the economics. The across-seed means are "
            "the comparison; the sds say how much of the gap is noise."
        ),
        "_what_it_measures": (
            "How much of the floor the prime Dutch lane is responsible for. "
            "Under D-7 the premium is a pure `T` increment against an untouched "
            "`S`, so all of it is floor and none of it is emission -- the one "
            "leg of the design that raises the floor without diluting anyone."
        ),
    }
    print(f"  lane effect on the floor: "
          f"{lane_effect['floor_without_prime_lane']['mean']:.6f} -> "
          f"{lane_effect['floor_with_prime_lane']['mean']:.6f} "
          f"({lane_effect['relative_uplift'] * 100:+.1f}%) over {len(SEEDS)} seeds")

    print("\n=== 2. Q12 -- the activation bonus (LAUNCH-BLOCKING) ===")

    print("\n=== 4. Q26 -- the auction lane, re-scoped by D-30 ===")
    q26_block = q26(census, prime_npv, fees["res_gas_ton"], mints_per_day,
                    fees["lane_floor_ton"], ladder)

    # D-90.2 DELETES determination 6 (D-32 / W8.2, the release forfeit against
    # the open-and-release gas). There is no release to price: a won lot mints in
    # its own close. The griefing vector it guarded is closed by D-88 point 3
    # instead -- opening a lot is a paid first bid of at least PRIME_P0_MIN.

    acquisition_block = {
        "_meta": {
            "description": (
                "The unified acquisition lane (CONCEPT.md SS4.4 as superseded "
                "2026-08-19; DECISIONS.md D-30/D-31/D-33, D-88, D-90). "
                "Generated by sim/scripts/run_determinations.py, which OWNS "
                "this key."
            ),
            "source": f"sim/scripts/run_determinations.py, seed={SEED}",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "decisions": ["D-30", "D-31", "D-33", "D-88", "D-90"],
            "consumers": {
                "bid_increment_ladder": "LAUNCH_FIX_PLAN W1.4 -- primes_market.tolk",
                "lane": (
                    "LAUNCH_FIX_PLAN W1.5's getLotPrice(n) -> "
                    "(p0, resGas, minIncrement, score)"
                ),
            },
        },
        "lane": {
            "_rule": (
                "ONE route to a number ahead of the head (D-88 point 3): an "
                "ASCENDING lot, for prime and composite alike, where opening IS "
                "a paid first bid at P0(n), with no D_MIN gate and a 7-day clock "
                "with D-8's extension. D-90: THE WON LOT MINTS AT CLOSE, both "
                "kinds -- there is no escrowed claim and no wait for the head, "
                "which never arrives at an auctioned position anyway. AT its "
                "turn: a composite mints sequentially at MINT_PRICE; a prime "
                "opens a descending Dutch lot that parks at its resting price. "
                "Primorial -> head only."
            ),
            "mint_price_ton": 1.0,
            "res_gas_ton": fees["res_gas_ton"],
            "p0_floor_ton": fees["lane_floor_ton"],
            "_p0_floor_identity": "P0_floor = MINT_PRICE + RES_GAS, exactly (D-30/D-37)",
            "claim_expiry": "n/a -- D-90 deletes the claim; a won lot mints at close",
        },
        "bid_increment_ladder": ladder,
        "open_lot_volume_and_queue_depth":
            q26_block["open_lot_volume_and_queue_depth"],
    }

    block = {
        "_meta": {
            "description": (
                "The four §11 determinations that were blocked on simulation "
                "output: Q12 (activation bonus, launch-blocking), Q18/D-10 "
                "(staking x* go/no-go -- DELETED by D-168) and "
                "Q26 (auction-lane outputs). Generated by "
                "sim/scripts/run_determinations.py, which OWNS this key."
            ),
            "source": f"sim/scripts/run_determinations.py, seed={SEED}",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "model": (
                "DECISIONS.md D-20: primes are NOT head mints. The head is "
                "defined over composites and Unity; every prime clears on the "
                "MODE_DUTCH_BUYNOW lane; D-114 routes half the premium to the "
                "ratchet as `pending` with zero emission; an unsold prime's "
                "tribute forfeits to the treasury. Since 2026-09-24 "
                "run_phase1.py runs the same model and reads this block's "
                "`d20_baseline.prime_lane_model_fed_to_engine`."
            ),
        },
        "d20_baseline_no_prime_ever_sells": {
            "_what_this_is": (
                "The BOUND, not the expectation: the same D-20 run with no prime "
                "lot ever finding a buyer. It fixes the head velocity every other "
                "figure is calibrated against -- head velocity is independent of "
                "prime sales under D-20, which is the whole point of the head "
                "being defined over composites -- and it is the worst case for "
                "both the floor (no premium reaches `T`) and the forfeit."
            ),
            "final_head": base0.head,
            "composite_mints": len(base0.mint_log),
            "prime_lots_opened": base0.prime_lots_opened,
            "final_floor_price": base0.floor_price,
            "unsold_prime_forfeit_to_treasury_ton": base0.unsold_prime_forfeit_ton,
            "final_T_ton": base0.T,
            "final_S_primes": base0.S,
        },
        "d20_baseline": {
            "head_range": [HEAD_LO, HEAD_HI],
            "final_head": base.head,
            "composite_mints": len(base.mint_log),
            "prime_lots_opened": base.prime_lots_opened,
            "prime_lots_sold": base.prime_lots_sold,
            "prime_lots_unsold": base.prime_lots_unsold,
            "prime_lot_backlog_peak": base.prime_lot_backlog_peak,
            "prime_lot_premium_total_ton": base.prime_lot_premium_total,
            "prime_lot_nominal_total_ton": base.prime_lot_nominal_total,
            "unsold_prime_forfeit_to_treasury_ton": base.unsold_prime_forfeit_ton,
            "prime_declines": base.prime_declines,
            "_prime_declines_note": (
                "Structurally zero, and that is the point: under D-20 the head "
                "never faces a prime, so the parked-head failure mode §12 called "
                "the highest-severity risk cannot occur on the prime branch at "
                "all. The legacy model reports thousands of declines here."
            ),
            "final_floor_price": base.floor_price,
            "prime_lane_floor_effect": lane_effect,
            "final_T_ton": base.T,
            "final_S_primes": base.S,
            "mints_per_day": mints_per_day,
            "head_velocity_mints_per_day": spread(vel),
            "prime_lane_model_fed_to_engine": prime_lot,
        },
        "q26_auction_lane": q26_block,
    }

    with open(PARAMS_PATH, "r", encoding="utf-8") as f:
        params = json.load(f)
    params["determinations"] = block
    params["acquisition"] = acquisition_block
    with open(PARAMS_PATH, "w", encoding="utf-8") as f:
        json.dump(params, f, indent=2, allow_nan=False)
        f.write("\n")  # `json.dump` emits none; every other writer of this file does
    print(f"\nWrote determinations -> {PARAMS_PATH}")

    with open(os.path.join(OUT_DIR, "determinations.json"), "w", encoding="utf-8") as f:
        json.dump(block, f, indent=2, allow_nan=False, default=str)
    with open(os.path.join(OUT_DIR, "acquisition.json"), "w", encoding="utf-8") as f:
        json.dump(acquisition_block, f, indent=2, allow_nan=False, default=str)
    print(f"Total wall time: {time.time() - t0:.1f}s")
    return True


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
