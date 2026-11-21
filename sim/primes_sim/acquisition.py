"""The unified acquisition lane -- CONCEPT.md SS4.4 as superseded 2026-08-19.

`DECISIONS.md` D-30, D-31, D-32, D-33 replace two ways of getting a number ahead
of the head with **one, and it depends only on primality**:

    composite  ->  ascending auction lot. Opening IS a paid first bid at P0(n).
                   No `D_MIN` gate. 7-day clock, D-8 anti-snipe extension. The
                   won lot becomes a claim that waits for the head and NEVER
                   expires; the winner may release it for 90% (D-32).
    prime      ->  descending Dutch lane, openable BEFORE its turn at a flat
                   P0(p). The decay clock starts at its turn and terminates at
                   exactly MINT_PRICE.
    primorial  ->  neither; mint at the head only (SS7).

This module owns the three quantities that mechanic newly owes and that no
existing module can answer, because each of them turns on the **deleted gate**:

  * `open_lot_volume` -- Q26's new half: simultaneously-open-lot volume AND
    post-win queue depth, both from one Little's-law identity. Removing `D_MIN`
    multiplies the openable set by ~70x, so the question stops being "how many
    numbers qualify" and becomes "how many lots can be open at once, and does
    the resulting claim queue congest the head". Q26's old half -- a
    head-collision probability, at a distance or as a curve in one -- is
    retired outright by D-45: the ledger takes a composite off its sequential
    line the instant a lot opens, so there is no longer a collision for any
    distance to bound.
  * `bid_increment_ladder` -- D-33's new consumer of the score. **A contract is
    being written against this right now**, so it is emitted in a shape a Tolk
    contract consumes directly: two integer arrays indexed by
    `D / SCORE_HALVING`, one entry per rung (nine under D-99's SCORE_MAX = 87).
  * `release_forfeit_check` -- D-32's hard constraint, at the low end of `P0`.

**What is derived here and what is declared.** Derived: the increment ladder
(swept against D-21's signed objective), the collision curve, the open-lot and
queue-depth identities, and the D-32 comparison. Declared and labelled as such:
the demand-rate axis the volume model is swept over, because no realised
open-lot rate exists pre-launch and inventing one would be inventing a
parameter. The sweep is anchored on the one demand rate the sim HAS measured --
the engine's realised head velocity -- so every row is quoted as a multiple of
it rather than as an absolute nobody can check.
"""

from __future__ import annotations

import math

import numpy as np

from . import trophy_auction as ta

DAY = 86400.0


# --------------------------------------------------------------------------- #
# D-33 -- the minimum bid increment ladder
# --------------------------------------------------------------------------- #

#: The ladder is indexed by `D(n) / SCORE_HALVING`, so it has this many rungs
#: over `[0, SCORE_MAX]`. **NINE** at the shipped `SCORE_HALVING = 10` and
#: D-99's `SCORE_MAX = 87` -- it was thirteen while the old 0..120 score lived,
#: and the contract's `getIncrementLadder()` still publishes thirteen entries
#: until it is re-emitted. One integer divide and one array lookup on TVM -- the
#: same shape and the same cost as the `FRAC` table `P0` already ships.
def ladder_rungs(c: ta.TrophyConstants = ta.C) -> int:
    return c.SCORE_MAX // c.SCORE_HALVING + 1


#: The percentages the sweep is allowed to select from, in basis points of the
#: standing high bid. Bounded below by "smaller than this and a raise costs the
#: protocol more than it moves the price" (see `increment_floor_ton`) and above
#: by "larger than this and one legal raise is a doubling". Integer basis points
#: because the contract computes `high * BPS / 10000`.
BPS_GRID = (100, 200, 300, 500, 800, 1000, 1500, 2000, 3000)


def increment_floor_ton(bid_round_trip_ton: float, *,
                        quantum_ton: float = 0.005) -> float:
    """The absolute floor under one legal raise, DERIVED, not chosen.

    A raise is not free to the protocol: it costs the gas of the bid itself plus
    the gas and attached value of the refund it forces on the previous high
    bidder. An increment smaller than that round trip makes a raise **cost more
    than it moves the price**, which is a griefing primitive rather than price
    discovery. So the floor is that round trip, rounded up to the quantum.

    This is the number that replaces the flat `MIN_INCREMENT_FLOOR = 1 TON`. The
    1 TON floor was defensible while `D_MIN = 30` kept the cheapest lot at 8 TON;
    with the gate dropped the cheapest lot opens at `MINT_PRICE + RES_GAS`, and a
    1 TON step there is a ~94% raise that ends the auction on the second bid.
    """
    return math.ceil(bid_round_trip_ton / quantum_ton) * quantum_ton


def rounds_to_walk(p0_ton: float, target_ton: float, *, floor_ton: float,
                   bps: int) -> float:
    """How many legal raises it takes to walk a lot from `P0` to `target`.

    The message-count cost of price discovery and the griefing bound, in one
    number. Computed under the shipped rule `step = max(floor, bps/10^4 * high)`,
    which is geometric once the percentage term dominates and arithmetic below
    that, so it is walked rather than solved in closed form.
    """
    if target_ton <= p0_ton:
        return 0.0
    high, n = p0_ton, 0
    while high < target_ton and n < 100_000:
        high += max(floor_ton, bps / 10_000.0 * high)
        n += 1
    return float(n)


def bid_increment_ladder(census: dict, prime_npv: dict, prem, *,
                         res_gas_ton: float, bid_round_trip_ton: float,
                         c: ta.TrophyConstants = ta.C,
                         bps_grid: tuple[int, ...] = BPS_GRID,
                         draws: int = 400, seed: int = 20260817) -> dict:
    """**D-33's owed output.** The minimum bid increment as a function of `D(n)`.

    *Why the score should set it at all* is D-33's, not the sim's: "a rarer
    number requires larger bid steps, so a contested rare number resolves in
    fewer rounds instead of grinding through hundreds of minimum raises." What
    the sim owes is the size of the step at each rung, and it is chosen under
    **the same signed objective the weights are chosen under** (D-21): per rung,
    the basis-point step that maximises expected premium captured to the ratchet,
    subject to that rung's participation not falling below the same threshold.

    The trade the sweep is resolving is real and runs both ways:

      * **too small** and a contested lot grinds through hundreds of escrowed
        raises, each forcing a refund -- the message-count cost D-11 named;
      * **too large** and the runner-up cannot reach their own valuation, so the
        clearing price is truncated DOWNWARD to the last rung they could afford
        and the premium the ratchet captures falls. `market.ascending_outcome`
        models that truncation explicitly, which is what lets the sweep see it.

    Emitted in the shape a Tolk contract consumes: two integer arrays indexed by
    `D / SCORE_HALVING`.
    """
    from . import market as mk

    rng = np.random.default_rng(seed)
    floor_ton = increment_floor_ton(bid_round_trip_ton)
    rungs = ladder_rungs(c)

    anchor = mk.plain_composite_value_ton(
        composite_accept_target=prem.composite_accept_target,
        typical_composite_k=prem.typical_composite_k, sigma=prem.sigma)
    comp = mk.composite_values(census, gamma=prem.gamma,
                               plain_value_ton=anchor["mean_ton"])

    # Bucket the composite line by rung. Primes are excluded: their lane is
    # descending and has no bid increment at all (D-31).
    buckets: dict[int, list[tuple[object, int]]] = {r: [] for r in range(rungs)}
    for cell, count in census["cells"].items():
        if cell.prime:
            continue
        r = min(cell.score // c.SCORE_HALVING, rungs - 1)
        buckets[r].append((cell, count))

    # ---- one MC sweep per (rung, bps), then select over the whole ladder ---
    # The selection is NOT per-rung-argmax. Two reasons, both from the signed
    # decisions rather than from taste:
    #
    #   1. **D-33 fixes the SHAPE**: "a rarer number requires larger bid steps."
    #      A ladder that is not monotone non-decreasing in the rung contradicts
    #      the decision it implements, whatever it scores. So the selection is
    #      over MONOTONE vectors only, by dynamic programme.
    #   2. **D-21's constraint 1 cannot bind on this choice, and the sweep
    #      PROVES it rather than assuming it.** Whether a composite lot opens
    #      and sells depends only on whether some buyer values it at or above
    #      `P0` -- under D-30 that buyer is the opener, and an unchallenged
    #      opener wins. The increment moves only the clearing price ABOVE that.
    #      So the sale rate must be identical across every basis-point candidate
    #      at a rung, and `_constraint_1_independence_check` asserts it is. If
    #      it ever is not, the model has drifted and the assertion fires.
    grid_n = len(bps_grid)
    cell_stats: list[list[dict]] = []
    for r in range(rungs):
        cells = buckets[r]
        per_bps = []
        for bi, bps in enumerate(bps_grid):
            # CONTROLLED COMPARISON: every basis-point candidate at this rung
            # sees the SAME bidder draws. Sharing one advancing generator across
            # the grid made the sweep compare different random worlds, and the
            # sale rate -- which cannot depend on the increment at all -- moved
            # with it. That is the exact bug that produced a non-monotone
            # ladder on the first pass.
            rng = np.random.default_rng(seed + 1_000 * r)
            premium = sold = lots = rounds_acc = 0.0
            for cell, count in cells:
                p0 = ta.p0_ton(cell.score, c=c)
                value = comp["value_ton"].get(cell, anchor["mean_ton"])
                out = mk.ascending_outcome(
                    p0, value, lam=prem.lam_ascending, sigma=prem.sigma,
                    rng=rng, draws=draws,
                    increment_floor_ton=floor_ton, increment_bps=bps)
                ppl = max(out["mean_clearing_unconditional_ton"]
                          - (ta.MINT_PRICE_TON + res_gas_ton) * out["sale_probability"],
                          0.0)
                premium += count * ppl
                sold += count * out["sale_probability"]
                lots += count
                rounds_acc += count * out["mean_rounds"]
            per_bps.append({
                "bps": bps,
                "lots": lots,
                "premium_total_ton": premium,
                "sold": sold,
                "premium_per_lot_ton": (premium / lots) if lots else 0.0,
                "sale_rate": (sold / lots) if lots else None,
                "mean_rounds": (rounds_acc / lots) if lots else None,
            })
        cell_stats.append(per_bps)

    def best_monotone(key: str) -> list[int]:
        """Max total `key` over non-decreasing bps index sequences. O(rungs*grid)."""
        NEG = float("-inf")
        val = [[NEG] * grid_n for _ in range(rungs)]
        prev = [[-1] * grid_n for _ in range(rungs)]
        for j in range(grid_n):
            val[0][j] = cell_stats[0][j][key]
        for r in range(1, rungs):
            run_best, run_arg = NEG, -1
            for j in range(grid_n):
                if val[r - 1][j] > run_best:
                    run_best, run_arg = val[r - 1][j], j
                val[r][j] = run_best + cell_stats[r][j][key]
                prev[r][j] = run_arg
        j = max(range(grid_n), key=lambda k: val[rungs - 1][k])
        path = [0] * rungs
        for r in range(rungs - 1, -1, -1):
            path[r] = j
            j = prev[r][j] if r else j
        return path

    # Constraint 1 independence, checked rather than asserted in prose.
    worst_drift = 0.0
    for r in range(rungs):
        rates = [b["sale_rate"] for b in cell_stats[r] if b["sale_rate"] is not None]
        if rates:
            worst_drift = max(worst_drift, max(rates) - min(rates))
    if worst_drift > 1e-9:
        raise ValueError(
            "the sale rate moved with the bid increment "
            f"(worst spread {worst_drift}). It cannot: under D-30 a lot opens "
            "iff some buyer values it at or above P0, and the increment only "
            "moves the clearing price above that. The model has drifted."
        )

    path = best_monotone("premium_total_ton")
    lane_lots = sum(cell_stats[r][path[r]]["lots"] for r in range(rungs))
    lane_opened = sum(cell_stats[r][path[r]]["sold"] for r in range(rungs))
    open_rate = (lane_opened / lane_lots) if lane_lots else 0.0
    selection_rule = (
        "argmax of TOTAL premium over MONOTONE ladders (D-33's stated shape). "
        "D-21's constraint 1 does not bind on this choice and is not applied as "
        "one: an opened composite lot always sells under D-30, and the "
        "increment cannot change whether a lot opens -- checked above, not "
        "assumed. The premium curve is FLAT: across the whole basis-point grid "
        "it moves a few percent while the round count moves by an order of "
        "magnitude, so the argmax is also the reading D-33 asks for -- *a "
        "contested rare number resolves in fewer rounds instead of grinding "
        "through hundreds of minimum raises.*"
    )

    rows = []
    bps_by_rung: list[int] = []
    floor_by_rung: list[int] = []
    for r in range(rungs):
        chosen = cell_stats[r][path[r]]
        d_lo, d_hi = r * c.SCORE_HALVING, (r + 1) * c.SCORE_HALVING - 1
        p0_lo = ta.p0_ton(d_lo, c=c)
        row = {
            "rung": r, "d_lo": d_lo, "d_hi": d_hi,
            "p0_at_rung_floor_ton": round(p0_lo, 6),
            "census_lots": int(chosen["lots"]),
            "selected_bps": chosen["bps"],
            "rounds_per_doubling": round(
                rounds_to_walk(p0_lo, 2 * p0_lo, floor_ton=floor_ton,
                               bps=chosen["bps"]), 1),
            "floor_binds_below_ton": round(
                floor_ton / (chosen["bps"] / 10_000.0), 4),
        }
        if chosen["lots"]:
            row.update({
                "premium_per_lot_ton": round(chosen["premium_per_lot_ton"], 6),
                "sale_rate": round(chosen["sale_rate"], 6),
                "mean_rounds_to_clear": round(chosen["mean_rounds"], 3),
                "by_bps": [{k: (round(v, 6) if isinstance(v, float) else v)
                            for k, v in b.items()} for b in cell_stats[r]],
            })
        else:
            row["_empty_rung"] = (
                "no number in the census window scores in this rung, so the "
                "value is carried by the monotonicity constraint from the rungs "
                "that do. The rung still has to carry a value because the "
                "contract indexes it and AUCTIONABLE_MAX admits numbers the "
                "window does not contain."
            )
        rows.append(row)
        bps_by_rung.append(chosen["bps"])
        floor_by_rung.append(int(round(floor_ton * ta.NANO)))

    return {
        "_provenance": "derived",
        "_question": (
            "D-33: the desirability score sets the minimum bid increment. The "
            "sim owes the ladder. LAUNCH_FIX_PLAN W1.4 is shipping an inert "
            "default until this lands."
        ),
        "_objective": (
            "D-21 as signed, over the whole ladder at once: maximise expected "
            "premium captured to the ratchet, subject to LANE participation not "
            "falling below the same declared floor (D-21 puts the constraint on "
            "the lane, not on a lot, and applying it per rung would kill the "
            "deep rungs for a property of the PRICE ladder rather than of the "
            "increment). It is the SAME objective the weights are chosen under, "
            "because the increment and the opening price are two consumers of "
            "one score and optimising them against different objectives would "
            "let them fight. The search is restricted to MONOTONE "
            "NON-DECREASING ladders, which is D-33's own stated shape -- "
            "*a rarer number requires larger bid steps* -- and not a smoothing "
            "convenience: a non-monotone ladder contradicts the decision it "
            "implements whatever it scores."
        ),
        "_selection_rule": selection_rule,
        "_constraint_1_independence_check": {
            "worst_sale_rate_spread_across_bps": worst_drift,
            "_meaning": (
                "0 by construction and asserted: under D-30 a composite lot "
                "opens iff some buyer values it at or above P0, and an "
                "unchallenged opener wins at P0, so the bid increment cannot "
                "change whether a lot opens or sells. D-21's constraint 1 is "
                "therefore not binding on the increment and is not applied to "
                "it -- which is a finding, not an omission."
            ),
        },
        "composite_open_rate": round(open_rate, 6),
        "_open_rate_note": (
            "Share of the composite line that attracts an opener at all. A "
            "DIAGNOSTIC, not a constraint: a number nobody opens produces no "
            "lot, no locked capital and no state, so a low open rate is the "
            "lane declining to price something rather than the lane failing."
        ),
        "_contract_rule": (
            "step = D / SCORE_HALVING; "
            "min_increment = max(min_increment_floor_nanoton[step], "
            "high_bid_nanoton * min_increment_bps[step] / 10000). "
            "One integer divide, two array lookups, one multiply, one divide -- "
            "the same shape as the FRAC table P0 already ships. `high_bid` is "
            "the STANDING high bid, which at the moment the lot opens is P0(n) "
            "itself, because under D-30 opening IS the first bid."
        ),
        "score_halving": c.SCORE_HALVING,
        "score_max": c.SCORE_MAX,
        "rungs": rungs,
        "min_increment_bps": bps_by_rung,
        "min_increment_floor_nanoton": floor_by_rung,
        "min_increment_floor_ton": round(floor_ton, 9),
        "_floor_derivation": (
            "The floor is the gas round trip one competing raise imposes -- the "
            f"bid plus the refund it forces, {bid_round_trip_ton:.6f} TON -- "
            "rounded up to the 0.005 TON quantum. An increment below it makes a "
            "raise cost the protocol more than it moves the price. It REPLACES "
            "the flat 1 TON floor, which was defensible only while D_MIN kept "
            "the cheapest lot at 8 TON: at the D_MIN-free floor P0 of "
            f"{ta.p0_ton(0, c=c)} TON a 1 TON step is a ~94% raise that ends "
            "the auction on the second bid."
        ),
        "by_rung": rows,
        "premises": mk.asdict(prem),
        "_status": "BOUNDED",
        "_status_note": (
            "BOUNDED, like every other number that rests on a bidder-arrival "
            "process no lot has ever tested. What IS robust is the SHAPE: the "
            "ladder is monotone by construction (D-33), the floor is a measured "
            "gas round trip rather than a preference, and the direction of the "
            "trade at every rung is the same truncation effect -- too small and "
            "a lot grinds through raises, too large and the runner-up cannot "
            "reach their own valuation and the clearing price is truncated "
            "DOWNWARD. The exact basis points inherit Q25's BOUNDED status. "
            "`by_bps` carries the whole curve at every populated rung so the "
            "owner can see how flat the optimum is rather than take the argmax "
            "on trust. Recalibrate against one month of realised bids; nothing "
            "here may be quoted on a public surface before then (SS9.1)."
        ),
    }


# --------------------------------------------------------------------------- #
# Q26 re-scoped, part 2 -- open-lot volume and post-win queue depth
# --------------------------------------------------------------------------- #


def open_lot_volume(*, mints_per_day: float, mean_open_days: float,
                    participation: float, mean_open_distance_mints: float,
                    p0_floor_ton: float, mean_clearing_ton: float,
                    open_rate_multiples=(0.1, 0.25, 0.5, 1.0, 2.0, 5.0),
                    c: ta.TrophyConstants = ta.C) -> dict:
    """Simultaneously-open-lot volume and post-win queue depth, under D-30.

    **Why this is a swept identity and not a forecast.** Dropping `D_MIN` removes
    the only thing that bounded the openable set: every composite up to
    `AUCTIONABLE_MAX` may now be opened, which is not a number that can be
    multiplied by anything useful. What bounds the lane instead is **capital** --
    opening is a paid first bid of at least `P0` locked for the window -- and no
    realised open rate exists pre-launch. Inventing one would be inventing a
    parameter (CLAUDE.md rule 3), so the model is stated as an identity and swept
    over an open rate expressed as a **multiple of the one demand rate the sim
    has measured**: the engine's realised head velocity in composite mints per
    day. Every row is therefore checkable against a quantity the reader already
    has.

    The identities, all Little's law:

        simultaneously open lots     L = R_open * mean_open_days
        TON locked in open bids      = L * mean_clearing
        claims created per day       R_claim = R_open * participation
        claim density on the head    = R_claim / mints_per_day
        post-win queue depth         Q = R_claim * mean wait for the head
        mean wait (days)             = mean_open_distance / mints_per_day

    **Claim density is the congestion answer.** It is the fraction of the numbers
    the head passes that arrive already claimed. Below 1 the head absorbs them --
    each is one extra `settle(n)`, funded by its own `RES_GAS`. At or above 1 the
    lane is creating claims faster than the head retires them, the queue grows
    without bound, and the mean wait diverges. That is the launch-blocking
    threshold and it is a ratio of two rates, so it does not depend on the level
    of the demand nobody has measured.
    """
    rows = []
    for m in open_rate_multiples:
        r_open = m * mints_per_day
        lots = r_open * mean_open_days
        r_claim = r_open * participation
        density = r_claim / mints_per_day if mints_per_day else float("inf")
        wait_days = mean_open_distance_mints / mints_per_day if mints_per_day else float("inf")
        rows.append({
            "open_rate_multiple_of_head_velocity": m,
            "lots_opened_per_day": round(r_open, 2),
            "simultaneously_open_lots": round(lots, 1),
            "ton_locked_in_open_bids": round(lots * mean_clearing_ton, 1),
            "claims_created_per_day": round(r_claim, 2),
            "claim_density_on_the_head": round(density, 4),
            "head_absorbs": density < 1.0,
            "post_win_queue_depth": round(r_claim * wait_days, 1),
            "ton_locked_in_waiting_claims": round(
                r_claim * wait_days * mean_clearing_ton, 1),
            "mean_wait_for_head_days": round(wait_days, 2),
        })
    return {
        "_model": (
            "Little's law on both stages: L = R * W for the open lots and again "
            "for the claim queue. NOT a forecast -- the open rate R is the swept "
            "axis and is DECLARED as a multiple of the engine's realised head "
            "velocity, which is the only demand rate this repo has measured."
        ),
        "mints_per_day_measured": round(mints_per_day, 3),
        "mean_open_days": round(mean_open_days, 4),
        "participation_modelled": round(participation, 4),
        "mean_open_distance_mints": round(mean_open_distance_mints, 1),
        "p0_floor_ton": p0_floor_ton,
        "mean_clearing_ton": round(mean_clearing_ton, 4),
        "rows": rows,
        "congestion_threshold": {
            "_rule": "claim_density_on_the_head = lots_won_per_day / mints_per_day",
            "critical_open_rate_multiple": round(1.0 / participation, 4)
            if participation else None,
            "_reading": (
                "The head absorbs the claim queue while claim density is below "
                "1: every claimed number the head reaches is one extra settle(n), "
                "and each one arrives with its own RES_GAS attached, so the cost "
                "is prepaid and the head does not stall. At density 1 the lane "
                "creates claims exactly as fast as the head retires them and the "
                "queue stops clearing; above it the queue and the mean wait both "
                "diverge. Since density is a RATIO of two rates it is independent "
                "of the demand level nobody has measured, which is what makes "
                "this the part of the answer that is robust."
            ),
        },
        "_gate_free_note": (
            "Nothing in this model reintroduces a `D_MIN`. It is deliberately "
            "gate-free, because the question W8.1 asks is exactly what the "
            "gate-free lane does. The eligibility count is no longer the binding "
            "constraint -- trophy_auction.openable_lots reports it at the whole "
            "window -- and capital is."
        ),
    }


# --------------------------------------------------------------------------- #
# `release_forfeit_check` is DELETED (D-90.2)
# --------------------------------------------------------------------------- #
#
# It checked D-32's hard constraint -- the 10% release forfeit had to exceed the
# gas of an open-and-release round trip, or releasing was free and opening lots
# became costless griefing -- at the low end of `P0`, where it bound. D-90.2
# deletes the release right itself: once a won lot MINTS AT CLOSE there is
# nothing to hand back, so there is no forfeit, no round trip and no inequality
# to check. `gas.open_release_round_trip`, which priced the right-hand side,
# goes with it.
#
# The griefing vector it guarded is closed by a different mechanism, and was
# already: D-88 point 3 makes opening a lot a PAID first bid of at least
# `PRIME_P0_MIN`, so a permanent record costs a real bid rather than gas,
# whether or not the opener can hand it back.


# --------------------------------------------------------------------------- #
# D-212 -- the naming fees, in TON, owner-set (D-179's PRIMES burn is deleted)
# --------------------------------------------------------------------------- #

# The owner (2026-11-21): any current owner names a number ONCE for about 50 EUR
# in TON; a rename costs 200 TON. Both go to the ratchet floor as a pure floor
# step (T rises, S does not), so the sim carries them with their source and
# derives nothing. The first-naming fee has NO TON figure here on purpose: a
# contract cannot read EUR, so the TON amount is chosen from the genesis-day
# TON/EUR rate and passed to genesis as `PRIMES_NAME_FEE_TON`
# (contracts/scripts/deployGenesis.ts `resolveNamingFees`), which refuses to run
# without it.
RENAME_FEE_TON: float = 200.0
NAME_FEE_EUR: float = 50.0


def naming_block() -> dict:
    """`naming` -- SS4.7.1's two TON fees (D-212).

    Pure: nothing in it depends on the run, so `test_params_ownership.py` can
    prove the committed block equals this function without re-running the sim.
    """
    return {
        "_provenance": "owner, DECISIONS.md D-212",
        "_note": (
            "D-212 replaces D-179's PRIMES burn (and deletes primes_sink.tolk): "
            "the CURRENT OWNER of a minted number names it for a TON fee sent to "
            "the collection's `name_number`; the fee is forwarded to the ledger "
            "as `royalty_to_ratchet`, a pure floor step. Both fees are deploy "
            "data on the collection (the rename fee also on the registrar, for "
            "an era trophy's paid re-engraving), with no setter."
        ),
        "name_fee_eur": NAME_FEE_EUR,
        "_name_fee_rule": (
            "the first naming of a number. TON figure = name_fee_eur at the "
            "TON/EUR rate on genesis day, passed as PRIMES_NAME_FEE_TON; no "
            "default exists, and a genesis without it fails"
        ),
        "rename_fee_ton": RENAME_FEE_TON,
        "_rename_fee_rule": (
            "every later naming of the same number, by whoever owns it then, "
            "and every era-trophy engraving after its free first one. "
            "PRIMES_RENAME_FEE_TON may lower it on testnet only"
        ),
        "_invariant": (
            "a naming fee raises T by exactly the fee and leaves S untouched "
            "(SS5); every refusal refunds the whole payment"
        ),
    }
