"""Phase A orchestrator -- the Phase 1 simulation re-run against CONCEPT.md
design draft v5 (UPGRADE_PLAN_V5.md SS3).

Runs, in order:

  1. the analytic tribute-structure sweep (SS3.2 band tables, the `f` dial, the
     ceiling table, the equal-multiplicative-age table, the auction-side loss);
  2. the baseline pass of the agent simulation under DECISIONS.md D-20 (primes
     skip the head and clear on the Dutch lane);
  3. (RETIRED 2026-09-24 -- was the prime-head dwell sweep. Under D-20 the head
     never stops at a prime, so there is no dwell to sweep.)
  4. the PRIME_UPLIFT / PRIME_WINDOW calibration against SS5.1's headroom table;
  5. (RETIRED by D-106 -- was patronage: two activation processes, the SS4.6.2
     inequality and SS11.12's three options. Patron mode is deleted; the recruit
     ladder that replaced it pays in `k_max` uplift only, so it has no breakeven
     to price and is bounded by section 6's K_CEIL clamp instead.)
  6. uplift stacking under K_CEIL -- base case and a pessimistic
     rank-and-credit distribution, floor trajectories side by side;
  7. the floor guard: sandwich profitability re-measured *with* the guard, and
     how large `pending` grows in a market that stays above the floor;
  8. the owed-dictionary state-size resolution;
  9. the kill criteria;
 10. charts;
 10b. the genesis emission curve (DECISIONS.md D-100 point 2, D-154) -- the
     first 100 mints after the 132.5 GRAM genesis donation, written to
     /docs/audit/genesis-emission-curve.md as a dated measurement record;
 11. /shared/params.json at schema_version 2.0.0 -- which since D-100 also
     carries the top-level `treasury` block (the LP-custody vote ladder and
     the governance figures the owner set) and, since D-168, the top-level
     `staking` block (the distribution rate the sim selects, the stake ladder,
     and the LP-depth-without-miner risk report).

Usage (from /sim):
    python scripts/run_phase1.py

Deterministic: every run is seeded and re-running reproduces the same numbers.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from primes_sim import acquisition as acq
from primes_sim import analysis as an
from primes_sim import charts
from primes_sim import desirability
from primes_sim import economics as econ
from primes_sim import gas as gasmod
from primes_sim import kill_criteria as kc
from primes_sim import primehead as ph
from primes_sim import storage as st
from primes_sim import tribute as tr
from primes_sim import trophy_auction as trophy
from primes_sim.arrivals import ArrivalParams
from primes_sim.engine import Engine, PrimeHeadParams, SimParams, StakingParams


def _env_float(name: str) -> float | None:
    """GAUNTLET.md X14 -- an override that is absent unless it is set, never 0.0."""
    raw = os.environ.get(name, "").strip()
    return float(raw) if raw else None

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "output")
PARAMS_PATH = os.path.join(REPO_ROOT, "shared", "params.json")
# CONCEPT SS4.1: the only place in this repo that measures real TVM gas.
GAS_BASELINE_PATH = os.path.join(REPO_ROOT, "contracts", "gas-baseline.json")

SEED = 20260814
SCHEMA_VERSION = "2.0.0"

# Top-level keys of shared/params.json that this script does NOT own.
#
# params.json has more than one generator. This one rebuilds the whole document
# from scratch on every run (build_params_json), so without an explicit merge it
# silently deletes whatever another generator wrote -- which is exactly what once
# happened to the (since deleted) `constellations` block.
#
# The rule for the next generator: a script that owns key X must be the ONLY
# writer of X, must preserve every key it does not own, and every other whole-file
# writer must list X here. Values under these keys are copied through untouched --
# never regenerated, never hand-edited.
#
#   determinations, acquisition -> sim/scripts/run_determinations.py
#
# `constellations` and `generators` were run_constellations.py's until
# TELEGRAM_INVITES_PLAN.md (owner, 2026-11-07) deleted both features and that
# script; a regen therefore drops both keys from the file.
#
# `invites` (SS4.1's seventh line) is NOT foreign: THIS script owns it. The block
# is beta arithmetic -- the SS4.1 table re-derived with
# `invite_count * (INVITE_TRANSFER_VALUE_TON + INVITE_SEND_FEE_TON)` deducted ahead of the residual -- and
# beta is this script's output everywhere else in the file (`mint`, `rebate`,
# `genesis.quest_rewards` all quote it).
#
# NOTE on `determinations`: since 2026-09-24 both scripts run DECISIONS.md D-20
# (primes are NOT head mints). This script READS the prime-lane outcome from that
# block (`_prime_lane_from_determinations`) and never regenerates it.
FOREIGN_PARAM_KEYS = ("determinations", "acquisition")

K = (2, 3, 5, 7, 11, 13)


def _prime_lane_from_determinations() -> dict:
    """D-20's prime Dutch lane outcome, as `run_determinations.py` MEASURED it.

    That script owns the lane model (`market.evaluate_lane`) and publishes the
    pair it fed its own engine at `determinations.d20_baseline.
    prime_lane_model_fed_to_engine`; this baseline consumes the same pair rather
    than re-deriving it. Run run_determinations.py first on a fresh checkout.
    """
    with open(PARAMS_PATH, encoding="utf-8") as fh:
        lane = json.load(fh)["determinations"]["d20_baseline"]["prime_lane_model_fed_to_engine"]
    return {k: float(lane[k]) for k in ("prime_lot_sale_probability", "prime_lot_mean_premium_ton",
                                        "prime_lot_mean_days_to_sale")}


BASELINE_KWARGS = dict(
    seed=SEED,
    k_min=0.2,
    k_max_cap=0.9,
    ramp_seconds=3600.0,
    n0_anchor=1000,
    flush_pct=0.20,
    flush_cooldown_seconds=86400.0,
    flush_min_ton=5.0,
    floor_guard=0.0,
    floor_guard_enabled=True,
    reference_primes=K,
    # DECISIONS.md D-20: primes are NOT head mints. The head walks composites; a
    # prime opens a Dutch lot as the head passes it, and the lot's sale rate and
    # premium are the lane outcome run_determinations.py measured. Until
    # 2026-09-24 this baseline ran the legacy model (the head minted primes at
    # 1 GRAM and could park on one), and every block below was generated under it.
    primes_skip_head=True,
    **_prime_lane_from_determinations(),
    genesis_lp_primes_per_ton=10_000.0,   # DENOMINATION_PLAN P1 (L = 10,000; owner 2026-08-19)
    # D-43 (owner 2026-08-20): the bounty vault is 10,000,000 PRIMES -- 500% of the
    # seeded LP, up from D-42's 100%, to fund the puzzle campaign (CONCEPT.md SS9.6):
    # 3 riddles at genesis plus one per week for 3 years (159 riddles), each worth
    # 1 GRAM at claim time. The vault is minted, not bought, so its GRAM worth is
    # `T0 * pct / (1 + pct)`: raising the fraction raises the growth budget
    # (100 -> 166.67 GRAM) but the price is paid entirely in the opening floor,
    # 20,000 -> 60,000 PRIMES per GRAM -- every SS6 number keyed to 20,000 moves with
    # this line. Every further doubling still buys less than the last (D-42 1a's
    # point stands): 500% -> 1000% would move the vault's worth from 166.67 GRAM to
    # only 181.8 GRAM. Past here the lever is the founder seed, not the vault
    # fraction, same as D-42 concluded at 100%.
    # D-204 (owner, 2026-11-11): 5.00 -> 7.80, a 15,600,000 PRIMES vault. The extra
    # 5,600,000 is what the donation's 132.50 -> 200 GRAM raise backs at the floor the
    # game already opened at (1.0761e-5 -> 1.0769e-5), and ALL of it goes to the
    # `prime_quests` track (era_bounty_report); no other track moves.
    bounty_vault_pct_of_lp=7.80,
    genesis_seed_ton=200.0,  # SS6 point 3, owner decision 2026-08-15
    # GAUNTLET.md X14. Unset in every committed run, so `shared/params.json` is
    # regenerated from the same inputs it always was. Setting both seeds the MODELLED
    # POOL at the real D-140 pair (292000 PRIMES / 0.1022 GRAM) while leaving S0 alone,
    # which is the measurement the item asks for:
    #   PRIMES_SIM_POOL_PRIMES=292000 PRIMES_SIM_POOL_TON=0.1022 python scripts/run_phase1.py
    modelled_pool_ton=_env_float("PRIMES_SIM_POOL_TON"),
    modelled_pool_primes=_env_float("PRIMES_SIM_POOL_PRIMES"),
    # D-154 (owner, 2026-09-21), amending D-100 point 2: the operator funds
    # 132.5 GRAM at genesis -- D-100 point 3's whole 150 GRAM commitment,
    # front-loaded, rather than 4.20 now and up to 150 incrementally later. This
    # is `T0`; `genesis_seed_ton` above keeps only its other job, sizing
    # S0 = seed * L * (1/2 + vault_pct) = 11,000,000 PRIMES (D-166: the vault's
    # 10,000,000 plus the treasury lock's 1,000,000; the operator lock is deleted)
    # and the modelled depth of the pair. The deploy floor is
    # `132.5 / (11,000,000 + 1,312,854) = 1.0761e-5` -- the second term is the
    # donor's own `donate_floor` mint (D-100 point 1), which S0 does not include.
    #
    # WHY THIS FIGURE AND NOT ANOTHER: D-140 pins the DeDust pair at the floor,
    # so the GRAM side is not a free choice -- it is `pairing_primes * p_f`, and
    # both factors rise with this field. Opening depth is therefore QUADRATIC in
    # it: `m * X / (S0 + m)` GRAM, `m` the donation's own tapered mint (D-166 took
    # the operator's 250,000-PRIMES vest tranche out of the pair), 14.13 at X = 132.5.
    # D-154 sized X so that donated + paired = 150.0 with the tranche in; without
    # it the total posted is 146.63, and the figure is left where the owner set it.
    #
    # D-204 (owner, 2026-11-11) takes it to 200 GRAM, the same figure as the nominal
    # seed again, and grows the vault with it (above) so the floor does not move.
    # The pair is then ~21.2 GRAM on top of the donation.
    genesis_donation_ton=200.0,
    horizon_days=3 * 365.0,
    n_max=2_000_000,
    history_every_n_mints=500,
    # SS4.1's seventh line (D-101), switched ON for the horizon. Until this line
    # existed here, `SimParams` had no invite field at all and every one of the
    # ~431k simulated mints split at the UNINVITED beta while
    # `invites.optin_rate_assumed` published 0.80 -- so `final_state`, the floor
    # appreciation, the kill criteria and the genesis blocks were all measured
    # with the line off. `invites._horizon_not_simulated` used to disclose that
    # gap; this closes it (CONSTELLATIONS_PLAN.md phase 1 item 1).
    #
    # THE RATE IS ASSUMED, NOT MEASURED, and every block that quotes a figure
    # derived from it carries `econ.INVITE_OPTIN_RATE_LABEL` as its `_source`.
    # It is a scenario input; re-run at the realised share once invited mints
    # exist.
    invite_optin_rate=econ.INVITE_OPTIN_RATE_ASSUMED,
)


EMISSION_CURVE_PATH = os.path.join(
    REPO_ROOT, "docs", "audit", "genesis-emission-curve.md"
)
EMISSION_CURVE_MINTS = 100


def emission_curve(e, n_mints: int = EMISSION_CURVE_MINTS) -> dict:
    """DECISIONS.md D-100 point 2: publish the first-100-mints emission curve
    BEFORE deploy.

    **Why this needs publishing at all.** The rebate a mint emits is
    `R = k * I * S / T` PRIMES (CONCEPT.md SS5) -- `S/T` is `1/p_f`, so the
    SMALLER the floor, the MORE PRIMES one GRAM of injection buys. That is what
    made this curve worth publishing when the donation was 4.20 GRAM: `p_f0` at
    3.5e-7 is 48x below D-92's 240 GRAM genesis, so each of the first mints
    emitted 48x the PRIMES it would have. D-154's 132.5 GRAM donation puts `p_f0`
    at 1.104e-5 and takes ~32x of that back -- the front-loading buys opening
    depth AND cuts the front-loaded emission, which is the trade the decision
    names. The ratchet theorem is untouched either way -- `k < 1` still makes
    every mint raise `T/S` -- but "the floor rises" and "supply is stable" are
    different claims, and this file is the second one, measured rather than
    asserted.

    **How the curve is built.** Not re-implemented: it replays the base-case run's
    OWN realised `(kind, beta, k)` stream, mint by mint, in order. `beta` (the
    residual injected into the ratchet) and `k` (the rebate coefficient, `0` on
    every prime mint by SS5.1) are both independent of the floor, so replaying
    them against a different genesis state is exact arithmetic, not a re-model.

    What the replay CHANGES is the state it starts from: `T0 = 200` (D-204's
    donation, the only thing in `seedT` after D-100 point 1) and
    `S0 = 16,600,000` (the 15,600,000-PRIMES bounty vault plus the 1,000,000 the
    treasury's lock vests; D-166 deleted the operator's). The run is on the D-20
    model, so `mint_log` holds composite head mints only: a prime lot's GRAM (its
    1 GRAM split and the ratchet's half of the premium) raises `T` with zero
    emission and is left out of the replay. That understates the floor and so
    OVERSTATES emission -- the conservative direction for this file.

    Returned: the per-mint rows, plus the decay summary D-100 point 2's claim is
    checked against.
    """
    T0 = e.p.genesis_donation_ton
    # The deploy supply: the seed PLUS the donor's `donate_floor` mint, which is
    # what `T0 / S0` has to be to equal the on-chain opening floor.
    S0 = e.deploy_supply_primes
    T, S = T0, S0
    rows = []
    for ev in e.mint_log[:n_mints]:
        floor_before = T / S if S > 0 else 0.0
        rebate = econ.rebate_primes(ev.beta, ev.k, floor_before) if floor_before > 0 else 0.0
        T += ev.beta
        S += rebate
        rows.append({
            "mint_index": len(rows) + 1,
            "n": ev.n,
            "kind": ev.kind,
            "k": ev.k,
            "beta_ton": ev.beta,
            "rebate_primes": rebate,
            "emission_pct_of_S0": rebate / S0 * 100.0,
            "emission_pct_of_S_before": (rebate / (S - rebate) * 100.0) if S > rebate else 0.0,
            "T_ton": T,
            "S_primes": S,
            "p_f_ton_per_primes": T / S if S > 0 else 0.0,
            "p_f_over_p_f0": (T / S) / (T0 / S0) if S > 0 and S0 > 0 else 0.0,
        })

    def _pct_at(i: int) -> float | None:
        return rows[i - 1]["emission_pct_of_S0"] if len(rows) >= i else None

    first = _pct_at(1)
    at10 = _pct_at(10)
    return {
        "genesis_donation_ton": T0,
        "genesis_supply_primes": S0,
        "p_f0_ton_per_primes": T0 / S0 if S0 > 0 else 0.0,
        "rows": rows,
        "first_mint_emission_pct_of_S0": first,
        "mint_10_emission_pct_of_S0": at10,
        "mint_100_emission_pct_of_S0": _pct_at(len(rows)) if rows else None,
        "cumulative_emission_pct_of_S0": (
            (rows[-1]["S_primes"] - S0) / S0 * 100.0 if rows else 0.0
        ),
        "S_multiple_after_curve": (rows[-1]["S_primes"] / S0) if rows else 1.0,
        "T_multiple_after_curve": (rows[-1]["T_ton"] / T0) if rows and T0 else None,
        "p_f_multiple_after_curve": (rows[-1]["p_f_over_p_f0"]) if rows else 1.0,
        "floor_monotone": all(
            rows[i]["p_f_ton_per_primes"] >= rows[i - 1]["p_f_ton_per_primes"]
            for i in range(1, len(rows))
        ),
        # D-100 point 2's claim, checked rather than repeated. A per-mint ratio
        # at exactly mint 10 is the WRONG instrument: mint 10 may be a prime, and
        # a prime emits nothing at all (SS5.1), so the ratio would read 0.00 and
        # flatter the claim for a reason that has nothing to do with the decay.
        # Two robust measures instead:
        #   * how much of the whole curve's emission happened in the first ten
        #     mints -- if the thing is self-correcting by mint 10, this is most
        #     of it;
        #   * the LARGEST single emission after mint 10, which is what "corrected"
        #     has to mean if it means anything.
        "first_10_share_of_cumulative_emission": (
            (rows[9]["S_primes"] - S0) / (rows[-1]["S_primes"] - S0)
            if len(rows) > 10 and rows[-1]["S_primes"] > S0 else None
        ),
        "max_emission_pct_of_S0_after_mint_10": (
            max(r["emission_pct_of_S0"] for r in rows[10:]) if len(rows) > 10 else None
        ),
        "max_emission_pct_of_S0": max((r["emission_pct_of_S0"] for r in rows), default=None),
    }


def write_emission_curve_doc(curve: dict, e) -> str:
    """Render `emission_curve()` as `docs/audit/genesis-emission-curve.md`.

    A dated MEASUREMENT RECORD in the shape the rest of `docs/audit/` uses --
    what was measured, against what code, on what date, and what it means. It is
    not a work list and nothing in it is a to-do (CLAUDE.md: do not treat a
    historical record as a backlog).
    """
    rows = curve["rows"]
    first = curve["first_mint_emission_pct_of_S0"]
    at100 = curve["mint_100_emission_pct_of_S0"]
    peak = curve["max_emission_pct_of_S0"]
    peak_after10 = curve["max_emission_pct_of_S0_after_mint_10"]
    share10 = curve["first_10_share_of_cumulative_emission"]
    s_mult = curve["S_multiple_after_curve"]
    pf_mult = curve["p_f_multiple_after_curve"]
    # D-100 point 2 predicts "on the order of 15% of S0" for the first mints and
    # "self-correcting within ~10 mints". Both are CHECKED here; every verdict
    # below is computed, not typed, so a re-run that moves the numbers moves the
    # verdicts with them instead of leaving stale prose behind.
    order_15 = "**yes**" if (peak is not None and 5.0 <= peak <= 30.0) else "**NO**"
    if share10 is not None and peak_after10 is not None and share10 >= 0.5 and peak_after10 <= 0.2 * peak:
        corrected = "**yes**"
    elif share10 is not None and share10 >= 0.5:
        corrected = "**partly**"
    else:
        corrected = "**NO**"

    lines = [
        "# Genesis emission curve \u2014 the first 100 mints after a %.2f GRAM donation" % curve["genesis_donation_ton"],
        "",
        "**Measured** " + time.strftime("%Y-%m-%d", time.gmtime()) + " \u00b7 "
        "**generator** `sim/scripts/run_phase1.py` (seed " + str(SEED) + ") \u00b7 "
        "**decision** `DECISIONS.md` D-100 point 2, D-154, D-204 \u00b7 "
        "**spec** `CONCEPT.md` \u00a75, \u00a76 point 3",
        "",
        "This is a **measurement record**, not a work list. Nothing in it is a to-do.",
        "",
        "## Why this file exists",
        "",
        "D-100 point 2 replaced D-92's 240 GRAM genesis donation with 4.20 GRAM, and",
        "D-154 and then D-204 raised it to **%.2f GRAM**. The derivation method is unchanged through" % curve["genesis_donation_ton"],
        "both; only its input moves. The consequence the decision commits to",
        "publishing *before deploy* is this one:",
        "",
        "> a mint's rebate is `R = k \u00b7 I \u00b7 S / T` PRIMES (\u00a75), and `S / T` is `1 / p_f`.",
        "> A smaller genesis floor makes every GRAM of injection buy proportionally",
        "> more PRIMES, so the donation also sizes the front-loaded emission below.",
        "",
        "The **ratchet theorem is untouched** \u2014 `k < 1` still makes `p_f = T/S` strictly",
        "increasing on every mint, and this run confirms it over the whole curve. But",
        "*the floor rises* and *supply is stable* are different claims. This file measures",
        "the second one.",
        "",
        "## Genesis state the curve starts from",
        "",
        "| quantity | value | where it comes from |",
        "|---|---|---|",
        "| `T\u2080` (`seedT`) | **%.2f GRAM** | D-100 point 2, owner-set. After D-100 point 1 a donation is the *only* thing that lands in `seedT`. |" % curve["genesis_donation_ton"],
        "| `S\u2080` | **{:,.0f} PRIMES** | 15,600,000 bounty vault (D-204) + 1,000,000 vested to the treasury (D-100 point 6; D-166 deleted the operator's 1 M) + the donor's `donate_floor` mint, `T₀ · L` tapered by D-156 (D-100 point 1). |".format(curve["genesis_supply_primes"]),
        "| `p_f0` | **%.6e GRAM/PRIMES** | `T\u2080 / S\u2080`. D-92's figure was 1.667e-5 \u2014 this is %.2f\u00d7 lower. |" % (curve["p_f0_ton_per_primes"], 1.6666666666666667e-05 / curve["p_f0_ton_per_primes"]),
        "| `L` | 10,000 PRIMES/GRAM | D-39, untouched: a denomination knob, not a price. |",
        "",
        "## Method",
        "",
        "The curve is **not a second model**. It replays the base-case Phase 1 run's own",
        "realised `(kind, \u03b2, k)` stream, mint by mint, in order. `\u03b2` (the residual",
        "injected into the ratchet) and `k` (the rebate coefficient \u2014 `0` on every prime",
        "mint, \u00a75.1) are both independent of the floor, so replaying them from a different",
        "genesis state is exact arithmetic rather than a re-simulation.",
        "",
        "The run is on the **D-20** model: primes are not head mints, so the table lists",
        "composites only and opens at **n = 4**. A prime's Dutch lot raises `T` with zero",
        "emission (§5.1, D-7); the replay leaves that GRAM out, which understates the floor",
        "and so overstates emission — the conservative direction for this file.",
        "",
        "## What the curve shows",
        "",
        "| claim in D-100 point 2 | measured | verdict |",
        "|---|---|---|",
        "| the first mints emit \"on the order of 15%% of `S\u2080`\" | the largest single mint emits **%.2f%%** of `S\u2080` (mint 1: %.2f%%) | %s |" % (peak, first, order_15),
        "| \"self-correcting within ~10 mints\" | the first 10 mints account for **%.1f%%** of all emission over the curve, and no mint after the tenth emits more than **%.3f%%** of `S\u2080` | %s |" % (share10 * 100.0, peak_after10, corrected),
        "| the ratchet still holds | `p_f` monotone over all %d mints | %s |" % (len(rows), "**yes**" if curve["floor_monotone"] else "**NO**"),
        "",
        "A per-mint ratio *at exactly mint 10* would have been the wrong instrument and is",
        "deliberately not used: mint 10 may be a prime, and a prime emits nothing at all",
        "(\u00a75.1), so that ratio can read `0.00` for a reason with nothing to do with decay.",
        "",
        "## The honest reading",
        "",
        "The per-mint emission does fall fast. It is a `k\u00b7\u03b2 / T` term and `T` grows by `\u03b2`",
        "every mint from a base of only %.2f GRAM, so the denominator runs away from the" % curve["genesis_donation_ton"],
        "numerator almost immediately. Over the first 100 mints:",
        "",
        "- `T` grows **{:.1f}\u00d7**, to {:,.2f} GRAM;".format(
            curve["T_multiple_after_curve"], rows[-1]["T_ton"]),
        "- `S` grows **{:.2f}\u00d7**, to {:,.0f} PRIMES \u2014 a cumulative emission of **{:,.1f}".format(
            s_mult, rows[-1]["S_primes"], curve["cumulative_emission_pct_of_S0"])
        + "% of `S\u2080`**;",
        "- `p_f` rises **%.2f\u00d7**, to %.6e GRAM/PRIMES;" % (pf_mult, rows[-1]["p_f_ton_per_primes"]),
        "- mint 100 emits %.4f%% of `S\u2080`." % at100,
        "",
        "What that costs, and what it does not. It is **not a solvency problem**: nothing",
        "here can make `p_f` fall, `S` is never decremented (\u00a73.3), and every emitted",
        "PRIMES is backed by the same `T` that received the injection \u2014 the floor ends the",
        "curve **%.2f\u00d7** higher than it started. It is a **dilution schedule**, and it is" % pf_mult,
        "front-loaded by construction: whoever mints first buys PRIMES at a floor",
        "%.2f\u00d7 cheaper than D-92's would have been. D-100 point 2 calls this" % (1.6666666666666667e-05 / curve["p_f0_ton_per_primes"]),
        "\"D-91's own",
        "complaint reproduced by choice\" and accepts it in writing; this file is the",
        "measurement that makes the choice legible rather than a footnote.",
        "",
        "The number to carry away is the cumulative one: the first %d mints multiply" % len(rows),
        "`S\u2080` by **%.2f**, and the floor still ends up **%.2f\u00d7** where it began." % (s_mult, pf_mult),
        "",
        "## The first 100 mints",
        "",
        "`k = 0` rows are prime mints (\u00a75.1: primes emit nothing and ratchet ~11\u00d7 harder).",
        "",
        "| # | n | kind | k | \u03b2 (GRAM) | rebate (PRIMES) | % of `S\u2080` | T (GRAM) | S (PRIMES) | `p_f` | `p_f/p_f0` |",
        "|--:|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|",
    ]
    for r in rows:
        lines.append(
            f"| {r['mint_index']} | {r['n']:,} | {r['kind']} | {r['k']:.4f} | "
            f"{r['beta_ton']:.4f} | {r['rebate_primes']:,.0f} | "
            f"{r['emission_pct_of_S0']:.3f}% | {r['T_ton']:.3f} | "
            f"{r['S_primes']:,.0f} | {r['p_f_ton_per_primes']:.3e} | "
            f"{r['p_f_over_p_f0']:.4f} |"
        )
    lines += [
        "",
        "## Regenerating this file",
        "",
        "`cd sim && python scripts/run_phase1.py`. It is written by the same pass that",
        "writes `shared/params.json`, from the same run, so the two can never disagree.",
        "",
    ]
    text = "\n".join(lines) + "\n"
    os.makedirs(os.path.dirname(EMISSION_CURVE_PATH), exist_ok=True)
    with open(EMISSION_CURVE_PATH, "w", encoding="utf-8") as fh:
        fh.write(text)
    return EMISSION_CURVE_PATH


# --------------------------------------------------------------------------- #
# DECISIONS.md D-151 / STAKING_PLAN.md P1 -- the ratchet's staked reserve.
#
# The sim writes the MODEL and the SELECTION RULE; the run writes the numbers
# (CLAUDE.md rule 3). Nothing below picks a value by hand except the two the
# owner already signed -- `exit_slippage_bps` and the 30-day harvest interval --
# and those carry their own `_source` saying so.
# --------------------------------------------------------------------------- #

#: D-151 point 2's sweep range. Not widened here: if no N in it works, the run
#: says so and emits the best one with a note.
RESERVE_DAYS_SWEEP = tuple(range(1, 15))
STAKE_MIN_SWEEP = (10.0, 100.0, 1_000.0, 10_000.0, 50_000.0, 200_000.0)
#: ASSUMPTION, never selected. Flagged in params.json the way `invites`' opt-in
#: rate is, and the headline is the middle one.
APR_SWEEP = (0.02, 0.04, 0.06)
HEADLINE_APR = 0.04
#: (`RATCHET_HOP_GAS_TON` and `ROUND_TRIP_COST_TON` are DELETED by D-146. They fed
#: constraint (b) -- round trips must not outpace the ratchet's own gas accrual --
#: and since D-146 the pool's flat fees are paid by the CALLER of `stake`/`unstake`,
#: not out of that accrual, so there is nothing for the accrual to fund.)
#: Constraint (a): flat fees may be at most this share of the yield they buy.
FEE_SHARE_OF_YIELD_MAX = 0.10
#: A row extrapolates only if it staked at least this often. The 1/x reading
#: assumes the stake count is the staked flow over the minimum; a row that stakes
#: once or twice, late, measures WHEN it staked, not the minimum. The D-180 run's
#: 200,000 GRAM row staked once and extrapolated to 2,548 GRAM against 206-219 from
#: every row with 21+ stakes -- a 10x false minimum.
MIN_STAKES_TO_EXTRAPOLATE = 10
#: Constraint 1: unmet flush demand must be zero in the base run and under this
#: share of total demand in the stress run.
UNMET_SHARE_MAX_STRESS = 0.01


def _round_up_nice(x: float) -> float:
    """Up to the next 1/2/5 x 10^k. "Round UP to a round number", written down."""
    if x <= 0:
        return 0.0
    k = math.floor(math.log10(x))
    for m in (1.0, 2.0, 5.0, 10.0):
        v = m * 10.0 ** k
        if v >= x - 1e-12:
            return v
    return 10.0 ** (k + 1)


def _staking_row(e: Engine) -> dict:
    """Everything one staking run measured, in one flat row."""
    stk = e.p.staking
    yield_headline = e.staked_ton_seconds * stk.apr / (365.0 * 86400.0)
    return {
        "reserve_days": stk.reserve_days,
        "stake_min_ton": stk.stake_min_ton,
        "leg2_fill_prob": stk.leg2_fill_prob,
        "final_pending_ton": e.pending,
        "final_liquid_ton": e.liquid,
        "final_staked_cost_ton": e.staked_cost,
        "final_exiting_ton": e.exiting,
        "staked_share_of_pending": (e.staked_cost / e.pending) if e.pending else None,
        "reserve_target_ton": e.reserve_target,
        "largest_tranche_asked_for_ton": e.flush_demand_max_ton,
        "reserve_cover_of_largest_tranche": (
            e.reserve_target / e.flush_demand_max_ton if e.flush_demand_max_ton > 0 else None
        ),
        "flush_demand_ton": e.flush_demand_ton,
        "unmet_flush_ton": e.unmet_flush_ton,
        "unmet_share_of_demand": (
            e.unmet_flush_ton / e.flush_demand_ton if e.flush_demand_ton > 0 else 0.0
        ),
        "unmet_flush_events": e.unmet_flush_events,
        "stake_events": e.stake_events,
        "exit_events": e.exit_events,
        "exit_legs": dict(e.exit_leg_counts),
        "staking_fees_paid_ton": e.staking_fees_paid,
        "realized_slippage_ton": e.realized_slippage_ton,
        "accrued_yield_ton_at_headline_apr": yield_headline,
        "harvested_tston": e.harvested_tston,
        "fee_share_of_yield": (
            e.staking_fees_paid / yield_headline if yield_headline > 0 else None
        ),
        "round_trips": e.stake_events,
        "total_mints": len(e.mint_log),
        "staked_ton_seconds": e.staked_ton_seconds,
    }


def staking_report(stress_kwargs: dict, gas_baseline: dict) -> dict:
    """Size `staked_fraction` and `stake_min_ton`, and publish the sweeps.

    `reserve_days` is the SWEPT variable and keeps that name inside the sweep
    tables; the published constant is the fraction it reduces to. See the
    `_fraction_definitions` note in the returned block.

    Two runs per reserve-day: the base three-year run and the
    `pending_growth_above_floor_market` stress run, both with **leg 2 switched
    off**. That is the conservative reading and the only one that can
    discriminate: with leg 2 available every exit is instant, so nothing can be
    unmet at any `N` and the sweep would be a flat line of zeros. With leg 2 off
    a leg-1 miss becomes the ~36 h bill, which is exactly the shortfall the
    reserve exists to prevent.
    """
    # Derived before the sweep so every modelled run harvests on the same rule
    # the contract will: `harvest()` is skipped below 20 jetton transfers of gas
    # (D-151 point 4). At the modelled stake sizes a month's accrual is three
    # orders of magnitude above it, so the guard never binds and no figure below
    # depends on it -- which is the point of deriving it rather than tuning it.
    transfer_gas = (gas_baseline["jetton_wallet.transfer"]
                    + gas_baseline["jetton_wallet.internal_transfer"])
    one_transfer_ton = gasmod.gas_to_ton(transfer_gas, transactions=2)
    harvest_dust = 20.0 * one_transfer_ton

    def _run(reserve_days, stake_min, *, leg2=0.0, apr=HEADLINE_APR, **kw) -> Engine:
        return run_pass(
            staking=StakingParams(
                enabled=True,
                reserve_days=float(reserve_days),
                stake_min_ton=float(stake_min),
                apr=apr,
                leg2_fill_prob=leg2,
                harvest_dust_tston=harvest_dust,
            ),
            **kw,
        )

    # ---- 1. reserve_days ------------------------------------------------ #
    probe_stake_min = 1_000.0
    base_rows, stress_rows = [], []
    for n in RESERVE_DAYS_SWEEP:
        base_rows.append(_staking_row(_run(n, probe_stake_min)))
        stress_rows.append(_staking_row(_run(n, probe_stake_min, **stress_kwargs)))
        b, s = base_rows[-1], stress_rows[-1]
        print(f"  reserve_days={n:>2}: staked {b['staked_share_of_pending']*100:5.1f}% of pending, "
              f"unmet base {b['unmet_flush_ton']:.1f} GRAM, stress "
              f"{s['unmet_share_of_demand']*100:.2f}% of demand, "
              f"exits {b['exit_events']}")

    chosen_n, n_satisfied = None, []
    for b, s in zip(base_rows, stress_rows):
        ok = b["unmet_flush_ton"] == 0.0 and s["unmet_share_of_demand"] <= UNMET_SHARE_MAX_STRESS
        n_satisfied.append(ok)
        if ok and chosen_n is None:
            chosen_n = b["reserve_days"]
    range_note = None
    if chosen_n is None:
        # Not widened silently: the best row in range, said out loud.
        best = min(range(len(base_rows)), key=lambda i: (base_rows[i]["unmet_flush_ton"],
                                                         stress_rows[i]["unmet_share_of_demand"]))
        chosen_n = base_rows[best]["reserve_days"]
        range_note = (
            f"NO N in {RESERVE_DAYS_SWEEP[0]}..{RESERVE_DAYS_SWEEP[-1]} meets the rule. "
            f"Emitting the best row in range (N={chosen_n:g}) with unmet "
            f"{base_rows[best]['unmet_flush_ton']:.3f} GRAM in the base run and "
            f"{stress_rows[best]['unmet_share_of_demand']*100:.3f}% of demand in the "
            "stress run. The range was NOT widened -- widening it is an owner call."
        )
        print("  " + range_note)

    # ---- 2. stake_min_ton ----------------------------------------------- #
    min_rows = []
    for m in STAKE_MIN_SWEEP:
        min_rows.append(_staking_row(_run(chosen_n, m)))
        r = min_rows[-1]
        print(f"  stake_min={m:>9,.0f} GRAM: {r['stake_events']:>5} stakes, fees "
              f"{r['staking_fees_paid_ton']:8.1f} GRAM = "
              f"{(r['fee_share_of_yield'] or 0)*100:6.2f}% of yield")

    # The constraint is 1/x in the minimum -- a stake fires once the excess
    # over the reserve has grown by `stake_min`, so the count is the staked FLOW
    # divided by it and the flat-fee bill scales the same way. Each swept row
    # therefore EXTRAPOLATES to the minimum that would just satisfy it, which is
    # a continuous answer instead of a grid step; the rows agree to a few per
    # cent and the largest is taken, which is the conservative reading. A row
    # that staked nothing extrapolates to nothing and is excluded -- "stake never"
    # satisfies every cost constraint and is not an answer to the question. A row
    # that staked too few times to be a flow is excluded for the same reason
    # (MIN_STAKES_TO_EXTRAPOLATE).
    live = [r for r in min_rows
            if r["stake_events"] >= MIN_STAKES_TO_EXTRAPOLATE and (r["fee_share_of_yield"] or 0) > 0]
    for r in min_rows:
        m = r["stake_min_ton"]
        r["implies_min_from_fee_share_ton"] = (
            m * r["fee_share_of_yield"] / FEE_SHARE_OF_YIELD_MAX if r in live else None
        )
    implied_fee = max((r["implies_min_from_fee_share_ton"] for r in live), default=None)
    if implied_fee is None:
        chosen_min = _round_up_nice(STAKE_MIN_SWEEP[-1])
        binds = "neither -- no swept value staked at all; largest swept value emitted"
    else:
        chosen_min = _round_up_nice(implied_fee)
        binds = "fee_share"
    print(f"  implied minimum: fee-share {implied_fee} "
          f"-> stake_min_ton = {chosen_min:,.0f} ({binds} binds)")

    # ---- 3. the chosen configuration, at D-151's own leg behaviour ------- #
    # `leg2_fill_prob = 1.0` is the letter of D-151 point 5 -- bounded slippage
    # tolerated -- so this run, not the conservative sweep, is what `final_state`
    # publishes and what `realized_slippage_ton` is measured on.
    chosen_run = _run(chosen_n, chosen_min, leg2=1.0)
    chosen = _staking_row(chosen_run)

    # ---- 4. APR: swept, never selected ----------------------------------- #
    # Exact rather than three more runs: the yield is a pure integral of the cost
    # basis, `accrued = staked_ton_seconds * apr / year`, and the APR feeds back
    # into nothing -- yield never enters `T`.
    tsy = chosen["staked_ton_seconds"] / (365.0 * 86400.0)
    apr_rows = [
        {
            "apr": apr,
            "accrued_yield_ton_over_horizon": tsy * apr,
            "yield_per_year_ton": tsy * apr / (chosen_run.p.horizon_days / 365.0),
            "fee_share_of_yield": (chosen["staking_fees_paid_ton"] / (tsy * apr)) if tsy * apr > 0 else None,
        }
        for apr in APR_SWEEP
    ]

    # THE PUBLISHED CONSTANT IS A FRACTION, NOT A DAY COUNT. `reserve_days` is
    # what was SWEPT and it stays in the sweep table under that name, but it is
    # not what the contract holds: `flush_pct` makes the daily ceiling a fixed
    # fifth of `pending`, so "N days of ceiling" reduces to the fixed fraction
    # `flush_pct * N` of `pending` held liquid -- self-referential as a duration
    # and exact as a fraction. Publishing the day count as the parameter would
    # name a constant after a unit it does not have, and would hide the reason
    # N >= 1/flush_pct stakes nothing at all.
    flush_pct = chosen_run.p.flush_pct
    reserve_fraction = flush_pct * chosen_n
    staked_fraction = max(1.0 - reserve_fraction, 0.0)
    days_ceiling = math.ceil(1.0 / flush_pct) - 1
    return {
        "staked_fraction": staked_fraction,
        "reserve_fraction_of_pending": reserve_fraction,
        "_fraction_definitions": (
            "`staked_fraction` is the share of the ratchet's whole obligation "
            "(`pending + stakedCost + exiting`) that ends up in tsTON; "
            "`reserve_fraction_of_pending` = 1 - it is the liquid share, and is the one "
            "`reserveTarget` multiplies on chain. Both are `flush_pct` (%.2f) times the swept "
            "`reserve_days` below: reserve = flush_pct * N, staked = 1 - flush_pct * N."
            % flush_pct
        ),
        "_equivalent_reserve_days": chosen_n,
        "_reserve_days_ceiling": days_ceiling,
        "_reserve_days_ceiling_note": (
            "A day count above %d is not a bigger reserve, it is NO STAKING: at "
            "flush_pct = %.2f the reserve reaches the whole obligation at N = %g, and every "
            "N at or above it stakes exactly zero. The 1..14 sweep therefore has only %d "
            "distinct outcomes, which is the strongest reason the constant is published as a "
            "fraction." % (days_ceiling, flush_pct, 1.0 / flush_pct, days_ceiling)
        ),
        "stake_min_ton": chosen_min,
        "harvest_interval_seconds": 2_592_000,
        "harvest_dust_tston": harvest_dust,
        "exit_slippage_bps": 50,
        "modelled_apr": HEADLINE_APR,
        "leg1_fill_prob": StakingParams().leg1_fill_prob,
        "leg3_latency_days": StakingParams().leg3_latency_days,
        "deposit_fee_ton": StakingParams().deposit_fee_ton,
        "exit_fee_ton": StakingParams().exit_fee_ton,
        "_source": (
            "The RATCHET's GRAM reserve staked as tsTON (CONCEPT.md SS4.3.2, DECISIONS.md "
            "D-151) -- UNRELATED to the top-level `staking` block, which is D-168's PRIMES "
            "staking paid from the treasury vest. Different "
            "asset (GRAM, not PRIMES), different actor (the ratchet contract, not a player), "
            "different section. "
            "sim/scripts/run_phase1.py staking_report, seed=%d, STAKING_PLAN.md P1. "
            "`staked_fraction` comes from the SMALLEST N in %d..%d with zero unmet flush "
            "demand in the base three-year run and <= %.0f%% of demand unmet in the "
            "`pending_growth_above_floor_market` stress run; `stake_min_ton` is the larger of "
            "the two implied minima below, rounded up to a 1/2/5 figure. "
            "WHAT THIS RUN DOES NOT SHOW: the base run produced ZERO exits at EVERY N -- the "
            "venue-depth clamp keeps a real tranche two orders of magnitude below the ceiling "
            "the reserve is sized against, so the reserve was never drawn on and the stress "
            "scenario never flushes at all. The three exit legs are therefore UNEXERCISED by "
            "this sweep, and a zero here is an absence of evidence, not a pass: leg 1, leg 2 "
            "and leg 3 are proved only by the mock pool's branch tests (STAKING_PLAN.md P0 "
            "point 1), and `unmet_flush_ton == 0` must not be quoted as a measurement of them."
            % (SEED, RESERVE_DAYS_SWEEP[0], RESERVE_DAYS_SWEEP[-1], UNMET_SHARE_MAX_STRESS * 100)
        ),
        "_exit_slippage_bps_source": (
            "OWNER's value, 2026-09-20 (DECISIONS.md D-151 point 5), NOT a sim output. A "
            "stable pool charges 0.04% and fills inside ~10-20 bps, so 50 bps clears a thin "
            "book without being a real haircut and refuses in a genuine depeg. The sim CONSUMES "
            "it -- every leg-2 fill is modelled at the full bound, so `realized_slippage_ton` "
            "is the worst case this number permits, never an average."
        ),
        "_harvest_interval_source": (
            "OWNER's value, 2026-09-20 (DECISIONS.md D-151 point 4): >= 30 days apart. "
            "2592000 = 30 * 86400."
        ),
        "_harvest_dust_source": (
            "DERIVED, not picked: 20 x the gas cost of ONE jetton transfer at basechain "
            "config 21. `jetton_wallet.transfer` (%d) + `jetton_wallet.internal_transfer` (%d) "
            "= %d gas units over 2 transactions, from contracts/gas-baseline.json, priced by "
            "sim/primes_sim/gas.py's `gas_to_ton` at %.9f GRAM; x20 = %.9f. Below this a "
            "harvest costs more gas than it moves value, so it is skipped (D-151 point 4). "
            "Every run in the sweeps below harvests on this threshold, and none of them is "
            "affected by it: a month's accrual at the modelled stake sizes is three orders of "
            "magnitude above it, so it guards the empty-pool case and nothing else."
            % (gas_baseline["jetton_wallet.transfer"],
               gas_baseline["jetton_wallet.internal_transfer"],
               transfer_gas, one_transfer_ton, harvest_dust)
        ),
        "_modelled_apr_source": (
            "ASSUMPTION, NOT MEASURED -- the same standing as `invites.optin_rate_assumed`. "
            "Tonstakers' realised APR is an external number with no measurement in this repo, "
            "so it is SWEPT over %s in `apr_sweep` rather than chosen, and %.2f is used as the "
            "headline for the `reserve_days` and `stake_min_ton` selections above. Yield never "
            "enters `T`, so the APR feeds back into nothing: every other figure in this block "
            "is identical at all three rates." % (list(APR_SWEEP), HEADLINE_APR)
        ),
        "apr_sweep": apr_rows,
        "reserve_days_sweep": {
            "_rule": (
                "smallest N with unmet_flush_ton == 0 in the base run AND "
                "unmet_share_of_demand <= %.2f in the stress run" % UNMET_SHARE_MAX_STRESS
            ),
            "_leg_assumption": (
                "Both legs of the sweep run with `leg2_fill_prob = 0` -- the DeDust leg "
                "unavailable, every leg-1 miss becoming the ~36 h payout bill. That is the "
                "only reading under which the rule can discriminate: with leg 2 available "
                "every exit is instant, so `unmet_flush_ton` is identically zero at every N "
                "by construction. It is a bound, not a measured refusal rate."
            ),
            "_range_note": range_note,
            "satisfies_rule": [bool(x) for x in n_satisfied],
            "base_run": base_rows,
            "stress_run_above_floor_market": stress_rows,
        },
        "stake_min_sweep": {
            "_rule": (
                "one constraint, rounded up to a 1/2/5 figure: cumulative flat fees <= "
                "%.0f%% of cumulative accrued yield at the headline APR. It is 1/x in the "
                "minimum, so each row extrapolates to the value that would just satisfy it "
                "(`implies_min_from_fee_share_ton`) and the largest extrapolation is taken, "
                "over rows with at least %d stakes -- fewer is a timing, not a flow. "
                "A second constraint -- round trips must not outpace the ratchet's own gas "
                "accrual (RATCHET_HOP_GAS) -- was DELETED by D-146 (2026-09-22): the pool's "
                "flat fees are paid by the caller of `stake`/`unstake`, not out of that "
                "accrual, so there is nothing for it to bound. It never bound: fee share "
                "implied 289.4 GRAM against its 117.6."
                % (FEE_SHARE_OF_YIELD_MAX * 100, MIN_STAKES_TO_EXTRAPOLATE)
            ),
            "min_stakes_to_extrapolate": MIN_STAKES_TO_EXTRAPOLATE,
            "at_reserve_days": chosen_n,
            "implied_min_from_fee_share_ton": implied_fee,
            "binding_constraint": binds,
            "rows": min_rows,
        },
        "chosen_configuration": chosen,
    }


def prime_mints(e: Engine) -> int:
    """Primes minted by either route: at the head (legacy path) or off a sold
    D-20 Dutch lot, which never enters `mint_log`."""
    return sum(1 for ev in e.mint_log if ev.kind == "prime") + e.prime_lots_sold


# DECISIONS.md D-196 / GAUNTLET.md V30.1: the ledger holds far-ahead claim
# marks locally only for 256-number blocks below a frontier the keeper's
# permissionless `import_block` advances once a block starts below `head + W`.
# A head that reaches the frontier first STALLS (mints refund as a lost race)
# until anyone imports -- it never corrupts state, and a larger W costs one
# 256-bit ledger word per 256 numbers, so W is sized generously.
LOT_BLOCK_NUMBERS = 256
#: DESIGN INPUT, not a sim output: how long the keeper (backend/keeper,
#: KEEPER_INTERVAL_MS = 60 s) may be down without the head stalling.
KEEPER_OUTAGE_TOLERANCE_DAYS = 1.0
IMPORT_WINDOW_SAFETY = 2.0
IMPORT_WINDOW_MIN_NUMBERS = 4096


def import_window_report(e: Engine) -> dict:
    """Size `off_head.import_window` from the base run's fastest head.

    The measured input is the most NUMBERS the head covered in any sliding
    window of KEEPER_OUTAGE_TOLERANCE_DAYS (mint_log carries the head position
    `n` and time `t` of every head mint; the gap between two of them includes
    the primes the head skipped, which is what W is measured in)."""
    import numpy as np

    span = KEEPER_OUTAGE_TOLERANCE_DAYS * 86400.0
    t = np.array([ev.t for ev in e.mint_log], dtype=np.float64)
    n = np.array([ev.n for ev in e.mint_log], dtype=np.int64)
    j = np.searchsorted(t, t + span, side="right") - 1
    peak = int((n[j] - n).max()) if len(n) else 0
    raw = peak * IMPORT_WINDOW_SAFETY
    blocks = max(math.ceil(raw / LOT_BLOCK_NUMBERS),
                 IMPORT_WINDOW_MIN_NUMBERS // LOT_BLOCK_NUMBERS)
    return {
        "numbers": blocks * LOT_BLOCK_NUMBERS,
        "blocks": blocks,
        "_rule": (
            "W = max(ceil(peak_head_advance_numbers * safety / 256) * 256, 4096), where "
            "peak_head_advance_numbers is the most numbers the base run's head covered in "
            "any sliding window of keeper_outage_tolerance_days. A head that reaches "
            "importedTo*256 before an import lands stalls (mints refund) until anyone calls "
            "import_block -- a stall, never corruption -- and W costs W/256 ledger words, "
            "so it is sized generously."
        ),
        "_source": (
            "sim/scripts/run_phase1.py import_window_report over the baseline Engine's "
            "mint_log (DECISIONS.md D-196, GAUNTLET.md V30.1)."
        ),
        "_flush_window_note": (
            "D-198 reuses W as the flush window (primes_ledger.tolk walkLimitN: the walk "
            "stops W blocks past Aux.unsoldFlushed). Same stall, same derivation: flush_unsold "
            "is due once the head leaves a block, so with the keeper live the cursor trails "
            "the head by <= 1 block and an outage leaves W blocks of head travel before mints "
            "refund -- the lower bound this rule sizes. The other side, rows held on the "
            "ledger, is not a sizing input: a full W-block window holds 857 unsold rows with "
            "forfeit rows (measured, LotBlock.spec.ts), far under config 43's 65,536 cells."
        ),
        "inputs": {
            "peak_head_advance_numbers": peak,
            "keeper_outage_tolerance_days": KEEPER_OUTAGE_TOLERANCE_DAYS,
            "_keeper_outage_tolerance_note": (
                "DESIGN INPUT, not a sim output: the keeper (KEEPER_INTERVAL_MS = 60 s) "
                "may be down this long before the head can stall."
            ),
            "safety": IMPORT_WINDOW_SAFETY,
            "min_numbers": IMPORT_WINDOW_MIN_NUMBERS,
            "block_numbers": LOT_BLOCK_NUMBERS,
        },
    }


def run_pass(tribute_pct=0.10, **overrides) -> Engine:
    split = econ.SplitParams(tribute_pct=tribute_pct)
    kwargs = dict(BASELINE_KWARGS)
    kwargs.update(overrides)
    p = SimParams(split=split, **kwargs)
    return Engine(p).run()


# --------------------------------------------------------------------------- #


def main(params_path: str = PARAMS_PATH, write_docs: bool = True):
    """Run every pass and write params.json to `params_path`. `--check` passes a temp
    path and `write_docs=False`, so it regenerates without touching a tracked file."""
    t_start = time.time()
    os.makedirs(OUT_DIR, exist_ok=True)

    # ------------------------------------------------------------------ #
    # 1. Analytic tribute structure (SS3.2)
    # ------------------------------------------------------------------ #
    print("=== 1. Tribute structure: band tables, f-dial, ceiling, equal age ===")
    spf5 = tr.spf_sieve(100_000)
    bands = {
        "n_1e5_flat_f0": tr.band_shares(100_000, "flat", 0.0, spf5),
        "n_1e5_sqrt_f0": tr.band_shares(100_000, "sqrt", 0.0, spf5),
        "n_1e5_p_f0": tr.band_shares(100_000, "p", 0.0, spf5),
        "n_1e5_sqrt_f020": tr.band_shares(100_000, "sqrt", 0.20, spf5),
    }
    spf6 = tr.spf_sieve(1_000_000)
    bands["n_1e6_flat_f0"] = tr.band_shares(1_000_000, "flat", 0.0, spf6)
    bands["n_1e6_sqrt_f0"] = tr.band_shares(1_000_000, "sqrt", 0.0, spf6)
    for name, b in bands.items():
        print(f"  {name}: >200 = {b['all_gt_200']*100:.1f}%  >10k = {b['gt_10k']*100:.1f}%")
    ceiling_tbl = tr.lifetime_ceiling_table(1_000_000, spf6)
    equal_age = tr.repayment_head_multiples(1_000_000, spf6)

    # ------------------------------------------------------------------ #
    # 2. Baseline pass
    # ------------------------------------------------------------------ #
    print("\n=== 2. Baseline pass (D-20) ===")
    e2 = run_pass()
    npv2 = an.discounted_tribute_npv_by_prime(e2)
    y2 = an.annualized_tribute_yield(e2, 90.0)
    ref2 = an.auction_reference_prices(npv2, y2)
    print(f"  final head {e2.head-1:,}  mints {len(e2.mint_log):,}  floor {e2.floor_price:.6f}")
    print(f"  prime lots {e2.prime_lots_opened:,} (sold {e2.prime_lots_sold:,}, "
          f"unsold {e2.prime_lots_unsold:,}, peak open {e2.prime_lot_backlog_peak:,})")

    auction = {
        "v5_reference_prices": ref2,
        "v5_npv_ton": npv2,
        "annualized_yield_final_quarter_ton": y2,
        "weighting_comparison": an.auction_value_comparison(200_000),
    }
    print("  v5 reference reserves:", {p: round(v["reference_reserve_ton"], 2) for p, v in ref2.items()})

    # ------------------------------------------------------------------ #
    # 4. PRIME_UPLIFT / PRIME_WINDOW calibration (SS5.1)
    # ------------------------------------------------------------------ #
    print("\n=== 4. PRIME_UPLIFT / PRIME_WINDOW ===")
    n_top = e2.head - 1
    k_max_top = econ.k_max_of_n(n_top, 1000, 0.9, 0.2)
    sizing = ph.size_prime_uplift(e2, k_max_top)
    sel = sizing["selected"]
    print(f"  k_max at range top (n={n_top:,}) = {k_max_top:.3f}; selected {sel}")
    up = econ.UpliftParams(prime_uplift=sel["prime_uplift"], prime_window=sel["prime_window"])
    if (up.prime_uplift, up.prime_window) != (econ.UpliftParams().prime_uplift,
                                              econ.UpliftParams().prime_window):
        print("  calibration moved off the proposal -- re-running the baseline with it")
        BASELINE_KWARGS["uplifts"] = up
        e2 = run_pass()
        npv2 = an.discounted_tribute_npv_by_prime(e2)
        y2 = an.annualized_tribute_yield(e2, 90.0)
        ref2 = an.auction_reference_prices(npv2, y2)
        auction["v5_reference_prices"] = ref2
        auction["v5_npv_ton"] = npv2
        auction["annualized_yield_final_quarter_ton"] = y2
    headroom_doc = econ.headroom_table(econ.UpliftParams(prime_uplift=0.06, prime_window=5))
    print("  SS5.1's published table, reproduced at the documented proposal 0.06/5:")
    for r in headroom_doc:
        print(f"    n={r['n']:>9,}  k_max {r['k_max_n']:.3f}  headroom {r['headroom_to_k_ceil']:.3f}  "
              f"credit {r['credit_value_ton']:.3f}  forgone {r['rebate_forgone_ton']:.3f}  "
              f"nets {r['protocol_nets_ton']:.3f}  share {r['compensation_share']*100:.0f}%")
    headroom = econ.headroom_table(up)
    print("  at the calibrated pair:")
    for r in headroom:
        print(f"  n={r['n']:>9,}  k_max {r['k_max_n']:.3f}  headroom {r['headroom_to_k_ceil']:.3f}  "
              f"credit {r['credit_value_ton']:.3f}  forgone {r['rebate_forgone_ton']:.3f}  "
              f"nets {r['protocol_nets_ton']:.3f}  share {r['compensation_share']*100:.0f}%")
    invariant_ns = [10 ** i for i in range(3, 8)] + [n_top]
    invariant = [
        {
            "n": n,
            "k_max_n": econ.k_max_of_n(n, 1000, 0.9, 0.2),
            "uplift_x_window": up.prime_uplift * up.prime_window,
            "holds": up.prime_uplift * up.prime_window < econ.k_max_of_n(n, 1000, 0.9, 0.2),
        }
        for n in sorted(set(invariant_ns))
    ]
    invariant_holds = all(r["holds"] for r in invariant)
    print(f"  invariant PRIME_UPLIFT*PRIME_WINDOW < k_max(n) over range: {invariant_holds}")
    realized = prime_uplift_realized_report(e2, up)
    print(f"  realized in engine: {realized['windows_opened']} windows, "
          f"{realized.get('uplifted_mints', 0)} uplifted mints, holds={realized['holds']}")

    # ------------------------------------------------------------------ #
    # 6. Uplift stacking under K_CEIL (base vs pessimistic)
    # ------------------------------------------------------------------ #
    print("\n=== 6. Uplift stacking under K_CEIL ===")
    e_pess = run_pass(pessimistic_uplifts=True)
    stacking = {
        "k_ceil": up.k_ceil,
        "base_case": an.uplift_clamp_report(e2),
        "pessimistic_case": an.uplift_clamp_report(e_pess),
        "base_floor_trajectory": an.floor_trajectory(e2),
        "pessimistic_floor_trajectory": an.floor_trajectory(e_pess),
        "final_floor_base": e2.floor_price,
        "final_floor_pessimistic": e_pess.floor_price,
        "floor_ratio_pessimistic_over_base": e_pess.floor_price / e2.floor_price if e2.floor_price else None,
        "ladders": {
            "recruit_rank_tiers": list(up.recruit_rank_tiers),
            "recruit_rank_uplifts": list(up.recruit_rank_uplifts),
            "prime_rank_tiers": list(up.prime_rank_tiers),
            "prime_rank_uplifts": list(up.prime_rank_uplifts),
            "max_summed_uplift": (up.recruit_rank_uplifts[-1] + up.prime_rank_uplifts[-1]
                                  + up.prime_uplift + up.newcomer_uplift),
        },
    }
    print(f"  base floor {e2.floor_price:.6f} vs pessimistic {e_pess.floor_price:.6f} "
          f"({stacking['floor_ratio_pessimistic_over_base']:.3f}x)")
    print(f"  clamp bind rate: base {stacking['base_case']['clamp_bind_rate']:.4f}, "
          f"pessimistic {stacking['pessimistic_case']['clamp_bind_rate']:.4f}")

    # ------------------------------------------------------------------ #
    # 7. Floor guard
    # ------------------------------------------------------------------ #
    print("\n=== 7. Floor guard ===")
    sandwich_guarded = an.sandwich_profitability(e2)
    e_noguard = run_pass(floor_guard_enabled=False, horizon_days=365.0,
                         history_every_n_mints=1000)
    sandwich_unguarded = an.sandwich_profitability(e_noguard)
    pending = an.pending_growth_report(e2)
    e_healthy = run_pass(external_buy_ton_per_day=400.0,
                         horizon_days=365.0, history_every_n_mints=1000)
    pending_above_floor = an.pending_growth_report(e_healthy)
    pending_above_floor["amm_vs_floor"] = an.amm_vs_floor_detachment(e_healthy)
    print(f"  above-floor market (400 GRAM/day external demand): pending "
          f"{pending_above_floor['final_pending_ton']:.1f} GRAM after "
          f"{pending_above_floor['days_simulated']:.0f} days, fill rate "
          f"{pending_above_floor['fill_rate']}")
    # ------------------------------------------------------------------ #
    # 7b. The staked reserve (DECISIONS.md D-151 / STAKING_PLAN.md P1)
    # ------------------------------------------------------------------ #
    print("\n=== 7b. Staked reserve: reserve_days and stake_min_ton ===")
    staking = staking_report(
        # The SAME stress scenario `pending_growth_above_floor_market` is
        # measured on, so the two blocks describe one run and not two.
        dict(external_buy_ton_per_day=400.0, horizon_days=365.0,
             history_every_n_mints=1000),
        gasmod.load_gas_baseline(GAS_BASELINE_PATH),
    )
    print(f"  staked_fraction = {staking['staked_fraction']:.2f} "
          f"(reserve {staking['reserve_fraction_of_pending']:.2f} of pending = "
          f"{staking['_equivalent_reserve_days']:g} days of ceiling), "
          f"stake_min_ton = {staking['stake_min_ton']:,.0f}, "
          f"harvest_dust_tston = {staking['harvest_dust_tston']:.9f}")

    detach = an.amm_vs_floor_detachment(e2)
    guard_capacity = an.guard_can_close_detachment(e2)

    # D-168 / STAKING_PLAN.md SS3.3: the LP miner is deleted, so the only depth
    # certain to exist is the operator's genesis pair (D-154: L*X PRIMES against
    # L*X^2/S0 GRAM). Re-run the base case with the pool seeded there.
    pair_primes = e2.genesis_donation_primes
    pair_ton = pair_primes * e2.floor_price_deploy
    e_pair = run_pass(modelled_pool_ton=pair_ton,
                      modelled_pool_primes=pair_primes)
    lp_depth = _lp_depth_without_miner(e2, e_pair)
    print(f"  LP depth without miner: {lp_depth['verdict']} "
          f"(operator pair {pair_ton:.2f} GRAM / {pair_primes:,.0f} PRIMES; fills "
          f"{e_pair.flush_fills}/{e_pair.flush_attempts})")
    print(f"  guarded: net sandwich PnL {sandwich_guarded['sandwich_net_pnl_ton']:.2f} GRAM over "
          f"{sandwich_guarded['sandwich_events']} events; fills {e2.flush_fills}/{e2.flush_attempts}")
    print(f"  unguarded (1yr control): net {sandwich_unguarded['sandwich_net_pnl_ton']:.2f} GRAM")
    print(f"  pending: final {pending['final_pending_ton']:.1f} GRAM "
          f"({(pending['pending_share_of_T'] or 0)*100:.1f}% of T), peak {pending['peak_pending_ton']:.1f}")

    # ------------------------------------------------------------------ #
    # 8. owed-dictionary ceiling
    # ------------------------------------------------------------------ #
    print("\n=== 8. owed-dict state-size resolution ===")
    storage_report = st.report()
    ceiling_base = an.owed_ceiling_report(e2)
    e_low = run_pass(
                     arrival=ArrivalParams(base_rate_per_day=15.0, growth_per_day=0.0,
                                           hype_multiplier=3.0),
                     horizon_days=5 * 365.0, n_max=500_000, history_every_n_mints=1000)
    e_high = run_pass(
                      arrival=ArrivalParams(base_rate_per_day=200.0, growth_per_day=0.003,
                                            hype_multiplier=8.0),
                      horizon_days=2 * 365.0, n_max=2_000_000, history_every_n_mints=1000)
    ceiling_low = an.owed_ceiling_report(e_low)
    ceiling_high = an.owed_ceiling_report(e_high)
    print(f"  baseline crosses {an.OWED_CEILING_N:,}? {ceiling_base['crossed_within_horizon']} "
          f"(day {ceiling_base['day_crossed']})")
    print(f"  high growth: {ceiling_high['crossed_within_horizon']} (day {ceiling_high['day_crossed']})")
    print(f"  resolution: {storage_report['recommended']['shards']} shards -> capacity n = "
          f"{storage_report['recommended']['capacity_n']:,}")

    # ------------------------------------------------------------------ #
    # 9. Kill criteria
    # ------------------------------------------------------------------ #
    print("\n=== 9. Kill criteria ===")
    kills = kc.run_all(e2, auction)
    for k in kills:
        print(f"  {k['name']}: {'PASS' if k['passed'] else 'FAIL'}")
    all_passed = all(k["passed"] for k in kills)

    # ------------------------------------------------------------------ #
    # 10. Charts + params.json
    # ------------------------------------------------------------------ #
    print("\n=== 10. Charts ===")
    for p in charts.render_all(e2, y2, OUT_DIR):
        print("  ", p)

    # DECISIONS.md D-100 point 2: the emission curve is published BEFORE deploy,
    # from the same run that writes params.json, so the two cannot disagree.
    curve = emission_curve(e2)
    print("\n=== 10b. Genesis emission curve (D-100 point 2) ===")
    print(f"  p_f0 = {curve['p_f0_ton_per_primes']:.6e} GRAM/PRIMES "
          f"(T0 = {curve['genesis_donation_ton']:.2f} GRAM / S0 = "
          f"{curve['genesis_supply_primes']:,.0f} PRIMES)")
    print(f"  mint 1 emits {curve['first_mint_emission_pct_of_S0']:.2f}% of S0; "
          f"mint 10 {curve['mint_10_emission_pct_of_S0']:.2f}%; "
          f"mint 100 {curve['mint_100_emission_pct_of_S0']:.3f}%")
    print(f"  over 100 mints: T x{curve['T_multiple_after_curve']:.1f}, "
          f"S x{curve['S_multiple_after_curve']:.2f}, "
          f"p_f x{curve['p_f_multiple_after_curve']:.2f}, "
          f"floor monotone: {curve['floor_monotone']}")
    if write_docs:
        print("  ", write_emission_curve_doc(curve, e2))

    era_report = era_bounty_report(e2)
    # D-106: was `rank_value["mean_beta"]`, computed inside the deleted patronage
    # section. Same quantity, read straight off the baseline run's own mint log.
    beta_measured = (sum(ev.pool_injection for ev in e2.mint_log) / len(e2.mint_log)
                     if e2.mint_log else 0.0)
    quest_reward_rep = quest_reward_report(e2, era_report, beta_measured)
    # G78b / D-171: the contract-fact board, sized from `prime_quests` the same way, and
    # the ONE lifetime cap shared across both boards (`share_of_cap` on every row).
    quest_reward_rep["prime_quests"] = prime_quest_reward_report(e2, era_report, quest_reward_rep)
    score_rebate_rep = score_rebate_report(e2, era_report)
    params_out = build_params_json(
        e2, ref2, y2, kills, all_passed, up, sizing, headroom, headroom_doc, invariant,
        invariant_holds, bands, ceiling_tbl, equal_age, auction,
        stacking, sandwich_guarded, sandwich_unguarded,
        pending, pending_above_floor, detach, guard_capacity, storage_report, ceiling_base, ceiling_low,
        ceiling_high, era_report, quest_reward_rep, score_rebate_rep, staking,
        lp_depth,
    )
    merge_foreign_keys(params_out, PARAMS_PATH, verbose=True)
    # `allow_nan=False`: Python's json.dump emits bare `NaN` / `Infinity` by default,
    # which are not JSON. shared/params.json is the declared single source of truth for
    # the contracts, the backend and the webapp, all of which parse it with a real JSON
    # parser and fail hard on those tokens. Raising here is the right failure: a
    # non-finite value in a parameter file is a sim bug to fix at the source (use None
    # for "not observed"), not something to serialise and discover downstream.
    with open(params_path, "w", encoding="utf-8") as f:
        json.dump(params_out, f, indent=2, allow_nan=False)
        # Trailing newline: `json.dump` emits none, but every committed copy of
        # this file has had one (a formatter normalised it outside the
        # generator), so without this a clean regen shows a spurious
        # "\ No newline at end of file" diff on the last line every time.
        f.write("\n")
    print(f"\nWrote {params_path}")

    summary = {
        "kill_criteria_all_passed": all_passed,
        "kill_criteria": {k["name"]: k["passed"] for k in kills},
        "prime_uplift": up.prime_uplift,
        "prime_window": up.prime_window,
        "k_ceil": up.k_ceil,
        "floor_guard": e2.p.floor_guard,
        "f": e2.p.split.flat_dividend_f,
        "band_check_gt200_sqrt_1e5": bands["n_1e5_sqrt_f0"]["all_gt_200"],
        "owed_ceiling_resolution_shards": storage_report["recommended"]["shards"],
        "wall_time_s": time.time() - t_start,
    }
    with open(os.path.join(OUT_DIR, "run_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"\nTotal wall time: {time.time() - t_start:.1f}s")
    # SS5.1 measured in the engine: a window worth >= the rebate its prime
    # withheld fails the run, like a kill criterion.
    return all_passed and realized["holds"] is not False


def _concept_draft() -> str:
    """The draft version CONCEPT.md's own status line declares, read, never typed."""
    with open(os.path.join(REPO_ROOT, "CONCEPT.md"), encoding="utf-8") as f:
        m = re.search(r"design draft (v[\d.]+)", f.read(2000))
    return m.group(1) if m else "unknown"


def merge_foreign_keys(params_out: dict, path: str, verbose: bool = False) -> dict:
    """Carry the keys this script does not own across from the file on disk.

    build_params_json() rebuilds the whole document, so writing it straight out
    deletes whatever another generator put there. Every key in FOREIGN_PARAM_KEYS
    is copied through verbatim instead. A missing file is the first-run case, not
    an error: the stubs in build_params_json() stand in until the owning
    generator has run once. Mutates and returns `params_out`.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            existing = json.load(f)
    except FileNotFoundError:
        existing = {}
    for key in FOREIGN_PARAM_KEYS:
        if key in existing:
            params_out[key] = existing[key]
            if verbose:
                print(f"  preserved foreign key `{key}` (owned by another generator)")
    return params_out


def era_bounty_report(e: Engine) -> dict:
    from primes_sim.arrivals import PRIMORIALS
    reached = [pr for pr in PRIMORIALS if pr <= e.head]
    per_era_frac = [0.20, 0.16, 0.13, 0.11, 0.10, 0.10, 0.10, 0.10]
    per_era_frac = [f / sum(per_era_frac) for f in per_era_frac]
    vault = e.bounty_vault_initial
    # D-204: the tracks are WHOLE-PRIMES amounts, not fractions of the vault. They
    # were fractions while the vault was 10,000,000 (30% eras; 40/35% of the rest);
    # D-204 grew the vault for one track only, so the others keep the amounts those
    # fractions gave and `prime_quests` is what is left. The emitted fractions are
    # derived from the amounts, for the readers that quote them.
    eras_pool = ERAS_POOL_PRIMES
    eras_pool_frac = eras_pool / vault
    remaining = round(vault - eras_pool)
    prime_quests_primes = (
        remaining - PUZZLES_TRACK_PRIMES - QUESTS_TRACK_PRIMES - SECURITY_BOUNTY_PRIMES
    )
    assert prime_quests_primes > 0, "the vault no longer covers its own tracks"
    # DENOMINATION_PLAN P4 -- the era schedule is GRAM-DENOMINATED.
    #
    # A fixed nominal PRIMES bounty inflates with the floor: `p_f` rises ~45x over
    # year one at baseline demand, so an era ceremony sized to be worth 2 GRAM at
    # open would be worth ~90 GRAM at day 365. What the design fixes is the
    # ceremony's VALUE, so that is what the schedule carries. `max_primes` is the
    # PRIMES that value buys at the GENESIS floor and is therefore the largest the
    # boundary can ever pay -- the ratchet only raises `p_f`, so in normal
    # operation the cap is never reached; it exists to bound the (T, S) snapshot
    # the vault is handed (primes_bounty_vault.tolk D22). Because the caps are
    # exactly the old nominal amounts, the vault's total lifetime commitment is
    # unchanged and `eras_pool_primes` still bounds it.
    p_f0 = e.floor_price_genesis
    return {
        "bounty_vault_size_primes": vault,
        "eras_pool_frac_of_vault": eras_pool_frac,
        "eras_pool_primes": eras_pool,
        "era_bounty_schedule_denomination": (
            "GRAM. `bounty_ton` is the ceremony's fixed value; the vault pays "
            "min(bounty_ton * S / T, max_primes) nano-PRIMES. `max_primes` is "
            "bounty_ton / genesis_floor_price_ton_per_primes and is a cap, not an "
            "amount. DENOMINATION_PLAN P4; CONCEPT.md SS7."
        ),
        "era_bounty_schedule": [
            {
                "era_boundary_n": pr,
                "bounty_ton": eras_pool * per_era_frac[i] * p_f0,
                "max_primes": eras_pool * per_era_frac[i],
            }
            for i, pr in enumerate(PRIMORIALS[:8])
        ],
        "reached_within_baseline_horizon": reached,
        # EARN_PLAN E2 needs one of these buckets as an ACTUAL NUMBER, not a
        # sentence: the voucher program's on-chain budget is the vault allow-list
        # entry's `remaining`, and CLAUDE.md rule 3 says a number in a contract
        # must be traceable to params.json or to CONCEPT.md. So the prose split
        # below is emitted as machine-readable amounts alongside the note it
        # replaces. The FRACTIONS are unchanged and are still a Phase A design
        # allocation rather than a simulated result -- that caveat survives
        # verbatim in `remaining_vault_split_note`, because making a number
        # machine-readable does not make it measured.
        "remaining_vault_split": {
            "frac_of_vault": 1.0 - eras_pool_frac,
            "pool_primes": remaining,
            "tracks": {
                name: {
                    "frac_of_remaining": primes / remaining,
                    "primes": primes,
                }
                for name, primes in (
                    # TELEGRAM_INVITES_PLAN.md (owner, 2026-11-07) deleted the
                    # constellation discovery-bounty track (0.15, 1,050,000
                    # PRIMES, D-193) with constellations. Its PRIMES stay in the
                    # vault -- D-43's size is unchanged -- and go to the track
                    # SS9.6's special-number rebates draw on, 0.25 -> 0.40, so
                    # `score_rebate` below is re-sized against the larger track.
                    ("puzzles", PUZZLES_TRACK_PRIMES),
                    # G75 (owner, 2026-09-23): `constellation_challenge` (0.05)
                    # is DELETED -- D-102 deleted `challenge()`, so it funded
                    # nothing. Its share goes to `unallocated` below, not to
                    # another track, so no track's figure moves.
                    # D-170 (owner, 2026-09-23): 0.20 + G75's unallocated 0.05,
                    # less the security prize below -- 750,000 PRIMES. Taken
                    # from here because nothing reads this track: no program is
                    # on the vault's allow-list for it and the sim sizes nothing
                    # from it, where `quests` sets the SS9.4 per-player reward.
                    #
                    # D-204 (owner, 2026-11-11): 750,000 -> 6,350,000. The whole
                    # of the vault's growth lands here, so with the headcount at
                    # 1,000 the smallest of SS9.4's twelve contract-fact quests
                    # pays 104 PRIMES where it paid 1.
                    ("prime_quests", prime_quests_primes),
                    # Raised 0.05 -> 0.35 by absorbing the whole previously
                    # unallocated 30% remainder. CONCEPT.md SS9.4's social quests
                    # are the acquisition funnel and they draw on this track and
                    # no other; at 0.05 the track held 14,000 PRIMES, which is
                    # ~1.2 GRAM at the genesis floor and funds a two-digit number
                    # of players. See `quest_rewards` below for the arithmetic
                    # that sizes it, and note the hard ceiling: the vault is
                    # pre-counted in S with no T behind it (SS3.3), so the WHOLE
                    # vault is worth T0 * pct / (1 + pct) at the opening floor --
                    # raising `pct` raises it, and pays for the raise with a lower
                    # p_f0, but nothing pushes it past T0. A growth budget is
                    # bounded by the founder seed (D-41).
                    ("quests", QUESTS_TRACK_PRIMES),
                    # D-170: ONE owner-set prize for a bug that can drain the
                    # system, a PRIMES count and not a fraction. Not simulated:
                    # the vault is pre-counted in S whole (SS3.3), so reserving
                    # part of it moves no simulated quantity.
                    ("security_bounty", SECURITY_BOUNTY_PRIMES),
                )
            },
        },
        "remaining_vault_split_note": (
            "D-204 (owner, 2026-11-11): the tracks are WHOLE-PRIMES amounts and the "
            "fractions here are derived from them. The vault grew 10,000,000 -> "
            "15,600,000 and the whole 5,600,000 went to prime_quests (750,000 -> "
            "6,350,000); eras (3,000,000), puzzles (2,800,000), quests (2,450,000) and "
            "security_bounty (1,000,000) keep the amounts the old fractions gave them. "
            "HISTORY of those amounts, at the 10,000,000 vault: "
            "Remaining 70% of vault: puzzles 40% (SS9.6's special-number rebates; 25% "
            "until TELEGRAM_INVITES_PLAN.md deleted the 15% constellation discovery-bounty "
            "track, D-193, whose PRIMES stayed in the vault and joined this track), "
            "prime quests 20% (raised from Phase 1 v4's "
            "0% -- SS0.1 makes prime quests the most generously funded track; D-170 cut it to "
            "750,000 PRIMES), quests 35%, security_bounty 1,000,000 PRIMES (D-170: one "
            "owner-set prize for a bug that can drain the system, paid through a second "
            "voucher instance; it took G75's unallocated 5% and 650,000 from prime quests). "
            "Proportions are a Phase A design allocation, not separately simulated. "
            "The tracks sum to 100% of the remainder: the 30% that was "
            "deliberately unallocated at genesis was folded into `quests` to fund "
            "SS9.4's social acquisition quests, which draw on that track and no other. "
            "An unallocated bucket is a floor-price gift to holders (SS3.3 pre-counts "
            "the WHOLE vault into S), so spending it is a real decision and not free: it "
            "converts a permanent understatement of backing into a growth budget. That "
            "reallocation does not by itself move p_f0; the vault fraction separately "
            "does (D-41 -> D-42 -> D-43, 20% -> 100% -> 500% of seeded LP) -- the floor "
            "now opens at 60,000 PRIMES per GRAM, and every SS6 number keyed to the "
            "opening floor moves with it. See `score_rebate` for what D-43's raise "
            "now funds (D-47 supersedes D-43's puzzle campaign). EARN_PLAN E2's "
            "voucher program draws on `quests` only."
        ),
    }


ERAS_POOL_PRIMES = 3_000_000
PUZZLES_TRACK_PRIMES = 2_800_000
QUESTS_TRACK_PRIMES = 2_450_000
"""D-204 -- the vault tracks that did NOT grow, in whole PRIMES: the amounts the
pre-D-204 fractions (30% eras; 40% / 35% of the rest) gave at a 10,000,000 vault."""

SECURITY_BOUNTY_PRIMES = 1_000_000
"""DECISIONS.md D-170 -- the one security prize, in whole PRIMES. Owner-set, not simulated.

Reserved out of the vault's remaining 70% as its own track so the bounty vault's allow-list
can cap a dedicated voucher instance at exactly this figure (CONCEPT.md SS9.5, SS10 Phase 4).
"""

REBATE_HORIZON_N = 1_000_000
"""CONCEPT.md SS9.6 / DECISIONS.md D-99 -- the horizon the rebate is sized over.

Read off `owed_dict_ceiling_resolution`: baseline reaches n=431,038 over 3 years,
high-growth reaches n=1,011,927 over 2 years. 1,000,000 sits just under the
high-growth ceiling and comfortably above baseline -- worst-case-but-not-absurd,
same precedent as `owed_ceiling_n`. Re-extend (raise the bound, re-run the
sweep) if actual head growth overtakes it -- a re-size, not a redesign.

Was `SPECIAL_NUMBER_HORIZON_N`. D-99 deletes the special-number TIERS
(discount/free/bonus), `specialNumberTier`, the tier price curve and the
curated-year list; what survives is this horizon and the two rebate rates below.
"""

#: D-99 SS1.5, owner answer 16, SIGNED: 0.005 GRAM of PRIMES per point of D(n) on
#: a head-minted composite. A TARGET, not the shipped figure -- `score_rebate_report`
#: clamps it if the projection overruns the vault's `puzzles` track, and the
#: emitted block says which happened.
SIGNED_COMPOSITE_PER_POINT_TON = 0.005

#: D-99 SS1.5: the flat figure for a prime of D-96's family, "today's `free` tier
#: value, resized by the sim against the new composite population". The signed
#: starting point, scaled by the same factor as the per-point rate so the RATIO
#: between the two signed targets survives the clamp.
SIGNED_PRIME_FAMILY_TON = 0.132

#: Half the `puzzles` track; the other half stays as headroom. Unchanged from the
#: rule the pre-D-99 tier sizer used, so the two runs are comparable.
TARGET_TRACK_FRACTION = 0.5


def score_rebate_report(e: Engine, era_report: dict) -> dict:
    """CONCEPT.md SS9.6 / D-99 SS1.5 -- the two rebate rates, sized.

    Replaces `special_numbers_report` (D-99 supersedes D-47/D-68/D-89's tier
    program). There are no tiers left to classify: **two populations** get PRIMES
    back from the bounty vault and nothing else does.

      * `composite_per_point` -- a composite minted AT THE HEAD, paid
        `rate * D(n)`. An auction-won composite gets nothing; the premium is the
        price of impatience.
      * `prime_family` -- a prime of D-96's `dirichlet_primes` (p > 100,000,
        p = 1 mod 101), flat, **by whatever route it minted**. D-99 narrows D-96
        to exactly this: the family scores no points, sets no bit and lifts no
        price. It selects a rebate and nothing else.

    **What the sim owns here and what it does not** (CLAUDE.md rule 3). The two
    signed targets above are the OWNER'S (answer 16, and SS1.5's "today's free
    tier value"). What the sim owns is whether the vault can afford them: it
    measures the score distribution and the head/floor path, projects what both
    populations would draw, and CLAMPS the pair -- preserving their ratio -- if
    the projection overruns half the `puzzles` track. The emitted block says
    which of the two happened rather than reporting a clamped number as if it
    had been chosen.

    **The projection includes the auction path** (D-99 SS5 point 4). The pre-D-99
    sizer counted only head-paced claims, which was right while every rebate
    family was a prime that had to wait its turn. It is not right now: a
    rebate-family prime won at auction draws from the vault the moment its lot
    closes. Every family member inside the horizon is therefore counted, at the
    floor its own `n` implies, regardless of which route mints it -- the
    conservative direction, since an auction win claims EARLIER (a lower floor,
    hence more PRIMES) than the head would have.

    **The floor path is this run's own.** A member at position `n` is priced at
    the floor this baseline run's head/floor history reaches when the head
    arrives at `n`; beyond this run's final head the run's FINAL floor is used
    rather than extrapolating growth -- deliberately conservative
    (higher-PRIMES-cost), not a claim about what happens after year 3.
    """
    import numpy as np

    from primes_sim import desirability as ds

    track = era_report["remaining_vault_split"]["tracks"]["puzzles"]
    p_f0 = e.floor_price_genesis
    hist = sorted(e.history, key=lambda h: h["t_days"])
    final_floor = hist[-1]["floor_price"] if hist else p_f0

    # The floor at the moment the head arrives at each n, as an array. The head
    # is monotone in time, so the history is already sorted in `head` too and one
    # searchsorted resolves every n at once -- the same step function the old
    # scalar `floor_at_head_n` walked, computed exhaustively instead of sampled.
    ns = np.arange(1, REBATE_HORIZON_N + 1, dtype=np.int64)
    if hist:
        heads = np.array([h["head"] for h in hist], dtype=np.int64)
        floors = np.array([h["floor_price"] for h in hist], dtype=np.float64)
        idx = np.searchsorted(heads, ns, side="right") - 1
        floor_of_n = np.where(idx >= 0, floors[np.clip(idx, 0, len(floors) - 1)], p_f0)
        floor_of_n = np.where(ns > heads[-1], final_floor, floor_of_n)
    else:
        floor_of_n = np.full(ns.shape, p_f0, dtype=np.float64)
    inv_floor = 1.0 / floor_of_n

    # The score distribution, exhaustive over [1, horizon] -- not sampled. This
    # is the measurement the whole sizing rests on, so it is the one thing that
    # is not allowed to be an estimate.
    # GAUNTLET.md C15 (signed 2026-09-24): the head mint pays per point of the
    # FACTORED score `scoreOfFrom(n, factors)`, so that is what is summed here.
    # A prime's factored score is its from-`n` score (the mint passes no list).
    from primes_sim.tribute import spf_sieve

    sieve = ds.prime_sieve(ds.sieve_limit_for(REBATE_HORIZON_N + 1))
    spf = spf_sieve(REBATE_HORIZON_N)
    scores = np.concatenate([
        ds.factored_scores_range(lo, min(lo + 250_000, REBATE_HORIZON_N + 1),
                                 sieve=sieve, spf=spf)
        for lo in range(1, REBATE_HORIZON_N + 1, 250_000)
    ])
    prime_mask = sieve[ns]
    composite_mask = ~prime_mask

    # D-96's family, SIEVED (its own density argument, kept): 1 in phi(101) = 1
    # in 100 primes at every depth, which is ~1 in 1,316 integers just above
    # 100,000 and rarer beyond -- under the owner's declared ceiling of 1 in
    # 1,000 integers. Never exhausted, which is why D-96 chose it over a closed
    # 25-member family, and D-99 keeps it for that reason and no other.
    family_mask = (prime_mask & (ns > ds.DIRICHLET_MIN_N)
                   & (ns % ds.DIRICHLET_MOD == 1))
    family_count = int(family_mask.sum())
    prime_count = int(prime_mask.sum())

    # The two populations' PRIMES draw per unit of rate.
    composite_points = int(scores[composite_mask].sum())
    composite_primes_per_ton_of_rate = float((scores * inv_floor)[composite_mask].sum())
    family_primes_per_ton_of_rate = float(inv_floor[family_mask].sum())

    budget_primes = track["primes"] * TARGET_TRACK_FRACTION
    at_signed = (SIGNED_COMPOSITE_PER_POINT_TON * composite_primes_per_ton_of_rate
                 + SIGNED_PRIME_FAMILY_TON * family_primes_per_ton_of_rate)
    scale = budget_primes / at_signed if at_signed > 0 else 1.0
    clamped = scale < 1.0
    applied = min(scale, 1.0)

    # Rounded DOWN to the nanoGRAM-legible 1e-6 quantum, never to nearest: a
    # rate rounded up would put the projection back over the 50% budget the
    # scale was solved for, which is the one thing the clamp exists to prevent.
    quantum = 1e-6
    composite_rate = math.floor(SIGNED_COMPOSITE_PER_POINT_TON * applied / quantum) * quantum
    family_rate = math.floor(SIGNED_PRIME_FAMILY_TON * applied / quantum) * quantum
    composite_rate = round(composite_rate, 9)
    family_rate = round(family_rate, 9)

    composite_projected = composite_rate * composite_primes_per_ton_of_rate
    family_projected = family_rate * family_primes_per_ton_of_rate
    total_projected = composite_projected + family_projected
    # The claim-time clamp the contract carries: what the reward costs at the
    # GENESIS floor, the worst case, since the ratchet only ever raises p_f.
    composite_max_primes_per_point = composite_rate / p_f0
    family_max_primes = family_rate / p_f0
    composite_worst_case = composite_max_primes_per_point * composite_points
    family_worst_case = family_max_primes * family_count
    total_worst_case = composite_worst_case + family_worst_case

    band_of = lambda s: "0" if s == 0 else "1-10" if s <= 10 else "11-30" if s <= 30 else "31+"
    comp_scores = scores[composite_mask]
    bands = {}
    for name, lo_s, hi_s in (("0", 0, 0), ("1-10", 1, 10), ("11-30", 11, 30),
                             ("31+", 31, ds.W.SCORE_MAX)):
        c = int(((comp_scores >= lo_s) & (comp_scores <= hi_s)).sum())
        bands[name] = {"count": c, "share": c / comp_scores.size}

    return {
        "_source": "sim/scripts/run_phase1.py score_rebate_report",
        "_decision": "D-99 SS1.5 (supersedes D-47/D-68/D-89's tier program)",
        "horizon_n": REBATE_HORIZON_N,
        "rates": {
            "composite_per_point": {
                "kind": 0,
                "reward_ton": composite_rate,
                "max_primes_per_point_genesis_floor": composite_max_primes_per_point,
                "_who": (
                    "a COMPOSITE minted AT THE HEAD, paid reward_ton * D(n), D(n) "
                    "being the FACTORED score scoreOfFrom(n, factors) (GAUNTLET.md "
                    "C15, signed 2026-09-24). An auction-won composite gets nothing "
                    "(D-99 SS1.5)."
                ),
            },
            "prime_family": {
                "kind": 1,
                "reward_ton": family_rate,
                "max_primes_genesis_floor": family_max_primes,
                "_who": (
                    "a PRIME of D-96's family (p > "
                    f"{ds.DIRICHLET_MIN_N:,} and p = 1 mod {ds.DIRICHLET_MOD}), "
                    "flat, by whatever route it minted -- head or auction."
                ),
            },
        },
        "signed_targets_ton": {
            "composite_per_point": SIGNED_COMPOSITE_PER_POINT_TON,
            "prime_family": SIGNED_PRIME_FAMILY_TON,
            "_provenance": (
                "OWNER-DECLARED (D-99 answer 16 for the per-point rate; SS1.5 for "
                "the family's starting figure, today's shipped 0.132 GRAM). The "
                "sim does not choose them -- it checks whether the vault can "
                "afford them and clamps the PAIR, ratio preserved, if it cannot."
            ),
        },
        "sizing": {
            "puzzles_track_primes": track["primes"],
            "target_track_fraction": TARGET_TRACK_FRACTION,
            "budget_primes": budget_primes,
            "projection_at_signed_targets_primes": at_signed,
            "scale_solved": scale,
            "scale_applied": applied,
            "clamped": clamped,
            "_rule": (
                "One free scale over BOTH rates, so the ratio between the two "
                "signed targets survives: projection(s) = s * (0.005 * "
                "sum_composites D(n)/p_f(n) + 0.132 * sum_family 1/p_f(n)), "
                "solved for projection = 50% of the puzzles track. s >= 1 means "
                "the signed targets fit and are shipped unchanged (the sim never "
                "inflates a signed number); s < 1 means they overrun and both are "
                "scaled by s."
            ),
        },
        "score_distribution_over_composites": {
            "window": [1, REBATE_HORIZON_N],
            "composite_count": int(composite_mask.sum()),
            "prime_count": prime_count,
            "total_points": composite_points,
            "mean_score": composite_points / int(composite_mask.sum()),
            "bands": bands,
            "_method": (
                "EXHAUSTIVE, not sampled: desirability.factored_scores_range "
                "(scoreOfFrom with the true factorization, GAUNTLET.md C15 signed "
                "2026-09-24; a prime's is its from-n score) over every n in "
                "[1, horizon]. No number scores 0 below 10^8 -- the LEN term "
                "pays 2 points per digit under 9 -- so the '0' band is empty by "
                "construction and 'ordinary' means the 1-10 band."
            ),
        },
        "rebate_family": {
            "min_n": ds.DIRICHLET_MIN_N,
            "mod": ds.DIRICHLET_MOD,
            "sieved_count_to_horizon": family_count,
            "share_of_primes_in_window": family_count / prime_count,
            "density_per_integer": family_count / REBATE_HORIZON_N,
            "_density_argument": (
                "D-96, unchanged by D-99's narrowing. Dirichlet's theorem makes "
                "the class infinite and equidistributed: exactly 1/phi(101) = 1 "
                "in 100 primes at every depth, so it is never exhausted -- the "
                "reason D-96 replaced D-68's closed 25-member family. The owner's "
                "declared ceiling is 1 in 1,000 INTEGERS; the sieved density "
                "above is what this window actually realises."
            ),
        },
        "projection": {
            "composite_primes": composite_projected,
            "prime_family_primes": family_projected,
            "total_primes_at_head_reached_floor": total_projected,
            "share_of_puzzles_track": total_projected / track["primes"],
            "fits_in_track": total_projected <= track["primes"],
            "_includes_auction_path": (
                "YES, and that is D-99 SS5 point 4's correction to this block. "
                "Every rebate-family prime inside the horizon is counted whether "
                "it mints at the head or at auction, because the family rebate "
                "pays on either route. Counting it at the head-arrival floor is "
                "the conservative direction only for the head route; an auction "
                "win claims earlier, at a LOWER floor and therefore more PRIMES, "
                "which the 50% headroom is there to absorb."
            ),
        },
        "worst_case": {
            "composite_primes": composite_worst_case,
            "prime_family_primes": family_worst_case,
            "total_max_primes": total_worst_case,
            "fits_in_track": total_worst_case <= track["primes"],
            "_meaning": (
                "The theoretical ceiling if every member claimed at the GENESIS "
                "floor, which cannot happen once the head has moved. It exists to "
                "size the claim-time clamp (payout_formula), not the track "
                "balance."
            ),
        },
        "payout_formula": (
            "min(reward_ton * S/T, max_primes) nano-PRIMES at claim time, times "
            "D(n) on kind 0 and times 1 on kind 1 -- the same min(value, stock) "
            "shape as the era bounty schedule and the quest reward cap. "
            "max_primes = reward_ton / genesis_floor_price_ton_per_primes."
        ),
        "_note": (
            "The three tiers are DELETED. There is no discount/free/bonus, no "
            "specialNumberTier, no tier price curve and no curated-year list: "
            "D-99 prices every number from one additive score and pays the rebate "
            "off the same score. The words must not come back -- a tier was a "
            "rebate wearing a rarity badge, which is exactly what D-99 answer 15 "
            "separates. If a claim's clamp binds below its reward_ton, that is "
            "the vault running the puzzles track dry, not a bug -- the same "
            "self-funding shape D-42 applies to quests."
        ),
    }


def quest_reward_report(e: Engine, era_report: dict, beta: float) -> dict:
    """CONCEPT.md SS9.4 -- what a social quest pays, and what bounds it.

    Three numbers with three different jobs. Conflating any two of them is the
    failure this block exists to prevent.

    `reward_primes` is the OFFER, and as of D-42 it is denominated in PRIMES, not
    in GRAM. Every player who finishes the board gets the same number of PRIMES
    whenever they finish it. This is the reverse of D-41 and it is the whole point
    of the decision: the owner wants a fixed HEADCOUNT (10,000 players), and a
    fixed headcount out of a track whose size is fixed in PRIMES is only possible
    if the per-player draw is fixed in PRIMES too. Under D-41's GRAM denomination
    the early players were the expensive ones -- 0.25 GRAM cost 3,750 PRIMES at the
    opening floor and about 10 PRIMES at the sim's end state -- so the track funded
    65 players in the first months and the rest only years later. Fixing the PRIMES
    inverts that: the count is guaranteed on day one and the VALUE is what grows.

    `lifetime_cap_ton` is the CEILING, unchanged and still an invariant. A wallet
    may never earn more from quests, over its whole life, than the ratchet
    injection of the mint that unlocks the reward -- `beta * MINT_PRICE`. That is
    what makes the program self-funding in the only sense SS5 cares about: the
    gating mint adds `beta` GRAM to `T` while the vault payout leaves `S` untouched
    (SS3.3 pre-counts the vault), so every quest-paid wallet strictly RAISES `p_f`.

    Under D-41 the cap could be checked once, here, because the reward's GRAM value
    never moved. Under D-42 it CANNOT, and this is the load-bearing consequence of
    the switch: a fixed PRIMES reward appreciates with the floor, so it eventually
    crosses the cap on its own. `cap_binds_at_floor_price` below is exactly where.
    Past that point the payout must be CLAMPED at claim time to
    `lifetime_cap_ton / p_f` nano-PRIMES -- the same `min(value, stock)` shape the
    era schedule already uses in primes_bounty_vault.tolk, running the other way.
    A backend that pays the nominal PRIMES forever would breach SS5's self-funding
    property somewhere around the sim's second year, silently.

    `target_wallets` is the owner's headcount, and under D-42 it is an INPUT rather
    than a quotient. The reward falls out of `track / target_wallets`.

    What bounds all of this is the vault's GRAM worth, and that is the piece easiest
    to get backwards. The vault is pre-counted into `S` with no `T` behind it, so
    its value at the opening floor is `V * p_f0 = T0 * V / S0` (10/11 of `T0` since
    D-166; `T0 * vault_pct / (1 + vault_pct)` before it deleted the operator lock).
    Raising `vault_pct` DOES raise that value -- D-42's 50% -> 100% takes it from 67
    to 100 GRAM -- and the whole increase is paid for by a lower `p_f0`, the same
    `T0` backing more PRIMES. What no amount of minting can do is push it past `T0`:
    the limit of `pct / (1 + pct)` is 1. A vault-funded growth programme is bounded
    by the founder seed, and at 200 GRAM that bound is the binding one. It is why
    10,000 players cannot each be paid 0.5 GRAM at opening prices -- that is 5,000
    GRAM, twenty-five times the entire founder capital -- and why D-42 buys the
    headcount with time instead of with money.
    """
    p_f0 = e.floor_price_genesis
    track = era_report["remaining_vault_split"]["tracks"]["quests"]
    track_primes = track["primes"]
    track_ton_at_genesis_floor = track_primes * p_f0

    ceiling_ton = beta * 1.0  # beta * MINT_PRICE; MINT_PRICE is 1 GRAM (SS4.1).

    # D-42: the HEADCOUNT is the input. The owner wants the programme to reach
    # 10,000 wallets, and wants that guaranteed rather than hoped for, so it is set
    # here and the per-player reward is the quotient.
    # D-204 (owner, 2026-11-11): 10,000 -> 1,000. Ten times the reward for a tenth
    # of the wallets, first come first served; wallet 1,001 is paid nothing.
    target_wallets = 1_000
    reward_primes = track_primes / target_wallets

    # Where the fixed PRIMES reward grows into the self-funding cap. Below this
    # floor price the nominal reward is payable in full; at and above it the claim
    # must be clamped. NOT a scheduling detail -- it is the SS5 invariant with a
    # date on it.
    cap_binds_at_floor_price = ceiling_ton / reward_primes

    # What the offer is actually worth along the simulated floor path, so the owner
    # can see the shape of the trade rather than being told about it.
    value_track = {
        "at_genesis_floor_ton": reward_primes * p_f0,
        "at_final_floor_ton": reward_primes * e.floor_price,
        "final_floor_price": e.floor_price,
        "floor_multiple_at_horizon": (e.floor_price / p_f0) if p_f0 > 0 else None,
        "_note": (
            "The reward is fixed in PRIMES, so its GRAM value IS the floor path. It "
            "opens small on purpose -- that is the price of guaranteeing the "
            "headcount on day one instead of funding it out of a seed that does not "
            "have the money (D-42)."
        ),
    }

    # SS9.4's social quests. Shares of the per-wallet reward, summing to 1.0 -- so
    # moving the reward moves every quest and no quest can drift out of the cap
    # independently.
    #
    # D-41 deleted `social-invite-minter` and D-42 keeps it deleted. Recruiting is
    # already paid, in GRAM and forever, by SS4.1's 10% referral line, which is
    # funded by the FLOW of mints rather than by this fixed stock -- so a
    # vault-funded bonus on top spends the scarcest budget in the system
    # duplicating the one reward that scales without it.
    #
    # D-118 (owner-signed 2026-09-22): D-73's `connect` quest is a FOURTH share of
    # this same reward, and the four split in equal quarters. The per-player
    # reward, the track and D-40's claim-time clamp are untouched -- only how the
    # board divides moves. The fractions are OWNER-SET, not sim-selected: nothing
    # here measures what one quest is worth against another.
    #
    # D-118 amended 2026-11-20 (owner): SS9.4's `story-verified-reach` is a FIFTH share, and
    # the five split in equal fifths. It was priced off a legacy GRAM figure outside this file
    # (~6,191 PRIMES at the genesis floor), unbudgeted in the track, and the per-wallet voucher
    # cap (audit R2-M2, `reward_nanoprimes`) would have stranded it. Reward, track and
    # headcount are untouched.
    shares = (
        ("social-join-channel", 0.2),
        ("social-join-group", 0.2),
        ("social-stay-7d", 0.2),
        ("connect", 0.2),
        ("story-verified-reach", 0.2),
    )
    assert abs(sum(f for _, f in shares) - 1.0) < 1e-12

    # Split the reward into WHOLE PRIMES by largest remainder, because the payout
    # rail is integral and rounding each share independently is a real overspend:
    # (under the old 30/30/40 split) 30/30/40 of 49 is 14.7/14.7/19.6, which rounds
    # to 15/15/20 = 50, and 50 x 10,000 players is 500,000 against a 490,000 track. The programme would run
    # out 200 players early -- a 2% error that only shows up as the last players
    # being turned away, which is the failure mode the headcount decision exists
    # to prevent.
    assert float(reward_primes).is_integer(), (
        f"per-player reward {reward_primes} is not a whole number of PRIMES; the "
        f"quests track must divide by target_wallets exactly"
    )
    exact = [reward_primes * f for _, f in shares]
    alloc = [int(x) for x in exact]
    remainder = int(round(reward_primes - sum(alloc)))
    # Hand the leftover PRIMES to the largest fractional parts, ties to the larger
    # share -- deterministic, and it puts the rounding where it is least visible.
    order = sorted(range(len(exact)), key=lambda i: (exact[i] - alloc[i], exact[i]), reverse=True)
    for i in order[:remainder]:
        alloc[i] += 1
    assert sum(alloc) == int(reward_primes), (alloc, reward_primes)
    quest_primes = dict(zip((qid for qid, _ in shares), alloc))

    # The track is spent to exhaustion, first come first served (owner, D-42), so
    # this is a real bound on the programme and not a forecast.
    assert abs(reward_primes * target_wallets - track_primes) < 1e-6, (
        "the per-player reward times the headcount must be exactly the track; "
        "otherwise the programme either overspends the vault or strands PRIMES"
    )

    return {
        "_purpose": (
            "SS9.4 social quest rewards. PRIMES-denominated as of D-42, clamped at "
            "claim time to `lifetime_cap_ton / p_f`. Paid from the bounty vault's "
            "`quests` track via the SS9.5 signed voucher, and ONLY after an on-chain "
            "mint is attributed to the wallet (decision 0.2.1)."
        ),
        "denomination": "PRIMES",
        "_denomination_note": (
            "D-42 REVERSES D-41 and DENOMINATION_PLAN P4 for this track only. P4's "
            "argument -- fix the VALUE, because a nominal PRIMES reward inflates "
            "with the floor -- still holds for the era ceremonies, where the point "
            "is that a ceremony is worth a stated amount. It does not hold here, "
            "where the point is that a stated NUMBER OF PLAYERS gets paid. Inflating "
            "with the floor is the feature: it is how a 100 GRAM vault reaches its "
            "headcount at all (10,000 under D-42; 1,000 since D-204)."
        ),
        "target_wallets": target_wallets,
        "_target_wallets_note": (
            "D-42, re-set by D-204 (10,000 -> 1,000): an INPUT, the owner's headcount, and an exact bound rather than a "
            "floor. The track divides into exactly this many equal rewards and is "
            "spent to exhaustion, first come first served."
        ),
        "reward_primes": reward_primes,
        "reward_nanoprimes": int(round(reward_primes * 1e9)),
        "lifetime_cap_ton": ceiling_ton,
        "_lifetime_cap_note": (
            "INVARIANT, not a budget. beta * MINT_PRICE -- the ratchet injection of "
            "the gating mint. A wallet that earned more than this would be paid more "
            "than its own mint contributed to T, and the program would stop being "
            "self-funding. Under D-42's PRIMES denomination this must be enforced at "
            "CLAIM time, not at design time: see cap_binds_at_floor_price."
        ),
        "cap_binds_at_floor_price": cap_binds_at_floor_price,
        "cap_binds_at_floor_multiple": (
            cap_binds_at_floor_price / p_f0 if p_f0 > 0 else None
        ),
        "_cap_binds_note": (
            "Above this floor price the nominal PRIMES reward is worth more than "
            "beta * MINT_PRICE, and the payout MUST be clamped to "
            "`lifetime_cap_ton / p_f` nano-PRIMES. Asserted in backend/attribution "
            "and its tests. A backend that ignores this breaches SS5 silently."
        ),
        "reward_value": value_track,
        "quests_track_primes": track_primes,
        "quests_track_ton_at_genesis_floor": track_ton_at_genesis_floor,
        "beta": beta,
        "vault_ton_ceiling_note": (
            "The whole bounty vault is worth T0 * V / S0 GRAM (10/11 of T0 since D-166) at "
            "the opening floor, because SS3.3 pre-counts it into S with no T behind "
            "it. Raising vault_pct raises that value and pays for it with a lower "
            "p_f0 -- the same T0 backing more PRIMES. It can never exceed T0, so a "
            "vault-funded growth budget is bounded by the founder seed. This is why "
            "10,000 players cannot be paid 0.5 GRAM each at opening prices: that is "
            "5,000 GRAM against a 200 GRAM seed (D-42)."
        ),
        "_rounding_note": (
            "`reward_primes` per quest is a WHOLE number, allocated by largest "
            "remainder so the five sum to exactly `reward_primes` above. Rounding "
            "each share independently can overpay the per-player budget and "
            "exhaust the track before the headcount (D-42)."
        ),
        "_shares_source": (
            "OWNER-SET (DECISIONS.md D-118, 2026-09-22; amended 2026-11-20): equal fifths "
            "across social-join-channel / social-join-group / social-stay-7d / connect / "
            "story-verified-reach. Was equal quarters (the story quest priced in GRAM outside "
            "this file), before that 30/30/40; the reward and the track are unchanged."
        ),
        "rewards": [
            {
                "quest_id": qid,
                "share_of_reward": frac,
                "reward_primes": quest_primes[qid],
                "reward_nanoprimes": quest_primes[qid] * 1_000_000_000,
                "value_at_genesis_floor_ton": quest_primes[qid] * p_f0,
            }
            for qid, frac in shares
        ],
    }


#: G78b / D-171 -- the relative weights of SS9.4's twelve contract-fact quests. OWNER-SET
#: in effect: they are the ratios `backend/attribution/src/quests.ts` carried since EARN_PLAN
#: (prime quests heaviest, SS9.4's "the game's one liveness risk"), kept as weights and no
#: longer as amounts. Nothing here measures what one quest is worth against another.
PRIME_QUEST_WEIGHTS = (
    ("referral-first", 25),
    ("referral-five-active", 100),
    ("referral-first-gift", 25),
    ("recruit-first", 150),
    ("recruit-rank-tier", 100),
    ("recruit-first-mint", 60),
    ("recruit-five-mints", 120),
    ("prime-first", 200),
    ("prime-first-tribute", 150),
    ("prime-rank-tier", 250),
    ("game-first-tribute-claim", 20),
    ("game-first-lot", 20),
)


def _largest_remainder(total: int, weights) -> dict:
    """Whole units summing to exactly `total`, split by `weights` (ties to the heavier)."""
    wsum = sum(w for _, w in weights)
    exact = [total * w / wsum for _, w in weights]
    alloc = [int(x) for x in exact]
    order = sorted(range(len(exact)), key=lambda i: (exact[i] - alloc[i], exact[i]), reverse=True)
    for i in order[: total - sum(alloc)]:
        alloc[i] += 1
    assert sum(alloc) == total, (alloc, total)
    return dict(zip((q for q, _ in weights), alloc))


def prime_quest_reward_report(e: Engine, era_report: dict, social: dict) -> dict:
    """G78b / D-171 -- SS9.4's contract-fact quests (referral, recruit, prime, game), paid
    from the vault's `prime_quests` track through the PQST voucher.

    Sized exactly as D-42 sizes the social board, because the track is the same kind of
    stock: PRIMES fixed at genesis, divided by the owner's headcount (the same 1,000, D-204), the
    per-wallet reward split across the twelve quests by `PRIME_QUEST_WEIGHTS`. Before this
    the twelve were hardcoded GRAM amounts summing to 1.02 GRAM per wallet -- above the
    0.46 GRAM self-funding ceiling on their own, and enough to exhaust the track after ~9
    wallets -- and nothing paid them.

    ONE CEILING, BOTH BOARDS. `lifetime_cap_ton` bounds everything one wallet earns from
    vault-paid quests. Two boards each clamped to the whole cap would pay up to twice it,
    so every PRIMES-denominated row -- social and contract alike -- carries `share_of_cap`,
    its reward over the combined per-wallet total, and the backend clamps each row to its
    share. Mutates `social["rewards"]` to add that field.
    """
    p_f0 = e.floor_price_genesis
    track_primes = era_report["remaining_vault_split"]["tracks"]["prime_quests"]["primes"]
    target_wallets = social["target_wallets"]
    reward_primes = track_primes / target_wallets
    assert float(reward_primes).is_integer(), (
        f"per-wallet contract-quest reward {reward_primes} is not whole; prime_quests must "
        f"divide by target_wallets exactly"
    )
    alloc = _largest_remainder(int(reward_primes), PRIME_QUEST_WEIGHTS)
    combined = social["reward_primes"] + reward_primes
    for row in social["rewards"]:
        row["share_of_cap"] = row["reward_primes"] / combined
    cap_ton = social["lifetime_cap_ton"]
    return {
        "_purpose": (
            "SS9.4's contract-fact quests (referral, recruit, prime, game). PRIMES-denominated, "
            "paid from the vault's `prime_quests` track through the PQST voucher (D-171) after "
            "an on-chain mint, clamped at claim time with the social board under ONE "
            "`lifetime_cap_ton` (each row's `share_of_cap`)."
        ),
        "denomination": "PRIMES",
        "target_wallets": target_wallets,
        "reward_primes": reward_primes,
        "prime_quests_track_primes": track_primes,
        "combined_reward_primes": combined,
        "combined_cap_binds_at_floor_price": cap_ton / combined,
        "combined_cap_binds_at_floor_multiple": (cap_ton / combined) / p_f0 if p_f0 > 0 else None,
        "_shares_source": (
            "PRIME_QUEST_WEIGHTS in sim/scripts/run_phase1.py: the ratios quests.ts carried as "
            "GRAM amounts since EARN_PLAN, kept as weights (G78b)."
        ),
        "rewards": [
            {
                "quest_id": qid,
                "reward_primes": alloc[qid],
                "reward_nanoprimes": alloc[qid] * 1_000_000_000,
                "share_of_cap": alloc[qid] / combined,
                "value_at_genesis_floor_ton": alloc[qid] * p_f0,
            }
            for qid, _ in PRIME_QUEST_WEIGHTS
        ],
    }


# --------------------------------------------------------------------------- #
# DECISIONS.md D-100 as amended by D-168 -- the governed treasury (LP = vote
# only), PRIMES staking paid from the treasury vest, and the vest split.
#
# The helpers below emit DISCLOSURE / GOVERNANCE figures beside exactly one
# sim-SELECTED number (`staking.distribution_rate_bps_per_day`). CLAUDE.md rule 3
# requires the distinction to be visible in the file itself, not inferred, so
# every `_source` string they write says which of the three a figure is:
#
#   OWNER-SET      the owner decided it (D-100 / D-147 / D-168); the sim records
#                  it and does not get a vote (terms, weights, vote multipliers,
#                  the caps, the epoch, the vest).
#   OWNER-PROPOSED the owner set an opening value and asked the sim to VALIDATE
#                  it. The sim reports pass/fail and its reasoning; it does NOT
#                  silently substitute its own ladder.
#   SIM-SELECTED   the sim chose it against a stated criterion (`P`).
# --------------------------------------------------------------------------- #

# D-147 LOCK TERMS measured from the deposit, cut to the four that vote by D-168
# (Q13): the no-lock / 1 d / 7 d rungs neither voted nor, once the miner is gone,
# earned anything, so they are deleted. PRIMES staking (Q8) offers the same four.
TIER_TERM_SECONDS = [2_592_000, 7_776_000, 15_552_000, 31_536_000]
TIER_LABELS = ["30 d", "3 m", "6 m", "1 y"]
# D-100 point 9 as extended by D-147, owner-set: governance, not economics. Every
# remaining LP rung votes, LIVE ONLY WHILE THE TERM RUNS.
VOTE_MULTIPLIERS = [1, 3, 10, 30]
# D-214, owner-set 2026-11-23: what LP locked forever through a position votes
# with. Not a tier -- it has no term -- so not an entry of VOTE_MULTIPLIERS.
FOREVER_VOTE_MULTIPLIER = 100
# D-168 (Q8), owner-set: the stake weights are the old LP mining ladder's top
# four rungs (D-147's `2 + i` at i = 3..6), carried to PRIMES staking unchanged.
STAKE_TIER_WEIGHTS = [5, 6, 7, 8]
# D-168 (Q6), owner-set: `distribute()` runs at most once per 30 days -- the same
# interval as the ratchet's `harvest()` (D-151 point 4, `staked_reserve.
# harvest_interval_seconds`), so the UI can present both as one monthly beat.
STAKE_EPOCH_SECONDS = 2_592_000
# D-100 point 5's target, re-stated for stakers by D-168 (Q12): the share of the
# treasury's free PRIMES paid out over one year. This is the CRITERION `P` is
# solved from -- stated first, so the rate is derived rather than a round number
# with a reason back-filled onto it. See `_distribution_rate_bps_per_day`.
DISTRIBUTION_FIRST_YEAR_PAYOUT_SHARE = 0.50
# D-100 point 6: the vest is 4 x 25% over 270 days, unchanged, but split into two
# instances. Mirrored as VEST_TRANCHES / VEST_INTERVAL in
# contracts/contracts/primes_vesting.tolk, which is where they are enforced.
VEST_TRANCHES = 4
VEST_INTERVAL_SECONDS = 7_776_000


def _distribution_rate_bps_per_day():
    """SIM-SELECTED `P` (D-100 point 5, re-stated for stakers by D-168 Q12).

    `distribute()` sends `budget = free * P * epoch / 86400` PRIMES per 30-day
    epoch -- a fraction of a BALANCE, not a fixed emission. Two consequences:

      * **The treasury never empties.** With no inflow the balance decays
        geometrically and is strictly positive for every finite `t`; the payout
        shrinks with the pot instead of stopping.
      * **`P` is a HALF-LIFE knob, not an amount.** Solving
        `1 - (1 - P)^365 = share` for the target first-year payout share gives
        `P = 1 - (1 - share)^(1/365)`.

    The criterion, stated before the number: **stakers are paid half of the
    treasury's free PRIMES in the first year.** The treasury's PRIMES funding is
    its 1,000,000-PRIMES vest (D-100 point 6, four tranches over 270 days), so a
    one-year half-life pays out roughly as fast as the vest funds it. D-168
    moves the whole vest from the (deleted) LP miner to stakers and keeps the
    derivation: the rate is solved per day, as it always was, and the contract
    applies it per epoch -- `realised_first_year_payout_share_epoch_rule` shows
    what that does to the first-year share, rather than re-solving against it
    (Q12 fixes the daily figure).

    Returns `(bps_rounded, exact_bps, realised_first_year_share)` -- the emitted
    value is the WHOLE basis point, because the contract stores bps.
    """
    exact = 1.0 - (1.0 - DISTRIBUTION_FIRST_YEAR_PAYOUT_SHARE) ** (1.0 / 365.0)
    bps = int(round(exact * 10_000.0))
    realised = 1.0 - (1.0 - bps / 10_000.0) ** 365.0
    return bps, exact * 10_000.0, realised


def _validate_stake_weights():
    """Does the owner's stake ladder price a LOCK TERM? (D-168, Q8.)

    Two checks, stated before the numbers:

      * **C1 monotone.** A longer term never earns less.
      * **C2 diminishing marginal weight per locked day.** The first month of
        illiquidity is worth more than the eleventh, and a ladder that pays a
        flat or rising price per day herds everyone into the longest rung.

    D-147's free-ride bound and its "vote spread > mining spread" test are
    DELETED, not re-checked: the first existed because a matured LP position
    kept mining forever, and D-168 stops earning at `maturesAt`; the second
    compared the LP vote ladder against an LP mining ladder that no longer
    exists.
    """
    w = STAKE_TIER_WEIGHTS
    d = [s / 86_400.0 for s in TIER_TERM_SECONDS]
    monotone = all(w[i + 1] > w[i] for i in range(len(w) - 1))
    steps = []
    for i in range(len(w) - 1):
        extra_days = d[i + 1] - d[i]
        steps.append({
            "from": TIER_LABELS[i],
            "to": TIER_LABELS[i + 1],
            "extra_weight": w[i + 1] - w[i],
            "extra_days": extra_days,
            "weight_per_extra_day": round((w[i + 1] - w[i]) / extra_days, 6),
        })
    marginal = [s["weight_per_extra_day"] for s in steps]
    diminishing = all(marginal[i + 1] < marginal[i] for i in range(len(marginal) - 1))
    return {
        "monotone": monotone,
        "marginal_weight_per_locked_day_diminishing": diminishing,
        "verdict": "PASS" if (monotone and diminishing) else "FAIL",
        "steps": steps,
        "longest_over_shortest": round(w[-1] / w[0], 4),
        "_longest_over_shortest_note": (
            "Earning stops at `maturesAt` and `relock` restarts it, so a 30 d "
            "staker who relocks every month earns at weight %(w0)g continuously; "
            "`longest_over_shortest` is therefore the whole premium a one-year "
            "lock buys over rolling the shortest term, for as long as both are "
            "served -- not a multiple bought once and kept."
            % {"w0": w[0]}
        ),
        "_not_substituted": (
            "D-168 sets these weights as the owner's ladder and asks the sim to "
            "validate them. A failing ladder is reported as FAIL with its reason "
            "and the owner picks the next one (CLAUDE.md rule 3)."
        ),
    }


def _lp_depth_without_miner(e, e_real_pair):
    """STAKING_PLAN.md SS3.3's mandatory risk report: the LP miner existed to pay
    for DeDust depth, which `flush()` (CONCEPT.md SS4.3.1) swaps against. What
    does the flush look like with the miner removed?

    The measured answer has two halves:

      1. **The sim never credited the miner with any depth.** The modelled pool
         is seeded once at genesis and afterwards moves only by swaps (flush
         buys, rebate sellers, the sandwicher); no code path adds liquidity for
         any reason, miner or otherwise. Every flush figure in this file was
         therefore ALREADY measured with zero miner-funded depth, and deleting
         the miner moves none of them.
      2. **The unfunded floor.** With nobody paid to add LP, the depth that is
         certain to exist is the operator's genesis pair (D-140/D-154:
         `L * X` PRIMES against `L * X^2 / S0` GRAM, priced at `p_f0`). The same
         three-year run is repeated with the pool seeded at exactly that pair
         -- GAUNTLET.md X14's override -- so the flush is measured at the depth
         a miner-less market is guaranteed, not at the 200 GRAM nominal.

    "The band" is SS4.3.1's: the flush fills only at or below `p_f`, so it
    defends `x = 1` and nothing above it. It can still defend it when, at the
    worst sampled detachment, `pending` covers the GRAM needed to lift the pool
    back to the floor.
    """
    def row(run, pool_ton0, pool_primes0):
        cap = an.guard_can_close_detachment(run)
        det = an.amm_vs_floor_detachment(run)
        fills = run.flush_fills
        mean_fill = run.swapped / fills if fills else 0.0
        return {
            "pool_ton_at_genesis": pool_ton0,
            "pool_primes_at_genesis": pool_primes0,
            "pool_ton_at_horizon": run.pool.ton_reserve,
            "flush_attempts": run.flush_attempts,
            "flush_fills": fills,
            "fill_rate": (fills / run.flush_attempts) if run.flush_attempts else None,
            "swapped_ton": run.swapped,
            "mean_fill_ton": mean_fill,
            # Price impact of the mean tranche on the pool it started from: the
            # fraction by which a constant-product swap of `a` GRAM into `R_t`
            # moves the spot price is `(1 + a/R_t)^2 - 1`.
            "mean_fill_price_impact_at_genesis_depth": (
                (1.0 + mean_fill / pool_ton0) ** 2 - 1.0 if pool_ton0 > 0 else None
            ),
            "fraction_of_samples_below_floor": det["fraction_of_samples_below_floor"],
            "approx_max_consecutive_days_below_floor": det["approx_max_consecutive_days_below_floor"],
            "worst_detachment_ton_needed_to_close": cap.get("ton_needed_to_close_ton"),
            "worst_detachment_pending_available_ton": cap.get("pending_available_ton"),
            "coverage_x": cap.get("coverage_x"),
            "flush_can_defend_band": bool(cap["balance_sufficient"]),
            "final_floor_price": run.floor_price,
        }

    base = row(e, e.p.genesis_seed_ton, e.p.genesis_seed_ton * e.p.genesis_lp_primes_per_ton)
    real = row(e_real_pair, e_real_pair.p.modelled_pool_ton, e_real_pair.p.modelled_pool_primes)
    ok = base["flush_can_defend_band"] and real["flush_can_defend_band"]
    return {
        "_source": (
            "sim/scripts/run_phase1.py _lp_depth_without_miner, seed=%d. STAKING_PLAN.md "
            "SS3.3 / D-168 risk report. MEASURED, not selected: nothing here is a parameter."
            % SEED
        ),
        "miner_modelled_depth_contribution_ton": 0.0,
        "_miner_never_modelled": (
            "The engine's DeDust pool is seeded at genesis and moves only by swaps; "
            "no path adds liquidity. The deleted LP miner was never credited with "
            "depth, so `modelled_pool_nominal` below IS the miner-less flush and every "
            "`flush` / `floor_guard_capacity` figure elsewhere in this file is unchanged "
            "by D-168. What the miner could have bought -- external LP drawn in by a "
            "PRIMES yield -- was an unmodelled upside, and deleting it removes an "
            "assumption nobody had made."
        ),
        "band_defended": "x = 1: SS4.3.1's floor guard fills only at or below p_f",
        "modelled_pool_nominal": base,
        "operator_genesis_pair_only": real,
        "_operator_genesis_pair_only_note": (
            "The same run with the pool seeded at the operator's D-154 pair "
            "(L*X PRIMES against L*X^2/S0 GRAM, priced at p_f0) -- the only depth that "
            "exists when nobody is paid to add LP."
        ),
        "verdict": "FLUSH DEFENDS ITS BAND" if ok else "FLUSH CANNOT DEFEND ITS BAND -- ESCALATE",
        "_verdict_reasoning": (
            "A thinner pool makes the floor CHEAPER to defend, not dearer: lifting a "
            "constant-product pool back to p_f costs `sqrt(k * p_f) - R_t` GRAM, which "
            "shrinks with depth, while `pending` is set by mint volume and does not. "
            "What thin depth costs is fill SIZE -- `max_in_at_floor` shrinks with the "
            "pool, so tranches are smaller and more of `pending` waits as the "
            "protocol's standing bid (it counts in T either way, SS5) -- and sandwich "
            "exposure, which the guard caps at `p_f` but does not zero (D-190: an "
            "attacker who sizes the flush after its pump still takes burn efficiency "
            "while the market is under the floor; X14: the unguarded "
            "control goes to ~100%% extracted at the real pair, so the guard is MORE "
            "load-bearing there). Coverage at the worst detachment: %s at the nominal "
            "pool, %s at the operator pair."
            % (
                ("%.1fx" % base["coverage_x"]) if base["coverage_x"] else "no detachment",
                ("%.1fx" % real["coverage_x"]) if real["coverage_x"] else "no detachment",
            )
        ),
    }


def _staking_block(e, lp_depth):
    """DECISIONS.md D-168 -- PRIMES staking paid from the treasury vest.

    Nothing here is minted and nothing touches `S`, `T`, `pending` or `owed`:
    `distribute()` moves PRIMES the treasury already holds to the stake
    contract, which streams them to stakers pro rata to `amount * weight`.
    """
    p_bps, p_exact, realised_share = _distribution_rate_bps_per_day()
    epoch_days = STAKE_EPOCH_SECONDS / 86_400.0
    per_epoch = p_bps * STAKE_EPOCH_SECONDS / (10_000.0 * 86_400.0)
    epochs_per_year = 365.0 / epoch_days
    return {
        "_source": (
            "DECISIONS.md D-168 (STAKING_PLAN.md SS2/SS3.3). WHICH FIGURES ARE WHOSE "
            "(CLAUDE.md rule 3): `epoch_seconds` OWNER-SET (Q6 -- the ratchet's "
            "`harvest_interval_seconds`, one monthly beat); `tier_term_seconds` "
            "OWNER-SET (Q8 -- the four LP lock terms); `tier_weights` OWNER-SET "
            "(Q8 -- the old LP mining ladder's top four rungs, validated in "
            "`tier_weight_validation`, not substituted); `acc_scale` an ENGINEERING "
            "constant (moved from `treasury`); `distribution_rate_bps_per_day` "
            "SIM-SELECTED -- the only figure in this block the sim chooses, solved "
            "from the stated criterion in `distribution_rate_selection`."
        ),
        "epoch_seconds": STAKE_EPOCH_SECONDS,
        "tier_term_seconds": TIER_TERM_SECONDS,
        "tier_labels": TIER_LABELS,
        "tier_weights": STAKE_TIER_WEIGHTS,
        "tier_weight_validation": _validate_stake_weights(),
        "distribution_rate_bps_per_day": p_bps,
        "distribution_rate_selection": {
            "criterion": (
                "Pay stakers %.0f%% of the treasury's free PRIMES in the first year, "
                "so the pot pays out at roughly the pace the treasury's "
                "1,000,000-PRIMES vest funds it (four tranches over 270 days). Stated "
                "BEFORE the number: `P = 1 - (1 - share)^(1/365)`."
                % (DISTRIBUTION_FIRST_YEAR_PAYOUT_SHARE * 100.0)
            ),
            "exact_bps_per_day": round(p_exact, 6),
            "emitted_bps_per_day": p_bps,
            "realised_first_year_payout_share": round(realised_share, 6),
            "budget_share_of_free_per_epoch": round(per_epoch, 6),
            "realised_first_year_payout_share_epoch_rule": round(
                1.0 - (1.0 - per_epoch) ** epochs_per_year, 6
            ),
            "_epoch_rule": (
                "A permissionless `distribute()`, at most once per `epoch_seconds`, "
                "sends `budget = free * rate * epoch / (10000 * 86400)` PRIMES to the "
                "stake contract, which streams it linearly over the next epoch. "
                "`free` is the treasury's whole PRIMES balance -- nothing accrues "
                "inside the treasury any more."
            ),
            "_never_empties": (
                "`budget = P * free` is a fraction of a BALANCE, so the pot decays "
                "geometrically and is positive for every finite t. There is no "
                "schedule to exhaust and no 'the rewards stopped' state -- the payout "
                "shrinks with the pot. Every inflow (a forfeit, a PRIMES donation, the "
                "next vest tranche) lifts the trajectory from that epoch forward. A "
                "rule that cannot drain the treasury does not need a vote to "
                "authorise it (D-100 point 5)."
            ),
        },
        "acc_scale": 2 ** 64,
        "_acc_scale_note": (
            "Fixed-point scale of the stake contract's reward-per-weight "
            "accumulator: `acc += amt * ACC_SCALE / totalWeight`, and a position's "
            "claim is `weight * acc / ACC_SCALE - rewardDebt`. 2^64 against Tolk's "
            "native 257-bit integers leaves the operands bounded well under 2^120. "
            "It is an ENGINEERING constant, not an economic parameter -- it is here "
            "because three codebases must agree on it, not because a sim picked it."
        ),
        "lp_depth_without_miner": lp_depth,
    }


def _treasury_block(e):
    """DECISIONS.md D-100 points 4, 8 and 9 as amended by D-147 and D-168 -- one
    definition of every figure the treasury contract, its wrapper, the backend
    and the webapp read. Governance only: D-168 deletes the LP miner, so LP
    custody buys a vote and nothing else, and no figure here is sim-selected.
    """
    return {
        "_source": (
            "DECISIONS.md D-100 (SIGNED 2026-09-04) points 4, 8 and 9, as amended by "
            "D-147 and D-168. LP = VOTE ONLY: D-168 deletes the LP miner (its rate, "
            "weights and accumulator scale move to the top-level `staking` block, "
            "which pays PRIMES stakers from the same vest). WHICH FIGURES ARE WHOSE "
            "(CLAUDE.md rule 3): every figure here is OWNER-SET -- "
            "`tier_term_seconds` (D-147's lock terms from the deposit, cut to the "
            "four that vote by D-168 Q13); `vote_multipliers` (point 9 as extended by "
            "D-147 -- governance, not economics, LIVE ONLY WHILE THE TERM RUNS); "
            "`proposal_cap_bps` and `propose_min_bps` (point 8 -- 25% of the asset's "
            "balance at EXECUTE time, and >= 1% of eligible weighted LP to propose). "
            "The sim selects nothing in this block."
        ),
        "tier_term_seconds": TIER_TERM_SECONDS,
        "tier_labels": TIER_LABELS,
        "vote_multipliers": VOTE_MULTIPLIERS,
        "vote_eligible_min_tier_index": 0,
        "forever_vote_multiplier": FOREVER_VOTE_MULTIPLIER,
        "_forever_note": (
            "DECISIONS.md D-214, OWNER-SET 2026-11-23 (chosen over 60 and 300): LP "
            "locked forever through a position's `to_sink` keeps voting as ONE "
            "per-wallet total on the child, weighted `amount * "
            "forever_vote_multiplier`, never maturing -- the ladder's ~3x step past "
            "the 1-year term's 30. NOT a tier (no term, no deposit, no relock), so "
            "it is not an entry of `vote_multipliers`. It counts in "
            "`eligibleWeight` and so in the 1% propose bar (owner-accepted). Every "
            "credit restamps the total's `weightSince`. LP sent to the sink any "
            "other way, the genesis seed included, carries no vote."
        ),
        "_vote_note": (
            "D-100 point 9 as amended by D-147 and D-168: the electorate is LP "
            "custody whose TERM IS STILL RUNNING, weighted `amount * voteMultiplier`; "
            "every remaining tier votes, so `vote_eligible_min_tier_index` is 0. A "
            "MATURED position loses its vote and earns nothing -- D-168 deletes the "
            "miner, so LP custody buys voice and nothing else. Vote weight is a pure "
            "function of (amount, tier, now) -- no snapshot, no oracle, no `p_f` read. "
            "Point 10a is accepted in writing: on day one the electorate is the "
            "operator alone."
        ),
        "proposal_cap_bps": 2500,
        "propose_min_bps": 100,
        "vote_duration_seconds": 86_400,
        "notice_duration_seconds": 86_400,
        "_notice_note": (
            "OWNER-SET 2026-11-19 (chosen over 3, 7 and 30 days), DECISIONS.md "
            "D-173 amendment (audit R2-H1; option A, a notice period, chosen over a"
            " quorum). A proposal is public for `notice_duration_seconds` before "
            "its vote opens: `opens = proposed + notice`, `closes = opens + "
            "vote_duration_seconds`. LP locked during the notice votes NO (a YES "
            "needs LP held since the proposal, D-173 2026-11-21); LP locked "
            "once the vote is open does not (1202). A SEPARATE parameter from "
            "`vote_duration_seconds` -- that the two are equal is a coincidence of "
            "the chosen value. Divided by the D-139 clock divisor like the vote "
            "length. Published by `getGov().noticeDuration`."
        ),
        "_governance_note": (
            "D-100 point 8 as amended by D-167, D-194 and D-173's 2026-11-19 "
            "and 2026-11-21 amendments: a proposal transfers {GRAM | PRIMES | tsTON} to an address "
            "(LP is NOT proposable, D-167) or confirms a queued venue change "
            "(D-194, moves no value). A transfer is capped at `proposal_cap_bps` of"
            " THAT asset's balance at EXECUTE time, not at propose time. One open "
            "proposal per proposer, no fee. A proposal is public for "
            "`notice_duration_seconds` before its vote opens; the vote then lasts "
            "`vote_duration_seconds`, simple majority of votes cast, NO QUORUM. "
            "Execute is permissionless after close for one more vote length, and a "
            "bounced execute is re-executable. Point 10b is accepted in writing: "
            "with no quorum a single 30-day locker passes a proposal unless someone"
            " with more weight votes no. No standing operator position exists "
            "(D-166), so the defences are rules: the 25% cap, the notice plus the "
            "vote (two days in total, not per proposal -- D-130), and the 1% "
            "proposer threshold. The notice makes a proposal opposable by LP locked"
            " during it, which may vote no; a yes needs LP held since the proposal "
            "was made (D-173's 2026-11-21 amendment), so the opposition moves last."
        ),
    }


def _vesting_block(e):
    """DECISIONS.md D-166, amending D-100 point 6 (which amended D-91 point 2,
    D-77 point 2 and D-46 points 1 and 3).

    A DISCLOSURE SCHEDULE, NOT a simulation output: nothing in the ratchet, the
    split or sim/ reads these numbers, and no economic quantity is derived from
    them. They are recorded here so the deploy script and the UI read one
    definition instead of two literals. CLAUDE.md rule 3 is not engaged -- there
    is no sim run behind this and there should not be. Mirrored as VEST_TRANCHES /
    VEST_INTERVAL in contracts/contracts/primes_vesting.tolk, which is where they
    are enforced.

    ONE INSTANCE. D-100 point 6 split the vest into two instances of the same
    `primes_vesting.tolk`, 1,000,000 PRIMES each to the operator and to the
    treasury contract. D-166 DELETES the operator's instance: the operator buys
    PRIMES by minting at the head like any player, which makes CONCEPT.md SS2
    principle 4 ("team takes fees, never supply") absolute. The treasury's lock
    is unchanged -- same total, same 4 x 25% / 270-day schedule, same contract --
    and its beneficiary has no key (D-100 point 7): it spends only by a passed
    proposal or D-168's `distribute()` rule.
    """
    allocation = e.genesis_supply_primes - e.bounty_vault_initial

    return {
        "_source": (
            "DECISIONS.md D-166, amending D-100 point 6 (which amended D-91 point 2, "
            "D-77 point 2 and D-46 points 1 and 3). A DISCLOSURE SCHEDULE, NOT a "
            "simulation output: nothing in the ratchet, the split or sim/ reads these "
            "numbers, and no economic quantity is derived from them. Mirrored as "
            "VEST_TRANCHES / VEST_INTERVAL in contracts/contracts/primes_vesting.tolk, "
            "which is where they are enforced. ONE instance since D-166: the "
            "operator's 1,000,000-PRIMES lock is deleted, the treasury's is unchanged."
        ),
        "total_allocation_primes": allocation,
        "instances": 1,
        "tranches": VEST_TRANCHES,
        "interval_seconds": VEST_INTERVAL_SECONDS,
        "interval_days": VEST_INTERVAL_SECONDS // 86_400,
        "total_days": (VEST_TRANCHES - 1) * (VEST_INTERVAL_SECONDS // 86_400),
        "treasury": {
            "beneficiary": "`primes_treasury.tolk` (the governed treasury contract)",
            "total_primes": allocation,
            "tranches": VEST_TRANCHES,
            "interval_seconds": VEST_INTERVAL_SECONDS,
            "interval_days": VEST_INTERVAL_SECONDS // 86_400,
            "total_days": (VEST_TRANCHES - 1) * (VEST_INTERVAL_SECONDS // 86_400),
            "genesis_tranche_primes": allocation / VEST_TRANCHES,
            "genesis_tranche_pct_of_s0": (
                (allocation / VEST_TRANCHES) / e.genesis_supply_primes * 100.0
            ),
            "_why": (
                "D-100 point 6. This lock is what makes the treasury a pot worth "
                "governing at all: it is the PRIMES D-168's `distribute()` pays "
                "stakers out of, and the PRIMES a D-100 point 8 proposal can "
                "transfer. It has no key -- the beneficiary is a contract with no "
                "owner, no admin opcode, no upgrade and no pause (point 7) -- so "
                "nothing the operator can sign moves it."
            ),
        },
        "_release_rule": (
            "Release is a TARGET, total_amount * unlocked / tranches, and a call "
            "transfers the difference against what has already gone out -- never a "
            "fixed per-tranche amount. Intermediate targets truncate; the final one "
            "is exact (total * 4 / 4), so the last tranche absorbs every remainder "
            "and the lock always empties. 1,000,000 * 10^9 divides by 4 exactly, so "
            "no tranche truncates at THIS allocation; the target form stays because "
            "it is what makes catch-up one message and what keeps the lock exact "
            "for any total_amount a future deployment declares."
        ),
        "_invariant": (
            "The lock touches NO economic state. S counted the whole allocation at "
            "genesis (SS3.3) and does not move; T never saw it. p_f = T/S is "
            "identical with and without this contract -- the vest changes who can "
            "sell and when, never anybody's floor."
        ),
    }


def invite_line_report(e, up) -> dict:
    """`invites` -- SS4.1's SEVENTH line, and the beta table re-derived with it
    (TELEGRAM_INVITES_PLAN.md, owner 2026-11-07; it replaced D-101's generators).

    Nothing here is a parameter this script chose. There are exactly three inputs
    and each carries its own provenance in the emitted block:

      * `transfer_value_ton` = 0.1 is OWNER-SET: one plain non-bounceable transfer
        with the ledger's fixed comment, per recipient;
      * `max_count` = 3 is OWNER-SET, not derived;
      * `optin_rate_assumed` = 1.0 is ASSUMED and says so -- no invited mint has
        ever been made, so there is no rate to measure. It is an input to a
        scenario, never an output of one.

    What the sim actually DERIVES is the arithmetic on top: beta at count 0, beta
    at the full count, the cohort mean at the assumed opt-in rate, and the check
    that the ratchet theorem still holds at the smaller beta.

    The `k < 1` check is run numerically rather than asserted, at the WORST k the
    uplift stack can produce -- both rank ladders maxed and both windows open, so
    the summed uplifts hit the single `K_CEIL` clamp. For each count it verifies
    that emitted value `k*I` stays strictly below the injection `I`, that the
    emission and the injection shrink in the SAME ratio (so the rebate does not
    lag the injection at a reduced beta), and that `(T+I)/(S+kI/p_f) > p_f` at
    this run's own final `T` and `S`. `K_CEIL` is a clamp on the summed uplifts
    and is not a function of beta, so none of this can move it -- which is the
    point of measuring rather than asserting.
    """
    P = 1.0  # SS4: the flat all-in mint price the table is stated for
    sp = e.p.split
    rows = []
    # D-106 collapsed this from EIGHT rows to FOUR. The four that went were the
    # patron line's phi1/phi2 x (referred, unreferred) corners; what is left is
    # (prime | composite) x (referred | not), which is the whole of SS4.1's
    # spread now that the only conditional lines are the referral and the invite.
    for label, is_prime, referred in (
        ("composite, referred", False, True),
        ("composite, unreferred", False, False),
        ("prime, referred", True, True),
        ("prime, unreferred", True, False),
    ):
        b0 = econ.beta(is_prime, referred, sp, 0, P)
        b5 = econ.beta(is_prime, referred, sp, econ.INVITE_MAX_COUNT, P)
        bx = econ.beta_expected(is_prime, referred, sp,
                                econ.INVITE_MAX_COUNT,
                                econ.INVITE_OPTIN_RATE_ASSUMED, P)
        rows.append({
            "row": label,
            "is_prime_mint": is_prime,
            "referred": referred,
            "beta_no_invite": b0,
            "beta_full_invite": b5,
            "beta_expected_at_assumed_optin": bx,
            "delta_full_invite": b5 - b0,
            # D-215: the floor no operator-set terms can push it under.
            "beta_at_line_cap": econ.beta_at_line_cap(is_prime, referred, sp, P),
        })

    worst = min(rows, key=lambda r: r["beta_full_invite"])

    # The HORIZON, measured. This used to be `_horizon_not_simulated`: the engine
    # had no invite field, `Engine._do_mint` called `split_mint` without
    # `invite_count`, and every mint in the three-year run behind every other
    # block in this file split at the uninvited beta while this block published
    # an 0.80 opt-in rate. `SimParams.invite_optin_rate` closed that
    # (CONSTELLATIONS_PLAN.md phase 1 item 1); what follows is read off the run's
    # own mint log, not projected.
    horizon_mints = len(e.mint_log)
    invited_mints = sum(1 for ev in e.mint_log if ev.invite_count > 0)
    slots = sum(ev.invite_count for ev in e.mint_log)
    ton_deducted = slots * (econ.INVITE_TRANSFER_VALUE_TON + econ.INVITE_SEND_FEE_TON)
    # NOT a beta: `pool_injection` is `beta * price`, so this is GRAM, and it
    # only coincides with mean beta because every mint in this run prices at
    # exactly MINT_PRICE = 1 GRAM (the Dutch lane's premium is credited to
    # `pending` separately and never passes through `pool_injection`). Named for
    # what it measures so the key does not silently mislabel itself if a lane
    # ever routes a residual at another price.
    mean_injection_ton = (sum(ev.pool_injection for ev in e.mint_log) / horizon_mints
                          if horizon_mints else None)
    line_at_optin = (econ.INVITE_OPTIN_RATE_ASSUMED * econ.INVITE_MAX_COUNT
                     * (econ.INVITE_TRANSFER_VALUE_TON + econ.INVITE_SEND_FEE_TON))
    simulated = {
        "optin_rate_drawn": e.p.invite_optin_rate,
        "optin_rate_realised": (invited_mints / horizon_mints) if horizon_mints else None,
        "simulated_mints": horizon_mints,
        "invited_mints": invited_mints,
        "invite_slots_deployed": slots,
        "ton_deducted_over_the_horizon": ton_deducted,
        "mean_line_ton_per_mint": (ton_deducted / horizon_mints) if horizon_mints else None,
        "expected_line_ton_per_mint_at_assumed_optin": line_at_optin,
        "mean_pool_injection_ton_measured": mean_injection_ton,
        "final_T_ton": e.T,
        "share_of_final_T": (ton_deducted / e.T) if e.T else None,
        "_note": (
            "THE HORIZON IS SIMULATED UNDER THE INVITE LINE. `SimParams."
            "invite_optin_rate` is drawn per mint as a Bernoulli at "
            "`optin_rate_drawn`, all-or-nothing at `max_count` (the checkout fills "
            "all 3 recipients or the mint sends none, so a count sampled over 0..3 "
            "would model a control that does not exist), from a DEDICATED RNG stream -- so a run "
            "with the line off shares this one's realised history exactly, mint for "
            "mint, and only the money differs. `optin_rate_realised` is the share "
            "the draw actually produced and is a measurement; "
            "`optin_rate_drawn` is the ASSUMPTION it was drawn from and is not. "
            "`ton_deducted_over_the_horizon` is the summed seventh line over the "
            "run, and it is GRAM that left the residual -- so `final_state`, the "
            "floor appreciation, the kill criteria and the genesis blocks are now "
            "measured WITH the line, not above it. "
            "`mean_pool_injection_ton_measured` is the mean residual in GRAM, not a "
            "rate: it equals mean beta only because every mint in this run prices "
            "at MINT_PRICE = 1 GRAM, which is why it is comparable against "
            "`beta_table`'s rows at all."
        ),
        "_source": (
            "MEASURED over this run's own mint log, except "
            "`optin_rate_drawn` / `expected_line_ton_per_mint_at_assumed_optin`, "
            "which restate the assumption: " + econ.INVITE_OPTIN_RATE_LABEL
        ),
    }

    # Worst-case k: every uplift live at once, clamped by K_CEIL.
    k_worst = min(up.k_ceil,
                  e.p.k_max_cap + up.prime_uplift + up.newcomer_uplift
                  + max(up.recruit_rank_uplifts) + max(up.prime_rank_uplifts))
    p_f = e.floor_price
    counts = []
    b_base = worst["beta_no_invite"]
    i_base = b_base * P
    r_base = econ.rebate_primes(i_base, k_worst, p_f)
    for c in range(econ.INVITE_MAX_COUNT + 1):
        b = econ.beta(worst["is_prime_mint"], worst["referred"], sp, c, P)
        inj = b * P
        emitted = econ.rebate_primes(inj, k_worst, p_f)
        counts.append({
            "invite_count": c,
            "beta": b,
            "injection_ton": inj,
            "emitted_primes": emitted,
            "emitted_value_ton": emitted * p_f,
            "emitted_value_below_injection": bool(emitted * p_f < inj),
            "emission_ratio_to_count_0": (emitted / r_base) if r_base else None,
            "injection_ratio_to_count_0": (inj / i_base) if i_base else None,
            "floor_after": (e.T + inj) / (e.S + emitted),
            "floor_rises": bool((e.T + inj) / (e.S + emitted) > p_f),
        })

    # D-215: the same check at the line cap, the worst any operator terms can reach.
    b_cap = econ.beta_at_line_cap(worst["is_prime_mint"], worst["referred"], sp, P)
    inj_cap = b_cap * P
    emitted_cap = econ.rebate_primes(inj_cap, k_worst, p_f)
    at_cap = {
        "line_ton": econ.INVITE_LINE_CAP_TON,
        "beta": b_cap,
        "injection_ton": inj_cap,
        "emitted_value_below_injection": bool(emitted_cap * p_f < inj_cap),
        "floor_rises": bool((e.T + inj_cap) / (e.S + emitted_cap) > p_f),
    }

    return {
        "_source": (
            "sim/scripts/run_phase1.py invite_line_report, over "
            "primes_sim.economics.beta / beta_expected. THIS SCRIPT OWNS THIS KEY "
            "(see FOREIGN_PARAM_KEYS): the invite line is beta arithmetic and beta "
            "is written here. TELEGRAM_INVITES_PLAN.md (owner 2026-11-07, replacing "
            "D-101's generators), CONCEPT.md SS4.1 seventh line. "
            "SCOPE: the per-mint beta table below is arithmetic in isolation; "
            "`_horizon_simulated` is the three-year run this file's other blocks "
            "come from, and it now carries the line."
        ),
        "_horizon_simulated": simulated,
        "max_count": econ.INVITE_MAX_COUNT,
        "_max_count_source": (
            "OWNER-SET, not derived (TELEGRAM_INVITES_PLAN.md, 2026-11-07, like "
            "D-101's count): the minter supplies 0..3 recipient addresses in the "
            "mint message and there is no governance over it; the checkout fills "
            "all 3 from the keeper's list, which is a copy decision and not a "
            "protocol one."
        ),
        "transfer_value_ton": econ.INVITE_TRANSFER_VALUE_TON,
        "transfer_value_nanoton": int(round(econ.INVITE_TRANSFER_VALUE_TON * 1e9)),
        "_transfer_value_source": (
            "OWNER-SET, not derived (TELEGRAM_INVITES_PLAN.md, 2026-11-07): each "
            "invite is one plain non-bounceable transfer of this value carrying the "
            "ledger's fixed text comment. The ledger's per-transfer value must equal "
            "it. It replaced D-101's 0.025 GRAM generator item deploy."
        ),
        # round(): 3 * 0.1 is 0.30000000000000004 in binary, and the app prints it.
        "line_ton_at_max_count": round(econ.INVITE_MAX_COUNT * (econ.INVITE_TRANSFER_VALUE_TON + econ.INVITE_SEND_FEE_TON), 9),
        "share_of_mint_price_at_max_count":
            round(econ.INVITE_MAX_COUNT * (econ.INVITE_TRANSFER_VALUE_TON + econ.INVITE_SEND_FEE_TON) / P, 9),
        "count_ceiling": econ.INVITE_COUNT_CEILING,
        "line_cap_ton": econ.INVITE_LINE_CAP_TON,
        "send_fee_allowance_ton": econ.INVITE_SEND_FEE_TON,
        "_bounds_source": (
            "OWNER-SET (DECISIONS.md D-215, 2026-11-22). The operator sets count and "
            "value on chain with `set_invite_terms`; `max_count` / `transfer_value_ton` "
            "are the GENESIS terms this run models, and the ledger publishes the "
            "live ones on `getInviteTerms`. These three bound every terms the ledger "
            "accepts: count <= count_ceiling and count * (value + send_fee_allowance) "
            "<= line_cap, checked at the setter and at every invite mint. "
            "`send_fee_allowance_ton` is an upper bound on a MEASURED cost (0.00040 GRAM "
            "per transfer at 3 invites, 0.00031 at 100, InviteTransfers.spec.ts); the "
            "transfer is sent PAY_FEES_SEPARATELY so the value arrives whole, and what "
            "the allowance overstates is swept to the ratchet pool by sweep_ops -- "
            "this sim does not credit it back, so its floor is the conservative one. "
            "`line_ton_at_max_count` includes the allowance (3 x 0.101)."
        ),
        "worst_beta_at_line_cap": min(r["beta_at_line_cap"] for r in rows),
        "optin_rate_assumed": econ.INVITE_OPTIN_RATE_ASSUMED,
        "_optin_rate_source": econ.INVITE_OPTIN_RATE_LABEL,
        "beta_table": rows,
        "_beta_table_note": (
            "SS4.1's beta rows, computed rather than tabulated. `beta_no_invite` "
            "reproduces the shipped table exactly -- the line is opt-in, so "
            "a mint that does not carry it splits as it always did. "
            "`beta_expected_at_assumed_optin` is the COHORT MEAN and inherits the "
            "ASSUMED label on the opt-in rate; it is the figure any floor "
            "projection over an invited population should use, and it is not a "
            "measurement."
        ),
        "unspent_slot_rule": (
            "A slot the minter's list has no address for is not "
            "sent anywhere (D-101 call 3, kept by TELEGRAM_INVITES_PLAN.md). It stays in the residual and backs the floor, exactly "
            "as an unset referral key does (SS4.1). Arithmetically an unspent slot "
            "is indistinguishable from a lower count, which is why there is no "
            "refund, credit or carry-forward term anywhere in this block."
        ),
        "k_lt_1_check": {
            "k_worst_case": k_worst,
            "k_ceil": up.k_ceil,
            "clamp_binds": bool(k_worst >= up.k_ceil - 1e-12),
            "floor_price_at_check": p_f,
            "T_ton": e.T,
            "S_primes": e.S,
            "worst_row": worst["row"],
            "by_invite_count": counts,
            "at_line_cap": at_cap,
            "k_lt_1_holds": all(c["emitted_value_below_injection"] for c in counts)
                            and at_cap["emitted_value_below_injection"],
            "floor_rises_at_every_count": all(c["floor_rises"] for c in counts)
                                          and at_cap["floor_rises"],
            "emission_tracks_injection": all(
                c["emission_ratio_to_count_0"] is None
                or abs(c["emission_ratio_to_count_0"] - c["injection_ratio_to_count_0"]) < 1e-12
                for c in counts),
            "_note": (
                "The ratchet theorem never used beta being constant: for any "
                "injection I > 0 and any k < 1, (T+I)/(S+kI/p_f) > p_f. A smaller "
                "beta shrinks injection and rebate TOGETHER, in the same ratio -- "
                "which is what `emission_tracks_injection` checks numerically. The "
                "single K_CEIL clamp sits on the SUMMED UPLIFTS and is not a "
                "function of beta at all (D-101, 'why no invariant moves')."
            ),
        },
    }


def floor_appreciation_report(e) -> dict:
    """The floor-appreciation multiple over the modelled horizon, MEASURED here
    rather than quoted from prose.

    CLAUDE.md "Measured provenance" carried a **389x** figure -- `p_f` from
    0.00083 to 0.32407 over a 3-year base-case run -- until 2026-09-05, when it
    was corrected to this block's figures. That number predated the current
    denomination: D-39/D-42 set L = 10,000 and D-100 point 2 unpinned the genesis
    donation from `lp_ton / S0`, which moved both endpoints. It is re-derived
    from this run's own floor trajectory so the number a reader quotes is a sim
    output with a `_source` and not a sentence in a guide.

    Two endpoints are reported: the DEPLOY floor (`donation / S0`, what the spec
    quotes at open) and the first SAMPLED floor of the run. They used to differ
    by two orders of magnitude, because the genesis auction's clearings landed
    in `T` before the first sample; D-20 deleted that auction and the D-180
    baseline has none, so the two bases now give one multiple.
    """
    traj = an.floor_trajectory(e)
    if not traj:
        return {"_provenance": "NOT DERIVED", "_note": "empty history"}
    first, last = traj[0]["floor_price"], traj[-1]["floor_price"]
    monotone = all(traj[i + 1]["floor_price"] >= traj[i]["floor_price"]
                   for i in range(len(traj) - 1))
    return {
        "_source": (
            "sim/scripts/run_phase1.py floor_appreciation_report, over "
            "analysis.floor_trajectory of this run's own history. SUPERSEDES the "
            "389x figure (p_f 0.00083 -> 0.32407), which was measured under the "
            "pre-D-39/D-100 denomination and does not reproduce here. CLAUDE.md "
            "'Measured provenance' was corrected to these figures on 2026-09-05; "
            "GAUNTLET.md A12 moved CONCEPT.md and docs/math-note.md onto them, "
            "and since D-180 the sampled and deploy bases are one multiple. ONE "
            "carrier of 389x remains and is NOT superseded here: DECISIONS.md, "
            "signed history with an inline [Correction, 2026-09-12] note. "
            "sim/tests/test_params_ownership.py greps for the carriers rather "
            "than trusting this list, so a new one cannot appear unnamed."
        ),
        "horizon_days": e.p.horizon_days,
        "first_sampled_floor_price": first,
        "final_floor_price": last,
        "multiple_over_horizon": (last / first) if first else None,
        "deploy_floor_price": e.floor_price_deploy,
        "multiple_over_horizon_from_deploy_floor":
            (last / e.floor_price_deploy) if e.floor_price_deploy else None,
        "monotone_at_every_sampled_point": bool(monotone),
        "sampled_points": len(traj),
        "measured_at_invite_optin_rate": e.p.invite_optin_rate,
        "_invite_line_note": (
            "MEASURED WITH SS4.1's SEVENTH LINE LIVE. `Engine._do_mint` draws an "
            "invite count per mint and passes it to `split_mint`, so this "
            "trajectory is the floor an invited population produces, not the "
            "uninvited upper bound the block used to carry. The opt-in rate it was "
            "drawn at is ASSUMED, not measured -- see "
            "`invites._horizon_simulated`, which reports the realised share and the "
            "GRAM the line took out of the residual over the horizon. Nothing in the "
            "ratchet moved: a smaller beta shrinks injection and emission in the "
            "same ratio, which `invites.k_lt_1_check` verifies numerically."
        ),
        "_note": (
            "`multiple_over_horizon` is measured from the FIRST SAMPLED point of "
            "the run (after the genesis clearings land in T), which is the basis "
            "the retired 389x was measured on. "
            "`multiple_over_horizon_from_deploy_floor` uses `donation / S0` "
            "instead and is the larger number. They are "
            "the same trajectory read from two different zeroes -- do not compare "
            "one against the other."
        ),
    }


def prime_uplift_realized_report(e: Engine, up) -> dict:
    """SS5.1 in the engine, not on paper: every window a Dutch-lot prime opened
    on its buyer, and the k_max uplift the K_CEIL clamp actually let through on
    the composite mints that spent it, against k_max at the prime that opened it
    (the rebate the prime mint withheld)."""
    rows = [
        dict(w, k_max_at_prime=econ.k_max_of_n(w["prime"], 1000, 0.9, 0.2))
        for w in e.all_prime_windows()
    ]
    if not rows:
        return {"windows_opened": 0, "holds": None, "_note": "no prime was sold"}
    margins = [r["k_max_at_prime"] - r["realized_uplift_sum"] for r in rows]
    worst = rows[min(range(len(rows)), key=margins.__getitem__)]
    return {
        "_source": (
            "sim/scripts/run_phase1.py prime_uplift_realized_report over "
            "Engine.all_prime_windows(). D-20 sells every prime off a Dutch lot, "
            "so the window is opened on the lot's buyer (SettlePrimeClearing in "
            "primes_ledger.tolk) and spent on their next composite head mints."
        ),
        "windows_opened": len(rows),
        "windows_fully_consumed": sum(r["uplifted_mints"] >= up.prime_window for r in rows),
        "uplifted_mints": sum(r["uplifted_mints"] for r in rows),
        "nominal_uplift_x_window": up.prime_uplift * up.prime_window,
        "max_realized_uplift_sum": max(r["realized_uplift_sum"] for r in rows),
        "mean_realized_uplift_sum": sum(r["realized_uplift_sum"] for r in rows) / len(rows),
        "min_margin_to_k_max_at_prime": min(margins),
        "worst_window": worst,
        "holds": all(m > 0 for m in margins),
    }


def build_params_json(e, ref_prices, yields, kills, all_passed, up, sizing,
                      headroom, headroom_doc, invariant, invariant_holds, bands, ceiling_tbl, equal_age,
                      auction,
                      stacking, sandwich_guarded, sandwich_unguarded, pending,
                      pending_above_floor, detach,
                      guard_capacity, storage_report, ceiling_base, ceiling_low,
                      ceiling_high, era_report, quest_reward_rep, score_rebate_rep, staking,
                      lp_depth):
    sp = e.p.split

    # CONCEPT SS4.1: OPS_RESERVE is derived, not chosen. Price the deferred legs
    # off the contract gas-regression baseline at the basechain gas/storage
    # config, using this run's own event frequencies. The gas file is produced by
    # `pnpm test:contracts`; if it is missing the sim must not invent a number.
    gas_baseline = gasmod.load_gas_baseline(GAS_BASELINE_PATH)
    ops = gasmod.ops_reserve(
        gas_baseline,
        total_mints=len(e.mint_log) + e.prime_lots_sold,
        horizon_days=e.p.horizon_days,
        owed_entries=prime_mints(e),
    )
    # CONCEPT.md SS4.4 as superseded 2026-08-19 (D-30/D-33): RES_FEE and
    # RES_PRIORITY are DELETED. RES_GAS survives alone, carved from the winning
    # bid, and is re-derived here against the close/settle profile the unified
    # lane actually runs -- never picked in a contract constant.
    res_split = gasmod.res_gas_derivation(gas_baseline)
    # `gasmod.open_release_round_trip` is DELETED (D-90.2) -- it priced the gas
    # of an open-and-release round trip for D-32's forfeit constraint, and there
    # is no release.
    bid_round_trip_ton = gasmod.bid_round_trip_ton(gas_baseline)
    # DECISIONS.md D-99: `D(n)`, the one additive score that prices every
    # number. Emitted TOP-LEVEL as `score`, not under `off_head`: it was
    # nested there (as `reservations`) when it sized a reservation FEE, and it has not been a fee
    # since D-30. It now has three consumers, none of them a reservation --
    # P0(n) (trophy_auction), the vault rebate (genesis.score_rebate) and the
    # minimum bid increment (acquisition). The 33 weights inside it are
    # OWNER-DECLARED and parsed out of shared/opcodes.ts; the histogram and the
    # worked examples are this run's own measurement.
    desirability_block = desirability.desirability_block()
    # TROPHY_AUCTION_PLAN.md SS3.1: the trophy lane. Emitted TOP-LEVEL rather
    # than under `off_head` because it is not one -- it is a separate
    # contract with its own entrypoints, its own gas rows and its own money
    # path, and nesting it would imply the reservation book owns a price map it
    # never evaluates (the 2^(D/10) map runs on the auction contract, which is
    # exactly what keeps SS4.4 point 1's 0.0002 GRAM scoring headroom untouched).
    # It reads three things back out of the blocks above -- RES_GAS,
    # RES_PRIORITY_BASE and the published histogram -- and the RESERVE_FLOOR
    # identity check is what stops those three drifting apart silently.
    #
    # The NPV ladder is calibrated at THIS RUN's realised horizon and mint rate,
    # not at `prime_tribute_npv`'s defaults, so the analytic sweep is compared
    # with the engine run's own NPVs on the same clock. The two are
    # different computations and the residual is published, not reconciled away
    # -- see `trophy_auction.npv_calibration`.
    trophy_mints_per_year = len(e.mint_log) / (e.p.horizon_days / 365.0)
    trophy_block = trophy.trophy_auction_block(
        mint_price_ton=1.0,
        res_gas_ton=res_split["res_gas_ton"],
        histogram=desirability_block["histogram"],
        npv_horizon=int(e.head),
        npv_mints_per_year=trophy_mints_per_year,
        engine_npv={p: ref_prices[p]["npv_ton"] for p in ref_prices},
        exponent=sp.divisor_exponent,
        f=sp.flat_dividend_f,
        tribute_pct=sp.tribute_pct,
    )
    trophy_block["gas"] = gasmod.trophy_auction_gas(
        gas_baseline, res_gas_ton=res_split["res_gas_ton"]
    )
    gas_line = gasmod.gas_ops_line(gas_baseline)
    # The engine's split and the published line are ONE derivation, never two.
    assert abs(gas_line["gas_ops_pct"] - sp.gas_ops_pct) < 1e-12, (gas_line, sp.gas_ops_pct)
    gas_draw = gasmod.measured_gas_draw_per_mint(
        gas_baseline,
        prime_share=prime_mints(e) / max(len(e.mint_log) + e.prime_lots_sold, 1),
    )
    # DECISIONS.md D-212: the naming fees are the owner's, so the block is a pure
    # function of nothing the run measured.
    naming_block = acq.naming_block()

    return {
        "_meta": {
            "description": (
                "Single source of truth for every simulation-derived constant. "
                "Regenerated by /sim/scripts/run_phase1.py -- deterministic given "
                "the fixed seed below."
            ),
            "schema_version": SCHEMA_VERSION,
            "concept_draft": _concept_draft(),
            "source": f"sim/scripts/run_phase1.py, seed={SEED}",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "report": "regenerate with sim/scripts/run_phase1.py; see CLAUDE.md 'Measured provenance'",
            "supersedes": "schema_version 1.0.0 (pre-v5 economics; its kill-criteria passes do not transfer)",
        },
        "mint": {
            "mint_price_ton": 1.0,
            "tribute_pct": sp.tribute_pct,
            "referral_pct": sp.referral_pct,
            "treasury_pct": sp.treasury_pct,
            "gas_ops_pct": sp.gas_ops_pct,
            "_gas_ops_pct_note": (
                "DERIVED, not chosen (DECISIONS.md D-117, signed 2026-09-22): the heaviest "
                "mint executeMint can perform, measured on the ledger's own books by "
                "GasRegression.spec.ts (`gas_ops_spend.*` in contracts/gas-baseline.json), "
                "rounded UP to the next 5% step of the mint (step OWNER-SET, D-117). Still FIXED per mint as "
                "CONCEPT.md SS11.5 closed it (D-9) -- beta is a constant in every SS4.2 "
                "example -- but the constant is now the measured worst case, not 10%. The "
                "old 10% was reconciled against a hand-kept list of attached hops that "
                "missed the special-number rebate, the era trophy, the ratchet hop and the "
                "fee legs' forward fees; the ledger really spent 0.110 GRAM on the omega=3 "
                "primorial. See `fees.gas_ops_line` for the rows and the headroom. What a mint "
                "does not spend is swept back into the ratchet pool, emission-free (D-117), so "
                "the line's size moves GRAM through the pool rather than out of it: "
                "`fees.effective_beta_referred_composite`."
            ),
        },
        # SS4.1's seventh line: the GRAM the line costs a mint is a split concern,
        # and the split is written in this file.
        "invites": invite_line_report(e, up),
        "tribute": {
            "flat_dividend_f": sp.flat_dividend_f,
            "divisor_line_share": 1.0 - sp.flat_dividend_f,
            "divisor_exponent": sp.divisor_exponent,
            "divisor_weight_formula": "w(p) = e * p**0.5, with s = floor(sqrt(p)) submitted and verified s^2 <= p < (s+1)^2",
            "flat_dividend_accrual": "div_acc += f * 0.10 / pi(n) per mint; entry[p] stamped at mint; claim pays div_acc - entry[p]",
            "prime_mint_tribute": "the whole 10% line has no recipient on a prime mint and falls to the pool (SS4.1, SS4.2.1)",
            "band_tables": bands,
            "lifetime_ceiling_table": ceiling_tbl,
            "equal_multiplicative_age": equal_age,
        },
        "rebate": {
            "k_min": e.p.k_min,
            "k_max_cap": e.p.k_max_cap,
            "ramp_seconds": e.p.ramp_seconds,
            "n0_anchor": e.p.n0_anchor,
            "k_on_prime_mint": 0.0,
            "_k_on_prime_mint_note": (
                "SS5.1/SS11.15 is CLOSED: primes emit nothing, k = 0 unconditionally. "
                "There is no k = k_min fallback and none should appear in the contract."
            ),
            "S_MAX": e.p.s_max,
            "S_MAX_nanoprimes": int(round(e.p.s_max * 1e9)),
            "_S_MAX_source": (
                "DECISIONS.md D-156 -- OWNER-SET, not sim-selected, exactly as D-154's "
                "`genesis_donation_ton` is. The sim CONSUMES this figure and re-derives the "
                "emission curve, the floor and every dependent block from it; it does not "
                "choose it. 1,200,000,000 PRIMES was set at 100x the then-12,000,000 genesis "
                "supply; D-166 moved S0 to 11,000,000 and left S_MAX where the owner set "
                "it, so it is no longer a multiple of S0 and nothing reads it as one. "

                "SS5's emission is multiplicative (`dS/S = k*beta/T`), so `S` is bounded iff "
                "`k` is integrable in `u = ln n`; `2.7/log10(n)` is not, and `K_MIN = 0.2` "
                "flattens it entirely past n = 10^13.5. D-156 does NOT replace that curve -- "
                "it multiplies it by `(S_MAX - S)/S_MAX`, which makes emission logistic and "
                "bounds `S` without touching the sim-calibrated shape where the game lives. "
                "`k` only shrinks, so `k < 1` and the ratchet theorem strengthen."
            ),
            "K_CEIL": up.k_ceil,
            "PRIME_UPLIFT": up.prime_uplift,
            "PRIME_WINDOW": up.prime_window,
            "NEWCOMER_UPLIFT": up.newcomer_uplift,
            "NEWCOMER_WINDOW": up.newcomer_window,
            # Not selected: sizing the newcomer credit needs the elasticity of
            # gift-mint take-up with respect to it, and no such measurement
            # exists before mainnet. `uplift_stacking` is what bounds it.
            "_newcomer_source": (
                "OWNER-SET incumbent pair, NOT swept. Opened by the recruit edge in "
                "primes_ledger.tolk (a gift mint to an address minterState has never "
                "seen) and spent one per clocked mint. DECISIONS.md D-106."
            ),
            "recruit_rank_tiers": list(up.recruit_rank_tiers),
            "recruit_rank_kmax_uplifts": list(up.recruit_rank_uplifts),
            "prime_rank_tiers": list(up.prime_rank_tiers),
            "prime_rank_kmax_uplifts": list(up.prime_rank_uplifts),
            "uplift_stack_rule": "k_max = min(k_max(n) + recruit + prime + PRIME_UPLIFT + NEWCOMER_UPLIFT, K_CEIL) -- summed, clamped once",
            "prime_uplift_sizing": sizing,
            "headroom_table": headroom,
            "headroom_table_documented_proposal_0p06_over_5": headroom_doc,
            "invariant_prime_uplift_x_window_lt_kmax": {
                "holds_across_simulated_range": invariant_holds,
                "rows": invariant,
                "_note": (
                    "Static arithmetic over n. The contract side is swept by "
                    "contracts/tests/KMaxCurve.spec.ts; the engine side is "
                    "`prime_uplift_realized`."
                ),
            },
            "prime_uplift_realized": prime_uplift_realized_report(e, up),
            "uplift_stacking": stacking,
        },
        "flush": {
            "flush_pct": e.p.flush_pct,
            "flush_cooldown_seconds": e.p.flush_cooldown_seconds,
            "flush_min_ton": e.p.flush_min_ton,
            "FLOOR_GUARD": e.p.floor_guard,
            "min_out_rule": "min_out = amount * S / T * (1 + FLOOR_GUARD)",
            "sandwich_profitability_check": sandwich_guarded,
            "sandwich_profitability_check_unguarded_control": sandwich_unguarded,
            "_sandwich_note": (
                "Re-measured WITH the guard. The v4 file's number was measured against "
                "storeCoins(1) -- no guard at all -- and is not carried forward. "
                "D-190 (2026-09-26): the attacker is now also the flush CALLER -- it "
                "pumps up to 8x the flush, then sizes the tranche to the pumped pool "
                "(D-143), which the earlier model (flush sized before the pump, pump "
                "capped at 0.5x) could not do and so read 0.00 GRAM. The PnL here is "
                "BURN EFFICIENCY lost while the market is under the floor: the "
                "ratchet still never averages above p_f, and T, S and p_f do not move."
            ),
            "pending_growth": pending,
            "pending_growth_above_floor_market": pending_above_floor,
        },
        # DECISIONS.md D-151 / STAKING_PLAN.md P1. Sits next to `flush` because
        # the reserve is a multiple of the flush ceiling above it.
        #
        # NOT `staking`: the top-level `staking` block is D-168's PRIMES
        # staking (a player locking PRIMES for a share of the treasury vest) --
        # a different asset, a different actor and a different section. One
        # grep for "staking" must not return both mechanics as if they were one.
        "staked_reserve": staking,
        "prime_head": {
            "model": (
                "DECISIONS.md D-20: primes are NOT head mints. The head walks composites; "
                "a prime opens a Dutch lot as the head passes it, so the head never parks "
                "and there is no prime-head dwell to measure. (Until 2026-09-24 this block "
                "carried the legacy model's dwell distribution, stall alert, sensitivity "
                "sweep and stall-sized prime-quest budget; all four measured a deleted "
                "risk and are deleted with it.)"
            ),
            "prime_lots_opened": e.prime_lots_opened,
            "prime_lots_sold": e.prime_lots_sold,
            "prime_lots_unsold": e.prime_lots_unsold,
            # V26.2 / D-188: the most prime lots ever open at once -- one market
            # `lots` row and one ledger unsold row each. The `BOUND:` beside the
            # market's `lots` map is written from it.
            "prime_lot_backlog_peak": e.prime_lot_backlog_peak,
            "prime_lot_premium_to_ratchet_ton": e.prime_lot_premium_total,
            "unsold_prime_forfeit_ton": e.unsold_prime_forfeit_ton,
            "prime_lane_model": {
                "prime_lot_sale_probability": e.p.prime_lot_sale_probability,
                "prime_lot_mean_premium_ton": e.p.prime_lot_mean_premium_ton,
                "prime_lot_mean_days_to_sale": e.p.prime_lot_mean_days_to_sale,
                "_source": (
                    "determinations.d20_baseline.prime_lane_model_fed_to_engine, measured "
                    "by sim/scripts/run_determinations.py (market.evaluate_lane). The "
                    "premium splits per D-114: the ratchet's half is the figure above."
                ),
            },
        },
        "score": desirability_block,
        # The off-head lane's gas carve (SS4.4): RES_GAS and the lot floor it
        # sets. The lane's prices live under `trophy_auction` and `acquisition`.
        "off_head": {
            **res_split,
            "bid_round_trip_ton": round(bid_round_trip_ton, 9),
            "import_window": import_window_report(e),
        },
        "naming": naming_block,
        "trophy_auction": trophy_block,
        "genesis": {
            # D-20 (DECISIONS.md; CONCEPT.md SS6) DELETED the genesis K-lot and
            # its ascending pre-bid phase outright -- there is no fixed six-prime
            # set left in the design. Every prime, from 2 onward, opens the
            # instant it is next among not-yet-built numbers (never blocking the
            # head, which is defined over composites and Unity only) and clears
            # through the SAME uniform MODE_DUTCH_BUYNOW lane D-4 already defined:
            # a per-prime descending price from P0(p) to its resting price
            # max(MINT_PRICE, P0/3, NPV/2), buy-now only, parked there until bought.
            # The general derivation, D-20 point 1 / CONCEPT.md SS6: one shared
            # DECAY_SECONDS and one shared 1.5x fair-value multiplier applied to
            # EVERY prime's own simulated NPV -- not a precomputed table for six
            # numbers. `p0_ton_by_prime` is generated by the same analytic sweep
            # `trophy_auction.npv_ladder` already runs (`tribute.prime_tribute_npv`,
            # general over any prime under a horizon), so this is the exact
            # dictionary `primes_market.tolk`'s `MarketConfig.npvTable` should be
            # seeded with at deploy -- one entry per prime up to the same
            # NPV_LADDER_PRIME_COUNT bound documented in `trophy_auction`, beyond
            # which the contract's own npvTable-miss fallback (the ladder)
            # quotes the identical price anyway.
            "prime_dutch_lane": {
                "_rule": (
                    "P0(p) = max(PRIME_P0_MULTIPLE * NPV(p), LOT_FLOOR, MINT_PRICE * "
                    "2^(D(p)/SCORE_HALVING)) -- D-99 deletes PRIME_P0_MIN and puts "
                    "the ladder branch in its place, decaying LINEARLY from P0(p) to "
                    "the resting price max(MINT_PRICE, P0(p)/3, NPV(p)/2) over "
                    "DECAY_SECONDS (D-88 point 1, D-99 SS1.2), then parking there "
                    "until bought. Applies to every prime, starting with 2 -- there "
                    "is no expiry and no genesis-specific slope (D-20 deletes the old"
                    " 90-day ceiling / P0-over-10 opening bid / P0-over-100 reserve "
                    "format along with the K-lot)."
                ),
                "decay_seconds": trophy.C.AUCTION_WINDOW_SECONDS,
                "decay_seconds_days": trophy.C.AUCTION_WINDOW_SECONDS / 86400.0,
                "_decay_seconds_note": (
                    "Must equal PRIME_DUTCH_SECONDS in "
                    "contracts/contracts/primes_market.tolk (604800 = 7 days). "
                    "Coincides numerically with the unrelated composite trophy "
                    "lane's AUCTION_WINDOW_SECONDS -- both are declared 7-day "
                    "constants, not the same field."
                ),
                "mint_price_floor_ton": 1.0,
                "prime_p0_multiple": trophy.C.PRIME_P0_MULTIPLE,
                "opens_at_launch": [
                    p for p in (2, 3) if p < 4
                ],  # SS6 point 1: after Unity, every prime before the first
                    # composite (4) opens simultaneously -- 2 and 3 at genesis.
                "npv_source": (
                    "sim/primes_sim/tribute.py prime_tribute_npv (analytic), via "
                    "trophy_auction.npv_ladder -- see trophy_auction.npv_ladder "
                    "for the calibration (horizon, mints_per_year, discount rate) "
                    "and trophy_auction.npv_ladder.npv_ton_by_prime for the table."
                ),
                "p0_ton_by_prime": {
                    str(p): round(
                        trophy.p0_nanoton(desirability.score(int(p)), prime=True,
                                          npv_ton=v) / trophy.NANO,
                        4,
                    )
                    for p, v in trophy_block["npv_ladder"]["npv_ton_by_prime"].items()
                },
                "_p0_ton_by_prime_note": (
                    "Every prime in the analytic sweep's dictionary "
                    f"({trophy_block['npv_ladder']['prime_count']} primes, up to "
                    f"{trophy_block['npv_ladder']['max_prime_in_table']}). Beyond "
                    "it, npvTable has no entry and p0Of() falls back to the "
                    "ladder -- the identical price this table would have quoted "
                    "with the entry present, since past the dictionary the NPV "
                    "branch no longer binds."
                ),
            },
            # `auction_reference_prices` WAS emitted here: the six engine NPVs
            # (p = 2..13) the analytic ladder regresses against, plus a reference
            # reserve and a yield that nothing read once D-20 deleted the genesis
            # auction. The NPVs are published once, beside the ladder they check,
            # as `trophy_auction.npv_calibration.by_prime.*.engine_npv_ton`.
            # `auction_reserves_ton_legacy_v5` WAS emitted here too. D-20 retired the
            # reserves' role as a genesis auction floor (SS11.17) and the key was
            # kept alive under its old name for exactly one consumer:
            # run_constellations.py re-seeded its own engine pass's
            # `auction_reserves_ton` from it. D-102 deleted that engine pass -- the
            # new generators/constellations model is not a function of simulated
            # ownership -- so the key had no reader left in the repo and is
            # dropped rather than shipped as a 5,000-key file's dead weight. The
            # two-pass reserve calibration went with the genesis auction
            # (2026-09-24): the NPVs above come from the one D-20 baseline pass.
            "genesis_lp_ratio_primes_per_ton": e.p.genesis_lp_primes_per_ton,
            # DECISIONS.md D-100 point 2: the operator funds 4.20 GRAM at genesis,
            # not D-92's 240. D-92's derivation stands as a METHOD -- `X = S0 /
            # (1/p_f - L)` -- but it is now run the other way round: the donation
            # is the owner-set INPUT and `genesis_floor_price_ton_per_primes` is
            # what falls out, `4.20 / 12,000,000 = 3.5e-7`, 48x below the figure
            # this file carried through D-92. Everything below that divides by the
            # genesis floor (`era_bounty_schedule.bounty_ton`, `quest_rewards`,
            # `score_rebate`, `sinks.*.nanoprimes`, `deploy_floor_*`) moves with
            # it and is regenerated here, never hand-patched (CLAUDE.md rule 3).
            # `genesis_lp_ratio_primes_per_ton` (L = 10,000) is NOT touched: D-39
            # fixed it and it is a denomination knob, not a price.
            "genesis_donation_ton": e.p.genesis_donation_ton,
            "genesis_floor_price_ton_per_primes": e.floor_price_genesis,
            "_genesis_donation_source": (
                "DECISIONS.md D-154, amending D-100 point 2 -- OWNER-SET, not "
                "sim-selected. The operator will not fund D-92's 480 GRAM (240 donated + "
                "240 paired). D-100 point 2 set 4.20 GRAM at genesis with up to 150 GRAM "
                "incrementally afterwards (point 3); D-154 FRONT-LOADS that whole "
                "commitment to 132.50 GRAM at genesis, because D-140 pins the pair at "
                "the floor and so makes opening depth quadratic in this figure -- `(L*X "
                "+ 250,000) * X / S0` GRAM at the time, 17.39 at X = 132.50, and 132.50 + "
                "17.39 = 149.89 was the commitment. D-166 deleted the operator lock and "
                "its tranche with it: the pair is now `m * X / (S0 + m)` = 14.13 GRAM, `m` "
                "= 1,312,854 the donation's own D-156-tapered mint, at S0 = 11,000,000, and the donation is left where the owner set it. "
                "D-204 (owner, 2026-11-11) SUPERSEDES THE FIGURE: the donation is 200 GRAM, "
                "and the vault grows 10,000,000 -> 15,600,000 with it so the floor it "
                "buys is the one the game already opened at; every 132.50-era number in "
                "this note is history. `donate_floor` "
                "stays permissionless and incremental for anyone afterwards. The sim "
                "consumes this figure and re-derives the floor; it does not choose it. "
                "D-93's `T > 0` ignition guard is what makes a donation this small "
                "legal, and D-100 point 1's `emitted = min(X*L, X*S/T)` is what keeps a "
                "LATE donation from minting above the floor."
            ),
            "_donation_vs_modelled_depth": (
                "HONEST MODELLING GAP, flagged rather than buried. `genesis_seed_ton` "
                "(200) is a NOMINAL that sizes S0 = seed * L * (1/2 + vault_pct) = "
                "11,000,000 PRIMES (D-166) and the depth of the DeDust pair the agent loop "
                "trades against; `genesis_donation_ton` (132.50) is the GRAM actually "
                "credited into `T`. Before D-100 these were the same number by "
                "construction (D-92 chose the donation to reproduce `seed / S0`), so "
                "the modelled pool and `T` coincided. They no longer do, and D-140 "
                "moved the real pair AGAIN, and D-154 resized it a third time: it is "
                "now 1,312,854 PRIMES, all minted by the donation (D-166 took the "
                "operator's 250,000 first vest tranche out with the operator lock), "
                "against 14.13 GRAM, priced at "
                "`primes * p_f`. D-154 NARROWS this gap without closing it -- 14.13 GRAM "
                "of real pair against depth sized off a 200 GRAM nominal is the same "
                "order of magnitude for the first time, where D-100 point 2's 0.1022 "
                "GRAM was three orders below it. Neither number is the point: what D-140 "
                "fixed is the RATIO, which is the only thing about the pair the "
                "protocol can see. Re-sizing the modelled pool is still NOT done, "
                "because pool depth feeds k_max calibration, the reserves and the kill "
                "criteria, and silently re-deriving those off an operational choice is "
                "exactly the drift CLAUDE.md rule 3 forbids. MEASURED 2026-09-18 "
                "(GAUNTLET.md X14, docs/audit/x14-modelled-pool-depth.md): one full run "
                "with the pool seeded at the real pair, against the committed run, "
                "moves 45 numeric leaves and NOT ONE of them is a parameter. `rebate` "
                "(k_max_cap, K_CEIL, PRIME_UPLIFT and every uplift tier) and "
                "`off_head` (RES_GAS, LOT_FLOOR; then named `reservations`) are byte-identical, and all three "
                "kill criteria keep `passed: true`. What moves is observation: the AMM "
                "price, the flush fill count, `pending`, and criterion 1's own "
                "`measured`/`guard_capacity` sub-blocks. So the re-sizing is NOT "
                "adopted, and this is now a measured statement rather than an open "
                "question. The finding worth carrying: the unguarded sandwich control "
                "goes from 10.70% to 99.9999% of swapped value extracted, so SS4.3.1's "
                "floor guard is MORE load-bearing at the real depth, not less. What "
                "follows from the change that WAS made: `market_over_floor_at_open` is "
                "1.0 -- not D-92's 6x and not D-100's unintended 286x -- so the SS4.3.1 "
                "floor guard is live from the first mint instead of refusing every "
                "attempt."
            ),
            "bounty_vault_size_primes": e.bounty_vault_initial,
            "bounty_vault_pct_of_genesis_lp": e.p.bounty_vault_pct_of_lp,
            "era_bounty_schedule": era_report,
            "quest_rewards": quest_reward_rep,
            "score_rebate": score_rebate_rep,
            # SS6 point 3: founder-seeded LP at deploy. `T0` sets depth, not
            # price -- the floor is 1/(L * (1 + vault_pct)) at any seed size.
            "genesis_seed_ton": e.p.genesis_seed_ton,
            "genesis_supply_primes": e.genesis_supply_primes,
            # `donate_floor`'s mint to the donor (D-100 point 1, D-156 taper) and
            # the supply the deploy floor divides by. The floor is
            # `genesis_donation_ton / deploy_supply_primes`, NOT `/ genesis_supply_primes`.
            "genesis_donation_primes": e.genesis_donation_primes,
            "deploy_supply_primes": e.deploy_supply_primes,
            "deploy_floor_price_ton_per_primes": e.floor_price_deploy,
            "deploy_floor_primes_per_ton": (
                1.0 / e.floor_price_deploy if e.floor_price_deploy > 0 else None
            ),
            # D-140: the opening pair is posted AT the floor, not at `L`. `L` is
            # the rate `donate_floor` MINTS at (a denomination knob, D-39) and
            # was never a price; quoting it here is what produced the 286x open.
            # The deposit ratio on an empty pool IS the price, so the operator
            # posts `primes * p_f` GRAM against whatever PRIMES they hold, and the
            # market opens at `1 / p_f` PRIMES per GRAM.
            "market_open_primes_per_ton": (
                1.0 / e.floor_price_genesis if e.floor_price_genesis > 0 else None
            ),
            # Was `1 + vault_pct` (6.0) under D-92, then an unintended 286x once
            # D-100 point 2 cut the donation 57x and left the pair quoted at `L`.
            # D-140 makes it 1.0 BY CONSTRUCTION: the pair's own ratio is `p_f`,
            # so this is `p_f / p_f`. It is the ratio the SS4.3.1 floor guard
            # sees, and at 1.0 the guard is live from the first mint.
            "market_over_floor_at_open": (
                1.0 if e.floor_price_genesis > 0 else None
            ),
            "forfeit_split_bps": 5800,
            "_forfeit_split_source": (
                "DECISIONS.md D-166 (amends D-100 point 6's 80/20) -- OWNER-SET. An "
                "unsold prime's tribute forfeits (CONCEPT.md SS6 point 2, SS4.1) split "
                "58% to the treasury CONTRACT (governed, no key -- D-100 point 7) and "
                "the remaining 42% to `ConfigA.operatorAddr`. Basis points of the "
                "forfeited amount; the treasury share is `bps`, the operator share "
                "is `10000 - bps`. Nothing here is derived from a sim run and "
                "nothing in sim/ reads it -- CLAUDE.md rule 3 is not engaged."
            ),
            # D-114, and see the G20 note in `fees` above for why an OWNER-SET
            # constant is emitted from the generator rather than kept by hand.
            "premium_treasury_bps": 5000,
            "_premium_treasury_split_source": (
                "DECISIONS.md D-114 -- OWNER-SET, amends D-7. An auction lot's "
                "premium above MINT_PRICE + RES_GAS (CONCEPT.md SS4.4) splits 50% "
                "to the treasury CONTRACT (governed, no key -- D-100 point 7) and "
                "the remaining 50% to the ratchet as pending. Basis points of the "
                "premium; the ratchet share is `10000 - bps`. Same idiom as "
                "forfeit_split_bps above. Nothing here is derived from a sim run "
                "and nothing in sim/ reads it -- CLAUDE.md rule 3 is not engaged."
            ),
            "_note": (
                "D-20 deleted the genesis K-lot auction, so no clearing reaches `T` at "
                "genesis: `T0` is the donation alone. Auction premiums arrive later, "
                "per lot, and only half reaches the ratchet (D-114); the run models "
                "that on the D-20 prime lane (`prime_head.prime_lot_premium_to_ratchet_ton`). "
                "Until 2026-09-24 the sim credited ~1,375 GRAM of genesis clearings here "
                "and every floor figure in this file was inflated by it."
            ),
            # D-77 (amends D-46 points 1 and 3), as amended by D-100 point 6 and
            # D-166: a DISCLOSURE SCHEDULE, not a simulation output (CLAUDE.md
            # rule 3 is not engaged). Constructed here, not hand-maintained in
            # shared/params.json, because a full regen used to silently delete
            # this block (GAUNTLET.md G20). One instance since D-166 -- the
            # treasury's; the operator's lock is deleted. Its total is
            # `genesis_supply_primes - bounty_vault_size_primes`.
            "vesting": _vesting_block(e),
        },
        # DECISIONS.md D-100 points 4/8/9 as amended by D-168. Top-level, not
        # nested under `genesis`, because none of it is a genesis figure: the
        # custody and the governance run for the life of the game. LP = vote
        # only; every figure is owner-set.
        "treasury": _treasury_block(e),
        # DECISIONS.md D-168: PRIMES staking paid from the treasury vest. The
        # one sim-selected figure (`distribution_rate_bps_per_day`) and the
        # mandatory LP-depth-without-miner risk report live here.
        "staking": _staking_block(e, lp_depth),
        # CONCEPT SS2 principle 4: the fee lines. None of them issues PRIMES and
        # none is a claim on pending / owed. The split rates themselves are
        # `mint.*`; nothing here repeats them.
        "fees": {
            "royalty_numerator": 500,
            "royalty_denominator": 10000,
            "royalty_pct": 0.05,
            "royalty_note": (
                "TEP-66 declaration on the collection (SS3.1). Honored by "
                "marketplaces, NOT enforced by the contract: a direct transfer "
                "pays nothing. Deliberately excluded from every revenue "
                "projection the dashboard publishes."
            ),
            # D-128. NOT SIM-DERIVED and nothing under sim/ reads it -- emitted
            # here anyway because a key this file does not write is a key the
            # next full regen DELETES. That is not hypothetical: these three and
            # `genesis.premium_treasury_bps` were hand-added to params.json and
            # vanished on the first regen after them (GAUNTLET.md G20's failure,
            # repeated). An owner-set constant belongs in the generator with its
            # provenance string, exactly like `forfeit_split_bps` below.
            "royalty_ratchet_bps": 5000,
            "royalty_ratchet_note": (
                "DECISIONS.md D-128: of the royalty a marketplace actually "
                "forwards, this many basis points are injected into the ratchet as "
                "backing (T += share, S untouched) and the remainder goes to the "
                "operator. Scope is the NUMBERS collection, the only one left since "
                "TELEGRAM_INVITES_PLAN.md deleted generators and constellations."
            ),
            "royalty_ratchet_source": (
                "NOT SIM-DERIVED, AND NOTHING UNDER sim/ READS IT. Nothing in the "
                "simulation models secondary-market turnover, so there is no volume "
                "series for a royalty rate to be applied to -- running the sim for "
                "this number would mean inventing the turnover model it came out "
                "of, which is CLAUDE.md rule 3 pointed backwards. It is a DISCLOSED "
                "POLICY CHOICE in D-114's idiom, the same class of number as "
                "premium_treasury_bps = 5000: where fee-shaped revenue goes, not a "
                "value the simulation solves for. See royalty_note above: the "
                "royalty is excluded from every revenue projection the dashboard "
                "publishes, and this split does not change that."
            ),
            **ops.as_params(),
            "ops_reserve_note": (
                "SS4.1: the standing float sweep_ops may never dip into, covering "
                "the ledger's deferred costs (owed rent and settlement gas; D-146 "
                "removed amortized flush gas). DERIVED, not chosen -- one HORIZON_MINTS of "
                "deferred draw priced off contracts/gas-baseline.json at the "
                "basechain gas and storage config. See ops_reserve_derivation for "
                "every term. Must match OPS_RESERVE in primes_ledger.tolk."
            ),
            "gas_ops_line": gas_line,
            "measured_gas_draw_ton_per_mint": gas_draw["blended_ton"],
            "measured_gas_draw": gas_draw,
            "measured_gas_draw_note": (
                "Priced from contracts/gas-baseline.json, which GasRegression.spec.ts "
                "pins -- so this figure moves only when the implementation's real TVM "
                "gas moves. The sweepable surplus is (line - blended draw) per mint. "
                "The prime/composite rows are kept separately because SS5.1's claim "
                "that zero emission buys back the primality check is exactly the "
                "comparison between them."
            ),
            # D-117 (owner, 2026-09-22): the surplus goes back to the POOL, not the
            # operator -- `sweep_ops` credits the ratchet's `pending` with no emission.
            "ops_surplus_destination": "ratchet pool (pending), emission-free, k = 0",
            "ops_surplus_to_pool_ton_per_composite_mint": round(
                sp.gas_ops_pct - sp.gas_ops_draw_composite_ton, 9),
            "ops_surplus_to_pool_ton_per_prime_mint": round(
                sp.gas_ops_pct - sp.gas_ops_draw_prime_ton, 9),
            "effective_beta_referred_composite": round(
                econ.beta(False, True, sp) + sp.gas_ops_pct - sp.gas_ops_draw_composite_ton, 6),
            "ops_surplus_to_pool_ton_over_horizon": round(e.ops_surplus_to_pool_total, 6),
            "_effective_beta_note": (
                "beta is the residual the rebate is priced on (k * beta * P); the effective "
                "figure adds the unspent gas & ops line, which the permissionless sweep "
                "returns to the pool without emission. The sim books it at mint (the sweep's "
                "timing lag is not modelled), so final_state and the floor multiples include it."
            ),
        },
        "kill_criteria": {
            "results": kills,
            "all_passed": all_passed,
            "_note": (
                "Re-evaluated against v5 economics. The v4 file's all_passed=true does not "
                "transfer: the criteria themselves changed and the economics under them "
                "changed. There are now FOUR. Criterion 4, blue-chip constellation "
                "crowding, is deleted by D-102 along with the x3/2 tribute multiplier it "
                "measured -- it PASSED at -2.68% here (-2.25% in run_constellations.py's "
                "realistic-density re-run) against a -10% threshold and is retired "
                "rather than re-tuned, so `all_passed` is the same verdict over one fewer "
                "still-passing test and no other criterion or sink read it."
            ),
        },
        "owed_dict_ceiling_resolution": {
            "_status": "RESOLVED by sharding; see `recommended`.",
            "ceiling_n_single_account": an.OWED_CEILING_N,
            "baseline_scenario": ceiling_base,
            "low_growth_scenario": ceiling_low,
            "high_growth_scenario": ceiling_high,
            "storage_analysis": storage_report,
        },
        "amm_floor_detachment_check": detach,
        "floor_guard_capacity": guard_capacity,
        "final_state": {
            "final_head": e.head - 1,
            "final_T_ton": e.T,
            "final_S_primes": e.S,
            # SS3.3 / SS11.21: emission, burns and circulating supply are three
            # separate numbers and the dashboard is required to report them that
            # way. The sim used to publish only `S`, which made the burn side of
            # that report uncalibrated -- there was no simulated magnitude to check
            # the on-chain counter against.
            "final_burned_primes": e.burned_primes,
            "final_burn_events": e.burn_events,
            "final_circulating_primes": e.circulating_primes,
            "circulating_share_of_S": (e.circulating_primes / e.S) if e.S else None,
            "final_floor_price": e.floor_price,
            "final_amm_price": e.pool.price_ton_per_primes,
            "final_pending_ton": e.pending,
            "final_swapped_ton": e.swapped,
            "final_treasury_ton": e.treasury_total,
            "final_div_acc_ton": e.div_acc,
            "flat_dividend_paid_total_ton": e.flat_dividend_total,
            "total_mints_simulated": len(e.mint_log),
            "prime_mints": prime_mints(e),
            "prime_declines": e.prime_declines,
            "horizon_days": e.p.horizon_days,
            "floor_appreciation": floor_appreciation_report(e),
            # D-151's four end-of-run figures. They come from the STAKING run
            # (`staking.chosen_configuration`), not from the base run every
            # other field here is read off -- the base run has staking off, so
            # its `staked_cost` is structurally zero. Same seed, same reserves,
            # same horizon; the only difference is the block being measured.
            "_staked_reserve_source": (
                "staked_reserve.chosen_configuration -- the base three-year run re-run with "
                "the reserve staked, at the selected staked_fraction/stake_min_ton and "
                "DECISIONS.md D-151's own leg behaviour (leg 2 available). The prefix names "
                "the RATCHET's tsTON reserve, never D-168's PRIMES staking."
            ),
            "staked_reserve_cost_ton": staking["chosen_configuration"]["final_staked_cost_ton"],
            "staked_reserve_harvested_tston": staking["chosen_configuration"]["harvested_tston"],
            "staked_reserve_fees_paid_ton": staking["chosen_configuration"]["staking_fees_paid_ton"],
            "staked_reserve_realized_slippage_ton":
                staking["chosen_configuration"]["realized_slippage_ton"],
        },
    }


#: Fields that differ on every run by construction, so `--check` must not read them as drift.
VOLATILE_PARAM_FIELDS = (("_meta", "generated_at"),)


def params_drift(fresh_path: str, committed_path: str) -> list[str]:
    """Unified diff between two params.json files, ignoring VOLATILE_PARAM_FIELDS.
    Compared as parsed JSON re-dumped canonically, so CRLF and whitespace never count.
    Empty list = no drift."""
    import difflib

    def canon(path):
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        for block, key in VOLATILE_PARAM_FIELDS:
            if isinstance(d.get(block), dict):
                d[block].pop(key, None)
        return json.dumps(d, indent=2, sort_keys=True).splitlines()

    return list(difflib.unified_diff(canon(committed_path), canon(fresh_path),
                                     "committed/shared/params.json", "regenerated", lineterm=""))


def check(committed_path: str = PARAMS_PATH, run=main) -> int:
    """`--check`: regenerate into a temp file and diff it against the committed copy,
    which is never written. 1 on drift or on a failing run, 0 when the file is current."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        fresh = os.path.join(tmp, "params.json")
        ok = run(params_path=fresh, write_docs=False)
        drift = params_drift(fresh, committed_path)
    if drift:
        print("\n".join(drift[:400]))
        print(f"\nDRIFT: {committed_path} is not what run_phase1.py regenerates "
              f"({len(drift)} diff lines). Regenerate on the box and commit, or find the change.")
        return 1
    print(f"\n{committed_path} is current.")
    return 0 if ok else 1


if __name__ == "__main__":
    if "--check" in sys.argv[1:]:
        sys.exit(check())
    ok = main()
    sys.exit(0 if ok else 1)
