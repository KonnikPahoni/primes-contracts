"""Missing-tests survey, sim "Later" items 6-12: input guards that used to fail
silently, the params.json --check, the kill criteria, OPS_RESERVE rebuilt from its
own stored inputs, the gas-line rounding edges, the sieve and params.json's shape.
"""
from __future__ import annotations

import json
import math
import os
import sys

import pytest

from primes_sim import analysis as an
from primes_sim import economics as econ
from primes_sim import gas as gasmod
from primes_sim import kill_criteria as kc
from primes_sim import storage
from primes_sim.numtheory import Sieve

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PARAMS_PATH = os.path.join(REPO_ROOT, "shared", "params.json")
sys.path.insert(0, os.path.join(REPO_ROOT, "sim", "scripts"))
import run_phase1  # noqa: E402


@pytest.fixture(scope="module")
def params():
    with open(PARAMS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------- #
# 6. K_CEIL >= 1 voids SS5's k < 1; k(t) edges
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bad", [1.0, 1.5, 0.0, -0.1])
def test_k_ceil_outside_open_unit_interval_is_rejected(bad):
    with pytest.raises(ValueError, match="k_ceil"):
        econ.UpliftParams(k_ceil=bad)


def test_k_ceil_just_below_one_is_accepted_and_still_clamps_below_one():
    up = econ.UpliftParams(k_ceil=0.999, recruit_rank_uplifts=(5.0,) * 6)
    k, bound = econ.k_max_effective(10, 1000, 0.9, 0.2, up, recruit_rank=5)
    assert bound and k == 0.999 < 1.0


def test_k_of_t_zero_ramp_raises_instead_of_zero_division():
    with pytest.raises(ValueError, match="ramp"):
        econ.k_of_t(1.0, 0.2, 0.9, 0.0)
    with pytest.raises(ValueError, match="ramp"):
        econ.k_of_t(1.0, 0.2, 0.9, -5.0)


@pytest.mark.parametrize("t", [-1e9, -1.0, 0.0])
def test_k_of_t_non_positive_t_is_k_min(t):
    assert econ.k_of_t(t, 0.2, 0.9, 3600) == 0.2


def test_k_of_t_stays_in_band():
    for t in (1e-9, 1.0, 1799.0, 3599.999, 3600.0, 3600.001, 1e12):
        assert 0.2 <= econ.k_of_t(t, 0.2, 0.9, 3600) <= 0.9


# --------------------------------------------------------------------------- #
# 7. run_phase1.py --check: diff/exit logic on fixtures (the real run is a
#    many-minute job; it is run on the box as `pnpm remote sim:phase1 --check`)
# --------------------------------------------------------------------------- #

def _write(path, doc, crlf=False, indent=2):
    text = json.dumps(doc, indent=indent)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text.replace("\n", "\r\n") if crlf else text)


_DOC = {"_meta": {"generated_at": "2026-01-01T00:00:00Z", "schema_version": "2.0.0"},
        "rebate": {"K_CEIL": 0.95, "k_min": 0.2}}


def test_params_drift_ignores_timestamp_crlf_and_formatting(tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    _write(a, _DOC)
    other = json.loads(json.dumps(_DOC))
    other["_meta"]["generated_at"] = "2027-12-31T23:59:59Z"
    _write(b, other, crlf=True, indent=4)
    assert run_phase1.params_drift(str(b), str(a)) == []


def test_params_drift_reports_a_changed_value(tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    _write(a, _DOC)
    other = json.loads(json.dumps(_DOC))
    other["rebate"]["K_CEIL"] = 0.96
    _write(b, other)
    drift = run_phase1.params_drift(str(b), str(a))
    assert any(l.startswith("-") and "0.95" in l for l in drift)
    assert any(l.startswith("+") and "0.96" in l for l in drift)


def _fake_run(doc, ok=True, seen=None):
    def run(params_path, write_docs):
        assert not write_docs, "--check must not regenerate docs/audit pages"
        assert os.path.abspath(params_path) != os.path.abspath(PARAMS_PATH)
        if seen is not None:
            seen.append(params_path)
        _write(params_path, doc)
        return ok
    return run


def test_check_exit_codes_and_never_writes_the_committed_file(tmp_path):
    committed = tmp_path / "params.json"
    _write(committed, _DOC)
    before = committed.read_bytes()
    seen = []
    assert run_phase1.check(str(committed), run=_fake_run(_DOC, seen=seen)) == 0
    drifted = json.loads(json.dumps(_DOC))
    drifted["rebate"]["k_min"] = 0.21
    assert run_phase1.check(str(committed), run=_fake_run(drifted)) == 1
    # No drift but a failing run (a kill criterion) is still red.
    assert run_phase1.check(str(committed), run=_fake_run(_DOC, ok=False)) == 1
    assert committed.read_bytes() == before
    assert not os.path.exists(seen[0]), "the temp regeneration outlived the check"


# --------------------------------------------------------------------------- #
# 8. kill criteria
# --------------------------------------------------------------------------- #

def _amm(monkeypatch, days, frac, sufficient):
    monkeypatch.setattr(an, "amm_vs_floor_detachment", lambda e: {
        "approx_max_consecutive_days_below_floor": days,
        "fraction_of_samples_below_floor": frac})
    monkeypatch.setattr(an, "guard_can_close_detachment", lambda e: (
        {} if sufficient is None else {"balance_sufficient": sufficient}))
    return kc.check_amm_detachment(None)


@pytest.mark.parametrize("days,frac,sufficient,persistent,passed", [
    (0.0, 0.0, False, False, True),    # never detached
    (13.9, 0.149, False, False, True),  # just under both thresholds
    (14.0, 0.0, False, True, False),   # persistent by duration, guard short
    (0.0, 0.15, False, True, False),   # persistent by share, guard short
    (30.0, 0.5, True, True, True),     # persistent but the guard can close it
    (30.0, 0.5, None, True, False),    # no capacity reading counts as cannot close
])
def test_check_amm_detachment_branches(monkeypatch, days, frac, sufficient, persistent, passed):
    r = _amm(monkeypatch, days, frac, sufficient)
    assert r["persistent_detachment_observed"] is persistent
    assert r["passed"] is passed


def test_baseline_kill_criteria_all_passed(params):
    kills = params["kill_criteria"]
    assert kills["all_passed"] is True
    assert {k["name"] for k in kills["results"]} == {
        "amm_detachment_guard_cannot_close", "tribute_justifies_auction_reserve_under_sqrt_p"}
    assert all(k["passed"] for k in kills["results"])


def test_baseline_amm_verdict_recomputes_from_its_stored_measurement(params, monkeypatch):
    stored = next(k for k in params["kill_criteria"]["results"]
                  if k["name"] == "amm_detachment_guard_cannot_close")
    monkeypatch.setattr(an, "amm_vs_floor_detachment", lambda e: stored["measured"])
    monkeypatch.setattr(an, "guard_can_close_detachment", lambda e: stored["guard_capacity"])
    assert kc.check_amm_detachment(None) == stored


# --------------------------------------------------------------------------- #
# 9. OPS_RESERVE and the gas & ops line
# --------------------------------------------------------------------------- #

def test_ops_reserve_rebuilds_from_its_stored_inputs(params):
    d = params["fees"]["ops_reserve_derivation"]
    inp = d["inputs"]
    total_mints = d["horizon_mints"]
    r = gasmod.ops_reserve(
        inp["gas_baseline"],
        total_mints=total_mints,
        horizon_days=inp["seconds_per_mint"] * total_mints / 86400,
        owed_entries=inp["owed_entries_at_final_head"],
        horizon_mints=d["horizon_mints"],
        settlement_rate=inp["settlement_rate_assumed"],
    )
    assert r.reserve_ton == params["fees"]["ops_reserve_ton"] == 99.0
    assert r.settlement_ton == pytest.approx(d["settlement_ton"], rel=1e-6)
    # seconds_per_mint is stored to 4 dp, so the rent leg rebuilds to ~1e-6 relative.
    assert r.owed_rent_ton == pytest.approx(d["owed_rent_ton"], rel=1e-5)
    assert r.total_ton == pytest.approx(d["unrounded_total_ton"], rel=1e-6)
    assert r.settlement_gas_ton_per_mint == d["settlement_gas_ton_per_mint"]
    assert r.owed_rent_ton_per_second == pytest.approx(d["owed_rent_ton_per_second"], rel=1e-6)


def test_ops_reserve_rejects_zero_mints():
    base = {"ledger.mint_won_lot": 128158, "market.close": 12550}
    with pytest.raises(ValueError, match="total_mints"):
        gasmod.ops_reserve(base, total_mints=0, horizon_days=365.0, owed_entries=1000)


def _line(worst_nanoton, mint_price_ton=1.0):
    return gasmod.gas_ops_line({"gas_ops_spend.worst": worst_nanoton,
                                "gas_ops_spend.small": 1_000_000}, mint_price_ton=mint_price_ton)


@pytest.mark.parametrize("worst_nano,pct", [
    (150_000_000, 0.15),   # exactly on a step: no extra step from 2.9999999999999996
    (150_000_001, 0.20),   # one nanoTON over a step buys the next one
    (150_000_020, 0.20),   # was 0.15 -- the round(.., 6) swallowed it
    (180_000_000, 0.20),
    (191_764_880, 0.20),   # the committed worst_plain_w12 row
    (1_000_000_000, 1.0),  # a worst case equal to the mint is still coverable
])
def test_gas_ops_line_rounds_up_to_the_step(worst_nano, pct):
    line = _line(worst_nano)
    assert line["gas_ops_pct"] == pct
    assert line["headroom_ton"] >= 0, "the line must cover the worst mint it is sized on"


def test_gas_ops_line_refuses_a_worst_case_above_the_mint_price():
    with pytest.raises(ValueError, match="MINT_PRICE"):
        _line(1_000_000_001)


def test_committed_gas_ops_line_matches_the_derivation(params):
    rows = params["fees"]["gas_ops_line"]["rows_ton"]
    base = {gasmod.GAS_OPS_SPEND_PREFIX + k: round(v / gasmod.NANOTON) for k, v in rows.items()}
    assert gasmod.gas_ops_line(base)["gas_ops_pct"] == params["mint"]["gas_ops_pct"]


# --------------------------------------------------------------------------- #
# 12. storage / numtheory edges, params.json shape
# --------------------------------------------------------------------------- #

def test_n_for_prime_count_small_cases():
    assert storage.n_for_prime_count(1, hi=100) == 2
    assert storage.n_for_prime_count(4, hi=100) == 7
    assert storage.n_for_prime_count(25, hi=100) == 97


def test_n_for_prime_count_beyond_the_sieve_raises():
    # pi(100) = 25: the 26th prime is past `hi`, which used to come back as hi+1.
    with pytest.raises(ValueError, match="raise `hi`"):
        storage.n_for_prime_count(26, hi=100)


def _is_prime(n):
    return n >= 2 and all(n % d for d in range(2, math.isqrt(n) + 1))


@pytest.mark.parametrize("n_max", [0, 1, 2, 3, 4, 48, 49, 50, 1000])
def test_sieve_matches_trial_division(n_max):
    s = Sieve(n_max)
    for n in range(n_max + 1):
        assert bool(s.is_prime(n)) == _is_prime(n), n
        if n >= 2:
            f = s.factorize(n)
            assert math.prod(p ** e for p, e in f.items()) == n
            assert all(_is_prime(p) for p in f)
            assert s.omega(n) == len(f)


def test_sieve_degenerate_inputs():
    s = Sieve(10)
    for n in (-7, -1, 0, 1):
        assert not s.is_prime(n)
    assert s.factorize(1) == {}
    assert s.factorize(0) == {}
    with pytest.raises(IndexError):
        s.is_prime(11)


def test_params_json_schema(params):
    def walk(o, path="$"):
        if isinstance(o, dict):
            for k, v in o.items():
                assert isinstance(k, str)
                walk(v, f"{path}.{k}")
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, f"{path}[{i}]")
        elif isinstance(o, float):
            assert math.isfinite(o), f"{path} is not finite"
        else:
            assert o is None or isinstance(o, (str, int, bool)), f"{path}: {type(o)}"

    with open(PARAMS_PATH, encoding="utf-8") as fh:
        json.loads(fh.read(), parse_constant=lambda c: pytest.fail(f"non-JSON constant {c}"))
    walk(params)

    required = {"_meta", "mint", "invites", "tribute", "rebate", "flush", "prime_head",
                "score", "genesis", "treasury", "staking", "fees", "kill_criteria",
                "final_state", *run_phase1.FOREIGN_PARAM_KEYS}
    assert required <= params.keys(), required - params.keys()
    assert all(isinstance(params[k], dict) for k in required)
    assert params["_meta"]["schema_version"] == run_phase1.SCHEMA_VERSION

    r = params["rebate"]
    # SS5: k_min < k_max_cap < K_CEIL < 1, primes emit nothing, S_MAX in both units.
    assert 0 < r["k_min"] < r["k_max_cap"] < r["K_CEIL"] < 1
    assert r["k_on_prime_mint"] == 0
    assert r["ramp_seconds"] > 0
    assert r["S_MAX_nanoprimes"] == round(r["S_MAX"] * 1e9)
    for tiers, ups in (("recruit_rank_tiers", "recruit_rank_kmax_uplifts"),
                       ("prime_rank_tiers", "prime_rank_kmax_uplifts")):
        assert r[tiers] == sorted(r[tiers]) and len(r[ups]) == len(r[tiers]) + 1
        assert r[ups] == sorted(r[ups]) and r[ups][0] == 0

    m = params["mint"]
    # SS4.1: the fixed lines leave a positive residual for the ratchet.
    assert m["mint_price_ton"] > 0
    assert 0 < m["tribute_pct"] + m["referral_pct"] + m["treasury_pct"] + m["gas_ops_pct"] < 1
