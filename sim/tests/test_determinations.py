"""The four §11 determinations, and the D-20 model they are computed under.

Two kinds of test live here and they are deliberately different in character:

  * **Invariant tests** -- things that must hold no matter what any premise
    says. `k < 1` via the single clamp, `S` untouched by a premium injection,
    the head never facing a prime, the published ordering being fatal. These
    are the ones that would catch a real regression.
  * **Agreement tests** -- the vectorised census against the scalar
    `desirability` definitions, the same way `test_desirability.py` pins the
    vectorised score against the scalar one. Silent divergence between the two
    is the failure mode that produced a wrong histogram once already.

Nothing here asserts a *value* that depends on an unmeasured premise. Asserting
"the objective is 0.38 GRAM per head mint" would pin a number the module itself
publishes as BOUNDED, and the test would then be defending a premise rather than
a property.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from primes_sim import desirability as ds
from primes_sim import economics as econ
from primes_sim import market as mk
from primes_sim import trophy_auction as ta
from primes_sim.engine import Engine, PrimeHeadParams, SimParams

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PARAMS_PATH = os.path.join(REPO_ROOT, "shared", "params.json")


# --------------------------------------------------------------------------- #
# The census agrees with the scalar definitions it vectorises
# --------------------------------------------------------------------------- #


def test_predicate_masks_classify_the_documented_shapes():
    """The census's own classifier, which decides which CELL a number lands in.

    D-99 detached this from the price: the masks no longer score anything, they
    only name the shape a cell is measured over (`composite_values` reads cell
    frequency, not cell points). What they must still do is fire on the shapes
    they are named for.
    """
    def top(n):
        m = mk._predicate_masks(np.array([n], dtype=np.int64))
        return {k for k in ("repdigit", "pow10", "palindrome", "run", "repeat",
                            "trailing_zeros", "year") if bool(m[k][0])}

    assert "repdigit" in top(1111) and "palindrome" in top(1111)
    assert "pow10" in top(1000) and "trailing_zeros" in top(1000)
    assert "run" in top(1234)
    assert "repeat" in top(1212) and "repeat" in top(1122)
    assert "year" in top(2023) and "year" not in top(2523)
    assert top(738491) == set()


def test_cell_of_agrees_with_the_census():
    lo, hi = 100, 20_000
    census = mk.class_census(lo, hi, chunk=20_000)
    by_hand: dict[mk.Cell, int] = {}
    for n in range(lo, hi):
        c = mk.cell_of(n)
        by_hand[c] = by_hand.get(c, 0) + 1
    assert by_hand == census["cells"]


def test_census_counts_every_number_exactly_once():
    census = mk.class_census(100, 10_000, chunk=10_000)
    assert sum(census["cells"].values()) == census["count"] == 9_900


def test_the_cell_carries_the_shipped_score():
    """D-99: `D(n)` is no longer a function of the cell's shape fields, so the
    census carries the score itself. If the cell's score and
    `desirability.score` ever disagree, the bid-increment ladder is bucketed
    against a different ladder than the one the contract ships."""
    for n in (100, 111, 1000, 1111, 1221, 1234, 2000, 2023, 1212, 1122, 999999):
        assert mk.cell_of(n).score == ds.score(n), n


# --------------------------------------------------------------------------- #
# The weight search is DELETED (D-99), and the lane model that carried it is not
# --------------------------------------------------------------------------- #
#
# Seven tests stood here: the incumbent's infeasibility under D-21's constraint
# 3, the published-predicate ordering, the trailing-zeros ramp bound, and the
# "all three constraints are fatal" property of `market.optimise_weights`. All
# of them tested a SEARCH OVER WEIGHTS, and D-99 deletes that search -- the 33
# category weights are owner-declared and parsed from `shared/opcodes.ts`, so
# there is nothing left to select and no ordering constraint over a pattern
# layer that no longer exists. What survives is below: the lane model itself,
# which prices lots and which Q26 and the D-33 ladder both still consume.


def test_the_lane_model_still_prices_both_lanes(monkeypatch):
    """`evaluate_lane` (was `evaluate_weights`) on the smallest census that has
    both lanes: every composite is openable (D-30 dropped the gate) and the
    prime lane is measured separately (D-31)."""
    census = mk.class_census(100, 20_000, chunk=20_000)
    prime_npv = {p: 1.0 for p in (101, 103, 107, 1009, 10007)}
    prem = mk.ObjectivePremises(draws=40, seed=1)
    r = mk.evaluate_lane(census, prime_npv, prem, res_gas_ton=0.04,
                         increment_ladder={"min_increment_floor_ton": 0.015,
                                           "min_increment_bps": [1000, 2000, 3000]})
    assert r["constraint_2_auctioned_share_of_composite_line"] == pytest.approx(1.0)
    assert r["prime_lots"] == len(prime_npv)
    assert 0.0 <= r["constraint_1_participation"] <= 1.0
    assert r["constraint_2_mean_p0_composite_ton"] >= ta.C.RESERVE_FLOOR_TON


def test_a_higher_scoring_number_opens_dearer():
    """The one monotonicity the ladder owes: P0 is non-decreasing in D(n), and
    strictly increasing once the ladder clears the lane floor. This is what the
    deleted constraint 2 was protecting -- that being early is not made
    arbitrarily expensive -- expressed as a property of the price map rather
    than of a weight vector."""
    prices = [ta.p0_ton(d) for d in range(0, ds.W.SCORE_MAX + 1)]
    assert all(b >= a for a, b in zip(prices, prices[1:]))
    assert ta.p0_ton(ds.score(1111)) > ta.p0_ton(ds.score(1112))


# --------------------------------------------------------------------------- #
# Lane mechanics
# --------------------------------------------------------------------------- #


def test_a_lot_worth_far_more_than_the_floor_always_sells_on_the_dutch_lane():
    rng = np.random.default_rng(0)
    out = mk.dutch_outcome(50.0, 500.0, lam_per_day=1.0, sigma=0.5, rng=rng,
                           draws=500, decay_seconds=ta.C.AUCTION_WINDOW_SECONDS,
                           floor_ton=1.0, observation_days=90.0)
    assert out["sale_probability"] > 0.99
    assert out["mean_clearing_if_sold_ton"] >= 1.0


def test_a_lot_worth_far_less_than_the_floor_never_sells():
    rng = np.random.default_rng(0)
    out = mk.dutch_outcome(50.0, 0.001, lam_per_day=1.0, sigma=0.2, rng=rng,
                           draws=500, decay_seconds=ta.C.AUCTION_WINDOW_SECONDS,
                           floor_ton=1.0, observation_days=90.0)
    assert out["sale_probability"] == 0.0
    assert out["mean_clearing_unconditional_ton"] == 0.0


def test_dutch_clearing_never_falls_below_the_universal_floor():
    """D-20 point 2: the floor is a universal `MINT_PRICE`, so a prime can never
    sell below the ordinary mint price."""
    rng = np.random.default_rng(1)
    for value in (1.5, 5.0, 40.0):
        out = mk.dutch_outcome(80.0, value, lam_per_day=2.0, sigma=0.9, rng=rng,
                               draws=400, decay_seconds=ta.C.AUCTION_WINDOW_SECONDS,
                               floor_ton=1.0, observation_days=60.0)
        if out["sale_probability"] > 0:
            assert out["mean_clearing_if_sold_ton"] >= 1.0 - 1e-9


def test_ascending_clearing_is_bounded_by_p0_below():
    rng = np.random.default_rng(2)
    out = mk.ascending_outcome(8.0, 40.0, lam=3.0, sigma=0.8, rng=rng, draws=500,
                               increment_floor_ton=0.015, increment_bps=1000)
    assert out["sale_probability"] > 0
    assert out["mean_clearing_if_sold_ton"] >= 8.0 - 1e-9


def test_ascending_with_no_bidders_yields_no_premium():
    rng = np.random.default_rng(3)
    out = mk.ascending_outcome(8.0, 40.0, lam=0.0, sigma=0.8, rng=rng, draws=200,
                               increment_floor_ton=0.015, increment_bps=1000)
    assert out["sale_probability"] == 0.0
    assert out["mean_clearing_unconditional_ton"] == 0.0


def test_the_raise_walk_is_the_contracts_minimum_raise_walk():
    """D-33 as `primes_market.tolk` `minIncrementOn` enforces it: from `P0` each
    legal raise is `high + max(floor, high * bps / 10^4)`. Two bidders both
    valued just past the 3rd walk point clear at exactly that point."""
    p0, floor, bps = 1.07, 0.015, 1000
    g = [p0]
    for _ in range(4):
        g.append(g[-1] + max(floor, g[-1] * bps / 10_000))
    rng = np.random.default_rng(0)
    # sigma=0: every bidder values it at exactly `value`; lam=50: >=2 arrive.
    out = mk.ascending_outcome(p0, g[3] + 1e-6, lam=50.0, sigma=0.0, rng=rng,
                               draws=50, increment_floor_ton=floor,
                               increment_bps=bps)
    assert out["mean_clearing_if_sold_ton"] == pytest.approx(g[3])


# --------------------------------------------------------------------------- #
# D-45's surviving fragment of the extending-close model
# --------------------------------------------------------------------------- #


def test_prefunding_displacement_is_bounded_and_monotone():
    """Q26 (re-scoped 2026-09-24): the lane-aware share never exceeds the
    lane-unaware bound, rises with buyer interest and falls with the P0 level."""
    from primes_sim import tribute as tr
    lo, hi = 100, 3000
    census = mk.class_census(lo, hi)
    npv = {p: v for p, v in tr.prime_tribute_npv(hi, mints_per_year=50_000)["npv"].items()
           if lo <= p < hi}
    prem = mk.ObjectivePremises()

    def run(lam):
        return mk.prime_prefunding_displacement(
            npv_by_prime=npv, census=census,
            prem=mk.replace(prem, lam_dutch_per_day=lam), head_range=(lo, hi),
            mints_per_day=150.0, carry_rate_annual=0.35,
            p0_multiples=(1.0, 3.0))["by_p0_multiple"]
    low, high = run(0.02), run(0.30)
    for r in (*low.values(), *high.values()):
        assert 0.0 <= r["displaced_share"] <= r["lane_unaware_upper_bound_share"] <= 1.0
    assert high["p0_x1.0"]["displaced_share"] > low["p0_x1.0"]["displaced_share"]
    assert high["p0_x3.0"]["displaced_share"] < high["p0_x1.0"]["displaced_share"]


def test_mean_lot_open_days_rises_with_late_bid_intensity():
    """D-8's trade: the extension lengthens the lot as late-bid intensity rises.

    This is the only piece of the pre-D-45 extending-close model that survives:
    `open_lot_volume` still needs mean open life. The head-collision question
    that used to be measured alongside it is retired outright (D-45) -- there
    is no longer a distance for the head to collide with.
    """
    lo = mk.mean_lot_open_days(lam_late_per_hour=0.1, max_bidders=50)
    hi = mk.mean_lot_open_days(lam_late_per_hour=20.0, max_bidders=50)
    assert hi > lo


# --------------------------------------------------------------------------- #
# The D-20 engine mode
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def d20_engine():
    p = SimParams(seed=7, primes_skip_head=True,
                  prime_lot_sale_probability=0.8,
                  prime_lot_mean_premium_ton=2.0,
                  prime_head=PrimeHeadParams(enabled=False),
                  horizon_days=60.0, n_max=5_000, history_every_n_mints=200)
    return Engine(p).run()


def test_d20_lot_buyers_spend_the_prime_window_under_5_1(d20_engine):
    """SS5.1 in the engine: a Dutch-lot prime opens PRIME_WINDOW on a wallet that
    mints, the window is actually spent on composite head mints, and what the
    K_CEIL clamp lets through never reaches k_max at the prime that opened it."""
    e = d20_engine
    up = e.p.uplifts
    wins = e.all_prime_windows()
    assert len(wins) > 0
    assert sum(w["uplifted_mints"] for w in wins) > 0, "nothing consumed the uplift"
    for w in wins:
        assert w["uplifted_mints"] <= up.prime_window
        assert w["realized_uplift_sum"] <= up.prime_uplift * up.prime_window + 1e-12
        assert w["realized_uplift_sum"] < econ.k_max_of_n(w["prime"], 1000, 0.9, 0.2)


def test_d20_head_never_mints_a_prime(d20_engine):
    assert not any(ev.kind == "prime" for ev in d20_engine.mint_log)


def test_d20_head_can_never_park_on_a_prime(d20_engine):
    """§12's highest-severity risk cannot occur on the prime branch under D-20 --
    structurally, not probabilistically."""
    assert d20_engine.prime_declines == 0


def test_d20_head_starts_at_4_after_opening_2_and_3():
    """CONCEPT.md §6 point 1: after Unity, primes 2 and 3 open in the market and
    4 is the next number available to build."""
    p = SimParams(seed=1, primes_skip_head=True, prime_head=PrimeHeadParams(enabled=False),
                  horizon_days=1.0, n_max=50, max_mints=1)
    e = Engine(p)
    assert e.head == 2
    e.run()
    assert 2 in e.ownership or 2 in e.unsold_prime_numbers
    assert 3 in e.ownership or 3 in e.unsold_prime_numbers
    assert e.mint_log[0].n == 4, "the first head mint is the first composite"


def test_d20_every_prime_below_the_head_is_a_lot(d20_engine):
    e = d20_engine
    assert e.prime_lots_opened == e.prime_lots_sold + e.prime_lots_unsold
    assert e.prime_lots_opened > 0


def test_d20_premium_raises_T_without_touching_S():
    """D-7's whole point: a premium is a pure `T` increment against **zero**
    emission, so it is strictly floor-accretive."""
    p = SimParams(seed=3, primes_skip_head=True, prime_head=PrimeHeadParams(enabled=False),
                  prime_lot_sale_probability=1.0, prime_lot_mean_premium_ton=25.0,
                  horizon_days=1.0, n_max=100)
    e = Engine(p)
    s_before, t_before, f_before = e.S, e.T, e.floor_price
    e._open_prime_lot(101, 0.0)
    assert e.S == s_before, "a premium must not emit PRIMES"
    assert e.T > t_before
    assert e.floor_price > f_before, "a premium must be strictly floor-accretive"


def test_d20_prime_lot_nominal_leg_matches_an_ordinary_prime_mint_split():
    """Confirmed against the contract 2026-08-17: `SettlePrimeClearing` runs the
    IDENTICAL five-way split on the IDENTICAL nominal `MINT_PRICE`, so a prime's
    nominal `T` contribution is unchanged by D-20 and only the delivering
    message differs. The premium is the addition, not a replacement.

    This is the exact assumption whose absence produced the 59.8 GRAM
    `SimCrossCheck` gap, so it is pinned rather than trusted.
    """
    p = SimParams(seed=11, primes_skip_head=True,
                  prime_head=PrimeHeadParams(enabled=False),
                  prime_lot_sale_probability=1.0, prime_lot_mean_premium_ton=0.0,
                  horizon_days=1.0, n_max=100)
    e = Engine(p)
    t_before = e.T
    e._open_prime_lot(101, 0.0)
    nominal = e.T - t_before
    # Both admissible §4.1 rows for a prime mint: tribute has no recipient and
    # falls to the pool, so beta is the prime row, unreferred or referred -- plus,
    # since D-117, the unspent gas & ops line `sweep_ops` returns to the pool.
    sp = econ.SplitParams()
    surplus = sp.gas_ops_pct - sp.gas_ops_draw_prime_ton
    assert nominal in (pytest.approx(econ.beta(True, False) + surplus),
                       pytest.approx(econ.beta(True, True) + surplus)), nominal


def test_d20_prime_lot_premium_is_additive_not_a_replacement():
    """The premium sits ON TOP of the unchanged nominal leg -- the ratchet's
    half of it (D-114); the other half is the treasury's."""
    kw = dict(seed=11, primes_skip_head=True,
              prime_head=PrimeHeadParams(enabled=False),
              prime_lot_sale_probability=1.0, horizon_days=1.0, n_max=100)
    a = Engine(SimParams(prime_lot_mean_premium_ton=0.0, **kw))
    b = Engine(SimParams(prime_lot_mean_premium_ton=7.0, **kw))
    ta_, tb = a.T, b.T
    a._open_prime_lot(101, 0.0)
    b._open_prime_lot(101, 0.0)
    assert (b.T - tb) - (a.T - ta_) == pytest.approx(3.5)
    assert b.treasury_total - a.treasury_total == pytest.approx(3.5)


def test_d20_unsold_prime_tribute_forfeits_to_the_treasury():
    """D-20 point 4: not to the pool, and not to any specific item's income."""
    p = SimParams(seed=5, primes_skip_head=True, prime_head=PrimeHeadParams(enabled=False),
                  prime_lot_sale_probability=0.0, prime_lot_mean_premium_ton=0.0,
                  horizon_days=90.0, n_max=3_000, history_every_n_mints=500)
    e = Engine(p).run()
    assert e.prime_lots_unsold == e.prime_lots_opened > 0
    assert e.unsold_prime_forfeit_ton > 0.0, (
        "composites of unsold primes must forfeit their divisor share to treasury"
    )
    assert e.treasury_total >= e.unsold_prime_forfeit_ton


def test_the_published_baseline_and_the_default_run_d20():
    """Both params.json generators run D-20 (run_phase1.py since the 2026-09-24
    baseline migration), and so does the SimParams default; the legacy path,
    which mints primes at the head, is opt-in."""
    import os, sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
    import run_phase1
    assert run_phase1.BASELINE_KWARGS["primes_skip_head"] is True
    assert SimParams().primes_skip_head is True
    p = SimParams(seed=9, primes_skip_head=False, horizon_days=30.0, n_max=2_000, history_every_n_mints=500)
    e = Engine(p).run()
    assert any(ev.kind == "prime" for ev in e.mint_log), (
        "the legacy path mints primes at the head -- that is the drift D-20 deleted"
    )


# --------------------------------------------------------------------------- #
# The shipped block
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def params():
    with open(PARAMS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def test_determinations_block_is_present_and_owned(params):
    d = params["determinations"]
    assert "run_determinations.py" in d["_meta"]["source"]


def test_all_determinations_are_present(params):
    """ONE since D-106 deleted `q12_activation_bonus`, D-99 `q25` and D-168
    `q18`; deleted questions leave no tombstone block."""
    d = params["determinations"]
    assert d["q26_auction_lane"]["_status"], "q26 must declare SELECTED or BOUNDED"
    for gone in ("q12_activation_bonus", "q25_desirability_weights", "q18_staking_x_star"):
        assert gone not in d, gone


def test_every_determination_declares_selected_bounded_or_deleted(params):
    """A determination must say where it stands. D-99 adds a third standing --
    DELETED -- for Q25, whose question the owner answered by declaring the
    weights instead of asking the sim to fit them; a deleted block must still
    carry its reason rather than vanishing, because the shipped params.json is
    what a reader checks the record against."""
    for key, block in params["determinations"].items():
        if not key.startswith("q"):
            continue
        assert block["_status"].startswith(("SELECTED", "BOUNDED", "DELETED")), key
        if block["_status"] == "DELETED":
            assert block["_decision"] and block["_why"]


def test_no_lookahead_H_is_computed_in_the_determinations(params):
    """D-20 point 3 retired `lookaheadH`; §11.26 deletes it from the owed list
    rather than sizing it. A *key* reintroducing it is a regression.

    Deliberately a check on keys, not on the text: the block explains at length
    that `H` is not owed, so the word appears and should. What must never appear
    is a field carrying a value for it.
    """
    def keys(node):
        if isinstance(node, dict):
            for k, v in node.items():
                yield k
                yield from keys(v)
        elif isinstance(node, list):
            for v in node:
                yield from keys(v)

    banned = {"lookaheadh", "lookahead_h", "h", "dutch_lookahead",
              "lookahead_distance"}
    found = {k for k in keys(params["determinations"]) if k.lower() in banned}
    assert not found, f"a retired lookahead field is back: {sorted(found)}"


def test_engine_has_no_stake_uplift_leg():
    """D-168: four uplift legs, one clamp. The fifth (stake) term is gone."""
    assert not hasattr(SimParams(), "stake_uplift")


def test_the_score_weights_are_owner_declared(params):
    """D-99: the 33 category weights are owner-declared (`shared/opcodes.ts`),
    not a sim selection."""
    # and the weights are in their new home, marked as the owner's
    assert params["score"]["_provenance"] == "owner-declared (D-99)"




def test_v26_2_backlog_peak_counts_unsold_for_ever_and_sold_for_their_dwell():
    """V26.2 / D-188: the peak number of prime lots open at once sizes the
    market's `lots` map. An unsold lot stays for ever; a sold one for
    `prime_lot_mean_days_to_sale`, so lots opened further apart than that never
    overlap and lots opened inside it do."""
    kw = dict(seed=5, primes_skip_head=True, prime_head=PrimeHeadParams(enabled=False),
              prime_lot_mean_premium_ton=0.0, horizon_days=1.0, n_max=200)
    never = Engine(SimParams(prime_lot_sale_probability=0.0, **kw))
    for i, p in enumerate((101, 103, 107)):
        never._open_prime_lot(p, i * 30 * 86400.0)
    assert never.prime_lot_backlog_peak == never.prime_lots_unsold == 3

    sold = Engine(SimParams(prime_lot_sale_probability=1.0,
                            prime_lot_mean_days_to_sale=6.0, **kw))
    sold._open_prime_lot(101, 0.0)
    sold._open_prime_lot(103, 1 * 86400.0)      # inside 101's six days
    sold._open_prime_lot(107, 20 * 86400.0)     # after both closed
    assert sold.prime_lot_backlog_peak == 2
    assert sold.prime_lots_unsold == 0
