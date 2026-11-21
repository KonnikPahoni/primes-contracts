"""SS4.1's seventh line -- invite transfers (TELEGRAM_INVITES_PLAN.md, owner
2026-11-07; it replaced D-101's generator deploys).

  * the split stays closed at 100% for every `invite_count` in 0..3, and for a
    short invitee list inside each of them;
  * beta shrinks by exactly `count * INVITE_TRANSFER_VALUE_TON` and by nothing
    else -- the five named lines are byte-for-byte the ones they were;
  * an unspent slot returns to beta, so a short list is arithmetically the same
    mint as a lower count (D-101 call 3);
  * `count = 0` reproduces SS4.1's six beta values, so nobody who does not opt
    in sees a different game;
  * `k < 1` still holds and the ratchet still ratchets -- VERIFIED, not
    asserted: the rebate is `k*beta*P`, so a smaller beta shrinks injection and
    emission in the same ratio and `(T+I)/(S+kI/p_f) > p_f` survives it.
"""
from __future__ import annotations

import pytest

from primes_sim import economics as econ

COUNTS = range(0, econ.INVITE_MAX_COUNT + 1)
V = econ.INVITE_TRANSFER_VALUE_TON


def _split(count: int, served: int | None = None, price: float = 1.0):
    """One referred composite mint -- the busiest split row (D-106 deleted the
    patron line, so `composite, referred` IS the smallest-residual row now)."""
    return econ.split_mint(
        price,
        factor_owners={"alice": 0.6, "bob": 0.4},
        referral_owner=42,
        minted_primes_count=51,
        is_prime_mint=False,
        invite_count=count,
        invitees_served=served,
    )


def test_the_line_is_the_owners_three_transfers_of_a_tenth():
    """Both numbers are OWNER-SET (TELEGRAM_INVITES_PLAN.md decision 1): up to 3
    transfers of 0.1 TON, so the line is 0.30 TON at the full count."""
    assert econ.INVITE_MAX_COUNT == 3
    assert V == pytest.approx(0.1)
    assert econ.INVITE_MAX_COUNT * V == pytest.approx(0.30)


@pytest.mark.parametrize("count", COUNTS)
@pytest.mark.parametrize("price", [1.0, 4.0])
def test_split_closed_at_100pct(count: int, price: float):
    for served in range(0, count + 1):
        r = _split(count, served, price)
        total = (
            r.treasury + r.gas_ops + r.tribute_paid + r.flat_dividend
            + r.referral_paid + r.invite_paid + r.pool_injection
        )
        assert total == pytest.approx(price), (count, served)
        # No line is ever negative -- a closed split that closes by going short
        # somewhere is not closed.
        assert min(
            r.treasury, r.gas_ops, r.tribute_paid, r.flat_dividend, r.referral_paid,
            r.invite_paid, r.invite_to_pool, r.pool_injection,
        ) >= 0.0
        # The to-pool terms were never subtracted, so they live inside beta.
        assert r.pool_injection >= r.tribute_to_pool + r.referral_to_pool + r.invite_to_pool


@pytest.mark.parametrize("count", COUNTS)
def test_beta_shrinks_by_the_line_and_nothing_else(count: int):
    base, r = _split(0), _split(count)
    assert r.pool_injection == pytest.approx(base.pool_injection - count * V)
    assert r.invite_paid == pytest.approx(count * V)
    # The five named lines are untouched at their stated rates (D-101 call 1).
    for line in ("treasury", "gas_ops", "tribute_paid", "flat_dividend",
                 "referral_paid"):
        assert getattr(r, line) == pytest.approx(getattr(base, line)), line
    assert r.recipient_shares == base.recipient_shares
    # And the analytic beta() agrees with the realised residual.
    assert econ.beta(False, True, invite_count=count) == pytest.approx(r.pool_injection)


@pytest.mark.parametrize("count", COUNTS)
def test_unspent_slot_returns_to_beta(count: int):
    """A short list is the same mint as a lower count -- no refund, no carry."""
    for served in range(0, count + 1):
        short = _split(count, served)
        lower = _split(served)
        assert short.pool_injection == pytest.approx(lower.pool_injection)
        assert short.invite_paid == pytest.approx(lower.invite_paid)
        assert short.invite_to_pool == pytest.approx((count - served) * V)


def test_count_zero_reproduces_the_beta_values():
    """Default behaviour is unchanged for anyone who does not opt in (SS4.1).

    FOUR rows, not six: D-106 deleted the patron line, so the phi1/phi2 rows
    (0.40/0.50 and 0.575/0.675) no longer exist.
    """
    # D-117: the gas & ops line is sim-derived, so the rows are written against it.
    g = econ.SplitParams().gas_ops_pct
    assert econ.beta(False, True) == pytest.approx(0.75 - g)
    assert econ.beta(False, False) == pytest.approx(0.85 - g)
    assert econ.beta(True, True) == pytest.approx(0.85 - g)
    assert econ.beta(True, False) == pytest.approx(0.95 - g)


def test_beta_at_max_count_is_the_rows_minus_030():
    for prime in (False, True):
        for referred in (False, True):
            full = econ.beta(prime, referred, invite_count=econ.INVITE_MAX_COUNT)
            assert full == pytest.approx(econ.beta(prime, referred) - 0.30)
            assert full > 0.0
    # the plan's worst case: a referred composite keeps 0.25 for the ratchet
    assert econ.beta(False, True, invite_count=econ.INVITE_MAX_COUNT) == pytest.approx(0.25)


def test_optin_rate_is_labelled_as_an_assumption():
    assert econ.INVITE_OPTIN_RATE_ASSUMED == 1.0   # the webapp always fills 3
    label = econ.INVITE_OPTIN_RATE_LABEL.lower()
    assert "assumed" in label and "not measured" in label
    # The cohort mean sits `optin * count * V` below the uninvited row.
    mean = econ.beta_expected(False, True)
    assert mean == pytest.approx(0.75 - econ.SplitParams().gas_ops_pct
                                 - econ.INVITE_OPTIN_RATE_ASSUMED * econ.INVITE_MAX_COUNT * V)


@pytest.mark.parametrize("count", COUNTS)
def test_k_lt_1_and_the_ratchet_still_ratchets(count: int):
    """SS5 / D-101: the rebate is `k*beta*P`, a fraction OF THE INJECTION.

    Verified rather than asserted -- for the worst k the uplift stack can
    produce (the single K_CEIL clamp, which is not a function of beta), emission
    and injection shrink in the same ratio and the floor still rises.
    """
    up = econ.UpliftParams()
    k, clamped = econ.k_max_effective(
        1000, n0=1000, cap=0.9, k_min=0.2, up=up,
        recruit_rank=5, prime_rank=5, in_prime_window=True, in_newcomer_window=True,
    )
    assert clamped and k == pytest.approx(up.k_ceil) and k < 1.0

    inj = _split(count).pool_injection
    b0 = _split(0).pool_injection
    assert 0.0 < inj <= b0
    assert k * inj < inj                      # k < 1 -> emitted value < injected

    T, S = 285_754.0, 47_502_892.0            # final_state of the base sim run
    p_f = T / S
    emitted = econ.rebate_primes(inj, k, p_f)
    assert emitted == pytest.approx(k * inj / p_f)
    # Emission tracks beta exactly -- it does not lag or lead it.
    assert emitted / econ.rebate_primes(b0, k, p_f) == pytest.approx(inj / b0)
    # (T+I)/(S+kI/p_f) > p_f, the SS5 theorem, at this smaller beta.
    assert (T + inj) / (S + emitted) > p_f


# --------------------------------------------------------------------------- #
# The two guards on the reference implementation
# --------------------------------------------------------------------------- #

def test_the_residual_must_stay_positive_and_says_so_when_it_does_not():
    """`I = beta*P > 0` is the one premise docs/math-note.md's theorem still
    needs. Every deduction but one is a RATE and so is price-free; the seventh
    line is an ABSOLUTE 0.1 TON per slot, so at a low enough price and count 3
    it eats past the residual and the pool would fund the invitations.
    Unreachable in the shipped game -- MINT_PRICE is a flat 1 TON and a prime's
    lane rests at `max(NPV(p)/2, P0(p)/3, MINT_PRICE)` -- which is exactly why the guard
    belongs in the reference phase 2's ledger is written from.

    The worst row is referred-composite. At 3 x 0.1 TON it breaks below
    0.30 / 0.55 ~ 0.545 TON (it was ~0.19 TON at D-101's 5 x 0.025) -- still
    below the flat 1 TON MINT_PRICE every mint splits on.
    """
    def worst(price):
        # referred composite: the row with the smallest residual
        return econ.split_mint(price, {"alice": 1.0}, referral_owner=42,
                               minted_primes_count=51, invite_count=econ.INVITE_MAX_COUNT)

    # the shipped price is clear: 1 - .05 - .10 - .10 - gas & ops - .30
    assert worst(1.0).pool_injection == pytest.approx(0.45 - econ.SplitParams().gas_ops_pct)
    assert worst(0.6).pool_injection > 0.0
    for price in (0.5, 0.18, 0.10):
        with pytest.raises(AssertionError, match="residual is not positive"):
            worst(price)


@pytest.mark.parametrize("bad", [2.5, "5", None, True])
def test_invite_count_is_an_integer_not_merely_in_range(bad):
    """The count is the number of recipient addresses. Range-checking alone
    accepted 2.5 and deducted TON for two and a half transfers."""
    with pytest.raises(TypeError):
        econ.split_mint(1.0, None, referral_owner=None, invite_count=bad)


# --------------------------------------------------------------------------- #
# The ENGINE side: is the HORIZON actually simulated under the line?
#
# Everything above is per-mint arithmetic in isolation. Until `SimParams` grew
# `invite_optin_rate` the three-year run underneath every block in
# shared/params.json split at the uninvited beta while the published opt-in rate
# was 0.80, and `invites._horizon_not_simulated` disclosed the gap rather than
# closing it. These pin the wiring that closed it.
# --------------------------------------------------------------------------- #

from primes_sim.engine import Engine, PrimeHeadParams, SimParams  # noqa: E402


def _engine(rate: float, seed: int = 7) -> Engine:
    """A small run -- 25 days, n_max 5000 -- not a calibration pass."""
    return Engine(SimParams(
        seed=seed,
        horizon_days=25,
        n_max=5000,
        history_every_n_mints=50,
        invite_optin_rate=rate,
        prime_head=PrimeHeadParams(npv_horizon=5000),
    )).run()


def _fingerprint(e):
    """Everything about a run that is NOT the money: which numbers minted, in
    which order, to which wallet, under which referral. The invite line moves
    none of it -- if it does, the draw is coming off the wrong RNG stream.

    `ev.k` USED TO BE IN HERE AND D-156 TOOK IT OUT, deliberately. The logistic
    supply cap makes `k` a function of `S` (`k_eff = k*(S_MAX - S)/S_MAX`), and
    `S` is money -- so a smaller residual now propagates into `k`, and `k` no
    longer belongs in a fingerprint whose whole definition is "not the money".
    The RNG-stream check this function exists for is untouched: the mint
    SEQUENCE is what a mis-drawn `_invite_rng` would reshuffle, and that is
    still compared exactly. `k` is asserted separately, with the tolerance the
    coupling implies -- see `test_the_supply_cap_couples_k_to_the_invite_line`.
    """
    return [(ev.n, ev.wallet_id, ev.archetype, ev.referred) for ev in e.mint_log]


def test_rate_zero_deducts_nothing_and_is_reproducible():
    a, b = _engine(0.0), _engine(0.0)
    assert a.mint_log, "the fixture must actually mint"
    assert all(ev.invite_count == 0 for ev in a.mint_log)
    assert (a.T, a.S, a.floor_price, a.head) == (b.T, b.S, b.floor_price, b.head)
    assert _fingerprint(a) == _fingerprint(b)


def test_rate_one_deducts_the_full_line_on_every_mint():
    """3 x 0.1 TON off the residual of every mint, and NOTHING else changed.

    The identical fingerprint is the check on the dedicated `_invite_rng`
    stream: had the draw come off `self.rng`, one extra draw per mint would
    reshuffle the arrival clock, the wallet assignment and every prime decline
    behind it, and this list would diverge on the first mint.
    """
    off, on = _engine(0.0), _engine(1.0)

    assert all(ev.invite_count == econ.INVITE_MAX_COUNT for ev in on.mint_log)
    assert _fingerprint(on) == _fingerprint(off)

    line = econ.INVITE_MAX_COUNT * V
    assert line == pytest.approx(0.30)
    for hot, cold in zip(on.mint_log, off.mint_log):
        assert cold.pool_injection - hot.pool_injection == pytest.approx(line, abs=1e-12)


def test_the_supply_cap_couples_k_to_the_invite_line():
    """D-156, stated as a test rather than discovered again later.

    Before the logistic cap, `k` was a pure function of `(n, t, uplifts)` and the
    invite line could not reach it. `k_eff = k*(S_MAX - S)/S_MAX` makes it a
    function of `S` too, so a smaller residual -> less emission -> a fractionally
    LARGER `k` on the next mint. The effect is real and it is tiny: at `S` near
    genesis the two runs differ in the seventh significant figure.

    MEASURED on this fixture: max relative deviation 1.306e-03 over 4,330 mints,
    and ZERO sign violations (2026-11-07, at TELEGRAM_INVITES_PLAN.md's 3 x 0.1 TON
    line; it was 2.697e-04 at D-101's 5 x 0.025 -- the coupling scales with the
    TON the line takes out of the residual). The bound below is that measurement plus headroom,
    not a guess -- a run that exceeds it has changed the coupling, not the noise.

    Direction matters more than magnitude. The invited run emits less, so its
    `S` is lower, so its taper is closer to 1 -- `k` must come out >= the
    uninvited run's, never below it. A flipped sign here means the taper is
    reading the wrong side of the cap.
    """
    off, on = _engine(0.0), _engine(1.0)
    pairs = [(h.k, c.k) for h, c in zip(on.mint_log, off.mint_log)]
    assert any(h != c for h, c in pairs), "the cap must actually couple k to S"
    for hot, cold in pairs:
        assert hot >= cold - 1e-12
        assert hot == pytest.approx(cold, rel=2e-3)


@pytest.mark.parametrize("rate", [0.0, 1.0])
def test_the_engine_split_is_closed_at_100pct_either_way(rate: float):
    """Per mint: the paid lines, the invite line and the residual are the 1 TON
    that went in. The unpaid lines (no factor owner, no referral key, a prime's
    tribute) are already inside `pool_injection` -- that IS SS4.1's "falls to
    the pool", and the closure is what proves nothing leaked to the team."""
    e = _engine(rate)
    sp = e.p.split
    for ev in e.mint_log:
        total = (ev.tribute_paid + ev.flat_dividend + ev.pool_injection
                 + ev.invite_count * V
                 + sp.treasury_pct + sp.gas_ops_pct
                 + (sp.referral_pct if ev.referred else 0.0))
        assert total == pytest.approx(1.0, abs=1e-9)


def test_the_realised_optin_share_matches_the_assumption_it_was_drawn_from():
    """The Bernoulli draw is the SIMULATION of what `econ.beta_expected`
    computes analytically, so over a run the two must agree. That agreement is
    what lets params.json publish a measured cohort-mean beta instead of
    restating the assumed rate back at the reader."""
    e = _engine(econ.INVITE_OPTIN_RATE_ASSUMED, seed=11)
    share = sum(ev.invite_count > 0 for ev in e.mint_log) / len(e.mint_log)
    assert share == pytest.approx(econ.INVITE_OPTIN_RATE_ASSUMED, abs=0.05)

    mean_line = sum(ev.invite_count for ev in e.mint_log) * V / len(e.mint_log)
    analytic = (econ.beta(False, True, e.p.split, 0, 1.0)
                - econ.beta_expected(False, True, e.p.split,
                                     econ.INVITE_MAX_COUNT,
                                     econ.INVITE_OPTIN_RATE_ASSUMED, 1.0))
    assert mean_line == pytest.approx(analytic, abs=0.01)
