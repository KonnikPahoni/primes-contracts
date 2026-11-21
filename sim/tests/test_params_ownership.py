"""shared/params.json has more than one generator -- they must not clobber each other.

`run_phase1.py` rebuilds the whole document from scratch; `run_determinations.py`
rewrites exactly its own keys and preserves the rest. Without an explicit merge the
first silently deletes the second's work, which is what once happened to the
(since deleted) `constellations` block. These tests pin the rule that prevents a
repeat:

  a script that owns key X is the only writer of X, and every whole-file writer
  lists X in its FOREIGN_PARAM_KEYS so the value survives a run in any order.
"""
from __future__ import annotations

import json
import os
import re
import sys

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PARAMS_PATH = os.path.join(REPO_ROOT, "shared", "params.json")
SCRIPTS_DIR = os.path.join(REPO_ROOT, "sim", "scripts")

sys.path.insert(0, SCRIPTS_DIR)
import run_phase1  # noqa: E402


@pytest.fixture(scope="module")
def params():
    with open(PARAMS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _keys_written_by(script: str) -> set[str]:
    """Top-level keys a single-key generator assigns, e.g. `params["x"] = block`."""
    with open(os.path.join(SCRIPTS_DIR, script), encoding="utf-8") as fh:
        src = fh.read()
    return set(re.findall(r'^\s*params\[["\'](\w+)["\']\]\s*=', src, re.M))


# --------------------------------------------------------------------------- #
# The ownership rule
# --------------------------------------------------------------------------- #

def test_constellations_and_generators_are_gone(params):
    """TELEGRAM_INVITES_PLAN.md (owner, 2026-11-07) deleted both features, their
    generator script and their blocks. Neither may be preserved as foreign (a
    regen would then carry a dead block forever) and neither may be on disk."""
    for key in ("constellations", "generators"):
        assert key not in run_phase1.FOREIGN_PARAM_KEYS
        assert key not in params, f"`{key}` survived the regen"
    assert not os.path.exists(os.path.join(SCRIPTS_DIR, "run_constellations.py"))
    tracks = params["genesis"]["era_bounty_schedule"]["remaining_vault_split"]["tracks"]
    assert "constellation_discovery" not in tracks


def test_phase1_DOES_own_the_invites_key():
    """The other side of the ownership rule, pinned so the split does not drift.

    `invites` (SS4.1's seventh line) is beta arithmetic -- the table re-derived
    with `invite_count * INVITE_TRANSFER_VALUE_TON` deducted ahead of the residual
    -- and beta is run_phase1.py's output everywhere else in the file.
    """
    assert "invites" not in run_phase1.FOREIGN_PARAM_KEYS


def test_phase1_does_not_own_the_determinations_key():
    assert "determinations" in run_phase1.FOREIGN_PARAM_KEYS


@pytest.mark.parametrize("script", ["run_determinations.py"])
def test_every_key_another_generator_writes_is_declared_foreign(script):
    """The generalised form: adding a generator without declaring its key fails here.

    Parametrised over every single-key generator, so the next one is one list
    entry away from being covered rather than a new test.
    """
    owned_elsewhere = _keys_written_by(script)
    assert owned_elsewhere, (
        f"regex found no owned keys in {script} -- the detector, not the code, is stale"
    )
    missing = owned_elsewhere - set(run_phase1.FOREIGN_PARAM_KEYS)
    assert not missing, (
        f"{script} writes {sorted(missing)}, which run_phase1.py would "
        f"overwrite. Add them to run_phase1.FOREIGN_PARAM_KEYS."
    )


# --------------------------------------------------------------------------- #
# The merge itself
# --------------------------------------------------------------------------- #

def test_merge_preserves_foreign_keys_and_leaves_owned_keys_alone(tmp_path):
    on_disk = {"acquisition": {"lane": {"budget_primes": 6000.0}},
               "determinations": {"q26_auction_lane": {"verdict": "kept"}},
               "genesis": {"stale": True}}
    path = tmp_path / "params.json"
    path.write_text(json.dumps(on_disk), encoding="utf-8")

    fresh = {"acquisition": {"stub": True}, "genesis": {"stale": False}}
    out = run_phase1.merge_foreign_keys(fresh, str(path))

    assert out["acquisition"] == on_disk["acquisition"]  # foreign key survives
    assert out["determinations"] == on_disk["determinations"]  # and so does this one
    assert out["genesis"] == {"stale": False}                  # owned key is regenerated


def test_merge_tolerates_a_missing_file(tmp_path):
    """First run: no params.json yet is the bootstrap case, not a crash."""
    fresh = {"acquisition": {"stub": True}}
    out = run_phase1.merge_foreign_keys(fresh, str(tmp_path / "does-not-exist.json"))
    assert out == {"acquisition": {"stub": True}}


# --------------------------------------------------------------------------- #
# The shipped file
# --------------------------------------------------------------------------- #

def test_shipped_invite_block_is_owned_here_and_labels_its_assumption(params):
    """`invites` is run_phase1.py's, and its one ASSUMED input says so.

    Three inputs, two kinds of provenance, and the block is only honest if it
    keeps them apart: the per-transfer value and the max count are OWNER-SET
    (TELEGRAM_INVITES_PLAN.md, 2026-11-07), and the opt-in rate is ASSUMED --
    no invited mint has ever been made. A block that published the opt-in rate as
    a run output would be a rule-3 violation dressed as a measurement.
    """
    inv = params["invites"]
    assert "run_phase1.py" in inv["_source"]
    assert inv["max_count"] == 3
    assert "OWNER-SET" in inv["_max_count_source"]
    assert inv["transfer_value_ton"] == 0.1
    assert inv["transfer_value_nanoton"] == 100_000_000
    assert "OWNER-SET" in inv["_transfer_value_source"]
    for gone in ("generator_value_ton", "generator_value_nanoton", "_generator_value_source"):
        assert gone not in inv
    assert inv["optin_rate_assumed"] == 1.0   # the checkout always fills 3 (D-180)
    assert inv["_optin_rate_source"].startswith("ASSUMED")
    assert inv["line_ton_at_max_count"] == 0.3   # exact: the app prints it

    # The SS4.1 table is unchanged for a mint that does not opt in, and every
    # row loses exactly the line at the full count -- an absolute TON deduction,
    # not a rate, so the delta is the same on every row. Four rows since D-106
    # deleted the conditional patron line and the phi1/phi2 rows with it.
    rows = inv["beta_table"]
    assert len(rows) == 4
    steady = next(r for r in rows if r["row"] == "composite, referred")
    g = params["mint"]["gas_ops_pct"]  # D-117: sim-derived
    assert steady["beta_no_invite"] == pytest.approx(0.75 - g)
    assert steady["beta_full_invite"] == pytest.approx(0.45 - g)
    for r in rows:
        assert r["delta_full_invite"] == pytest.approx(-0.30)
        assert r["beta_full_invite"] > 0.0
        lo = min(r["beta_no_invite"], r["beta_full_invite"])
        hi = max(r["beta_no_invite"], r["beta_full_invite"])
        assert lo <= r["beta_expected_at_assumed_optin"] <= hi


def test_shipped_invite_block_re_runs_the_ratchet_check(params):
    """SS5's `k < 1` and the ratchet theorem at the reduced beta, verified in the
    file rather than asserted in prose (D-101, 'why no invariant moves')."""
    chk = params["invites"]["k_lt_1_check"]
    assert chk["k_worst_case"] < 1.0
    assert chk["clamp_binds"], "the worst-case stack should be sitting on K_CEIL"
    assert chk["k_lt_1_holds"]
    assert chk["floor_rises_at_every_count"]
    assert chk["emission_tracks_injection"], (
        "emission and injection must shrink in the SAME ratio at a reduced beta"
    )
    counts = chk["by_invite_count"]
    assert [c["invite_count"] for c in counts] == [0, 1, 2, 3]
    for c in counts:
        assert c["emitted_value_ton"] < c["injection_ton"]
        assert c["floor_after"] > chk["floor_price_at_check"]


# The retired 389x floor-appreciation figure, in every shape the repo writes it:
# "389x", "389×", "~389" and the old endpoint 0.32407.
_389X_MARKER = re.compile(r"389\s*[x×]|~\s*389|0\.32407")

# Files that TALK ABOUT the retirement rather than quoting the figure as current.
# Excluding them by name is the only hand-maintained part of the scan, and it is
# the safe direction: a missed narrator is a noisy test, a missed carrier is the
# silent drift this test exists to catch.
_389X_NARRATORS = frozenset({
    "CLAUDE.md",                            # corrected 2026-09-05; states what it read
    "GAUNTLET.md",                          # A12 item 1 -- where the drift is filed
    "DESIGN.md",                            # design-iteration's own run log narrating the
                                             # A12 fix ("389x->46.77x") as history, same as
                                             # GAUNTLET.md -- not a claim that 389x still holds
    "CONSTELLATIONS_PLAN.md",               # the plan that asked for the re-derivation
    "contracts/tests/SimCrossCheck.spec.ts",  # calls it "the retired 389x" in a comment
})
_389X_SKIP_DIRS = frozenset({
    ".git", ".venv", "node_modules", "graphify-out", "dist", "build",
    "__pycache__", "output", "coverage",
})
_389X_EXTS = (".md", ".ts", ".tsx", ".tolk", ".py", ".fc")


def _files_still_quoting_389x() -> list[str]:
    """Every repo file still quoting the retired 389x, as posix paths."""
    found = []
    for dirpath, dirnames, filenames in os.walk(REPO_ROOT):
        dirnames[:] = [d for d in dirnames if d not in _389X_SKIP_DIRS]
        for name in filenames:
            if not name.endswith(_389X_EXTS):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, REPO_ROOT).replace(os.sep, "/")
            if rel in _389X_NARRATORS or rel.startswith("sim/"):
                continue  # sim/ IS the generator and its own tests
            try:
                text = open(full, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            if _389X_MARKER.search(text):
                found.append(rel)
    return sorted(found)


def test_the_floor_appreciation_multiple_is_measured_not_quoted(params):
    """CLAUDE.md 'Measured provenance' carried a 389x floor multiple measured
    under the pre-D-39/D-100 denomination. It no longer reproduces, so the sim
    emits its own with a `_source` and names what it supersedes.

    This test previously required the `_source` to say "does NOT supersede",
    because at the time every standing document still carried 389x and a sim
    block cannot retire an owner-signed sentence by itself (CLAUDE.md rule 2).
    CLAUDE.md was corrected to these figures on 2026-09-05, so the block now
    does supersede it — but only it. The remaining carriers must still be NAMED
    and still be FILED, which is what is pinned here: a `_source` that quietly
    dropped them would be the drift moving into the dark.
    """
    fa = params["final_state"]["floor_appreciation"]
    assert "389x" in fa["_source"]
    assert "CLAUDE.md" in fa["_source"] and "corrected" in fa["_source"]
    # The carriers are GREPPED, not listed here. A hardcoded tuple was what the
    # first version of this test used, and it pinned three of nine -- so it
    # enforced a disclosure that under-reported the drift and would have stayed
    # green as more carriers were missed. Deriving the set means a tenth carrier
    # fails this test on the day it appears.
    carriers = _files_still_quoting_389x()
    assert carriers, "the marker scan found nothing -- the regex or the walk broke"
    for path in carriers:
        assert path in fa["_source"], (
            f"{path} still quotes 389x and the `_source` does not name it")
    assert "GAUNTLET.md A12" in fa["_source"], "the drift must be filed where a person sees it"
    # and it says which beta it was measured at
    assert fa["measured_at_invite_optin_rate"] == pytest.approx(
        params["invites"]["optin_rate_assumed"]), (
        "the published trajectory must be the one measured at the published rate")
    assert "SEVENTH LINE LIVE" in fa["_invite_line_note"]
    assert fa["monotone_at_every_sampled_point"], "the ratchet theorem in simulation"
    assert fa["multiple_over_horizon"] > 1.0
    assert fa["final_floor_price"] == pytest.approx(
        params["final_state"]["final_floor_price"])
    # One zero since D-180: with no genesis clearings in `T` the first sampled
    # floor IS the deploy floor, so the two multiples coincide.
    assert fa["first_sampled_floor_price"] == pytest.approx(fa["deploy_floor_price"])
    assert (fa["multiple_over_horizon_from_deploy_floor"]
            == pytest.approx(fa["multiple_over_horizon"]))


def test_the_invite_block_measures_the_horizon_under_the_line(params):
    """This test used to assert the OPPOSITE: that the block honestly disclosed
    that the three-year run behind every other block was generated at
    invite_count = 0 while `optin_rate_assumed` published 0.80. That disclosure
    was legitimate scope, not a bug -- but the scope is now closed
    (CONSTELLATIONS_PLAN.md phase 1 item 1), so what has to be pinned is that the
    run really is under the line and that the ASSUMED rate is still labelled as
    an assumption rather than laundered into a measurement by having been drawn
    from.
    """
    inv = params["invites"]
    assert "_horizon_not_simulated" not in inv, (
        "the disclosure is retired -- if this key is back, the engine stopped "
        "drawing an invite count and the horizon is uninvited again")
    hs = inv["_horizon_simulated"]
    assert "SCOPE" in inv["_source"]

    # drawn at the ASSUMED rate, and the label travels with it
    assert hs["optin_rate_drawn"] == pytest.approx(inv["optin_rate_assumed"])
    assert "ASSUMED" in hs["_source"] and "not measured" in hs["_source"]
    assert "MEASURED over this run" in hs["_source"]

    # the draw actually happened, on the run every other block comes from
    assert hs["simulated_mints"] == params["final_state"]["total_mints_simulated"]
    assert 0 < hs["invited_mints"] <= hs["simulated_mints"]
    assert hs["optin_rate_realised"] == pytest.approx(
        hs["invited_mints"] / hs["simulated_mints"])
    # Bernoulli at the assumed rate over ~4e5 draws: the realised share is a measurement and
    # is allowed to differ from the assumption, but not by much.
    assert hs["optin_rate_realised"] == pytest.approx(
        hs["optin_rate_drawn"], abs=0.01)

    # all-or-nothing at max_count, so slots = invited x 3
    assert hs["invite_slots_deployed"] == hs["invited_mints"] * inv["max_count"]
    assert hs["ton_deducted_over_the_horizon"] == pytest.approx(
        hs["invite_slots_deployed"] * inv["transfer_value_ton"])
    assert hs["mean_line_ton_per_mint"] == pytest.approx(
        hs["ton_deducted_over_the_horizon"] / hs["simulated_mints"])
    assert hs["mean_line_ton_per_mint"] == pytest.approx(
        hs["expected_line_ton_per_mint_at_assumed_optin"], abs=0.002)
    assert hs["share_of_final_T"] == pytest.approx(
        hs["ton_deducted_over_the_horizon"] / hs["final_T_ton"])
    assert "SIMULATED UNDER THE INVITE LINE" in hs["_note"]

    # The realised mean residual is a mixture over the whole population, so it
    # must land inside the beta table's own envelope -- above the smallest fully
    # invited row and below the largest uninvited one. Outside that bracket the
    # engine is splitting on rates the table does not describe.
    #
    # The key is TON, not a rate: `pool_injection` is `beta * price`. The two are
    # comparable here only because every mint in the run prices at 1 TON, which
    # is asserted rather than assumed.
    assert params["mint"]["mint_price_ton"] == pytest.approx(1.0), (
        "mean_pool_injection_ton_measured is only comparable to a beta at price 1")
    assert (min(r["beta_full_invite"] for r in inv["beta_table"])
            < hs["mean_pool_injection_ton_measured"]
            < max(r["beta_no_invite"] for r in inv["beta_table"]))


def test_vesting_block_survives_a_phase1_regen(params):
    """`genesis.vesting` (the D-77 disclosure schedule, as split by D-100 point 6)
    is a THIRD clobber risk this module did not previously cover, found while
    adding `curated_composite_count` alongside it (GAUNTLET.md N1). Unlike
    `constellations`/`determinations`, it is not a top-level key, so it cannot be
    listed in `FOREIGN_PARAM_KEYS` (that mechanism only preserves top-level keys)
    -- it is nested under `genesis`, which `build_params_json()` regenerates
    wholesale. This test pins its presence in the SHIPPED file so a future regen
    that silently drops it fails loudly here rather than being noticed only when
    `contracts/scripts/genesisPipeline.ts` or the webapp go looking for a schedule
    that used to be there.

    RENAMED by DECISIONS.md D-100 point 6 (`genesis.operator_vesting` ->
    `genesis.vesting.{operator,treasury}`), then CUT TO ONE INSTANCE by D-166:
    the operator's lock is deleted and only the treasury's 1,000,000-PRIMES lock
    remains, same schedule, same contract. Asserting the operator key is ABSENT
    is what stops a regen quietly restoring a supply line to the team (CONCEPT.md
    SS2 principle 4).
    """
    v = params["genesis"]["vesting"]
    assert v["instances"] == 1
    assert v["tranches"] == 4
    assert v["interval_days"] == 90
    inst = v["treasury"]
    for key in ("beneficiary", "total_primes", "tranches", "interval_seconds",
                "interval_days", "total_days", "genesis_tranche_primes",
                "genesis_tranche_pct_of_s0"):
        assert key in inst, f"`{key}` missing from genesis.vesting.treasury"
    assert inst["tranches"] == 4
    assert inst["interval_days"] == 90
    assert inst["total_primes"] == v["total_allocation_primes"] == 1_000_000
    assert "operator" not in v, "D-166 deleted the operator's vesting lock"
    assert "operator_vesting" not in params["genesis"], (
        "genesis.operator_vesting is retired by D-100 point 6 and its successor "
        "by D-166"
    )


def test_treasury_block_is_governance_only(params):
    """DECISIONS.md D-100 points 4/8/9 as amended by D-147 and D-168: LP custody
    buys a VOTE and nothing else. The miner's rate, weights and accumulator scale
    are gone from this block (they moved to `staking`), and every figure left is
    owner-set -- the sim selects nothing here, and the provenance must say so.
    """
    t = params["treasury"]
    assert "D-100" in t["_source"] and "D-168" in t["_source"]
    assert "OWNER-SET" in t["_source"]
    for gone in ("tier_weights", "miner_rate_bps_per_day", "miner_rate_selection",
                 "tier_weight_validation", "miner_yield", "acc_scale", "tier_delay_seconds"):
        assert gone not in t, f"`treasury.{gone}` survived D-168"
    # D-168 Q13: the four terms that vote; tiers 0-2 are deleted.
    assert t["tier_term_seconds"] == [2592000, 7776000, 15552000, 31536000]
    assert t["vote_multipliers"] == [1, 3, 10, 30]
    assert len(t["tier_labels"]) == len(t["tier_term_seconds"]) == len(t["vote_multipliers"])
    assert t["vote_eligible_min_tier_index"] == 0
    assert t["proposal_cap_bps"] == 2500
    assert t["propose_min_bps"] == 100


def test_staking_block_rate_is_solved_and_ladder_validated(params):
    """DECISIONS.md D-168: PRIMES staking paid from the treasury vest. One
    sim-selected figure (`distribution_rate_bps_per_day`), and it must arrive with
    the criterion it was solved from; the epoch is the ratchet's harvest interval;
    the owner's 5/6/7/8 ladder is validated, not substituted."""
    st = params["staking"]
    assert "D-168" in st["_source"]
    for word in ("OWNER-SET", "SIM-SELECTED"):
        assert word in st["_source"]

    # Q6: one monthly beat with the ratchet's harvest().
    assert st["epoch_seconds"] == 2592000
    assert st["epoch_seconds"] == params["staked_reserve"]["harvest_interval_seconds"]

    # Q8: the LP terms, weighted by the old mining ladder's top four rungs.
    assert st["tier_term_seconds"] == params["treasury"]["tier_term_seconds"]
    assert st["tier_weights"] == [5, 6, 7, 8]
    assert len(st["tier_labels"]) == len(st["tier_weights"]) == len(st["tier_term_seconds"])
    assert st["acc_scale"] == 2 ** 64

    # The rate reproduces from its criterion: P = 1 - (1 - share)^(1/365), in bps.
    sel = st["distribution_rate_selection"]
    assert sel["criterion"]
    assert sel["emitted_bps_per_day"] == st["distribution_rate_bps_per_day"]
    assert round(sel["exact_bps_per_day"]) == st["distribution_rate_bps_per_day"]
    assert sel["exact_bps_per_day"] == pytest.approx(
        (1.0 - 0.5 ** (1.0 / 365.0)) * 10_000.0, rel=1e-6)
    assert 0.45 < sel["realised_first_year_payout_share"] < 0.55
    per_epoch = st["distribution_rate_bps_per_day"] * st["epoch_seconds"] / (10_000 * 86_400)
    assert sel["budget_share_of_free_per_epoch"] == pytest.approx(per_epoch, abs=1e-6)
    assert 0.45 < sel["realised_first_year_payout_share_epoch_rule"] < 0.55

    # Monotone + diminishing weight per locked day; D-147's two LP-miner
    # criteria are deleted, not carried.
    val = st["tier_weight_validation"]
    assert val["monotone"] is True
    assert val["marginal_weight_per_locked_day_diminishing"] is True
    assert val["verdict"] == "PASS"
    per_day = [s["weight_per_extra_day"] for s in val["steps"]]
    assert all(b < a for a, b in zip(per_day, per_day[1:]))
    assert "free_ride_bounded" not in val
    assert "governance_spread_exceeds_mining_spread" not in val


def test_lp_depth_without_miner_risk_report_is_published(params):
    """STAKING_PLAN.md SS3.3: deleting the LP miner must come with a measured
    statement of flush depth without it, and a verdict. A FAIL verdict is an
    owner escalation, so this test fails loudly rather than letting it ship."""
    r = params["staking"]["lp_depth_without_miner"]
    assert r["miner_modelled_depth_contribution_ton"] == 0.0
    for case in ("modelled_pool_nominal", "operator_genesis_pair_only"):
        row = r[case]
        assert row["flush_fills"] > 0, case
        assert row["flush_can_defend_band"] is True, case
    pair = r["operator_genesis_pair_only"]
    g = params["genesis"]
    assert pair["pool_primes_at_genesis"] == pytest.approx(g["genesis_donation_primes"])
    assert pair["pool_ton_at_genesis"] / pair["pool_primes_at_genesis"] == pytest.approx(
        g["deploy_floor_price_ton_per_primes"], rel=1e-9)
    assert r["verdict"] == "FLUSH DEFENDS ITS BAND"


def test_genesis_floor_is_derived_from_the_donation_not_from_L(params):
    """DECISIONS.md D-100 point 2. Before it, the genesis floor was
    `1 / (L * (1 + vault_pct))` -- a pure function of the denomination -- because
    D-92 chose the donation to reproduce exactly that. D-100 unpins the two: the
    donation is 4.20 TON by owner decision and the floor is whatever `T0 / S0`
    falls out to.

    Asserting the DERIVATION rather than the number is deliberate. A test that
    pinned 3.5e-7 would have to be edited every time the owner moves the donation,
    which is precisely the "hardcoded number not traceable to the sim or the
    concept" CLAUDE.md rule 3 calls a bug. This checks the relationship instead,
    and separately checks that the floor is no longer the old `1/(L*1.2)` form.

    It used to pin `t0 == 4.20` in the next breath, against its own argument, and
    D-154's move to 132.50 is what collected the debt. The donation is an OWNER
    figure: the only thing a test may say about it is that it is positive and that
    the floor follows from it.
    """
    g = params["genesis"]
    t0 = g["genesis_donation_ton"]
    # The floor divides by the DEPLOY supply: the seed plus the donor's own
    # `donate_floor` mint (D-100 point 1), `T0 * L` tapered by D-156.
    l = g["genesis_lp_ratio_primes_per_ton"]
    s_max = params["rebate"]["S_MAX"]
    donor = t0 * l * (s_max - g["genesis_supply_primes"]) / s_max
    assert g["genesis_donation_primes"] == pytest.approx(donor, rel=1e-12)
    s0 = g["deploy_supply_primes"]
    assert s0 == pytest.approx(g["genesis_supply_primes"] + donor, rel=1e-12)
    assert t0 > 0
    assert g["genesis_floor_price_ton_per_primes"] == pytest.approx(t0 / s0, rel=1e-12)
    assert g["deploy_floor_price_ton_per_primes"] == pytest.approx(t0 / s0, rel=1e-12)
    # No longer `1 / (L * (1 + vault_pct))`: that identity died with D-92's 240 TON.
    l = g["genesis_lp_ratio_primes_per_ton"]
    pct = g["bounty_vault_pct_of_genesis_lp"]
    assert g["genesis_floor_price_ton_per_primes"] != pytest.approx(1.0 / (l * (1.0 + pct)))
    # D-39 fixed L; D-100 point 2 explicitly leaves it alone.
    assert l == 10000.0
    # D-166's forfeit split (58/42, amending D-100 point 6's 80/20) rides in the same block.
    assert g["forfeit_split_bps"] == 5800
    # D-140: the opening pair is posted AT the floor, so the market opens at
    # `1/p_f` and not at `L`. Asserted as an IDENTITY rather than against the
    # literal 2,857,142.86, because the whole point is that the two figures move
    # together -- a regen that moved the floor and left the market price behind
    # is the exact defect D-140 fixes, and it reads as a passing test otherwise.
    assert g["market_open_primes_per_ton"] == pytest.approx(
        1.0 / g["genesis_floor_price_ton_per_primes"], rel=1e-12
    )
    assert g["market_over_floor_at_open"] == pytest.approx(1.0, rel=1e-12)
    # ...and NOT the old `(1/L)/p_f` = 285.7, named so it cannot come back quietly.
    assert g["market_over_floor_at_open"] != pytest.approx(
        (1.0 / l) / g["genesis_floor_price_ton_per_primes"]
    )


def test_the_rebate_family_count_is_a_fresh_sieve_not_an_estimate(params):
    """D-96's density argument, re-derived here rather than re-read.

    REPLACES the curated-composite sieve. D-99 deletes the curated list, the
    three tiers and `specialNumberTier` outright, so the only population whose
    size still sizes an exposure is D-96's rebate family: a prime p > 100,000
    with p = 1 (mod 101), which is the one thing in the block that a wrong count
    would mis-size. Sieved here with the same deterministic Miller-Rabin the
    contract, the webapp and the sim all share (`trophy_auction.is_prime`), so
    this is an independent check and not a re-read of the field it checks.
    """
    from primes_sim import trophy_auction as trophy

    block = params["genesis"]["score_rebate"]
    fam = block["rebate_family"]
    horizon = block["horizon_n"]
    assert (fam["min_n"], fam["mod"]) == (100_000, 101)

    count = sum(1 for n in range(fam["min_n"] + 1, horizon + 1)
                if n % fam["mod"] == 1 and trophy.is_prime(n))
    assert fam["sieved_count_to_horizon"] == count

    # D-96's own ceiling: rarer than 1 in 1,000 integers.
    assert fam["density_per_integer"] < 1 / 1_000
    # and Dirichlet's 1-in-phi(101) share of the primes, to sampling tolerance.
    assert fam["share_of_primes_in_window"] == pytest.approx(1 / 100, rel=0.25)


def test_the_rebate_block_says_which_figures_are_whose(params):
    """CLAUDE.md rule 3 on the D-99 rebate: the two SIGNED targets are the
    owner's and the two SHIPPED rates are the sim's clamp of them. A reader must
    be able to tell which is which without leaving the file, and must be told
    whether the clamp bound."""
    block = params["genesis"]["score_rebate"]
    assert "D-99" in block["_decision"]
    assert "OWNER-DECLARED" in block["signed_targets_ton"]["_provenance"]

    sizing = block["sizing"]
    rates = block["rates"]
    scale = sizing["scale_applied"]
    for key, signed in (("composite_per_point", 0.005), ("prime_family", 0.132)):
        assert block["signed_targets_ton"][key] == signed
        assert rates[key]["reward_ton"] == pytest.approx(signed * scale, abs=1.1e-6)
        assert rates[key]["reward_ton"] <= signed * scale   # rounded DOWN, never up
    # the sim clamps DOWN or ships the signed figure; it never inflates one
    assert scale <= 1.0
    assert sizing["clamped"] == (sizing["scale_solved"] < 1.0)
    # and the projection lands where the rule says it does
    assert block["projection"]["share_of_puzzles_track"] <= 0.5 + 1e-9

    # the tier vocabulary is gone and must not come back
    dumped = json.dumps(block).lower()
    for word in ('"discount"', '"free"', '"bonus"', "tier_value_ton"):
        assert word not in dumped


def test_the_score_block_is_owner_declared_and_top_level(params):
    """D-99: the 54 weights are the owner's (33 signed as D-99, phase 3's six
    added by PRICING_MODEL_PLAN.md SS4, N6's nine appended at 39..47, D-162's six
    at 48..53), and the
    file has to say so in the same words the tier prices they replace were
    recorded in."""
    score = params["score"]
    assert score["_provenance"] == "owner-declared (D-99)"
    assert len(score["weights"]["bits"]) == 54
    assert score["weights"]["SCORE_MAX"] == 87
    assert "special_numbers" not in params["genesis"]


def test_the_naming_fees_are_the_owners_and_the_generator_emits_them_verbatim(params):
    """D-212: a naming costs TON (the owner's 50 EUR, then 200 TON), and the
    PRIMES burn block it replaced is gone with the sink. `naming_block()` is pure,
    so the committed block must equal it exactly -- the proof the JSON came from
    the generator without re-running the sim. No TON figure for the first naming
    may appear: it is chosen on genesis day (`PRIMES_NAME_FEE_TON`)."""
    from primes_sim import acquisition as acq

    assert "sinks" not in params, "D-212 deletes the burn sink and its block"
    naming = params["naming"]
    assert naming == acq.naming_block()
    assert naming["rename_fee_ton"] == 200.0
    assert naming["name_fee_eur"] == 50.0
    assert "name_fee_ton" not in naming
    assert "D-212" in naming["_provenance"]
