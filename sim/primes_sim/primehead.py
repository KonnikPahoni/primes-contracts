"""The prime-uplift sizing that survives D-20 (UPGRADE_PLAN_V5.md SS3 item 3).

`PRIME_UPLIFT` / `PRIME_WINDOW` are sized from the observed consumability of
the window. The prime-head dwell, stall-alert and prime-quest helpers went with
the model D-20 deleted, where the head minted primes.
"""
from __future__ import annotations

import numpy as np

from .engine import Engine


def window_consumability(e: Engine, windows=(3, 4, 5, 6, 8, 10, 15)) -> dict:
    """How many further **composite** mints a prime minter actually makes --
    the constraint on `PRIME_WINDOW`, since a credit spread over a window the
    wallet never reaches is worth less than its face value."""
    order: dict[int, list[tuple[int, str]]] = {}
    for ev in e.mint_log:
        order.setdefault(ev.wallet_id, []).append((ev.mint_index, ev.kind))
    counts = []
    for wid, evs in order.items():
        evs.sort()
        for i, (_, kind) in enumerate(evs):
            if kind == "prime":
                after = sum(1 for _, k2 in evs[i + 1:] if k2 == "composite")
                counts.append(after)
    if not counts:
        return {"error": "no prime mints"}
    arr = np.array(counts, dtype=float)
    return {
        "prime_mints_observed": int(arr.size),
        "mean_subsequent_composite_mints": float(arr.mean()),
        "median": float(np.median(arr)),
        "p25": float(np.quantile(arr, 0.25)),
        "p75": float(np.quantile(arr, 0.75)),
        "share_reaching_5": float((arr >= 5).mean()),
        "share_reaching_10": float((arr >= 10).mean()),
        "expected_consumed_at_window": {
            str(w): float(np.minimum(arr, w).mean()) for w in windows
        },
    }


def realistic_window_consumption(w: int, lam: float = 2.6) -> float:
    """E[min(w, M)] where a wallet's lifetime mint count is `M = 1 + Poisson(lam)`.

    The simulation's own wallet pool mints far more than a real wallet will
    (a few hundred wallets absorb hundreds of thousands of mints), so using the
    in-sim count would flatter a long window. The Poisson prior is stated as a
    prior; it was shared with the retired patronage.py's recruit mint count.
    """
    from math import exp, factorial
    total = 0.0
    for j in range(0, 60):
        pj = exp(-lam) * lam ** j / factorial(j)
        total += pj * min(w, 1 + j)
    return total


def size_prime_uplift(e: Engine, k_max_at_range_top: float, margin: float = 0.30,
                      grid_uplift=(0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10),
                      grid_window=(3, 4, 5, 6, 8, 10, 15), beta_composite: float = 0.65,
                      lam: float = 2.6) -> dict:
    """Calibrate (PRIME_UPLIFT, PRIME_WINDOW) rather than confirm 0.06/5.

    Two constraints, both structural rather than tuned:

      C1 **spendability** -- `PRIME_UPLIFT <= K_CEIL - k_max(n0)`. Below the
         k_max anchor the base curve sits at its cap, so the headroom to
         `K_CEIL` is only `0.95 - 0.90 = 0.05`; an uplift larger than that is
         clipped on exactly the mints a fresh prime minter makes first. SS5.1's
         own table shows this happening to the proposed 0.06 (credit 0.163
         instead of 0.195 at n <= 1000).
      C2 **the SS5.1 invariant with margin** --
         `PRIME_UPLIFT * PRIME_WINDOW <= (1-margin) * k_max(n)` at the top of
         the simulated range. The doc's own pair carries 0.30 against 0.45 at
         n = 1e6, a 33% margin; 30% is used here.

    Objective: maximise the credit a minter actually **realises**,
    `PRIME_UPLIFT * E[min(W, further composite mints)] * beta`, which stops the
    search from lengthening the window for free.
    """
    cons = window_consumability(e)
    k_ceil = e.p.uplifts.k_ceil
    spendability_cap = k_ceil - e.p.k_max_cap
    rows = []
    for u in grid_uplift:
        for w in grid_window:
            c1 = u <= spendability_cap + 1e-12
            c2 = u * w <= (1.0 - margin) * k_max_at_range_top + 1e-12
            consumed = realistic_window_consumption(w, lam)
            # `None`, not float("nan"): this is the "no in-sim observation at this
            # window" sentinel and it has to survive `json.dump` into a file the TS
            # side parses. Python emits bare `NaN`, which is not JSON -- every
            # non-Python consumer of shared/params.json (the contract cross-check,
            # the backend, the webapp) fails on it, and the file is declared the
            # single source of truth for all of them.
            raw_in_sim = cons.get("expected_consumed_at_window", {}).get(str(w))
            in_sim = float(raw_in_sim) if raw_in_sim is not None else None
            realised = u * consumed * beta_composite
            rows.append({
                "prime_uplift": u, "prime_window": w,
                "uplift_x_window": round(u * w, 4),
                "feasible": bool(c1 and c2),
                "c1_spendable_at_n0": bool(c1),
                "c2_invariant_with_margin": bool(c2),
                "expected_consumed_mints_prior": consumed,
                "expected_consumed_mints_in_sim": in_sim,
                "realised_credit_ton": realised,
                "face_credit_ton": u * w * beta_composite,
            })
    feas = [r for r in rows if r["feasible"]]
    best = max(feas, key=lambda r: (round(r["realised_credit_ton"], 9), -r["prime_window"])) if feas else None
    return {
        "k_max_at_range_top": k_max_at_range_top,
        "margin_required": margin,
        "spendability_cap_k_ceil_minus_k_max_n0": spendability_cap,
        "mint_count_prior_lambda": lam,
        "consumability_in_sim": cons,
        "grid": rows,
        "selected": best,
        "documented_proposal": {"prime_uplift": 0.06, "prime_window": 5,
                                "spendable_at_n0": 0.06 <= spendability_cap},
    }
