"""UPGRADE_PLAN_V5.md SS3 items 2, 4 and 6.

  * item 2 -- zero emission on primes: `k = 0`, the tribute line falls to the
    pool, beta = 0.75 on the referred steady-state prime row, and SS4.2.1's
    ratchet-coefficient table falls out of the model;
  * item 4 -- `PRIME_UPLIFT` sized against SS5.1's headroom table, with the
    `PRIME_UPLIFT * PRIME_WINDOW < k_max(n)` invariant asserted across the
    whole simulated range;
  * item 6 -- uplift stacking: four uplifts summed, clamped **once** at
    `K_CEIL`, never reaching it.
"""
from __future__ import annotations

import pytest

from primes_sim import economics as econ
from primes_sim.engine import Engine, PrimeHeadParams, SimParams


# --------------------------------------------------------------------------- #
# item 2 -- zero emission on primes
# --------------------------------------------------------------------------- #


def test_prime_mint_tribute_falls_to_pool_and_beta_is_075():
    r = econ.split_mint(1.0, None, referral_owner=42, minted_primes_count=51,
                        is_prime_mint=True)
    assert r.tribute_paid == 0.0
    assert r.flat_dividend == 0.0
    assert r.tribute_to_pool == pytest.approx(0.10)
    assert r.pool_injection == pytest.approx(0.85 - econ.SplitParams().gas_ops_pct)  # D-117: 0.65 at the 20% line


def test_beta_table_four_rows():
    """SS4.1's beta values, computed rather than tabulated.

    SIX until D-106, which deleted the patron line and with it the phi1 rows
    (0.40 referred / 0.50 unreferred) and the phi2 rows (0.575 / 0.675).
    """
    g = econ.SplitParams().gas_ops_pct  # D-117: the gas & ops line is sim-derived (0.20)
    assert econ.beta(False, True) == pytest.approx(0.75 - g)
    assert econ.beta(False, False) == pytest.approx(0.85 - g)
    # +10 points for a prime
    assert econ.beta(True, True) == pytest.approx(0.85 - g)
    assert econ.beta(True, False) == pytest.approx(0.95 - g)


def test_ratchet_coefficient_table_4_2_1():
    """SS4.2.1: (1-k)*beta for the four rows -- 0.055 / 0.248 / 0.440 / 0.650 at
    D-117's 20% gas & ops line (0.065 / 0.293 / 0.520 / 0.750 at the old 10%)."""
    beta_c = econ.beta(False, True)
    beta_p = econ.beta(True, True)
    # D-98: the middle row is the HALF-hour mark now -- at the full hour k(t) is
    # already k_max, which is the row above.
    k_half = econ.k_of_t(1800.0, 0.2, 0.9, 3600.0)
    assert (1 - 0.90) * beta_c == pytest.approx(0.055, abs=0.001)
    assert (1 - k_half) * beta_c == pytest.approx(0.2475, abs=0.001)
    assert (1 - 0.20) * beta_c == pytest.approx(0.440, abs=0.001)
    assert (1 - 0.0) * beta_p == pytest.approx(0.650, abs=0.001)
    # "as much as nearly twelve patient composite mints"
    assert (1.0 * beta_p) / ((1 - 0.90) * beta_c) == pytest.approx(11.8, abs=0.2)


def _engine(**kw):
    p = SimParams(
        horizon_days=kw.pop("horizon_days", 30),
        n_max=kw.pop("n_max", 20_000),
        history_every_n_mints=50,
        prime_head=PrimeHeadParams(npv_horizon=20_000),
        **kw,
    )
    return Engine(p).run()


def test_every_prime_mint_emits_nothing():
    # The legacy path: under the D-20 default no prime is a head mint at all.
    e = _engine(primes_skip_head=False)
    primes = [ev for ev in e.mint_log if ev.kind == "prime"]
    assert primes, "run produced no prime mints"
    assert all(ev.k == 0.0 for ev in primes)
    assert all(ev.rebate_primes == 0.0 for ev in primes)
    assert all(ev.tribute_paid == 0.0 and ev.flat_dividend == 0.0 for ev in primes)


def test_prime_mint_never_increases_S():
    """The Phase B fuzz property, checked here first."""
    e = _engine()
    for ev in e.mint_log:
        if ev.kind == "prime":
            assert ev.rebate_primes == 0.0


# --------------------------------------------------------------------------- #
# item 4 -- PRIME_UPLIFT sizing
# --------------------------------------------------------------------------- #


def test_headroom_table_reproduces_5_1():
    up = econ.UpliftParams(prime_uplift=0.06, prime_window=5)
    rows = {r["n"]: r for r in econ.headroom_table(up)}
    expected = {
        1000: (0.900, 0.050, 0.163, 0.675, 0.513),
        10_000: (0.675, 0.275, 0.195, 0.506, 0.311),
        100_000: (0.540, 0.410, 0.195, 0.405, 0.210),
        1_000_000: (0.450, 0.500, 0.195, 0.338, 0.143),
    }
    for n, (km, hr, credit, forgone, nets) in expected.items():
        r = rows[n]
        assert r["k_max_n"] == pytest.approx(km, abs=0.001)
        assert r["headroom_to_k_ceil"] == pytest.approx(hr, abs=0.001)
        assert r["credit_value_ton"] == pytest.approx(credit, abs=0.001)
        assert r["rebate_forgone_ton"] == pytest.approx(forgone, abs=0.001)
        assert r["protocol_nets_ton"] == pytest.approx(nets, abs=0.001)


def test_compensation_share_rises_24_to_58_and_protocol_nets_every_row():
    up = econ.UpliftParams(prime_uplift=0.06, prime_window=5)
    rows = econ.headroom_table(up)
    shares = [r["compensation_share"] for r in rows]
    assert shares[0] == pytest.approx(0.24, abs=0.01)
    assert shares[-1] == pytest.approx(0.58, abs=0.01)
    assert shares == sorted(shares), "compensation share must rise as emission decays"
    assert all(r["protocol_nets_ton"] > 0 for r in rows)


@pytest.mark.parametrize("n", [10 ** i for i in range(2, 9)])
def test_prime_uplift_invariant_across_range(n):
    """`PRIME_UPLIFT * PRIME_WINDOW < k_max(n)` -- a contract-level invariant
    in Phase B, asserted here across the whole simulated range."""
    for up in (econ.UpliftParams(prime_uplift=0.06, prime_window=5),
               econ.UpliftParams()):
        km = econ.k_max_of_n(n, 1000, 0.9, 0.2)
        assert up.prime_uplift * up.prime_window < km


def test_invariant_only_fails_past_the_unreachable_clamp():
    """SS5.1: the constraint fails only past n ~ 1e13, where the `k_max >= k_min`
    clamp already binds."""
    up = econ.UpliftParams(prime_uplift=0.06, prime_window=5)
    assert up.prime_uplift * up.prime_window < econ.k_max_of_n(10 ** 8, 1000, 0.9, 0.2)
    unclamped = 0.9 * __import__("math").log(1000) / __import__("math").log(10 ** 13)
    assert unclamped < up.prime_uplift * up.prime_window


# --------------------------------------------------------------------------- #
# item 6 -- uplift stacking under K_CEIL
# --------------------------------------------------------------------------- #


def test_uplifts_are_summed_then_clamped_once():
    up = econ.UpliftParams()
    k, clamped = econ.k_max_effective(500, 1000, 0.9, 0.2, up, recruit_rank=5,
                                      prime_rank=5, in_prime_window=True,
                                      in_newcomer_window=True)
    assert clamped
    assert k == pytest.approx(up.k_ceil)
    # the sum, not any single uplift, is what reaches the ceiling
    raw = 0.9 + up.recruit_rank_uplifts[5] + up.prime_rank_uplifts[5] + up.prime_uplift + up.newcomer_uplift
    assert raw > up.k_ceil


def test_no_reachable_combination_reaches_k_ceil_in_k():
    """SS5: `k_min <= k(t) <= K_CEIL < 1` for every reachable combination."""
    up = econ.UpliftParams()
    for n in (14, 1000, 10_000, 1_000_000):
        for pr in range(6):
            for qr in range(6):
                for a in (False, True):
                    for b in (False, True):
                        km, _ = econ.k_max_effective(n, 1000, 0.9, 0.2, up, pr, qr, a, b)
                        assert km <= up.k_ceil
                        assert econ.k_of_t(10 ** 9, 0.2, km, 3600.0) < 1.0


def test_pessimistic_stacking_still_ratchets_the_floor():
    """Item 6: publish the floor trajectory under a pessimistic rank-and-credit
    distribution next to the base case. Both must be monotone."""
    base = _engine()
    pess = _engine(pessimistic_uplifts=True)
    for e in (base, pess):
        floors = [h["floor_price"] for h in e.history]
        assert all(b >= a - 1e-12 for a, b in zip(floors, floors[1:]))
    assert pess.floor_price <= base.floor_price * 1.0000001
    assert pess.k_clamp_hits > 0
    assert base.k_clamp_hits <= base.k_clamp_eligible
