"""LATE_GAME_PLAN.md L1 -- the rotation, and the one thing L1 exists to falsify.

CONCEPT.md SS5.4's central sentence is *the asset side's share of each mint rises
monotonically with `n` because the rebate is the only leg of the split carrying a
decay term*. SS3 item 5 makes that a kill criterion: if it does not hold under the
base parameters, the sentence is false and L0 ships without it. So it is asserted
here rather than observed once in a runner's stdout.

The other three figures are checked for *shape* rather than for exact values --
they are doc tables, not constants, and SS3 is explicit that this tranche must not
produce a constant. What is asserted is what SS5.4 actually claims about them: the
flat dividend decays per prime and the referral line has no `n` term.
"""
from __future__ import annotations

import math

import pytest

from primes_sim import economics as econ
from primes_sim import tribute as tr


@pytest.fixture(scope="module")
def spf_1e5():
    return tr.spf_sieve(100_000)


@pytest.fixture(scope="module")
def spf_1e6():
    # SS5.4 publishes to n = 1e6 and the flat dividend does not become immaterial
    # until well past 1e5, so one test genuinely needs the full horizon.
    return tr.spf_sieve(1_000_000)


# --------------------------------------------------------------------------- #
# SS3 item 1 + item 5 -- the asset-share curve and its kill criterion
# --------------------------------------------------------------------------- #


def test_asset_share_rises_monotonically_at_the_floor():
    """The kill criterion. If this fails, SS5.4's central sentence is false."""
    curve = econ.asset_share_curve()
    assert curve["monotone_at_floor"], curve["rows"]


def test_asset_share_curve_reproduces_the_shipped_table():
    rows = econ.asset_share_curve()["rows"]
    assert [round(r["k_max_n"], 3) for r in rows] == [0.900, 0.675, 0.540, 0.450]
    assert [round(r["rebate_value_at_floor_ton"], 3) for r in rows] == [0.585, 0.439, 0.351, 0.293]
    assert [round(r["asset_share_at_floor"] * 100, 1) for r in rows] == [25.5, 31.3, 36.3, 40.6]
    # SS8.1's own x* table, reproduced from the same k_max curve -- the two
    # sections of the document agree because they share one formula.
    assert [round(r["x_star"], 2) for r in rows] == [1.54, 2.05, 2.56, 3.08]


def test_the_asset_side_is_constant_which_is_the_whole_observation():
    """Nothing on the asset side grows. That is the point, and SS5.4 says so."""
    rows = econ.asset_share_curve()["rows"]
    assert len({round(r["asset_side_ton"], 9) for r in rows}) == 1
    for r in rows:
        assert r["referral_ton"] == pytest.approx(0.10)
        assert r["divisor_line_ton"] == pytest.approx(0.08)
        assert r["flat_dividend_ton"] == pytest.approx(0.02)


def test_the_rotation_vanishes_at_the_premium_ceiling():
    """SS5.4's required caveat, asserted so a later edit cannot quietly drop it.

    `x* = (1-c)/(k_max*beta)` is proportional to `1/k_max(n)`, so the rebate at the
    ceiling is worth `1-c` for every n and the decay term divides out exactly. A
    section that published only the rising column would be overclaiming.
    """
    curve = econ.asset_share_curve()
    shares = [r["asset_share_at_x_star"] for r in curve["rows"]]
    assert shares == pytest.approx([shares[0]] * len(shares))
    assert not curve["monotone_at_x_star"]
    assert shares[0] == pytest.approx(0.20 / (0.20 + 0.90))


def test_beta_is_the_residual_of_the_split_not_a_quoted_constant():
    assert econ.beta(is_prime_mint=False, referred=True) == pytest.approx(0.75 - econ.SplitParams().gas_ops_pct)
    # SS4.1: add ten points on a prime -- the tribute line has no recipient.
    assert econ.beta(is_prime_mint=True, referred=True) == pytest.approx(0.85 - econ.SplitParams().gas_ops_pct)


# --------------------------------------------------------------------------- #
# SS3 item 2 -- three assets on one axis
# --------------------------------------------------------------------------- #


def test_referral_line_has_no_n_term(spf_1e5):
    out = tr.asset_lifetime_curves(100_000, spf_1e5, probes=(211, 1009))
    assert out["referral_ton_per_routed_mint"] == pytest.approx(0.10)
    assert out["_referral_has_no_n_term"] is True
    # Referral income is strictly linear in mints elapsed -- the defining property
    # that makes it the cleanest instance of SS5.4's claim (SS3.1).
    for rows in out["by_prime"].values():
        marks = sorted(rows.items(), key=lambda kv: kv[1]["mints_elapsed"])
        for label, row in marks:
            expected = 0.10 * out["referral_routing_share"] * row["mints_elapsed"]
            assert row["referral_ton"] == pytest.approx(expected)


def test_large_primes_earn_more_at_equal_multiplicative_age(spf_1e5):
    """SS3.2's inversion, re-checked on the extended table: at equal age the larger
    prime is the better asset, because it dominates the weight of its multiples."""
    # 50p rather than 100p: 1009 * 100 exceeds the 1e5 horizon, and a mark past the
    # horizon is not recorded at all -- deliberately, since a truncated cumulative
    # would understate the larger prime and invert the very result under test.
    out = tr.asset_lifetime_curves(100_000, spf_1e5, probes=(2, 211, 1009))
    at_50p = {p: rows["head_50p"]["divisor_tribute_ton"] for p, rows in out["by_prime"].items()}
    assert at_50p[1009] > at_50p[211] > at_50p[2]


# --------------------------------------------------------------------------- #
# SS3 item 3 -- the flat dividend's decay shape
# --------------------------------------------------------------------------- #


def test_flat_dividend_line_is_constant_but_decays_per_prime(spf_1e5):
    d = tr.flat_dividend_decay(100_000, spf_1e5, sample_decades=(1e3, 1e4, 1e5))
    # The LINE does not decay: f * 0.10 TON per mint, at every n.
    assert d["flat_line_ton_per_mint"] == pytest.approx(0.02)
    assert d["_aggregate_line_is_constant"] is True
    # PER PRIME it does, like 1/pi(n) -- the qualifier SS5.4 owes the reader.
    per_prime = [r["per_prime_ton_per_1000_mints"] for r in d["rows"]]
    assert per_prime == sorted(per_prime, reverse=True)
    # ...and specifically like 1/pi(n), not like some slower shape: the ratio
    # between consecutive decades should track the pi(n) ratio.
    for a, b in zip(d["rows"], d["rows"][1:]):
        assert a["per_prime_ton_per_mint"] / b["per_prime_ton_per_mint"] == pytest.approx(
            b["pi_n"] / a["pi_n"], rel=1e-9
        )


def test_flat_dividend_materiality_head_is_reachable(spf_1e6):
    """SS11's new open question exists because this number is small enough to
    matter. If it ever moves above the horizon the game can plausibly reach, the
    question can be closed -- so the bound is asserted rather than assumed.

    CONCEPT.md SS5.4 quotes ~224,700; asserted as a band rather than a point,
    because the exact crossing is a property of pi(n) and the threshold, and
    pinning it would make this a change-detector instead of a claim check."""
    d = tr.flat_dividend_decay(1_000_000, spf_1e6)
    n = d["per_prime_immaterial_from_head"]
    assert n is not None
    assert 100_000 < n < 500_000


# --------------------------------------------------------------------------- #
# The parameter file the whole tranche reads from
# --------------------------------------------------------------------------- #


def test_params_json_is_valid_json_for_non_python_consumers():
    """shared/params.json is the declared single source of truth for the
    contracts, the backend and the webapp, all of which parse it with a strict
    JSON parser. Python's json.dump emits bare `NaN` for float('nan'), which is
    not JSON and which those consumers fail hard on -- it shipped that way and was
    caught by SimCrossCheck.spec.ts trying to read it. Asserted here, at the
    producing end, so it cannot recur.
    """
    import json
    import os

    path = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "params.json")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    # `parse_constant` fires on exactly the three non-JSON tokens Python emits.
    def reject(tok):
        raise AssertionError(f"shared/params.json contains the non-JSON token {tok!r}")

    data = json.loads(text, parse_constant=reject)
    assert data["_meta"]["schema_version"]
    assert not math.isnan(data["rebate"]["K_CEIL"])
