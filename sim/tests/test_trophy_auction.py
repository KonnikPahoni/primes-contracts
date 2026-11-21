"""TROPHY_AUCTION_PLAN.md SS9 -- the trophy lane's own properties.

These are the sim half of the check; `contracts/tests/TrophyAuction.spec.ts` and
`SimCrossCheck.spec.ts` are the other half, and assert that
`primes_trophy_auction.tolk` reproduces the `FRAC` table, the constants and the
price tables emitted here. Neither is sufficient alone: this file can only prove
the price map is well behaved, and the specs can only prove the contract agrees
with whatever the map says.

The load-bearing test in this file is
`test_integer_ladder_matches_the_float_reference_to_the_nanoton` -- the plan
names the `2^(D/10)` approximation as *"the likeliest place for silent
contract/sim drift"*.
"""

import json
import math
import pathlib
import random
from dataclasses import asdict

import pytest

from primes_sim import desirability as ds
from primes_sim import trophy_auction as tr


C = tr.C
PARAMS_PATH = pathlib.Path(__file__).resolve().parents[2] / "shared" / "params.json"


@pytest.fixture(scope="module")
def params() -> dict:
    return json.loads(PARAMS_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def block(params) -> dict:
    return params["trophy_auction"]


# --------------------------------------------------------------------------- #
# SS6 item 6 -- the bounds that survive
# --------------------------------------------------------------------------- #


def test_p0_is_monotone_in_the_score():
    """Weakly monotone everywhere, strictly monotone once the ladder clears the
    floor. A non-monotone price map would mean a strictly nicer number could
    open cheaper, which is the one property the ladder exists to provide."""
    vals = [tr.p0_nanoton(d) for d in range(C.SCORE_MAX + 1)]
    assert all(vals[i] <= vals[i + 1] for i in range(len(vals) - 1))
    # strictly increasing from the first rung above the floor onward
    first_above = next(i for i, v in enumerate(vals)
                       if v > round(C.RESERVE_FLOOR_TON * tr.NANO))
    assert all(vals[i] < vals[i + 1] for i in range(first_above, len(vals) - 1))
    # and monotone for primes too, where two more branches join the max
    pv = [tr.p0_nanoton(d, prime=True) for d in range(C.SCORE_MAX + 1)]
    assert all(pv[i] <= pv[i + 1] for i in range(len(pv) - 1))


def test_p0_is_never_below_the_reserve_floor_on_the_auction_lane():
    floor = round(C.RESERVE_FLOOR_TON * tr.NANO)
    for d in range(C.SCORE_MAX + 1):
        assert tr.p0_nanoton(d) >= floor
        assert tr.p0_nanoton(d, prime=True) >= floor


def test_a_prime_never_collapses_onto_the_lane_floor():
    """`PRIME_P0_MIN` is DELETED by D-99, and this is the property it existed to
    guarantee, now delivered by the score instead of by a constant.

    D12's argument was that a plain deep prime scored `D(n) = 0`, so both price
    branches collapsed to `RESERVE_FLOOR` and the auction became a reservation
    with seven days of ceremony attached. Under D-99 primality is a category
    worth 15 points on its own, so the LADDER branch alone opens any prime at
    2^(15/10) = 2.83 TON -- comfortably clear of the 1.06 TON lane floor, with no
    floor constant and no special case.
    """
    rng = random.Random(20260816)
    probes = [2, 3, 17, 1009, 1000003, 90000000019]
    probes += [p for p in (rng.randrange(10**6, 10**12) for _ in range(400))
               if tr.is_prime(p)]
    plain_prime_ton = tr.ladder_ton_float(ds.P[ds.PRIME])
    assert plain_prime_ton == pytest.approx(2.83, abs=0.01)
    for p in probes:
        assert tr.p0_ton(ds.score(p), prime=True) >= plain_prime_ton - 1e-9
        assert tr.p0_ton(ds.score(p), prime=True) > C.RESERVE_FLOOR_TON
    assert not hasattr(C, "PRIME_P0_MIN_TON"), "deleted by D-99"


def test_p0_at_score_max_sits_inside_the_declared_band():
    b = tr.ladder_bounds()
    lo, hi = b["declared_band_at_score_max_ton"]
    assert lo <= b["p0_at_score_max_ton"] <= hi
    assert b["monotone_in_score"] and b["above_reserve_floor_everywhere"]


# --------------------------------------------------------------------------- #
# SS6 item 2 -- the RESERVE_FLOOR identity
# --------------------------------------------------------------------------- #


def test_reserve_floor_identity_holds_against_the_shipped_res_gas(params):
    """`RESERVE_FLOOR == MINT_PRICE + RES_GAS`, exactly -- D-30/D-37 deleted the
    `RES_PRIORITY_BASE` term.

    Checked against `shared/params.json` rather than against literals, so the
    floor breaks loudly the next time the close/settle gas is re-measured and
    `res_gas_derivation` moves a quantum. That is the whole reason the identity
    is asserted rather than assumed: the floor is not a chosen number.
    """
    res = params["off_head"]
    ident = tr.reserve_floor_identity(
        mint_price_ton=params["mint"]["mint_price_ton"],
        res_gas_ton=res["res_gas_ton"],
    )
    assert ident["holds"], ident
    assert ident["sum_ton"] == pytest.approx(C.RESERVE_FLOOR_TON)


# --------------------------------------------------------------------------- #
# SS9 -- the integer approximation. The likeliest place for silent drift.
# --------------------------------------------------------------------------- #


def test_integer_ladder_matches_the_float_reference_to_the_nanoton():
    """The contract computes `(MINT_PRICE << (D/10)) * FRAC[D%10] / 2^16` in
    integers. The float reference is the SAME expression evaluated in floats --
    not `2**(D/10)`, which differs by the table's own rounding and is bounded
    separately below. What drifts in practice is the table, the shift, or the
    order of the multiply and the divide, and this catches all three.
    """
    for d in range(C.SCORE_MAX + 1):
        integer_nano = tr.ladder_nanoton(d)
        float_nano = tr.ladder_ton_float(d) * tr.NANO
        assert abs(integer_nano - float_nano) <= 1.0, d
        # the floor-divide can only ever round DOWN, never up
        assert integer_nano <= float_nano + 1e-6


def test_frac_table_is_within_a_stated_bound_of_the_true_exponential():
    """The approximation is real and is published rather than absorbed."""
    err = tr.frac_table_error()
    assert err["max_relative_error"] < err["bound"]
    assert err["bound"] == 2.0 ** -17
    assert len(tr.FRAC) == C.SCORE_HALVING
    assert tr.FRAC[0] == 1 << 16
    assert tr.FRAC == [round(2 ** (j / 10) * 65536) for j in range(10)]


def test_ladder_hits_the_exact_doublings():
    """Every whole multiple of SCORE_HALVING must be an exact power of two in
    nanoTON -- FRAC[0] is exactly 2^16, so the multiply and divide cancel."""
    for k in range(0, C.SCORE_MAX // C.SCORE_HALVING + 1):
        assert tr.ladder_nanoton(k * C.SCORE_HALVING) == tr.NANO << k


# --------------------------------------------------------------------------- #
# SS3.1's price table, computed rather than transcribed
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "n,expected_score,expected_p0_ton",
    [
        (1234, 55, 45.254882812),    # run 25 + LEN 10 + listed 20
        (2023, 39, 14.928588867),    # year 25 + LEN 10 + a +2 or two
        (10000, 56, 48.502929687),   # power of ten 40 + LEN 8 + square 4
        (1000, 62, 73.516601562),    # power of ten 40 + LEN 12 + cube 8 + 2
        (1111, 55, 45.254882812),    # repdigit 40 + LEN 10 + happy/harshad
    ],
)
def test_plan_price_table_for_composites(n, expected_score, expected_p0_ton):
    """The shipped opening price of five composites, at D-99's score.

    TROPHY_AUCTION_PLAN.md SS3.1's table was written against the pre-D-99 score
    and none of its figures survive; these are D-99's, regenerated. The values
    are the FRAC TABLE's, not `2**(D/10)` -- the difference is the table's 2^-17
    rounding, and pinning the SHIPPED number here rather than the mathematical
    one is the point: this is what the contract must reproduce.
    """
    assert ds.score(n) == expected_score
    assert not tr.is_prime(n)
    assert tr.lane(n, expected_score) == tr.AUCTION
    assert tr.p0_ton(expected_score) == pytest.approx(expected_p0_ton, abs=1e-6)


def test_the_top_rung_is_the_declared_ceiling_and_not_a_guard():
    """D-99 answer 9: a composite opens at no more than 420 TON, and the CLAMP
    is what enforces it -- there is no second ceiling rule anywhere.

    Before D-99 the top rung was a guard nobody expected to see (`SCORE_MAX =
    120` priced at 4,096 TON, far above any realised score). Now it is the
    stated cap and real numbers reach it: 2, 3 and 5 all clamp at 87.
    """
    assert tr.p0_ton(C.SCORE_MAX) == 415.875
    assert tr.p0_ton(C.SCORE_MAX) <= 420.5
    assert tr.p0_ton(C.SCORE_MAX) == pytest.approx(2.0 ** 8.7, rel=2.0 ** -17)
    for n in (2, 3, 5):
        assert ds.score(n) == C.SCORE_MAX


def test_the_deep_line_opens_at_the_floor_now_that_the_threshold_is_gone():
    """D-30 drops the `D_MIN` gate, so the question the threshold answered --
    *"why a threshold rather than a continuous curve?"* -- is answered a
    different way, and the sim has to check the new answer rather than the old.

    The old worry was that a continuous `2^(D/10)` map surcharges the deep line:
    a 7-digit number scoring 8 opens at 1.74 TON, a 74% surcharge on ~98% of the
    book. What stops that now is not a threshold but the `RESERVE_FLOOR` branch
    of the `max`, which holds every low-score lot at `MINT_PRICE + RES_GAS`
    until the ladder overtakes it. So the property to assert is where the ladder
    crosses the floor, and that everything below it opens at exactly the floor.
    """
    floor = C.RESERVE_FLOOR_TON
    for n in (738491, 4818):
        d = ds.score(n)
        assert not tr.is_prime(n)
        assert tr.lane(n, d) == tr.ASCENDING          # no gate: it IS a lot
    # every score below the crossing opens at exactly the floor...
    crossing = min(d for d in range(C.SCORE_MAX + 1)
                   if tr.ladder_ton_float(d) > floor)
    for d in range(crossing):
        assert tr.p0_ton(d) == pytest.approx(floor)
    # ...and the surcharge the old threshold was protecting against is real,
    # which is why the floor branch has to be there
    assert tr.ladder_ton_float(8) == pytest.approx(1.741, abs=1e-3)
    assert crossing <= 8


# --------------------------------------------------------------------------- #
# SS3 -- lane entry
# --------------------------------------------------------------------------- #


def test_lane_entry_depends_only_on_primality():
    """D-30/D-31: ONE route ahead of the head, and it turns on primality alone.

    This is the property that replaces the old three-way table. It must hold at
    EVERY score, not at a handful of examples, because the whole simplification
    D-30 bought is that the score no longer selects anything.
    """
    # every prime is on the descending Dutch lane at ANY D(n)
    assert tr.lane(17, ds.score(17)) == tr.DUTCH              # D = 28
    assert tr.lane(1009, ds.score(1009)) == tr.DUTCH          # D = 20
    assert tr.lane(90000000019, 0) == tr.DUTCH                # D = 0
    # every composite is on the ascending lane at ANY D(n) -- no gate
    assert tr.lane(1111, ds.score(1111)) == tr.ASCENDING      # D = 80
    assert tr.lane(1234, ds.score(1234)) == tr.ASCENDING      # D = 50
    assert tr.lane(4818, ds.score(4818)) == tr.ASCENDING      # D = 20
    assert tr.lane(738491, ds.score(738491)) == tr.ASCENDING  # D = 12
    # and the score cannot change the answer anywhere on its range
    for d in range(C.SCORE_MAX + 1):
        assert tr.lane(999999999999, d, prime=False) == tr.ASCENDING
        assert tr.lane(999999999937, d, prime=True) == tr.DUTCH
    assert not hasattr(C, "D_MIN"), "D_MIN is deleted by D-30"


def test_primorials_are_neither_reservable_nor_auctionable():
    """SS7's era boundaries. Every argument applies with more force at 128 TON
    than at 0.075 -- including for the primorials that are themselves prime."""
    for pr in tr.PRIMORIALS:
        assert tr.lane(pr, ds.score(pr)) == tr.HEAD_ONLY
    assert tr.is_prime(2) and tr.lane(2, ds.score(2)) == tr.HEAD_ONLY
    # 30030 is a primorial; 30031 is not
    assert tr.lane(30030, ds.score(30030)) == tr.HEAD_ONLY
    assert tr.lane(30031, ds.score(30031)) != tr.HEAD_ONLY


def test_miller_rabin_agrees_with_a_sieve_over_a_dense_sample():
    """Plan SS9: `getIsAuctionOnly(n)`'s primality must agree with the webapp's
    in-browser Pick step. Both mirror this; if this is wrong, all three are."""
    n_max = 50_000
    sieve = bytearray([1]) * (n_max + 1)
    sieve[0] = sieve[1] = 0
    for i in range(2, int(n_max ** 0.5) + 1):
        if sieve[i]:
            sieve[i * i:: i] = bytearray(len(sieve[i * i:: i]))
    assert all(tr.is_prime(n) == bool(sieve[n]) for n in range(n_max + 1))
    # Carmichael numbers -- the case a Fermat test gets wrong
    for c in (561, 1105, 1729, 2465, 2821, 6601, 8911, 41041, 825265):
        assert not tr.is_prime(c)


# --------------------------------------------------------------------------- #
# D3 -- the NPV extension, and its honest relationship to the six known values
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def analytic_npv(params) -> dict:
    """The analytic sweep at the shipped calibration, re-derived from
    `params.json`'s own record of the engine run rather than from literals."""
    from primes_sim import tribute as trib

    fs = params["final_state"]
    horizon = int(fs["final_head"])
    mints_per_year = fs["total_mints_simulated"] / (fs["horizon_days"] / 365.0)
    spf = trib.spf_sieve(horizon)
    return trib.prime_tribute_npv(
        horizon, spf,
        exponent=params["tribute"]["divisor_exponent"],
        f=params["tribute"]["flat_dividend_f"],
        tribute_pct=params["mint"]["tribute_pct"],
        discount_rate_annual=0.35,
        mints_per_year=mints_per_year,
    )["npv"]


def test_npv_extension_reproduces_the_six_known_genesis_entries(params, analytic_npv):
    """Plan SS9: *"NPV(p) extension reproduces the six known entries for
    p in {2,3,5,7,11,13} before it is trusted for 17."*

    It reproduces their SHAPE exactly and their LEVEL to a uniform +5.3%, and
    this test asserts precisely that rather than widening a tolerance until the
    two agree. The six published values come from
    `analysis.discounted_tribute_npv_by_prime`, which walks the ENGINE's realised
    mint log and discounts by wall-clock time; the extension comes from
    `tribute.prime_tribute_npv`, which sweeps the true factorization of every n
    on a constant-rate mint-index clock. Different computations. Evaluated at the
    engine's own horizon and realised mint rate the ratio between them is
    constant to under a tenth of a percentage point across all six -- so the
    analytic ladder inherits the engine's ordering and relative spacing, which is
    what "trusted for 17" actually requires.
    """
    known = {int(p): v["engine_npv_ton"]
             for p, v in params["trophy_auction"]["npv_calibration"]["by_prime"].items()}
    assert set(known) == {2, 3, 5, 7, 11, 13}

    ratios = {p: analytic_npv[p] / v for p, v in known.items()}
    # the level offset is small and one-directional
    assert all(1.0 < r < 1.10 for r in ratios.values()), ratios
    # and, the load-bearing half, it is UNIFORM: a level offset, not a shape
    # disagreement. A shape disagreement would mean the extension cannot be
    # trusted to order 17 against 13.
    assert max(ratios.values()) - min(ratios.values()) < 0.002, ratios

    # ordering and relative spacing survive exactly
    order = sorted(known, key=lambda p: -known[p])
    assert order == sorted(known, key=lambda p: -analytic_npv[p]) == [2, 3, 5, 7, 11, 13]


def test_npv_is_strictly_decreasing_and_extends_past_13(analytic_npv):
    """17 is the first number that needs D3, and it is the number the owner was
    looking at when this started."""
    ps = sorted(analytic_npv)[:2000]
    assert all(analytic_npv[ps[i]] > analytic_npv[ps[i + 1]]
               for i in range(len(ps) - 1))
    assert analytic_npv[17] < analytic_npv[13]
    # NPV/sqrt(p) declines fast and is not a clean function of sqrt(p), which is
    # why no cheap extrapolation was available and the table is generated.
    ratios = [analytic_npv[p] / math.sqrt(p) for p in (2, 3, 5, 7, 11, 13)]
    assert ratios == sorted(ratios, reverse=True)
    assert ratios[0] / ratios[-1] > 5


def test_npv_dictionary_bound_covers_every_prime_the_branch_can_bind_on(block):
    """The dictionary's size is a derived bound, not a guess: past the prime
    where `PRIME_P0_MULTIPLE * NPV(p)` drops under the prime's OWN ladder price,
    an entry changes no price at all. D-99 replaced the old flat `PRIME_P0_MIN /
    PRIME_P0_MULTIPLE` threshold with that per-prime comparison, because the
    constant it referred to is deleted."""
    lad = block["npv_ladder"]
    assert "2^(D(p)/SCORE_HALVING)" in lad["npv_branch_binding_rule"]
    assert lad["prime_count"] > lad["npv_branch_binding_prime_count"]
    npv = {int(p): v for p, v in lad["npv_ton_by_prime"].items()}
    last = lad["npv_branch_last_binding_prime"]
    for p, v in npv.items():
        if p > last:
            # the fallback quotes the same price the entry would have
            assert (tr.p0_nanoton(ds.score(p), prime=True, npv_ton=v)
                    == tr.p0_nanoton(ds.score(p), prime=True, npv_ton=None))


# --------------------------------------------------------------------------- #
# SS3.2 -- lot counts, recomputed from published data
# --------------------------------------------------------------------------- #


def test_every_composite_is_openable_and_the_size_of_that_change_is_published(block, params):
    """D-30: the openable set is the whole window, and the historical thresholds
    are kept so the size of what the deletion admitted is a number rather than an
    impression -- 58,500 numbers would pass the deleted gate, out of 9,999,900.

    The four counts moved again under D-99, which replaced the score every number
    gets, and again under GAUNTLET.md N6, which appended nine categories at bits
    39..47; they are recomputed here from the same `score.histogram.counts_by_score`
    the generator sums, so a change that forgets this block still fails. Being
    hardcoded is the POINT -- these are the published size of a deleted gate, and a
    self-deriving assertion would move with the score and report nothing.

    What N6 moved, for a reader comparing against the D-99 figures: 591,146 ->
    591,258 at D >= 20 (+112), 58,500 -> 58,597 at 30 (+97), 2,093 -> 2,133 at 40
    (+40) and 413 -> 422 at 50 (+9). Nine categories over a 10^7 window move the
    tail by hundredths of a percent, which is the shape a batch of RARE categories
    is supposed to have -- a big move here would have meant one of them fires on
    ordinary numbers and is not a rarity at all.

    D-162's two from-`n` bits (lucas, pronic) moved them again: 591,258 ->
    591,352 at 20 (+94), 58,597 -> 58,610 at 30 (+13), 2,133 -> 2,141 at 40 (+8)
    and 422 -> 424 at 50 (+2). Its four factor-side bits are invisible here, as
    33..39 are: this histogram is `scoreOf(n)`.
    """
    e = block["openable_lots"]
    assert e["openable_share"] == 1.0
    assert e["openable_under_d30"] == e["count"]
    by = e["historical_thresholds"]
    assert by["20"]["would_have_passed"] == 591_352
    assert by["30"]["would_have_passed"] == 58_610
    assert by["40"]["would_have_passed"] == 2_141
    assert by["50"]["would_have_passed"] == 424
    assert by["30"]["share"] == pytest.approx(0.005861, abs=1e-6)

    # The block is a tail sum of the published histogram, not a second measurement.
    counts = params["score"]["histogram"]["counts_by_score"]
    for threshold in ("20", "30", "40", "50"):
        tail = sum(v for k, v in counts.items() if int(k) >= int(threshold))
        assert by[threshold]["would_have_passed"] == tail
    assert e["newly_admitted_by_dropping_d_min_30"] == (
        e["count"] - by["30"]["would_have_passed"])
    # D-99 leaves 0.59% of the window at D >= 30, so 99.4% of numbers are ones the
    # deleted gate would have excluded. The claim is that dropping the gate admitted
    # the overwhelming majority of the line, and the share is checked against the
    # counts rather than against a remembered constant.
    assert e["newly_admitted_share"] == pytest.approx(
        e["newly_admitted_by_dropping_d_min_30"] / e["count"], abs=1e-12)
    assert e["newly_admitted_share"] > 0.98


# --------------------------------------------------------------------------- #
# Declared-ness, and the params.json drift check
# --------------------------------------------------------------------------- #


def test_declared_constants_are_marked_declared(block):
    """Plan SS6 is explicit that these are the owner's and must not be dressed as
    simulation outputs. The marking is the mechanism, so it is asserted."""
    assert block["_provenance"] == "declared"
    for key in ("SCORE_HALVING", "SCORE_MAX", "PRIME_P0_MULTIPLE",
                "AUCTION_WINDOW_SECONDS", "BID_EXTENSION_SECONDS"):
        assert key in block["constraints"] or key in block["constants"]
    # PRIME_P0_MIN (D-99), D_MIN (D-30) and the flat MIN_INCREMENT (D-33) are
    # deleted outright -- no tombstone keys.
    for gone in ("PRIME_P0_MIN_TON", "D_MIN", "MIN_INCREMENT"):
        assert gone not in block["constraints"]
    assert "PRIME_P0_MIN_TON" not in block["constants"]
    # RESERVE_FLOOR left the declared list under D-30: it is now DERIVED, equal
    # to MINT_PRICE + RES_GAS. The block must say so, because a floor that reads
    # as declared is a floor nobody re-derives when the settlement gas moves.
    assert "DERIVED" in block["constraints"]["RESERVE_FLOOR_TON"]
    # and MIN_INCREMENT left it too -- D-33 makes it a sim output.
    assert "min_increment" not in block


def test_bid_extension_is_prime_and_inside_its_admissible_range():
    """D10. The constant with a wide admissible range, spent on a number that
    belongs to the project: 30 minutes is long enough that a bidder in any
    timezone can respond, 2 hours short enough that a lot terminates."""
    assert tr.is_prime(C.BID_EXTENSION_SECONDS // 60)
    assert 30 * 60 <= C.BID_EXTENSION_SECONDS <= 2 * 3600
    assert C.AUCTION_WINDOW_SECONDS == 7 * 24 * 3600


def test_the_bid_increment_ladder_ships_in_acquisition(params):
    """D-33 makes the minimum bid increment a FUNCTION OF `D(n)` and a sim
    output: the shipped ladder is there, monotone, and indexed the way a Tolk
    contract indexes it."""
    lad = params["acquisition"]["bid_increment_ladder"]
    assert lad["score_halving"] == C.SCORE_HALVING
    assert lad["rungs"] == C.SCORE_MAX // C.SCORE_HALVING + 1
    assert len(lad["min_increment_bps"]) == lad["rungs"]
    assert len(lad["min_increment_floor_nanoton"]) == lad["rungs"]
    # D-33's stated shape: a rarer number requires larger bid steps.
    bps = lad["min_increment_bps"]
    assert all(bps[i] <= bps[i + 1] for i in range(len(bps) - 1))
    # the floor is a measured gas round trip, not the retired flat 1 TON
    assert lad["min_increment_floor_ton"] < 1.0
    assert lad["min_increment_floor_nanoton"][0] == int(
        round(lad["min_increment_floor_ton"] * 1e9))


def test_gas_group_degrades_gracefully_until_the_contract_lands(block):
    """SS8: the lot lane's rows are `market.*` (D-3 folded the trophy auction
    into `primes_market.tolk`). If any is ever missing from the baseline the
    group must say so rather than invent a number or crash the regeneration."""
    gas = block["gas"]
    if gas["measured"]:
        assert not gas["missing_rows"]
        assert set(gas["rows"]) >= {"market.open_lot", "market.bid_head_prime",
                                    "market.close"}
    else:
        assert gas["missing_rows"]
        assert "NOT MEASURED" in gas["_note"]


def test_params_json_block_matches_this_module(block):
    """`shared/params.json` is generated from here; drift between them means the
    contract is being checked against a stale copy of the constants."""
    assert block["constants"] == asdict(C)
    assert block["price_map"]["frac_table"] == tr.FRAC
    assert block["price_map"]["frac_scale_bits"] == tr.FRAC_SCALE_BITS
    assert block["price_map"]["mint_price_nanoton"] == tr.MINT_PRICE_NANOTON
    for d, ton in block["price_map"]["plan_rungs_ton"].items():
        assert tr.ladder_nanoton(int(d)) / tr.NANO == pytest.approx(ton)
    for row in block["price_table_composites"] + block["price_table_primes"]:
        n = row["n"]
        assert row["score"] == ds.score(n)
        assert row["class"] == ("prime" if tr.is_prime(n) else "composite")
        assert row["lane"] == tr.lane(n, row["score"])
    assert block["reserve_floor_identity"]["holds"]


def test_the_scored_fee_is_deleted_and_the_block_says_so(params):
    """D-30/D-33: `RES_PREMIUM` as a fee is deleted, and with it `PREMIUM_UNIT`,
    `PREMIUM_CAP`, `RES_PRIORITY_BASE` and the whole normalisation solve.

    This replaces the coverage that asserted the fee ladder was live. The
    property that matters now is the negative one: `shared/params.json` must not
    still be publishing a scored fee, because a contract or a UI reading those
    keys would be charging a price the design deleted. The score itself is
    untouched -- D-33 is explicit about that -- so the weights are asserted to
    still be there.
    """
    des = params["score"]
    for gone in ("premium_unit_ton", "premium_cap_ton", "res_priority_base_ton",
                 "normalisation", "fee_lane_max_score", "fee_lane_max_premium_ton"):
        assert gone not in des, f"`{gone}` is deleted by D-30/D-33"
    assert des["weights"]["SCORE_MAX"] == ds.W.SCORE_MAX
    assert "acquisition.bid_increment_ladder" in des["_score_consumers"]["min_bid_increment"]
    # D-99 moved the block out of the RES_GAS block; no signpost is left.
    assert "desirability" not in params["off_head"]

def test_the_clamp_is_reached_by_real_numbers_not_only_in_principle(params):
    """Under the pre-D-99 score the realised maximum (86) sat below the clamp
    (120), so the top of the ladder was a guard. D-99 sets the clamp AT the
    ceiling the owner declared, and the smallest primes reach it -- which is the
    difference between a bound and a price.
    """
    hist = params["score"]["histogram"]
    assert hist["max_score"] == ds.W.SCORE_MAX == 87
    assert ds.score(2) == ds.score(3) == ds.score(5) == 87
    assert "max_score_achievable" not in hist

def test_gas_rows_are_the_names_the_baseline_publishes():
    """The group read `trophy_auction.*` keys GasRegression.spec.ts never wrote,
    so it reported NOT MEASURED for ever. Every row it asks for must exist."""
    import json
    from primes_sim import gas as gasmod
    baseline = json.loads(gasmod.DEFAULT_GAS_BASELINE_PATH.read_text())
    assert not set(gasmod.TROPHY_AUCTION_ROWS) - set(baseline)
