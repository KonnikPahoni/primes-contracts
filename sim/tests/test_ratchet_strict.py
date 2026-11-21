"""CONCEPT.md §5 at ENGINE level, per mint, under the hardest settings the theorem has.

`test_engine.py::test_floor_monotone_nondecreasing` samples the history every 50 mints
and allows a 1e-12 fall; `test_supply_cap.py` bounds `S` on a toy recurrence. Neither
looks at the mint the theorem is about. These run the real `Engine._do_mint` and check
every single one:

  * §5 theorem: `p_f' > p_f` STRICTLY on every mint, with `k` pinned at the `K_CEIL`
    clamp (every uplift saturated), all three §4.1 invite transfers on every mint (β at
    its 0.25 worst case on a referred composite), and the D-156 taper both slack and
    binding. The slack case is the hard one: the taper only ever shrinks `k`.
  * D-156 cap with `s_max = S0 * 1.001`: the taper drives every composite `k` below
    `k_min` (the ordering that stops the floor defeating the cap), `S < s_max` after every
    mint, and a prime mint's `k` is exactly 0 (§5.1).

Every override below is a test-only `SimParams` field; `shared/params.json` and the
economic constants are untouched. `k_ceil` stays at its signed 0.95.
"""
from __future__ import annotations

from dataclasses import replace

import pytest

from primes_sim import economics as econ
from primes_sim.engine import Engine, PrimeHeadParams, SimParams

K_CEIL = econ.UpliftParams().k_ceil


class _PerMint(Engine):
    """The real engine, recording the floor either side of each `_do_mint`."""

    def _do_mint(self, *a, **kw):
        before = self.floor_price
        ev = super()._do_mint(*a, **kw)
        self.steps.append((before, self.floor_price, ev))
        return ev


def _run(p: SimParams) -> _PerMint:
    e = _PerMint(p)
    e.steps = []
    e.run()
    return e


def _params(**kw) -> SimParams:
    base = dict(seed=7, horizon_days=20, n_max=5000, history_every_n_mints=50,
                prime_head=PrimeHeadParams(npv_horizon=5000))
    base.update(kw)
    return SimParams(**base)


def _s0() -> float:
    """S0 as the engine computes it (the seed, before the donor's mint). It does not
    depend on `s_max`, so one construction gives the anchor for the capped run."""
    return Engine(_params()).genesis_supply_primes


# ---- §5: strict increase, per mint ------------------------------------------------- #

# Every wallet's summed uplifts exceed K_CEIL, so the clamp binds on every mint; a
# near-zero ramp makes k(t) reach that clamped k_max on any positive gap.
SATURATED = econ.UpliftParams(recruit_rank_uplifts=(K_CEIL,) * 6)


@pytest.mark.parametrize("taper", ["slack", "binding"])
@pytest.mark.parametrize("primes_skip_head", [True, False])
def test_floor_rises_strictly_on_every_mint(taper, primes_skip_head):
    kw = dict(uplifts=SATURATED, ramp_seconds=1e-6, invite_optin_rate=1.0,
              primes_skip_head=primes_skip_head,
              prime_head=PrimeHeadParams(npv_horizon=5000, enabled=False))
    if taper == "binding":
        kw["s_max"] = 2.0 * _s0()   # taper starts near 0.5 and falls from there
    e = _run(_params(**kw))
    steps = e.steps
    assert len(steps) > 1000, "too few mints for the run to mean anything"

    evs = [ev for _, _, ev in steps]
    assert all(ev.invite_count == econ.INVITE_MAX_COUNT for ev in evs)
    assert all(ev.k_clamped and ev.k_max_effective == K_CEIL for ev in evs)
    assert e.k_clamp_hits == e.k_clamp_eligible
    # The saturated k actually reaches the emission site: some composite mints at the
    # clamp itself (times the taper), not at k_min.
    comps = [ev for ev in evs if ev.kind == "composite"]
    taper_at = lambda ev: econ.supply_taper(ev.S_after - ev.rebate_primes, e.p.s_max)
    assert any(ev.k == pytest.approx(K_CEIL * taper_at(ev), rel=1e-12) for ev in comps)
    assert min(ev.beta for ev in comps) == pytest.approx(0.25, abs=1e-9), "β worst case not reached"
    if taper == "binding":
        assert max(taper_at(ev) for ev in comps) < 0.6

    falls = [(i, b, a, ev.n, ev.kind, ev.k, ev.beta)
             for i, (b, a, ev) in enumerate(steps) if not a > b]
    assert not falls, f"{len(falls)} mint(s) did not raise p_f strictly; first: {falls[:3]}"
    # ... and so the floor across the mint log is strictly increasing too.
    floors = [ev.T_after / ev.S_after for ev in evs]
    assert all(b > a for a, b in zip(floors, floors[1:]))


# ---- D-156: a cap that binds from the first mint ----------------------------------- #

@pytest.mark.parametrize("primes_skip_head", [True, False])
def test_tight_cap_holds_k_below_k_min_and_S_below_s_max(primes_skip_head):
    s_max = _s0() * 1.001
    p = _params(s_max=s_max, primes_skip_head=primes_skip_head,
                prime_head=PrimeHeadParams(npv_horizon=5000, enabled=False))
    e = _run(p)
    evs = [ev for _, _, ev in e.steps]
    comps = [ev for ev in evs if ev.kind == "composite"]
    primes = [ev for ev in evs if ev.kind == "prime"]
    assert len(comps) > 1000

    # After the taper, never at or above the floor k_min -- the taper is applied AFTER
    # the k_min clamp, so k_min cannot hold emission up against the cap.
    bad = [(ev.n, ev.k) for ev in comps if not 0.0 < ev.k < p.k_min]
    assert not bad, f"composite k outside (0, k_min={p.k_min}): {bad[:5]}"
    assert all(ev.S_after < s_max for ev in evs)
    assert e.S < s_max
    assert e.deploy_supply_primes < s_max
    if primes_skip_head:
        assert not primes, "D-20: the head never mints a prime"
    else:
        assert primes, "the legacy path should mint primes at the head"
        assert all(ev.k == 0.0 and ev.rebate_primes == 0.0 for ev in primes)
