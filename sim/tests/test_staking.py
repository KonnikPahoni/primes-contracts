"""DECISIONS.md D-151 / STAKING_PLAN.md P1 -- the ratchet's staked reserve.

Four properties, and they are the four the ratchet theorem rests on:

  * `T = seeded + swapped + liquid + staked_cost + exiting` at the end of a run
    (the engine asserts it at every step; this pins the ends);
  * staking moves GRAM between terms of `T` and NEVER changes `T` itself, so a
    staked run's floor is identical to an unstaked one's -- the flat pool fees
    are paid from the gas buffer and the yield lands outside `T` (D-151 point 2
    and point 4). A leg-2 haircut is the ONE exception and it is a realized
    loss, published as such;
  * yield is a pure integral of the cost basis, so the APR sweep is exact;
  * `reserve_days` does what it says: liquid tracks N days of the flush ceiling.
"""
from __future__ import annotations

import pytest

from primes_sim.engine import DAY, Engine, SimParams, StakingParams, YEAR_SECONDS

BASE = dict(
    seed=20260814,
    horizon_days=120.0,
    n_max=200_000,
    history_every_n_mints=2000,
    genesis_donation_ton=4.20,
    genesis_seed_ton=200.0,
    bounty_vault_pct_of_lp=5.0,
    genesis_lp_primes_per_ton=10_000.0,
)


def _run(**staking) -> Engine:
    stk = StakingParams(enabled=True, **staking) if staking else StakingParams()
    return Engine(SimParams(staking=stk, **BASE)).run()


@pytest.fixture(scope="module")
def staked() -> Engine:
    return _run(reserve_days=1.0, stake_min_ton=100.0, apr=0.04)


@pytest.fixture(scope="module")
def unstaked() -> Engine:
    return _run()


def test_t_identity_holds_at_the_end(staked):
    e = staked
    assert e.staked_cost > 0, "the fixture must actually stake something"
    e._assert_t_identity()
    assert e.liquid + e.staked_cost + e.exiting == pytest.approx(e.pending)


def test_staking_does_not_move_T(staked, unstaked):
    """The whole point. `T` is the numerator of `p_f = T/S`, so anything staking
    took out of it would be a floor that fell -- which is the ratchet theorem
    broken, not a fee."""
    assert staked.realized_slippage_ton == 0.0
    assert staked.T == pytest.approx(unstaked.T)
    assert staked.S == pytest.approx(unstaked.S)
    assert staked.floor_price == pytest.approx(unstaked.floor_price)


def test_fees_and_yield_are_off_book(staked):
    stk = staked.p.staking
    assert staked.staking_fees_paid == pytest.approx(staked.stake_events * stk.deposit_fee_ton
                                                     + staked.exit_events * stk.exit_fee_ton)
    assert staked.accrued_yield + staked.harvested_tston > 0
    # Neither term is inside `pending`, which is what "never enters T" means
    # once it is written as arithmetic.
    assert staked.pending == pytest.approx(staked.liquid + staked.staked_cost
                                           + staked.exiting)


def test_yield_is_the_integral_the_apr_sweep_assumes(staked):
    """`accrued(apr) = staked_ton_seconds * apr / year` -- why run_phase1.py
    sweeps the APR arithmetically instead of running the model three times."""
    total = staked.accrued_yield + staked.harvested_tston
    assert total == pytest.approx(
        staked.staked_ton_seconds * staked.p.staking.apr / YEAR_SECONDS, rel=1e-9
    )


def test_reserve_days_sizes_the_liquid_part(staked):
    """N days of the flush ceiling, held back and not staked."""
    ceiling = min(staked.pending,
                  max(staked.p.flush_pct * staked.pending, staked.p.flush_min_ton))
    assert staked.reserve_target == pytest.approx(1.0 * ceiling)
    # Liquid sits between the target and the target plus one stake minimum: the
    # excess above that would have been staked at the last poke.
    assert staked.reserve_target - 1e-6 <= staked.liquid
    assert staked.liquid <= staked.reserve_target + staked.p.staking.stake_min_ton


def test_more_reserve_days_stakes_less():
    a = _run(reserve_days=1.0, stake_min_ton=100.0)
    b = _run(reserve_days=3.0, stake_min_ton=100.0)
    assert a.staked_cost > b.staked_cost
    assert a.pending == pytest.approx(b.pending)


def test_disabled_is_the_old_engine(unstaked):
    assert (unstaked.staked_cost, unstaked.exiting, unstaked.accrued_yield) == (0.0, 0.0, 0.0)
    assert unstaked.staking_fees_paid == 0.0
    assert unstaked.liquid == pytest.approx(unstaked.pending)


def test_an_exit_that_cannot_fill_instantly_is_unmet():
    """Leg 3 is the only thing that produces `unmet_flush_ton`, so it is forced
    here rather than waited for: both instant legs off, every exit is the ~36 h
    bill."""
    e = Engine(SimParams(staking=StakingParams(enabled=True), **BASE))
    e.T, e.pending = 1_004.2, 1_000.0
    e.staked_cost, e._stake_last_t = 900.0, 0.0
    e.p.staking.leg1_fill_prob = 0.0
    e.p.staking.leg2_fill_prob = 0.0
    served = e._fundable_flush(500.0, 10 * DAY)
    assert served == pytest.approx(100.0)
    assert e.unmet_flush_ton == pytest.approx(400.0)
    assert e.exit_leg_counts[3] == 1
    e._assert_t_identity()
    # The exit is sized to restore the RESERVE, not merely the shortfall: at the
    # default 3 reserve-days the target is 3 * 0.2 * 1000 = 600 GRAM, so 500 is
    # brought back and the next consecutive flush day pays no withdrawal fee.
    assert e.exiting == pytest.approx(500.0)
    # ... and it lands after the latency, at the exact rate.
    e._land_exits(10 * DAY + 2 * DAY)
    assert e.exiting == 0.0
    assert e.liquid == pytest.approx(600.0)
    assert e.staked_cost == pytest.approx(400.0)
    assert e.T == pytest.approx(1_004.2)
