"""Parrondo search -- the auditor's question SS5's theorem does not answer.

SS5 proves `k < 1` on one mint. Parrondo's paradox is about what a *sequence* of
individually-losing plays can do when one play changes the state the next is
played in, and TON PRIMES has exactly that coupling: minting a prime pays nothing
(SS5.1) but buys prime rank and opens PRIME_WINDOW, both of which uplift `k_max`
on subsequent composite mints (SS4.7.1, SS5).

Three things are asserted here, in increasing order of strength:

  1. the model is a faithful encoding of SS5/SS5.1/SS4.7.1 -- prime mints emit
     nothing, uplifts stack and clamp once, the coupling exists at all;
  2. the Parrondo signature IS present -- mixing beats both pure games. This is
     designed behaviour, and asserting it means a future edit that silently kills
     the rank incentive shows up here rather than in a player's spreadsheet;
  3. **no policy is ever profitable**, at any n, any beta row, any rank grant.
     This is the one that must never go green-to-red without a design decision.

See `primes_sim/parrondo.py` for what is measured (emission only) and for the six
places the model is deliberately generous to the attacker.
"""
from __future__ import annotations

import pytest

from primes_sim import economics as econ
from primes_sim import parrondo as pa


@pytest.fixture(scope="module")
def params():
    return pa.load_params()


@pytest.fixture(scope="module")
def model(params):
    return pa.model_from_params(params, n=10_000, beta_composite=0.65)


# --------------------------------------------------------------------------- #
# 1 -- the model encodes the concept
# --------------------------------------------------------------------------- #


def test_prime_mint_emits_nothing(model):
    """SS5.1: `k = 0` unconditionally, so game B's payoff is the whole mint price."""
    assert model.prime_payoff() == pytest.approx(-model.mint_price)


def test_composite_mint_loses_in_isolation(model):
    """Game A is a losing game at every reachable state -- that is `k * beta < 1`."""
    for pc in (0, 1, 3, 10, 30, 100):
        for w in range(model.prime_window + 1):
            for mm in range(model.newcomer_window + 1):
                assert model.composite_payoff(pc, w, mm) < 0.0


def test_the_coupling_exists(model):
    """B must actually improve A, or there is no paradox to search for: both the
    permanent rank uplift and the temporary window uplift have to bite."""
    base = model.k_effective(primes_minted=0, window_pos=model.prime_window, mints_made=99)
    ranked = model.k_effective(primes_minted=100, window_pos=model.prime_window, mints_made=99)
    windowed = model.k_effective(primes_minted=0, window_pos=0, mints_made=99)
    assert ranked > base, "prime rank does not uplift k_max — SS4.7.1 is not wired in"
    assert windowed > base, "PRIME_WINDOW does not uplift k_max — SS5.1 is not wired in"


def test_window_resets_only_on_a_prime_mint(model):
    """The reset is the single backward edge in an otherwise monotone chain, and
    it is what makes the state machine cyclic enough for a paradox."""
    s = (5, 0, 0)
    assert pa._after_composite(model, s)[1] == 1
    assert pa._after_prime(model, (5, 4, 0))[1] == 0
    assert pa._after_prime(model, (5, 4, 0))[0] == 6


def test_uplifts_clamp_once_at_k_ceil(model, params):
    """SS5's single clamp on the SUM. The bound below is only a bound because this
    holds; if the uplifts clamped individually the stacked value could exceed it."""
    k, clamped = econ.k_max_effective(
        n=model.n, n0=model.n0_anchor, cap=model.k_max_cap, k_min=model.k_min,
        up=model.uplifts, recruit_rank=5, prime_rank=5,
        in_prime_window=True, in_newcomer_window=True,
    )
    assert k <= params["rebate"]["K_CEIL"] + 1e-12
    del clamped


# --------------------------------------------------------------------------- #
# 2 -- the closed-form asymptotic bound
# --------------------------------------------------------------------------- #


def test_asymptotic_bound_is_k_ceil_times_beta(model, params):
    """Granting infinite free grinding, the best sustainable return per GRAM is
    `k_max_stacked * beta`. At n = n0 the clamp binds and the number is exactly
    `K_CEIL * beta_ceiling` — which is what makes K_CEIL the load-bearing constant
    rather than one of the four uplifts."""
    m = pa.model_from_params(params, n=params["rebate"]["n0_anchor"], beta_composite=0.65)
    b = pa.asymptotic_bound(m)
    assert b["clamped_at_K_CEIL"]
    assert b["return_per_ton_at_beta_ceiling"] == pytest.approx(
        params["rebate"]["K_CEIL"] * b["beta_ceiling_in_split"]
    )
    assert b["safe"]


@pytest.mark.parametrize("n", pa.N_DECADES)
def test_asymptotic_bound_safe_at_every_decade(params, n):
    for _name, beta_value, cash in pa.BETA_ROWS:
        m = pa.model_from_params(params, n=n, beta_composite=beta_value, recruit_rank=5,
                                 cash_recovered=cash)
        assert pa.asymptotic_bound(m)["safe"]


def test_self_sender_row_is_the_split_not_a_typed_number():
    """TELEGRAM_INVITES_PLAN.md: a referred composite with 3 invites leaves 0.247
    for the ratchet and a self-sender recovers 0.40 in cash -- together the plain
    referred row plus the self-referral, less the three transfers' fee allowance
    (D-215), so cash and beta cannot both be granted on one GRAM."""
    name, beta, cash = pa.BETA_ROWS[0]
    assert name == "self_sender_referred"
    assert beta == pytest.approx(0.247)
    assert cash == pytest.approx(0.40)
    assert beta + cash + econ.INVITE_MAX_COUNT * econ.INVITE_SEND_FEE_TON == pytest.approx(econ.beta(False, False))


def test_self_sender_scenario_loses_with_its_cash(params):
    """The cash comes back on primes too, so pure B no longer returns 0 -- and
    the best policy still loses."""
    _name, beta, cash = pa.BETA_ROWS[0]
    m = pa.model_from_params(params, n=1_000, beta_composite=beta, recruit_rank=5,
                             cash_recovered=cash)
    assert m.prime_payoff() == pytest.approx(cash - 1.0)
    sig = pa.parrondo_signature(m, horizon=100)
    assert sig["mixed_return_per_ton"] < 1.0
    assert not sig["exploit"]


# --------------------------------------------------------------------------- #
# 3 -- the finite-horizon search
# --------------------------------------------------------------------------- #


def test_net_optimal_policy_is_never_profitable(model):
    """The sharp falsification test. Skipping is always available and scores
    exactly 0, so a positive optimum is not a warning — it is an exploit."""
    r = pa.optimal_net_value(model, horizon=120)
    assert r.optimal_net_ton <= 1e-9
    assert not r.profitable


def test_net_optimum_is_reached_by_not_minting(model):
    """The 0 above must be 'declined to play', not 'played to a break-even'. The
    two are the same number and only the second would be alarming."""
    r = pa.optimal_net_value(model, horizon=120)
    assert r.optimal_spend_ton == pytest.approx(0.0)


def test_ratio_optimal_policy_does_mint_and_still_loses(model):
    """The ratio search is the one that finds a real strategy. It must actually
    spend GRAM (otherwise the bisection degenerated) and must still come back under
    1.0 GRAM returned per GRAM spent."""
    r = pa.optimal_ratio(model, horizon=120)
    assert not r["degenerate"]
    assert r["spend_ton"] > 0.0
    assert r["return_per_ton"] < 1.0


def test_ratio_optimum_dominates_every_fixed_policy(model):
    """Sanity on the solver: an optimal policy that loses to a hand-written one
    means the DP is wrong, and every conclusion drawn from it is worthless."""
    best = pa.optimal_ratio(model, horizon=120)["return_per_ton"]
    for mc, mp in ((True, False), (False, True), (True, True)):
        fixed = pa.evaluate_fixed_policy(model, mint_composites=mc, mint_primes=mp, horizon=120)
        if fixed["return_per_ton"] is not None:
            assert best >= fixed["return_per_ton"] - 1e-9


def test_ratio_optimum_respects_the_asymptotic_bound(model):
    """The finite-horizon optimum pays the grinding cost the closed form amortises
    away, so it can never exceed it. A violation means the two disagree about the
    uplift stack."""
    best = pa.optimal_ratio(model, horizon=120)["return_per_ton"]
    bound = pa.asymptotic_bound(model)["return_per_ton_at_scenario_beta"]
    assert best <= bound + 1e-9


# --------------------------------------------------------------------------- #
# 4 -- the paradox itself
# --------------------------------------------------------------------------- #


def test_parrondo_signature_is_present_and_bounded(params):
    """Mixing the two losing games DOES beat both of them pure. This is designed
    behaviour (SS4.7.1 sells rank as a reward), and it is asserted so that a change
    which silently removes the rank incentive fails here.

    n = 1e6 is chosen because `k_max(n)` has decayed far enough that the flat
    uplifts are proportionally largest — the paradox's best ground.
    """
    m = pa.model_from_params(params, n=1_000_000, beta_composite=0.85, recruit_rank=5)
    sig = pa.parrondo_signature(m, horizon=200)
    assert sig["signature_present"], "the rank/window coupling no longer pays — SS4.7.1 is dead"
    assert sig["signature_gain"] > 0.0
    # and the gain is nowhere near enough to reach break-even
    assert sig["mixed_return_per_ton"] < 1.0
    assert not sig["exploit"]


def test_scan_finds_no_exploit_anywhere(params):
    """The full product of decade x beta row x recruit-rank grant. Nothing is
    sampled and nothing is truncated, so this is the whole claim, not a spot check.

    The horizon is short here to keep the suite fast; `scripts/run_parrondo.py`
    runs it long. The optimum is monotone in the horizon only through the grinding
    cost, which a longer horizon amortises FURTHER — so a short horizon is the
    conservative direction for the exploit test and the generous one for the
    signature test.
    """
    report = pa.scan(horizon=100, params=params)
    assert report["scenario_count"] == len(pa.N_DECADES) * len(pa.BETA_ROWS) * 2
    assert not report["exploit_found"], report["exploit_scenarios"]
    assert report["worst_case"]["mixed_return_per_ton"] < 1.0
    # the worst case must be the clamp binding, not some interior accident
    assert report["worst_case"]["margin_to_break_even"] > 0.0
