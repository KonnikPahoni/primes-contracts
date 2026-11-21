"""CONCEPT.md SS4.4 as superseded 2026-08-19: `RES_GAS`, alone.

`RES_FEE` and `RES_PRIORITY` are **deleted** (D-30/D-33) -- there is no fee for
`RES_GAS` to be the non-waivable half of. `RES_GAS` survives, carved off the
**winning bid** before the premium is computed, because a won claim must still
fund its own `settle(n)` when the head arrives or it strands the head at `n` --
the parked head SS12 calls the highest-severity risk.

These tests are about the *derivation being a derivation*, not about the number
being any particular number. Every property SS4.4 attaches to `RES_GAS` is
tested here: never waivable (there is nothing left to waive it against, which is
itself asserted), never short of the hops it must pay, its own field, and
rounded up in its own favour.

D-90 REWRITES WHAT THE DERIVATION IS OVER. A won lot mints in its own close, so
there is no claim record to write, no `settle(n)` to fund later and no rent to
prepay -- the four legs collapse to two, and the value is RETAINED at 0.06 by
D-90.4 rather than following the derivation down (see
`gas.RETAINED_RES_GAS_TON`). D-32's forfeit-versus-gas constraint is deleted with
the release right it constrained; the derivation-moves-with-the-measurement check
is the one that survives, and it is the one W1.6 actually owed.
"""
from pathlib import Path

import json
import pytest

from primes_sim import gas as gasmod

REPO = Path(__file__).resolve().parents[2]
GAS_BASELINE = REPO / "contracts" / "gas-baseline.json"
PARAMS = REPO / "shared" / "params.json"


@pytest.fixture(scope="module")
def baseline():
    return gasmod.load_gas_baseline(GAS_BASELINE)


@pytest.fixture(scope="module")
def split(baseline):
    return gasmod.res_gas_derivation(baseline)


@pytest.fixture(scope="module")
def params():
    with open(PARAMS, encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------- #
# The derivation itself
# --------------------------------------------------------------------------- #

def test_res_gas_covers_every_hop_the_protocol_must_pay(split):
    """`RES_GAS >= the hops`, always. One-sided: it may exceed the measured cost
    (rounding is in its favour) but may never fall short, because a shortfall
    silently becomes a SS4.1 gas & ops cost."""
    d = split["res_gas_derivation"]
    hops = d["settle_confirm_hops_ton"]
    assert split["res_gas_ton"] >= hops
    assert split["res_gas_ton"] >= d["unrounded_res_gas_ton"]
    # D-90.4 floors it above its own derivation, and the surplus is published
    # rather than banked.
    assert d["retained_headroom_ton"] >= 0
    assert split["res_gas_ton"] == pytest.approx(
        d["derived_res_gas_ton"] + d["retained_headroom_ton"])


def test_settle_hop_matches_what_the_ledger_attaches(split):
    """primes_ledger.tolk `handleSettle` attaches 0.015 (`SettleConfirmed`) +
    0.010 (`HeadUpdate`). If the sim and the contract diverge here the
    difference is charged to the gas & ops line, so the figure is pinned."""
    d = split["res_gas_derivation"]
    assert d["settle_confirm_hops_ton"] == pytest.approx(0.015 + 0.010)


def test_derivation_moves_with_the_measurement(baseline):
    """SS4.4's "sized from the benchmark, not chosen": make the settle path more
    expensive and `RES_GAS` must follow it up.

    D-90.4's retained floor does NOT break this. It floors the value at 0.06, so
    the derivation must be pushed clear of the floor before the movement is
    observable -- which is exactly what "the floor is a floor and not the value"
    means, and why the multiplier here is large.
    """
    dearer = dict(baseline)
    dearer["ledger.mint_won_lot"] = (
        baseline["ledger.mint_won_lot"] * 4000)
    moved = gasmod.res_gas_derivation(dearer)
    base = gasmod.res_gas_derivation(baseline)
    assert moved["res_gas_ton"] > base["res_gas_ton"]
    # and the lane floor moves with it -- the identity is not a coincidence
    assert moved["lane_floor_ton"] > base["lane_floor_ton"]


def test_the_scoring_row_left_res_gas_with_d33(split):
    """D-33 moves `D(n)` evaluation to `open_lot`, paid by the opener's own
    message. The worst-case scored row must NOT be inside `RES_GAS` any more,
    or the winner is charged for compute the opener already paid."""
    rows = split["res_gas_derivation"]["inputs"]["gas_baseline"]
    assert "market.reserve.max_digits" not in rows
    assert "market.reserve" not in rows
    # D-90: two legs, both measured under their own names. The shard rows are
    # gone with the shard.
    assert set(rows) == {"market.close", "ledger.mint_won_lot"}
    assert not split["res_gas_derivation"]["inputs"]["gas_rows_substituted"]


def test_the_rent_leg_is_deleted(split):
    """D-90: there is no claim record, so there is nothing to rent and no claim
    write -- the derivation carries neither term."""
    d = split["res_gas_derivation"]
    for gone in ("claim_record_rent_ton", "claim_write_hop_ton",
                 "modelled_claim_wait_days", "_rent_deleted_note"):
        assert gone not in d


def test_a_lane_floor_that_cannot_cover_its_settlement_is_an_error(baseline):
    """The failure SS4.4 exists to prevent, restated for the auction lane: a
    floor `P0` too small to fund the settlement it promises. The sim must refuse
    to emit rather than quietly shrink `RES_GAS` to fit."""
    with pytest.raises(ValueError, match="cannot fund its own settlement"):
        gasmod.res_gas_derivation(baseline, p0_floor_ton=1.01)


# --------------------------------------------------------------------------- #
# The lane floor identity (D-30/D-37 deleted the third term)
# --------------------------------------------------------------------------- #

def test_lane_floor_is_mint_price_plus_res_gas_exactly(split):
    """`RES_PRIORITY_BASE` is deleted, so the old 1.05 identity loses a term."""
    assert split["lane_floor_ton"] == pytest.approx(1.0 + split["res_gas_ton"])


def test_params_json_matches_the_derivation(split, params):
    """params.json is the parameter authority and the contracts mirror it. A
    stale file fails here rather than at deploy time."""
    res = params["off_head"]
    assert res["res_gas_ton"] == split["res_gas_ton"]
    assert res["lane_floor_ton"] == split["lane_floor_ton"]
    assert res["res_gas_nanoton"] == int(round(res["res_gas_ton"] * 1e9))
    # the deleted fee fields must be gone, not merely unused
    for gone in ("res_fee_ton", "res_priority_ton", "cancellation_fee_pct"):
        assert gone not in res, f"`{gone}` is deleted by D-30"


# --------------------------------------------------------------------------- #
# The gas & ops line still absorbs the worst settlement
# --------------------------------------------------------------------------- #

def test_settlement_worst_case_fits_the_gas_ops_line(baseline):
    """SS4.1 / D-117: the line is derived FROM the worst measured mint, so every
    measured row -- settlement included -- fits it, by at most one whole percent."""
    draw = gasmod.measured_gas_draw_per_mint(baseline, prime_share=0.084067)
    assert draw["worst_case_fits_allocation"] is True
    line = gasmod.gas_ops_line(baseline)
    assert all(v <= line["gas_ops_ton"] for v in line["rows_ton"].values())
    assert 0 <= line["headroom_ton"] < gasmod.GAS_OPS_LINE_STEP_PCT


def test_unspent_gas_ops_line_returns_to_the_pool_without_emission():
    """D-117 (owner, 2026-09-22): `sweep_ops` credits the ratchet's pending with the
    unspent line. It is a part of the gas & ops line, never of beta, so the rebate
    (k * beta * P) cannot grow with it."""
    from primes_sim import economics as econ
    sp = econ.SplitParams()
    r = econ.split_mint(1.0, {1: 1.0}, referral_owner=2, params=sp, minted_primes_count=5)
    assert r.ops_surplus_to_pool == pytest.approx(sp.gas_ops_pct - sp.gas_ops_draw_composite_ton)
    assert 0.0 < r.ops_surplus_to_pool < r.gas_ops
    assert r.pool_injection == pytest.approx(econ.beta(False, True, sp))


def test_import_window_is_sized_from_the_measured_peak(params):
    """D-196 / V30.1: `off_head.import_window` is whole 256-number blocks, at
    least 4096 numbers, and covers the measured peak head advance x safety."""
    w = params["off_head"]["import_window"]
    i = w["inputs"]
    assert w["numbers"] % 256 == 0 and w["blocks"] == w["numbers"] // 256
    assert w["numbers"] >= i["min_numbers"] == 4096
    need = i["peak_head_advance_numbers"] * i["safety"]
    assert w["numbers"] >= need and (w["numbers"] - 256 < need or w["numbers"] == 4096)
    # D-198 reuses W as the flush window; its provenance rides with the value.
    assert "walkLimitN" in w["_flush_window_note"]
