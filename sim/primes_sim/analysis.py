"""Post-run analysis: tribute-by-prime series, AMM-vs-floor detachment,
sandwich profitability, owed-dict ceiling check (CLAUDE.md "Measured provenance"
Spike 4), and auction reference-price derivation.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .engine import Engine, DAY

# Phase 0 Spike 4 finding (CLAUDE.md "Measured provenance"): the `owed` dict, stored as
# a single map in the bank's own account state, hits config param 43
# (max_acc_state_cells = 65536, ~2.0 cells/entry) at n ~= 386,093.
OWED_CEILING_N = 386_093


def history_df(e: Engine) -> pd.DataFrame:
    return pd.DataFrame(e.history)


def mintlog_df(e: Engine) -> pd.DataFrame:
    rows = [
        {
            "n": ev.n,
            "kind": ev.kind,
            "t_days": ev.t / DAY,
            "archetype": ev.archetype,
            "wallet_id": ev.wallet_id,
            "referred": ev.referred,
            "k": ev.k,
            "pool_injection": ev.pool_injection,
            "rebate_primes": ev.rebate_primes,
            "tribute_paid": ev.tribute_paid,
        }
        for ev in e.mint_log
    ]
    return pd.DataFrame(rows)


def owed_ceiling_report(e: Engine) -> dict:
    final_head = e.head - 1
    hist = history_df(e)
    crossing = hist[hist["head"] >= OWED_CEILING_N]
    crossed = not crossing.empty
    day_crossed = float(crossing.iloc[0]["t_days"]) if crossed else None
    return {
        "owed_ceiling_n": OWED_CEILING_N,
        "final_head_reached": final_head,
        "horizon_days": e.p.horizon_days,
        "crossed_within_horizon": crossed,
        "day_crossed": day_crossed,
        "pct_of_horizon_at_crossing": (day_crossed / e.p.horizon_days * 100.0) if crossed else None,
    }


def annualized_tribute_yield(e: Engine, window_days: float = 90.0) -> dict:
    """Approximate tribute run-rate for each auction prime using mint-log
    records: sum tribute recorded within the last `window_days` of sim time,
    scaled to a year. Requires per-mint recipient attribution, which the
    engine doesn't log directly (only aggregate tribute_paid per mint), so
    this recomputes recipient shares by replaying factorization -- cheap
    relative to the run itself since we only touch the tail window.
    """
    total_days = e.p.horizon_days
    cutoff = max(0.0, total_days - window_days)
    per_prime = {p: 0.0 for p in e.p.reference_primes}
    exponent_p = e.p.split.divisor_exponent
    f = e.p.split.flat_dividend_f
    div_line = e.p.split.tribute_pct * (1.0 - f)
    log = e.mint_log
    for i in range(len(log) - 1, -1, -1):
        ev = log[i]
        if ev.t / DAY < cutoff:
            break
        # SS3.2 flat dividend: the accumulator's step on this mint, which is
        # right under D-20 too, where no prime ever appears in the mint log.
        step = ev.div_acc_after - (log[i - 1].div_acc_after if i else 0.0)
        for prime in e.p.reference_primes:
            per_prime[prime] += step
        if ev.kind != "composite":
            continue
        factors = e.sieve.factorize(ev.n)
        weights = {p: ex * (p ** exponent_p) for p, ex in factors.items()}
        total_w = sum(weights.values())
        if total_w <= 0:
            continue
        for prime in e.p.reference_primes:
            if prime in weights:
                per_prime[prime] += (weights[prime] / total_w) * div_line
    span = min(window_days, total_days)
    scale = 365.0 / span if span > 0 else 0.0
    return {p: v * scale for p, v in per_prime.items()}


def discounted_tribute_npv_by_prime(e: Engine, discount_rate: float = 0.35) -> dict:
    """Sum of *actually simulated* per-mint tribute cash flows to each
    genesis auction prime's owner, discounted back to genesis at
    `discount_rate` (annualized), replaying real mint timing rather than
    extrapolating a terminal run-rate forward (which would double-count the
    arrival process's modeled growth and badly overstate genesis-day fair
    value). This walks the *entire* mint log once -- more expensive than
    the tail-window yield check but only run for the reserve-setting passes.
    """
    npv = {p: 0.0 for p in e.p.reference_primes}
    exponent_p = e.p.split.divisor_exponent
    f = e.p.split.flat_dividend_f
    div_line = e.p.split.tribute_pct * (1.0 - f)
    prev_acc = 0.0
    for ev in e.mint_log:
        years = ev.t / DAY / 365.0
        disc = 1.0 / ((1 + discount_rate) ** years)
        # SS3.2 flat dividend: the accumulator's step on this mint (see
        # `annualized_tribute_yield`).
        step, prev_acc = ev.div_acc_after - prev_acc, ev.div_acc_after
        for prime in e.p.reference_primes:
            npv[prime] += step * disc
        if ev.kind == "prime":
            continue
        factors = e.sieve.factorize(ev.n)
        weights = {p: ex * (p ** exponent_p) for p, ex in factors.items()}
        total_w = sum(weights.values())
        if total_w <= 0:
            continue
        for prime in e.p.reference_primes:
            if prime in weights:
                npv[prime] += (weights[prime] / total_w) * div_line * disc
    return npv


def auction_value_comparison(horizon: int, auction_set=(2, 3, 5, 7, 11, 13),
                             f: float = 0.20, tribute_pct: float = 0.10,
                             discount_rate: float = 0.35,
                             mints_per_year: float = 30_000.0) -> dict:
    """SS10/SS12: report the **auction-side loss** from the `sqrt(p)` weighting
    as explicitly as the tail-side gain. Compares each blue chip's discounted
    lifetime tribute under v4 economics (flat exponent, no flat dividend)
    against v5 (`e*sqrt(p)` on 80%, flat dividend on 20%)."""
    from . import tribute as tr
    spf = tr.spf_sieve(horizon)
    v4 = tr.prime_tribute_npv(horizon, spf, exponent=0.0, f=0.0,
                              tribute_pct=tribute_pct, discount_rate_annual=discount_rate,
                              mints_per_year=mints_per_year)["npv"]
    v5 = tr.prime_tribute_npv(horizon, spf, exponent=0.5, f=f, tribute_pct=tribute_pct,
                              discount_rate_annual=discount_rate,
                              mints_per_year=mints_per_year)["npv"]
    rows = {}
    for p in auction_set:
        a, b = v4.get(p, 0.0), v5.get(p, 0.0)
        rows[p] = {"v4_flat_exponent_npv_ton": a, "v5_sqrt_p_npv_ton": b,
                   "change_pct": ((b - a) / a * 100.0) if a else None}
    return {
        "horizon": horizon,
        "blue_chips": rows,
        "v4_total_ton": sum(v["v4_flat_exponent_npv_ton"] for v in rows.values()),
        "v5_total_ton": sum(v["v5_sqrt_p_npv_ton"] for v in rows.values()),
        "_note": "exponent 0 reproduces v4's flat `e` weighting (w = e * p**0).",
    }


def auction_reference_prices(
    npv_by_prime: dict, annualized_yield: dict | None = None, margin: float = 0.5
) -> dict:
    """Auction reference/reserve price per genesis prime.

    `npv_by_prime` (from discounted_tribute_npv_by_prime) is the sum of
    *actually simulated* tribute cash flows to that prime's owner over the
    whole run, discounted back to genesis at the function's discount rate --
    this is the per-prime NPV that P0(p) and the resting price read (CONCEPT.md SS6). The
    reserve is set at `margin` (<1) of that NPV so real measured tribute
    income justifies the reserve with headroom (CONCEPT.md SS6, SS10 kill
    criterion), leaving bidders NPV-implied upside above the floor.
    """
    out = {}
    for prime, npv in npv_by_prime.items():
        out[prime] = {
            "npv_ton": npv,
            "reference_reserve_ton": npv * margin,
        }
        if annualized_yield is not None and prime in annualized_yield:
            out[prime]["annualized_tribute_yield_ton_final_quarter"] = annualized_yield[prime]
    return out


def amm_vs_floor_detachment(e: Engine, tolerance: float = 0.0) -> dict:
    hist = history_df(e)
    hist = hist[hist["S"] > 0]
    below = hist["amm_price"] < hist["floor_price"] * (1 - tolerance)
    frac_time_below = float(below.mean()) if len(hist) else 0.0
    # longest consecutive run of history samples below floor
    max_run = 0
    run = 0
    for b in below:
        if b:
            run += 1
            max_run = max(max_run, run)
        else:
            run = 0
    sample_spacing_days = (
        (hist["t_days"].iloc[-1] - hist["t_days"].iloc[0]) / max(len(hist) - 1, 1) if len(hist) > 1 else 0.0
    )
    return {
        "fraction_of_samples_below_floor": frac_time_below,
        "max_consecutive_samples_below_floor": int(max_run),
        "approx_max_consecutive_days_below_floor": max_run * sample_spacing_days,
        "min_amm_price": float(hist["amm_price"].min()) if len(hist) else None,
        "min_floor_price": float(hist["floor_price"].min()) if len(hist) else None,
        "final_amm_price": float(hist["amm_price"].iloc[-1]) if len(hist) else None,
        "final_floor_price": float(hist["floor_price"].iloc[-1]) if len(hist) else None,
    }


def sandwich_profitability(e: Engine) -> dict:
    """Re-measured under the floor guard (UPGRADE_PLAN_V5.md SS3 item 7).

    The v4 number in shared/params.json was measured against a swap with
    `min_out = 1` -- i.e. no guard at all -- and must not be reused. Under
    `min_out = amount*S/T` the guard caps the ratchet's average fill at `p_f`,
    and nothing more: while the market is under the floor, an attacker who is
    also the caller (D-143 lets it size the tranche) pumps, sizes the flush to
    the pumped pool, and sells back (D-190). What that costs is burn efficiency
    -- PRIMES not burned per GRAM spent -- never `T`, `S` or `p_f`.
    """
    total_flushed = e.swapped
    return {
        "guard_enabled": e.p.floor_guard_enabled,
        "floor_guard": e.p.floor_guard,
        "sandwich_events": e.sandwich_events,
        "sandwich_attacks_declined_as_unprofitable": e.sandwich_declined_events,
        "sandwich_net_pnl_ton": e.sandwich_net_pnl_ton,
        "sandwich_gross_profit_on_winning_events_ton": e.sandwich_gross_profit_ton,
        "flushes_bounced_while_sandwiched": e.sandwich_bounced_flushes,
        "avg_net_pnl_per_event_ton": (e.sandwich_net_pnl_ton / e.sandwich_events) if e.sandwich_events else 0.0,
        "total_swapped_ton": total_flushed,
        "net_pnl_pct_of_swapped": (e.sandwich_net_pnl_ton / total_flushed * 100.0) if total_flushed > 0 else None,
        "flush_attempts": e.flush_attempts,
        "flush_fills": e.flush_fills,
        "flush_bounces": e.flush_bounces,
    }


def pending_growth_report(e: Engine) -> dict:
    """SS10/SS4.3.1: how large the ratchet's balance grows in a market that
    stays above the floor for months. This is a design output, not a queue."""
    hist = history_df(e)
    if hist.empty:
        return {}
    final_T = float(hist["T"].iloc[-1])
    return {
        "final_pending_ton": float(hist["pending"].iloc[-1]),
        "peak_pending_ton": e.pending_peak,
        "final_swapped_ton": float(hist["swapped"].iloc[-1]),
        "final_T_ton": final_T,
        "pending_share_of_T": float(hist["pending"].iloc[-1]) / final_T if final_T else None,
        "flush_attempts": e.flush_attempts,
        "flush_fills": e.flush_fills,
        "flush_bounces": e.flush_bounces,
        "fill_rate": e.flush_fills / e.flush_attempts if e.flush_attempts else None,
        "last_flush_outcome": e.last_flush_outcome,
        "external_buy_ton_per_day": e.p.external_buy_ton_per_day,
        "external_bought_ton": e.external_bought_ton,
        "days_simulated": float(hist["t_days"].iloc[-1]),
        "pending_growth_ton_per_day": (
            float(hist["pending"].iloc[-1]) / float(hist["t_days"].iloc[-1])
            if float(hist["t_days"].iloc[-1]) > 0 else None
        ),
        "_note": (
            "Under the floor guard a fill requires the market to be at or below the "
            "floor. In a market that stays above it, `pending` is not a backlog: it is "
            "the protocol's standing bid, and it counts in T either way (SS5)."
        ),
    }


def ton_to_lift_price(pool, target_price: float) -> float:
    """GRAM that must be bought into a constant-product pool to raise its spot
    price to `target_price`. x'/y' = target with x'y' = k (ignoring fee)."""
    x, y = pool.ton_reserve, pool.primes_reserve
    if x <= 0 or y <= 0 or target_price <= 0:
        return 0.0
    k = x * y
    x_target = math.sqrt(k * target_price)
    return max(x_target - x, 0.0)


def guard_can_close_detachment(e: Engine) -> dict:
    """SS4.3.1's claim, measured: when the AMM sits below the floor, is the
    ratchet's accumulated balance enough to buy the gap closed?"""
    hist = history_df(e)
    hist = hist[hist["S"] > 0]
    below = hist[hist["amm_price"] < hist["floor_price"]]
    if below.empty:
        return {
            "detachment_observed": False,
            "balance_sufficient": True,
            "_note": "AMM never sampled below the floor in this run.",
        }
    worst = below.loc[(below["floor_price"] - below["amm_price"]).idxmax()]
    from .amm import Pool
    proxy = Pool(
        ton_reserve=float(worst["pool_ton_reserve"]),
        primes_reserve=float(worst["pool_primes_reserve"]),
        fee=e.p.amm_fee,
    )
    need = ton_to_lift_price(proxy, float(worst["floor_price"]))
    have = float(worst["pending"])
    return {
        "detachment_observed": True,
        "worst_sample_day": float(worst["t_days"]),
        "amm_price_at_worst": float(worst["amm_price"]),
        "floor_price_at_worst": float(worst["floor_price"]),
        "ton_needed_to_close_ton": need,
        "pending_available_ton": have,
        "balance_sufficient": bool(have >= need),
        "coverage_x": (have / need) if need > 0 else None,
    }


def uplift_clamp_report(e: Engine) -> dict:
    return {
        "k_ceil": e.p.uplifts.k_ceil,
        "mints_evaluated": e.k_clamp_eligible,
        "mints_where_clamp_bound": e.k_clamp_hits,
        "clamp_bind_rate": e.k_clamp_hits / e.k_clamp_eligible if e.k_clamp_eligible else None,
        "max_k_observed": max((ev.k for ev in e.mint_log), default=None),
        "max_k_max_effective_observed": max((ev.k_max_effective for ev in e.mint_log), default=None),
    }


def floor_trajectory(e: Engine, points: int = 12) -> list[dict]:
    hist = history_df(e)
    if hist.empty:
        return []
    idx = np.linspace(0, len(hist) - 1, min(points, len(hist))).astype(int)
    return [
        {
            "t_days": float(hist["t_days"].iloc[i]),
            "head": int(hist["head"].iloc[i]),
            "floor_price": float(hist["floor_price"].iloc[i]),
            "T": float(hist["T"].iloc[i]),
            "S": float(hist["S"].iloc[i]),
        }
        for i in idx
    ]
