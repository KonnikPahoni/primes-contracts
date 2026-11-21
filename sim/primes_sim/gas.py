"""`OPS_RESERVE` derivation — CONCEPT.md SS4.1.

The gas-&-ops line takes a flat share of every mint, DERIVED here since
DECISIONS.md D-117 (`gas_ops_line`: the measured worst-case mint, rounded up to a
whole percent). Ordinary mints cost well under it, and the surplus is swept by
the permissionless `sweep_ops`:

    sweepable = balance - declared_liability - OPS_RESERVE

`OPS_RESERVE` is the standing float the sweep may never dip into. CONCEPT.md
SS4.1 requires it to be *derived rather than chosen*: it is a float for the costs
a mint cannot pay at mint time -- `owed` storage rent and reservation
settlement gas -- so it is sized as **one horizon of deferred draw**.

(Amortized FLUSH gas was a third leg until DECISIONS.md D-146, signed
2026-09-22: every permissionless ratchet leg is now paid by its caller, who
attaches the venue's gas and gets the change back, so no flush is a deferred
cost of any mint and the leg is gone from the sum rather than set to zero.)

Everything on the right-hand side is a measurement:

  * per-operation gas comes from `contracts/gas-baseline.json`, the only place in
    this repo that measures real TVM gas (`GasRegression.spec.ts` pins it);
  * the gas price is this chain's basechain config 21, read live from the
    sandbox in Phase 0; the measurement basis is CLAUDE.md "Measured provenance";
  * storage prices are basechain config 18;
  * the *frequencies* -- how many `owed` entries exist and how fast mints
    arrive -- come from the Phase 1 run itself.

The single judgment left is `HORIZON_MINTS`, and it is declared alongside the
result in `shared/params.json`. Oversizing it costs the operator delayed revenue
and costs a user nothing: the reserve can only ever sit on the ledger, and SS4.1
excludes it from `getSolvency()`'s liability term precisely so that a ledger
merely holding its float does not read as insolvent.

The construction carries the same incentive the sweep itself does. When the
implementation gets cheaper the harness says so on the next run and the reserve
falls with it; nobody has to remember to lower a hand-set number.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

# --------------------------------------------------------------------------- #
# Network prices. Not our choice -- TON basechain config.
# --------------------------------------------------------------------------- #

#: config 21, basechain. `gas_price` is scaled by 2**16. Read live from
#: `blockchain.config` during Phase 0; see CLAUDE.md "Measured provenance".
GAS_PRICE_NANOTON_PER_UNIT = 4369067 / 65536  # ~= 66.6683
FLAT_GAS_PRICE_NANOTON = 6667                 # per transaction, config 21
NANOTON = 1e-9

#: config 18, basechain. Both scaled by 2**16, charged per second.
CELL_PRICE_PS_NANOTON = 500 / 65536  # ~= 0.007629 nanoTON / cell / second
BIT_PRICE_PS_NANOTON = 1 / 65536     # ~= 1.526e-5 nanoTON / bit / second

#: Cells charged rent per `owed` entry. One entry per *prime*, not per mint --
#: SS3.4 puts `owed` on the items. NOT the storage analysis's figure: `storage.py`
#: carries 2.00 (measured, Phase 0) and 2.50 (conservative, v5 entry stamp) for
#: the config-43 cell ceiling, where overstating would under-size shards. Here
#: overstating only over-reserves rent, so this rounds up past both to a whole
#: 3 cells. Moving it moves `ops_reserve` in params.json -- a sim re-run.
OWED_CELLS_PER_ENTRY = 3.0
OWED_BITS_PER_ENTRY = OWED_CELLS_PER_ENTRY * 800  # a cell is <= 1023 bits

#: The one judgment. How many mints of runway the ledger should hold before the
#: sweep is allowed to take anything. Declared, not fitted.
HORIZON_MINTS = 10_000


def gas_to_ton(gas_units: float, transactions: int = 1) -> float:
    """Compute cost of `gas_units` spread over `transactions` messages, in TON."""
    return (
        gas_units * GAS_PRICE_NANOTON_PER_UNIT + transactions * FLAT_GAS_PRICE_NANOTON
    ) * NANOTON


def load_gas_baseline(path: str | Path) -> dict[str, int]:
    """Read `contracts/gas-baseline.json`. Keys are `contract.entrypoint`."""
    with open(path, encoding="utf-8") as fh:
        return {k: int(v) for k, v in json.load(fh).items() if not k.startswith("_")}


@dataclass(frozen=True)
class OpsReserve:
    """A derived `OPS_RESERVE`, with every term kept so the report can show it."""

    horizon_mints: int
    horizon_seconds: float
    settlement_gas_ton_per_mint: float
    owed_rent_ton_per_second: float
    settlement_ton: float
    owed_rent_ton: float
    total_ton: float
    reserve_ton: float
    deferred_draw_ton_per_mint: float
    inputs: dict

    def as_params(self) -> dict:
        """The `fees` fragment for shared/params.json."""
        return {
            "ops_reserve_ton": self.reserve_ton,
            "ops_reserve_derivation": {
                "rule": (
                    "OPS_RESERVE = one HORIZON_MINTS of deferred draw, rounded up to "
                    "the next whole TON. Deferred draw = reservation settlement gas + "
                    "`owed` storage rent over the same horizon. (Amortized flush gas was "
                    "a third term until D-146: the caller of every permissionless ratchet "
                    "leg pays its own venue gas, so no flush is a deferred cost of a mint.)"
                ),
                "horizon_mints": self.horizon_mints,
                "horizon_seconds": round(self.horizon_seconds, 1),
                "settlement_gas_ton_per_mint": self.settlement_gas_ton_per_mint,
                "owed_rent_ton_per_second": self.owed_rent_ton_per_second,
                "settlement_ton": round(self.settlement_ton, 6),
                "owed_rent_ton": round(self.owed_rent_ton, 6),
                "unrounded_total_ton": round(self.total_ton, 6),
                "deferred_draw_ton_per_mint": self.deferred_draw_ton_per_mint,
                "inputs": self.inputs,
            },
        }


def ops_reserve(
    gas_baseline: dict[str, int],
    *,
    total_mints: int,
    horizon_days: float,
    owed_entries: int,
    horizon_mints: int = HORIZON_MINTS,
    settlement_rate: float = 1.0,
) -> OpsReserve:
    """Size `OPS_RESERVE` from measured gas and measured Phase 1 frequencies.

    `settlement_rate` defaults to 1.0 -- *every* mint arriving through a
    reservation. The Phase 1 run puts the real figure well below that
    (D-30 deleted the reservation lane), but the conservative bound is the
    defensible one here: over-reserving only delays operator revenue, whereas
    under-reserving is the ledger running out of gas to settle a reservation
    somebody already paid `res_fee_ton` for. SS4.1 states that asymmetry.
    """
    # --- leg 1: settlement. D-90: TWO messages, not three. A won lot settles in
    # its own close (`market.close` -> `ledger.mint_won_lot`); the
    # shard hop and the later permissionless `settle(n)` are both deleted.
    settle_gas = (
        gas_baseline["ledger.mint_won_lot"]
        + gas_baseline["market.close"]
    )
    settlement_per_mint = gas_to_ton(settle_gas, transactions=2) * settlement_rate

    # --- (leg 2, amortized flush gas, is DELETED by D-146: the caller pays.) ---

    # --- leg 3: `owed` storage rent. One entry per prime, held forever. ---
    owed_rent_per_second = (
        owed_entries
        * (
            OWED_CELLS_PER_ENTRY * CELL_PRICE_PS_NANOTON
            + OWED_BITS_PER_ENTRY * BIT_PRICE_PS_NANOTON
        )
        * NANOTON
    )

    # Convert the horizon from mints to seconds at the Phase 1 arrival rate, so
    # the rent leg and the gas legs are measured over the same stretch of time.
    if total_mints <= 0:
        # A zero arrival rate used to read as 0 s/mint, which zeroed the rent leg and
        # published a reserve that silently covered settlement gas alone.
        raise ValueError(f"total_mints must be > 0 to price the rent leg; got {total_mints}")
    seconds_per_mint = (horizon_days * 86400) / total_mints
    horizon_seconds = horizon_mints * seconds_per_mint

    settlement_ton = settlement_per_mint * horizon_mints
    owed_rent_ton = owed_rent_per_second * horizon_seconds
    total = settlement_ton + owed_rent_ton

    return OpsReserve(
        horizon_mints=horizon_mints,
        horizon_seconds=horizon_seconds,
        settlement_gas_ton_per_mint=round(settlement_per_mint, 9),
        owed_rent_ton_per_second=round(owed_rent_per_second, 12),
        settlement_ton=settlement_ton,
        owed_rent_ton=owed_rent_ton,
        total_ton=total,
        reserve_ton=float(math.ceil(total)),
        deferred_draw_ton_per_mint=round(total / horizon_mints, 9),
        inputs={
            "gas_baseline": {
                "ledger.mint_won_lot": gas_baseline[
                    "ledger.mint_won_lot"
                ],
                "market.close": gas_baseline["market.close"],
            },
            "gas_price_nanoton_per_unit": round(GAS_PRICE_NANOTON_PER_UNIT, 4),
            "flat_gas_price_nanoton": FLAT_GAS_PRICE_NANOTON,
            "cell_price_ps_nanoton": round(CELL_PRICE_PS_NANOTON, 9),
            "bit_price_ps_nanoton": round(BIT_PRICE_PS_NANOTON, 9),
            "owed_cells_per_entry": OWED_CELLS_PER_ENTRY,
            "owed_entries_at_final_head": owed_entries,
            "settlement_rate_assumed": settlement_rate,
            "seconds_per_mint": round(seconds_per_mint, 4),
            "_source": (
                "gas from contracts/gas-baseline.json (GasRegression.spec.ts); "
                "gas price from basechain config 21 per CLAUDE.md 'Measured provenance'; "
                "storage prices from basechain config 18; frequencies from this "
                "Phase 1 run."
            ),
        },
    )


#: The two hops the ledger attaches when it settles a claim at the head:
#: `SettleConfirmed` (0.015, book hop + shard hop) and `HeadUpdate` (0.010).
#: primes_ledger.tolk `handleSettle`. SS4.4 puts these on `RES_GAS`, NOT on the
#: SS4.1 gas & ops line -- see `res_gas_derivation` below.
SETTLEMENT_HOP_VALUE_TON = 0.025
#: D-90 EMPTIES THIS MAP. Every stand-in it carried named a shard or release row,
#: and `primes_market_shard.tolk` and the release path are both deleted: a won lot
#: MINTS IN ITS OWN CLOSE, so there is no claim record to write, no slot to free
#: and no holder to refund. The two legs that survive (`market.close` and
#: `ledger.mint_won_lot`) are both measured under their own names by
#: `GasRegression.spec.ts`, so nothing here is substituted any more.
CLAIM_GAS_SUBSTITUTIONS: dict[str, str] = {}

#: D-90.4 RETAINS `RES_GAS` AT ITS PRE-D-90 VALUE, and this constant is where
#: that decision is written down rather than inferred from a coincidence.
#:
#: Instant settlement makes the derivation below CHEAPER — the claim-write hop
#: and the record's ten-year rent are both gone, and the round trip is two
#: transactions instead of six. D-90.4 nonetheless holds every price
#: byte-identical ("no pricing, premium or split change"), so `RES_GAS` stayed at
#: 0.06 and the surplus over the derivation was PUBLISHED as
#: `retained_headroom_ton` instead of being quietly banked.
#:
#: D-113 RAISES THE RETAINED FLOOR AGAIN, 0.06 -> 0.07: `market.tolk` closeLot's
#: own comment never netted the composite ascending lane's OPEN_RESERVE_GAS
#: (paid at open, from this contract's own float, not carved from the bid)
#: against the close-time surplus, so every closed lot on every lane drained
#: the market's own balance with no funding path back. The prime lane's own
#: leak (closeLot forwarding a whole extra RES_GAS + PREMIUM_HOP_GAS to the
#: ledger when the settle arm only needed MINT_PRICE + SETTLE_GAS) is fixed at
#: the source instead of papered over here — see `primes_market.tolk` closeLot.
#: What is left once that source fix lands is the composite lane's open-time
#: leak alone, measured at a live sandbox balance (not the arithmetic) by
#: `PrimesMarket.spec.ts`'s V8 block: ~0.00625 TON per closed composite lot,
#: quantum-rounded up to 0.01 and added to the retained floor. Kept as a
#: RETAINED figure rather than a new formula leg for the same reason as the
#: original 0.06: real TVM forward-fee mechanics do not reduce cleanly to the
#: declared-constant arithmetic, so the number this loop may not guess is
#: measured directly instead of derived from a model that does not match it.
RETAINED_RES_GAS_TON = 0.070


def _row(gas_baseline: dict[str, int], key: str) -> tuple[int, str | None]:
    """A gas row, or its declared stand-in. Returns `(gas, substituted_from)`."""
    if key in gas_baseline:
        return gas_baseline[key], None
    sub = CLAIM_GAS_SUBSTITUTIONS.get(key)
    if sub and sub in gas_baseline:
        return gas_baseline[sub], sub
    raise KeyError(
        f"gas-baseline.json has neither `{key}` nor a declared stand-in for it"
    )


def res_gas_derivation(
    gas_baseline: dict[str, int],
    *,
    p0_floor_ton: float | None = None,
    mint_price_ton: float = 1.0,
    quantum_ton: float = 0.005,
) -> dict:
    """`RES_GAS` under the unified acquisition lane (D-30/D-31/D-32/D-33).

    **What survived and what did not.** CONCEPT.md SS4.4's superseding box keeps
    `RES_GAS` and deletes the fee it used to be carved out of. There is no
    `RES_FEE` and no `RES_PRIORITY` any more, so this is no longer a *split*: it
    is one derived quantity, carved off the **winning bid** before the premium is
    computed, exactly as `trophy_auction.money` already describes. Every property
    SS4.4 attaches to it is unchanged -- never waivable, never payable in PRIMES,
    its own field on the shard record, rounded UP in `RES_GAS`'s favour.

    **Two legs since D-90**: the settle hop that rides to the ledger with the
    close, and the TVM compute of the close/settle pair. The scoring loop is
    not here -- `D(n)` is evaluated at `open_lot` and the opener pays for it.

    `p0_floor_ton` is the bottom of the lane -- the lowest opening price any lot
    can carry. `RES_GAS` is carved out of it, so a `RES_GAS` that exceeds
    `p0_floor - MINT_PRICE` is the same failure the old `ValueError` caught: the
    lane's cheapest lot cannot fund the settlement it promises. That raises here
    rather than shrinking `RES_GAS`, because SS4.4's asymmetry is unchanged.
    """
    subs: dict[str, str] = {}
    rows: dict[str, int] = {}
    for key in ("market.close", "ledger.mint_won_lot"):
        g, sub = _row(gas_baseline, key)
        rows[key] = g
        if sub:
            subs[key] = sub

    # D-90: TWO transactions. The close and the settlement it sends to the
    # ledger, and that is the whole round trip — there is no shard claim write,
    # no later `settle(n)`, no `shard_settle_ack` relay and no slot to release.
    # `open_lot` and `bid` are still NOT here: they are paid by the message that
    # sends them, at the time it is sent.
    claim_compute_gas = sum(rows.values())
    compute_ton = gas_to_ton(claim_compute_gas, transactions=2)

    # D-90 deleted the claim record, and the rent leg and claim-write hop with it.
    unrounded = SETTLEMENT_HOP_VALUE_TON + compute_ton
    derived = math.ceil(unrounded / quantum_ton) * quantum_ton
    # D-90.4: the derivation is the FLOOR, not the value — see
    # `RETAINED_RES_GAS_TON`. The surplus is published below.
    res_gas = max(derived, RETAINED_RES_GAS_TON)
    retained_headroom = round(res_gas - derived, 9)
    # The lane floor IS `MINT_PRICE + RES_GAS` -- the cheapest lot on the lane
    # is the one whose whole premium is its own settlement funding, so the
    # identity is a definition, not a coincidence. A caller may pin a different
    # floor (the owner may floor `P0` above it under D-32); when they do, the
    # check below is the one the old `res_fee_split` raised.
    lane_floor = round(mint_price_ton + res_gas, 9)
    headroom = round((p0_floor_ton if p0_floor_ton is not None else lane_floor)
                     - mint_price_ton - res_gas, 9)
    if headroom < 0:
        raise ValueError(
            f"RES_GAS ({res_gas}) exceeds the lane floor's premium headroom "
            f"(P0_floor {p0_floor_ton} - MINT_PRICE {mint_price_ton}): the "
            "cheapest lot on the lane cannot fund its own settlement. Raise the "
            "P0 floor or make settlement cheaper -- do not shrink RES_GAS "
            "(CONCEPT.md SS4.4)."
        )
    return {
        "res_gas_ton": round(res_gas, 9),
        "res_gas_nanoton": int(round(res_gas * 1e9)),
        "lane_floor_ton": lane_floor,
        "lane_floor_nanoton": int(round(lane_floor * 1e9)),
        "lane_floor_identity": (
            "RESERVE_FLOOR = MINT_PRICE + RES_GAS, exactly "
            f"({mint_price_ton} + {round(res_gas, 9)} = {lane_floor})."
        ),
        "lane_floor_premium_headroom_ton": headroom,
        "res_gas_derivation": {
            "rule": (
                "D-90: RES_GAS = the settle hop that rides to the ledger with the "
                "close + the TVM compute of the close/settle pair, rounded up to "
                f"the next {quantum_ton} TON, and then FLOORED AT "
                f"{RETAINED_RES_GAS_TON} TON (D-90.4, raised by D-113). It is "
                "CARVED FROM THE WINNING BID."
            ),
            "derived_res_gas_ton": round(derived, 9),
            "retained_res_gas_ton": RETAINED_RES_GAS_TON,
            "retained_headroom_ton": retained_headroom,
            "_retained_note": (
                "D-90.4 retains the pre-D-90 RES_GAS so no price moves. Instant "
                "settlement is cheaper than the claim it replaced, so the fee now "
                f"over-collects by {retained_headroom} TON per won lot. That is "
                "published rather than banked: it is a real surplus and a "
                "candidate for the next re-derivation, not a hidden margin. "
                "Lowering it is a PRICE change (LOT_FLOOR = MINT_PRICE + RES_GAS) "
                "and therefore an owner decision, which is why this run does not "
                "take it."
            ),
            "settle_confirm_hops_ton": SETTLEMENT_HOP_VALUE_TON,
            "claim_compute_ton": round(compute_ton, 9),
            "claim_compute_gas": claim_compute_gas,
            "unrounded_res_gas_ton": round(unrounded, 9),
            "quantum_ton": quantum_ton,
            "_scoring_left_note": (
                "The worst-case scoring row (`market.reserve.max_digits`) is "
                "DELIBERATELY ABSENT. Under D-33 `D(n)` is evaluated at "
                "`open_lot` to quote P0 and the bid increment, and the opener "
                "pays for it in their own message. Carrying it inside RES_GAS "
                "would charge the winner for compute the opener already paid."
            ),
            "inputs": {
                "gas_baseline": rows,
                "gas_rows_substituted": subs,
                "_substitution_note": (
                    "unexpected -- D-90 empties CLAIM_GAS_SUBSTITUTIONS; both "
                    "surviving rows are measured under their own names"
                ) if subs else "none -- every row is measured under its own name",
                "cell_price_ps_nanoton": round(CELL_PRICE_PS_NANOTON, 9),
                "bit_price_ps_nanoton": round(BIT_PRICE_PS_NANOTON, 9),
                "p0_floor_ton": p0_floor_ton if p0_floor_ton is not None else lane_floor,
                "mint_price_ton": mint_price_ton,
                "_source": (
                    "hop value mirrors primes_market.tolk SETTLE_GAS and "
                    "primes_ledger.tolk handleSettle; gas from "
                    "contracts/gas-baseline.json."
                ),
            },
        },
        "res_gas_note": (
            "SS4.4: RES_GAS is carved from the winning bid before the premium is "
            "computed and funds the lot's mint IN THE CLOSE TRANSACTION. It is "
            "NEVER waivable, NEVER payable in PRIMES, and NEVER routed anywhere "
            "but settlement. DERIVED as a floor and RETAINED at "
            f"{RETAINED_RES_GAS_TON} by D-90.4/D-113 (see `retained_headroom_ton`): "
            "must match RES_GAS in primes_market.tolk."
        ),
    }


# `open_release_round_trip` is DELETED (D-90.2). It priced the right-hand side of
# D-32's constraint -- "the 10% release forfeit must exceed the gas of an
# open-and-release round trip, or releasing is free and opening lots becomes
# costless griefing" -- and there is no release to price. What closed the
# griefing hole in the end was not the forfeit at all but D-88 point 3: opening a
# lot IS a paid first bid of at least PRIME_P0_MIN, so nobody buys a permanent
# record for the price of gas, whether or not they can hand it back.


def bid_round_trip_ton(gas_baseline: dict[str, int]) -> float:
    """The gas cost one competing raise imposes: the bid itself plus the refund
    of the previous high bidder it forces.

    This is the floor under the minimum bid increment -- an increment smaller
    than this makes a raise cost the protocol more than it moves the price, and
    that is a derivation rather than a taste. `market.bid` is not published yet;
    the declared stand-in is `market.bid_head_prime`, the measured bid entry
    point on the same contract.
    """
    bid = gas_baseline.get("market.bid", gas_baseline["market.bid_head_prime"])
    # bid in, refund out: two transactions, plus the refund's attached value.
    return gas_to_ton(bid, transactions=2) + 0.010



#: TROPHY_AUCTION_PLAN.md SS8. The lot-lane rows, under the names
#: GasRegression.spec.ts actually publishes: D-3's P2.A7 consolidation folded
#: primes_trophy_auction.tolk into `primes_market.tolk`, so the rows are
#: `market.*`. Mapping: `open` -> `market.open_lot` (+ `.max_digits`, the
#: worst-case scored open), the descending prime lot -> `market.open_head_lot`,
#: `bid` -> `market.bid_head_prime` (the only measured bid entry point; the
#: same stand-in `bid_round_trip_ton` declares), `close` -> `market.close`.
#: The old `close_early` row is gone: D-45 deleted the head-arrival early close.
TROPHY_AUCTION_ROWS = (
    "market.open_lot",
    "market.open_lot.max_digits",
    "market.open_head_lot",
    "market.bid_head_prime",
    "market.close",
)

def trophy_auction_gas(gas_baseline: dict[str, int], *,
                       res_gas_ton: float,
                       rows: tuple[str, ...] = TROPHY_AUCTION_ROWS) -> dict:
    """The `trophy_auction` row group (TROPHY_AUCTION_PLAN.md SS8).

    The market's lot-lane entry points (`TROPHY_AUCTION_ROWS`), each priced the
    way every other row in this module is -- measured TVM gas from
    `contracts/gas-baseline.json` at basechain config 21 -- and none invented.

    **Degrades rather than raises.** A row missing from the baseline yields a
    note, not a `KeyError` that stops `params.json` regenerating and not a
    made-up number (CLAUDE.md rule 3).
    """
    present = {k: gas_baseline[k] for k in rows if k in gas_baseline}
    missing = [k for k in rows if k not in gas_baseline]
    out: dict = {
        "measured": bool(present) and not missing,
        "rows": {k: {"gas": v, "ton": round(gas_to_ton(v), 9)}
                 for k, v in present.items()},
        "missing_rows": missing,
        "res_gas_carved_from_bid_ton": res_gas_ton,
        "_res_gas_note": (
            "D-30/D-90: RES_GAS is part of the winning payment "
            "(C = MINT_PRICE + RES_GAS + premium) and funds the lot's own mint, "
            "which happens in the close transaction -- there is no reservation "
            "or escrowed claim to settle later. The slice that rides to the "
            "ledger with the mint leg is primes_market.tolk's SETTLE_GAS; the "
            "close itself is measured as `market.close` above."
        ),
    }
    if missing:
        out["_note"] = (
            "NOT MEASURED. contracts/gas-baseline.json does not publish "
            f"{missing}. The lot lane lives in primes_market.tolk (D-3); "
            "GasRegression.spec.ts is where these rows are measured. No number "
            "is invented in their place (CLAUDE.md rule 3)."
        )
    return out


#: DECISIONS.md D-117 -- the rounding step, OWNER-SET (2026-09-22): the gas & ops
#: line is the measured worst case rounded UP to the next 5% of the mint. Declared,
#: not fitted, like `OPS_RESERVE`'s whole TON. The owner chose the coarse step
#: because the unspent line is swept back into the ratchet pool (D-117), so the
#: extra headroom costs the pool nothing on net.
GAS_OPS_LINE_STEP_PCT = 0.05

#: Where GasRegression.spec.ts writes the ledger-side spend of each reconciled
#: mint, in NANOTON (not gas): `gas_ops_spend.<row>`.
GAS_OPS_SPEND_PREFIX = "gas_ops_spend."

DEFAULT_GAS_BASELINE_PATH = Path(__file__).resolve().parents[2] / "contracts" / "gas-baseline.json"


def gas_ops_spend_rows(gas_baseline: dict[str, int]) -> dict[str, float]:
    """The measured per-mint draw on the SS4.1 gas & ops line, TON, by row."""
    rows = {
        k[len(GAS_OPS_SPEND_PREFIX):]: v * NANOTON
        for k, v in gas_baseline.items()
        if k.startswith(GAS_OPS_SPEND_PREFIX)
    }
    if not rows:
        raise ValueError(
            "contracts/gas-baseline.json has no `gas_ops_spend.*` rows -- regenerate it "
            "with GAS_BASELINE_UPDATE=1 on GasRegression.spec.ts; the gas & ops line "
            "is derived from them and must not be invented (CLAUDE.md rule 3)."
        )
    return rows


def gas_ops_line(gas_baseline: dict[str, int], *, mint_price_ton: float = 1.0) -> dict:
    """DECISIONS.md D-117: SS4.1's gas & ops line, DERIVED from the heaviest mint.

    The line is a fixed share of every mint (D-9), so it has to cover the WORST
    mint `executeMint` can perform, not the average one. GasRegression.spec.ts
    measures that mint on the ledger's own books -- the fall in its surplus over
    declared liability across the whole trace, which counts every hop the line
    pays for by construction (the item deploy, each credit_tribute, the rebate
    mint, the ratchet hop, the era bounty and trophy, the special-number rebate,
    the fee legs' forward fees, the D-117 confirmation) -- on seeded stacks that
    fire every leg at once. The line is that worst row rounded UP to the next 5%
    step of the mint (`GAS_OPS_LINE_STEP_PCT`, owner-set). What an ordinary mint
    does not spend is swept back into the ratchet pool (`sweep_ops`, D-117), so
    the line's size moves TON through the pool, not out of it.
    """
    rows = gas_ops_spend_rows(gas_baseline)
    worst_row = max(rows, key=rows.get)
    worst_ton = rows[worst_row]
    if worst_ton > mint_price_ton:
        raise ValueError(
            f"worst mint `{worst_row}` spends {worst_ton} TON, more than MINT_PRICE "
            f"{mint_price_ton}: no gas & ops line can cover it"
        )
    # Ceil in whole nanoTON (the rows are integers there), not in float steps: a float
    # ceil needs a round() to stop 0.15/0.05 = 2.9999999999999996 buying a whole extra
    # step, and that round() then swallowed a worst case up to ~25 nanoTON ABOVE a step,
    # publishing a line smaller than the mint it is sized to cover.
    step_nano = round(GAS_OPS_LINE_STEP_PCT * mint_price_ton / NANOTON)
    steps = -(-round(worst_ton / NANOTON) // step_nano)
    pct = round(steps * GAS_OPS_LINE_STEP_PCT, 6)
    return {
        "gas_ops_pct": pct,
        "gas_ops_ton": round(pct * mint_price_ton, 9),
        "worst_case_row": worst_row,
        "worst_case_spend_ton": round(worst_ton, 9),
        "headroom_ton": round(pct * mint_price_ton - worst_ton, 9),
        "rows_ton": {k: round(v, 9) for k, v in sorted(rows.items())},
        "rule": (
            "gas_ops_pct = the largest measured `gas_ops_spend.*` row in "
            "contracts/gas-baseline.json, rounded UP to the next 5% step of MINT_PRICE "
            "(the step is OWNER-SET, D-117; the unspent line is swept back to the pool). Each row is the ledger's own surplus-over-liability drop across "
            "one mint's whole trace (GasRegression.spec.ts `spendAcross`), storage rent "
            "excluded (OPS_RESERVE's leg). The `worst_*` rows are seeded stacks firing "
            "every leg at once: all factors sold, a recruit gift (trophy), a referral, "
            "a full invite list, a primorial (era bounty) and the special-number rebate."
        ),
        "_source": "DECISIONS.md D-117 (signed 2026-09-22); GAUNTLET.md V17",
    }


def gas_ops_draw_default(kind: str) -> float:
    """D-117: what an ORDINARY mint of `kind` really spends from the line, TON --
    the measured `composite_w2` / `prime_purchase` rows. The rest of the line is
    swept back into the ratchet pool, emission-free, by `sweep_ops`."""
    rows = gas_ops_spend_rows(load_gas_baseline(DEFAULT_GAS_BASELINE_PATH))
    return rows["prime_purchase" if kind == "prime" else "composite_w2"]


def gas_ops_pct_default() -> float:
    """The derived line from the committed baseline -- `SplitParams`' default."""
    return gas_ops_line(load_gas_baseline(DEFAULT_GAS_BASELINE_PATH))["gas_ops_pct"]


def measured_gas_draw_per_mint(gas_baseline: dict[str, int], *, prime_share: float) -> dict:
    """The actual draw a mint makes on the gas & ops line, against the line.

    SS4.1's sweepable surplus is `(line - actual draw)` per mint, and SS5.1's
    "zero emission on primes buys back the primality check" claim is exactly the
    comparison between the two rows below -- so both are emitted, not just the
    blended figure. D-117: both are MEASURED spend rows now (the ledger's own
    surplus drop, GasRegression.spec.ts), not compute gas plus a hand-kept list of
    attached hop values -- that list missed every hop nobody had added to it.
    """
    rows = gas_ops_spend_rows(gas_baseline)
    line = gas_ops_line(gas_baseline)
    composite_ton = rows["composite_w2"]
    # D-20: a prime never goes through `ledger.mint` -- it clears via the Dutch
    # lane (`market.bid_head_prime` -> `ledger.settle_prime_clearing`).
    prime_ton = rows["prime_purchase"]
    blended = prime_share * prime_ton + (1 - prime_share) * composite_ton
    allocation = line["gas_ops_ton"]
    return {
        "composite_ton": round(composite_ton, 9),
        "prime_ton": round(prime_ton, 9),
        "blended_ton": round(blended, 9),
        "worst_case_row": line["worst_case_row"],
        "worst_case_ton": line["worst_case_spend_ton"],
        "worst_case_fits_allocation": line["worst_case_spend_ton"] <= allocation,
        "prime_share": round(prime_share, 6),
        "gas_ops_allocation_ton": allocation,
        "sweepable_surplus_ton_per_mint": round(allocation - blended, 9),
        "surplus_share_of_allocation": round((allocation - blended) / allocation, 6),
        "_note": (
            "Every figure is a MEASURED ledger-side spend (GasRegression.spec.ts, "
            "`gas_ops_spend.*` in contracts/gas-baseline.json): the drop in the "
            "ledger's surplus over declared liability across one mint's whole trace, "
            "so every hop the line pays is in it and nothing is counted twice. The "
            "allocation is `gas_ops_line`'s derived figure, sized to the worst row; "
            "the surplus is what an ordinary mint leaves for sweep_ops."
        ),
    }
