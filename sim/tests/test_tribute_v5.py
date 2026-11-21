"""Regression test for UPGRADE_PLAN_V5.md SS3 item 1 -- the divisor weighting.

CONCEPT.md SS3.2 publishes band tables computed over the true factorization of
every n up to the horizon. If this model does not put primes > 200 at 58.5% of
the divisor line at n = 1e5 under `e*sqrt(p)` weighting, **the model is wrong,
not the doc** (the plan says so in those words). Everything else in Phase A
that touches tribute rests on this sweep, so it is checked to a tenth of a
point, not loosely.
"""
from __future__ import annotations

import pytest

from primes_sim import economics as econ
from primes_sim import tribute as tr


@pytest.fixture(scope="module")
def spf_1e5():
    return tr.spf_sieve(100_000)


@pytest.fixture(scope="module")
def spf_1e6():
    return tr.spf_sieve(1_000_000)


def test_band_table_sqrt_at_1e5(spf_1e5):
    b = tr.band_shares(100_000, "sqrt", 0.0, spf_1e5)
    assert b["all_gt_200"] == pytest.approx(0.585, abs=0.001)
    assert b["first_10"] == pytest.approx(0.222, abs=0.001)
    assert b["31_199"] == pytest.approx(0.193, abs=0.001)
    assert b["200_1000"] == pytest.approx(0.199, abs=0.001)
    assert b["1k_10k"] == pytest.approx(0.274, abs=0.002)
    assert b["gt_10k"] == pytest.approx(0.113, abs=0.001)


def test_band_table_flat_at_1e5(spf_1e5):
    b = tr.band_shares(100_000, "flat", 0.0, spf_1e5)
    assert b["all_gt_200"] == pytest.approx(0.247, abs=0.001)
    assert b["first_10"] == pytest.approx(0.616, abs=0.001)


def test_band_table_at_1e6(spf_1e6):
    s = tr.band_shares(1_000_000, "sqrt", 0.0, spf_1e6)
    f = tr.band_shares(1_000_000, "flat", 0.0, spf_1e6)
    assert s["all_gt_200"] == pytest.approx(0.732, abs=0.001)
    assert s["first_10"] == pytest.approx(0.136, abs=0.001)
    assert f["all_gt_200"] == pytest.approx(0.298, abs=0.001)
    assert f["first_10"] == pytest.approx(0.577, abs=0.001)


def test_f_dial_lifts_the_tail(spf_1e5):
    """SS3.2: raising `f` from 0 to 0.2 lifts the >10k band from 11.3% to
    ~21.8% of the line at n = 1e5."""
    b0 = tr.band_shares(100_000, "sqrt", 0.0, spf_1e5)
    b2 = tr.band_shares(100_000, "sqrt", 0.20, spf_1e5)
    assert b0["gt_10k"] == pytest.approx(0.113, abs=0.001)
    assert b2["gt_10k"] == pytest.approx(0.218, abs=0.005)


def test_full_p_weighting_guts_the_blue_chips(spf_1e5):
    """SS3.2's argument for stopping at 1/2: weighting by `p` collapses the
    first ten primes, which is what destroys the genesis auction."""
    s = tr.band_shares(100_000, "sqrt", 0.0, spf_1e5)
    p = tr.band_shares(100_000, "p", 0.0, spf_1e5)
    assert p["first_10"] < s["first_10"] * 0.6
    assert p["all_gt_200"] > s["all_gt_200"]


def test_divisor_weights_ordering_on_234():
    """SS3.2's worked example: minting 234 = 2 * 3^2 * 13 pays the owner of 13
    slightly more than the owner of 3, and the owner of 2 least."""
    w = econ.divisor_weights({2: 1, 3: 2, 13: 1}, 0.5)
    total = sum(w.values())
    line = 0.10 * (1 - 0.20)
    share = {p: line * x / total for p, x in w.items()}
    assert share[13] > share[3] > share[2]
    assert share[13] == pytest.approx(0.0340, abs=0.0005)
    assert share[3] == pytest.approx(0.0327, abs=0.0005)
    assert share[2] == pytest.approx(0.0133, abs=0.0005)


def test_tribute_line_splits_80_20():
    r = econ.split_mint(1.0, {1: 1.0}, referral_owner=2, minted_primes_count=51)
    assert r.tribute_paid == pytest.approx(0.08)
    assert r.flat_dividend == pytest.approx(0.02)
    assert (r.tribute_paid + r.flat_dividend + r.referral_paid + r.treasury
            + r.gas_ops + r.pool_injection) == pytest.approx(1.0)
    assert r.pool_injection == pytest.approx(0.75 - econ.SplitParams().gas_ops_pct)  # D-117: 0.55 at the 20% line


# `test_total_line_is_multiplier_invariant` lived here: it asserted that
# `tr.constellation_crowding`'s boosted and unboosted divisor lines summed to the
# same total, i.e. that SS3.2.2's x3/2 multiplier reweighted the 10% line and never
# inflated it. DECISIONS.md D-102 deletes the multiplier, `constellation_crowding`
# and kill criterion 4 outright, so there is no multiplier left to be invariant to
# and `divisor_line_shares` no longer takes a reweighting argument at all. The
# structural claim it was defending -- that no weighting can change the SIZE of
# the tribute line -- is still checked, one function up, by the split test above:
# `pool_injection` is the same beta regardless of recipient weights.
