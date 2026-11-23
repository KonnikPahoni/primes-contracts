"""The unified market (D-16/D-20), modelled: the two lanes, their clearing
prices, and the three §11.26 numbers.

This module exists because **every model in `sim/` that predates `DECISIONS.md`
D-20 treats a prime as a head mint**, and D-20 deleted that. Under D-20:

  * the head is defined over **composites and Unity only**. After Unity (n=1)
    mints, primes 2 and 3 open in the market and **4** is the next number the
    head can build. A prime is never in the head's path and never stalls it.
  * every prime, from 2 onward, is bought from a `MODE_DUTCH_BUYNOW` lot whose
    price decays from `P0(p)` to **exactly `MINT_PRICE` = 1 GRAM** over
    `PRIME_DUTCH_SECONDS`, then rests on 1 GRAM forever. Buy-now, no expiry.
  * EVERY composite is auctioned on the **ascending** lane (D-30 dropped the
    `D(n) >= D_MIN` gate; there is no fee lane left), whose
    close **extends** on a late bid (D-8): a bid inside the final `N` minutes
    pushes the close out by `N`. **D-22 (signed, option 1): `open_lot` refuses
    primes**, so the ascending lane is composites only and a prime can never
    produce an ascending lot that has no settlement event. This module models
    exactly that: `evaluate_lane` sends every prime to `dutch_outcome` and
    every composite to `ascending_outcome`, and there is no path between them.
  * **D-7 premium routing:** the nominal 1 GRAM runs through the ordinary §4.1
    five-way split; 100% of the premium above it is credited to the ratchet as
    `pending`, with **no treasury cut**. `RES_GAS` is carved before the premium.
  * an **unsold** prime's tribute forfeits to the **treasury** (D-20 point 4),
    not to the pool and not to any NFT holder.

`H`, the Dutch lookahead, is **not** computed here and must not be added. D-20
point 3 retired `lookaheadH` outright — primes are never on the sequential line,
so there is nothing to look ahead of. (Verified 2026-08-17: no `H`/`lookaheadH`
symbol existed anywhere under `sim/`; nothing had to be deleted.)

--------------------------------------------------------------------------- #
THE PREMISES. Read these before any number this module produces.
--------------------------------------------------------------------------- #

No lot has ever cleared. Every quantity below therefore rests on a *stated*
premise about bidders, and the premises are swept rather than picked wherever
picking would be inventing an economic parameter (CLAUDE.md rule 3). The
discipline is the retired `newcomer_lever_sweep`'s: **bound the answer, name what
would make it decidable, and mark the result BOUNDED rather than SELECTED when
the sweep does not agree with itself.**

  P1 · VALUE OF THE NUMBER ITSELF — relative scarcity, measured not asserted,
      on a scale the repo already carries.
          V(n) = PLAIN_VALUE * (freq(plain) / freq(class(n))) ** GAMMA
      `class(n)` is the number's (top predicate, trailing zeros, digit length,
      year-window) cell and `freq` is that cell's **exhaustively measured**
      frequency. Scarcity-implied value is the standard anchor in the comparable
      markets §4.4 point 1a names (TON anonymous numbers, Telegram usernames)
      and it is computable in-repo; a *better* anchor would be realised prices
      from those markets, which this repo does not have. GAMMA is swept.
      **The scale is not invented.** `PLAIN_VALUE` is `E[u]` from
      `engine.PrimeHeadParams`'s existing hand-set `composite_accept_target` —
      the assumption that already says what an ordinary composite is worth to an
      arriving buyer — so it inherits the sensitivity sweep `run_phase1.py`
      already publishes instead of adding a new free parameter. An earlier
      version anchored on "a lot at `D_MIN` is worth `RESERVE_FLOOR`"; that was
      rejected as a free scale nobody has measured, and it collapsed ascending
      participation below 1% as an artifact of the anchor rather than as a
      property of the lane.

  P2 · WHAT A PRIME PAYS ON TOP — anchored on cash flow, and ADDITIVE.
      intrinsic(p) = NPV(p) + PRIME_UPLIFT credit + rights, exactly
      `Engine.prime_mint_value_ton`'s three terms, reused rather than
      re-invented. A buyer's willingness to pay for a prime is
      `V(n) + intrinsic(p)`: a prime is a number **and** a claim, not a claim
      instead of a number. The additive form is load-bearing — the multiplicative
      one concluded that a deep prime with negligible tribute NPV is worth less
      than an ordinary composite, which is false by inspection since a prime
      dominates a composite at the same price.

  P3 · BIDDER ARRIVAL — Poisson, rate uniform across lots.
      Interested bidders per lot ~ Poisson(LAMBDA). Uniform in `n` deliberately:
      making arrival scale with the score would let the price map buy its own
      demand and the premium estimate would be circular. LAMBDA is swept.

  P4 · VALUATION DISPERSION — lognormal, sigma = 0.90.
      Bidder i values the lot at V(n) * exp(SIGMA*Z - SIGMA^2/2), Z ~ N(0,1), so
      E[bidder value] = V(n) exactly and SIGMA moves only the spread. 0.90 is
      `PrimeHeadParams.sigma`, reused so the two models do not disagree about how
      spread out buyers are.

  P5 · ASCENDING MECHANICS — English auction, second-price-plus-increment.
      Bidders with value >= P0 participate. Zero participants: no sale, no
      premium. One participant: clears at P0. Two or more: clears at the
      second-highest value rounded up by one `MIN_INCREMENT`, capped at the
      highest value. This is the standard English/Japanese limit and it is the
      conservative reading — it never books the top bidder's full surplus.

  P6 · DUTCH MECHANICS — first arrival at or below the standing price takes it.
      Buyers arrive Poisson(LAMBDA_DUTCH per day) over an observation horizon.
      A buyer takes the lot the moment the standing price is at or below their
      value. Price decays linearly from P0(p) to 1 GRAM over
      PRIME_DUTCH_SECONDS and rests at 1 GRAM. "Unsold" means unsold **within
      the observation horizon**, which is a reporting window and not a claim
      that it is unsold forever — the lot has no expiry.

Nothing in this module fits a declared constant. `SCORE_HALVING`, `SCORE_MAX`,
`PRIME_P0_MULTIPLE`, `AUCTION_WINDOW`, `BID_EXTENSION` and
`PRIME_DUTCH_SECONDS` stay declared (`trophy_auction.TrophyConstants`), exactly
as `trophy_auction.py` says; `PRIME_P0_MIN` is deleted by D-99 and D-99's 33
score weights are declared too, in `shared/opcodes.ts`. `MIN_INCREMENT` has LEFT
that list: D-33 makes it a function of `D(n)` and a sim output, derived in
`acquisition.bid_increment_ladder`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict, replace

import numpy as np

from . import desirability as ds
from . import trophy_auction as ta

DAY = 86400.0

#: The window every census and every objective integral is taken over. Same
#: window `desirability.histogram` publishes, so the two are comparable term by
#: term rather than merely similar.
WINDOW_LO = ds.WINDOW_LO
WINDOW_HI = ds.WINDOW_HI

#: How a number LOOKS, ranked, for the value model only. This was the published
#: ordering of the pre-D-99 score's pattern predicates and D-21's constraint 3
#: made inverting it fatal; D-99 deletes that score and that constraint. What
#: survives is its other job: it decides which single predicate names a census
#: CELL, and the cell is the unit `composite_values` measures scarcity over.
#: It no longer prices anything -- `Cell.score` does.
PUBLISHED_PATTERN_ORDER = ("repdigit", "pow10", "trailing_zeros", "palindrome",
                           "run", "repeat")

# --------------------------------------------------------------------------- #
# The class census (P1) -- measured once, exhaustively
# --------------------------------------------------------------------------- #


def _predicate_masks(ns: np.ndarray) -> dict:
    """Boolean masks for every §4.4 point 1a predicate, over an int64 array.

    These are the pre-D-99 score's pattern predicates, kept for the ONE job that
    survived it: naming which census CELL a number lands in, so
    `composite_values` can measure that class's frequency. They score nothing --
    `Cell.score` carries `desirability.score(n)` and that is what prices a lot.
    """
    ns = ns.astype(np.int64)
    d = np.zeros_like(ns)
    p = np.ones_like(ns)
    for _ in range(19):
        d += (ns >= p).astype(np.int64)
        p = p * 10
    dmax = int(d.max())

    dig = np.zeros((dmax, ns.shape[0]), dtype=np.int64)
    for i in range(dmax):
        dig[dmax - 1 - i] = (ns // (10 ** i)) % 10
    lead = dmax - d

    def digit_at(i):
        idx = np.clip(lead + i, 0, dmax - 1)
        return dig[idx, np.arange(ns.shape[0])]

    idx0 = np.zeros_like(ns)
    first = digit_at(idx0)
    same = np.ones(ns.shape[0], dtype=bool)
    asc = np.ones(ns.shape[0], dtype=bool)
    desc = np.ones(ns.shape[0], dtype=bool)
    pali = np.ones(ns.shape[0], dtype=bool)
    abab = np.ones(ns.shape[0], dtype=bool)
    zeros_after_first = np.ones(ns.shape[0], dtype=bool)
    for i in range(1, dmax):
        ii = np.full(ns.shape[0], i, dtype=np.int64)
        cur, prev = digit_at(ii), digit_at(ii - 1)
        active = i < d
        same &= ~active | (cur == first)
        asc &= ~active | (cur == prev + 1)
        desc &= ~active | (cur == prev - 1)
        zeros_after_first &= ~active | (cur == 0)
        pali &= ~active | (cur == digit_at(d - 1 - ii))
        if i >= 2:
            abab &= ~active | (cur == digit_at(ii - 2))

    tz = np.zeros_like(ns)
    still = np.ones(ns.shape[0], dtype=bool)
    for k in range(1, dmax + 1):
        hit = still & ((ns % (10 ** k)) == 0)
        tz += hit.astype(np.int64)
        still &= hit

    aabb = ((d == 4) & (digit_at(idx0) == digit_at(idx0 + 1))
            & (digit_at(idx0 + 2) == digit_at(idx0 + 3))
            & (digit_at(idx0) != digit_at(idx0 + 2)))
    return {
        "d": d,
        "tz": np.minimum(tz, ds.W.TZ_CAP),
        "repdigit": (d >= 2) & same,
        "pow10": (d >= 2) & (first == 1) & zeros_after_first,
        "trailing_zeros": tz > 0,
        "palindrome": (d >= 2) & pali,
        "run": (d >= 3) & (asc | desc),
        "repeat": ((d >= 4) & (d % 2 == 0) & abab) | aabb,
        "year": (ns >= ds.YEAR_LO) & (ns <= ds.YEAR_HI),
    }


@dataclass(frozen=True)
class Cell:
    """One census cell: everything `D(n)` and `V(n)` depend on, and nothing else.

    `score` is `desirability.score(n)` -- **D-99's** additive score, carried on
    the cell rather than recomputed from the cell's own fields. Before D-99 the
    score WAS a function of `(top, tz, digits, year)`, so the cell determined it;
    the 33-category score is not, so the census key gained the score itself. The
    remaining fields survive because they are what the VALUE model
    (`composite_values`) measures scarcity over -- a classification of how a
    number looks, which is a different question from what the game charges for
    it.
    """

    top: str          # winning pattern predicate, or "plain"
    tz: int           # min(trailing zeros, TZ_CAP); only meaningful if top == trailing_zeros
    digits: int
    year: bool
    prime: bool
    score: int        # D(n), D-99 (desirability.score)


def class_census(lo: int = WINDOW_LO, hi: int = WINDOW_HI, *,
                 chunk: int = 1_000_000, with_primes: bool = True) -> dict:
    """Exhaustive `(top predicate, tz, digits, year, prime)` census over the window.

    Returns `{"cells": {Cell: count}, "count": N}`. The prime flag is carried
    because under D-20 primes are a **different lane with a different valuation
    anchor** (P2), so they must never be pooled into the composite frequency
    that P1 reads.
    """
    counts: dict[Cell, int] = {}
    total = 0
    score_sieve = ds.prime_sieve(ds.sieve_limit_for(hi))
    sieve = score_sieve if with_primes else None
    n_scores = ds.W.SCORE_MAX + 1
    for start in range(lo, hi, chunk):
        stop = min(start + chunk, hi)
        ns = np.arange(start, stop, dtype=np.int64)
        m = _predicate_masks(ns)
        top = np.full(ns.shape[0], len(PUBLISHED_PATTERN_ORDER), dtype=np.int64)
        for rank, name in enumerate(PUBLISHED_PATTERN_ORDER):
            top = np.where(m[name] & (top > rank), rank, top)
        prime = sieve[start:stop] if sieve is not None else np.zeros(ns.shape[0], bool)
        score = ds.scores_range(start, stop, sieve=score_sieve)
        key = ((((top * 10 + m["tz"]) * 20 + m["d"]) * 2
                + m["year"].astype(np.int64)) * 2 + prime.astype(np.int64)) \
            * n_scores + score
        vals, cnt = np.unique(key, return_counts=True)
        for v, c in zip(vals.tolist(), cnt.tolist()):
            rest, sc = divmod(v, n_scores)
            rest, pr = divmod(rest, 2)
            rest, yr = divmod(rest, 2)
            rest, dg = divmod(rest, 20)
            t, tz = divmod(rest, 10)
            name = (PUBLISHED_PATTERN_ORDER[t] if t < len(PUBLISHED_PATTERN_ORDER)
                    else "plain")
            cell = Cell(name, int(tz), int(dg), bool(yr), bool(pr), int(sc))
            counts[cell] = counts.get(cell, 0) + c
        total += stop - start
    return {"cells": counts, "count": total, "window": [lo, hi]}


# --------------------------------------------------------------------------- #
# Ground-truth value (P1, P2)
# --------------------------------------------------------------------------- #


def plain_composite_value_ton(*, composite_accept_target: float = 0.90,
                              typical_composite_k: float = 0.60,
                              sigma: float = 0.90,
                              beta: float = 0.65,
                              price_ton: float = 1.0) -> dict:
    """The value anchor, taken from an assumption the repo **already** carries.

    P1 needs a scale, and picking one would be inventing an economic parameter.
    It is not picked here: `engine.PrimeHeadParams` already carries a hand-set
    `composite_accept_target` -- *"what fraction of arrivals would accept an
    ordinary composite mint at the typical rebate"* -- and `Engine.__init__`
    already inverts it into a lognormal private valuation `u` with

        P(u >= 1 - typical_composite_k * beta) = composite_accept_target

    That inversion **is** the statement "what is a plain composite worth to an
    arriving buyer", stated in GRAM. So the anchor is `E[u]`, read off the same
    calibration, and it inherits the sensitivity sweep `run_phase1.py` already
    publishes over `composite_accept_target` instead of needing a new one.

    Using a fresh anchor -- "a lot at `D_MIN` is worth `RESERVE_FLOOR`" was the
    first thing tried -- was rejected: it is a free scale nobody has measured,
    it collapsed ascending participation to under 1%, and the collapse was an
    artifact of the anchor rather than a property of any weight vector.
    """
    from .engine import _norm_ppf

    thresh = max(price_ton - typical_composite_k * beta * price_ton, 1e-6)
    mu = math.log(thresh) + _norm_ppf(composite_accept_target) * sigma
    return {
        "mean_ton": math.exp(mu + sigma * sigma / 2.0),
        "median_ton": math.exp(mu),
        "mu": mu,
        "sigma": sigma,
        "acceptance_threshold_ton": thresh,
        "composite_accept_target": composite_accept_target,
        "_source": (
            "engine.PrimeHeadParams / Engine.__init__'s private-valuation "
            "calibration. NOT a new assumption: this is the existing hand-set "
            "one, read out in GRAM instead of left implicit."
        ),
    }


def composite_values(census: dict, *, gamma: float, plain_value_ton: float) -> dict:
    """P1: value **relative to a plain composite**, by measured class scarcity.

        V(cell) = PLAIN_VALUE * (freq(plain) / freq(cell)) ** gamma

    A plain composite is worth `PLAIN_VALUE` by construction, and every rarer
    class scales up by how much rarer it is -- measured exhaustively from the
    census, not asserted. `gamma` is the one free exponent and it is swept.

    Framing the scale as a **ratio to the plain cell** rather than as an
    absolute `V_UNIT` matters: it means the level comes entirely from the
    existing `composite_accept_target` calibration and the weights are compared
    against each other on a scale nobody had to choose.
    """
    cells = {c: n for c, n in census["cells"].items() if not c.prime}
    plain = {c: n for c, n in cells.items()
             if c.top == "plain" and not c.year}
    plain_freq = (sum(plain.values()) / len(plain)) if plain else 1.0
    value = {c: plain_value_ton * ((plain_freq / n) ** gamma) for c, n in cells.items()}
    return {
        "value_ton": value,
        "count": cells,
        "plain_reference_frequency": plain_freq,
        "plain_value_ton": plain_value_ton,
        "gamma": gamma,
        "calibration_note": (
            "V(cell) = PLAIN_VALUE * (freq(plain)/freq(cell))^gamma. PLAIN_VALUE "
            "is E[u] from the engine's existing composite-acceptance "
            "calibration; the frequencies are exhaustively measured over the "
            "census window; gamma is swept and never selected."
        ),
    }


def prime_intrinsic_ton(npv_ton: float, *, rights_value_ton: float,
                        prime_uplift_credit_ton: float) -> float:
    """P2: what a prime pays its buyer **over and above** being a number.

    Exactly `Engine.prime_mint_value_ton`'s three terms -- discounted forward
    tribute, the `PRIME_UPLIFT` credit, and naming + prime rank -- reused rather
    than re-invented. The buyer's total willingness to pay is this **plus** the
    private value of the number itself (P1), because a prime is a number *and* a
    claim, not a claim instead of a number. That additive form is what stops the
    model concluding that a deep prime with negligible tribute NPV is worth less
    than an ordinary composite, which was the first version's error.
    """
    return npv_ton + prime_uplift_credit_ton + rights_value_ton


# --------------------------------------------------------------------------- #
# Lane outcomes (P3-P6)
# --------------------------------------------------------------------------- #


def _poisson_matrix(rng, lam: float, draws: int) -> tuple[np.ndarray, np.ndarray]:
    """`(counts, active_mask)` for `draws` Poisson(lam) draws, as a rectangular
    `draws x K` mask. `K` is the 1-in-10^6 upper tail so truncation is never the
    thing that decides an answer."""
    counts = rng.poisson(lam, draws)
    k = int(max(counts.max(), 1))
    idx = np.arange(k)[None, :]
    return counts, idx < counts[:, None]


def ascending_outcome(p0_ton: float, value_ton: float, *, lam: float,
                      sigma: float, rng: np.random.Generator, draws: int,
                      increment_floor_ton: float,
                      increment_bps: int) -> dict:
    """P3-P5. Monte-Carlo one ascending lot's clearing price and participation.

    Vectorised: bidders that did not arrive, and bidders below `P0`, are both
    masked to `-inf` so the top-two order statistics fall out of one sort.

    Returns the sale probability and the mean clearing price both conditional on
    a sale and unconditional. The unconditional one is what the objective
    integrates, which is what makes the participation constraint bind on the
    objective rather than on a side report.
    """
    counts, active = _poisson_matrix(rng, lam, draws)
    if active.size == 0:
        return {"sale_probability": 0.0, "mean_clearing_if_sold_ton": 0.0,
                "mean_clearing_unconditional_ton": 0.0,
                "mean_rounds": 0.0}
    v = value_ton * np.exp(sigma * rng.standard_normal(active.shape) - sigma * sigma / 2.0)
    # D-30: opening the lot IS the first bid at P0, so a bidder whose value is
    # below P0 cannot participate at all -- the same mask as before, but now it
    # is the OPENER's constraint too and there is no cheaper lane to fall to.
    v = np.where(active & (v >= p0_ton), v, -np.inf)
    v = -np.sort(-v, axis=1)                       # descending
    top1 = v[:, 0]
    top2 = v[:, 1] if v.shape[1] > 1 else np.full(draws, -np.inf)
    sold = np.isfinite(top1)
    # --- the raise ladder, modelled exactly as the contract enforces it ------
    # D-33, `primes_market.tolk` `minIncrementOn`: a raise must clear
    # `high + max(floor, high * bps / 10^4)`, where `high` is the STANDING bid.
    # Under D-30 the opener's bid IS `P0`, so the minimum-raise walk visits
    # `g_0 = P0, g_{k+1} = g_k + max(floor, r * g_k)` -- arithmetic while the
    # floor binds, geometric once `g_k >= floor / r`. The runner-up's best
    # legal bid is the largest `g_k` at or below their value; if that is `g_0`
    # they cannot raise and the opener wins at `P0`.
    #
    # This truncation is the WHOLE trade the increment ladder resolves, and
    # getting it wrong destroys the trade: an earlier pass let the runner-up bid
    # `P0 + step` even when that exceeded their value, which made the clearing
    # price rise monotonically with the increment and told the sweep that the
    # largest step on the grid was always best. It is not -- a step larger than
    # the runner-up's surplus over `P0` prices them out entirely and the lot
    # clears at `P0`.
    r = increment_bps / 10_000.0
    h_star = increment_floor_ton / r
    k1 = max(math.ceil((h_star - p0_ton) / increment_floor_ton), 0)
    g_k1 = p0_ton + k1 * increment_floor_ton      # first walk point with r*g >= floor

    def walk_index(v):
        arith = np.floor(np.maximum(v - p0_ton, 0.0) / increment_floor_ton)
        geo = k1 + np.floor(np.log(np.maximum(v, g_k1) / g_k1) / math.log1p(r))
        return np.where(v < g_k1, arith, geo)

    def walk_point(k):
        return np.where(k <= k1, p0_ton + k * increment_floor_ton,
                        g_k1 * (1.0 + r) ** np.maximum(k - k1, 0.0))

    hi_for_step = np.where(np.isfinite(top2), top2, 0.0)
    m = walk_index(hi_for_step)
    can_raise = np.isfinite(top2) & (m >= 1.0)
    runner_bid = walk_point(m)
    next_bid = walk_point(m + 1.0)
    # The winner takes it one step above the runner-up when that is inside their
    # own value; otherwise they cannot legally raise and the runner-up wins at
    # their own last legal bid.
    clear = np.where(
        can_raise,
        np.where(next_bid <= top1, next_bid, runner_bid),
        p0_ton)
    clear = np.where(sold, clear, 0.0)
    rounds = np.where(can_raise, m + 1.0, np.where(sold, 1.0, 0.0))
    return {
        "sale_probability": float(sold.mean()),
        "mean_clearing_if_sold_ton": float(clear[sold].mean()) if sold.any() else 0.0,
        "mean_clearing_unconditional_ton": float(clear.mean()),
        "mean_rounds": float(rounds[sold].mean()) if sold.any() else 0.0,
    }


def dutch_outcome(p0_ton: float, value_ton: float, *, lam_per_day: float,
                  sigma: float, rng: np.random.Generator, draws: int,
                  decay_seconds: float, floor_ton: float,
                  observation_days: float) -> dict:
    """P4/P6. Monte-Carlo one descending prime lot, vectorised.

    The clock never expires: past `decay_seconds` the price rests on
    `floor_ton`. "Unsold" therefore means *unsold within the observation
    window*, and the window is reported next to the number.
    """
    decay_days = decay_seconds / DAY
    counts, active = _poisson_matrix(rng, lam_per_day * observation_days, draws)
    if active.size == 0:
        return {"sale_probability": 0.0, "mean_clearing_if_sold_ton": 0.0,
                "mean_clearing_unconditional_ton": 0.0,
                "mean_days_to_sale": None, "observation_days": observation_days}
    ts = np.sort(np.where(active, rng.uniform(0.0, observation_days, active.shape),
                          np.inf), axis=1)
    vs = value_ton * np.exp(sigma * rng.standard_normal(ts.shape) - sigma * sigma / 2.0)
    price = np.where(ts >= decay_days, floor_ton,
                     p0_ton - (p0_ton - floor_ton) * np.minimum(ts, decay_days) / decay_days)
    takes = np.isfinite(ts) & (vs >= price)
    any_take = takes.any(axis=1)
    first = np.argmax(takes, axis=1)
    rows = np.arange(ts.shape[0])
    clear = np.where(any_take, price[rows, first], 0.0)
    t_sale = np.where(any_take, ts[rows, first], np.nan)
    return {
        "sale_probability": float(any_take.mean()),
        "mean_clearing_if_sold_ton": float(clear[any_take].mean()) if any_take.any() else 0.0,
        "mean_clearing_unconditional_ton": float(clear.mean()),
        "mean_days_to_sale": (float(np.nanmean(t_sale)) if any_take.any() else None),
        "observation_days": observation_days,
    }


# --------------------------------------------------------------------------- #
# The signed objective (D-21 / Q25)
# --------------------------------------------------------------------------- #


@dataclass
class ObjectivePremises:
    """Every premise the objective is evaluated under, in one reviewable object.

    None of these is a shipped parameter: they are the sweep axes, and
    `run_determinations.py` reports across them rather than at a point. (The
    weight search these premises used to select a vector under is deleted by
    D-99 -- the weights are owner-declared now -- but every premise below is
    still what the lane model and the D-33 bid-increment ladder are evaluated
    under.)
    """

    #: P1. The scarcity exponent. The ONE free exponent in the value model and
    #: the reason `run_determinations.py` sweeps rather than reports a point.
    gamma: float = 0.5
    #: P1's scale, inherited from `engine.PrimeHeadParams.composite_accept_target`
    #: via `plain_composite_value_ton` -- not a new assumption.
    composite_accept_target: float = 0.90
    typical_composite_k: float = 0.60
    #: P2's two non-cash terms, both taken verbatim from `PrimeHeadParams`.
    rights_value_ton: float = 0.05
    prime_uplift_credit_ton: float = 0.195     # min(PRIME_UPLIFT, headroom)*WINDOW*beta
    #: P3. Interested bidders per composite lot, and buyer arrivals per day on a
    #: prime lot. Uniform in `n` deliberately (see the module header).
    lam_ascending: float = 2.0
    lam_dutch_per_day: float = 0.30
    #: P4. The private-valuation dispersion. Same 0.90 the engine's prime-head
    #: model uses, so the two do not disagree about how spread out buyers are.
    sigma: float = 0.90
    observation_days: float = 90.0     # P6 reporting window for "unsold"
    draws: int = 400                   # MC draws per cell
    #: DECLARED, and the owner is asked to confirm it: a **majority** of opened
    #: lots must find a buyer inside the observation window. Justification in
    #: `run_determinations.py`'s report block -- below one half, the modal
    #: outcome of opening a lot is that it does not sell, and a lane whose modal
    #: outcome is failure cannot honestly be described as price discovery on a
    #: public surface (§9.1). It is not derived and is not dressed as derived.
    participation_threshold: float = 0.50
    #: Constraint 2's operative cap under D-30: the largest MEAN `P0(n)` over
    #: the composite line the price map may produce, in GRAM. `None` means
    #: unconstrained: the search that used to resolve it against the incumbent's
    #: own mean is deleted with the weight vector (D-99).
    #:
    #: Why this and not the old auctioned-share cap: D-30 deletes the fee lane,
    #: so every composite is auctioned and the share is 1 for every vector --
    #: the old measure has no variance left in it. The constraint's stated
    #: purpose is *"the ladder prices earliness; if it prices it so highly that
    #: players wait instead"*, and with every composite carrying a `P0` that is
    #: measurable directly. The cap is relative to the incumbent rather than to
    #: the literal flat-fee baseline for the same reason as before: under the
    #: flat fee nothing was auctioned, so a literal reading kills every vector
    #: including the shipped design.
    max_mean_p0_ton: float | None = None
    seed: int = 20260817


def _p0_for_cell(cell: Cell, npv_ton: float | None,
                 c: ta.TrophyConstants) -> float:
    return ta.p0_nanoton(cell.score, prime=cell.prime, npv_ton=npv_ton,
                         c=c) / ta.NANO


def cell_of(n: int) -> Cell:
    """The census cell of a single `n` -- the scalar twin of `class_census`.

    Built by running the census's OWN vectorised classifier over a one-element
    array rather than by a second scalar copy of the same predicates: the two
    forms disagreeing is precisely the bug `test_cell_of_agrees_with_the_census`
    used to have to catch, and there is now only one form.
    """
    m = _predicate_masks(np.array([n], dtype=np.int64))
    top = "plain"
    for name in PUBLISHED_PATTERN_ORDER:
        if bool(m[name][0]):
            top = name
            break
    return Cell(top, int(m["tz"][0]), len(str(n)), bool(m["year"][0]),
                ta.is_prime(n), ds.score(n))


def _sig(x: float, digits: int = 2) -> float:
    if x <= 0:
        return 0.0
    m = 10 ** (digits - 1 - math.floor(math.log10(x)))
    return round(x * m) / m


def prime_lot_groups(prime_npv: dict) -> dict:
    """Group in-range primes by `(score, NPV to 2 significant figures)`.

    Tens of thousands of primes cannot each get their own Monte-Carlo run inside
    a coordinate ascent, and they do not need one: `P0(p)` depends on the prime
    only through `D(p)` and `NPV(p)`, so two primes agreeing on both are the same
    lot. The grouping is exact in `D` and rounded in `NPV`; the rounding is to
    two significant figures, which moves `P0` by at most 0.5% on the NPV branch
    and not at all on the `PRIME_P0_MIN` or ladder branches.
    """
    groups: dict[tuple[Cell, float], int] = {}
    for p, npv in prime_npv.items():
        key = (cell_of(p), _sig(npv))
        groups[key] = groups.get(key, 0) + 1
    return groups


def evaluate_lane(census: dict, prime_npv: dict,
                  prem: ObjectivePremises, *,
                  res_gas_ton: float, increment_ladder: dict,
                  c: ta.TrophyConstants = ta.C) -> dict:
    """The lane's expected premium and its constraint margins.

    **RENAMED from `evaluate_weights` by D-99.** There is no weight vector left
    to evaluate: the 33 category weights are owner-declared and `D(n)` rides on
    the census cell, so this function measures one MECHANIC (the two lanes under
    one price map) rather than one candidate parameterisation of it. D-21's
    constraint 3 -- *the published ordering of the pattern predicates must not
    invert* -- is deleted with the search it constrained; the ordering it
    protected was a property of a four-layer max-score that no longer exists.

    **The population is a head range, not the whole number line.** Under D-20 a
    prime lot opens only when every composite below it has been built, so the
    lots that exist over a horizon are exactly the primes and threshold
    composites inside the range the head covers in that horizon. Integrating over
    the whole 10^2..10^7 window instead would count hundreds of thousands of
    prime lots that will not open for decades, and would make "per unit of head
    progress" mean nothing.

    **PRIMARY** -- expected premium captured to the ratchet across the whole
    auction lane, per unit of head progress. Head progress is measured in
    **composites**, because D-20 defines the head over composites and Unity: one
    unit of head progress is one composite built. Premium per lot is
    `clearing - MINT_PRICE - RES_GAS`, floored at zero (D-7: the nominal 1 GRAM
    goes through the ordinary five-way split and `RES_GAS` is carved before the
    premium; there is no treasury cut on premium).

    **CONSTRAINT 1 -- lane participation, RESTATED UNDER D-30.** D-21 words it as
    *the share of lots that receive a bid or sell above the floor*, and its
    stated purpose is that a lane whose modal outcome is failure cannot honestly
    be called price discovery. Under D-30 **opening a lot IS a paid first bid**,
    so a composite lot only comes into existence when a buyer at or above `P0`
    exists, and *"if nobody outbids the opener, the opener wins at `P0(n)`"* --
    **every opened composite lot sells, by construction.** The population the
    constraint ranges over is therefore opened lots, and the composite lane
    contributes only through how many lots open at all.

    What does NOT collapse is the prime lane: a prime lot exists from its turn
    whether or not anyone wants it, an unsold one forfeits tribute (D-20 point
    4), and that is a real failure. So the reported participation is
    `(prime lots sold + composite lots opened) / (prime lots + composite lots
    opened)` -- the prime lane's genuine sale rate, diluted by a composite lane
    that cannot fail once a lot exists.

    The share of the composite line that attracts an opener at all is reported
    separately as `open_rate_of_composite_line`. It is a **diagnostic, not a
    constraint**: a number nobody opens produces no lot, no locked capital, no
    forfeit and no state, so a low open rate is the lane declining to price
    something rather than the lane failing. Treating it as a constraint would
    import a failure mode D-30 removed.

    **CONSTRAINT 2 -- head velocity not reduced, RE-AIMED under D-30.** The old
    measure was the share of the composite line pushed off the fee lane onto the
    auction lane. D-30 deletes the fee lane, so that share is **1 for every
    vector** and the constraint would be vacuous if it were left as it was. The
    quantity it was standing in for survives: what the constraint forbids is a
    retune that makes being early systematically more expensive, because a
    buyer priced out of the lane waits for the head instead. Under D-30 that is
    measured directly -- **the mean `P0(n)` over the whole composite line** --
    which is measurable precisely because every composite now has a `P0`. The
    cap survives as a premise (`ObjectivePremises.max_mean_p0_ton`) even though
    the search that used it is gone -- it is what a future mechanic change is
    measured against.

    """
    rng = np.random.default_rng(prem.seed)
    anchor = plain_composite_value_ton(
        composite_accept_target=prem.composite_accept_target,
        typical_composite_k=prem.typical_composite_k, sigma=prem.sigma)
    comp = composite_values(census, gamma=prem.gamma,
                            plain_value_ton=anchor["mean_ton"])

    def value_of(cell: Cell) -> float:
        """The private value of the *number*, for a prime or a composite alike."""
        if cell in comp["value_ton"]:
            return comp["value_ton"][cell]
        return comp["value_ton"].get(replace(cell, prime=False),
                                     anchor["mean_ton"])

    premium_total = 0.0
    lots = 0
    sold_lots = 0.0
    composites = 0
    composite_lots = 0
    composite_opened = 0.0
    composite_p0_total = 0.0
    prime_sold = 0.0
    prime_lots_n = 0
    prime_unsold = 0.0
    by_band: dict[str, dict] = {}

    def book(band, count, sale_p, ppl, days_to_sale=None):
        b = by_band.setdefault(band, {"lots": 0, "premium_ton": 0.0, "sold": 0.0,
                                      "sold_days": 0.0})
        b["lots"] += count
        b["premium_ton"] += count * ppl
        b["sold"] += count * sale_p
        # V26.2: sale-weighted days a sold lot stays open (Dutch lane only).
        b["sold_days"] += count * sale_p * (days_to_sale or 0.0)

    # ---- descending prime lane (D-20) ---------------------------------- #
    for (cell, npv), count in prime_lot_groups(prime_npv).items():
        d = cell.score
        p0 = ta.p0_nanoton(d, prime=True, npv_ton=npv if npv > 0 else None,
                           c=c) / ta.NANO
        # P1 + P2, additive: a prime is a number AND a claim.
        value = value_of(cell) + prime_intrinsic_ton(
            npv, rights_value_ton=prem.rights_value_ton,
            prime_uplift_credit_ton=prem.prime_uplift_credit_ton)
        out = dutch_outcome(p0, value,
                            lam_per_day=prem.lam_dutch_per_day, sigma=prem.sigma,
                            rng=rng, draws=prem.draws,
                            decay_seconds=c.AUCTION_WINDOW_SECONDS,
                            floor_ton=ta.MINT_PRICE_TON,
                            observation_days=prem.observation_days)
        ppl = max(out["mean_clearing_unconditional_ton"]
                  - (ta.MINT_PRICE_TON + res_gas_ton) * out["sale_probability"], 0.0)
        premium_total += count * ppl
        lots += count
        prime_lots_n += count
        prime_sold += count * out["sale_probability"]
        sold_lots += count * out["sale_probability"]
        prime_unsold += count * (1.0 - out["sale_probability"])
        book("prime_dutch", count, out["sale_probability"], ppl,
             out["mean_days_to_sale"])

    # ---- ascending composite lane -------------------------------------- #
    for cell, count in census["cells"].items():
        if cell.prime:
            continue
        composites += count
        d = cell.score
        # D-30: NO LANE GATE. Every composite in the window may be opened as an
        # ascending lot; the `d < D_MIN -> fee lane, no lot` branch that used to
        # sit here is deleted with the fee lane it belonged to.
        p0 = _p0_for_cell(cell, None, c)
        composite_p0_total += count * p0
        # D-33: the band's step, as the contract reads it (`incrementBpsAt`).
        rung = min(d // c.SCORE_HALVING, len(increment_ladder["min_increment_bps"]) - 1)
        out = ascending_outcome(
            p0, value_of(cell), lam=prem.lam_ascending, sigma=prem.sigma,
            rng=rng, draws=prem.draws,
            increment_floor_ton=increment_ladder["min_increment_floor_ton"],
            increment_bps=increment_ladder["min_increment_bps"][rung])
        ppl = max(out["mean_clearing_unconditional_ton"]
                  - (ta.MINT_PRICE_TON + res_gas_ton) * out["sale_probability"], 0.0)
        premium_total += count * ppl
        lots += count
        composite_lots += count
        # `sale_probability` here IS the probability the lot OPENS: it is
        # P(at least one bidder values it at or above P0), and under D-30 that
        # bidder is the opener. Every lot that opens sells.
        composite_opened += count * out["sale_probability"]
        sold_lots += count * out["sale_probability"]
        book("D%d-%d" % ((d // 10) * 10, (d // 10) * 10 + 9), count,
             out["sale_probability"], ppl)

    # Participation over the lots that EXIST: every prime lot, plus the
    # composite lots that opened. See the constraint 1 note above.
    existing = prime_lots_n + composite_opened
    participation = ((prime_sold + composite_opened) / existing) if existing else 0.0
    open_rate = (composite_opened / composite_lots) if composite_lots else 0.0
    mean_p0 = (composite_p0_total / composites) if composites else 0.0
    return {
        "constraint_2_mean_p0_composite_ton": mean_p0,
        "open_rate_of_composite_line": open_rate,
        "_open_rate_note": (
            "DIAGNOSTIC, NOT A CONSTRAINT. Share of the composite line that "
            "attracts at least one buyer at or above P0, i.e. the share that "
            "gets opened as a lot at all. A number nobody opens produces no "
            "lot, no locked capital, no forfeit and no state, so a low open "
            "rate is the lane declining to price something rather than the lane "
            "failing. Under the deleted D_MIN gate this figure was ~0.95 "
            "because the population was the rare tail; over the whole composite "
            "line it is much lower, and that change is expected rather than a "
            "regression."
        ),
        "composite_lots_opened": composite_opened,
        "prime_lots_sold": prime_sold,
        "objective_premium_per_head_mint_ton": (premium_total / composites) if composites else 0.0,
        "premium_total_ton": premium_total,
        "lots": lots,
        "prime_lots": lots - composite_lots,
        "composite_lots": composite_lots,
        "head_progress_composites": composites,
        "constraint_1_participation": participation,
        "constraint_1_threshold": prem.participation_threshold,
        "constraint_1_margin": participation - prem.participation_threshold,
        "_constraint_1_note": (
            "Population = lots that EXIST: every prime lot (one per prime from "
            "its turn, whether or not anyone wants it) plus the composite lots "
            "that opened. Under D-30 opening a composite lot is a paid first "
            "bid and an unchallenged opener wins at P0, so every opened "
            "composite lot sells and the composite lane cannot fail this "
            "constraint. What can still fail it is the PRIME lane, whose unsold "
            "lots forfeit tribute to the treasury (D-20 point 4) -- so the "
            "constraint has not become vacuous, it has become a test of the "
            "prime lane diluted by a composite lane that is structurally safe."
        ),
        "constraint_2_auctioned_share_of_composite_line": (
            composite_lots / composites) if composites else 0.0,
        "constraint_2_cap": prem.max_mean_p0_ton,
        "constraint_2_margin": (
            None if prem.max_mean_p0_ton is None
            else prem.max_mean_p0_ton - mean_p0),
        "expected_unsold_prime_lots": prime_unsold,
        "by_band": {k: {**v, "premium_per_lot_ton": v["premium_ton"] / v["lots"],
                        "sale_rate": v["sold"] / v["lots"],
                        "mean_days_to_sale": (v["sold_days"] / v["sold"]
                                              if v["sold"] and v["sold_days"] else None)}
                    for k, v in sorted(by_band.items())},
    }


def mean_lot_open_days(*, lam_late_per_hour: float, max_bidders: int,
                       draws: int = 200_000, seed: int = 20260817,
                       c: ta.TrophyConstants = ta.C) -> float:
    """Mean total open life of an ascending lot under D-8's extending close.

    The lot runs `AUCTION_WINDOW` and then extends by `BID_EXTENSION` for as
    long as late bids keep arriving (Poisson(lam_late * BID_EXTENSION) per
    round), bounded by `max_bidders`. This is the piece of the retired
    head-collision model (D-45) that `acquisition.open_lot_volume` still
    needs -- how long a lot stays open -- with the collision/distance question
    itself gone, since the ledger removes a composite from its sequential line
    the instant the lot opens and there is no longer anything for the head to
    collide with.
    """
    rng = np.random.default_rng(seed)
    e_hours = c.BID_EXTENSION_SECONDS / 3600.0
    p_round = 1.0 - math.exp(-lam_late_per_hour * e_hours)
    u = rng.random(draws)
    rounds = np.floor(np.log(1.0 - u) / np.log(p_round)) if p_round > 0 else np.zeros(draws)
    rounds = np.minimum(rounds, max_bidders)
    total_days = c.AUCTION_WINDOW_SECONDS / DAY + rounds * c.BID_EXTENSION_SECONDS / DAY
    return float(total_days.mean())


# --------------------------------------------------------------------------- #
# Q26 item 3 -- the unsold-prime tribute forfeit (D-20 point 4)
# --------------------------------------------------------------------------- #


def _norm_sf(x: np.ndarray) -> np.ndarray:
    """Standard normal survival function, vectorised (Abramowitz-Stegun 7.1.26,
    |error| < 1.5e-7). scipy is not a dependency of this package."""
    z = np.abs(x) / math.sqrt(2.0)
    t = 1.0 / (1.0 + 0.3275911 * z)
    erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (
        -1.453152027 + t * 1.061405429)))) * np.exp(-z * z)
    return np.where(x >= 0, 0.5 * erfc, 1.0 - 0.5 * erfc)


def prime_prefunding_displacement(*, npv_by_prime: dict, census: dict,
                                  prem: ObjectivePremises,
                                  head_range: tuple[int, int],
                                  mints_per_day: float,
                                  carry_rate_annual: float,
                                  p0_multiples=(1.0, 1.5, 2.0, 3.0, 5.0),
                                  grid: int = 96,
                                  c: ta.TrophyConstants = ta.C) -> dict:
    """§11.26 as re-scoped 2026-09-24: what fraction of primes are bought AHEAD
    of the head (D-88 point 3's ascending lot at `P0(p)`) rather than at their
    own turn (the descending lot), and how the `P0` level moves it.

    **The lane-aware buyer.** An interested buyer of prime `p` arrives while `p`
    is still ahead of the head, `tau` days before its turn, with the same private
    value `v` the lane model uses (P1 + P2, lognormal P4). They compare:

      * **open now:** surplus `v - P0`, paid `tau` days early, so it costs the
        carry `P0 * (e^(r*tau) - 1)` -- a prime earns no tribute before the head
        passes it (tribute comes from composites above `p`, minted at the head),
        so owning early buys nothing but certainty;
      * **wait for the turn:** the descending lot OPENS at the same `P0(p)`, so
        waiting keeps the same surplus unless a rival takes the lot first. Rivals
        valuing it at `P0` or more arrive Poisson at `lam * s` per day (`s` =
        P(value >= P0)), so the waiting surplus is `(v - P0) * e^(-lam*s*tau)`.

    It opens iff `(v - P0) * (1 - e^(-lam*s*tau)) > P0 * (e^(r*tau) - 1)`. Both
    simplifications push displacement UP (conservative): opening ignores rivals
    who contest the ascending lot, and waiting ignores the chance of buying below
    `P0` as the lot decays. Arrivals are Poisson and decisions independent, so the
    number of openers before the turn is Poisson with mean `lam * integral q(tau)`
    and `P(displaced) = 1 - exp(-lam * integral q)` -- exact, no Monte-Carlo.

    The **lane-unaware bound** is the composite lane's own rule (every buyer with
    `v >= P0` opens): `1 - exp(-lam * s * tau_p)`.
    """
    lo, hi = head_range
    r = carry_rate_annual / 365.0
    lam = prem.lam_dutch_per_day
    anchor = plain_composite_value_ton(
        composite_accept_target=prem.composite_accept_target,
        typical_composite_k=prem.typical_composite_k, sigma=prem.sigma)
    comp = composite_values(census, gamma=prem.gamma,
                            plain_value_ton=anchor["mean_ton"])
    primes = sorted(p for p in npv_by_prime if lo <= p < hi)
    if not primes:
        return {"primes_considered": 0}
    V, P0, TAU, NPVB = [], [], [], []
    for i, p in enumerate(primes):
        npv = npv_by_prime[p]
        cell = cell_of(p)
        p0n = ta.p0_nanoton(cell.score, prime=True, npv_ton=npv, c=c)
        P0.append(p0n / ta.NANO)
        NPVB.append(round(c.PRIME_P0_MULTIPLE * npv * ta.NANO) == p0n)   # 1.5*NPV branch binds
        V.append(comp["value_ton"].get(replace(cell, prime=False), anchor["mean_ton"])
                 + prime_intrinsic_ton(npv, rights_value_ton=prem.rights_value_ton,
                                       prime_uplift_credit_ton=prem.prime_uplift_credit_ton))
        # Days until the head reaches p: composites strictly between lo and p,
        # at the engine's realised composite velocity.
        TAU.append(((p - lo) - i) / mints_per_day)
    V, P0, TAU, NPVB = map(np.asarray, (V, P0, TAU, NPVB))
    sig = prem.sigma
    frac = (np.arange(grid) + 0.5) / grid          # midpoint rule over [0, tau_p]

    rows = {}
    for m in p0_multiples:
        p0 = P0 * m
        s = _norm_sf((np.log(p0 / V) + sig * sig / 2) / sig)   # P(v >= P0)
        tau = TAU[:, None] * frac[None, :]
        contest = -np.expm1(-lam * s[:, None] * tau)
        v_star = p0[:, None] * (1.0 + np.expm1(r * tau) / np.maximum(contest, 1e-300))
        q = _norm_sf((np.log(v_star / V[:, None]) + sig * sig / 2) / sig)
        disp = -np.expm1(-lam * q.mean(axis=1) * TAU)
        unaware = -np.expm1(-lam * s * TAU)
        rows[f"p0_x{m}"] = {
            "p0_multiple": m,
            "displaced_share": round(float(disp.mean()), 4),
            "displaced_primes": round(float(disp.sum()), 1),
            "displaced_share_npv_priced": round(float(disp[NPVB].mean()), 4) if NPVB.any() else None,
            "displaced_share_floor_or_ladder_priced": round(float(disp[~NPVB].mean()), 4) if (~NPVB).any() else None,
            "lane_unaware_upper_bound_share": round(float(unaware.mean()), 4),
            "mean_p0_ton": round(float(p0.mean()), 4),
        }
    return {
        "head_range": [lo, hi],
        "primes_considered": len(primes),
        "primes_npv_priced": int(NPVB.sum()),
        "lam_per_day": lam,
        "carry_rate_annual": carry_rate_annual,
        "mints_per_day": round(mints_per_day, 3),
        "mean_days_ahead_of_head": round(float(TAU.mean()), 1),
        "by_p0_multiple": rows,
    }


def unsold_prime_forfeit(*, npv_by_prime: dict, census: dict,
                         prem: ObjectivePremises,
                         head_range: tuple[int, int], mints_per_day: float,
                         res_gas_ton: float, c: ta.TrophyConstants = ta.C,
                         draws: int | None = None,
                         seed: int = 20260817) -> dict:
    """What §12's revenue risk is now accepted against.

    Two quantities, and they are different: the share of prime lots still
    resting on their 1 GRAM floor at the end of the observation window, and the
    **tribute those lots forfeit to the treasury while they sit** (D-20 point 4).

    Tribute accrual while unsold is priced off the prime's own `NPV(p)` — the
    same analytic stream `trophy_auction.npv_ladder` publishes — pro-rated over
    the days it sits unowned. That is an approximation and it is stated: NPV is
    a discounted infinite-horizon figure, so pro-rating its first year over the
    unsold days slightly OVERSTATES the early accrual (tribute is front-loaded
    in `n`, not flat), which is the conservative direction for a forfeit total.
    """
    rng = np.random.default_rng(seed)
    lo, hi = head_range
    draws = draws or prem.draws
    anchor = plain_composite_value_ton(
        composite_accept_target=prem.composite_accept_target,
        typical_composite_k=prem.typical_composite_k, sigma=prem.sigma)
    comp = composite_values(census, gamma=prem.gamma,
                            plain_value_ton=anchor["mean_ton"])
    rows = []
    total_forfeit = 0.0
    unsold = 0.0
    considered = 0
    for p, npv in sorted(npv_by_prime.items()):
        if not (lo <= p < hi):
            continue
        considered += 1
        cell = cell_of(p)
        d = cell.score
        p0 = ta.p0_nanoton(d, prime=True, npv_ton=npv, c=c) / ta.NANO
        # Same additive willingness-to-pay as `evaluate_lane` (P1 + P2): the
        # private value of the number plus what the prime pays on top. Using a
        # different one here would let the forfeit total and the clearing
        # distribution disagree about the same lot.
        v = comp["value_ton"].get(replace(cell, prime=False), anchor["mean_ton"]) \
            + prime_intrinsic_ton(npv, rights_value_ton=prem.rights_value_ton,
                                  prime_uplift_credit_ton=prem.prime_uplift_credit_ton)
        out = dutch_outcome(p0, v, lam_per_day=prem.lam_dutch_per_day,
                            sigma=prem.sigma, rng=rng, draws=draws,
                            decay_seconds=c.AUCTION_WINDOW_SECONDS,
                            floor_ton=ta.MINT_PRICE_TON,
                            observation_days=prem.observation_days)
        p_unsold = 1.0 - out["sale_probability"]
        days_unowned = (out["mean_days_to_sale"] or prem.observation_days) \
            * out["sale_probability"] + prem.observation_days * p_unsold
        # first-year tribute rate implied by the NPV, pro-rated over days unowned
        forfeit = npv * min(days_unowned / 365.0, 1.0)
        total_forfeit += forfeit
        unsold += p_unsold
        rows.append({
            "p": p, "score": d, "p0_ton": round(p0, 4), "npv_ton": round(npv, 4),
            "sale_probability": round(out["sale_probability"], 4),
            "mean_days_to_sale": out["mean_days_to_sale"],
            "mean_clearing_if_sold_ton": round(out["mean_clearing_if_sold_ton"], 4),
            "forfeited_tribute_ton": round(forfeit, 5),
        })
    return {
        "_destination": "treasury (DECISIONS.md D-20 point 4), not the pool and not any item",
        "head_range": [lo, hi],
        "primes_considered": considered,
        "observation_days": prem.observation_days,
        "expected_unsold_lots_at_window_end": round(unsold, 2),
        "expected_unsold_share": round(unsold / considered, 4) if considered else None,
        "expected_forfeited_tribute_ton": round(total_forfeit, 4),
        "expected_forfeited_tribute_ton_per_prime": (
            round(total_forfeit / considered, 5) if considered else None),
        "mints_per_day_assumed": mints_per_day,
        "rows": rows[:200],
        "_rows_note": "first 200 primes in range; the totals are over all of them",
        "_approximation": (
            "Tribute forfeited is priced as NPV(p) pro-rated over the days the lot "
            "sits unowned. NPV is a discounted infinite-horizon stream, so this "
            "OVERSTATES a single early year -- conservative for a forfeit total, "
            "and stated rather than absorbed."
        ),
    }
