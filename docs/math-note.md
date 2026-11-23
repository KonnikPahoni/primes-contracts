# TON PRIMES — the math note

*A short paper for readers who want the mechanism, not the pitch. Every claim below is a
contract-verifiable invariant (design principle 1, CONCEPT.md §2) — where a get-method is
named, you can check the claim yourself against the live contract once it's deployed.*

Status: Phase 2 deliverable · Date: 2026-08-13, revised 2026-09-25. The genesis valuation
model (§6) is the model behind the sim's per-prime NPV table (`shared/params.json`
`npv_ladder.npv_ton_by_prime`), which every prime lot's opening and resting price read
(CONCEPT.md §6 point 1). There is no separate valuation contest; the published table is the
public anchor.

---

## 1. Setup

Every mint pays a flat price `P = 1 GRAM`. A fixed split (CONCEPT.md §4.1) deducts **five
lines** — three fixed: the treasury line (5%, paid to the governed treasury contract since
`DECISIONS.md` D-152), gas & ops (20%, sized to the measured worst-case mint by `DECISIONS.md` D-117; what a mint does not spend is swept back to the pool, §4 below) and tribute (10%, which resolves to the empty set
and falls back to the pool on a prime mint); and two conditional: an optional referral
(10%) and the **invite line** (`count × 0.1 GRAM`, `count ∈ 0..3`, three text transfers to
recipients the minter names — `DECISIONS.md` D-202; it was `count × 0.025 GRAM` over `0..5`
under D-101). *(This read "six lines" and named a patron line until 2026-09-21; D-106 deleted
that line on 2026-09-07 and the count here had not followed.)* Everything left over — the *pool injection* `β·P` — is the residual, not an
independently chosen number:

```
β = 0.55   (referred, no invite line)
β = 0.65   (unreferred, no invite line)
```

Those two figures are the **steady-state uninvited rows** of §4.1's table, not the only
values β takes: an invite line moves it down — to 0.25 on a referred composite that sends
all three, the worst case — and `shared/params.json` `invites.beta_table` carries every row. Nothing in
§2 depends on which row a mint is on — see "What makes this a theorem and not a hand-wave".

The contract tracks two cumulative counters, never reset, never decremented by anything except
their own definitions:

- `T` — total GRAM ever committed to the pool by the protocol.
- `S` — total PRIMES ever emitted as rebates, plus the genesis bounty vault (counted in from
  block zero, CONCEPT.md §3.3).

and defines the **internal floor price**

```
p_f = T / S
```

No oracle, no external price feed — `p_f` is a pure ratio of two on-chain counters, readable
by anyone via `getFloorNum()` / `getFloorDen()` on the **ledger** (or `getFloorOracle()` on the
**ratchet**) and decomposable from public state per the identity in §4 below. *(This read "bank
contract" until 2026-09-25; the word is retired, CONCEPT.md §3.4 — the components are the
splitter, ledger and ratchet.)*

## 2. The ratchet theorem

**Claim: every mint strictly increases `p_f`.** Not "on average," not "assuming honest
participants" — *every single mint*, unconditionally, as a matter of arithmetic.

**Rebate rule.** A mint occurring `t` seconds after the previous one earns a PRIMES rebate

```
R(t) = k(t) · β · P / p_f              PRIMES
k(t) = k_min + (k_max − k_min) · min(1, t/T_ramp)
```

with `0 < k_min < k_max < 1` (v1 values: `k_min = 0.2`, `T_ramp = 1 hour`, `k_max` per the
prime-density schedule in §3). `k(t)` climbs linearly the longer the game waits between mints
and lands on `k_max` one ramp after the last mint (D-98) — but it is architecturally *bounded
strictly below 1*, which is the entire mechanism. Note what the theorem below needs and what
it does not: only `k < 1`. Whether the climb *attains* its own ceiling `k_max` is a
game-design choice; `k_max ≤ K_CEIL = 0.95` is what keeps the proof.

**Theorem.** Let `p_f = T/S` before a mint, and let the mint inject `I = β·P > 0` into `T` and
emit `R = k·I/p_f` PRIMES into `S`, for any `k < 1`. Then the new floor

```
p_f' = (T + I) / (S + k·I/p_f)   >   p_f
```

**Proof.** `p_f' > p_f` is equivalent (after multiplying both sides by the positive quantity
`S + k·I/p_f`) to `T + I > p_f·(S + k·I/p_f) = p_f·S + k·I`. Since `p_f = T/S`, `p_f·S = T`, so
this reduces to `T + I > T + k·I`, i.e. `I > k·I`, i.e. `1 > k`. This holds by construction
(`k < 1` always). ∎

**What makes this a theorem and not a hand-wave:** the proof never uses `β` being constant, a
particular value of `k`, or any assumption about *who* mints, *why*, or what they do with the
rebate afterward. It holds for any positive injection `I` and any `k` strictly below 1. So the
floor rises regardless of referral status, gas draw, adversarial minting patterns, or any
future change to the split (as long as the split's leftover residual stays positive and
`k(t) < 1` stays true, which the `k_max < 1` clamp guarantees by construction, not by
convention — see §3).

**Step size.** `Δp_f / p_f ≈ (1 − k)·I / T`, which decays like `1/T` as the pool grows —
the floor is a staircase with ever-shallower steps that *never descends*. This is the honest
shape for a chart: not an exponential, a monotone staircase that flattens.

**Corollary (D-156, the supply cap does not disturb this proof).** The argument above uses
`k < 1` and nothing about where `k` comes from. D-156 multiplies emission by
`(S_MAX - S)/S_MAX`, a factor in [0, 1], so `k_eff <= k < 1` and every step of the theorem
holds verbatim with `k_eff` in place of `k` -- strictly *harder*, since a smaller `k` raises
`p_f` faster. `k < 1` therefore holds by two independent mechanisms: the single `K_CEIL`
clamp on the summed uplifts, and the taper on top of it. No line of this section changes.

**Corollary (accounting conservatism).** `S` counts *cumulative emission*, never decremented
by the buy-and-burn burns described in §4 below. Circulating PRIMES supply is therefore
strictly below `S`, and the gap only widens with every burn. `p_f = T/S` consequently
*understates* backing per circulating token — the number on the dashboard is always a lower
bound on the number a reader gets by dividing `T` by circulating supply instead. This is a
deliberate, stated design choice (not an oversight to be "corrected" later): a reader who
recomputes the sharper number should get a *better* answer than the headline figure, never a
worse one.

## 3. Emission by prime density

`k_max` itself decays over the number line like `1/ln(n)` — the asymptotic density of primes
near `n`, per the Prime Number Theorem — so early participation is structurally more rewarded,
continuously rather than in discrete halvings:

```
k_max(n) = 0.9                      for n ≤ 1000
k_max(n) = 0.9 · ln(1000) / ln(n)   for n > 1000
         = 2.7 / log₁₀(n)            (equivalent, cheaper on-chain: one log10 instead of two lns)
```

| n | k_max |
|---:|---:|
| ≤ 1,000 | 0.900 |
| 10,000 | 0.675 |
| 100,000 | 0.540 |
| 1,000,000 | 0.450 |

The contract clamps `k_max(n) ≥ k_min` (crossing point ≈ 3×10¹³, unreachable in practice, but
enforced anyway — an unclamped inversion would make waiting *punitive*, which would break the
theorem's `k < 1` requirement in spirit even though the algebra in §2 is agnostic to *why* `k`
is below 1). This clamp is a cheap, always-on guard against a term the game will realistically
never exercise, not a load-bearing part of normal operation.

**D-156 makes that crossing moot, and this is why the clamp did not have to move.** Past the
crossing `k_max` stops decaying, so emission's tail is a power law `S ~ n^0.2` and `S` is
unbounded -- which is the obstruction D-156 was filed against. The fix is a factor applied at
each emission site, `k_eff = k*(S_MAX - S)/S_MAX`, and it is applied **after** this clamp. So
the 0.2 floor still does its job (waiting is never punitive) while the cap still closes above
it: as `S -> S_MAX` the taper drives `k_eff -> 0` whatever `k_max` is holding at. Had the
taper been folded into `k_max` instead, this floor would have defeated it.

## 4. Where the injected GRAM actually goes: batched buy-and-burn

`T` increments **at mint time**, not at swap time — the protocol commits the GRAM the instant a
mint completes, even though the actual DeDust swap is batched and executed later by a
permissionless `flush()` call (CONCEPT.md §4.3). This ordering is what makes §2's theorem true
*at the moment of minting* rather than at some later, uncertain time when someone happens to
call `flush()`. The ratchet exposes `getPending()`, and the whole decomposition (CONCEPT.md §5)
is checkable per-block:

```
T = seeded + swapped + pending + stakedCost + exiting + realizedLoss
```

`seeded` is founder capital credited straight into `T` without passing through `pending`
(`getSeedT()` on the ledger — `0` in this deployment, `DECISIONS.md` D-26/D-46); `swapped` and
`pending` are `getFloorOracle()` on the ratchet; the last three are the staked reserve
(CONCEPT.md §4.3.2, D-151) from `getStaking()`, each moved only against another term of the
same sum, so the identity is conserved by construction. Reading it as two terms reports a
solvency gap that is not there. The gap between "committed" and "already swapped" is not
hidden, it's a named, queryable quantity.

Once swapped, the resulting PRIMES is burned, and the receipt for the genesis DeDust pair is
locked in the LP sink, which has no withdraw path (CONCEPT.md §6 point 3, D-154) — so every GRAM the protocol ever swaps lands in reserves nobody, not
even the team, can withdraw. This is what makes "the floor rises with zero external buyers"
a mechanism rather than a promise: the protocol is a perpetual, permanently-committed net
buyer against its own ratchet.

**Emission-free credits.** Mints are not the only credit to `T`. Three others raise `T` and
`pending` together, in the same step, with `k = 0` and `S` untouched: a floor donation
(`donate_floor`), the ratchet's half of the secondary-sale royalty, and — since `DECISIONS.md`
D-117 — the permissionless `sweep_ops`, which returns the gas & ops line's unspent surplus
(the ledger's balance above declared liability and `OPS_RESERVE`). Each is a pure floor
raise: it is §2's theorem with `k = 0`, so `T` grows, `S` does not, the inequality can only
strengthen, and the identity above stays exact.

## 5. Tribute weighting and the self-tribute corollary

**Tribute is prime-only.** 10% of every mint's price goes to primes — composite factors never
earn tribute. CONCEPT.md §3.2 splits it into a divisor line (80%) paid to the owners of the
minted number's *prime factor* NFTs and a flat prime dividend (20%) to every minted prime. For
`n = ∏ pᵢ^eᵢ`, prime `pᵢ`'s owner receives

```
tribute_share(pᵢ) = 0.08 · P · (eᵢ · √pᵢ) / Σⱼ (eⱼ · √pⱼ)
```

with `⌊√p⌋` submitted by the minter and checked on chain (§3.2). Weights are normalized
*within* the mint's own factor set, so the line's *size* never changes, only its *internal
split* does. *(A §5.1 here described a set-constellation tribute multiplier `m = 3/2`;
`DECISIONS.md` D-102 deleted it, and D-202 deleted constellations altogether.)*

**Fan-out is bounded by ω(n) — the count of *distinct* prime factors — not by n itself or by
d(n) (the divisor count).** Because the smallest number with `k` distinct prime factors is the
`k`-th primorial (510,510 for 7 factors, 9,699,690 for 8, ≈6.5×10⁹ for 10), and minting is
strictly sequential (so `n` never exceeds total mints ever made), realistic fan-out stays
**≤ 8 recipients** for any horizon this project will plausibly reach — a consequence of number
theory, not a parameter that could drift. This is why the design can afford a fixed,
enumerable-in-one-transaction fan-out at every mint, well under TON's 255-action limit.

**The self-tribute corollary.** Tribute owed to a prime *you own* is credited exactly like
tribute owed to anyone else — there is no special-case exemption — but since you are the owner
of record, you simply claim your own share back. The practical effect: **the owner of NFT `p`
receives a refund of the `p`-share of tribute on every future multiple of `p` they mint
themselves.** Owning a set of small primes — {2, 3, 5} covers most near-term composites — turns
a chunk of every future mint's tribute line into a rebate to yourself, on top of the inbound
cash flow from *everyone else's* mints of multiples of `p`. This is not a bonus mechanic layered
on top of §5's formula; it *is* §5's formula, applied to the case `owner(pᵢ) = minter`. Stated
explicitly because — per CONCEPT.md §3.2 — it materially changes the fair-value calculation for
genesis primes (§6) and is exactly the kind of derivable-but-easy-to-miss corollary this
audience is invited to find independently before reading it here.

## 6. Reference valuation model for the genesis primes

*This section defines the **model** precisely. The **numbers** are the sim's, published in
`shared/params.json`, and move when a re-run or a live mint-arrival track record moves them.*

A genesis prime `p`'s fair value has three additive legs, all stated in CONCEPT.md §6 and made
precise here:

```
V(p) = NPV_tribute(p) + V_self_tribute(p) + V_referral(p)
```

**Leg 1 — tribute NPV.** Discounted expected future tribute cash flow to `p`'s owner, under a
stated mint-arrival model:

```
NPV_tribute(p) = Σ_t  E[tribute paid to p at time t] / (1 + r)^t
```

where the expectation is taken over a chosen arrival process (Poisson base rate + growth, per
`/sim`'s engine) and `r` is a discount rate chosen to price in *mechanism and execution risk*,
not just time value — the Phase 1 calibration used `r = 35%/year`, deliberately high, because
this is a new, unaudited, single-team protocol, and a valuation model that doesn't discount for
that risk would be dishonest regardless of how clean the underlying math is.

**Leg 2 — self-tribute value.** The corollary of §5: a share of Leg 1's cash flow is not new
income but money the owner would otherwise have paid to themselves on their own future mints.
This *reduces the owner's effective cost basis* on future mints rather than adding new
inbound cash flow — modeled as a discount applied to the owner's own projected minting activity,
not double-counted as extra tribute revenue.

**Leg 3 — referral income.** `rp` (the referral key for the number `p` itself) is worth
claiming on the auction winner's own future mints and any mints they successfully route through
their public key — priced as an optional, low-confidence add-on since it depends on the owner's
own distribution effort, unlike Legs 1–2 which are mechanical.


**Start-price rule.** *Updated 2026-09-04 for `DECISIONS.md` D-88/D-89/D-90 (all landed
2026-09-01): the flat-fee reservation this note originally described here is gone (see §7),
and with it the fixed 90-day slope. Every number ahead of the head — prime or composite —
now sells on one **paid ascending auction** whose window is a fixed `AUCTION_WINDOW` of
7 real days (604,800s, D-3's Fragment-style clock), and opening the lot IS the opener's own
first bid at `P0`, not a tenth of it.* `P0` is still anchored on fair value for a prime, not
on a conservative fraction of it:

```
P0(p) = max( 1.5 · NPV_tribute(p), PRIME_P0_MIN )     PRIME_P0_MIN = 5 GRAM,
                                                       lifted further to a special
                                                       tier's price_max (D-88 point 2)
```

The 1.5 is still not a margin for safety; it is what sizes the *other* end of the range a
prime's price can occupy. **At its own turn** (never before — D-88 point 3 moved the
pre-turn case onto the ascending lane above), a prime instead opens a **descending** lane at
that same `P0(p)`, decaying linearly over the same 7-day `AUCTION_WINDOW`
(`PRIME_DUTCH_SECONDS`, the same constant) to

```
restingPrice(p) = max( NPV_tribute(p) / 2 , MINT_PRICE )    lifted to the tier's
                                                             price_min if p is special
```

— a **3× spread** from open to rest whenever the NPV branch binds on both ends
(`1.5 / 0.5 = 3`), and the lot **never expires**: unlike the old 90-day slope, it parks at
`restingPrice(p)` and stays listed there until somebody buys it (`sweep_expired_head_lot`
is deleted along with the fixed-duration model it existed to sweep). Because the window
shrank from 90 days to 7 while the multiplier did not change, the linear decay
`D(t) = max(P0(p)·(1 − t/604800), restingPrice(p))` now crosses a prime's own fair value
`NPV_tribute(p)` at `t ≈ 2.33 days` (`1 − t/7 = NPV/P0 = 1/1.5`) whenever the NPV branch
binds on both ends — not this note's old day-30 estimate, which was a property of the
retired 90-day window, not of the 1.5× multiple. Setting `P0` higher still does not raise
what a lot ultimately fetches on the ascending lane — bidding there is a live auction, not
a posted price — and on the descending lane it only delays the crossing, exactly as before.

Legs 2–3 remain bidder upside, as before, and for the same reason: `NPV_tribute` alone is
the anchor, so a bidder who values the self-tribute discount or referral income is bidding
against a curve that ignores both.

**This is still a number to re-derive rather than reuse verbatim**, once the team has an
actual view on mint-volume growth ahead of launch (the deleted `docs/phase1-report.md` §7 flagged
this explicitly; `shared/params.json`'s `_source` strings are the authority now) — `genesis.auction_start_ton` in `/shared/params.json` is a documented,
reproducible example run of this model at one set of growth/discount assumptions, not a
committed number. What changed is the consequence of getting it wrong: under the old
open-ended decay a mis-set reserve could leave a lot unsold indefinitely, whereas now a
mis-set `P0` only moves the clearing date along a curve that always terminates.

**What ships now vs. at launch, stated plainly:** the model (this section) ships with this
math note today. The *specific opening prices* are whatever the sim's NPV table says at the
last re-run before genesis, published in `shared/params.json` before any lot opens, which is
why the model needs to be public and precise now even though the numbers are not final.

## 7. The mint and the ascending-lot protocol

**The direct mint (concept §8).** A mint is ONE message: `mint(n, kind, factorization,
referral_key, beneficiary)` with the price attached, settled in the transaction that receives
it. `k(t)` is therefore read at execution, not fixed at an earlier commit, and the MEV that
buys is accepted rather than mitigated — §8 states the trade and its bound (`k_max · β · P`,
cents at any head worth sniping) rather than pricing a two-message protocol against it. If `n`
no longer matches the current head when the message lands (lost a race for the same next
number), the mint fails **cheaply**: the attached value is refunded in full minus gas, never
burned or kept — losing a race costs latency, never principal.

An earlier draft of this note analysed a commit–reveal protocol here, whose whole purpose was
to fix `k` across the two blocks a snipe would race in. It is gone; the paragraph above is
what replaced it.

**Acquiring a number ahead of the head (concept §4.4).** *Updated 2026-09-04,
`DECISIONS.md` D-88/D-89/D-90 (all landed 2026-09-01), superseding the 2026-08-19 update
below: there is now exactly **one** route ahead of the head, for every number regardless of
primality — a **paid ascending auction**. Opening the lot IS the opener's own first bid, at
`P0(n)`, with no `D_MIN` gate and no distance gate, over a fixed `AUCTION_WINDOW` of 7 real
days (extended only by snipe-protection near close). `kind` selects only which proof the
open must carry — a factorization for a composite, nothing for a prime, since the contract
runs its own Miller–Rabin at settlement. **The winning bid MINTS the number in the very
transaction that closes the lot, for both kinds** — D-90 deleted the escrowed claim and
`primes_market_shard.tolk` outright, so there is no `settle(n)`, no wait for the head to
arrive, and no separate claim step. (A composite's claim was never actually waiting on a
real future event either: D-45 had already taken an auctioned number off the sequential
line permanently the moment its lot opened, so the head skips it forever — D-90 only
corrected this note's mint-timing sentence to match that already-true fact.)*

*At its own turn, a composite still mints sequentially at `MINT_PRICE` — the core loop,
untouched. A prime instead opens the **descending Dutch lane** described in §6, at the same
`P0(p)` the ascending lane would have opened it at, decaying over the same 7-day window to
`restingPrice(p) = max(NPV_tribute(p)/2, MINT_PRICE)` and then parking there, unexpiring,
until bought. `RES_GAS` (0.06 GRAM) still exists — it is folded into `LOT_FLOOR` and
`RESERVE_FLOOR`, both inputs to `P0(n)`'s ladder — but it is no longer a settlement-gas fee
prepaid against a later permissionless `settle(n)`, because there is no later settlement to
prepay for. There is likewise no more separate "reservation rebate rule": a lot's mint is an
ordinary mint at whatever price the lot cleared at, split five ways like any other, with
`k(t)` read at the same settlement transaction exactly as the direct mint above reads it —
not fixed at `k_min` by a special case, because the special case is gone.*

The two paths resolve the same underlying tension from different angles: the direct mint is
the low-latency route for "I want the next number, whatever it turns out to be", and accepts
race exposure to stay one signature; the ascending lane defends "I want *this specific*
number" against having to win a live race for it at all, by a 7-day paid auction rather than
by block racing. CONCEPT.md §4.4's own framing — the ascending lane is "the pressure valve
for head contention" — is the accurate way to read them together, not as two competing
mechanisms.

---

*Historical (2026-08-19, `DECISIONS.md` D-30/D-31/D-33), retained for the derivation
context D-88/D-90 above builds on — superseded where it disagrees with that update:* the
flat-fee `reserve(n, proof)` entry point this note originally described here was already
deleted at D-30, replaced by a **reservable composite** won on an ascending lot and every
**prime** bought on a descending Dutch lane openable before its turn at a flat `P0` and
terminating at exactly 1 GRAM. The winner's claim escrowed the full mint price plus `RES_GAS`
up front, proof was verified at open time, and anyone could call permissionless `settle(n)`
once the head arrived. D-88/D-90 above is what deleted the escrow and `settle(n)` outright
and moved the pre-turn prime case onto the ascending lane; the termination price also moved
from a flat 1 GRAM to `max(NPV(p)/2, P0(p)/3, MINT_PRICE)` (§6).

---

*This note will be updated if Phase 3 benchmarking or Phase 1-style re-simulation changes any
formula's *parameters* — it should never need to change on the *theorems* in §2 or §5, which
are proven from the split's structure and are agnostic to the specific numbers in
`/shared/params.json`.*
