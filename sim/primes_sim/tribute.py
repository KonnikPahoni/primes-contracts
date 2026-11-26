"""Tribute-line structure over the true factorization of the number line
(CONCEPT.md SS3.2), independent of the agent simulation.

Three things live here, all computed by sweeping the real factorization of
every n up to a horizon rather than by sampling:

  * `band_shares` -- SS3.2's band tables (flat vs `sqrt(p)` vs `p` weighting).
    This is the regression target named in UPGRADE_PLAN_V5.md SS3 item 1:
    primes > 200 must land at 58.5% of the divisor line at n = 1e5.
  * `flat_dividend_shares` -- the `f`-dial: the flat prime dividend accrued as
    `div_acc += f * 0.10 / pi(n)` per mint, credited only from the block a
    prime is minted onward (SS3.2.1).
  * `prime_tribute_npv` -- for every prime p, the discounted value at its own
    mint of every future tribute payment it will receive up to the horizon.
    Used by the prime-head model (SS10) and by SS5.1's repayment claim.
"""
from __future__ import annotations

import math

import numpy as np

FIRST_TEN = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29)


def spf_sieve(n_max: int) -> np.ndarray:
    spf = np.arange(n_max + 1, dtype=np.int64)
    for i in range(2, int(n_max ** 0.5) + 1):
        if spf[i] == i:
            spf[i * i:: i] = np.minimum(spf[i * i:: i], i)
    return spf


def factorize(spf: np.ndarray, n: int) -> dict[int, int]:
    f: dict[int, int] = {}
    while n > 1:
        p = int(spf[n])
        e = 0
        while n % p == 0:
            n //= p
            e += 1
        f[p] = e
    return f


def _weight(p: int, e: int, mode: str) -> float:
    if mode == "flat":
        return float(e)
    if mode == "sqrt":
        return e * math.sqrt(p)
    if mode == "p":
        return float(e) * p
    raise ValueError(mode)


def band_of(p: int) -> str:
    if p in FIRST_TEN:
        return "first_10"
    if p < 200:
        return "31_199"
    if p <= 1000:
        return "200_1000"
    if p <= 10_000:
        return "1k_10k"
    return "gt_10k"


BANDS = ("first_10", "31_199", "200_1000", "1k_10k", "gt_10k")


def divisor_line_shares(horizon: int, mode: str = "sqrt",
                        spf: np.ndarray | None = None) -> dict[int, float]:
    """Share of the *divisor line* accruing to each prime when every n in
    [2, horizon] is minted once. Primes contribute nothing (their line falls to
    the pool, SS4.1).

    There is no reweighting argument any more: D-102 deleted SS3.2.2's x3/2
    constellation multiplier, which was the only thing that ever passed one, and
    with it `constellation_crowding` -- the blue-chip crowding check and kill
    criterion 4, which passed at -2.68% here against a -10% threshold. `w(p) = e * sqrt(p)` is the whole divisor weighting."""
    if spf is None:
        spf = spf_sieve(horizon)
    acc: dict[int, float] = {}
    for n in range(2, horizon + 1):
        f = factorize(spf, n)
        if len(f) == 1 and next(iter(f.values())) == 1:
            continue  # prime mint: no divisor recipients
        w = {p: _weight(p, e, mode) for p, e in f.items()}
        tot = sum(w.values())
        for p, x in w.items():
            acc[p] = acc.get(p, 0.0) + x / tot
    return acc


def flat_dividend_shares(horizon: int, spf: np.ndarray | None = None) -> dict[int, float]:
    """Share of the *flat dividend line* accruing to each prime, accrued
    `1/pi(n)` per mint from the block that prime is minted onward (SS3.2.1)."""
    if spf is None:
        spf = spf_sieve(horizon)
    pi = 0
    harm = 0.0
    baseline: dict[int, float] = {}
    for n in range(2, horizon + 1):
        if spf[n] == n:
            pi += 1
            baseline[n] = harm  # accrual starts now
        if pi > 0:
            harm += 1.0 / pi
    return {p: harm - b for p, b in baseline.items()}


def band_shares(horizon: int, mode: str = "sqrt", f: float = 0.0, spf: np.ndarray | None = None) -> dict:
    """Aggregate share of the tribute line by band.

    `f = 0` reproduces SS3.2's published band tables (which measure the divisor
    line alone); `f = 0.2` shows what the flat dividend does to them.
    """
    if spf is None:
        spf = spf_sieve(horizon)
    div = divisor_line_shares(horizon, mode, spf)
    flat = flat_dividend_shares(horizon, spf) if f > 0 else {}
    div_tot = sum(div.values()) or 1.0
    flat_tot = sum(flat.values()) or 1.0
    per_prime: dict[int, float] = {}
    for p, v in div.items():
        per_prime[p] = per_prime.get(p, 0.0) + (1.0 - f) * v / div_tot
    for p, v in flat.items():
        per_prime[p] = per_prime.get(p, 0.0) + f * v / flat_tot
    total = sum(per_prime.values()) or 1.0
    out = {b: 0.0 for b in BANDS}
    for p, v in per_prime.items():
        out[band_of(p)] += v / total
    out["all_gt_200"] = sum(v for p, v in per_prime.items() if p > 200) / total
    out["_horizon"] = horizon
    out["_mode"] = mode
    out["_f"] = f
    return out


def lifetime_ceiling_table(horizon: int, spf: np.ndarray | None = None, primes=(2, 211, 1009, 9973, 49999)) -> list[dict]:
    """SS3.2's "why the exponent is 1/2" table: a prime's realised divisor-line
    income against the structural ceiling 0.10 * N/p."""
    if spf is None:
        spf = spf_sieve(horizon)
    modes = {m: divisor_line_shares(horizon, m, spf) for m in ("flat", "sqrt", "p")}
    rows = []
    for p in primes:
        if p > horizon:
            continue
        mult = horizon // p - 1
        ceiling = 0.10 * horizon / p
        row = {"p": p, "multiples": mult, "ceiling_ton": ceiling}
        for m, acc in modes.items():
            # each mint pays 0.10 GRAM of tribute line; shares above are per-mint fractions
            row[m + "_ton"] = acc.get(p, 0.0) * 0.10
            row[m + "_pct_of_ceiling"] = row[m + "_ton"] / ceiling * 100.0 if ceiling else 0.0
        rows.append(row)
    return rows


def prime_tribute_npv(
    horizon: int,
    spf: np.ndarray | None = None,
    exponent: float = 0.5,
    f: float = 0.20,
    tribute_pct: float = 0.10,
    discount_rate_annual: float = 0.35,
    mints_per_year: float = 30_000.0,
) -> dict:
    """For every prime p <= horizon, the value at p's own mint of every tribute
    payment p receives from mint p+1 up to `horizon`, discounted at
    `discount_rate_annual` with mint index used as the clock.

    One backward sweep: maintain, for each prime, the running discounted sum of
    its future cash flows; when the sweep reaches p itself, that running sum
    *is* p's NPV (rebased to p's own mint index).

    Returns {"npv": {p: ton}, "undiscounted": {p: ton},
             "repay_head_multiple": {p: c or None}} where `c` is the multiple of
    p the head must reach for cumulative *undiscounted* tribute to repay the
    1 GRAM mint price (SS5.1's "about 12p / 20p" claim).
    """
    if spf is None:
        spf = spf_sieve(horizon)
    r_per_mint = discount_rate_annual / mints_per_year  # continuous-ish, small
    div_line = tribute_pct * (1.0 - f)
    flat_line = tribute_pct * f

    # pi(n) for the flat accrual
    is_prime = np.zeros(horizon + 1, dtype=bool)
    idx = np.arange(horizon + 1)
    is_prime[2:] = spf[2:] == idx[2:]
    pi = np.cumsum(is_prime)

    acc: dict[int, float] = {}          # discounted (to index 0) future flows
    undisc: dict[int, float] = {}
    npv: dict[int, float] = {}
    undisc_at_mint: dict[int, float] = {}

    # Backward sweep. discount factor to index 0 = exp(-r*n)
    for n in range(horizon, 1, -1):
        if is_prime[n]:
            d = math.exp(-r_per_mint * n)
            npv[n] = acc.get(n, 0.0) / d
            undisc_at_mint[n] = undisc.get(n, 0.0)
            continue
        d = math.exp(-r_per_mint * n)
        fac = factorize(spf, n)
        w = {p: e * (p ** exponent) for p, e in fac.items()}
        tot = sum(w.values())
        for p, x in w.items():
            cash = div_line * x / tot
            acc[p] = acc.get(p, 0.0) + cash * d
            undisc[p] = undisc.get(p, 0.0) + cash
        # flat dividend: every already-minted prime shares flat_line/pi(n)
        # (handled analytically below to stay O(N); see flat_component)
    # flat dividend component, per prime, computed with the harmonic trick
    harm_d = 0.0
    harm_u = 0.0
    flat_npv: dict[int, float] = {}
    flat_undisc: dict[int, float] = {}
    for n in range(2, horizon + 1):
        pin = int(pi[n])
        if is_prime[n]:
            flat_npv[n] = -harm_d
            flat_undisc[n] = -harm_u
        if pin > 0:
            harm_d += math.exp(-r_per_mint * n) * flat_line / pin
            harm_u += flat_line / pin
    for p in list(flat_npv.keys()):
        d = math.exp(-r_per_mint * p)
        npv[p] = npv.get(p, 0.0) + (flat_npv[p] + harm_d) / d
        undisc_at_mint[p] = undisc_at_mint.get(p, 0.0) + (flat_undisc[p] + harm_u)

    return {"npv": npv, "undiscounted": undisc_at_mint}


def prime_resting_tribute(
    window_mints: int,
    prime_bound: int,
    spf: np.ndarray | None = None,
    exponent: float = 0.5,
    f: float = 0.20,
    tribute_pct: float = 0.10,
) -> dict[int, float]:
    """DECISIONS.md D-218: for every prime p <= `prime_bound`, the tribute p
    collects from the `window_mints` composite mints that follow its own turn
    (head = p), undiscounted, in GRAM. This IS the resting price of p's
    descending lot, floored at MINT_PRICE by the caller.

    Mirrors the ledger, not `prime_tribute_npv`: the flat dividend
    (`f * tribute_pct`, `TRIBUTE_FLAT_AMOUNT` 0.02 GRAM) accrues on COMPOSITE
    mints only and is divided by pi(n) = the primes BELOW n (primes_ledger.tolk,
    the `hasTributeRecipients` arm, G79's ordering). The divisor line
    (`(1 - f) * tribute_pct`) is split over n's factors by `e * p**exponent`.
    The window counts composites because the head is defined over composites
    (D-20): a prime is never a head mint.
    """
    # The last window ends about `window_mints` composites past `prime_bound`;
    # composites are > 3/4 of the line there, so 2x is ample and asserted.
    horizon = prime_bound + 2 * window_mints + 1000
    if spf is None or len(spf) <= horizon:
        spf = spf_sieve(horizon)
    is_prime = np.zeros(horizon + 1, dtype=bool)
    idx = np.arange(horizon + 1)
    is_prime[2:] = spf[2:horizon + 1] == idx[2:]
    pi_below = np.concatenate(([0], np.cumsum(is_prime)[:-1]))  # primes < n
    comp = np.zeros(horizon + 1, dtype=bool)
    comp[4:] = ~is_prime[4:]
    comp_count = np.cumsum(comp)
    flat_cum = np.cumsum(np.where(comp, tribute_pct * f / np.maximum(pi_below, 1), 0.0))
    div_line = tribute_pct * (1.0 - f)

    out: dict[int, float] = {}
    for p in range(2, prime_bound + 1):
        if not is_prime[p]:
            continue
        end = int(np.searchsorted(comp_count, comp_count[p] + window_mints))
        assert end <= horizon, "rest window ran past the sieve"
        cash = float(flat_cum[end] - flat_cum[p])
        for m in range(2 * p, end + 1, p):
            fac = factorize(spf, m)
            w = {q: e * (q ** exponent) for q, e in fac.items()}
            cash += div_line * w[p] / sum(w.values())
        out[p] = cash
    return out


def repayment_head_multiples(
    horizon: int,
    spf: np.ndarray | None = None,
    exponent: float = 0.5,
    f: float = 0.20,
    tribute_pct: float = 0.10,
    probes=(2, 5, 211, 1009, 9973),
    price_ton: float = 1.0,
) -> dict:
    """SS5.1: the head multiple `c` at which prime p's cumulative undiscounted
    tribute repays its 1 GRAM mint price, plus SS3.2's equal-multiplicative-age
    table (earnings at head = 2p, 5p, 10p, 50p, 100p)."""
    if spf is None:
        spf = spf_sieve(horizon)
    div_line = tribute_pct * (1.0 - f)
    flat_line = tribute_pct * f
    is_prime = np.zeros(horizon + 1, dtype=bool)
    idx = np.arange(horizon + 1)
    is_prime[2:] = spf[2:] == idx[2:]
    pi = np.cumsum(is_prime)

    out = {}
    for p in probes:
        if p * 2 > horizon:
            continue
        cum = 0.0
        marks = {}
        repay_at = None
        for m in range(2 * p, horizon + 1, p):
            fac = factorize(spf, m)
            if len(fac) == 1 and next(iter(fac.values())) == 1:
                continue
            w = {q: e * (q ** exponent) for q, e in fac.items()}
            cum += div_line * w[p] / sum(w.values())
            if repay_at is None and cum >= price_ton:
                repay_at = m / p
        # equal-age marks need the flat line too; add it over the same span
        cum_marks = {}
        cum2 = 0.0
        flat_cum = 0.0
        next_mark = 0
        marks_at = [c * p for c in (2, 5, 10, 50, 100)]
        for n in range(p + 1, horizon + 1):
            if not is_prime[n]:
                fac = factorize(spf, n)
                if p in fac:
                    w = {q: e * (q ** exponent) for q, e in fac.items()}
                    cum2 += div_line * w[p] / sum(w.values())
            if pi[n] > 0:
                flat_cum += flat_line / int(pi[n])
            while next_mark < len(marks_at) and n >= marks_at[next_mark]:
                c = (2, 5, 10, 50, 100)[next_mark]
                cum_marks[f"head_{c}p"] = cum2 + flat_cum
                next_mark += 1
            if next_mark >= len(marks_at):
                break
        out[p] = {
            "repay_head_multiple_divisor_line_only": repay_at,
            "earnings_at_equal_age_ton": cum_marks,
        }
    return out


# --------------------------------------------------------------------------- #
# LATE_GAME_PLAN.md SS3 items 2 and 3 -- the three assets on one axis, and the
# flat dividend's decay shape
# --------------------------------------------------------------------------- #


def asset_lifetime_curves(
    horizon: int,
    spf: np.ndarray | None = None,
    exponent: float = 0.5,
    f: float = 0.20,
    tribute_pct: float = 0.10,
    referral_pct: float = 0.10,
    probes=(2, 5, 211, 1009, 9973),
    marks=(2, 5, 10, 50, 100),
    referral_routing_share: float | None = None,
) -> dict:
    """LATE_GAME_PLAN.md SS3 item 2: SS3.2's `2p...100p` equal-multiplicative-age
    table, extended so all **three** assets are measured on the same axis.

    The three lines, kept separate because they have different shapes and
    SS5.4's honesty depends on not blending them:

      * **divisor tribute** -- what SS3.2 already publishes: p's realised share
        of the `(1-f)` divisor line over every multiple of p up to `c*p`.
      * **flat prime dividend** -- `f * 0.10 / pi(n)` per mint from p's own mint
        onward. Decays like `1/pi(n)` *per prime*, which is the qualifier SS5.4
        has to state rather than leave a reader to derive.
      * **referral key** -- `referral_pct * P` per mint routed through the key,
        with **no `n` term anywhere in SS4.1**. This is the only genuinely
        flow-proportional asset in the design, and the one SS3.1 currently gives
        four bullets and no numbers.

    The referral line is not a property of `p` at all -- it is a property of how
    much flow its owner routes -- so it is reported as the per-routed-mint rate
    (`referral_ton_per_routed_mint`) and, for the same-axis comparison, as what
    a holder earns over the same span at `referral_routing_share` of all mints.
    Default: `1/pi(horizon)`, i.e. "one key among the minted primes' owners",
    chosen so the comparison is against a *flat* share and never flatters the
    key by assuming a share that grows.
    """
    if spf is None:
        spf = spf_sieve(horizon)
    div_line = tribute_pct * (1.0 - f)
    flat_line = tribute_pct * f
    is_prime = np.zeros(horizon + 1, dtype=bool)
    idx = np.arange(horizon + 1)
    is_prime[2:] = spf[2:] == idx[2:]
    pi = np.cumsum(is_prime)
    if referral_routing_share is None:
        referral_routing_share = 1.0 / float(int(pi[horizon]))

    out: dict[int, dict] = {}
    for p in probes:
        if p * marks[0] > horizon:
            continue
        divisor_cum = 0.0
        flat_cum = 0.0
        rows: dict[str, dict] = {}
        marks_at = [c * p for c in marks]
        next_mark = 0
        mints_since = 0
        for n in range(p + 1, horizon + 1):
            mints_since += 1
            if not is_prime[n]:
                fac = factorize(spf, n)
                if p in fac:
                    w = {q: e * (q ** exponent) for q, e in fac.items()}
                    divisor_cum += div_line * w[p] / sum(w.values())
            if pi[n] > 0:
                flat_cum += flat_line / int(pi[n])
            while next_mark < len(marks_at) and n >= marks_at[next_mark]:
                c = marks[next_mark]
                referral_cum = referral_pct * referral_routing_share * mints_since
                rows[f"head_{c}p"] = {
                    "divisor_tribute_ton": divisor_cum,
                    "flat_dividend_ton": flat_cum,
                    "referral_ton": referral_cum,
                    "tribute_total_ton": divisor_cum + flat_cum,
                    "mints_elapsed": mints_since,
                }
                next_mark += 1
            if next_mark >= len(marks_at):
                break
        out[p] = rows

    return {
        "horizon": horizon,
        "referral_routing_share": referral_routing_share,
        "referral_ton_per_routed_mint": referral_pct,
        "_referral_has_no_n_term": True,
        "by_prime": out,
        "_note": (
            "Divisor tribute and the flat dividend are p-specific; the referral "
            "line is not a property of p at all. Reported on the same axis only "
            "so SS5.4 can show the three shapes side by side -- flat, decaying "
            "per prime, and flat-per-routed-mint -- not so they can be summed "
            "into a single yield."
        ),
    }


def flat_dividend_decay(
    horizon: int,
    spf: np.ndarray | None = None,
    f: float = 0.20,
    tribute_pct: float = 0.10,
    materiality_ton_per_1000_mints: float = 0.001,
    sample_decades=(1e3, 1e4, 1e5, 1e6),
) -> dict:
    """LATE_GAME_PLAN.md SS3 item 3: confirm the `1/pi(n)` shape of the flat
    prime dividend **per prime**, and publish the head at which that line stops
    being material to any individual prime.

    SS3.2 proposes `f = 0.2` and states the accrual (`div_acc += f*0.10/pi(n)`)
    without ever stating its shape. The shape is the point: aggregate flat
    dividend paid per mint is a constant `f * 0.10` GRAM, so the *line* does not
    decay at all -- but it is divided among pi(n) primes, so **per prime it
    decays like `1/pi(n)` ~ `ln(n)/n`**, which is faster than any other leg in
    the design. This is one of the three qualifiers SS5.4 owes the reader.

    `materiality` is expressed per 1,000 mints of head progress rather than per
    mint, because a per-mint accrual at n = 1e6 is a number no interface can
    render honestly.
    """
    if spf is None:
        spf = spf_sieve(horizon)
    is_prime = np.zeros(horizon + 1, dtype=bool)
    idx = np.arange(horizon + 1)
    is_prime[2:] = spf[2:] == idx[2:]
    pi = np.cumsum(is_prime)
    flat_line = tribute_pct * f

    rows = []
    immaterial_at = None
    for n in [int(d) for d in sample_decades if d <= horizon]:
        pin = int(pi[n])
        per_mint = flat_line / pin if pin else 0.0
        rows.append({
            "n": n,
            "pi_n": pin,
            "per_prime_ton_per_mint": per_mint,
            "per_prime_ton_per_1000_mints": per_mint * 1000.0,
        })
    # first head at which the per-prime accrual over 1,000 mints falls under the
    # materiality threshold -- scanned on the real pi(n), not on the n/ln(n)
    # approximation, since the whole point is to publish a number
    for n in range(2, horizon + 1):
        pin = int(pi[n])
        if pin and (flat_line / pin) * 1000.0 < materiality_ton_per_1000_mints:
            immaterial_at = n
            break

    return {
        "horizon": horizon,
        "f": f,
        "flat_line_ton_per_mint": flat_line,
        "_aggregate_line_is_constant": True,
        "per_prime_shape": "1/pi(n) ~ ln(n)/n",
        "rows": rows,
        "materiality_threshold_ton_per_1000_mints": materiality_ton_per_1000_mints,
        "per_prime_immaterial_from_head": immaterial_at,
        "_decision_note": (
            "LATE_GAME_PLAN.md SS6 Q3: this produces the number, not the "
            "response. Raising `f` flattens tribute *between* primes and does "
            "not change the decay shape, so the decision of whether the shape "
            "wants an answer is separate and is not taken here."
        ),
    }
