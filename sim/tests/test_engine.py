"""Phase 1 engine sanity tests: small, fast runs (not the full calibration
passes in scripts/run_phase1.py) that check the invariants CONCEPT.md claims
actually hold in the simulation code.
"""
from __future__ import annotations

import pytest

from primes_sim.economics import SplitParams, split_mint, k_of_t, k_max_of_n
from primes_sim.engine import Engine, PrimeHeadParams, SimParams


def _small_engine(seed=1, horizon_days=20, n_max=5000):
    p = SimParams(
        seed=seed,
        horizon_days=horizon_days,
        n_max=n_max,
        history_every_n_mints=50,
        prime_head=PrimeHeadParams(npv_horizon=5000),
    )
    e = Engine(p)
    e.run()
    return e


def test_split_sums_to_price():
    result = split_mint(1.0, {1: 1.0}, referral_owner=2, params=SplitParams(),
                        minted_primes_count=10)
    total = (
        result.tribute_paid
        + result.flat_dividend
        + result.referral_paid
        + result.treasury
        + result.gas_ops
        + result.pool_injection
    )
    assert abs(total - 1.0) < 1e-9


def test_k_bounds():
    # D-98: a LINEAR ramp -- k_min at t=0, exactly halfway up the band at half the
    # ramp, exactly k_max at the ramp, and pinned there forever after.
    assert k_of_t(0, 0.2, 0.9, 3600) == 0.2
    assert k_of_t(1800, 0.2, 0.9, 3600) == pytest.approx(0.55)
    assert k_of_t(3600, 0.2, 0.9, 3600) == pytest.approx(0.9)
    assert k_of_t(1e9, 0.2, 0.9, 3600) == pytest.approx(0.9)


def test_k_max_clamped_at_k_min():
    # even at astronomically large n, k_max never drops below k_min
    assert k_max_of_n(10**24, 1000, 0.9, 0.2) >= 0.2


def test_floor_monotone_nondecreasing():
    e = _small_engine()
    hist = e.history
    floors = [h["floor_price"] for h in hist]
    assert all(b >= a - 1e-12 for a, b in zip(floors, floors[1:]))


def test_S_never_decreases():
    e = _small_engine()
    s_values = [h["S"] for h in e.history]
    assert all(b >= a - 1e-9 for a, b in zip(s_values, s_values[1:]))


def test_burns_are_counted_and_never_touch_S():
    """CONCEPT SS3.3 / SS11.21: burning removes tokens from circulation and leaves
    `S` alone. Both halves are asserted, because the pair is what makes the
    dashboard's two-number report meaningful -- a burn that moved `S` would move
    the floor, and an uncounted burn cannot be reported at all."""
    e = _small_engine(horizon_days=60)
    assert e.burned_primes >= 0.0
    assert e.burn_events == 0 or e.burned_primes > 0.0
    # S is cumulative emission: it is >= circulating at every recorded point.
    for h in e.history:
        assert h["circulating_primes"] <= h["S"] + 1e-9
        assert h["burned_primes"] >= 0.0
    assert abs(e.circulating_primes - (e.S - e.burned_primes)) < 1e-9


def test_burn_counter_only_grows():
    e = _small_engine(horizon_days=60)
    burned = [h["burned_primes"] for h in e.history]
    assert all(b >= a - 1e-9 for a, b in zip(burned, burned[1:]))


def test_deterministic_reproducible():
    e1 = _small_engine(seed=7)
    e2 = _small_engine(seed=7)
    assert e1.T == e2.T
    assert e1.S == e2.S
    assert e1.head == e2.head
    assert len(e1.mint_log) == len(e2.mint_log)
    # The whole trajectory, not four summary figures: two runs that agree on the end
    # state but differ in one mint's k, wallet or factors would pass the lines above.
    # repr, not ==, so a NaN in a history row cannot make identical runs unequal.
    assert repr(e1.mint_log) == repr(e2.mint_log)
    assert repr(e1.history) == repr(e2.history)


def test_different_seed_differs():
    e1 = _small_engine(seed=7)
    e2 = _small_engine(seed=8)
    assert e1.T != e2.T or e1.head != e2.head


def test_mint_runs_and_advances_head():
    e = _small_engine()
    assert e.head > 2
    assert len(e.mint_log) > 0


def test_deploy_floor_counts_the_donors_mint():
    """`donate_floor` mints `X*L` (D-156-tapered) to the donor while `T = 0`
    (D-100 point 1), so the deploy floor is `X / (S0 + that)`, not `X / S0`.
    The figures are the 2026-09-24 testnet genesis read-back
    (`docs/testnet-deployment.md`): S 11,000,000 -> 12,312,854.17, p_f 1.0761e-5."""
    # run_phase1.py's genesis inputs (the SimParams defaults are an older, smaller seed).
    e = Engine(SimParams(n_max=100, horizon_days=1.0, genesis_seed_ton=200.0,
                         bounty_vault_pct_of_lp=5.00, genesis_donation_ton=132.50))
    assert e.genesis_supply_primes == pytest.approx(11_000_000.0)
    assert e.genesis_donation_primes == pytest.approx(1_312_854.17, abs=0.01)
    assert e.S == pytest.approx(12_312_854.17, abs=0.01)
    assert e.floor_price_deploy == pytest.approx(1.0761e-5, rel=1e-4)
