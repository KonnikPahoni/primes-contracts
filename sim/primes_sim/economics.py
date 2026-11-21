"""Core per-mint economics for CONCEPT.md **design draft v5**.

Covers the SS4.1 split (now with the SS3.2 80/20 tribute split: a divisor line
weighted `e*sqrt(p)` and a flat prime dividend accrued O(1) per mint), the SS5
rebate/ratchet with the SS5 uplift stack clamped at `K_CEIL`, and SS5.1's
zero-emission rule for prime mints.

Changes against v4 (UPGRADE_PLAN_V5.md SS3 items 1, 2, 4, 6):
  * divisor weighting is `e * p**0.5`, not the flat exponent `e`;
  * the 10% tribute line splits `1-f` / `f` into the divisor line and the flat
    prime dividend, the latter accrued as `div_acc += f * 0.10 / pi(n)`;
  * a prime mint pays `k = 0` unconditionally and its whole tribute line has no
    recipient, so it falls to the pool (SS4.1, SS4.2.1) -> beta = 0.75 referred;
  * `k_max` is the *sum* of the base curve and four uplifts, clamped once at
    `K_CEIL = 0.95`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .gas import gas_ops_draw_default, gas_ops_pct_default

# --------------------------------------------------------------------------- #
# Split (SS4.1) + tribute internal split (SS3.2)
# --------------------------------------------------------------------------- #


@dataclass
class SplitParams:
    tribute_pct: float = 0.10
    referral_pct: float = 0.10
    treasury_pct: float = 0.05
    # DECISIONS.md D-117: DERIVED, not chosen -- the measured worst-case mint's
    # draw on the line (contracts/gas-baseline.json `gas_ops_spend.*`), rounded
    # up to a whole percent. `gas.gas_ops_line` publishes every term.
    gas_ops_pct: float = field(default_factory=gas_ops_pct_default)
    # D-117 (owner, 2026-09-22): the part of the line a mint does NOT spend is
    # swept back into the ratchet pool by `sweep_ops` -- emission-free (k = 0,
    # no PRIMES), a pure floor raise. These are the MEASURED per-mint draws
    # (GasRegression `gas_ops_spend.composite_w2` / `.prime_purchase`).
    gas_ops_draw_composite_ton: float = field(default_factory=lambda: gas_ops_draw_default("composite"))
    gas_ops_draw_prime_ton: float = field(default_factory=lambda: gas_ops_draw_default("prime"))
    # SS3.2: the tribute line's own 80/20 split and the divisor weighting.
    flat_dividend_f: float = 0.20     # `f`: share of the tribute line paid flat
    divisor_exponent: float = 0.5     # the exponent on p in w(p) = e * p**exponent
    # D-106 DELETED SS4.1's patron line (phi1 = 0.25 on a recruit's activation
    # mint, phi2 = 0.075 after, to a cumulative PATRON_CAP = 1.00 TON). It is not
    # a rate that went to zero -- it is a line that no longer exists, which is
    # why there is no `patron_rate` argument left to pass anywhere below.


# --------------------------------------------------------------------------- #
# SS4.1's seventh line: invite transfers (TELEGRAM_INVITES_PLAN.md, owner 2026-11-07)
# --------------------------------------------------------------------------- #

# OWNER-SET, not the sim's to choose (CLAUDE.md rule 3 is not engaged): each
# invite is a plain non-bounceable 0.1 TON transfer with a fixed text comment,
# sent by the ledger to an address the minter supplies. It replaced D-101's
# 0.025 TON PRIME GENERATOR item deploy, which reached no wallet. The contract's
# per-transfer value must equal this one.
INVITE_TRANSFER_VALUE_TON: float = 0.1

# D-114 -- OWNER-SET, not the sim's to choose: an auction lot's premium above
# MINT_PRICE + RES_GAS splits this share (basis points) to the governed treasury;
# the rest reaches the ratchet as `pending`. params.json `genesis.premium_treasury_bps`.
PREMIUM_TREASURY_BPS: int = 5000

# OWNER-SET (TELEGRAM_INVITES_PLAN.md, 2026-11-07, like D-101 call 2): the minter
# supplies 0..3 recipient addresses in the mint message.
INVITE_MAX_COUNT: int = 3

# ASSUMED, NOT MEASURED. The webapp checkout has no invite toggle: it declares
# INVITE_MAX_COUNT on every mint (owner directive 2026-09-16,
# webapp/src/components/MintCheckout/invites.ts), so the rate is 1.0. It was 0.80,
# a planning figure from when the checkout offered 5-or-0. Not modelled: agent-SDK
# mints that send none, and short keeper lists (unspent slots fall to beta) -- so
# this is the UPPER bound on the line's spend. Any params.json block that publishes
# it carries `INVITE_OPTIN_RATE_LABEL` as its `_source`.
INVITE_OPTIN_RATE_ASSUMED: float = 1.0
INVITE_OPTIN_RATE_LABEL: str = (
    "ASSUMED, not measured: 1.0 -- the webapp checkout fills 3 invite recipients on "
    "every mint (owner directive 2026-09-16, no toggle). Not modelled: agent-SDK mints "
    "sending none and short keeper lists, so this is the upper bound on the line's "
    "spend. Replace with the realised share once invited mints exist "
    "(GAUNTLET.md J12, TELEGRAM_INVITES_PLAN.md)."
)


@dataclass
class SplitResult:
    tribute_paid: float          # TON actually paid out of the tribute line (divisor line only)
    tribute_to_pool: float       # tribute TON with no recipient -> pool
    flat_dividend: float         # TON accrued to `div_acc` (flat prime dividend)
    referral_paid: float
    referral_to_pool: float
    treasury: float
    gas_ops: float
    pool_injection: float        # beta * P
    recipient_shares: dict       # {owner_id: ton} over the divisor line
    invite_paid: float = 0.0     # TON leaving as invite transfers (SS4.1)
    invite_to_pool: float = 0.0  # unspent invite slots -> pool (D-101 call 3)
    # D-117: the unspent gas & ops line, swept back into the pool with NO emission.
    # A part of `gas_ops`, not of `pool_injection`: the rebate is k * beta * P and
    # this TON never enters beta, so it raises T without raising S.
    ops_surplus_to_pool: float = 0.0


def divisor_weights(
    factors: dict[int, int],
    exponent: float = 0.5,
    multipliers: dict[int, float] | None = None,
) -> dict[int, float]:
    """SS3.2: w(p) = e * p**exponent, times any constellation/rank multiplier.

    Returns raw (un-normalised) weights keyed by prime.
    """
    out: dict[int, float] = {}
    for p, e in factors.items():
        w = float(e) * (float(p) ** exponent)
        if multipliers:
            w *= multipliers.get(p, 1.0)
        out[p] = w
    return out


def split_mint(
    price_ton: float,
    factor_owners: dict[int, float] | None,
    referral_owner,
    params: SplitParams = SplitParams(),
    minted_primes_count: int = 0,
    is_prime_mint: bool = False,
    invite_count: int = 0,
    invitees_served: int | None = None,
) -> SplitResult:
    """Compute the SS4.1 split for one mint.

    `factor_owners`: {owner_id: weight} normalised to sum to 1 across the
    *divisor line's* recipients (already `e*sqrt(p)`- and multiplier-weighted).
    `minted_primes_count`: pi(n), the number of minted primes that share the
    flat dividend. Only used to make the per-prime accrual meaningful upstream.
    `is_prime_mint`: SS4.1/SS4.2.1 -- on a prime mint the tribute line "resolves
    to the empty set and falls to the pool", which is what puts beta at 0.75 on
    the referred steady-state prime row. That covers *both* tribute lines: the
    divisor line has no factor owner and the flat dividend is not accrued
    either, since the mint's own number is not yet minted when the line is
    computed and SS4.2.1's worked example books the whole 0.10 to the pool.
    `invite_count`: SS4.1's seventh line -- `0..3` invite transfers at
    `INVITE_TRANSFER_VALUE_TON` each, an ABSOLUTE TON amount deducted ahead of the
    residual, not a percentage of the price. Defaults to 0, so an uninvited mint
    splits exactly as it did before the line existed.
    `invitees_served`: how many of those slots the minter's recipient list
    actually supplied an address for. `None` means all of them. A slot with no
    address is not sent anywhere -- it stays in the residual and backs the floor
    (D-101 call 3), which is the same shape as `tribute_to_pool` below: the
    to-pool terms are reported for the audit trail and are never *subtracted*
    from `pool_injection`, because they never left it.
    """
    # `invite_count` is the number of recipient addresses in the mint message,
    # so a non-integer is not a value the contract can be handed -- type-checked
    # here rather than silently deducting 2.5 slots' worth of TON.
    if isinstance(invite_count, bool) or not isinstance(invite_count, int):
        raise TypeError(
            f"invite_count is a count of addresses, not a {type(invite_count).__name__}"
        )
    if not 0 <= invite_count <= INVITE_MAX_COUNT:
        raise ValueError(
            f"invite_count must be 0..{INVITE_MAX_COUNT} (SS4.1), got {invite_count}"
        )
    served = invite_count if invitees_served is None else min(max(invitees_served, 0), invite_count)
    invite_paid = served * INVITE_TRANSFER_VALUE_TON
    invite_to_pool = (invite_count - served) * INVITE_TRANSFER_VALUE_TON

    tribute_line = params.tribute_pct * price_ton
    referral_line = params.referral_pct * price_ton
    treasury = params.treasury_pct * price_ton
    gas_ops = params.gas_ops_pct * price_ton

    f = params.flat_dividend_f
    divisor_line = tribute_line * (1.0 - f)
    flat_line = tribute_line * f

    recipient_shares: dict = {}
    if is_prime_mint:
        tribute_paid = 0.0
        flat_dividend = 0.0
        tribute_to_pool = tribute_line
    else:
        if factor_owners:
            tribute_paid = divisor_line
            tribute_to_pool = 0.0
            for owner, w in factor_owners.items():
                recipient_shares[owner] = recipient_shares.get(owner, 0.0) + w * divisor_line
        else:
            tribute_paid = 0.0
            tribute_to_pool = divisor_line
        if minted_primes_count > 0:
            flat_dividend = flat_line
        else:
            flat_dividend = 0.0
            tribute_to_pool += flat_line

    if referral_owner is not None:
        referral_paid = referral_line
        referral_to_pool = 0.0
    else:
        referral_paid = 0.0
        referral_to_pool = referral_line

    pool_injection = (
        price_ton - treasury - gas_ops - tribute_paid - flat_dividend - referral_paid
        - invite_paid
    )
    # `I = beta*P > 0` is the one premise docs/math-note.md's ratchet theorem still
    # needs ("as long as the split's leftover residual stays positive"). Every line
    # but the seventh is a RATE, so the residual is price-independent -- the invite
    # line is an ABSOLUTE 0.1 TON per slot, so at a low enough price it eats past
    # the residual and the pool would fund the invitations. Unreachable in the
    # shipped game (MINT_PRICE is a flat 1 TON and a prime's lane rests at
    # max(NPV(p)/2, P0(p)/3, MINT_PRICE)), which is exactly why it is an assert: this
    # function is the reference phase 2's ledger is written from, and this is the
    # line that fails if a future price change makes it reachable.
    assert pool_injection > 0.0, (
        f"SS4.1 residual is not positive ({pool_injection:.6f} TON at price "
        f"{price_ton}, invite_count {invite_count}): the ratchet theorem's I > 0 "
        f"premise fails and the pool would be funding the deducted lines"
    )
    return SplitResult(
        tribute_paid=tribute_paid,
        tribute_to_pool=tribute_to_pool,
        flat_dividend=flat_dividend,
        referral_paid=referral_paid,
        referral_to_pool=referral_to_pool,
        treasury=treasury,
        gas_ops=gas_ops,
        pool_injection=pool_injection,
        recipient_shares=recipient_shares,
        invite_paid=invite_paid,
        invite_to_pool=invite_to_pool,
        ops_surplus_to_pool=max(
            gas_ops - (params.gas_ops_draw_prime_ton if is_prime_mint else params.gas_ops_draw_composite_ton),
            0.0,
        ),
    )


def beta(
    is_prime_mint: bool,
    referred: bool,
    params: SplitParams = SplitParams(),
    invite_count: int = 0,
    price_ton: float = 1.0,
) -> float:
    """SS4.1's beta table, computed rather than tabulated.

    D-106 collapsed this from six rows to TWO -- (prime | composite) x (referred
    | not) with the patron line deleted -- so the only remaining spread is the
    invite line.

    Returns the residual as a FRACTION of the mint price. Every line but the
    seventh is a rate, so they are price-free; SS4.1's seventh line is an
    absolute `invite_count * INVITE_TRANSFER_VALUE_TON` (D-101 call 1), so it needs
    the price to be expressed as a fraction -- `price_ton` defaults to the flat
    all-in 1 TON mint of SS4, which is the price the table is stated for.
    `invite_count` defaults to 0, so the base values are unchanged for anyone who
    does not opt in.
    """
    b = 1.0 - params.treasury_pct - params.gas_ops_pct
    if not is_prime_mint:
        b -= params.tribute_pct
    if referred:
        b -= params.referral_pct
    b -= invite_count * INVITE_TRANSFER_VALUE_TON / price_ton
    return b


def beta_expected(
    is_prime_mint: bool,
    referred: bool,
    params: SplitParams = SplitParams(),
    invite_count: int = INVITE_MAX_COUNT,
    optin_rate: float = INVITE_OPTIN_RATE_ASSUMED,
    price_ton: float = 1.0,
) -> float:
    """Population-mean beta over a cohort where `optin_rate` of the mints tick
    the checkout's invite box (D-101 call 2: it offers `INVITE_MAX_COUNT` or 0).

    `optin_rate` is an ASSUMPTION -- see `INVITE_OPTIN_RATE_LABEL`, which is the
    `_source` any published figure derived from this must carry.
    """
    opted = beta(is_prime_mint, referred, params, invite_count, price_ton)
    plain = beta(is_prime_mint, referred, params, 0, price_ton)
    return optin_rate * opted + (1.0 - optin_rate) * plain


# --------------------------------------------------------------------------- #
# Rebate / emission (SS5, SS5.1)
# --------------------------------------------------------------------------- #


@dataclass
class UpliftParams:
    """SS5's four uplifts and the single clamp that sits on their sum."""

    k_ceil: float = 0.95
    prime_uplift: float = 0.06
    prime_window: int = 5
    newcomer_uplift: float = 0.05
    newcomer_window: int = 5
    # rank -> k_max uplift, per ladder (SS4.7, SS4.7.1)
    recruit_rank_uplifts: tuple[float, ...] = (0.0, 0.010, 0.020, 0.035, 0.050, 0.080)
    prime_rank_uplifts: tuple[float, ...] = (0.0, 0.010, 0.020, 0.035, 0.050, 0.080)
    recruit_rank_tiers: tuple[int, ...] = (1, 3, 10, 30, 100)
    prime_rank_tiers: tuple[int, ...] = (1, 3, 10, 30, 100)

    def __post_init__(self):
        # SS5: the ratchet theorem needs k < 1 on every mint, and K_CEIL is the ONE
        # clamp that guarantees it. A ceiling at or above 1 would be accepted and
        # silently void the theorem for every stacked-uplift mint.
        if not 0.0 < self.k_ceil < 1.0:
            raise ValueError(f"k_ceil must be in (0, 1) -- k < 1 is SS5's ratchet invariant; got {self.k_ceil}")


def rank_of(count: int, tiers) -> int:
    """0..5 tier index for a lifetime counter against SS4.7's ladder."""
    r = 0
    for t in tiers:
        if count >= t:
            r += 1
    return r


def k_of_t(t_seconds: float, k_min: float, k_max: float, ramp: float) -> float:
    """SS5: k(t) = k_min + (k_max-k_min)*min(1, t/ramp) -- a LINEAR ramp that
    reaches k_max exactly at t = ramp (D-98) and holds there. The pre-D-98 form
    was exponential with `ramp` as its time constant, which only ever got to 63%
    of the band in the first hour and never reached the ceiling at all.
    """
    if t_seconds <= 0:
        return k_min
    if ramp <= 0:
        raise ValueError(f"ramp must be > 0 seconds (SS5's linear ramp); got {ramp}")
    return k_min + (k_max - k_min) * min(1.0, t_seconds / ramp)


def k_max_of_n(n: int, n0: int, cap: float, k_min: float) -> float:
    """SS5: k_max(n) = cap for n<=n0, else cap*ln(n0)/ln(n), clamped >= k_min."""
    if n <= n0:
        return cap
    val = cap * math.log(n0) / math.log(n)
    return max(val, k_min)


def k_max_effective(
    n: int,
    n0: int,
    cap: float,
    k_min: float,
    up: UpliftParams,
    recruit_rank: int = 0,
    prime_rank: int = 0,
    in_prime_window: bool = False,
    in_newcomer_window: bool = False,
) -> tuple[float, bool]:
    """SS5's stacked ceiling: base curve + four uplifts, **summed then clamped
    once** at `K_CEIL`. Returns (k_max, clamp_bound)."""
    base = k_max_of_n(n, n0, cap, k_min)
    total = (
        base
        + up.recruit_rank_uplifts[min(recruit_rank, len(up.recruit_rank_uplifts) - 1)]
        + up.prime_rank_uplifts[min(prime_rank, len(up.prime_rank_uplifts) - 1)]
        + (up.prime_uplift if in_prime_window else 0.0)
        + (up.newcomer_uplift if in_newcomer_window else 0.0)
    )
    if total >= up.k_ceil:
        return up.k_ceil, True
    return total, False


# D-156: the logistic supply cap. `S_MAX` is OWNER-SET, not sim-selected -- the
# same standing D-154 gave `genesis_donation_ton`. The sim CONSUMES this figure
# and re-derives the emission curve, the floor and every dependent block from it;
# it does not choose it. `shared/params.json rebate.S_MAX` is the authority.
S_MAX_PRIMES: float = 1_200_000_000.0


def supply_taper(s: float, s_max: float) -> float:
    """D-156: the factor that turns SS5's emission logistic.

    `k_eff = k * (S_MAX - S) / S_MAX`, so `dS/S = k*(1 - S/S_MAX)*beta/T` and `S`
    approaches `S_MAX` asymptotically without ever reaching it.

    This is a SEPARATE factor applied at the emission site, deliberately NOT
    folded into `k_max_of_n`: the contract applies it at `storage.S +=` for the
    same reason (the `atKMin` settlement branch bypasses `k_of_t` entirely), and
    `k_max` is also the figure the webapp's `KMaxCurve` draws -- tapering that
    would draw a curve the ladder does not use.

    `k` only ever shrinks, so SS5's single `K_CEIL` clamp still governs the summed
    uplifts and the ratchet theorem strengthens rather than needing rework
    (`docs/math-note.md` SS2 is agnostic to WHY `k < 1`).
    """
    if s_max <= 0:
        return 1.0
    if s >= s_max:
        return 0.0
    return (s_max - s) / s_max


def rebate_primes(pool_injection: float, k: float, floor_price: float) -> float:
    """R(t) = k * pool_injection / p_f, in PRIMES. Guards p_f==0 (pre-genesis)."""
    if floor_price <= 0:
        return 0.0
    return k * pool_injection / floor_price


# --------------------------------------------------------------------------- #
# SS5.1's headroom table (UPGRADE_PLAN_V5.md SS3 item 4)
# --------------------------------------------------------------------------- #


def headroom_row(
    n: int,
    up: UpliftParams,
    n0: int = 1000,
    cap: float = 0.9,
    k_min: float = 0.2,
    beta_composite: float = 0.65,
    beta_prime: float = 0.75,
    price_ton: float = 1.0,
) -> dict:
    """One row of SS5.1's table.

    credit value   = min(PRIME_UPLIFT, headroom) * PRIME_WINDOW * beta*P
    rebate forgone = k_max(n) * beta_prime * P
    """
    km = k_max_of_n(n, n0, cap, k_min)
    headroom = up.k_ceil - km
    credit = min(up.prime_uplift, headroom) * up.prime_window * beta_composite * price_ton
    forgone = km * beta_prime * price_ton
    return {
        "n": n,
        "k_max_n": km,
        "headroom_to_k_ceil": headroom,
        "credit_value_ton": credit,
        "rebate_forgone_ton": forgone,
        "protocol_nets_ton": forgone - credit,
        "compensation_share": (credit / forgone) if forgone > 0 else float("inf"),
        "invariant_uplift_x_window_lt_kmax": up.prime_uplift * up.prime_window < km,
    }


def headroom_table(up: UpliftParams, ns=(1000, 10_000, 100_000, 1_000_000), **kw) -> list[dict]:
    return [headroom_row(n, up, **kw) for n in ns]


# --------------------------------------------------------------------------- #
# SS5.4's rotation curve (LATE_GAME_PLAN.md SS3 item 1 -- the one mandatory L1
# output, and the one thing L1 exists to falsify)
# --------------------------------------------------------------------------- #


def x_star(k_max: float, beta_: float, c: float = 0.10) -> float:
    """SS8.1's premium ceiling `x* = (1-c)/(k_max * beta)`.

    `c` is the cash a self-referred loop recovers outside the rebate: 0.10 for
    self-referral alone, 0.40 for a minter who also sends its own invite
    transfers to itself (3 x 0.1 TON, TELEGRAM_INVITES_PLAN.md) -- in which case
    `beta_` must be the invited row (0.25 referred composite), not the plain one.
    """
    denom = k_max * beta_
    return float("inf") if denom <= 0 else (1.0 - c) / denom


def asset_share_row(
    n: int,
    n0: int = 1000,
    cap: float = 0.9,
    k_min: float = 0.2,
    params: SplitParams = SplitParams(),
    beta_composite: float = 0.65,
    price_ton: float = 1.0,
    c_recovered: float = 0.10,
    divisor_realisation: float = 1.0,
    referral_realisation: float = 1.0,
) -> dict:
    """One row of SS5.4's rotation table, for a *composite* mint at n.

    The claim under test (LATE_GAME_PLAN.md SS1.1): the asset side's share of
    each mint's value rises monotonically with `n` **because the rebate is the
    only leg of the split carrying an `n` term**. Nothing here grows; the
    columns that are flat are flat by construction and the one that decays is
    `k_max(n) = 2.7/log10(n)`.

    Legs, all from SS4.1 and none of them invented here:

      * divisor tribute   `(1-f) * tribute_pct * P`, realised only when the
        minted number's prime-factor NFTs have owners (`divisor_realisation`);
      * flat dividend     `f * tribute_pct * P`, realised once pi(n) > 0;
      * referral          `referral_pct * P`, realised on a valid key
        (`referral_realisation`; SS4.1 treats universal self-referral as the
        expected outcome, so 1.0 is the planning case);
      * rebate            `k_max(n) * beta * P` **valued at the floor**, which
        is the upper bound on emission at n, not the expected one.

    `rebate_value_at_x_star_ton` is the same rebate valued at SS8.1's ceiling
    and is the honest counterweight to the whole section: at `x = x*` the
    rebate is worth `1 - c` TON **for every n**, because `x*` divides out the
    very `k_max(n)` the rotation is made of. The rotation is a
    floor-denominated statement and SS5.4 must say so.
    """
    km = k_max_of_n(n, n0, cap, k_min)
    tribute_line = params.tribute_pct * price_ton
    divisor_line = tribute_line * (1.0 - params.flat_dividend_f) * divisor_realisation
    flat_line = tribute_line * params.flat_dividend_f
    referral = params.referral_pct * price_ton * referral_realisation
    asset_side = divisor_line + flat_line + referral
    rebate_floor = km * beta_composite * price_ton
    xs = x_star(km, beta_composite, c_recovered)
    rebate_at_x_star = rebate_floor * xs if xs != float("inf") else float("inf")
    return {
        "n": n,
        "k_max_n": km,
        "beta_composite": beta_composite,
        "divisor_line_ton": divisor_line,
        "flat_dividend_ton": flat_line,
        "referral_ton": referral,
        "asset_side_ton": asset_side,
        "rebate_value_at_floor_ton": rebate_floor,
        "asset_share_at_floor": asset_side / (asset_side + rebate_floor),
        "x_star": xs,
        "rebate_value_at_x_star_ton": rebate_at_x_star,
        "asset_share_at_x_star": asset_side / (asset_side + rebate_at_x_star),
    }


def asset_share_curve(
    ns=(1000, 10_000, 100_000, 1_000_000),
    **kw,
) -> dict:
    """SS5.4's table plus the kill criterion of LATE_GAME_PLAN.md SS3 item 5.

    If `monotone_at_floor` is False the central sentence of SS5.4 is false and
    L0 ships without it. Nothing else in this module is allowed to paper over
    that: the flag is returned, not asserted away.
    """
    rows = [asset_share_row(n, **kw) for n in ns]
    at_floor = [r["asset_share_at_floor"] for r in rows]
    at_x_star = [r["asset_share_at_x_star"] for r in rows]
    return {
        "rows": rows,
        "monotone_at_floor": all(b > a for a, b in zip(at_floor, at_floor[1:])),
        "monotone_at_x_star": all(b > a for a, b in zip(at_x_star, at_x_star[1:])),
        "asset_share_at_floor_range": [at_floor[0], at_floor[-1]],
        "asset_share_at_x_star_range": [at_x_star[0], at_x_star[-1]],
        "_kill_criterion": (
            "LATE_GAME_PLAN.md SS3 item 5: the asset side's share of mint value "
            "must rise monotonically across the horizon at the floor. It does NOT "
            "rise at x*, and that is not a failure -- x* is proportional to "
            "1/k_max(n), so it divides the decay term out exactly. SS5.4 states "
            "the rotation at the floor and discloses the x* row next to it."
        ),
    }
