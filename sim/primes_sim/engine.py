"""Discrete-event simulation engine for CONCEPT.md **design draft v5**
(UPGRADE_PLAN_V5.md Phase A).

State tracked: T, S, pending, swapped, AMM pool (xy=k, `amm_fee`), NFT
ownership map, the `owed` divisor-tribute ledger, the `div_acc` flat-dividend
accumulator with per-prime `entry[p]` stamps, both rank ladders, the prime and
newcomer credit windows, and the k(t) clock. (The reservation book (D-30/D-90)
and the genesis K-lot auction (D-20) are deleted designs and are not modelled.)

Four v5 mechanics that did not exist in the v4 engine:

  * divisor tribute weighted `e*sqrt(p)` and split 80/20 against a flat prime
    dividend (SS3.2);
  * `k = 0` on every prime mint, with the whole tribute line falling to the
    pool (SS4.1, SS5.1);
  * the **prime head as a first-class object** -- an arrival at a prime head
    may decline, which parks the head and is the only way the model can see
    SS12's highest-severity risk (SS10);
  * the **floor guard** on `flush()`: a fill requires
    `primes_out >= amount * S/T * (1+FLOOR_GUARD)`, otherwise the swap bounces
    and `pending` is restored unchanged (SS4.3.1).
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

import numpy as np

from . import economics as econ
from .agents import (
    AgentPool,
    Archetype,
    bot_loop_burst_length,
    claims_tribute_immediately,
    mint_delay_seconds,
    sells_rebate_immediately,
)
from .amm import Pool
from .arrivals import ArrivalParams, ArrivalProcess, PRIMORIALS
from .numtheory import Sieve

DAY = 86400.0


@dataclass
class PrimeHeadParams:
    """SS10's prime-head model. An arriving would-be minter facing a prime head
    compares what the prime actually pays -- discounted tribute, the
    `PRIME_UPLIFT` credit, naming/rank -- against the 1 GRAM price, using a
    private valuation `u` for the asset itself.

    `composite_accept_target` is the single most load-bearing assumption in
    this module and is **hand-set**: it says what fraction of arrivals would
    accept an ordinary composite mint at the typical rebate. It is what
    calibrates the private-valuation distribution, and the run publishes a
    sensitivity sweep over it rather than a point estimate.
    """

    enabled: bool = True
    composite_accept_target: float = 0.90
    typical_composite_k: float = 0.60
    sigma: float = 0.90               # lognormal shape of the private valuation
    rights_value_ton: float = 0.05    # naming + rank, hand-set (SS4.7.1 pays no GRAM)
    prime_hunter_share: float = 0.05  # arrivals that take any prime regardless
    npv_horizon: int = 1_000_000      # horizon for the forward tribute sweep


YEAR_SECONDS = 365.0 * DAY


@dataclass
class StakingParams:
    """DECISIONS.md D-151 / STAKING_PLAN.md P1 -- the ratchet's staked reserve.

    The ratchet's `pending` is 87% idle in the base run. Everything above a
    liquid reserve is staked in Tonstakers as tsTON and counted in `T` **at
    cost**; yield accrues OUTSIDE `T` and is harvested to the governed treasury.
    This block is the model that sizes `reserve_days` and `stake_min_ton`; it is
    OFF by default, so every run that does not ask for it is bit-identical to a
    run from before this existed.

    **Which daily ceiling `reserve_days` multiplies.** D-151 says "N days x the
    daily flush ceiling (`flush_pct = 0.2`)". `_maybe_flush` sizes a tranche as
    `min(pending, max(flush_pct * pending, flush_min_ton))`, so that expression
    IS the ceiling -- and the reading taken here is that it is computed on the
    ratchet's WHOLE obligation (liquid + staked + exiting, i.e. this engine's
    `pending`), not on the liquid part alone. Sizing it on the liquid part is
    self-referential: `liquid > reserve_days * flush_pct * liquid` is satisfied
    by every liquid balance above a fixed point, so the reserve would shrink to
    nothing as staking succeeded. On the whole obligation the reserve is a
    stated fraction `reserve_days * flush_pct` of `T`'s ratchet share, which is
    the quantity D-151's sentence is about, and it is a number the contract can
    compute from its own storage (`pending + stakedCost + exiting`).

    The three exit legs are D-151's, with per-leg behaviour configurable because
    none of the three has a measured fill rate on mainnet:

      * leg 1, Tonstakers' fill-or-kill withdrawal, instant and at the exact
        rate -- it fills when the pool's free GRAM covers the amount, which no
        get-method exposes, so it is a Bernoulli draw at `leg1_fill_prob`;
      * leg 2, the guarded DeDust swap, instant and at a haircut. The haircut is
        drawn at the FULL `exit_slippage_bps` bound every time, so the run
        reports the worst case D-151 tolerates rather than an average;
      * leg 3, the ~36 h payout bill, at the exact rate after
        `leg3_latency_days`. It is what a flush cannot have in the step it
        wanted it, so it is the only thing that produces `unmet_flush_ton`.

    `leg2_fill_prob` defaults to 1.0 -- leg 2 always available -- which is the
    letter of D-151's "bounded slippage tolerated". The reserve sweep also runs
    it at 0.0 ("leg 2 refuses", the depeg case D-151 says is precisely when
    waiting is correct), because at 1.0 nothing can ever be unmet and the sweep
    cannot discriminate. Neither is a measured probability; the two are the
    bounds, and both are published.
    """

    enabled: bool = False
    #: N in "N days x the daily flush ceiling". Swept 1..14 by run_phase1.py.
    reserve_days: float = 3.0
    #: Economic minimum, not a dust guard: every stake costs its caller a flat
    #: `deposit_fee_ton`, so a small stake earns less than it costs. Sized by
    #: run_phase1.py.
    stake_min_ton: float = 100.0
    #: ASSUMPTION, swept {0.02, 0.04, 0.06}. Yield never enters `T`.
    apr: float = 0.04
    #: What one stake actually COSTS, not what it attaches. `DEPOSIT_FEE =
    #: ONE_TON` (pool.func:79) is a gas reserve: ~0.89 of it comes back as
    #: `excesses` and the ratchet forwards it to the caller (MISTAKES.md
    #: 2026-11-23). Measured: 0.887-0.897 back on mainnet (2026-11-23), so at
    #: most 0.113 lost; the caller's net in RatchetStaking.spec.ts is 0.1128.
    #: It was 1.0, which sized `stake_min_ton` ~9x too high. Paid by the caller
    #: (D-146), never out of `pending` -- a fee out of `pending` would drop `T`
    #: and break the ratchet theorem (D-151 point 2).
    deposit_fee_ton: float = 0.113
    #: `WITHDRAWAL_FEE = ONE_TON / 2` (pool.func:80) plus the TEP-74 burn leg's
    #: gas. Same gas-buffer treatment as the deposit fee.
    exit_fee_ton: float = 0.8
    #: OWNER's value, 2026-09-20 (D-151 point 5). Not a sim output.
    exit_slippage_bps: float = 50.0
    leg1_fill_prob: float = 0.9
    leg2_fill_prob: float = 1.0
    leg3_latency_days: float = 1.5
    #: D-151 point 4: >= 30 days apart, skipped below dust.
    harvest_interval_seconds: float = 30.0 * DAY
    harvest_dust_tston: float = 0.0


@dataclass
class SimParams:
    seed: int = 42

    split: econ.SplitParams = field(default_factory=econ.SplitParams)
    uplifts: econ.UpliftParams = field(default_factory=econ.UpliftParams)

    # SS5 rebate/ratchet
    k_min: float = 0.2
    k_max_cap: float = 0.9
    ramp_seconds: float = 3600.0
    n0_anchor: int = 1000
    # D-156: the logistic supply cap. OWNER-SET (see `econ.S_MAX_PRIMES`); the sim
    # consumes it and re-derives the consequences.
    s_max: float = econ.S_MAX_PRIMES

    # SS4.3 / SS4.3.1 flush
    flush_pct: float = 0.20
    flush_cooldown_seconds: float = DAY
    flush_min_ton: float = 5.0
    floor_guard: float = 0.0
    floor_guard_enabled: bool = True

    # genesis (SS6). D-20 deleted the genesis K-lot auction and D-30/D-90 the
    # reservation lane; neither is modelled. `reference_primes` is only the set
    # whose tribute NPV `analysis` measures (`trophy_auction.npv_calibration`).
    reference_primes: tuple[int, ...] = (2, 3, 5, 7, 11, 13)
    # `L`, the genesis LP anchor: PRIMES per GRAM of founder seed. DENOMINATION_PLAN
    # (owner decision 2026-08-19) sets it to 10,000, which puts the deploy floor at
    # 1/12,000 GRAM per PRIMES. It is a pure denomination knob -- `T` is bit-identical
    # and `p_f/p_f0` is identical at every sampled day for any `L` -- so nothing
    # economic is re-derived when it moves. Kept in sync with the explicit value in
    # scripts/run_phase1.py and scripts/run_determinations.py; a stale default here
    # would silently redenominate any pass that does not pass the kwarg.
    genesis_lp_primes_per_ton: float = 10_000.0
    bounty_vault_pct_of_lp: float = 0.20
    # SS6 point 3: the LP is FOUNDER-SEEDED at deploy, not funded out of auction
    # proceeds. This is what lets minting open in the genesis block; the previous model derived T/S from the
    # clearings, which is only expressible if nothing mints until they land.
    #
    # T0 sets day-one depth, not price: S0 = T0 * L * (1 + vault_pct), so
    # p_f0 = 1 / (L * 1.2) at ANY seed size. Owner decision 2026-08-15: 200 GRAM.
    #
    # D-100 point 2 SPLITS this field in two. It used to be BOTH the PRIMES-side
    # sizing of S0 AND the GRAM credited into T at genesis; those are now different
    # numbers, because the operator funds 4.20 GRAM at genesis (not 240/480), and
    # `genesis_donation_ton` below carries the second role. This field keeps only
    # the first: it is a NOMINAL that sizes S0 = seed*L*(1/2 + vault_pct) = 11,000,000
    # PRIMES -- the 10,000,000-PRIMES bounty vault plus the 1,000,000 PRIMES the
    # treasury's lock vests (D-100 point 6; D-166 deleted the operator's matching
    # 1,000,000) -- and it is the
    # modelled depth of the DeDust pair the agent loop trades against. Neither of
    # those is GRAM anyone sends: the pair is the operator's own, off-protocol
    # (D-46 point 4), and locked depth is never summed into `T` (D-100 point 4).
    genesis_seed_ton: float = 200.0
    # GAUNTLET.md X14 -- the modelled DeDust pair, decoupled from the S0 nominal.
    #
    # `genesis_seed_ton` above does two jobs at once: it sizes S0 (a supply figure
    # nobody funds) and it sets the depth of the pool the agent loop trades. Before
    # D-100 point 2 those coincided with the money the operator actually posted; they
    # have not since, and D-140 moved the real pair again -- 292,000 PRIMES against
    # 0.1022 GRAM, priced at `primes * p_f`. These two fields let a run seed the POOL at
    # the real pair while leaving S0 exactly where it is, so the question X14 asks
    # ("what is calibrated against depth, and does the real book change it?") can be
    # measured rather than argued. `None` is the default and reproduces the previous
    # behaviour bit for bit -- no committed run passes them.
    modelled_pool_ton: float | None = None
    modelled_pool_primes: float | None = None
    # D-154 (amends D-100 point 2): `T0`. The operator donates 132.5 GRAM at
    # genesis through `donate_floor`, and that -- nothing else -- is what `seedT`
    # means after D-100 point 1 deletes the second `seedT` credit (D-26's
    # definition restored: capital credited straight into `T` that never passes
    # through the ratchet). D-92's derivation stands as a METHOD
    # (`X = S0 / (1/p_f - L)`); its INPUT is owner-set, and D-154 front-loads the
    # WHOLE of D-100 point 3's 150 GRAM commitment into genesis instead of
    # dribbling it in afterwards, because D-140 pins the pair at the floor and so
    # makes opening depth quadratic in this field: the GRAM side is
    # `m * X / (S0 + m)`, `m` the donation's own D-156-tapered mint (D-166 took the
    # operator's vest tranche out of the pair), 14.13 GRAM at 132.5.
    # `p_f0 = 132.5 / (11,000,000 + 1,312,854) = 1.0761e-5` (`_genesis`), and every
    # figure this file derives from the genesis floor moves
    # with it (regenerated, never hand-patched).
    #
    # NOT taken: re-sizing the modelled pool to the real pair. The pool is a
    # market-depth assumption, not a `T` term, and re-sizing it would silently
    # re-calibrate k_max, the kill criteria and the reserves off a modelling
    # choice no decision makes. Flagged in `genesis._donation_vs_modelled_depth`
    # in shared/params.json rather than buried here. D-154 NARROWS that gap
    # rather than closing it: the real pair goes from 0.1022 GRAM to ~17.4, against
    # a modelled depth sized off the 200 GRAM nominal, so the two are now the same
    # order of magnitude for the first time. X14 already measured that seeding the
    # pool at the real pair moves 45 numeric leaves and NOT ONE parameter.
    genesis_donation_ton: float = 132.50

    amm_fee: float = 0.0025  # DeDust mainnet volatile default; see amm.py's docstring

    arrival: ArrivalParams = field(default_factory=ArrivalParams)
    agent_mix: dict | None = None

    prime_head: PrimeHeadParams = field(default_factory=PrimeHeadParams)

    #: D-151 / STAKING_PLAN.md P1. Disabled by default; see `StakingParams`.
    staking: StakingParams = field(default_factory=StakingParams)

    # SS3 item 6: pessimistic rank-and-credit distribution
    pessimistic_uplifts: bool = False

    # ---- DECISIONS.md D-20: primes are NOT head mints ------------------ #
    # Both generators of shared/params.json set it True (run_phase1.py since
    # the owner-signed 2026-09-24 baseline migration, run_determinations.py
    # before it), and it is the default. A unit test that exercises the legacy
    # path, in which the head walks THROUGH primes, sets it False explicitly.
    #
    # With it on, the model follows D-20 exactly:
    #   * the head is defined over composites and Unity; it never mints a prime
    #     and can never park on one, so `prime_declines` is structurally 0;
    #   * a prime's lot opens when the head passes it and clears on the
    #     `MODE_DUTCH_BUYNOW` lane;
    #   * D-7 routing: the nominal 1 GRAM runs the ordinary §4.1 five-way split
    #     (on a prime the tribute line has no recipient and falls to the pool)
    #     and 100% of the premium is credited to the ratchet as `pending` with
    #     zero emission -- a pure `T` increment against an untouched `S`;
    #   * an unsold prime's tribute forfeits to the TREASURY (D-20 point 4).
    primes_skip_head: bool = True
    #: Probability a prime lot finds a buyer, and the mean premium it clears at
    #: over the 1 GRAM floor. Both are SUPPLIED, not invented here: the caller
    #: passes what `market.dutch_outcome` measured under its stated premises.
    prime_lot_sale_probability: float = 0.0
    prime_lot_mean_premium_ton: float = 0.0
    #: V26.2: how long a SOLD lot's row stays open, from the same lane model
    #: (`market.evaluate_lane`'s sale-weighted `mean_days_to_sale`). Used only
    #: to size the peak concurrent backlog (`prime_lot_backlog_peak`); it moves
    #: no money. 0 resolves a sale instantly, as before.
    prime_lot_mean_days_to_sale: float = 0.0

    # ---- SS4.1's seventh line: invite transfers -------------------------------- #
    # ASSUMED, NOT MEASURED, and the label travels with it: see
    # `econ.INVITE_OPTIN_RATE_LABEL`, which is the `_source` any published figure
    # derived from this must carry. The DEFAULT IS 0.0 and that is deliberate --
    # the line is opt-in, `run_determinations.py` and every test calibrated
    # against the uninvited split keep splitting the way they did, and a run that
    # wants the invited horizon says so (scripts/run_phase1.py's BASELINE_KWARGS
    # does).
    #
    # The DRAW is Bernoulli at this rate, all-or-nothing at `INVITE_MAX_COUNT`,
    # not a count sampled over 0..3. The checkout fills all 3 recipients or the
    # mint sends none, so a binomial over the four counts would be modelling a control that does not
    # exist. It is also exactly the two-point mixture `econ.beta_expected`
    # already computes analytically -- which is what makes the realised mean beta
    # of a run checkable against it, and that cross-check is the one the report
    # block publishes.
    invite_optin_rate: float = 0.0

    horizon_days: float = 3 * 365.0
    n_max: int = 2_000_000
    history_every_n_mints: int = 200
    max_mints: int | None = None

    whale_dump_rate_per_day: float = 1.0 / 25.0
    whale_dump_frac_of_holdings: float = 0.6
    sandwich_active: bool = True
    # D-190: the front-run sizes the best-responder tries, as fractions of the
    # flush. The profitable range under the guard runs to ~8x the flush.
    sandwich_frontrun_fracs: tuple[float, ...] = (0.05, 0.10, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0)
    external_buy_ton_per_day: float = 0.0


#: Sentinel owner id for tribute that belongs to nobody because the prime that
#: earned it is an unsold Dutch lot. DECISIONS.md D-20 point 4 routes it to the
#: treasury -- an already-wired destination, not a new admin-adjacent pool.
TREASURY_OWNER = -999


@dataclass
class MintEvent:
    n: int
    kind: str
    t: float
    archetype: str
    wallet_id: int
    referred: bool
    k: float
    k_max_effective: float
    k_clamped: bool
    beta: float
    pool_injection: float
    rebate_primes: float
    tribute_paid: float
    flat_dividend: float
    invite_count: int = 0
    dwell_seconds: float = 0.0
    declines: int = 0
    factors: dict[int, int] = field(default_factory=dict)
    referral_number: int | None = None
    mint_index: int = 0
    T_after: float = 0.0
    S_after: float = 0.0
    pending_after: float = 0.0
    # D-117: cumulative unspent gas & ops booked into T/pending so far. On chain it
    # arrives only when someone calls `sweep_ops`, so a replay nets it out.
    ops_swept_after: float = 0.0
    # G79: the flat-dividend accumulator after this mint. The chain accrues it before
    # the head-advance walk counts the next prime, so both sides divide by pi(n) of
    # the primes BELOW n; SimCrossCheck replays it against `getDivAcc`.
    div_acc_after: float = 0.0


# Module-level cache for the forward-tribute sweep, which is expensive and
# identical across runs with the same horizon/parameters.
_NPV_CACHE: dict[tuple, dict] = {}


def forward_tribute_npv(horizon: int, f: float, exponent: float, tribute_pct: float,
                        discount_rate: float = 0.35, mints_per_year: float = 30_000.0) -> dict:
    key = (horizon, round(f, 6), round(exponent, 6), round(tribute_pct, 6),
           round(discount_rate, 6), round(mints_per_year, 3))
    if key not in _NPV_CACHE:
        from . import tribute as tr
        _NPV_CACHE[key] = tr.prime_tribute_npv(
            horizon, exponent=exponent, f=f, tribute_pct=tribute_pct,
            discount_rate_annual=discount_rate, mints_per_year=mints_per_year,
        )
    return _NPV_CACHE[key]


class Engine:
    def __init__(self, params: SimParams):
        self.p = params
        self.rng = np.random.default_rng(params.seed)
        # A SEPARATE stream for the D-20 prime Dutch lane, so that turning the
        # lane on does not shift every subsequent draw on the main path. Without
        # it, "the same run with and without prime clearings" is not a controlled
        # comparison at all -- the arrival sequence diverges and the floor
        # difference mixes the lane's effect with a different realised history.
        # One extra stream is the cheapest way to make that comparison mean what
        # it says.
        self._lot_rng = np.random.default_rng(params.seed + 1_000_003)
        # A THIRD stream, for SS4.1's invite line (D-101), for exactly the same
        # reason and with the same guarantee: at `invite_optin_rate = 0` every
        # unrelated number in the run is bit-identical to a run without this
        # field, because the only consumers of `self.rng` are the arrival clock,
        # wallet/archetype assignment, the whale clock, the
        # and `_accepts_prime` -- neither of which reads the
        # floor -- and none of them shifts when the invite draw comes from here.
        # The draw is unconditional per mint (below), so a rate-0 and a rate-0.8
        # run stay aligned draw-for-draw and the floor difference between them is
        # the line's effect, not a different realised history.
        self._invite_rng = np.random.default_rng(params.seed + 2_000_003)
        # A FOURTH stream, for D-151's exit legs, for the same reason as the
        # three above: a run with `staking.enabled = False` must be bit-identical
        # to a run from before the block existed, and one with it on must differ
        # only by what staking does -- not by a different realised arrival
        # history.
        self._stake_rng = np.random.default_rng(params.seed + 3_000_003)
        self.sieve = Sieve(params.n_max + 10)
        self.agents = (
            AgentPool(rng=self.rng, mix=params.agent_mix)
            if params.agent_mix
            else AgentPool(rng=self.rng)
        )

        self.T = 0.0
        self.S = 0.0
        self.pending = 0.0
        self.swapped = 0.0
        self.treasury_total = 0.0
        self.ops_surplus_to_pool_total = 0.0  # D-117: unspent gas & ops, swept to the pool

        self.owed: dict[int, float] = {}
        self.claimed_total: dict[int, float] = {}
        self.ownership: dict[int, int] = {}
        self.wallet_primes_balance: dict[int, float] = {}
        self.wallet_ton_balance: dict[int, float] = {}

        # SS3.2 flat prime dividend (O(1) accrual)
        self.div_acc = 0.0
        self.div_entry: dict[int, float] = {}
        self.flat_dividend_total = 0.0

        # SS4.7 / SS4.7.1 ladders and SS5's credit windows.
        #
        # D-106: `recruit_rank_count` and `newcomer_window_left` have NO WRITER
        # in this engine, and that predates D-106 -- the patron block that used
        # to open a newcomer window wrote only that one, and nothing ever wrote a
        # rank. Both ladders are therefore modelled by `pessimistic_uplifts`
        # alone, which stacks EVERY ladder at its top tier simultaneously. That
        # is the bound the SS5 invariant actually needs: the K_CEIL clamp is what
        # `k < 1` rests on, and a run that maxes every leg tests the clamp harder
        # than any realistic recruit distribution could. Modelling a gift-mint
        # rate instead would mean inventing a take-up parameter with no
        # measurement behind it, which CLAUDE.md rule 3 forbids.
        self.recruit_rank_count: dict[int, int] = {}
        self.prime_rank_count: dict[int, int] = {}
        self.prime_window_left: dict[int, int] = {}
        # SS5.1's invariant, measured rather than assumed: per prime window, the
        # k_max uplift the clamp actually let through. `_open_prime_window` is
        # the live one per wallet [prime, realized_sum, uplifted_mints];
        # `prime_windows` the closed ones.
        self._open_prime_window: dict[int, list] = {}
        self.prime_windows: list[dict] = []
        self.newcomer_window_left: dict[int, int] = {}
        self.k_clamp_hits = 0
        self.k_clamp_eligible = 0

        self.pool: Pool | None = None
        self.last_flush_t = 0.0
        self.last_mint_t = 0.0

        # D-20 / CONCEPT.md §6 point 1: no genesis K-lot, so the head opens at 2
        # on both paths (the legacy path walks it through primes).
        self.head = 2
        self._head_since_t = 0.0

        self.arrivals = ArrivalProcess(params.arrival, self.rng)

        self._next_whale_check_t = self.rng.exponential(DAY / max(params.whale_dump_rate_per_day, 1e-9))
        self._whale_wallet = -1
        self.wallet_primes_balance[self._whale_wallet] = 0.0

        self.sandwich_extracted_ton = 0.0
        self.sandwich_gross_profit_ton = 0.0
        self.sandwich_net_pnl_ton = 0.0
        self.sandwich_events = 0
        self.sandwich_declined_events = 0
        self.sandwich_bounced_flushes = 0
        self.external_bought_ton = 0.0
        self._next_external_buy_t = DAY


        self.flush_attempts = 0
        self.flush_fills = 0
        self.flush_bounces = 0
        self.last_flush_outcome = "never"

        # CONCEPT SS3.3 / SS11.21: the burn side of the supply report. The flush's
        # proceeds leg was already a burn in this model -- the PRIMES bought out of
        # the pool were simply dropped -- but nothing counted them, so the sim could
        # not answer "how much has been burned" and neither could the dashboard it
        # calibrates. `S` is untouched by burns by construction (it is cumulative
        # emission), which is exactly why circulating supply has to be tracked
        # separately rather than read off `S`.
        self.burned_primes = 0.0
        self.burn_events = 0
        self.pending_peak = 0.0
        self.pending_series: list[tuple[float, float]] = []

        # ---- D-151 / STAKING_PLAN.md P1: the staked reserve ---------------- #
        #
        # `self.pending` keeps its meaning -- the ratchet's WHOLE obligation, the
        # term of `T` that is neither seeded nor swapped -- and is now split by
        # where the GRAM physically is:
        #
        #     pending == liquid + staked_cost + exiting
        #     T       == seeded + swapped + liquid + staked_cost + exiting
        #
        # so `liquid` is derived rather than stored and none of the six sites
        # that write `pending` has to know staking exists. The contract stores
        # the same identity the other way round (its `pending` IS `liquid`, with
        # `stakedCost` and `exiting` beside it); the arithmetic is the same and
        # `_assert_t_identity` below checks it on every step.
        self.staked_cost = 0.0
        self.exiting = 0.0
        #: tsTON yield, valued in GRAM. NEVER a term of `T` -- "realize, never
        #: mark" (D-151 point 4) is this line.
        self.accrued_yield = 0.0
        self.harvested_tston = 0.0
        #: Flat pool fees, paid from the ratchet's gas buffer, NOT out of
        #: `pending`: a fee taken from the staked amount would drop `T`.
        self.staking_fees_paid = 0.0
        self.realized_slippage_ton = 0.0
        #: GRAM a flush wanted and could not get in the step it wanted it, and the
        #: denominator that makes it a rate.
        self.unmet_flush_ton = 0.0
        self.flush_demand_ton = 0.0
        #: The largest single tranche the reserve was asked for -- what the
        #: reserve has to cover, as against the ceiling it is SIZED against.
        self.flush_demand_max_ton = 0.0
        self.staked_ton_seconds = 0.0   # the integral APR multiplies
        self.stake_events = 0
        self.exit_events = 0
        self.exit_leg_counts = {1: 0, 2: 0, 3: 0}
        self.unmet_flush_events = 0
        self.staked_cost_peak = 0.0
        self._exit_queue: list[tuple[float, float, float]] = []
        self._stake_last_t = 0.0
        self._last_harvest_t = 0.0

        self.prime_dwells: list[dict] = []
        self.composite_dwells: list[dict] = []
        self.prime_declines = 0
        self.arrivals_seen = 0

        # D-20 prime Dutch lane counters. All zero unless `primes_skip_head`.
        self.prime_lots_opened = 0
        self.prime_lots_sold = 0
        self.prime_lots_unsold = 0
        # V26.2 / D-188: the PEAK number of prime lots open at once -- unsold
        # ones for ever, sold ones for `prime_lot_mean_days_to_sale`. One market
        # `lots` row (and one ledger unsold row) each; the `BOUND:` beside the
        # market's `lots` is written from it.
        self.prime_lot_backlog_peak = 0
        self._sold_lot_closes: list[float] = []
        self.prime_lot_premium_total = 0.0
        self.prime_lot_nominal_total = 0.0
        self.unsold_prime_forfeit_ton = 0.0
        self.unsold_prime_numbers: set[int] = set()

        self.history: list[dict] = []
        self.mint_log: list[MintEvent] = []

        # prime-head valuation inputs
        self._npv: dict[int, float] = {}
        if params.prime_head.enabled:
            hz = min(params.prime_head.npv_horizon, params.n_max)
            self._npv = forward_tribute_npv(
                hz,
                params.split.flat_dividend_f,
                params.split.divisor_exponent,
                params.split.tribute_pct,
            )["npv"]
            self._npv_horizon = hz
            # calibrate the private-valuation lognormal against the composite
            # acceptance target (see PrimeHeadParams docstring)
            ph = params.prime_head
            v_comp = ph.typical_composite_k * 0.65
            thresh = max(1.0 - v_comp, 1e-6)
            from math import log
            # P(u >= thresh) = target  ->  mu = ln(thresh) + z*sigma
            z = _norm_ppf(ph.composite_accept_target)
            self._u_mu = log(thresh) + z * ph.sigma
            self._u_sigma = ph.sigma

        self._genesis()

    # ------------------------------------------------------------------ #
    # Genesis
    # ------------------------------------------------------------------ #
    def _genesis(self):
        p = self.p
        # D-20 point 1 DELETED the genesis K-lot: no pre-assigned owners for
        # {2,3,5,7,11,13} and no clearings. `T` opens at the donation alone.
        lp_ton = p.genesis_seed_ton
        lp_primes = lp_ton * p.genesis_lp_primes_per_ton
        vault_primes = lp_primes * p.bounty_vault_pct_of_lp
        # D-100 point 2: `T0` is the 4.20 GRAM donation, NOT `lp_ton`. `lp_ton` sizes
        # S0 and the modelled pair; it is not credited to `T` any more, because
        # after D-100 point 1 the only thing that lands in `seedT` is a donation.
        donation_ton = p.genesis_donation_ton

        # D-166: the vested allocation is the TREASURY's D-100 point 6 half of
        # `seed * L` and nothing else -- the operator's half is deleted, and the
        # operator acquires PRIMES by minting like anyone (SS2 principle 4). The
        # vault is still sized off the nominal `lp_primes`, not off what is
        # vested, so its absolute 10,000,000 does not move with this line.
        vested_primes = lp_primes / 2.0

        # S0 as of the SEED, before the donation. `self.S` is cumulative and mutates
        # on every mint, so reporting it as the genesis supply gives the END-of-run
        # number -- which looks like a genesis figure and is off by the whole
        # simulated horizon.
        self.genesis_supply_primes = vested_primes + vault_primes

        # `donate_floor` MINTS to the donor (D-100 point 1): `X*L` while `T = 0`,
        # tapered by D-156 like every other `S +=` site. Those PRIMES are the pair's
        # PRIMES side (D-140). The sim used to credit `T` and skip this, which put the
        # modelled deploy floor at `X / S0` = 1.2045e-5 against the 1.0761e-5 the
        # 2026-09-24 testnet genesis measured (`docs/testnet-deployment.md`).
        self.genesis_donation_primes = (
            donation_ton * p.genesis_lp_primes_per_ton
            * econ.supply_taper(self.genesis_supply_primes, p.s_max)
        )
        # S as of deploy: the seed plus the donor's mint. What the floor divides by.
        self.deploy_supply_primes = self.genesis_supply_primes + self.genesis_donation_primes

        self.T = donation_ton
        self.S = self.deploy_supply_primes
        self.bounty_vault_balance = vault_primes
        self.bounty_vault_initial = vault_primes
        # SS5's `T = seedT + swapped + pending` holds at genesis (D-26): `seedT`
        # is the donation and `swapped` and `pending` are both 0.

        # X14: the POOL may be seeded at the real pair without moving S0, which is
        # computed from `lp_primes` above and is untouched by this.
        pool_ton = p.modelled_pool_ton if p.modelled_pool_ton is not None else lp_ton
        pool_primes = p.modelled_pool_primes if p.modelled_pool_primes is not None else lp_primes
        self.pool = Pool(ton_reserve=pool_ton, primes_reserve=pool_primes, fee=p.amm_fee)

        # SS6 point 3: the DEPLOY-time floor, which is what the spec quotes and
        # what the dashboard shows at open -- `donation / S0`, before any clearing.
        #
        # PROVENANCE (D-46 point 2, D-91 point 4, D-92, D-100 point 2). On chain
        # genesis seeds `T = 0` and the floor is created afterwards by
        # `donate_floor`, which adds `X` to `T`. Under D-92 that `X` was chosen to
        # REPRODUCE `lp_ton / S0` -- 240 GRAM, so the two coincided and the deploy
        # floor could be written as `1/(L * (1 + vault_pct))`, independent of the
        # seed. D-100 point 2 unpins them: the donation is 4.20 GRAM by owner
        # decision, `S0` is still `lp_ton * L * (1 + vault_pct)`, and the deploy
        # floor is therefore `4.20 / 12,000,000 = 3.5e-7` -- 48x below the old
        # figure and no longer a function of `L` alone. Anything that quotes
        # "1/(L*1.2)" or "60,000 PRIMES per GRAM at open" is stale by this line.
        # With no genesis clearings (D-20) `floor_price` equals this at deploy.
        # `self.S` here already includes the donor's mint, so this is
        # `X / (S0 + X*L*taper)`, not `X / S0`.
        self.floor_price_deploy = donation_ton / self.S if self.S > 0 else 0.0
        self.floor_price_genesis = self.floor_price_deploy

    @property
    def floor_price(self) -> float:
        return self.T / self.S if self.S > 0 else 0.0

    @property
    def minted_primes_count(self) -> int:
        return len(self.div_entry)

    # ------------------------------------------------------------------ #
    # Tribute weighting (SS3.2)
    # ------------------------------------------------------------------ #
    def _tribute_weights(self, n: int) -> dict[int, float] | None:
        if self.sieve.is_prime(n):
            return None
        factors = self.sieve.factorize(n)
        # D-102 deleted the SS3.2.2 constellation multiplier, and no other
        # multiplier ever wrote this map, so `w(p) = e * sqrt(p)` is the whole
        # divisor weighting again. `divisor_weights` keeps its third argument
        # for a future weighting; nothing in the sim passes one.
        raw_by_prime = econ.divisor_weights(factors, self.p.split.divisor_exponent, None)
        raw: dict[int, float] = {}
        for prime, w in raw_by_prime.items():
            owner = self.ownership.get(prime)
            if owner is None:
                # D-20 point 4: under the D-20 model every prime below the head
                # already has a lot, so an unowned factor is an UNSOLD prime and
                # its tribute forfeits to the treasury -- not to the pool, and
                # not silently redistributed to the co-owners of the other
                # factors, which is what dropping the term here would do.
                if self.p.primes_skip_head:
                    raw[TREASURY_OWNER] = raw.get(TREASURY_OWNER, 0.0) + w
                continue
            raw[owner] = raw.get(owner, 0.0) + w
        if not raw:
            return None
        total = sum(raw.values())
        return {o: w / total for o, w in raw.items()}

    # ------------------------------------------------------------------ #
    # Uplift stack (SS5)
    # ------------------------------------------------------------------ #
    def _effective_k_max(self, n: int, wallet_id: int,
                         drop_prime_window: bool = False) -> tuple[float, bool]:
        up = self.p.uplifts
        if self.p.pessimistic_uplifts:
            pr = len(up.recruit_rank_uplifts) - 1
            qr = len(up.prime_rank_uplifts) - 1
            in_prime = True
            in_new = True
        else:
            pr = econ.rank_of(self.recruit_rank_count.get(wallet_id, 0), up.recruit_rank_tiers)
            qr = econ.rank_of(self.prime_rank_count.get(wallet_id, 0), up.prime_rank_tiers)
            in_prime = (self.prime_window_left.get(wallet_id, 0) > 0
                        and not drop_prime_window)
            in_new = self.newcomer_window_left.get(wallet_id, 0) > 0
        km, clamped = econ.k_max_effective(
            n, self.p.n0_anchor, self.p.k_max_cap, self.p.k_min, up,
            recruit_rank=pr, prime_rank=qr,
            in_prime_window=in_prime, in_newcomer_window=in_new,
        )
        # D-168 deleted §5.3's fifth (stake) leg: four legs, one clamp.
        return km, clamped

    # ------------------------------------------------------------------ #
    # SS4.1's seventh line: does this mint carry invite transfers?
    # ------------------------------------------------------------------ #
    def _invite_draw(self) -> int:
        """One Bernoulli draw at `invite_optin_rate`, from the dedicated stream.

        `INVITE_MAX_COUNT` or 0 -- see the field's comment on `SimParams` for why
        it is two-point and not a count over 0..3. `invitees_served` is left at
        its `None` default at the call site: D-101 call 3's unspent slot is
        arithmetically indistinguishable from a lower count (params.json
        `invites.unspent_slot_rule` says so), so simulating it separately would
        add a second assumed rate and buy nothing.
        """
        return (econ.INVITE_MAX_COUNT
                if self._invite_rng.random() < self.p.invite_optin_rate else 0)

    # ------------------------------------------------------------------ #
    # One mint
    # ------------------------------------------------------------------ #
    def _do_mint(self, n, t, archetype, wallet_id, mint_index,
                 dwell=0.0, declines=0) -> MintEvent:
        # Drawn FIRST and UNCONDITIONALLY, before any branch: `_do_mint` has no
        # early return today, but a future one that skipped the draw would
        # desynchronise this stream against a control run and destroy exactly the
        # comparison it exists to protect.
        invite_count = self._invite_draw()

        is_prime = bool(self.sieve.is_prime(n))
        factors = {} if is_prime else self.sieve.factorize(n)
        ref_number = self.agents.choose_referral(wallet_id)
        referral_owner_wallet = self.ownership.get(ref_number) if ref_number is not None else None
        referred = referral_owner_wallet is not None

        weights = None if is_prime else self._tribute_weights(n)
        result = econ.split_mint(
            1.0,
            weights,
            referral_owner_wallet if referred else None,
            self.p.split,
            minted_primes_count=self.minted_primes_count,
            is_prime_mint=is_prime,
            invite_count=invite_count,
        )

        self.treasury_total += result.treasury
        for owner, ton_amt in result.recipient_shares.items():
            if owner == TREASURY_OWNER:
                self._forfeit_unsold_tribute(ton_amt)   # D-20 point 4
                continue
            self.owed[owner] = self.owed.get(owner, 0.0) + ton_amt
        if result.flat_dividend > 0 and self.minted_primes_count > 0:
            self.div_acc += result.flat_dividend / self.minted_primes_count
            self.flat_dividend_total += result.flat_dividend
        if referred:
            self.wallet_ton_balance[referral_owner_wallet] = (
                self.wallet_ton_balance.get(referral_owner_wallet, 0.0) + result.referral_paid
            )

        # ---- SS5.1: primes emit nothing. k = 0, unconditionally. ---- #
        k_max_eff, clamped = self._effective_k_max(n, wallet_id)
        if is_prime:
            k = 0.0
        else:
            k = econ.k_of_t(t - self.last_mint_t, self.p.k_min, k_max_eff, self.p.ramp_seconds)
        self.k_clamp_eligible += 1
        if clamped:
            self.k_clamp_hits += 1

        # D-156: the logistic cap, applied to `k` BEFORE the rebate product and
        # AFTER the k_min/uplift stack above -- mirroring `primes_ledger.tolk`
        # exactly, which is what `SimCrossCheck.spec.ts` binds. Applying it after
        # the k_min branch is what stops that floor defeating the cap.
        k *= econ.supply_taper(self.S, self.p.s_max)

        floor_before = self.floor_price
        rebate = econ.rebate_primes(result.pool_injection, k, floor_before) if floor_before > 0 else 0.0

        # D-117: the unspent gas & ops line reaches the pool too, via the
        # permissionless `sweep_ops` -- emission-free, so it is outside the rebate
        # product above. Booked at mint: ponytail: the sweep's timing lag (it runs
        # whenever someone calls it) is not modelled; the GRAM is the same.
        self.T += result.pool_injection + result.ops_surplus_to_pool
        self.pending += result.pool_injection + result.ops_surplus_to_pool
        self.ops_surplus_to_pool_total += result.ops_surplus_to_pool
        self.S += rebate
        self.pending_peak = max(self.pending_peak, self.pending)

        self.wallet_primes_balance[wallet_id] = self.wallet_primes_balance.get(wallet_id, 0.0) + rebate
        self.ownership[n] = wallet_id
        self.agents.record_ownership(wallet_id, n)

        if is_prime:
            self.owed.setdefault(n, 0.0)
            self.claimed_total.setdefault(n, 0.0)
            self.div_entry[n] = self.div_acc          # SS3.2: stamp entry at mint
            self.prime_rank_count[wallet_id] = self.prime_rank_count.get(wallet_id, 0) + 1
            self._grant_prime_window(wallet_id, n)
        else:
            # SS5.1: the window decrements on composite mints only
            if self.prime_window_left.get(wallet_id, 0) > 0:
                win = self._open_prime_window.get(wallet_id)
                if win is not None:
                    win[1] += k_max_eff - self._effective_k_max(n, wallet_id, True)[0]
                    win[2] += 1
                self.prime_window_left[wallet_id] -= 1
                if self.prime_window_left[wallet_id] == 0:
                    self._close_prime_window(wallet_id)
            if self.newcomer_window_left.get(wallet_id, 0) > 0:
                self.newcomer_window_left[wallet_id] -= 1

        self.last_mint_t = t

        if sells_rebate_immediately(archetype) and rebate > 0 and self.pool is not None:
            got = self.pool.swap_primes_for_ton(rebate)
            self.wallet_primes_balance[wallet_id] -= rebate
            self.wallet_ton_balance[wallet_id] = self.wallet_ton_balance.get(wallet_id, 0.0) + got

        ev = MintEvent(
            n=n, kind="prime" if is_prime else "composite", t=t,
            archetype=archetype.name, wallet_id=wallet_id, referred=referred,
            k=k, k_max_effective=k_max_eff, k_clamped=clamped,
            beta=result.pool_injection,
            pool_injection=result.pool_injection, rebate_primes=rebate,
            tribute_paid=result.tribute_paid, flat_dividend=result.flat_dividend,
            invite_count=invite_count,
            dwell_seconds=dwell, declines=declines,
            factors=factors,
            referral_number=ref_number if referred else None, mint_index=mint_index,
            T_after=self.T, S_after=self.S, pending_after=self.pending,
            ops_swept_after=self.ops_surplus_to_pool_total,
            div_acc_after=self.div_acc,
        )
        self.mint_log.append(ev)
        if is_prime:
            self.prime_dwells.append({"n": n, "dwell_days": dwell / DAY, "declines": declines,
                                      "t_days": t / DAY})
        else:
            self.composite_dwells.append({"n": n, "dwell_days": dwell / DAY, "t_days": t / DAY})
        return ev

    # ------------------------------------------------------------------ #
    # Prime-head acceptance (SS10, SS5.1's liveness problem)
    # ------------------------------------------------------------------ #
    def prime_mint_value_ton(self, n: int) -> float:
        """What a prime mint actually pays its minter, in GRAM-equivalent:
        discounted forward tribute + the PRIME_UPLIFT credit + rights."""
        ph = self.p.prime_head
        npv = self._npv.get(n)
        if npv is None:
            npv = 0.0
        up = self.p.uplifts
        km = econ.k_max_of_n(n, self.p.n0_anchor, self.p.k_max_cap, self.p.k_min)
        headroom = max(up.k_ceil - km, 0.0)
        credit = min(up.prime_uplift, headroom) * up.prime_window * 0.65
        return npv + credit + ph.rights_value_ton

    # ------------------------------------------------------------------ #
    # D-20: the prime Dutch lane. NOT a head mint.
    # ------------------------------------------------------------------ #
    def _open_prime_lot(self, p_num: int, t: float) -> None:
        """Open, and immediately resolve in expectation, one prime's Dutch lot.

        Resolved in expectation rather than by simulating the seven-day clock
        inside the mint loop, because the clock is decoupled from the head by
        construction (D-20 point 3 retired the lookahead for exactly this
        reason) and because the sale probability and mean premium are measured
        elsewhere -- `market.dutch_outcome` -- rather than guessed here.

        Money, per D-7 and D-20 point 4:
          * sold: the nominal 1 GRAM runs the ordinary §4.1 split with
            `is_prime_mint=True`, so the whole tribute line falls to the pool
            and `β = 0.85`; the ratchet's half of the premium (D-114) is added
            to `T` and `pending` with **zero emission**, which is what makes a
            premium strictly floor-accretive, and the other half goes to the
            treasury;
          * unsold: no money moves, and the tribute the prime would have earned
            forfeits to the **treasury** while it sits.

        `S` is never touched on this path. That is the whole point of the D-7
        routing and it is asserted in `test_determinations.py`.
        """
        self.prime_lots_opened += 1
        closes = self._sold_lot_closes
        while closes and closes[0] <= t:
            heapq.heappop(closes)
        if self._lot_rng.random() >= self.p.prime_lot_sale_probability:
            self.prime_lots_unsold += 1
            self.prime_lot_backlog_peak = max(self.prime_lot_backlog_peak,
                                              self.prime_lots_unsold + len(closes))
            self.div_entry.setdefault(p_num, self.div_acc)
            self.owed.setdefault(p_num, 0.0)
            self.claimed_total.setdefault(p_num, 0.0)
            self.unsold_prime_numbers.add(p_num)
            return

        # The buyer is a wallet from the minting population, as on chain: the
        # SettlePrimeClearing arm credits the prime rank and opens the SS5.1
        # window on whoever bought, and they spend it on their next head mints.
        # Before any wallet exists (2 and 3 open at genesis) it is a wallet that
        # never mints. One `_lot_rng` draw either way.
        draw = int(self._lot_rng.integers(0, 1 << 30))
        n_wallets = self.agents._next_wallet_id
        wallet_id = draw % n_wallets if n_wallets else 700_000 + draw % 5000
        # D-7, and confirmed against the contract 2026-08-17: `SettlePrimeClearing`
        # runs the IDENTICAL five-way split on the IDENTICAL nominal MINT_PRICE.
        # A prime's nominal `T` contribution is therefore exactly a composite
        # mint's, and only the delivering message differs -- so the referral leg
        # must be resolved here the same way `_do_mint` resolves it, not
        # special-cased to "unreferred". Hardcoding no referral would book
        # beta = 0.85 on every lot against a realised blend nearer 0.77, which
        # flatters `T` by ~0.08 GRAM per prime for no reason the design gives.
        # The genuinely NEW term is the premium below, which the pre-D-20 model
        # did not have at all.
        ref_number = self.agents.choose_referral(wallet_id)
        referral_owner = (self.ownership.get(ref_number)
                          if ref_number is not None else None)
        # D-7: this lane runs the IDENTICAL split on the IDENTICAL nominal
        # MINT_PRICE, so it carries SS4.1's seventh line too -- a prime bought
        # off the Dutch lane is a mint and its buyer sets a count like anyone
        # else. Drawn immediately before the split so draws and splits stay
        # one-to-one across runs.
        result = econ.split_mint(
            1.0, None, referral_owner, self.p.split,
            minted_primes_count=self.minted_primes_count, is_prime_mint=True,
            invite_count=self._invite_draw(),
        )
        if referral_owner is not None:
            self.wallet_ton_balance[referral_owner] = (
                self.wallet_ton_balance.get(referral_owner, 0.0)
                + result.referral_paid
            )
        self.treasury_total += result.treasury
        # D-114: half the premium goes to the governed treasury, never to `T`.
        premium = max(self.p.prime_lot_mean_premium_ton, 0.0)
        premium_treasury = premium * econ.PREMIUM_TREASURY_BPS / 10_000
        self.treasury_total += premium_treasury
        premium -= premium_treasury
        self.T += result.pool_injection + premium + result.ops_surplus_to_pool
        self.pending += result.pool_injection + premium + result.ops_surplus_to_pool
        self.ops_surplus_to_pool_total += result.ops_surplus_to_pool
        self.pending_peak = max(self.pending_peak, self.pending)
        self.prime_lot_premium_total += premium
        self.prime_lot_nominal_total += result.pool_injection
        self.prime_lots_sold += 1
        heapq.heappush(closes, t + self.p.prime_lot_mean_days_to_sale * DAY)
        self.prime_lot_backlog_peak = max(self.prime_lot_backlog_peak,
                                          self.prime_lots_unsold + len(closes))

        self.ownership[p_num] = wallet_id
        self.agents.record_ownership(wallet_id, p_num)
        self.owed.setdefault(p_num, 0.0)
        self.claimed_total.setdefault(p_num, 0.0)
        self.div_entry[p_num] = self.div_acc
        self.prime_rank_count[wallet_id] = self.prime_rank_count.get(wallet_id, 0) + 1
        self._grant_prime_window(wallet_id, p_num)

    def _grant_prime_window(self, wallet_id: int, prime: int) -> None:
        """SS5.1: a prime opens PRIME_WINDOW composite mints of PRIME_UPLIFT on
        its buyer. A second prime RESETS the window rather than stacking."""
        self._close_prime_window(wallet_id)
        self.prime_window_left[wallet_id] = self.p.uplifts.prime_window
        if not self.p.pessimistic_uplifts:
            self._open_prime_window[wallet_id] = [prime, 0.0, 0]

    def _close_prime_window(self, wallet_id: int) -> None:
        win = self._open_prime_window.pop(wallet_id, None)
        if win is not None:
            self.prime_windows.append(
                {"prime": win[0], "realized_uplift_sum": win[1], "uplifted_mints": win[2]})

    def all_prime_windows(self) -> list[dict]:
        """Closed windows plus the ones still open at the end of the run."""
        return self.prime_windows + [
            {"prime": w[0], "realized_uplift_sum": w[1], "uplifted_mints": w[2]}
            for w in self._open_prime_window.values()
        ]

    def _forfeit_unsold_tribute(self, amount: float) -> None:
        """D-20 point 4: tribute with no owner goes to the treasury, not the pool."""
        self.treasury_total += amount
        self.unsold_prime_forfeit_ton += amount

    def _accepts_prime(self, n: int) -> bool:
        ph = self.p.prime_head
        if not ph.enabled:
            return True
        if self.rng.random() < ph.prime_hunter_share:
            return True
        u = float(np.exp(self._u_mu + self._u_sigma * self.rng.standard_normal()))
        return (u + self.prime_mint_value_ton(n)) >= 1.0

    # ------------------------------------------------------------------ #
    # The staked reserve (DECISIONS.md D-151 / STAKING_PLAN.md P1)
    # ------------------------------------------------------------------ #
    @property
    def liquid(self) -> float:
        """The part of `pending` that is GRAM on the ratchet's own balance.

        Derived, not stored: `pending` stays the whole obligation, so the six
        sites that write it need no knowledge of staking. This is the quantity
        the CONTRACT calls `pending`.
        """
        return self.pending - self.staked_cost - self.exiting

    @property
    def daily_flush_ceiling(self) -> float:
        """`_maybe_flush`'s own tranche sizing, read as the ceiling D-151's
        `reserve_days` multiplies. On the whole obligation -- see
        `StakingParams` for why not on `liquid`.

        Deliberately the same expression written twice: `SimCrossCheck.spec.ts`
        pins `_maybe_flush`'s copy LITERALLY, as the sizing rule the contract
        must match, so that line stays spelled out where the test looks for it.
        """
        return min(self.pending, max(self.p.flush_pct * self.pending, self.p.flush_min_ton))

    @property
    def reserve_target(self) -> float:
        return self.p.staking.reserve_days * self.daily_flush_ceiling

    def _assert_t_identity(self) -> None:
        """`T = seeded + swapped + liquid + staked_cost + exiting`, at every step.

        In the engine rather than only in a test: every route that moves a term
        passes through here, and a test can only see the two ends of the run.
        `seeded` is the genesis donation -- the one thing D-26 says never passes
        through the ratchet's `pending`.
        """
        lhs = (self.p.genesis_donation_ton + self.swapped
               + self.liquid + self.staked_cost + self.exiting)
        if abs(self.T - lhs) > 1e-6 * max(1.0, abs(self.T)):
            raise AssertionError(
                f"T identity broken: T={self.T!r} != seeded+swapped+liquid+"
                f"staked+exiting={lhs!r} (liquid={self.liquid!r}, "
                f"staked={self.staked_cost!r}, exiting={self.exiting!r})"
            )
        if self.liquid < -1e-6:
            raise AssertionError(f"liquid went negative: {self.liquid!r}")

    def _land_exits(self, t: float) -> None:
        """Credit every exit whose leg has arrived. A leg-2 haircut is a REALIZED
        loss: it leaves `exiting` at cost and lands as less GRAM, so `T` falls
        with `pending` and the identity holds across it."""
        if not self._exit_queue:
            return
        still: list[tuple[float, float, float]] = []
        for land_t, amount, haircut in self._exit_queue:
            if land_t > t:
                still.append((land_t, amount, haircut))
                continue
            self.exiting -= amount
            if haircut:
                self.T -= haircut
                self.pending -= haircut
                self.realized_slippage_ton += haircut
        self._exit_queue = still

    def _exit_stake(self, need: float, t: float) -> None:
        """D-151's three legs, in order. `need` is GRAM of cost basis to bring
        back; the leg decides when it lands and at what haircut."""
        stk = self.p.staking
        need = min(need, self.staked_cost)
        if need <= 0:
            return
        self.staked_cost -= need
        self.exiting += need
        self.exit_events += 1
        self.staking_fees_paid += stk.exit_fee_ton

        if self._stake_rng.random() < stk.leg1_fill_prob:
            leg, land_t, haircut = 1, t, 0.0
        elif self._stake_rng.random() < stk.leg2_fill_prob:
            leg, land_t = 2, t
            haircut = need * stk.exit_slippage_bps / 10_000.0
        else:
            leg, land_t, haircut = 3, t + stk.leg3_latency_days * DAY, 0.0
        self.exit_leg_counts[leg] += 1
        self._exit_queue.append((land_t, need, haircut))
        self._land_exits(t)          # legs 1 and 2 are instant

    def _staking_tick(self, t: float) -> None:
        """One keeper poke: accrue, land arrived exits, harvest, stake.

        Called from `_maybe_flush`, which is the same per-arrival cadence the
        keeper's `flush()` poke runs on -- `stake()`, `unstake()` and
        `harvest()` are pokes of exactly that kind (D-151: gas-only, no
        authority).
        """
        stk = self.p.staking
        if not stk.enabled:
            return
        dt = max(t - self._stake_last_t, 0.0)
        self._stake_last_t = t

        # Yield accrues on the COST BASIS and lands outside `T`. The integral is
        # kept so the APR sweep is exact arithmetic rather than three runs:
        # `accrued(apr) = staked_ton_seconds * apr / YEAR`.
        if self.staked_cost > 0 and dt > 0:
            self.staked_ton_seconds += self.staked_cost * dt
            self.accrued_yield += self.staked_cost * stk.apr * dt / YEAR_SECONDS

        self._land_exits(t)

        if (t - self._last_harvest_t >= stk.harvest_interval_seconds
                and self.accrued_yield >= stk.harvest_dust_tston):
            self.harvested_tston += self.accrued_yield
            self.accrued_yield = 0.0
            self._last_harvest_t = t

        excess = self.liquid - self.reserve_target
        if excess > stk.stake_min_ton:
            self.staked_cost += excess
            self.staked_cost_peak = max(self.staked_cost_peak, self.staked_cost)
            self.stake_events += 1
            # The FLAT deposit fee is charged to the gas buffer, never netted out
            # of the amount: netting it would drop `T` by 1 GRAM per stake and
            # `p_f = T/S` with it (D-151 point 2).
            self.staking_fees_paid += stk.deposit_fee_ton
        self._assert_t_identity()

    def _fundable_flush(self, amount: float, t: float) -> float:
        """How much of a wanted tranche the liquid reserve can actually send.

        Shortfall triggers an exit sized to restore the reserve (never merely the
        shortfall -- a shortfall-sized exit pays the withdrawal fee again on the
        next consecutive flush day). What the instant legs cannot deliver in this
        step is `unmet_flush_ton`, counted once per flush window.
        """
        self.flush_demand_ton += amount
        self.flush_demand_max_ton = max(self.flush_demand_max_ton, amount)
        if amount <= self.liquid:
            return amount
        self._exit_stake(max(amount, self.reserve_target) - self.liquid, t)
        if amount > self.liquid:
            self.unmet_flush_ton += amount - self.liquid
            self.unmet_flush_events += 1
            amount = max(self.liquid, 0.0)
        self._assert_t_identity()
        return amount

    # ------------------------------------------------------------------ #
    # Flush (SS4.3) with the floor guard (SS4.3.1)
    # ------------------------------------------------------------------ #
    def _maybe_flush(self, t: float):
        self._staking_tick(t)
        if t - self.last_flush_t < self.p.flush_cooldown_seconds:
            return
        if self.pending <= 0:
            self.last_flush_t = t
            return
        amount = min(self.pending, max(self.p.flush_pct * self.pending, self.p.flush_min_ton))
        if amount < self.p.flush_min_ton and amount < self.pending:
            return
        amount = min(amount, self.pending)
        auto_size = amount

        # ---- VENUE-DEPTH SIZING (2026-09-19) ----
        #
        # `auto_size` above comes from `pending` and knows nothing about the
        # pool; `min_out` below is priced ON the pool. Nothing connected the
        # two, so a tranche larger than the venue could absorb bounced against a
        # guard working exactly as designed -- the SPOT price below the floor and
        # the swap's AVERAGE execution price above it. Measured on testnet at
        # 7.7x above with the spot 2.1x below, and it is most of why the run
        # BEFORE this change reported 1086 bounces in 1089 attempts: the guard
        # was refusing the SIZE, not the market. Re-measured after it
        # (GAUNTLET.md G40): 422 bounces in 1317 attempts, a 68.0% fill rate
        # against the old 0.3%. (That run also read sandwich PnL 0.00; D-190's
        # caller-sized attacker re-measures it at 3.0% of swapped.)
        #
        # The contract cannot read the pool (no synchronous cross-contract call
        # on TVM), so the CALLER sizes the tranche and the contract clamps it to
        # `min(amount, auto_size)` -- one-directional, so a caller may only ask
        # for less. `Pool.max_in_at_floor` is the same closed form the app and
        # the keeper use, and 0.0 means no tranche of any size clears the guard.
        floor_price = self.T / self.S if self.S > 0 else 0.0
        if self.p.floor_guard_enabled and floor_price > 0:
            venue_max = self.pool.max_in_at_floor(floor_price, self.p.floor_guard)
            if venue_max <= 0:
                # Below-the-fee-line market: no size fills. Not an attempt --
                # the caller can see this off `get_reserves` without spending
                # the ratchet's 0.25 GRAM of swap gas to be told.
                self.last_flush_t = t
                return
            amount = min(amount, venue_max)

        # D-151: the tranche is sent from the LIQUID reserve. What it cannot
        # cover triggers an exit; what the instant legs cannot deliver in this
        # step is unmet, and the flush goes out smaller.
        short = False
        if self.p.staking.enabled:
            funded = self._fundable_flush(amount, t)
            short = funded < amount
            amount = funded
            if amount <= 0:
                self.last_flush_t = t
                return

        self.flush_attempts += 1

        # The sandwicher is a **best-responder**, not a reflex: it sizes its
        # front-run to maximise simulated profit and skips the attack when every
        # size loses. Modelling it as an unconditional 50% front-run would make
        # the guard look good for the wrong reason -- the attacker's own pump is
        # what bounces the flush, so an unconditional attacker simply donates
        # fees and incidentally blocks the protocol's buying.
        #
        # D-190 (2026-09-26): IT IS ALSO THE CALLER. Since D-143 `flush()` takes
        # the size as an argument, so the attacker pumps FIRST and then sizes
        # the tranche to the PUMPED pool, `min(amount, a_max(pumped))` -- the
        # guard still fills, at an average up to `p_f`, and the attacker sells
        # back above where it bought. The model before D-190 sized the flush
        # before the pump and capped the front-run at 0.5x the flush, so any
        # pump bounced it and the check read 0.00 GRAM; the profitable pumps run
        # to ~8x the flush (`sandwich_frontrun_fracs`). What the attack takes is
        # BURN EFFICIENCY -- fewer PRIMES burned per GRAM while the market is
        # under the floor. `T`, `S` and `p_f` do not move (CONCEPT.md SS8).
        front = 0.0
        primes_bought_by_sandwich = 0.0
        if self.p.sandwich_active and amount > 0:
            best_frac, best_pnl, best_amount = 0.0, 0.0, amount
            for frac in self.p.sandwich_frontrun_fracs:
                pnl, sized = self._simulate_sandwich(amount, frac * amount)
                if pnl > best_pnl:
                    best_frac, best_pnl, best_amount = frac, pnl, sized
            if best_frac > 0:
                front = best_frac * amount
                primes_bought_by_sandwich = self.pool.swap_ton_for_primes(front)
                amount = best_amount
                self.sandwich_events += 1
            else:
                self.sandwich_declined_events += 1

        # The cooldown is charged PRO RATA, matching `handleFlush`: it
        # rate-limits GRAM throughput, not call count, so a tranche a tenth the
        # auto size locks a tenth of the window. Keyed to the call instead, a
        # caller-chosen size would be a denial of service -- a dust request
        # would spend the whole day's allowance.
        incurred = self.p.flush_cooldown_seconds * amount / auto_size if auto_size > 0 else self.p.flush_cooldown_seconds
        self.last_flush_t = t - (self.p.flush_cooldown_seconds - incurred)
        # A tranche cut by the RESERVE, not by the caller, charges the whole
        # window: pro rata would let the same unserved demand be re-counted
        # every few hours, which measures retries rather than shortfall.
        if short:
            self.last_flush_t = t

        # SS4.3.1: min_out = amount * S / T * (1 + FLOOR_GUARD) = amount / p_f
        min_out = (amount * self.S / self.T) * (1.0 + self.p.floor_guard) if self.T > 0 else 0.0

        quoted_out = self.pool.quote_ton_for_primes(amount)

        filled = (not self.p.floor_guard_enabled) or (quoted_out >= min_out)
        if filled:
            bought = self.pool.swap_ton_for_primes(amount)
            self.pending -= amount
            self.swapped += amount
            self.flush_fills += 1
            self.last_flush_outcome = "filled"
            # SS4.3: bought PRIMES are burned, never held. Counted here so
            # `circulating_primes` is a measured quantity rather than a claim.
            self.burned_primes += bought
            self.burn_events += 1
        else:
            # bounce: GRAM returns, `pending` restored unchanged, nothing lost
            self.flush_bounces += 1
            self.last_flush_outcome = "bounced"
            if primes_bought_by_sandwich > 0:
                self.sandwich_bounced_flushes += 1

        if primes_bought_by_sandwich > 0:
            ton_back = self.pool.swap_primes_for_ton(primes_bought_by_sandwich)
            pnl = ton_back - front
            self.sandwich_net_pnl_ton += pnl
            if pnl > 0:
                self.sandwich_gross_profit_ton += pnl
                self.sandwich_extracted_ton += pnl

        if self.p.staking.enabled:
            self._assert_t_identity()

    def _simulate_sandwich(self, amount: float, front: float) -> tuple[float, float]:
        """Dry-run a front-run of size `front` against a flush the ATTACKER then
        sizes (D-143: the caller picks `amount`, clamped one-way). Returns the
        attacker's PnL and the flush size it would send."""
        from .amm import Pool

        if front <= 0:
            return 0.0, amount
        sim = Pool(self.pool.ton_reserve, self.pool.primes_reserve, self.pool.fee)
        got = sim.swap_ton_for_primes(front)
        sized = amount
        if self.p.floor_guard_enabled and self.S > 0:
            sized = min(amount, sim.max_in_at_floor(self.T / self.S, self.p.floor_guard))
        if sized > 0:
            sim.swap_ton_for_primes(sized)
        else:
            sized = amount  # no size fills: the flush the attacker sends bounces
        return sim.swap_primes_for_ton(got) - front, sized

    def _maybe_external_flow(self, t: float):
        """Exogenous market demand. Zero in the baseline: SS5's claim is that the
        ratchet works with **no external buyers**. A non-zero rate is used only
        to construct the "market stays above the floor for months" regime that
        SS10 asks `pending` to be measured in."""
        rate = self.p.external_buy_ton_per_day
        if rate <= 0 or self.pool is None:
            return
        while self._next_external_buy_t <= t:
            self.pool.swap_ton_for_primes(rate)
            self.external_bought_ton += rate
            self._next_external_buy_t += DAY

    # ------------------------------------------------------------------ #
    # Whale dumps / claims
    # ------------------------------------------------------------------ #
    def _maybe_whale_dump(self, t: float):
        while self._next_whale_check_t <= t:
            bal = self.wallet_primes_balance.get(self._whale_wallet, 0.0)
            if bal > 0 and self.pool is not None:
                amt = bal * self.p.whale_dump_frac_of_holdings
                got = self.pool.swap_primes_for_ton(amt)
                self.wallet_primes_balance[self._whale_wallet] -= amt
                self.wallet_ton_balance[self._whale_wallet] = (
                    self.wallet_ton_balance.get(self._whale_wallet, 0.0) + got
                )
            self._next_whale_check_t += self.rng.exponential(
                DAY / max(self.p.whale_dump_rate_per_day, 1e-9)
            )

    def _whale_accrue(self, ev: MintEvent):
        skim = ev.rebate_primes * 0.05
        if skim > 0:
            self.wallet_primes_balance[self._whale_wallet] = (
                self.wallet_primes_balance.get(self._whale_wallet, 0.0) + skim
            )

    def _process_claims(self, t, archetype, primes_involved):
        for prime in primes_involved:
            owner = self.ownership.get(prime)
            if owner is None:
                continue
            owed = self.owed.get(prime, 0.0)
            flat = self.div_acc - self.div_entry.get(prime, self.div_acc)
            total = owed + flat
            if total <= 0:
                continue
            if claims_tribute_immediately(archetype) or self.rng.random() < 0.05:
                self.owed[prime] = 0.0
                self.div_entry[prime] = self.div_acc
                self.claimed_total[prime] = self.claimed_total.get(prime, 0.0) + total
                self.wallet_ton_balance[owner] = self.wallet_ton_balance.get(owner, 0.0) + total

    # ------------------------------------------------------------------ #
    # Main loop
    # ------------------------------------------------------------------ #
    def run(self):
        horizon_seconds = self.p.horizon_days * DAY
        t = 0.0
        mint_index = 0
        declines_here = 0
        self._record_history(t, mint_index)

        while t < horizon_seconds and self.head <= self.p.n_max:
            if self.p.max_mints is not None and mint_index >= self.p.max_mints:
                break
            self.arrivals.next_gap(self.head)
            t = self.arrivals.t
            if t >= horizon_seconds:
                break

            self._maybe_external_flow(t)
            self._maybe_whale_dump(t)
            self._maybe_flush(t)
            self.arrivals_seen += 1

            archetype, wallet_id = self.agents.next_minter()
            extra_wait = mint_delay_seconds(archetype, self.p.ramp_seconds, self.rng)
            t += extra_wait

            # D-20: the head is defined over composites and Unity. A prime is
            # never in its path -- it opens as a Dutch lot and the head walks
            # straight past it, so no arrival is consumed and nothing can park.
            if self.p.primes_skip_head:
                while self.head <= self.p.n_max and self.sieve.is_prime(self.head):
                    self._open_prime_lot(self.head, t)
                    self.head += 1
                    self._head_since_t = t
                if self.head > self.p.n_max:
                    break

            n = self.head
            if self.sieve.is_prime(n) and not self._accepts_prime(n):
                declines_here += 1
                self.prime_declines += 1
                continue  # the head parks: nobody else can mint past it

            dwell = max(t - self._head_since_t, 0.0)
            ev = self._do_mint(n, t, archetype, wallet_id, mint_index, dwell, declines_here)
            self.head += 1
            self._head_since_t = t
            declines_here = 0
            mint_index += 1

            self._whale_accrue(ev)
            self._process_claims(t, archetype, self._last_factors(n))

            if archetype == Archetype.BOT_LOOP:
                burst = bot_loop_burst_length(self.rng) - 1
                for _ in range(burst):
                    if self.head > self.p.n_max or t >= horizon_seconds:
                        break
                    if self.p.max_mints is not None and mint_index >= self.p.max_mints:
                        break
                    t += self.rng.uniform(1, 30)
                    if self.p.primes_skip_head:
                        while self.head <= self.p.n_max and self.sieve.is_prime(self.head):
                            self._open_prime_lot(self.head, t)
                            self.head += 1
                            self._head_since_t = t
                        if self.head > self.p.n_max:
                            break
                    n2 = self.head
                    if self.sieve.is_prime(n2) and not self._accepts_prime(n2):
                        break  # even a bot loop is stopped by a prime it won't take
                    dwell2 = max(t - self._head_since_t, 0.0)
                    ev2 = self._do_mint(n2, t, archetype, wallet_id, mint_index, dwell2)
                    self.head += 1
                    self._head_since_t = t
                    mint_index += 1
                    self._whale_accrue(ev2)

            if mint_index % self.p.history_every_n_mints == 0:
                self._record_history(t, mint_index)

        self._record_history(t, mint_index)
        return self

    @property
    def circulating_primes(self) -> float:
        """Emitted minus burned — the TEP-74 `total_supply` this model implies.

        Deliberately NOT `S`. CONCEPT SS5 makes `S` cumulative emission that never
        decrements, so the floor `p_f = T/S` understates backing per circulating
        token; the size of that understatement is this number, and it is the one
        the dashboard shows next to `S` rather than instead of it (SS11.21).
        """
        return self.S - self.burned_primes

    def _last_factors(self, n: int) -> list[int]:
        if self.sieve.is_prime(n):
            return [n]
        return list(self.sieve.factorize(n).keys())

    def _record_history(self, t: float, mint_index: int):
        amm_price = self.pool.price_ton_per_primes if self.pool else float("nan")
        self.history.append(
            {
                "t_days": t / DAY,
                "mint_index": mint_index,
                "head": self.head,
                "T": self.T,
                "S": self.S,
                "pending": self.pending,
                "swapped": self.swapped,
                "floor_price": self.floor_price,
                "amm_price": amm_price,
                "pool_ton_reserve": self.pool.ton_reserve if self.pool else float("nan"),
                "pool_primes_reserve": self.pool.primes_reserve if self.pool else float("nan"),
                "treasury_total": self.treasury_total,
                "sandwich_extracted_ton": self.sandwich_extracted_ton,
                "div_acc": self.div_acc,
                "flush_fills": self.flush_fills,
                "flush_bounces": self.flush_bounces,
                "burned_primes": self.burned_primes,
                "circulating_primes": self.circulating_primes,
                "prime_declines": self.prime_declines,
            }
        )

    # ------------------------------------------------------------------ #
    # Trace export
    # ------------------------------------------------------------------ #
    def export_trace(self, path: str, extra_meta: dict | None = None) -> dict:
        import json

        events = [
            {
                "mint_index": ev.mint_index, "n": ev.n, "kind": ev.kind, "t": ev.t,
                "archetype": ev.archetype, "wallet_id": ev.wallet_id,
                "referred": ev.referred, "referral_number": ev.referral_number,
                "factors": {str(p): e for p, e in ev.factors.items()},
                "k": ev.k, "k_max_effective": ev.k_max_effective,
                "pool_injection": ev.pool_injection, "rebate_primes": ev.rebate_primes,
                "tribute_paid": ev.tribute_paid, "flat_dividend": ev.flat_dividend,
                "dwell_seconds": ev.dwell_seconds, "declines": ev.declines,
                "T_after": ev.T_after, "S_after": ev.S_after, "pending_after": ev.pending_after,
                "ops_swept_after": ev.ops_swept_after,
                "div_acc_after": ev.div_acc_after,
            }
            for ev in self.mint_log
        ]
        summary = {
            "final_head": self.head, "final_T": self.T, "final_S": self.S,
            "final_pending": self.pending, "final_swapped": self.swapped,
            "final_floor_price": self.floor_price, "final_treasury_total": self.treasury_total,
            "final_div_acc": self.div_acc,
            "total_mints": len(self.mint_log),
            "owed": {str(p): v for p, v in self.owed.items()},
            "claimed_total": {str(p): v for p, v in self.claimed_total.items()},
            "ownership": {str(n): w for n, w in self.ownership.items()},
            "wallet_primes_balance": {str(w): v for w, v in self.wallet_primes_balance.items()},
            "wallet_ton_balance": {str(w): v for w, v in self.wallet_ton_balance.items()},
            "sandwich_extracted_ton": self.sandwich_extracted_ton,
            "sandwich_net_pnl_ton": self.sandwich_net_pnl_ton,
            "sandwich_events": self.sandwich_events,
            "flush_fills": self.flush_fills, "flush_bounces": self.flush_bounces,
        }
        out = {"meta": extra_meta or {}, "events": events, "summary": summary}
        with open(path, "w") as f:
            json.dump(out, f, indent=1)
        return out


def _norm_ppf(q: float) -> float:
    """Inverse standard normal CDF (Acklam's rational approximation).

    Used only to calibrate the private-valuation lognormal; scipy is not a
    dependency of this package.
    """
    if not 0.0 < q < 1.0:
        raise ValueError(q)
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if q < plow:
        x = math.sqrt(-2 * math.log(q))
        return (((((c[0] * x + c[1]) * x + c[2]) * x + c[3]) * x + c[4]) * x + c[5]) / \
               ((((d[0] * x + d[1]) * x + d[2]) * x + d[3]) * x + 1)
    if q > phigh:
        x = math.sqrt(-2 * math.log(1 - q))
        return -(((((c[0] * x + c[1]) * x + c[2]) * x + c[3]) * x + c[4]) * x + c[5]) / \
               ((((d[0] * x + d[1]) * x + d[2]) * x + d[3]) * x + 1)
    x = q - 0.5
    r = x * x
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * x / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
