"""Parrondo search: can two losing games be combined into a winning one?

WHY THIS MODULE EXISTS
----------------------
CONCEPT.md SS5's ratchet theorem proves `k < 1` **per mint**. That is a statement
about one event. It does not, on its own, rule out the shape Parrondo's paradox
describes: a player alternating between two individually-losing games according
to the current *state* can come out ahead, because one game modifies the state
the other is played in. The paradox's ingredients are a capital-independent
losing game A, a state-dependent losing game B, and a coupling between them.

TON PRIMES has all three, and they are not contrived:

  * game A -- mint a composite. Pays back `k * beta * P` in rebate value at the
    floor, with `k < 1`, so it loses on every play (SS5).
  * game B -- mint a prime. Pays back NOTHING: `k = 0` unconditionally (SS5.1).
    It is the strictly worse game of the two, in isolation.
  * the coupling -- game B raises the player's **prime rank** (SS4.7.1), which
    permanently uplifts `k_max`, and opens the **PRIME_WINDOW**, which
    temporarily uplifts it further. Both uplifts are spent on subsequent plays
    of game A. So B is the state-dependent game whose only payoff is a better A.

That is Parrondo's structure exactly. Whether the combination wins is not
something the SS5 theorem answers, and "K_CEIL clamps every k below 1" answers it
only for the asymptotic case (see `max_asymptotic_return_per_ton` below). The
finite-horizon question -- does grinding rank pay for itself? -- needs the chain
solved.

WHAT IS MEASURED
----------------
**Emission-only value.** Every payoff here is the GRAM-denominated value the
protocol *emits* to the player: the rebate, marked at the floor price. Deliberately
excluded:

  * tribute and flat-dividend income (SS3.2) -- a designed payment to prime
    owners, not an emission from the ratchet. Including it would make prime mints
    look profitable and would be measuring the game, not the exploit surface.
  * the NFT itself, and any resale value.
  * the referral line the player may collect from their own recruits (SS4.1).

ONE EXCEPTION, and it is a scenario input, not a default: `cash_recovered`. A
minter may name itself as referrer AND as all three invite recipients
(TELEGRAM_INVITES_PLAN.md, owner decision 2), so 0.10 + 3 x 0.1 = 0.40 GRAM of
every mint comes straight back as GRAM. That is not emission, but it IS money the
loop recovers, so the self-sender row grants it on every mint, prime or
composite, at the beta that row actually leaves for the ratchet (0.25).

So a positive result here means "the ratchet paid out more than it took in",
which is the only thing SS5's central claim forbids. A negative result does NOT
mean playing is unprofitable -- it means it is unprofitable *at the ratchet's
expense*, which is the property under test. This distinction is the whole point
of the module and must survive any future edit to it.

WHERE THE MODEL IS GENEROUS TO THE ATTACKER
-------------------------------------------
Every modelling choice that could go either way is resolved in the attacker's
favour, so a negative result is a bound rather than an observation:

  1. **Waiting is free and unlimited.** `k(t)` rises with the gap since the last
     mint (SS5), so the attacker is granted `k = k_max` on every composite mint --
     the supremum. In reality they compete with everyone else for the head and
     cannot hold it open.
  2. **Every prime mint is available.** The attacker is never outraced to a prime
     head, and pays nothing extra for the privilege.
  3. **beta is a free parameter**, swept up to its 0.85 ceiling (an unreferred
     prime, SS4.1), rather than pinned at the 0.65 planning number.
  4. **Both rank ladders are grantable.** `recruit_rank` is a scenario input rather
     than a decision, so the attacker may be handed the top recruit tier at zero
     cost, even though reaching it in reality means 100 gift mints at 1 GRAM each
     to 100 distinct fresh addresses (D-106's recruit edge).
  5. **No gas.** Mint price is the flat 1 GRAM with no transaction cost.

THE TWO QUESTIONS, AND THE TWO ANSWERS
--------------------------------------
`asymptotic_bound()` -- closed form. Grant the attacker infinite free grinding to
the best rank and window state reachable, forever. The best sustainable return per
GRAM spent is then `K_CEIL_effective * beta`, which is exactly what the single
`K_CEIL` clamp bounds. This is the strong statement and it needs no search.

`optimal_net_value()` -- finite-horizon dynamic programming over the real state
`(primes_minted, window_position, mints_made)`, maximising expected
`sum(rebate_value - ton_spent)`. The all-skip policy scores exactly 0 and is always
available, so the falsification test is sharp: **any positive optimum is an
exploit**. This is the question the closed form cannot answer, because grinding
cost is transient and washes out of any long-run average.

`parrondo_signature()` -- the paradox proper. Compares the mixed policy against
pure-A (composites only) and pure-B (primes only). If mixing beats both pure games
the Parrondo signature is present, and that is worth reporting *even when every
policy still loses*: it means state-cycling does buy the attacker something, and
the margin to `1.0` is the only thing standing between that and an exploit. A
future parameter change that widens the rank uplifts eats that margin.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import economics as econ

# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ParrondoModel:
    """One scenario: a fixed decade of the number line, a fixed beta row, and a
    fixed grant of recruit rank.

    `n` is held constant across the horizon rather than advancing with the head.
    `k_max(n)` declines in n (SS5), so freezing n at the *start* of a decade hands
    the attacker the highest ceiling available in that decade for the whole run --
    generous, per the module docstring, and it keeps the chain time-homogeneous so
    the DP below is exact rather than approximate.
    """

    n: int = 10_000
    # SS5 rebate curve
    k_min: float = 0.2
    k_max_cap: float = 0.9
    n0_anchor: int = 1000
    uplifts: econ.UpliftParams = field(default_factory=econ.UpliftParams)
    # SS4.1 split: beta on the attacker's composite mints.
    beta_composite: float = 0.65
    # Granted for free (see generosity note 4). Not a decision variable.
    recruit_rank: int = 0
    # GRAM returned to the player outside the rebate on EVERY mint, as a fraction
    # of the price: the self-sender's own referral + invite transfers. 0 except on
    # the self-sender row (see the module docstring's one exception).
    cash_recovered: float = 0.0
    # Density of primes at the head. SS5.1's prime mints are game B, so how often
    # game B is *offered* is a first-order input; the prime number theorem's
    # 1/ln(n) is the honest default.
    prime_density: float | None = None
    mint_price: float = 1.0
    # Cap on the tracked prime count. The top prime-rank tier is 100 primes, so
    # anything above it is behaviourally identical and folds into one state.
    prime_count_cap: int = 100

    @property
    def pi_prime(self) -> float:
        if self.prime_density is not None:
            return self.prime_density
        return 1.0 / math.log(self.n)

    @property
    def newcomer_window(self) -> int:
        return self.uplifts.newcomer_window

    @property
    def prime_window(self) -> int:
        return self.uplifts.prime_window

    def k_effective(self, primes_minted: int, window_pos: int, mints_made: int) -> float:
        """`k` on a composite mint from this state.

        The attacker is granted the supremum of `k(t)`, i.e. `k = k_max` (note 1),
        so this is `k_max_effective` with the SS5 uplift stack summed and clamped
        once at `K_CEIL`.
        """
        k_max, _clamped = econ.k_max_effective(
            n=self.n,
            n0=self.n0_anchor,
            cap=self.k_max_cap,
            k_min=self.k_min,
            up=self.uplifts,
            recruit_rank=self.recruit_rank,
            prime_rank=econ.rank_of(primes_minted, self.uplifts.prime_rank_tiers),
            in_prime_window=window_pos < self.prime_window,
            in_newcomer_window=mints_made < self.newcomer_window,
        )
        return k_max

    def composite_payoff(self, primes_minted: int, window_pos: int, mints_made: int) -> float:
        """Net GRAM on one composite mint: rebate value at the floor, plus any
        recovered cash, minus price."""
        k = self.k_effective(primes_minted, window_pos, mints_made)
        return (k * self.beta_composite + self.cash_recovered) * self.mint_price - self.mint_price

    def prime_payoff(self) -> float:
        """Net GRAM on one prime mint. SS5.1: `k = 0`, so only recovered cash comes back."""
        return self.cash_recovered * self.mint_price - self.mint_price


# --------------------------------------------------------------------------- #
# State space
# --------------------------------------------------------------------------- #
#
# (primes_minted, window_pos, mints_made), each capped at the point past which
# behaviour no longer changes. All three are monotone non-decreasing except
# `window_pos`, which a prime mint resets to 0 -- that reset IS the coupling
# between the two games, and it is the only backward edge in the chain.


def _state_space(m: ParrondoModel) -> tuple[list[tuple[int, int, int]], dict[tuple[int, int, int], int]]:
    states = [
        (pc, w, mm)
        for pc in range(m.prime_count_cap + 1)
        for w in range(m.prime_window + 1)
        for mm in range(m.newcomer_window + 1)
    ]
    return states, {s: i for i, s in enumerate(states)}


def _after_composite(m: ParrondoModel, s: tuple[int, int, int]) -> tuple[int, int, int]:
    pc, w, mm = s
    return (pc, min(w + 1, m.prime_window), min(mm + 1, m.newcomer_window))


def _after_prime(m: ParrondoModel, s: tuple[int, int, int]) -> tuple[int, int, int]:
    pc, _w, mm = s
    return (min(pc + 1, m.prime_count_cap), 0, min(mm + 1, m.newcomer_window))


# The initial state: a fresh account that has minted nothing. `window_pos` starts
# closed (no prime mint yet) and `mints_made` starts at 0, which is inside the
# newcomer window -- SS5's NEWCOMER_UPLIFT is granted from the first mint.
def initial_state(m: ParrondoModel) -> tuple[int, int, int]:
    return (0, m.prime_window, 0)


# --------------------------------------------------------------------------- #
# Question 1 -- the closed-form asymptotic bound
# --------------------------------------------------------------------------- #


def asymptotic_bound(m: ParrondoModel) -> dict:
    """Best sustainable GRAM returned per GRAM spent, granting the attacker every
    uplift at once and forever.

    No search: `k_max_effective` is monotone in every uplift, so the supremum is
    the fully-stacked value, and the return per GRAM on a composite mint is
    `k * beta`. This is the statement `K_CEIL` exists to make, restated as an
    attacker's rate of return so that it is comparable with the DP below.

    Grinding cost does not appear because it is transient: over an infinite
    horizon any finite number of prime mints is amortised to zero. That is what
    makes this a bound and not the whole answer.
    """
    k_best, clamped = econ.k_max_effective(
        n=m.n,
        n0=m.n0_anchor,
        cap=m.k_max_cap,
        k_min=m.k_min,
        up=m.uplifts,
        recruit_rank=len(m.uplifts.recruit_rank_uplifts) - 1,
        prime_rank=len(m.uplifts.prime_rank_uplifts) - 1,
        in_prime_window=True,
        in_newcomer_window=True,
    )
    # beta's ceiling is SS4.1's unreferred-prime row; a composite mint cannot
    # actually reach it (the tribute line resolves), but granting it is free here
    # and keeps the bound above anything the split can produce.
    beta_ceiling = econ.beta(is_prime_mint=True, referred=False)
    return {
        "n": m.n,
        "k_max_fully_stacked": k_best,
        "clamped_at_K_CEIL": bool(clamped),
        "beta_used": m.beta_composite,
        "beta_ceiling_in_split": beta_ceiling,
        "cash_recovered": m.cash_recovered,
        "return_per_ton_at_scenario_beta": k_best * m.beta_composite + m.cash_recovered,
        "return_per_ton_at_beta_ceiling": k_best * beta_ceiling,
        "safe": bool(max(k_best * beta_ceiling,
                         k_best * m.beta_composite + m.cash_recovered) < 1.0),
    }


# --------------------------------------------------------------------------- #
# Question 2 -- finite-horizon optimal policy
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class _Chain:
    """The scenario compiled to flat index arrays, so every pass below is a
    handful of numpy gathers rather than a Python loop over 4k states."""

    comp_next: np.ndarray
    prime_next: np.ndarray
    comp_gross: np.ndarray  # rebate value emitted on a composite mint (+ cash), GRAM
    prime_gross: float      # cash recovered on a prime mint, GRAM (SS5.1: no rebate)
    price: float
    pi: float
    start: int
    n_states: int


def _compile(m: ParrondoModel) -> _Chain:
    states, index = _state_space(m)
    return _Chain(
        comp_next=np.array([index[_after_composite(m, s)] for s in states], dtype=np.int64),
        prime_next=np.array([index[_after_prime(m, s)] for s in states], dtype=np.int64),
        comp_gross=np.array([m.composite_payoff(*s) + m.mint_price for s in states], dtype=np.float64),
        prime_gross=float(m.prime_payoff() + m.mint_price),
        price=float(m.mint_price),
        pi=float(m.pi_prime),
        start=index[initial_state(m)],
        n_states=len(states),
    )


def _solve(ch: _Chain, horizon: int, rho: float) -> tuple[float, np.ndarray, np.ndarray]:
    """Backward induction maximising expected `sum(gross - rho * spend)`.

    `rho = 1` is the plain net-GRAM objective. Sweeping `rho` turns the same solver
    into a ratio search (see `optimal_ratio`): the largest `rho` for which the
    optimum is still positive is the best GRAM-returned-per-GRAM-spent any policy
    achieves, which is the number a Parrondo comparison actually needs. Maximising
    net GRAM alone would not do -- with every action loss-making the net optimum
    degenerates to "never mint", which is true, uninteresting, and says nothing
    about how close the mixture gets to break-even.

    Returns (optimum at the start state, take-composite table, take-prime table),
    both tables indexed [t][state].
    """
    comp_r = ch.comp_gross - rho * ch.price
    prime_r = ch.prime_gross - rho * ch.price  # SS5.1: a prime mint emits nothing
    V = np.zeros(ch.n_states)
    take_c = np.empty((horizon, ch.n_states), dtype=bool)
    take_p = np.empty((horizon, ch.n_states), dtype=bool)
    for t in range(horizon - 1, -1, -1):
        c_val = comp_r + V[ch.comp_next]
        p_val = prime_r + V[ch.prime_next]
        tc = c_val > V
        tp = p_val > V
        take_c[t] = tc
        take_p[t] = tp
        V = ch.pi * np.where(tp, p_val, V) + (1.0 - ch.pi) * np.where(tc, c_val, V)
    return float(V[ch.start]), take_c, take_p


def _forward(ch: _Chain, take_c: np.ndarray, take_p: np.ndarray) -> dict:
    """Push the full state distribution forward under a policy table.

    Exact rather than sampled -- the state space is small enough to carry the whole
    distribution, so there is no Monte Carlo error to argue about.
    """
    horizon = take_c.shape[0]
    dist = np.zeros(ch.n_states)
    dist[ch.start] = 1.0
    spend = gross = n_prime = n_comp = 0.0

    for t in range(horizon):
        tc = take_c[t]
        tp = take_p[t]
        w_c = dist * (1.0 - ch.pi)
        w_p = dist * ch.pi
        minted_c = np.where(tc, w_c, 0.0)
        minted_p = np.where(tp, w_p, 0.0)

        n_comp += minted_c.sum()
        n_prime += minted_p.sum()
        spend += (minted_c.sum() + minted_p.sum()) * ch.price
        gross += float(minted_c @ ch.comp_gross) + minted_p.sum() * ch.prime_gross

        nxt = np.zeros(ch.n_states)
        nxt += np.where(tc, 0.0, w_c) + np.where(tp, 0.0, w_p)  # skipped mass stays put
        np.add.at(nxt, ch.comp_next, minted_c)
        np.add.at(nxt, ch.prime_next, minted_p)
        dist = nxt

    return {
        "spend_ton": float(spend),
        "return_ton": float(gross),
        "net_ton": float(gross - spend),
        "return_per_ton": (float(gross / spend) if spend > 0 else None),
        "prime_mints": float(n_prime),
        "composite_mints": float(n_comp),
    }


@dataclass
class DPResult:
    horizon: int
    optimal_net_ton: float
    optimal_spend_ton: float
    optimal_return_ton: float
    return_per_ton: float | None
    prime_mints_expected: float
    composite_mints_expected: float
    profitable: bool


def optimal_net_value(m: ParrondoModel, horizon: int = 400) -> DPResult:
    """The falsification test: the policy maximising expected net GRAM.

    At each opportunity nature offers a prime head with probability `pi_prime` and
    a composite head otherwise; the player then mints it or skips. Skipping is
    always available and scores exactly 0, so `optimal_net_ton <= 0` is the
    invariant under test and **any positive value is a live exploit**, not a
    warning.

    The forward pass is reported alongside so that "scored 0 by never minting" is
    distinguishable from "scored 0 by breaking even" -- only the second would be
    alarming, and the two are the same number.
    """
    ch = _compile(m)
    optimum, take_c, take_p = _solve(ch, horizon, rho=1.0)
    fwd = _forward(ch, take_c, take_p)
    return DPResult(
        horizon=horizon,
        optimal_net_ton=optimum,
        optimal_spend_ton=fwd["spend_ton"],
        optimal_return_ton=fwd["return_ton"],
        return_per_ton=fwd["return_per_ton"],
        prime_mints_expected=fwd["prime_mints"],
        composite_mints_expected=fwd["composite_mints"],
        profitable=optimum > 1e-12,
    )


def optimal_ratio(m: ParrondoModel, horizon: int = 400, iterations: int = 34) -> dict:
    """The best GRAM-returned-per-GRAM-spent achievable by ANY policy.

    Bisection on `rho`: `_solve` at a given `rho` asks "is there a policy whose
    gross beats `rho` times its spend?", and the all-skip policy pins the optimum
    at exactly 0 when the answer is no. So the crossing point is the maximal
    achievable ratio, found to ~1e-10 in 34 halvings of [0, 1.5].

    The upper bracket is deliberately above 1.0: if the true optimum were a
    profitable strategy the bisection must be able to report it rather than
    saturate at the safety threshold it is supposed to be testing.
    """
    ch = _compile(m)
    lo, hi = 0.0, 1.5
    best_c = best_p = None
    for _ in range(iterations):
        mid = 0.5 * (lo + hi)
        value, take_c, take_p = _solve(ch, horizon, rho=mid)
        if value > 1e-12:
            lo = mid
            best_c, best_p = take_c, take_p
        else:
            hi = mid
    if best_c is None:
        # No policy beats even rho = 0, i.e. nothing is ever minted. Only
        # reachable if the rebate is identically zero.
        return {"return_per_ton": 0.0, "spend_ton": 0.0, "degenerate": True}
    fwd = _forward(ch, best_c, best_p)
    fwd["ratio_bisection"] = lo
    fwd["degenerate"] = False
    return fwd


# --------------------------------------------------------------------------- #
# Question 3 -- the Parrondo signature
# --------------------------------------------------------------------------- #


def evaluate_fixed_policy(m: ParrondoModel, mint_composites: bool, mint_primes: bool, horizon: int = 400) -> dict:
    """A stationary policy that always/never plays each game.

    `(True, False)` is pure game A -- mint every composite, skip every prime.
    `(False, True)` is pure game B -- mint every prime, skip every composite.
    Skipping is free in this model, so pure A really does get a 100% composite
    diet rather than being diluted by the primes it declines.
    """
    ch = _compile(m)
    take_c = np.full((horizon, ch.n_states), bool(mint_composites))
    take_p = np.full((horizon, ch.n_states), bool(mint_primes))
    out = _forward(ch, take_c, take_p)
    out["mint_composites"] = bool(mint_composites)
    out["mint_primes"] = bool(mint_primes)
    return out


def parrondo_signature(m: ParrondoModel, horizon: int = 400) -> dict:
    """The paradox proper: does mixing the two games beat both of them pure?

    `signature_present` being true is NOT a failure. It says state-cycling pays,
    which the rank ladder is *designed* to do -- SS4.7.1 sells exactly that, and a
    player who mints a few primes to hold rank and then mints composites is playing
    the game as intended, not exploiting it.

    The failure condition is `exploit`: any policy returning more GRAM than it
    spends. Both are reported because the first is the early-warning signal for
    the second. The margin between the best mixed strategy and 1.0 is the only
    thing standing between "the rank ladder is a reward" and "the rank ladder is a
    money pump", and a future widening of the uplift table eats that margin
    directly. That number belongs in a report, not in someone's head.
    """
    pure_a = evaluate_fixed_policy(m, mint_composites=True, mint_primes=False, horizon=horizon)
    pure_b = evaluate_fixed_policy(m, mint_composites=False, mint_primes=True, horizon=horizon)
    both = evaluate_fixed_policy(m, mint_composites=True, mint_primes=True, horizon=horizon)
    best = optimal_ratio(m, horizon=horizon)
    net_opt = optimal_net_value(m, horizon=horizon)

    def per_ton(d: dict) -> float:
        r = d.get("return_per_ton")
        return float("-inf") if r is None else float(r)

    best_pure = max(per_ton(pure_a), per_ton(pure_b))
    mixed = per_ton(best)
    return {
        "n": m.n,
        "beta_composite": m.beta_composite,
        "recruit_rank_granted": m.recruit_rank,
        "prime_density": m.pi_prime,
        "horizon": horizon,
        "pure_A_composites_only": pure_a,
        "pure_B_primes_only": pure_b,
        "always_mint_both": both,
        "ratio_optimal": best,
        "net_optimal": {
            "net_ton": net_opt.optimal_net_ton,
            "spend_ton": net_opt.optimal_spend_ton,
            "return_per_ton": net_opt.return_per_ton,
        },
        "best_pure_return_per_ton": best_pure,
        "mixed_return_per_ton": mixed,
        # The Parrondo signature: the best mixture strictly beats both pure games.
        "signature_present": bool(mixed > best_pure + 1e-9),
        "signature_gain": mixed - best_pure,
        # The thing that must never be true.
        "exploit": bool(net_opt.profitable or mixed >= 1.0),
        "margin_to_break_even": 1.0 - mixed if mixed != float("-inf") else None,
    }


# --------------------------------------------------------------------------- #
# Scenario sweep
# --------------------------------------------------------------------------- #


def load_params(repo_root: Path | None = None) -> dict:
    """`shared/params.json` is the parameter authority (CLAUDE.md rule 3). Nothing
    in this module hardcodes an economic constant that lives there."""
    root = repo_root or Path(__file__).resolve().parents[2]
    with open(root / "shared" / "params.json", encoding="utf-8") as fh:
        return json.load(fh)


def model_from_params(
    params: dict,
    n: int,
    beta_composite: float,
    recruit_rank: int = 0,
    cash_recovered: float = 0.0,
) -> ParrondoModel:
    r = params["rebate"]
    up = econ.UpliftParams(
        k_ceil=r["K_CEIL"],
        prime_uplift=r["PRIME_UPLIFT"],
        prime_window=int(r["PRIME_WINDOW"]),
        newcomer_uplift=r["NEWCOMER_UPLIFT"],
        newcomer_window=int(r["NEWCOMER_WINDOW"]),
        recruit_rank_uplifts=tuple(r["recruit_rank_kmax_uplifts"]),
        prime_rank_uplifts=tuple(r["prime_rank_kmax_uplifts"]),
        recruit_rank_tiers=tuple(r["recruit_rank_tiers"]),
        prime_rank_tiers=tuple(r["prime_rank_tiers"]),
    )
    return ParrondoModel(
        n=n,
        k_min=r["k_min"],
        k_max_cap=r["k_max_cap"],
        n0_anchor=int(r["n0_anchor"]),
        uplifts=up,
        beta_composite=beta_composite,
        recruit_rank=recruit_rank,
        cash_recovered=cash_recovered,
        mint_price=params["mint"]["mint_price_ton"],
    )


# SS4.1's beta rows that a *composite* mint can actually produce, plus the 0.85
# ceiling granted for free (generosity note 3). A composite mint cannot reach
# 0.85 in reality -- its tribute line always resolves to someone -- so including
# it makes the sweep an over-approximation on purpose.
# The two `low` rows were the deleted patron line's phi1/phi2 corners (D-106) and
# are KEPT: this sweep is deliberately an over-approximation, and dropping rows
# would narrow the attacker's ground rather than widen it.
#
# Each row is (name, beta, cash_recovered). `self_sender_referred` is the one row
# with cash: a referred composite with the full invite line (TELEGRAM_INVITES_PLAN.md)
# leaves beta = 1 - .05 - gas & ops - .10 - .10 - 3 x 0.1 = 0.25 for the ratchet,
# and a minter that self-refers and sends all three invites to itself recovers
# 0.10 + 0.30 = 0.40 GRAM in cash on every mint. It is read from the split, not
# typed: `econ.beta(False, True, invite_count=INVITE_MAX_COUNT)` and
# `referral_pct + INVITE_MAX_COUNT * INVITE_TRANSFER_VALUE_TON`.
_SELF_SENDER_BETA = econ.beta(False, True, invite_count=econ.INVITE_MAX_COUNT)
_SELF_SENDER_CASH = econ.SplitParams().referral_pct + econ.INVITE_MAX_COUNT * econ.INVITE_TRANSFER_VALUE_TON
BETA_ROWS: tuple[tuple[str, float, float], ...] = (
    ("self_sender_referred", _SELF_SENDER_BETA, _SELF_SENDER_CASH),
    ("low_0_40", 0.40, 0.0),
    ("low_0_575", 0.575, 0.0),
    ("steady_state_referred", 0.65, 0.0),
    ("unreferred_composite", 0.75, 0.0),
    ("granted_ceiling", 0.85, 0.0),
)

# One representative n per decade. `k_max(n)` declines in n, so the low end is the
# attacker's best ground and the sweep must include it.
N_DECADES: tuple[int, ...] = (1_000, 10_000, 100_000, 1_000_000)


def scan(horizon: int = 400, params: dict | None = None) -> dict:
    """The full report: the closed-form bound and the finite-horizon search over
    every (decade, beta row, patron-rank grant) scenario.

    Nothing is sampled and nothing is truncated -- the returned `scenarios` list is
    the complete product, so a reader can check that no case was quietly dropped.
    """
    p = params or load_params()
    scenarios = []
    for n in N_DECADES:
        for beta_name, beta_value, cash in BETA_ROWS:
            for recruit_rank in (0, len(p["rebate"]["recruit_rank_kmax_uplifts"]) - 1):
                m = model_from_params(p, n=n, beta_composite=beta_value,
                                      recruit_rank=recruit_rank, cash_recovered=cash)
                row = parrondo_signature(m, horizon=horizon)
                row["beta_row"] = beta_name
                row["bound"] = asymptotic_bound(m)
                scenarios.append(row)

    exploits = [s for s in scenarios if s["exploit"]]
    signatures = [s for s in scenarios if s["signature_present"]]
    # "Worst" = the scenario where the attacker gets closest to break-even, which
    # is a max over the ratio-optimal policy since that policy dominates every
    # fixed one by construction.
    worst = max(scenarios, key=lambda s: s["mixed_return_per_ton"])
    widest = max(scenarios, key=lambda s: s["signature_gain"])
    return {
        "_what_this_measures": (
            "Emission-only GRAM returned per GRAM spent, over the SS4.7.1 rank / "
            "SS5.1 prime-window state machine. Tribute, dividends, referral income "
            "and the NFT itself are EXCLUDED -- this measures the ratchet's exposure, "
            "not whether the game is worth playing."
        ),
        "horizon_opportunities": horizon,
        "scenario_count": len(scenarios),
        "exploit_found": bool(exploits),
        "exploit_scenarios": exploits,
        "parrondo_signature_count": len(signatures),
        "worst_case": {
            "n": worst["n"],
            "beta_row": worst["beta_row"],
            "recruit_rank_granted": worst["recruit_rank_granted"],
            "mixed_return_per_ton": worst["mixed_return_per_ton"],
            "best_pure_return_per_ton": worst["best_pure_return_per_ton"],
            "margin_to_break_even": worst["margin_to_break_even"],
            "signature_present": worst["signature_present"],
        },
        "widest_signature": {
            "n": widest["n"],
            "beta_row": widest["beta_row"],
            "recruit_rank_granted": widest["recruit_rank_granted"],
            "signature_gain": widest["signature_gain"],
            "mixed_return_per_ton": widest["mixed_return_per_ton"],
            "best_pure_return_per_ton": widest["best_pure_return_per_ton"],
        },
        "scenarios": scenarios,
    }
