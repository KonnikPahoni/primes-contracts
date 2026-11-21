"""DECISIONS.md D-156 / CONCEPT.md SS5 -- the logistic supply cap.

  * the taper is the plain factor `(S_MAX - S)/S_MAX`, clamped into [0, 1] at
    both ends, so `k` only ever SHRINKS -- which is what keeps SS5's `k < 1`
    invariant and the ratchet theorem intact without reworking either;
  * `S` is bounded above by `S_MAX` under the recurrence SS5 actually runs
    (`S <- S*(1 + k*taper*beta/T)`), and approaches it without reaching it;
  * the taper is INVISIBLE where the game lives -- at the 3-year horizon's
    measured `S` it costs single-digit percent, which is the whole reason the
    `2.7/log10(n)` curve was multiplied rather than replaced;
  * the un-tapered recurrence DIVERGES over the same span, which is the defect
    D-156 exists to close.
"""
from __future__ import annotations

import math

import pytest

from primes_sim import economics as econ

S_MAX = econ.S_MAX_PRIMES
S0 = 11_000_000.0          # genesis supply, params.json genesis_supply_primes (D-166)
S_HORIZON = 39_382_039.0   # params.json final_state.final_S_primes, 3-year run (D-166 regen)


def test_s_max_is_the_signed_figure():
    """D-156 is 1.2e9 PRIMES, owner-set at 100x the then-12,000,000 genesis supply.
    D-166 moved S0 to 11,000,000 and left S_MAX alone, so it is not a multiple of
    S0 any more. A drift here is a parameter change."""
    assert S_MAX == 1_200_000_000.0


@pytest.mark.parametrize("s", [0.0, 1.0, S0, S_HORIZON, S_MAX * 0.5, S_MAX - 1.0])
def test_taper_is_in_unit_interval(s):
    """`k_eff = k * taper` may only shrink `k`, never grow it or flip its sign."""
    f = econ.supply_taper(s, S_MAX)
    assert 0.0 <= f <= 1.0


def test_taper_closes_at_and_beyond_the_cap():
    assert econ.supply_taper(S_MAX, S_MAX) == 0.0
    assert econ.supply_taper(S_MAX * 2, S_MAX) == 0.0


def test_taper_is_monotone_decreasing_in_S():
    xs = [0.0, S0, S_HORIZON, 3e8, 6e8, 9e8, S_MAX]
    fs = [econ.supply_taper(x, S_MAX) for x in xs]
    assert all(a >= b for a, b in zip(fs, fs[1:]))


def test_taper_is_invisible_over_the_modelled_horizon():
    """The design claim: >=95% of the rebate survives at the 3-year `S`.

    If this fails, `S_MAX` was set too low and D-156's "invisible where the game
    lives" argument no longer holds -- that is a decision to re-open, not a
    number to relax.
    """
    assert econ.supply_taper(S_HORIZON, S_MAX) > 0.95


def _run(tapered: bool, mints: int = 400_000) -> float:
    """SS5's own recurrence, coarsely: `dS/S = k*beta/T` with `T` linear in mints.

    Not a replacement for the engine -- it is the smallest thing that exhibits
    the divergence, so the bound is tested against the mechanism rather than
    against a fixture.
    """
    s, t, beta = S0, 200.0, 0.45
    for m in range(2, mints):
        k = min(0.95, max(0.2, 2.7 / math.log10(max(m, 10))))
        if tapered:
            k *= econ.supply_taper(s, S_MAX)
        s *= 1.0 + k * beta / t
        t += beta
    return s


def test_tapered_emission_stays_under_the_cap():
    assert _run(tapered=True) < S_MAX


def test_untapered_emission_blows_through_the_cap():
    """The defect, stated as a test: without the taper the same span exceeds
    `S_MAX`, so the cap is a real constraint and not decoration."""
    assert _run(tapered=False) > S_MAX


def test_taper_degenerates_safely_on_a_zero_cap():
    """`s_max <= 0` means "no cap configured" and must not zero every rebate."""
    assert econ.supply_taper(1.0, 0.0) == 1.0

