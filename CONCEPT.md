# TON PRIMES — Concept

*A number-theory game on TON where the jetton's price floor rises by construction, not by promise.*

Status: design draft v6.3 · Date: 2026-09-24

*v6.1 was a reconciliation pass bringing §2, §3.1, §3.4, §4.1, §4.4, §5.1, §8, §9, §10,
§11 and §12 current with `DECISIONS.md` D-1 through D-20. v6.2 closes what v6.1 flagged:
the simulation objective in §11.25 is signed (D-21) and its first run has landed, the
ascending-lane/prime contradiction in §11.28 is closed (D-22, `open_lot` refuses primes),
§11.12 is closed (D-23, φ₁ from the pool), and the era count is settled at **eight**
primorials — the contracts' enumeration — wherever the prose said six. v6.3 is a
consistency pass against the code and `shared/params.json`: the three-term prime resting
price everywhere, the current split, `RES_GAS`, forfeit and premium figures, the ascending
lane restated against D-45/D-88/D-90, and §11's status table and entries brought to agree.*

---

## 1. One-paragraph pitch

TON PRIMES mints the number line. Integers become NFTs: composites are built strictly in
sequence for a flat 1 GRAM, and primes are sold on a descending price that comes to rest at the prime's own floor,
`max(NPV(p)/2, P0(p)/3, MINT_PRICE)` — never below that same 1 GRAM. Primes are the aristocracy: they collect tribute from every composite they
divide.
Every NFT is also a referral key — `r42` pays the current owner of number 42 — so every
piece of the number line is a cash-flowing identity asset. Every mint commits GRAM to the
**ratchet** — a contract with no withdraw path, which buys PRIMES **only when the market
trades at or below the protocol's own floor price** — and pays composite minters a rebate
in PRIMES jetton whose size grows the longer nobody mints, mathematically capped so that
the jetton's floor price is **provably monotonically increasing** as long as anyone keeps
playing. **Primes pay no rebate at all**: they emit nothing, their tribute line has no
recipient, so the entire mint funds the floor and the minter is paid in the one currency
the ratchet cannot inflate — the asset's perpetual tribute claim, a name on the number,
and rank. Growth is a contract mechanic rather than a marketing budget: any mint can name a
**beneficiary** (§4.5), and a gift to an address the ledger has never seen credits the
giver a **recruit** — a tier on §4.7's ladder, which raises the rebate ceiling on their
own future mints. It pays no GRAM, so there is no line in the split for it and no payer who
can end up underwater. The contract is the whitepaper: the target audience is
TON-technical people, and
the marketing is a set of on-chain puzzles ("how does it work?") whose bounties are paid
in PRIMES and can only be claimed by calling the contract.

**The game sells two halves with opposite shapes, and the mix between them rotates by
construction.** PRIMES is the floor-bound half: monotone, collateral-grade, and traded
inside a published band. The numbers are the cash-flow half: tribute on primes, a referral
key on every NFT, and the era trophies that make the map worth
collecting. The rebate is the only leg of the mint carrying a decay term — `k_max(n)` falls
from 0.900 to 0.450 across three decades of the number line — while the asset-side legs
have no `n` term at all, so the asset side's share of each mint rises from 28.8% to 44.7%
over the same stretch **without a single parameter being tuned for it** (§5.4). Nothing
grows; the token half shrinks on a schedule this document publishes. That is the position,
not a hedge, and §5.4 carries the table it is read off.

## 2. Design principles

1. **Every economic claim must be a contract-verifiable invariant.** No promise that
   can't be expressed as a get-method.
2. **The audience is the auditor.** Assume every reader can and will read the Tolk source,
   compute the backing math, and post the result publicly.
3. **Honest asset roles.** The NFT is a *game piece with cash flows* (tribute rights and
   referral income), not a redeemable deposit. The jetton PRIMES is the *liquid asset*
   with a ratcheting price floor. Nothing is marketed as an investment; the appreciation
   is a mechanism, stated as math.
4. **Team takes fees, never supply.** Since `DECISIONS.md` D-166 this has **no exception**:
   the operator holds no genesis PRIMES allocation and acquires PRIMES the way any player
   does — by minting at the head at full price. *(History: D-46 minted the operator a
   disclosed, one-time allocation, D-77/D-91 vested it, and D-100 point 6 split its
   2,000,000 PRIMES into two instances of the same lock, 1,000,000 to the operator and
   1,000,000 to the governed treasury. D-166 deletes the operator's instance.)* What
   remains is the **treasury's** lock: 1,000,000 PRIMES in `primes_vesting.tolk`, released
   in **four equal 25% tranches 90 days apart, the last at day 270**, to the **governed
   treasury** (§5.5), which has no key and spends only by a passed proposal or by
   `distribute()` — disclosed supply that pays PRIMES stakers (§5.3, `DECISIONS.md` D-168), not
   the team, and checkable in one
   `getVesting` call. Genesis is no longer
   founder-seeded into a pool at deploy (D-46 supersedes that reading); liquidity is added
   later, by anyone, using DeDust directly. Ongoing revenue is exactly two fee lines,
   each visible on-chain: a 5% secondary royalty honored by marketplaces (§3.1, split with
   the ratchet since D-128), and §6 point 2's 42% remainder of an unsold prime's forfeited
   tribute (D-166; 20% before it). **§4.1's 5% line is no longer one of them**: D-100 point 6 pointed it at the
   operator's wallet and **D-152 points it at the governed treasury contract** (§5.5), so
   the one fee that every mint pays unconditionally is the one the team cannot spend
   without a passed proposal. **Nor is the gas-&-ops surplus**: `DECISIONS.md` D-117 returns
   what the protocol did not spend on gas to the ratchet pool (§4.1), where it raises the
   floor and pays nobody. All of them scale with *activity*;
   none is a claim on the ratchet, on `pending`, on `owed`, or on escrow, and none issues a
   single PRIMES.

   **A further line, smaller and conditional, was added by `DECISIONS.md` D-20 and is
   disclosed here rather than in a footnote: the tribute share of a prime that is still
   unsold is paid to the treasury** (§4.1, §6 point 2). It is GRAM out of the fixed 10%
   tribute line, it issues no PRIMES, it touches none of the four pools named above, and
   it terminates permanently the moment that prime is bought. It is a fee under the letter
   of this principle, and it is **the one line in this document where "an unresolvable
   split line falls to the pool, never to the team" does not hold** — so it is named in
   the principle it strains rather than only in the section that implements it.
5. **Growth mechanics must be as auditable as the economics.** Referrals resolve
   on-chain, virality rewards pay only on *measured* outcomes (counted bot starts and
   wallet connects, not self-reports), and every bounty claim is a contract call. No growth number in the
   dashboard that a reader can't recompute.
6. **Recruitment pays only on a full mint's spend.** Every reward for bringing someone
   in — the §4.7 rank tier, and the newcomer's own raised rebate ceiling (§4.6) — triggers
   on a full 1 GRAM mint, never on a drop, a claim, or a wallet count. This is what makes
   the recruitment layer sybil-closed rather than sybil-resistant: farming it means
   paying the full mint price per fresh address, which is indistinguishable from being a
   customer. *(This principle read "pays only on the recruit's own spend", and listed
   "annuity, rank, purse release", until `DECISIONS.md` D-106 deleted patron mode. The
   annuity and the purse are gone; what moved is the trigger, from the newcomer's own
   first mint to the §4.5 gift mint that buys their number — still a full 1 GRAM mint, so
   the sybil-closure argument is unchanged and the reward is now a `k_max` tier rather
   than GRAM.)* *(`DECISIONS.md` D-202 amends the price, not the trigger: the gift mint
   may send §4.1's three invite transfers to the gifter's own wallets, so a fresh address
   costs 0.70 GRAM net. It is still a full mint, and the reward is still no GRAM — §12.)*
7. **The number's price is 1 GRAM. What is ever priced above that is *earliness*, never
   the number.** The rule has two halves because the line has two classes, and since
   `DECISIONS.md` D-20 they are reached by different routes:

   - **Composites arrive at the head and mint flat.** Minting is strictly sequential over
     composites (and Unity), so every composite arrives at the head exactly once, and when
     it does anyone holding its factorization mints it for a flat 1 GRAM — no auction, no
     gate, no exception, at any point on the line.
   - **Primes are never at the head at all** (§6 point 1). A prime opens as a descending
     buy-now lot the moment it is next among unbuilt numbers, and **its price decays to that
     prime's own resting price and rests there forever**:
     `max(MINT_PRICE, P0(p) / 3, NPV(p) / 2)` (`DECISIONS.md` D-88 point 1, as rewritten by
     D-99 — there are no tiers; a memorable prime opens higher on its score and its resting
     price follows through the `P0(p) / 3` term). Where the finite `NPV` table has an entry
     the lot opens at `1.5 · NPV(p)` off the same table, so that is a 3× fall and no
     further; where it misses, `P0(p) / 3` keeps the same 3× fall off the score's ladder. **A small prime therefore rests well above 1 GRAM** — it earns tribute on every
     multiple, forever, and the resting price is half of what that is modelled to be worth;
     only a prime past the finite `NPV` table that opens under 3 GRAM rests at exactly the
     1 GRAM a composite costs.
     Either way the buyer pays that resting price plus the `RES_GAS` that funds the sale's
     own settlement (§4.4 point 1b). It never rises, it never expires, and nobody is ever
     outbid at the floor.

   §4.4's ascending lane and the prime lane's undecayed price both sell
   the *right to buy early*, which is a different object with a different price, and
   **nobody is ever forced to bid**: waiting is a complete strategy, available to everyone,
   and it is what caps what any of those mechanisms can ever fetch. This is the sentence
   most easily misread as a broken promise, so it is written here rather than left to be
   inferred: a lot clearing at 128 GRAM and the price it decays to are not two prices for the
   same thing. The bypass is the design, not a leak to be patched (§8), and closing it — by
   gating the head — is what §12 forbids at any price.

   **What the bypass is worth, exactly, because D-88 point 1 changed it and the old sentence
   promised more.** For a **composite** the bypass is the flat 1 GRAM mint at the head, with
   no exception at any point on the line — including the most memorable composite on it,
   whose score prices only what an *early* buyer pays and changes nothing about its turn
   (D-88 point 2, D-99: the head-advance walk's last special-composite skip is deleted).
   For a **prime** the bypass is that prime's resting price, not 1 GRAM: patience earns a 3×
   discount off the opening price, not an unconditional 1 GRAM. D-88 **deleted** the older
   invariant that no lane may terminate above 1 GRAM, and with it the reading that every
   number is eventually a 1 GRAM number. What survives is that the terminus is **write-once
   from `n`** — proposed by no message, updated by no handler — and that the head never
   waits on a prime, which is what §12's entry rests on now.

## 3. The assets

### 3.1 Number NFTs (TEP-62 collection)

- **Composites are built strictly sequentially: 4, 6, 8, 9, 10, … Primes are not on that
  line at all.** The sequential head advances over composites (and Unity, `n = 1`) only;
  every prime is sold off-head through §6 point 1's per-prime descending lot, whose price
  falls to the ordinary mint price and stays there. So the number line is still consumed
  in order and every integer is still minted exactly once — a prime simply reaches its
  buyer through a price rather than through a queue position (`DECISIONS.md` D-20).
- Flat mint price **P = 1 GRAM, all-in, forever** — the minter sends exactly 1 GRAM and the
  protocol pays every deploy and message (NFT item, jetton wallet, tribute accounting)
  out of the gas budget in §4.1. No variable gas quote, no refund dance. The NFT does not
  appreciate by mint-price escalation; its value comes from cash flows and
  collectibility.
- **Minting a composite requires submitting its prime factorization.** The contract
  verifies by multiplying the factors (cheap) and checking each factor is an
  already-minted prime NFT (a dictionary lookup). Proof-of-work by arithmetic.
- **Acquiring a prime requires passing on-chain primality verification** — deterministic
  Miller–Rabin with the first 13 prime bases (exact for n < 3.3·10²⁴; below
  ψ₇ ≈ 3.4·10¹⁴, which covers every auctionable number, the first seven are already exact
  and the test stops there — GAUNTLET V34), built on TVM's
  native 257-bit `MULDIVMOD` for overflow-free modular multiplication. The check runs when
  the lot is opened, not when it is bought, so the buyer pays for a verified prime and the
  settlement never re-runs it.
- **Prime mints emit no PRIMES at all.** A prime mint pays the full split of §4.1 and
  receives a rebate of exactly zero, so the entire injection is retained and the floor
  takes the largest step the mechanism can produce (§5.1). The prime minter is paid in
  **rights** instead — a raised rebate ceiling on their next composite mints, prime rank
  (§4.7.1), and the pen on the number they found for as long as they hold it (any owner
  names a number once for GRAM, `DECISIONS.md` D-212). The one-line statement
  of the whole asset design: **composites pay you now, primes pay you forever.**
- **Provable rarity classes**, each verifiable on-chain:
  twin primes, palindromic primes, Mersenne numbers, Sophie Germain primes, perfect
  powers. Rarity is a theorem, not a trait JSON.
- **An item has a rent runway, it is published, and anyone may extend it.** TON charges
  storage rent forever, and a composite item is endowed once with `ITEM_DEPLOY_VALUE` at
  mint and never topped up again — only primes receive `credit_tribute`, so only a prime's
  balance is refilled by the mechanism. A composite's balance is therefore a finite tank,
  and when it empties the account **freezes**: no transfer, no `get_nft_data`, no claim,
  nothing, until somebody funds it. Three things follow and all three are deliberate:
  - **The runway is a get-method, not a footnote.** `getStorageRunway()` on the item returns
    the seconds left at the config-18 price in force in the block that answers, with `-1`
    for no finite runway and `0` for a balance already gone. It is priced live rather than
    baked, so a network fee change is reflected without a redeploy.
  - **`TopUp` is permissionless** (`DECISIONS.md` D-62). Anybody may fund anybody's item,
    which is what stops the freeze from being a trap for an absent owner and makes keeping
    the collection alive something the community can do rather than something the operator
    must.
  - **The UI draws it** (§9.1). The reading is bounded below by zero and has no published
    ceiling — the original endowment is not a get-method — so the shape is drawn against
    the contract's OWN denominator, the `SECONDS_PER_YEAR` `getStorageRunway` measures the
    fee over, and it saturates rather than implying a tank that is exactly full. Drawing it
    against an invented horizon would be geometry that tracks no chain state.
- ~~**An item can be minted *unclaimed*.**~~ **DELETED 2026-09-07 (`DECISIONS.md`
  D-106).** Composites minted in patron mode existed on-chain with no owner, a recorded
  Patron, an optional purse and an optional claim lock, until a wallet holding none of the
  collection claimed them. The whole lifecycle is gone with patron mode: **every minted
  number has a real owner from the transaction that minted it**, gift mints included. This
  also removes the one exception §3.1's referral rule used to carry — an unclaimed number
  was a valid referral key whose `owner` was the collection placeholder, and
  `forward_to_owner` redirected its commission to the Patron rather than letting it fall
  to the pool, which contradicted the rule two bullets down. There is no such item, so
  there is no such redirect.

**Every NFT is a referral key.** The referral line in §4.1 is claimed by quoting a
*number*, not an address: a mint carrying `r42` pays 10% of the mint to the **current
owner of NFT 42**, resolved on-chain at mint time. Consequences, all deliberate:

- **Composites earn too.** Only primes collect tribute, but *any* number can earn
  referral income. A composite NFT is a working asset, not a souvenir — its yield is
  exactly the mint flow its owner can route through it.
- **The rate is 0.10 GRAM per routed mint, flat, forever, with no `n` term.** §4.1 charges
  the referral line at 10% of the mint price at every point on the number line; nothing in
  it decays with `n` or scales with the key's own size. Since D-106 deleted the patron
  line — whose `PATRON_CAP` *did* terminate — it is also **the only conditional leg left**.
  That makes the key **the only leg of the split that is both paid in GRAM and entirely
  independent of how far the head has travelled** — the
  cleanest instance of §5.4's rotation in the design, and the composite's answer to the
  prime's perpetual tribute claim. What it is *not* is a yield on the NFT: the key pays for
  flow the owner routes, so an unshared key earns exactly nothing and no holding period
  changes that.
- **Referral rights travel with the NFT.** Sell number 42 and you sell its future
  referral flow. Low, memorable numbers become vanity handles with cash-flow pricing —
  a second valuation game alongside the prime-tribute one.
- **A short integer is the whole growth primitive.** One number works as a URL
  parameter, a Telegram start param and a QR code. Attribution never depends on a backend: the key resolves from the
  collection contract.
- **You must own a piece of the line to earn from it.** There is no address-based
  referral. A new wallet's first mint carries no valid key (it owns nothing), so its
  10% falls to the pool — newcomers structurally subsidize the floor. From the second
  mint on, self-referral with their own NFT is rational and expected (§7). The one
  exception is a wallet that was **gifted** its first number (§4.5): it owns an NFT
  *before* it has ever minted, so it can self-refer from mint one. That is not a loophole,
  it is the acquisition working — and it is unchanged by D-106, which deleted the claim
  step but not the gift.

An unset or not-yet-minted key routes the 10% to the pool injection, exactly like the
unreferred case. Keys are clamped, never aliased to the team: there is no "owner key 0"
collecting orphan referrals — orphan referrals back the floor instead. (This is a
deliberate inversion of the referral-lottery pattern where unattributed traffic enriches
the operator.) The referral line has no exception; **the tribute line has exactly one**,
and it is stated in §4.1 and §2 principle 4 — an unsold prime's tribute is treasury
revenue rather than pool injection (`DECISIONS.md` D-20 point 4).

**Numbers can be minted as gifts** (§4.5): the payer's referral key earns the commission,
the recipient gets the NFT and the rebate. Numbers carry personal meaning — ages, years,
anniversaries — which makes a gifted integer a better viral object than any lottery
ticket. Combined with reservations (§4.4), "I reserved your birth year for you" is a
mechanic no other collection can copy.

**Secondary royalty: 5%, declared TEP-66, honored by marketplaces and not by this
contract — and it SPLITS 50/50 into the floor.** The numbers collection publishes standard
royalty parameters (5%) so that resales on Getgems and every other TON marketplace pay it.
(It is the game's only NFT collection since `DECISIONS.md` D-202 deleted the generators and
constellations collections; the generators collection split the same way.)

On the numbers collection (`DECISIONS.md` D-128), the destination those
parameters publish is **the collection's own address**, and the collection splits what
arrives: `ROYALTY_RATCHET_BPS = 5000` basis points of it go to the ledger as **backing** —
`T += share` with `S` untouched, forwarded to the ratchet as `pending`, which is the same
pure floor step a market clearing is (§5) — and the remainder goes to the operator at
`aux.royaltyDest`, which is deploy-fixed and unchanged. TEP-66 carries one destination, so a
two-way split has to happen at the address that is declared; that is why it is the
collection. So the one revenue line that scales with *trading* rather than with minting also
raises the floor every holder redeems against.

Three things the split is careful about. The two legs are **one multiplication and one
subtraction**, so they sum to what arrived at every amount and the truncated nanoton falls
to the ratchet rather than to the operator (§3.1's rule that an unresolved share goes to the
pool, never to the team). The collection **reserves its own storage endowment before it
forwards anything**, so a royalty can never spend the contract's rent — and what is split is
the balance above that floor, which means a payout too small to be worth the hops
accumulates rather than being burned on gas. The delivery cost is skimmed off the top before
the split, so both sides pay for it in proportion.

**And because of that skim, the split is 50/50 of the NET, not of the sale — so the
realised figure is published rather than quoted.** The three hops cost
`ROYALTY_FORWARD_GAS` (0.02 GRAM), taken before the division: at the 5% rate that is 40% of
the royalty on a 1 GRAM resale, 4% on a 10 GRAM one, and negligible above that. §9.1 forbids
printing a figure a reader cannot recompute, so the collection publishes
`getRoyaltySplit() -> (toRatchet, toOperator, forwards)` — cumulative, counted at send. The
realised split is `toRatchet / (toRatchet + toOperator)` and the delivery has cost
`forwards * ROYALTY_FORWARD_GAS` in total, both recomputable from one call. **No surface
may quote the nominal 50/50 without that;** the money is not lost either way, since a
payout too small to forward waits on a contract with no withdraw path until a later one
sweeps it.

`ROYALTY_RATCHET_BPS` is a **disclosed policy
choice, not a simulated value**: nothing under `sim/` models secondary-market turnover, so
there is no volume series for a rate to be solved against — the same footing as D-114's
`PREMIUM_TREASURY_BPS`, and `shared/params.json` says so in words.

Prime NFTs are perpetuities with a live cash flow (§3.2) and composites are
collectibles with a fixed supply of exactly one each, so secondary turnover is expected
to outlast primary minting by a wide margin; a fee line that scales with *trading* rather
than with minting is the one revenue stream that survives the number line slowing down.

The disclosure that has to travel with it, because §2's first principle is that every
economic claim is contract-verifiable and **this one is not**: GRAM royalty parameters are
a marketplace convention, not an enforced transfer tax. A direct wallet-to-wallet transfer
pays nothing, and a marketplace that chooses to ignore the parameters pays nothing. The
protocol neither blocks such transfers nor pretends the royalty is guaranteed — a transfer
hook that could block them would be an admin lever over other people's property, which
§8 does not permit at any price. So the royalty is stated as what it is: a convention the
major venues follow, worth real money in practice, and never counted as protocol revenue
in any projection the dashboard publishes.

### 3.2 Tribute (why primes are valuable)

**Tribute is prime-only.** A flat 10% of every mint is distributed *in GRAM* to owners of
**prime** NFTs. Composite NFTs never earn tribute — their return is the rebate (§5),
referral income (§3.1), rarity, and collectibility.

**The exclusion runs both ways, and that symmetry is the design.** Composites do not earn
tribute; primes do not earn rebate (§5.1). Neither asset is a strictly better version of
the other, and the choice between them is never the minter's anyway — the head decides.
What the minter of a prime buys is a perpetual claim on every multiple that will ever be
minted; what the minter of a composite buys is a liquid payment today. Two return shapes,
one price, and the number line alternates between them.

A divisor-based variant (composite owners also earning from their multiples) was
considered and **rejected**: recipients would scale with d(n), which reaches 240 for
720720 and thousands beyond, breaking the fan-out bound below.

#### The two tribute lines

The 10% splits into a divisor line and a flat line. The second exists solely to fix the
concentration problem quantified below, and both are pull-settled through the same ledger
(§3.2.1):

| line | share of the 10% | recipients | basis |
|---|---:|---|---|
| **Divisor tribute** | `1 − f` = **80%** | owners of the minted number's prime-factor NFTs | weight `w(p) = e · √p` |
| **Prime dividend** | `f` = **20%** | *every* minted prime, equally | flat accrual per composite mint |

**Divisor weights are `e · √p`, not `e`.** For n = ∏ pᵢ^eᵢ, factor pᵢ takes
`eᵢ·√pᵢ / Σ eⱼ√pⱼ` of the divisor line. Minting 234 = 2·3²·13 therefore pays the owner of
13 slightly *more* than the owner of 3 (0.0340 vs 0.0327 GRAM) and the owner of 2 the least
— where flat exponent weighting paid 2 and 13 the same and gave 3 double. The exponent
still matters; it is no longer the only thing that does.

**√p is verified, not computed.** TVM has no cheap square root, so the minter **submits
`s = ⌊√p⌋` alongside the factorization** and the contract checks `s² ≤ p < (s+1)²` — two
multiplies per factor. This is the same proof-of-work-by-arithmetic pattern §3.1 already
uses for the factorization itself: the expensive direction is off-chain, the verification
is a comparison. `f` and the exponent ½ are immutable after deploy (Phase 1 outputs, §10).

**The prime dividend costs O(1) gas, not O(π(n)).** It is never written per-prime. The
ledger keeps one accumulator `div_acc += f · 0.10 / π(n)` per **composite** mint and
stamps `entry[p]` when p becomes **eligible** — the moment the genesis or head-advance
walk crosses it and marks it, which under D-20 is not the moment it sells; a claim pays
`div_acc − entry[p]` and re-stamps. One extra field beside `owed` on the prime's own
item, one addition per mint, and accrual starts at eligibility — so a prime found
at n = 90,000 earns the dividend at exactly the same rate as prime 2 from that block
onward.

**Where `entry[p]` lives (`DECISIONS.md` D-188 point 4).** On the prime's **item**, beside
`owed` — never as a row per prime on the ledger, which config 43's 65,536-cell account cap
would fill (§3.2.1). An unsold prime has no item yet, so the walk writes its stamp into the
ledger's row for that unsold prime (`unsoldPrimes`, which is also the unsold flag), and the
sale deletes the row and hands the value to the new item in the same transaction
(`mint_item.prime_init`). A prime **sold ahead of the head** already has an item when the
walk reaches it, and a send from the walk would put a hop on the mint path, so its stamp is
parked on the ledger until the first claim hands it over. `claim_dividend` is permissionless and
nothing obliges an owner to send it, so the keeper walks the parked stamps
(`getNextSoldAhead(from)`) and claims each one; that drain, not owner behaviour, is what bounds
them. The claim is therefore a round trip
on the claimant's value: `claim_dividend` on the ledger sends `div_acc` to the item, the item
credits `div_acc − entry[p]` into `owed` and re-stamps, and its `dividend_credited` moves that
amount from the ledger's `divOutstanding` to `tributeOwed`. The ledger's
`getClaimableDividend(p)` answers while it holds the stamp and returns −1 once the item does;
the item's `getClaimableDividend(div_acc)` is the same subtraction there.

**An unsold prime's row leaves the ledger once the head has left its block** (`DECISIONS.md`
D-198). Kept there, a backlog of unbought primes is one row each — about 16,000 of them filled
the ledger's 65,536-cell account and stopped every mint. So the ledger's "unsold" is a bit
beside the prime's mark in its bitmap, and the stamp and forfeit counter of every unsold prime
in a block the head has passed move, exact, to that block's **lot block** (§4.4) through the
permissionless, caller-funded `flush_unsold` — one block at a time, the keeper sending it as
it sends `import_lot_block`. **The head-advance walk stops 26 blocks past the oldest block not
yet flushed**, exactly as it stops at the import frontier, so the rows on the ledger are
bounded whatever goes unsold. A sale of a flushed prime starts its item unstamped and asks the
lot block for the stamp, and the ledger sends the answer straight on to the item as a claim
would (`credit_dividend` with the stamp as its base); only an item that refuses it — not yet
populated when the answer arrives — gets it parked, for the keeper's claim. The ledger's `getClaimableDividend(p)` and `getDivEntry(p)`
return −2 for such a prime: read `getBookmark(p)` on its lot block. Nothing is recomputed, so
`div_outstanding`, `div_acc` and every buyer's entitlement are unchanged.

**A prime mint accrues nothing to this line.** The whole 10% tribute of a prime mint is
unresolvable — a prime has no minted factors to pay — so it falls to the pool under
§4.1's closure rule and `div_acc` does not move (§4.2.1 works the case through for 233).
Both lines in the table above are therefore read *per composite mint*; the code gate is
`primes_ledger.tolk`'s `hasTributeRecipients = kind == 0 && sumWeights > 0`.

**So a prime accrues before it has an owner, and the claim waits.** Every open Dutch lot
is accruing, but its item is only deployed when the lot closes (D-90 mints in the closing
transaction), so there is nothing to credit until then. `claim_dividend` therefore
**refuses while the prime is unsold** (error 219): the accrual keeps running against
`div_acc` and the eventual buyer claims all of it, because the item is handed the stamp the
walk wrote. This is not §6 point 2's forfeit — that rule is scoped to a *cited factor's*
divisor-line share, which is attributed to a citation and so has something to forfeit; the
flat line is attributed to nothing and is merely deferred. A prime sold ahead of the head is
refused too (201) until the walk reaches it: it is not yet in π(n) and has accrued nothing.

#### Why the weighting is `√p`, and why it stops there

**The problem.** A prime p earns only from multiples of p, which arrive at density 1/p.
Under flat exponent weighting the first ten primes capture **62%** of all tribute ever
paid, and the ~5,000 primes above 200 share 25% between them. That is not a valuation
game, it is a genesis-auction annuity with a long tail attached.

Simulated over the true factorization of every n up to the horizon, aggregate share of the
tribute line by band, flat weighting vs `√p`:

| band | # primes | flat @ 10⁵ | **√p @ 10⁵** | flat @ 10⁶ | **√p @ 10⁶** |
|---|---:|---:|---:|---:|---:|
| first 10 (2–29) | 10 | 61.6% | **22.2%** | 57.7% | **13.6%** |
| 31–199 | 36 | 13.7% | 19.3% | 12.5% | 13.2% |
| 200–1,000 | 122 | 8.7% | 19.9% | 7.8% | 15.8% |
| 1k–10k | 1,061 | 10.8% | 27.4% | 9.6% | 26.2% |
| >10k | 77,269 | 5.2% | 11.3% | 12.4% | 31.2% |
| **all primes > 200** | | **24.7%** | **58.5%** | **29.8%** | **73.2%** |

**Why the exponent is ½ and not 1.** Weighting by `p` itself flattens income further in
theory, but there is a hard structural ceiling that makes the extra flattening nearly
worthless: **p has only `N/p − 1` composite multiples below the horizon and can capture at
most 100% of each one's line**, so its lifetime income can never exceed `0.10 · N/p` GRAM.
`√p` already spends most of that budget:

| p | multiples @10⁶ | ceiling | flat | **`√p`** | % of ceiling | `p` | % of ceiling |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 2 | 499,999 | 50,000 | 21,293 | 3,216 | 6.4% | 575 | 1.1% |
| 211 | 4,738 | 473.8 | 133.8 | **214.8** | 45% | 260.8 | 55% |
| 1,009 | 990 | 99.0 | 29.4 | **71.9** | **73%** | 88.8 | 90% |
| 9,973 | 99 | 9.9 | 3.3 | **9.33** | **94%** | 9.88 | 99.8% |
| 49,999 | 19 | 1.9 | 0.72 | **1.87** | **98%** | 1.90 | 100% |

Going from `√p` to `p` buys prime 9,973 **+6%** and prime 1,009 +23%, while cutting prime 2
by 82% and collapsing the first ten to 4.9% of the line — destroying the small primes'
fair value (§6) to hand the tail almost nothing. **½ is where the marginal return dies**, and the
residual inequality past it is the `1/p` multiple count: arithmetic, not policy. This is
also the argument against every steeper variant a reader will propose, so the ceiling
formula belongs next to the get-method.

**Two rejected alternatives**, both stronger-looking and both worse:

- **Weighting by `p` (full flattening).** Rejected above on marginal return. It also
  guts §6: the auction prices the market's belief in the game, and it cannot do that if
  the assets being auctioned are worth a twentieth of what the mechanism implies.
- **A lifetime cap on a prime's tribute**, mirroring the retired `PATRON_CAP` (§4.6). It is the
  sharpest anti-rent generator available and it is rejected because a perpetual, uncapped claim
  is the *entire* compensation a prime minter receives under §5.1. Capping it reopens the
  sequential-stall problem that §5.1 calls the mechanism's kill criterion — paying for
  tribute equality in liveness is the worst trade in the document.

#### Large primes are early, not underpaid

The band tables above measure every prime at the same *calendar* horizon, which compares a
prime that has been alive for the whole game against one minted last week. The honest
comparison is at equal **multiplicative age** — what p has earned once the head reaches
`c·p`, since a prime's first possible payment is its own doubling at 2p:

| p | head = 2p | 5p | 10p | 50p | **100p** |
|---:|---:|---:|---:|---:|---:|
| 2 | 0.10 | 0.28 | 0.57 | 2.17 | **3.79** |
| 5 | 0.06 | 0.26 | 0.50 | 2.00 | **3.49** |
| 211 | 0.09 | 0.35 | 0.76 | 3.68 | **7.02** |
| 1,009 | 0.10 | 0.38 | 0.83 | 4.25 | **8.32** |
| 9,973 | 0.10 | 0.39 | 0.88 | 4.67 | **9.33** |

(GRAM, `√p` weighting, divisor line only.) **At equal age the ranking inverts: a large prime
is the better asset.** Prime 9,973 has earned 9.33 GRAM by the time the head reaches 100× it;
prime 2 had earned 3.79 GRAM at the same point in its own life. Break-even against the 1 GRAM
mint price arrives at head ≈ **12p** for large primes against ≈ **20p** for the genesis
ones. The reason is the same ceiling that limits them: a large prime *dominates* the
weight of nearly every multiple it appears in, so it takes 60–98% of that mint's divisor
line, where prime 2 splits its multiples with everyone.

So the deficit is **discounting, not unfairness**. Prime 9,973's 9.33 GRAM is real and
arrives over ~110,000 further mints; prime 211's arrives over ~4,700. What a large prime
lacks is not lifetime income but *time*, and the protocol pays for exactly that, in cash,
at mint: the `PRIME_UPLIFT` credit (§5.1) is spendable on the minter's next five composite
mints, and its value **rises** with n — 0.138 GRAM at n ≤ 1,000 to 0.165 GRAM at n = 10⁶ — as
`k_max(n)` decays away from the fixed `K_CEIL` and opens headroom. **This is one instance
of a general property, and §5.4 states it in general:** every leg of the split that is not
the rebate is `n`-invariant, so a decaying `k_max(n)` rotates each mint's value toward the
asset side without any lever being pulled. The credit is
compensation for the wait, the tribute weighting is compensation for the amount, and they
are strong in opposite regimes by construction. **Do not solve the same problem twice:**
Phase 1 must check that `f`, the ½ exponent and `PRIME_UPLIFT` together do not
over-compensate late primes into a reservation-book farming target (§8).

- Small primes (2, 3, 5) still divide the most future numbers → strongest cash flows →
  they remain the blue chips of the prime lane (§6), by a factor of ~17× over
  prime 211 rather than ~150×.
- A prime p earns from multiples of p at density 1/p while taking a share that grows like
  √p, so its value decays in expectation like **1/√p** scaled by future mint volume — a
  genuine valuation problem grounded in divisor density, not vibes. Pricing prime #97
  correctly *is* the game for quants: every prime lot opens at `P0(p)` — `1.5×` the sim's NPV
  wherever that binds — and decays toward its resting price (§6 point 1), so a buyer who
  prices it better than the sim captures the difference.
- **`f` is the flatness dial and it is not free.** Raising it from 0 to 0.2 lifts the >10k
  band from 11.3% to 21.8% of the line at n = 10⁵; 0.4 would take it to 32.4%. The cost is
  conceptual: a flat dividend pays a prime for *existing* rather than for dividing, so it
  is the one part of the tribute line that is not a theorem about divisibility, and every
  unit of `f` makes primes more interchangeable and pricing them less interesting.
  0.2 is proposed as the point where the tail becomes viable without the assets becoming
  fungible.

**The self-tribute discount — say it out loud.** Tribute owed to primes *you own* comes
back to you. The owner of NFT 2 is refunded the 2-share of tribute on **every even
number they ever mint**; collect {2, 3, 5} and most of your future tribute line is a
rebate to yourself. Owning small primes is a structural, compounding minting discount on
top of their inbound cash flow — a mechanism that is already implied by §3.2's rules but
must be stated, because it materially raises the small primes' fair prices (§6) and
it is exactly the kind of hidden corollary this audience enjoys discovering first.

**Fan-out is bounded by ω(n), not by n.** Recipients equal the count of *distinct* prime
factors; exponents are weights on an existing recipient, not extra recipients. ω grows
absurdly slowly, since the smallest n with k distinct factors is the k-th primorial — the
first number with 7 is 510,510, with 8 is 9,699,690, with 10 is ~6.5·10⁹, and with 19 is
~7.9·10²⁴, so ω(n) ≤ 18 for every n below the 3.3·10²⁴ Miller–Rabin exactness bound.

**The binding bound is ω(n) ≤ 12, and it comes from the reservable cap.** Every number
this protocol can ever mint satisfies `n ≤ AUCTIONABLE_MAX` = 2³² · 10⁴ − 1 ≈ 4.29·10¹³
(§4.4, `DECISIONS.md` D-11/D-18 — every entry point refuses more). The smallest number
with 13 distinct prime factors is 41# = 304,250,263,527,210 ≈ 3.04·10¹⁴, which is **seven
times the cap**, so ω = 13 is unreachable by construction. The smallest with 12 is
37# = 7,420,738,134,810 ≈ 7.42·10¹², which sits comfortably *under* the cap — so ω = 12 is
reachable, and is the ω any bound must admit. Twelve recipients is far under TON's
255-action limit, and under the per-transaction gas ceiling that binds before it.

**But cost is not monotone in ω, and that is the part worth carrying away.** Measured on
the deployed ledger (`GAUNTLET.md` D6), an ω = 8 mint costs **more** than an ω = 12 one —
0.0264 GRAM against 0.0242 — because the fee depends on the magnitudes of the primes, the
`s = ⌊√p⌋` arithmetic and dictionary depth, not merely on how many factors there are. The
worst protocol-side cost measured across the fan-out range is **0.0264 GRAM against the
0.20 GRAM gas & ops line** (`DECISIONS.md` D-117), 7.6× headroom. So fan-out cost cannot be extrapolated from ω
alone: ω bounds the *number of recipients*, and a separate measurement bounds the *cost*.
Treating "≤ N recipients" as a cost bound is exactly the mistake this paragraph used to
invite.

**≤ 8 is the head lane's expectation, not a bound.** The earlier form of this paragraph
derived ≤ 8 from "minting is sequential, so n ≈ total mints ever" — reaching ω = 9 would
need n ≥ 223,092,870, i.e. 223 million mints. That premise is **no longer true**, and it
stopped being true at `DECISIONS.md` D-30: the auction lane sells any number up to the
reservable cap, so a player may acquire a 12-distinct-factor number on day one without
223 million mints happening first. The conclusion survives — the head lane really does see
≤ 8 for any plausible mint count, and the cap really does forbid 13 — but the *reason*
had to be replaced, and a reader who checks the old justification against the auction lane
finds the premise gone in a minute (§2: the audience is the auditor). Sizing work must use
**ω ≤ 12**; ω ≤ 8 is a statement about what the sequential head will actually reach, not
about what an adversary can present.

### 3.2.1 Tribute accounting: credit at mint, settle on claim

Resolves the push-vs-pull question. Tribute is **pull-based** — *the money* does not move
at mint, and the recipient is never paid without asking. It is not message-free, and the
distinction matters to anyone sizing a mint:

1. **At mint**, the **ledger** (§3.4) sends **one `credit_tribute` message per cited
   factor** — up to ω(n) ≤ 12 of them (see §3.2's bound) — to that prime's own NFT item,
   at `CREDIT_TRIBUTE_VALUE` = 0.008 GRAM of gas each. The message carries the share as a
   **number**, not as value: **the GRAM stays custodied on the ledger** and is declared in
   its `tributeOwed` meter, which is what keeps `sweep_ops` from treating player money as
   gas & ops surplus. The `owed` balance therefore lives on the **item**
   (`primes_item.tolk`'s `getOwed()`), not in an `owed[p]` dictionary on the ledger.

   A cited factor whose prime is still **unsold** is the exception: its share is
   **forfeited to the treasury** and no credit is sent at all (§6 point 2, D-20 — never
   escrowed, never accrued on a nonexistent item, never paid to whoever later buys the
   lot).

   This paragraph previously read "zero outbound messages, negligible gas, no dependence
   on recipient liveness". None of the three held after the accounting moved onto the
   item: the sends exist, the gas reconciliation *depends* on them existing, and a credit
   that bounces needs the retry lane (`retry_credit`) rather than being impossible.
2. **On claim**, the prime's owner initiates and pays: owner → NFT item (verifies
   `sender == owner`) → ledger (pays out of its custodied balance and zeroes the item's
   `owed`). Three messages, entirely on the claimant's gas.
3. `getOwed()` on the prime's own NFT item exposes accrued tribute, so marketplaces and
   buyers can price a prime NFT from its actual cash position — read on the item, since
   that is where the balance is kept. The ledger's `getSolvency` publishes the other side
   of the same identity: its `tributeOwed` must equal `Σ_p getOwed(p)` over every item.
4. **A prime reads as a bond.** `owed` falls to 0 on every claim, so it cannot say what a
   prime has *earned*. The item therefore also keeps `tributeTotal`, incremented by every
   `credit_tribute` beside `owed` and never decremented, published as `getTributeTotal()`
   — divisor tribute paid to date, undiscounted (the flat dividend settles on the ledger
   and is not in it). `/n/:p` draws it against `getNpv(p)` on the market, the sim's
   discounted value of the prime's future tribute at its own mint (`params.json`
   `trophy_auction.npv_ladder`), labelled a **model**: the collectible's cash-flow side,
   with the forecast never presented as a balance.

The alternative — pushing each share into the prime's own NFT contract so the balance
travels with the NFT — was rejected on dust economics: a 7-factor mint splits 0.10 GRAM
into ~0.014 GRAM shares against ~0.004–0.006 GRAM of forward fee plus receiving-contract
gas each, skimming 30%+ off tribute, worsening as ω rises.

Storage is the tradeoff that decided where this lives. At n ≈ 10⁶ there are π(10⁶) = 78,498
primes; as one dictionary at ~2 cells an entry, any per-prime table on a shared account hits
config 43's 65,536-cell cap near n ≈ 386k, and the first transaction that must grow it rolls
back. So **every per-prime field lives on that prime's item** — `owed`, `tributeTotal`, the
dividend stamp `entry[p]` and the forfeit counter (`DECISIONS.md` D-188 point 4). What the
ledger keeps per prime is only what exists **before** the prime has an owner: one row per
unsold prime (its stamp; the row is the unsold flag) and one per no-owner prime a mint has
cited (its forfeit counter), both deleted and handed to the item at sale, plus a parked stamp
for a prime sold ahead of the head until the keeper's claim hands it over. Its growth is the **unsold backlog**,
not π(n). The market keeps one **sold bit** per closed lot (256 to a cell) rather than the
closed lot itself (§4.4).

### 3.2.2 (deleted)

This section specified constellations, a second number line built from owned numbers with a
PRIME GENERATOR's operation (`DECISIONS.md` D-102, D-103, D-125, D-192, D-193). **`DECISIONS.md`
D-202 deleted it**, with its collection, its item contract, the registrar's build handlers and the
vault's discovery bounty, whose 1,050,000 PRIMES stayed in the vault and joined §9.6's puzzles
track. There is one number line. The section number is kept so older citations resolve; nothing
else lives here.

### 3.3 PRIMES jetton (TEP-74, and TEP-89)

**The standard surface is two halves, and only one of them is readable by a human.**
TEP-74's get-methods (`get_jetton_data`, `get_wallet_address`, `get_wallet_data`) are what
a wallet or an explorer calls, off chain, against a snapshot. A **contract** cannot call a
get-method, so a DEX vault deploying against this master learns its own PRIMES wallet
address the only way one contract can ask another: by sending TEP-89
`provide_wallet_address#2c76b973` and waiting for `take_wallet_address#d1735400`. The
master answers it permissionlessly — it is the same derivable value `get_wallet_address`
already returns to anyone, and gating it would gate listing rather than abuse.

This is load-bearing for §4.3, not a compliance checkbox. PRIMES is one side of the
ratchet's DeDust pair; a master that does not answer TEP-89 is one no venue can build a
vault for, so `flush()` has nothing to sell into and the floor has no depth behind it.
Measured on testnet 2026-09-16: without the handler, DeDust's factory accepted
`create_vault`, the new vault deployed, asked, was refused with exit 101, and died
uninitialised with its stake bounced back — while `create_vault` itself reported success.


The liquid asset. Emitted **only** as mint rebates (§5), at the **floor-donation op**
(§6 point 3 — anyone may send GRAM to the ledger and be minted `L` PRIMES per GRAM against
it; this is where the DeDust pool's PRIMES side comes from), from the **bounty vault** —
a single genesis-minted, contract-held allocation that funds §9.6's score rebates (the
`puzzles` track, D-47/D-99; it absorbed the constellation discovery-bounty track when
`DECISIONS.md` D-202 deleted it), primorial-era bounties (§7) and §9.4's quests — and from the **treasury's vesting lock**
(`DECISIONS.md` D-100 point 6 as amended by D-166; §6 point 3): a one-time, disclosed
mint of 1,000,000 PRIMES held by `primes_vesting.tolk` and released to the **governed
treasury** (§5.5) in **four equal 25% tranches 90 days apart, the last at day 270**
(D-91). It is what funds §5.3's PRIMES staking (`DECISIONS.md` D-168; it funded the LP miner
until then). **There is no team allocation at all** (D-166
deleted the operator's matching 1,000,000-PRIMES lock) and no premine beyond these two
named, get-method-exposed contract holdings.

**The vest moves custody, not economics.** `S` counts the lock's allocation at genesis;
`T` never sees it. So `p_f = T/S` is
bit-identical to an unvested genesis — the lock changes *who can sell and when*, and
nothing else. It holds a jetton wallet and zero GRAM liability, so it does not appear in the
§3.4 solvency check at all. Its own reading is `getVesting` on the lock, and the same
one-get-call check the vault gets applies here too: `totalAmount − releasedAmount` must
equal the lock's own jetton wallet balance, which trusts none of the lock's arithmetic.

**The bounty vault is counted into `S` at genesis.** Every bounty ever paid is therefore
already priced into the floor from day one; paying a bounty moves tokens, never `p_f`.
This is the same conservative direction as the burn accounting in §5 — the floor
understates, never overstates. The vault is **15,600,000 PRIMES** at a nominal `T₀ = 200
GRAM` and `L = 10,000` (D-46: `T₀` sizes supply only — it is not deposited anywhere) —
`T₀·L·7.8`, and therefore 78/83 (94.0%) of `S₀ = 16,600,000` at any nominal-seed size
(§6 point 3; `DECISIONS.md` D-204 raised D-43's 500% to 780% alongside a larger donation and
gave the whole 5,600,000 increase to §9.4's contract-fact quests. D-43's 10,000,000 was up
from D-42's 100%/50%, sized for a puzzle campaign that D-47 replaced
with §9.6's special-number rebates;
10/11 of `S₀` before D-204, 5/6 until D-166 deleted the operator's 1,000,000-PRIMES lock from `S₀`).
Anything unclaimed after a stated horizon is burned (which, since `S` never
decrements, simply widens the circulating-supply gap in holders' favor).

The vault is reported as two numbers, never netted (§11.21): `get_vault_payouts` on the
vault for what it has paid into circulation, and the ratchet's burns for what has left it.
Its remaining balance is not a stored field at all — it is the vault's own jetton wallet,
so `15,600,000 − paid ≈ balance` is a check that costs a reader one get-call and trusts
none of the vault's arithmetic.

**The vault and the burns point the same way and do not compete.** A bounty payout
moves vault tokens into circulation without touching `S`; a burn removes circulating
tokens without touching `S`. Both change circulating supply in holders' favour relative to
the floor, neither moves `p_f`, and the two are funded from opposite ends of the same
accounting — so they should be reported as two numbers on the dashboard rather than netted
into one (§11.21).

**And they are measured, not asserted (§9.1).** Each of the three quantities has a
get-method on the contract that owns it: `S` is `getFloorDen` on the ledger, circulating
supply is TEP-74 `total_supply` on the jetton master (the only contract that knows it,
because burns decrement it and `S` by construction never does), the burn total is
`getBurnStats` on the ratchet (the flush's own swap proceeds only — PRIMES a holder sends the
ratchet directly are burned when they pay for it, uncounted), and vault payouts are
`getVaultPayouts` on the vault — with
the vault's remaining balance readable on its own jetton wallet, so `vault size − paid ≈
balance` is checkable without trusting the vault's arithmetic. The dashboard reads all
four and performs no arithmetic between them. The one derived figure it shows,
`S − total_supply`, is labelled as derived and is explicitly *not* the burn total: it also
carries the vault's still-unspent tokens and any rebate mint that bounced after `S` had
counted it. `getBurnStats` also returns whether the ratchet's burn counter is armed at
all, because "nothing burned yet" and "not counting yet" are different claims and a
dashboard that renders the second as the first has invented a measurement.

**A bounty the vault owes but has not delivered is a fifth number, and it is published
too** (`getDeferredPayouts` on the vault; `DECISIONS.md` D-129). The vault pays every
bounty by TEP-74 transfer and spends 0.1 GRAM of its own GRAM balance on each hop, so a
vault that is short of GRAM cannot deliver — and because the ledger's leg is deliberately
non-bouncing (a vault failure must never unwind the mint that triggered it), a payout that
fails there fails in total silence. Each trigger is one-shot, so silence meant permanent
forfeit. The vault therefore checks its balance before it pays: when it cannot afford the
hop it writes the payout to its retry journal and sends nothing, leaving the era or the
number UNPAID rather than marked paid, so anyone may finish it later with a permissionless
`retry_bounty_payout` — which carries its own hop (0.15 GRAM attached, the same as a
discovery claim), so a repeated retry never spends the vault's balance. `getVaultPayouts` still counts only what has actually left — a
deferred bounty is a liability, not circulating supply, and netting the two would report
tokens as in circulation that are still in the vault.

Running short of PRIMES is different from running short of GRAM, because nothing refills
the vault: genesis funds it once. So the vault carries its genesis funding as deploy data
(`getVaultFunded`), and an era bounty or number rebate that `funded − paid` cannot cover is
refused before anything is sent — no journal row, no bounce, the era or number left
UNPAID and forfeit (GAUNTLET.md V26.7). Journalling it would only buy a retry that bounces
again, and would add a row for every later head-minted composite. The wallet's balance,
not this figure, is still what the dashboard shows.

### 3.4 The contracts — and why none of them is a bank

Earlier drafts referred throughout to "the bank," a word that was never defined and that
turned out to be doing four unrelated jobs at once. This section names the components,
says which GRAM each one holds and whose it is, and retires the word.

| Component | GRAM it holds | Whose it is | The only ways GRAM leaves |
|---|---|---|---|
| **Splitter** — mint entry point: proof check, head advance, the §4.1 split | none (in-flight only) | — | the six split lines, atomically |
| **Ledger** — `T`, `S`, `p_f`, `div_acc`, the unsold-prime rows (§3.2.1), all get-methods | accrued tribute | the prime owners' | tribute claim (§3.2.1), signed-voucher claim (§9.5) |
| **Ratchet** — `pending`, `flush()`, swap, burn, the staked reserve (§4.3.2) | protocol backing | **nobody's** | `flush()` at contract-computed size and price (§4.3.1), and the §4.3.2 legs to the staking pool — every one to a venue address or the treasury, every amount computed here |
| **Market** — one price-discovery contract for every lane: the ascending lot lane and the per-prime descending lane (§4.4, §6) | standing bids on open lots | the bidders', until the lot closes | refund to an outbid bidder, settlement/premium to the ledger |
| **Collection + items** — TEP-62; per prime `owed`, the dividend stamp `entry[p]`, the forfeit counter; every number's name, written by its owner for GRAM (D-188, D-212) | none — a naming fee passes through to the ledger in the same transaction | — | the fee to the ledger's floor step, a refund to the payer |
| **Jetton minter + bounty vault** | none | — | PRIMES only, never GRAM (§3.3) |
| **Registrar** — the eight era trophies (§4.7) and their engravings | none | — | a re-engraving's fee to the collection, a refund to the payer |
| **Treasury** — the governed pot, LP custody for the vote, and the source of §5.3's staking budget (§5.5, D-100, D-168) | §4.1's 5% line on every mint (D-152) + 58% of the unsold-prime forfeits (D-166) | protocol revenue, under the LP electorate's control | a passed proposal, or nothing — `distribute()` sends PRIMES, never GRAM |
| **Position child** — one per depositing wallet, that wallet's LP positions (§5.5.3) | none | — | — |
| **Stake master** — PRIMES staking: principal, the reward stream, the accumulator (§5.3, D-168) | none — it owes PRIMES, not GRAM | — | — |
| **Stake position child** — one per staking wallet, that wallet's stake positions (§5.3) | none | — | — |
| **Minter card** — one per minting wallet: its rebate standing (prime rank, the §5.1 and §4.5 windows, §4.7's recruits and era tally); every head mint passes through the beneficiary's card to the ledger (§4.5, D-191) | none — what passes through is the mint's own value, forwarded | — | — |
| **Lot block** — one per 256-number block an auction touched beyond the ledger's import frontier: the block's claim and sold-prime bits until the import pulls them in (§4.4, D-196) | none — the openers' forwarded gas, which rides back to the ledger with the words | — | its one reply to the ledger, which deletes it |
| **LP sink** — locked depth (§5.5.4) | none — and anything sent is unrecoverable | nobody's | **no outbound message type exists in the contract** |

**The ratchet's outbound set is five destinations, not one, and the count was never the
property this section asks for** (`DECISIONS.md` D-151, §4.3.2). Until v5 it was a single
message — the DeDust swap — and this document said so. It is now the DeDust native vault
(the flush swap), the PRIMES jetton wallet (the proceeds burn), the Tonstakers pool (the
deposit), the tsTON jetton wallet (the withdrawal burn) and the governed treasury (the
harvest transfer). **What survives is what §8's claim actually rests on, and it is a
property rather than a count:** every destination is a venue address or the treasury, every
amount is computed by the contract, **no message names a recipient a caller chose**, and
there is still no withdraw, no sweep and no owner. That is checkable by reading one
contract's sends, which is the whole reason the ratchet is a contract of its own; a
destination census is what `NoAdminWithdraw.spec.ts` asserts, and it classifies each of the
five.

The registrar's only **outbound** messages are a trophy re-engraving's fee, sent on to the
floor through the collection, and the payer's change (`DECISIONS.md` D-212); it moves no
protocol GRAM (its constellation builds and their sends went with `DECISIONS.md` D-202).
**Nothing it stores grows with the number line** (`DECISIONS.md` D-188 point 6): per-number
state — a number's name — lives on the per-number item that already exists,
as `owed` does, and the prime rank is on each wallet's minter card (§4.5); what remains is
eight trophies and fixed counters. Its declared liability stays structurally zero, which is
the property that matters and the whole reason it is a separate contract.

**The market row is ONE contract.** `DECISIONS.md` D-3 and D-16 replaced
`primes_auction.tolk`, `primes_trophy_auction.tolk`, `primes_reservation_book.tolk` and
`primes_reservation_shard.tolk` — 3,269 lines, 36% of all Tolk in the repo — with
`primes_market.tolk` plus an escrow shard under it. **D-90 deletes the shard too**: a won lot
mints in its own close, so there are no reservation records and no escrow to custody. What is
left is one contract holding lots, counters, config and `headHint`. Wherever this document
says "the reservation book", read the market; the settled layout is
`docs/audit/unified-market-layout.md`.

**TWO separate pools of GRAM exist at all times, with two different owners** (D-90; there were
three until the escrow was deleted). `pending` is unwithdrawable protocol backing; `owed` is
money already promised to specific NFT owners. They are not interchangeable, they do not fail
together, and **a reader comparing a contract's balance to `get_pending()` will not get a
match unless the pools sit in different contracts.** That reconciliation is one of the few
things a skeptic can check per block without trusting anything, so it is worth engineering
for:

> For each contract, balance ≈ its own declared liability, checkable in one call. The
> ratchet's balance is `pending` plus a small gas reserve and nothing else.

**§4.3.2 does not add a term to that check, and the reason is where the GRAM physically is.**
Staked backing has left the ratchet's balance for the Tonstakers pool, so counting it as a
liability against the balance would make the delta negative for the whole round trip.
`getSolvency().liability` therefore stays **exactly** `pending`, and `stakedCost` and
`exiting` are read from `getStaking()` as terms of `T` — the same position `inFlightFlush`
has always been in, for the same reason.

**The third pool is gone rather than smaller, and that is the stronger statement.** Escrow
was refundable customer money: a won lot became a claim holding 1 GRAM on a range-partitioned
shard until the head arrived. Because no caller could enumerate the deployed shards, the pool
total was unreadable, and the market maintained a running aggregate over the shard traffic —
with an under-report bound published beside it, because the count could drift on a
force-cancel race. D-90 deletes the wait, and with it the claim, the shard, the aggregate and
the bound. **No contract in this system now holds refundable customer money at all**, which
removes a term from the solvency check rather than making one more accurate. The market still
holds standing bids on open lots, and those are refunded in the same transaction they are
outbid in — never a balance anyone has to come back for. It still answers the one-call
check: the market's `getSolvency()` declares Σ standing high bids, plus premiums of closed
lots awaiting the ledger's `SettleConfirmed`, plus `unforwardedPremium`, against its balance.
A standing bid is what the bidder paid less the gas their own message burned: a raise keeps
`BID_GAS` and a race-lost open keeps `REJECT_GAS`, both priced into what the caller sends, so
no bid's gas is paid out of the market's float (GAUNTLET V22/V23).

**Re-reading "two pools and no third" against a treasury that holds four assets** (D-100,
§5.5, and tsTON since D-151). The count is about **protocol GRAM**, and it is unchanged: the treasury holds none of
it. `pending` is on the ratchet, `owed` is on the ledger, and the treasury's GRAM is fee
revenue — §4.1's 5% line on every mint (`DECISIONS.md` D-152), 58% of the unsold-prime forfeits (D-166), plus, since D-114, half of
every auction premium (§4.4) — which nobody is owed and which can leave only by a passed
proposal. It is not refundable customer money, so D-90's stronger sentence survives
verbatim: **no contract in this system holds refundable customer GRAM at all.**

**Is the treasury part of the balance-versus-declared-liability check? Not on the GRAM row,
and it brings two rows of its own.** Working it out rather than asserting it:

- **GRAM: no row, because there is no declared GRAM liability to compare a balance against.**
  The treasury's GRAM is nobody's claim — no depositor can ask for it and no get-method
  declares an obligation over it. A zero row would be worse than no row: it would invite a
  reader to start summing an unrelated balance into the §3.4 aggregate.
- **PRIMES: no row on the treasury since `DECISIONS.md` D-168, and the row moved to the stake
  contract.** The treasury used to owe PRIMES to LP miners who had accrued and not claimed
  (TR-1, `getMinerSolvency()`). The miner is deleted and nothing accrues inside the treasury,
  so it declares no PRIMES liability. **The stake contract carries that shape instead**:
  its PRIMES wallet ≥ `lockedTotal + streamRemaining + unclaimedTotal` (ST-1,
  `getStakeSolvency`), checkable in one get-call, and a shortfall is a stop-the-line reading
  rather than a drift. It owes PRIMES and holds no GRAM, so it is **not a pool of GRAM** and
  leaves "two pools and no third" exactly as it was.
- **LP: a row, and it is a genuine custody relationship this system did not have before.**
  The treasury holds *other people's* LP receipts — and, since `DECISIONS.md` D-167, only
  those: there is no donate path and no LP proposal asset. `Σ positions.amount == LP wallet
  balance` (TR-5) is the reconciliation (§5.5.2). Stated plainly because it is the one
  new thing here a skeptic should check: the treasury is a **custodian of depositor LP**,
  withdrawable by the depositor and by nobody else, and that is not the same claim as
  "holds no customer money" — it is the same claim §3.4's table already makes about `owed`
  on the ledger, money already promised to specific NFT owners and claimable by them and by
  nobody else, in a different token. *(The comparison here was the purse on an unclaimed
  item until `DECISIONS.md` D-106 deleted patron mode; `owed` is the surviving custody row
  of the same shape.)*

So the decomposition rule is unweakened and gains a clause: **each contract's balance
matches its own declared liability, in every asset it holds** — and for the treasury that is
four assets and one liability (the depositors' LP); the stake contract adds one PRIMES
liability of its own (ST-1). The fourth, tsTON, arrives from §4.3.2's `harvest()` and
declares no liability at all: nobody is owed it, and it leaves only by a passed proposal like
the GRAM beside it.

**Why not "bank."** Three independent reasons, any one sufficient:

- **It claims the opposite of what the contract does.** A bank takes custody on a promise
  to return; every GRAM path here is a formula with no discretion and no withdraw
  function. §5 was already forced to write *"not a deposit"* — the document was defending
  against the connotations of its own chosen word.
- **It hands §12's perception risk a free premise.** "Where does the money in the bank
  go?" is a question that has to be answered; "where does the money in the ratchet go?"
  answers itself.
- **"Vault" is unavailable as a fallback** — DeDust's native vault appears in §4.3's
  execution path and the bounty vault is §3.3. Two collisions already spent.

**Why "ratchet."** It names the mechanism rather than the pot, it is already the
document's central term (§5), and it makes the defining property sound like a definition
instead of a promise: *a ratchet that pays out is not a ratchet.* Where the two senses
could be confused, "the ratchet" is the contract and "the ratchet theorem" / "ratchet
step" are the mechanism — the theorem is named after the contract's behaviour, not the
other way round.

**How many contracts, actually?** Decomposition is not free on TON: every boundary is a
message hop charged against the gas & ops line (§4.1), and the split must stay atomic. The
recommendation is **not** one contract per row above:

- **Splitter and ledger fuse.** They touch the same state in the same transaction; forcing
  a hop between them buys nothing and costs the mint path.
- **The ratchet separates.** It is the largest balance, the one with a permanent standing
  position under §4.3.1, and the one whose outbound set must be readable in isolation for
  §8's "no admin withdraw path" claim to be verifiable rather than asserted.
- **The escrow separated, and then stopped existing (D-90).** The rule was that refundable
  customer money must never share a contract with unwithdrawable backing — the single
  highest-value structural safeguard in the system, and cheap because settlement was already
  an asynchronous step. Settlement is no longer asynchronous: a won lot mints in its own
  close, so there is no refundable money to keep apart. The safeguard is satisfied by
  absence, which is the only way to satisfy it that cannot regress.

Three contracts plus the collection and the jetton. The extra hops were benchmarked against
the gas line in Phase 3 (§10) and are what D-117's derived 20% line is sized to carry; the
escrow the paragraph once said to keep was deleted by `DECISIONS.md` D-90.

### 3.5 (deleted)

This section specified PRIME GENERATORS, an operation held as an NFT and deployed to an invitee
on §4.1's invite line (`DECISIONS.md` D-101, D-115). **`DECISIONS.md` D-202 deleted them:** a
generator wrote its owner into storage and sent the wallet nothing, so an invite reached nobody.
§4.1's seventh line now sends up to three plain text transfers instead. The section number is
kept so older citations resolve; nothing else lives here.

## 4. The core loop

1. A player acquires a number for 1 GRAM all-in, optionally with a referral key `rN`. Two
   routes, and which one applies is decided by the number rather than by the player:
   **the next composite at the head** is minted directly by submitting its factorization,
   or **a prime** is bought off its standing descending lot at whatever the price has
   decayed to — its resting price `max(NPV(p)/2, P0(p)/3, MINT_PRICE)` at the bottom, never
   below 1 GRAM, plus `RES_GAS` (§4.4 point 1b, §6 point 1).
2. The 1 GRAM is split instantly and transparently (§4.1). Whatever survives every other
   line — tribute, referral, treasury, gas — is the pool injection.
3. **If the number is composite**, the player receives the current rebate in PRIMES (§5),
   whose floor-value is a fraction k(t) < 1 of that surviving injection, and the rebate
   clock resets to its minimum. **If it is prime**, the player receives no PRIMES at all
   (§5.1) — the whole injection is retained, the floor takes its maximum step, and the
   player is paid in the asset itself, naming rights, prime rank and a rebate-ceiling
   credit on their next composite mints.
4. The rebate share k(t) starts climbing again, second by second, toward its cap —
   making the *next* mint gradually more attractive.

**The number line decides how often a prime appears** — roughly one in every ln(n) numbers
— and that is the game's natural rhythm: a continuous stream of liquid, clock-driven
composite mints at the head, punctuated by a prime lot opening beside it, priced on rarity,
falling toward 1 GRAM, and paying its buyer nothing today and everything later. Since
`DECISIONS.md` D-20 the two run in parallel rather than in alternation: the head does not
wait for the prime, and the prime does not wait for the head.

The loop has one further branch. A mint may name a **beneficiary** other than the payer
(§4.5), which changes step 1 only in where the NFT and the rebate go, and leaves steps 2,
3 and 4 bit-for-bit identical. The split does not know the difference, so nothing below
this line depends on which branch was taken.

### 4.1 The split

Five lines are deducted first — three fixed, two conditional; **the pool injection β is
the residual**, not an independently chosen constant. This is what makes the rebate cap in
§5 exactly computable on-chain from real GRAM rather than from a hardcoded fraction.

| Line | Share | Destination | Purpose |
|------|------:|-------------|---------|
| Tribute | **10%** always | 80% to the minted number's prime-factor owners weighted `e·√p`, 20% split flat across all minted primes (§3.2) | Makes primes cash-flowing assets |
| Referral | **10%** if a valid key is set, else → pool | Current owner of NFT #key (§3.1) | Distribution incentive; makes every NFT a yield asset; documented self-referral discount |
| Treasury | **5%** | The **governed treasury contract** (`ConfigA.feeDests.treasuryAddr`, §5.5) | Protocol revenue, spendable only by a passed proposal or, for its PRIMES, by `distribute()` to §5.3's stakers (D-168). This row has been named twice: D-100 point 6 renamed it ~~"Treasury 5% · Owner"~~ → "Operator 5%" on the reading that the line was the team's fee, and **D-152 reverses that reading and the destination with it** — the recurring per-mint fee is protocol revenue, so it lands where nobody can spend it unilaterally. The operator's only remaining claim on a mint is §6 point 2's forfeit remainder (42% since D-166); the gas & ops surplus is swept to the ratchet pool since D-117 |
| Gas & ops | **20%** (derived, `DECISIONS.md` D-117; 10% until then) | Deploys, forward fees, primality gas subsidy, `owed` storage rent (flush gas left this line with D-146 — the caller pays it, §4.3); **the surplus over a standing reserve is swept back to the ratchet pool**, emission-free (it swept to the operator until D-117). Reservation settlement is **not** on this line — it is funded by `RES_GAS` (§4.4) | Keeps the all-in 1 GRAM solvent; what it does not spend raises the floor |
| Invite transfers | **`count` × (value + 0.001 GRAM fee)**, `count` set by the minter up to the operator's live count (genesis 3 × 0.1 GRAM), never more than **0.31 GRAM** a mint; unspent slots → pool | One plain, non-bounceable GRAM transfer per address the minter names, sent inside the mint transaction with its fee paid on top so the value arrives whole, each carrying the text comment `<words> primes.live/?ref=<n>_tg` — operator-set words, ledger-written link (`DECISIONS.md` D-202, D-211, D-215) | Reaches somebody not yet in the game as a line of text in their own wallet, carrying the minter's number as its referral key |
| **Pool injection (β)** | **residual** | Credited to the ratchet; converted to PRIMES on DeDust and burned by the public flush schedule (§4.3) | The price-floor ratchet |

**The mint keeps at most `MINT_PRICE + MINT_MARGIN` (1.5 GRAM); anything sent above that
ceiling comes straight back to the sender** (`DECISIONS.md` D-109), so a fat-fingered send
funds nobody — the split above always runs on the nominal `MINT_PRICE`, never on the raw
value attached. An excess too small to pay its own forward fee is not sent: it stays on the
ledger and the gas & ops sweep carries it to the pool (until 2026-11-20 that unsendable
refund failed the mint's action phase and the ledger kept the whole value). `MINT_MARGIN` (0.5 GRAM) is a wire constant sized against the largest
padded send this repo actually makes, not a `shared/params.json` figure.

**The lines that pay a third party are held behind the item deploy** — the *held split*
(`DECISIONS.md` D-117, signed 2026-09-22; D-117 called it an escrow, a word this document
reserves for the D-90-deleted pool). The divisor tribute (credited to an item or forfeited), the
referral relay and the 5% treasury line are not sent in the mint transaction: they ride on
the `mint_item` message to the collection as value, with a small cell naming each line; the
collection forwards all of it, inside the deploy, to the item; and the item — once populated,
from its own first transaction — keeps its deploy value and hands the rest back to the ledger
in `mint_confirmed` (`DECISIONS.md` D-199). Only then does the ledger pay them, after checking
that the receipt came from item(`n`). While the deploy is in flight the money is in a message,
on no contract's balance, so nothing can sweep it and there is still no third pool (§3.4). A
`mint_item` the collection refuses bounces home; a deploy the item refuses bounces to the
collection, which relays it to the ledger with every nanoton that came back. Either way the
same GRAM comes home instead: **no split line is ever paid for an item that does not exist** —
by construction, since the only sender of the receipt is the item. The ledger parks the original message — same number, same
owner, same held split — in a retry lane keyed by `n`, declares the held split in `unroutedHeld`
(so `sweep_ops` cannot take it and `getLiabilityBreakdown` reports it), and the
permissionless `retry_item(n)` re-sends it once whatever refused the deploy is fixed, the
caller paying the new deploy's value. So the number is minted again, to the wallet it was
sold to, and every line is paid exactly once, on the confirmation. Nothing the mint booked
is unwound — `T`, the flat 20% dividend accrual, the rebate `S`, the pool injection — and
nothing needs to be: the item still comes into existence, and `head` never moved back (a
bounce cannot know whether other mints have moved past it).

**The split has no prime branch, but two of its lines resolve to nothing on a prime mint.**
Every rate above is charged identically; what differs is that the rebate is zero (§5.1)
and that **the tribute line has no recipient.** A prime's only prime factor is itself, and
itself is not minted until the transaction completes — so tribute on a prime mint resolves
to the empty set and falls to the pool, exactly as an unset referral key does (§3.1). No
new rule: the existing "unresolvable line backs the floor" rule already covers it.

**The invite line is the fifth deduction, and the minter chooses who it pays**
(`DECISIONS.md` D-101 for the count, D-202 for the rest, D-215 for the terms). The mint
message carries both the count and the recipients — `invite_count:uint7` and
`invites:(Maybe ^InviteList)`, a dictionary of addresses keyed by slot 1..count, holes
allowed — and **nobody signs the list**: there is no operator key on the recipients. The
webapp fills every slot from the keeper's default list (below) and the minter may change any
of them, to anyone, their own wallets included; the agent SDK (`@ton-primes/agent`,
`mint({ invites })`) names its own or none. Each slot with an address is one transfer of the
live `Config.inviteValue`, sent non-bounceable so a Telegram wallet that is not deployed yet
still receives it, **with the forward fee paid on top so the value arrives whole** — a
Telegram wallet pushes a notification for 0.1 GRAM received and not for the 0.0999 a
fee-deducted send delivers (measured on mainnet, 2026-11-22). **The count and the value are
operator-set** (`set_invite_terms`, from `FeeDests.operatorAddr` only; genesis 3 × 0.1 GRAM),
so a channel that stops working can be traded for more, smaller transfers without a
redeploy. What the operator cannot move is fixed in the ledger's code and pinned to
`shared/params.json` by the sim: at most `INVITE_COUNT_CEILING` = 100 transfers a mint, and
`count × (value + INVITE_SEND_FEE)` ≤ `INVITE_LINE_CAP` = **0.31 GRAM**, checked at the setter
and again at every invite mint, so **no terms can take β below 0.24**. `INVITE_SEND_FEE` =
0.001 GRAM is the line paying its own fee — an upper bound on the measured 0.0003–0.0004 GRAM
per transfer — so the gas & ops line carries none of it, and what it overstates stays on the
ledger, where `sweep_ops` returns it to the ratchet pool. `getInviteTerms()` publishes the
live `(count, value)` beside the three bounds. **The comment is `<words> primes.live/?ref=<n>_tg`**:
the link and the minter's own `n` as a referral key are written by the ledger's code; the
words before them (at most 86 bytes) are set by the operator's wallet with `set_invite_terms`
(`DECISIONS.md` D-211, D-215), so a launch or a celebration can change what invitees read without a
redeploy. `getInviteText()` returns the live words and `getInviteComment(n)` the exact bytes.
A minter-written comment would let anyone send scam text from the game's address, so the
minter writes none; the operator's key can change the words but never the link. The `n` is
what makes inviting pay the inviter, through the 10% referral line above, when an invitee mints. The line buys **transfers, not a budget**: it has no residual
of its own, and nothing accumulates anywhere.

**Every slot the mint does not spend falls to β, never to the operator.** If the minter names
two addresses against a `count` of three, one slot's worth of GRAM is injected into the
ratchet. This is not a new rule either — it is the same "an unresolvable line backs the
floor" clause, applied to a line whose recipient may not have been supplied. The mint is
still 1 GRAM all-in and the split is still closed at 100%: at the genesis terms, 30.3 points of
the mint move from the ratchet to three invitees and their transfer fees, and not one nanoton
leaves the six named lines above. **A minter who names their own wallets gets the 0.30 GRAM back**, and the owner
accepts that (D-202): it is a cheaper mint paid for out of β, which is nobody's, and §8.1's
mint-and-sell threshold rises rather than falls with it (3.56× the floor at n = 10,000 with
self-referral, from 3.14×). What it does cheapen is a fake recruit, and §12 names that.
`getInviteSpend()` publishes the whole line, lifetime: slots funded, transfers sent, slots
that fell to the pool, GRAM delivered to invitees, and GRAM the line took off β (delivered
plus the fee allowance).

**Who the default list names is published, not private.** It is a suggestion the app fills
in, not a rule the contract enforces. The keeper's `GET /api/invitees`
serves an unsigned list from candidates ranked off five lists computed daily from the free GRAM
data lake, which anyone can rerun with no account (`tools/lake/`, `DECISIONS.md` D-201,
`backend/keeper/src/lakeInvitees.ts`), one signal each:
contract **deployers** (3–100 state-init sends), **keyword names** (a Telegram Username or TON
DNS name that *is* a maths word — `prime`, `gauss`, `riemann`…), paying **collectors** (3–30
collections acquired for consideration, never an airdrop), **Telegram collectible** holders
(1–20 Anonymous Numbers or upgraded Gifts) and NFT-collection **creators** (1–50). Every band
has a ceiling as well as a floor, so no industrial operator of a signal heads the list. A
candidate must be a plain user wallet (wallet v1 to v5) or a Telegram wallet, both by code hash,
active in the last 12 months, and carry **no** label in the public `ton-labels` dataset — a
label means an exchange, dApp, bot, fund or scammer, not a person. **Telegram wallets rank
first**, in three tiers: Telegram wallets a signal names, then Telegram wallets active in the
last 30 days that no signal names (activity alone makes a Telegram wallet a candidate, never a
standard one), then standard wallets a signal names. Within a tier, ranking is by how many
signals name the address, then by most recent activity. The daily job fails, keeping the
previous lists, if no list holds a Telegram wallet, so a wallet-code change cannot drop them
silently. The keeper then drops, from this repo's own index, every
address that has already minted (it is not a newcomer — and since `DECISIONS.md` D-191 the
contract agrees: a wallet that has minted has a SEEN minter card, so a gift to it is no
recruit edge, §4.6) and
every address it has already handed out, which it records durably (`invites_issued`) in the
request that hands it out: **the default list names an address at most once**. The selection reads
on-chain data only — no off-site profile, no LLM, no traders — and no step of it is on a
mint's path: a daily job writes the lists to files, the keeper re-reads them hourly, and a
failed job or an unreadable file leaves the previous list standing. With no lists the list is
empty and every slot falls to β, which is a legal mint. The keeper's `/status` reports
`inviteeSource` — candidate count and when the job computed it, `null` for the empty source —
so which of the two is live, and how fresh, is one read away. The signals are a proposal, not a measurement, until
invited addresses have had time to mint (`GAUNTLET.md` J12).

**Two assertions guard the line.** `primes_ledger.tolk` throws **221**
(`invite_count_over_max`) before the split is computed if `count` exceeds the live
`Config.inviteCount` (a `uint7` can say up to 127), **238** (`invite_terms_bad`) if the spend
would pass `INVITE_LINE_CAP`, and **236** (`invite_bad_workchain`) if any named slot inside the
declared count is not on **workchain 0** (audit R2-L1, 2026-11-19). The second exists because
the transfer's destination is minter-written: a send to a workchain that does not exist fails
in the action phase, which aborts the mint with no bounce and kept the payer's 1 GRAM. The
masterchain is refused with it — a `-1` invitee was deliverable, but every wallet the line is
for is on workchain 0 and the rule is one comparison. Either throw reverts the whole
transaction and bounces through the minter card (§4.5, D-191), which gives the mint's standing back
and returns the value — the minter pays gas only,
receives no number, and no line falls to β. The app's builders refuse the same address before
the wallet opens (`shared/messages.ts`), and the keeper's default list never offers one.
There is no signature left to fail: D-202 deleted
the operator key, errors 220 and 222 and `hashSignedInvites` with it, so D-108's refusal rule
has nothing to refuse, and no keeper outage can block a mint.

**There are exactly two exceptions to "an unresolvable line backs the floor", and both
are written here rather than left to be discovered. They share a shape: neither is a
*split line* at all — each is a forfeit on a discretionary action, and that is the
distinction that keeps "never to the team" intact.**

~~**Exception 2 (`DECISIONS.md` D-32, 2026-08-19): the 10% retained when a lot winner
releases their claim is treasury revenue.** A winner who hands back a won composite lot
before the head arrives is refunded 90%; the retained 10% goes to `treasuryAddr`, not to
the pool. Nothing was emitted against it and no line went unresolved — the money is the
price of changing your mind, and it exists to make opening a lot you do not want cost
something. Its floor is a hard constraint checked against the gas profile: **the forfeit
must exceed the gas cost of the open-and-release round trip**, or releasing is free and
opening lots becomes costless griefing.~~ **VOID (`DECISIONS.md` D-90.2, 2026-09-01): the
release right this forfeit was charged against is deleted along with it.** A won lot
mints the number in the transaction that closes it — there is no escrowed claim left to
release and nothing to charge 10% against. This is the same D-32-then-D-90 sequence §4.4's
own box (point 4, below) documents in full; see it for the complete history. The text
above is retained for provenance, not as a live rule.

**Exception 1: the tribute of an unsold prime is fee revenue, split 58% to the governed
treasury contract and 42% to the operator** (`DECISIONS.md` D-166; 80/20 before it). While prime `p` sits unsold on its descending
lot (§6 points 1–2),
every composite mint that cites `p` as a factor pays `p`'s share of the tribute line out as
**two sends** — `FORFEIT_TREASURY_BPS` = 5800 bps to `primes_treasury.tolk` (§5.5: no key,
spends only by proposal or by `distribute()`) and the remainder to `ConfigA.feeDests.
operatorAddr` — and **not** to the ratchet pool and **not** to any NFT holder
(`DECISIONS.md` D-20 point 4 as amended by D-100 point 6 and D-166, implemented in
`primes_ledger.tolk`'s forfeit leg; `getFeeDests()` publishes both destinations and the
split). The remainder is *subtracted*, never multiplied a second time, so the two sends
close to the whole for every amount and the truncation falls to the operator. Until D-100
both legs paid one wallet; D-100 point 6 split them, and **D-152 has since brought §4.1's
5% line back to the governed pot**, so the operator's whole claim on an ordinary mint is
this forfeit remainder — zero on any mint whose cited factors all have owners. The owner
signed this knowingly and it is the one place where the rule as stated everywhere else in
this document does not hold. **No leg is ever too small to pay its own gas** (`DECISIONS.md`
D-172): the treasury's 58% rides the same message as §4.1's 5% line, and an operator
remainder below one hop's gas (`RATCHET_HOP_GAS`, 0.001 GRAM) is **held** in `operatorHeld`
and sent with the next remainder that clears it. The same rule holds a D-114 premium half
below that figure in `treasuryHeld`, and a royalty whose operator half is below it waits on
the collection's balance. Both counters are published by `getLiabilityBreakdown()` and are
part of the ledger's declared liability, so `sweep_ops` never takes them; the 58/42 split
is exact over time, never per message.

*Why it is a fee and not a supply claim*, in one sentence, because it will be read
adversarially: the forfeit is GRAM taken out of the existing 10% tribute line for a
recipient who does not exist yet — it mints no PRIMES, never touches `S`, `T`, `pending`
or `owed`, cannot be reached by any admin function, and stops permanently the instant the
prime sells — so it is revenue that scales with activity like the other fee lines of
§2 principle 4, not a claim on the collection or on the backing.

*What it costs, stated plainly:* for as long as a prime goes unbought, four fifths of that
tribute goes to a pot the LP electorate spends and one fifth to the operator, instead of
accruing to that prime's owner. The amount is
public and per-prime at `getForfeited(p)` — until the head has left the prime's block and the
block is flushed (D-198); from then on its later forfeits are in the aggregate below — and
whether the prime is still forfeiting is `isPrimeUnsold(p)` (§9.1). The alternatives were the ratchet pool (the old K-lot rule) and
accrual to a specific item, and §6 point 2 records why treasury was chosen over both.

The consequence is that **primes are the strongest ratchet events in the game by a wide
margin** — they add ten points to β *and* emit nothing — and this happens without a single
parameter being tuned for it. It is the same inversion that runs through §3.1: what a
prime withholds from its minter, it hands to the floor.

One line varies now, so the table below is stated for `count = 0`. An invited mint
subtracts `count × (value + 0.001) GRAM` from whichever cell it lands in (`invites.beta_table`
publishes the grid: 0.247 referred and 0.347 unreferred at the genesis 3 × 0.1, and never
below 0.24 / 0.34 under any terms, `beta_at_line_cap`). The figures are re-derived
in the sim against the measured opt-in rate and `shared/params.json` is the authority for
what they become (§10 Phase 1) — the table is the shape:

| minter's state | referred | unreferred |
|---|---:|---:|
| any composite mint | **55%** | 65% |

**`DECISIONS.md` D-106 COLLAPSED THIS TABLE FROM SIX ROWS TO ONE**, and the four that went
are worth naming because they were quoted throughout this document: a recruit's
**activation mint** ran at 40% referred / 50% unreferred (the patron line taking 25%), and
their **mints 2–11** at 57.5% / 67.5% (the line taking 7.5%). The patron line was the only
rate in the split that varied, so with it deleted β is a function of the referral key
alone.

**Every cell above is a composite mint. Add 10 points for a prime**, since the tribute line
falls to the pool — so a prime mint injects **65%** referred and 75% unreferred, and emits
nothing at all against it.

(Every β on this page is 10 points lower than it read before `DECISIONS.md` D-117 raised the
gas & ops line from 10% to 20%: 65/75 composite and 75/85 prime became 55/65 and 65/75. The
line's unspent part returns to the pool through `sweep_ops`, so an ordinary referred composite
mint's *effective* pool share is ≈0.65 — see the gas & ops paragraph below.)

**β = 55% remains the steady-state planning number**, and the bolded column is the only
one that occurs in practice. Self-referral with one's own NFT is rational (see below) and
should be assumed universal; a gifted wallet in particular always owns the number it was
given, so it is referred from its very first mint and the right-hand column is
counterfactual for it.

Two consequences of the collapse are worth stating, because both are improvements the
deletion bought rather than losses it accepted:

- **The worst case rose from 0.40 to 0.525.** The deepest cut §4.1 could take used to be
  an activation mint with the referral resolved and a full invite fan-out
  (1.0 − 0.1 − 0.05 − 0.1 − 0.1 − 0.25 = 0.40, leaving 0.275 after the invite line). Without the
  patron line the same worst case was 0.525. The floor's slowest step got faster. (D-117's
  20% gas & ops line has since taken it to 0.425, D-202's three 0.1 GRAM transfers to 0.25,
  and D-215's fee-on-top to 1.0 − 0.1 − 0.05 − 0.20 − 0.1 − 0.303 = **0.247** at the genesis
  terms, a referred composite with all three slots sent — and no operator terms can take it
  below 0.24, the 0.31 GRAM line cap.)
- **A fresh unrecruited wallet still mints at 65%**, and a gifted one at 55% from its
  first mint. It owns no NFT, cannot set a valid key, and §3.1's "newcomers structurally
  subsidize the floor" applies in full to the first; the second gets §3.1's referral
  discount immediately, which is a real part of what the giver's 1 GRAM bought and belongs
  in the gift-flow copy.

Two consequences worth stating plainly, because they look like problems and aren't:

- **A variable β does not weaken the ratchet.** The theorem in §5 never used β being
  constant: for any injection *I* > 0 and any *k* < 1, `(T+I)/(S+kI/p_f) > p_f`. Every
  mint raises the floor regardless of referral status, gas draw, or split changes.
- **Setting a referral key shrinks your own rebate**, since the rebate is computed on the
  actual residual. That is not a bug and the rebate *must* be computed this way — basing
  it on a fixed notional 65% while injecting only 55% would give an effective k of 1.06
  and run the ratchet backwards. Self-referral remains rational anyway: 0.10 GRAM in hand
  beats k·0.10 GRAM of PRIMES for any k < 1. §7 already treats universal self-referral as
  the expected outcome and prices it as an honest 10% discount.

**Tribute is 10%, revised down from 20%** — 20% starved the pool injection for a cash
flow that is already the primes' main draw. Whether 10% is too thin to make prime NFTs
genuinely attractive is a **Phase 1 kill criterion** (§10).

**Gas & ops is a fixed 20% (0.20 GRAM), and the figure is derived, not estimated**
(`DECISIONS.md` D-117, signed 2026-09-22). It is the **heaviest mint the ledger can
perform**, measured on the ledger's own balance by `contracts/tests/GasRegression.spec.ts`
— the fall in the ledger's surplus over declared liability across the whole mint trace,
which counts every hop by construction — and rounded **up** to the owner-set 5% step by the
sim (`sim/primes_sim/gas.py`, `gas_ops_line`). The measured rows, in GRAM of ledger balance
per mint:

| mint | draw |
|---|---:|
| plain composite, ω = 12, every leg firing | **0.192** (the worst; sets the line) |
| primorial, ω = 9 | 0.181 |
| primorial, ω = 8 | 0.171 |
| primorial 510510, ω = 7 | 0.161 |
| primorial 30, ω = 3 | 0.114 |
| n = 6 (primorial), ω = 2 | 0.102 |
| composite, ω = 1 | 0.077 |

Headroom at the worst row is **0.008 GRAM** (0.016 until D-180 put the factored score on the mint's rebate leg, 0.014 after it; later per-mint legs, chiefly D-191's minter cards, took it to 0.008). Until D-117 the line was 10% against an
unbenchmarked ~0.10 GRAM estimate, and the reconciliation that defended it reported 0.099 on
ω = 3 because its hand-kept list of attached hops missed the special-number rebate hop, the
era trophy hop, the ratchet hop's `RATCHET_HOP_GAS` and the fee legs' forward fees, and
double-counted downstream fees; measured on the balance, that row is 0.114 (0.110 before
D-117's held-split round trip, above). Raising the line cost β exactly ten points on every row
of the table above, and nothing else: the split is still closed at 100%, and `k < 1` is
untouched because β only scales the injection.

**Where the gas & ops surplus goes: back to the pool.** The 20% is a budget sized to the
worst mint, and a budget has a residual: ordinary mints draw well under the line (an
ordinary referred composite draws ≈0.10 GRAM, a prime ≈0.008), so roughly 0.10 GRAM per
composite mint and ≈0.19 per prime mint accumulates on the ledger. That residual needs a
stated owner, because the alternative is to let it pile up unclaimed and unexplained, which
also silently breaks §3.4's promise that each contract's balance matches its own declared
liability in one get-call. **Its owner is the ratchet** (`DECISIONS.md` D-117, owner,
2026-09-22; until then it was operator revenue swept to a deploy-fixed operations address,
`ConfigD.opsAddr`, now deleted). A permissionless function moves

```
sweepable = balance − declared_liability − OPS_RESERVE
```

to the ratchet through the same hop a mint's injection takes, crediting `pending` and `T` by
the same amount. It is **emission-free**: `k = 0`, `S` does not move and no PRIMES are
minted, so each sweep is a pure floor raise and `T = seeded + swapped + pending` stays exact.
The consequence is stated plainly: **the pool's effective share of an ordinary referred
composite mint is β 0.55 plus the unspent line (0.20 − ≈0.10), ≈0.65** — and the swept part
carries no rebate, so per GRAM it ratchets the floor harder than β does. What D-117 moved off
β at the worst mint it hands back on the ordinary one, just later (at sweep time, once the
ledger clears `OPS_RESERVE`), not at mint time.

Three properties make this categorically different from the withdraw paths §8 forbids,
and all three are checkable rather than asserted:

- **The amount is a formula, not a choice.** The caller picks only *when*, exactly as with
  `flush()`. There is no argument that names an amount and no destination argument at all.
- **It is permissionless and pays no wallet.** Anyone may call it; it always pays the
  ratchet pool. It is not an operator line at all: an operator who vanishes cannot strand
  the protocol, and one who is present gets nothing from it.
- **It cannot reach the two protected pools.** `pending` is on the ratchet and `owed` is on
  the items — neither on the ledger, by the §3.4 decomposition. (There were three until
  `DECISIONS.md` D-90 deleted the escrow shard; with no refundable customer money anywhere
  in the system there is no third pool to protect.) `declared_liability` covers what the
  ledger itself still owes named counterparties (unrouted tribute credits, unclaimed flat
  dividends), and `OPS_RESERVE` is a standing float for costs the mint cannot pay at mint
  time: `owed` storage rent and lot settlement gas. (Amortized flush gas was a third until
  `DECISIONS.md` D-146 made every permissionless ratchet leg caller-paid.)

**The surplus is about half the line, because the line is sized to the worst mint.**
What the 0.20 GRAM pays for is not only TVM compute: every mint also *attaches* value to its
own outbound messages — 0.025 GRAM to deploy the NFT item, 0.008 per cited factor for
`credit_tribute`, and 0.020 for the rebate mint's wallet deploy. Those attachments are five
to ten times the compute term and come out of the same line, which is why draw climbs with
ω. Measured on the ledger's balance, draw runs from 0.077 GRAM (ω = 1) to 0.192 GRAM (ω = 12),
with a blended draw near **0.095 GRAM per mint**. (Before D-117 this paragraph quoted a
blended surplus of 0.034 GRAM against the 0.10 line; that reconciliation undercounted the
draw, see above.)

**The worst case is an auction close, and it is the buyer who pays for it.**
A close on a three-factor number is the only path that pays the hop into the ledger *and*
three tribute attachments *and* a rebate mint, and measured against this line as a whole it
came to ≈0.103 GRAM — a 3% overrun of the then-10% line that `GasRegression.spec.ts` was left failing on, because
the choice it forced belonged in this document: raise the line, cap cited factors on
auctioned mints, or price the close's hop separately from the mint. **The third is taken**,
and it costs the split nothing, because §4.4 had already specified the fee that does it:
`RES_GAS` rides on top of the lot price — `LOT_FLOOR = MINT_PRICE + RES_GAS`, and the clearing
price is `MINT_PRICE + RES_GAS + premium` on every lane — so an auctioned mint arrives with
its own hop money attached and is no more expensive to this line than a plain one. The
overrun was two distinct errors, both now fixed:

- The reconciliation charged the hop to the 10% line *and* to `RES_GAS`. It is funded once,
  by the buyer, on top of the 1 GRAM.
- The slice of `RES_GAS` forwarded to the ledger with the close (`SETTLE_GAS`) was 0.020 GRAM
  against the 0.025 GRAM of hops the ledger attaches on the way back, so 0.005 GRAM per close
  genuinely did leak onto the line. The forwarded slice now matches what is attached, and the
  harness asserts the equality against a get-method rather than a copied constant — if the
  ledger's hops ever grow past what the market forwards, that is a red test, not a silent
  subsidy.

**Both constants outlived the mechanism they were measured on, and only the mechanism
changed.** This was reconciled while a *reservation* stood ahead of the head and a separate
`settle(n)` call, routed through an escrow shard, turned it into a mint. `DECISIONS.md` D-30
deleted `RES_FEE`, the sum that used to contain `RES_GAS`; D-90 deleted `settle(n)`, the
escrow and the shard, so **winning a lot mints the number in the transaction that closes it**
and there is no settlement call left to fund. What survives unchanged is `RES_GAS` itself
— standing on its own, never waivable, which is the whole anti-abuse argument (§12: a waiver
that could reach it would let a wallet park the head for free) — and `SETTLE_GAS`, the slice
of it that rides to the ledger with the close, now one hop shorter than when it was measured.
The arithmetic above holds because the buyer still pays the same fee for the same hops; only
the number of contracts between them fell.

The invariant this leaves is worth stating plainly: **no mint path draws more from the
gas & ops line than a plain mint of the same ω.** An auction close adds hops, and the
lot's price adds exactly the fee that pays for them.

The honest framing for the copy: the line is a budget, not a fee. Whatever the protocol did
not spend on gas goes back to the floor, so **the floor's share goes up when the
implementation gets cheaper and down when GRAM gas gets dearer**, and the operator's share of
it is zero (`DECISIONS.md` D-117; before it, the residual was the operator's fee).

`OPS_RESERVE` is a Phase 1 output, and it is derived rather than chosen. It is a float for
costs the mint cannot pay at mint time, so it is sized as **a fixed horizon of deferred
draw**: the per-operation gas costs measured by the contract gas-regression harness
(`contracts/gas-baseline.json` — the only place in this repo that measures real TVM gas)
multiplied by the number of mints of runway the ledger should hold. That makes the number
traceable to a measurement instead of to a judgment, and it makes it *re-derivable*: when
the implementation gets cheaper the harness says so and the reserve falls with it, which is
the same incentive the sweep itself carries. The horizon is the only judgment left, it is
declared in `shared/params.json` alongside the result, and oversizing it delays the floor
raise the sweep would deliver and costs a user nothing — the reserve can only ever sit on the ledger.

The reserve is **not** counted as a liability in
`getSolvency()`, and the distinction matters enough to write down: a liability is money
owed to somebody who can come and ask for it, while the reserve is a target the contract
aims to hold. Folding the target into the liability term would make a solvent ledger that
happens to be under-funded — every ledger, early on — report a negative delta, destroying
the one signal that get-method exists to give. So §3.4's invariant stays "can this
contract cover what it owes," and what keeps the delta from climbing forever into an
undeclared pot is the sweep itself: with everything above `liability + OPS_RESERVE`
permissionlessly removable, the delta settles at roughly the reserve instead of growing
without bound. The reserve and the currently-sweepable amount are both exposed by
`getOpsSweep()`, per §9.1.

**The liability term is enumerated, not left to inference, because the sweep is defined
against it.** Everything the ledger holds and does not declare is by definition sweepable
into the ratchet pool (the operator until D-117), so a missing line in that sum is not a
reporting bug — it is a standing authorisation to move player money where no claim can reach
it. The ledger owes exactly three things, and
`getLiabilityBreakdown()` publishes them separately so a reader can see each one move:

1. **Accrued tribute** — §3.2's 80% divisor line, credited to the cited prime's item as
   `owed` while the GRAM stays on the ledger. This is the large one (0.08 GRAM per composite
   mint) and the least obvious, because `credit_tribute` carries *a number*, not the money:
   the item's `owed` rises without any GRAM moving, so the balance looks like float. It is
   reconcilable off-chain against `Σ_p get_owed(p)`, and the contract test suite performs
   exactly that walk on every step of its fuzz sequence.
2. **Bounced credits awaiting `retry_credit`** — a credit whose item was unreachable. It is
   owed on no item, so it is carried here instead and moves back the moment the retry lands.
   The two lines are always written together; an amount is in exactly one of them.
3. **Accrued flat dividends** — §3.2's 20% line, not yet converted into item `owed` by
   `claim_dividend`. Note that a dividend claim *moves* value between lines 3 and 1 rather
   than discharging anything: the GRAM does not leave the ledger until the owner claims the
   resulting `owed`.

The pool injection is deliberately **absent** from that list: it physically leaves the
ledger in the transaction that receives it, to the ratchet, so it is that contract's
declared liability — which is the whole point of §3.4's decomposition. (The escrow and the
patron purse were the other two absentees, for the same reason; D-90 and D-106 deleted
both, so the ledger has one fewer pool to *not* declare and the system has two.)

**Zero emission on primes also buys back the gas the primality check spends.** A prime
mint mints no PRIMES, so it deploys no jetton wallet and sends no rebate, and cites no
factors — the legs that make draw climb with ω disappear on exactly the mints that carry 13
Miller–Rabin rounds. The two heaviest and lightest legs of the budget sit on opposite sides
of the prime/composite split and cancel, which turns the *prime* worst case in §12's
gas-insolvency risk (a large prime blowing the all-in budget) into one of the cases with the
most headroom under the 0.20 line. It does nothing for the composite worst case, which is
what sizes the line: a many-factor composite mints PRIMES and pays one tribute attachment
per cited factor, and none of those legs is on the prime side of the split (D-117's worst
row is ω = 12, above). This was
not the reason for removing the prime rebate, but it is the reason the removal is cheap to
implement rather than merely defensible.

All economic parameters immutable after deploy — decided, see §11.1's hybrid closure:
the single mutable surface in the system is the three DeDust venue addresses on the
ratchet, which touch no rate, cap or curve — but do decide where flush sends `pending`, so
changing them takes the proposer key AND a passed LP vote, after 30 days (`DECISIONS.md`
D-194). §4.3.2's staking addresses are deploy data with no setter.

### 4.2 Worked example: minting 234

234 = 2 · 3² · 13, so Ω = 4 and there are three tribute recipients. Assuming the minter
set a referral key — say `r42`, and (the expected case) the minter owns NFT 42
themselves:

| Destination | GRAM |
|---|---:|
| Pool injection → `T` counter | 0.550 |
| Owner of NFT 42 (referral key) | 0.100 |
| Divisor tribute → owner of 13 (weight √13 = 3.606) | 0.0340 |
| Divisor tribute → owner of 3 (weight 2√3 = 3.464) | 0.0327 |
| Divisor tribute → owner of 2 (weight √2 = 1.414) | 0.0133 |
| Prime dividend → all 51 minted primes, flat (0.00039 each) | 0.0200 |
| Treasury | 0.050 |
| Gas & ops | 0.200 |
| **Total** | **1.000** |

Note what the `√p` weighting of §3.2 did here: **13, an ordinary organically-minted prime,
is the largest single recipient of this mint** — ahead of 3 despite 3 appearing squared,
and at 2.5× the owner of 2. Under the flat exponent weighting this replaces, the row order
was 3 (0.050), then 2 and 13 tied at 0.025.

(This is now the only case: `DECISIONS.md` D-102 deleted the constellation tribute
multiplier, so `w(p) = e·√p` is the whole of the divisor weighting and no second scenario
runs over this mint.)

(Since `DECISIONS.md` D-106 there is no second scenario over this mint on the split side
either: the patron line is deleted, so 0.550 is the referred composite figure for every
minter, recruited or not. Had they named a **beneficiary** (§4.5), every row above is
unchanged — the split does not know or care — but the NFT *and* the rebate would go to
that address, and if the ledger had never seen it the minter would also be credited one
recruit on §4.7's ladder.)

The minter also receives the NFT and a rebate whose floor-value is k(t) · 0.550 GRAM —
between 0.110 GRAM (minted instantly after the previous one, k = k_min) and at most
0.495 GRAM (k → k_max = 0.9, since 234 < n₀). At the one-hour mark the ramp tops out
(`T_ramp` = 1 h, `DECISIONS.md` D-98), so k = k_max = 0.9 gives the full 0.495 GRAM of
floor-value, and the mint ratchets the floor roughly **+0.008%** (ratchet coefficient
`(1−k)·β` = 0.055, §4.2.1's table).

Note the tension the last two numbers encode: **the rebate and the ratchet trade off
directly.** A patient minter extracts more PRIMES and advances the floor less; an
impatient one does the reverse. Both are strictly positive for the floor.

Note also that all three tribute recipients here (2, 3, 13) are small primes — bought off
their descending lots (§6 point 1) rather than minted at the head, like every prime.
Early in the game essentially all tribute flows to auction buyers; how fast it diffuses to
organically-minted primes is an argument for keeping the auction set K small (§6). And if
the minter *is* one of those owners, that share returns to them — the self-tribute
discount of §3.2 in action.

Verification of 234 costs almost nothing — one multiply chain and three dictionary lookups
confirming 2, 3 and 13 are minted primes. Minting 233 instead would run 13 Miller–Rabin
rounds. That asymmetry is the point of §3.1.

### 4.2.1 Worked example: minting 233

The head has advanced by one, the number is prime, and the same minter sets the same key
`r42`. Nothing about the split changes; two of its lines simply find nobody to pay.

| Destination | GRAM |
|---|---:|
| Pool injection → `T` counter | 0.650 |
| Owner of NFT 42 (referral key) | 0.100 |
| Tribute | — (233 has no minted prime factors; the line falls to the pool) |
| Treasury | 0.050 |
| Gas & ops | 0.200 |
| **Total** | **1.000** |

The minter receives **no PRIMES**. What they receive instead is NFT 233 itself — a
perpetual claim on the tribute line of every multiple of 233 ever minted — plus permanent
naming rights on it, +1 prime rank (§4.7.1), and a `PRIME_UPLIFT` credit raising the
rebate ceiling on their next `PRIME_WINDOW` composite mints (§5.1).

Compare the two mints on the only axis the protocol cares about, using
`Δp_f/p_f ≈ (1−k)·βP/T`:

| mint | β | k | ratchet coefficient `(1−k)·β` |
|---|---:|---:|---:|
| 234, patient (k = k_max = 0.9, any t ≥ 1 h) | 0.550 | 0.90 | 0.055 |
| 234, at the half-hour mark | 0.550 | 0.550 | 0.248 |
| 234, instant (k = k_min = 0.2) | 0.550 | 0.20 | 0.440 |
| **233, any time** | **0.650** | **0** | **0.650** |

**A single prime mint moves the floor as much as nearly twelve (≈11.8) patient
composite mints.** The clock is irrelevant to it — `k(t)` has nothing to modulate — so a prime is
the one number in the game whose ratchet contribution cannot be diluted by a minter
waiting for a better rebate. That is what "primes fund the ratchet" means arithmetically,
and
it is checkable against two get-methods.

### 4.3 The flush schedule: batched, permissionless buy-and-burn

**Per-mint swapping is dead on dust economics.** A DeDust swap consumes roughly 0.05–0.20
GRAM of gas (0.25 GRAM is the documented attach amount, excess bounced) plus 0.02–0.03 GRAM
for the subsequent burn message. Against a 0.55 GRAM injection that is **13–42% skimmed off
the ratchet**, on top of a gas & ops line already fully committed to NFT and jetton-wallet
deploys. The pool trading fee is negligible by comparison: 0.25% on a mainnet volatile pool is
~0.0016 GRAM of that injection. That is DeDust's mainnet default, not a constant of this
design — the fee is per-pool and is READ (§9.1); the testnet venue's own `get_trade_fee`
answers 0.40%, which moves this line to ~0.0026 GRAM and changes nothing about it. This is the
same arithmetic that killed push-based tribute in §3.2.1, applied to the pool leg.

So the injection is **credited at mint, executed on flush**:

1. **At mint**, β is added to the ratchet's `pending` counter and the GRAM simply stays on
   its balance. Zero outbound messages, zero DeDust gas. `T` increments here (§5). (Since
   D-151 the part of that balance above a liquid reserve is staked at cost rather than left
   sitting — §4.3.2. It is still `T`, the counter still increments here, and nothing in this
   schedule changes.)
2. **`flush()` is permissionless, and the caller pays for it** (`DECISIONS.md` D-146,
   signed 2026-09-22). Anyone may call it — team, keeper bot, or a curious participant —
   and whoever calls it attaches the venue's gas: **`DEDUST_SWAP_GAS` (0.25 GRAM) plus
   0.01 GRAM of the ratchet's own compute, 0.26 GRAM in all**. Below that the call refuses by
   name (`ratchet_flush_gas`, 225) before anything moves; above it the change comes straight
   back to the caller as a TEP-74 `excesses`. **The swap message must carry the venue's own
   gas on top of the GRAM being swapped**, or the vault rejects it for declaring more input
   than it was sent — that gas now rides out of the caller's value, never out of `pending`.
   The owner's rule is the specification: *calling flush from any wallet should not affect
   the gas and fees reserve in any way.* The contract makes that arithmetic, not policy: it
   reserves exactly the balance it held before the call, less the `amount` that leaves
   `pending`, so the balance above `pending` cannot fall whatever a caller attaches. The
   same rule covers all four permissionless ratchet legs — `flush`, `stake`, `unstake`,
   `harvest` (§4.3.2). The ratchet's own gas buffer — the surplus of each `pool_inject`,
   which carries `β + RATCHET_HOP_GAS` and credits only `β` — now pays its storage rent and
   nothing else, which is why D-146 cut `RATCHET_HOP_GAS` from 0.005 to 0.001 GRAM.
   (Before D-146 the buffer paid the venue, and the pro-rata cooldown below let a
   one-nanoton tranche spend 0.20 GRAM of it per call with no cooldown at all — G39's drain.)
3. **The caller chooses only the timing — never the amount, and never the price.** Size,
   rate and the price limit are all fixed in the contract:

```
require(now − last_flush ≥ FLUSH_COOLDOWN)
require(in_flight == 0)                          // one round trip at a time
amount  = min(pending, max(FLUSH_PCT · pending, FLUSH_MIN))
require(amount ≥ FLUSH_MIN or amount == pending)
min_out = amount · S / T · (1 + FLOOR_GUARD)     // = amount / p_f at FLOOR_GUARD = 0
```

**One round trip at a time** (GAUNTLET V15). A flush credits `swapped` and debits `pending`
at send time and relies on either the venue's proceeds notification or a bounce to settle
which of the two was right. Only one such trip can be outstanding, because the contract
tracks a single in-flight amount: a second flush started over an unsettled first would make
the first's bounce restore the *second's* amount, silently breaking `T = seeded + swapped +
pending` — the identity §3.4 promises is checkable in one get-call. The refusal is
diagnosable rather than silent (`ratchet_flush_in_flight`). In normal operation it never
fires: `FLUSH_COOLDOWN` is a day and the swap's own deadline is ten minutes, so a legal
flush finds nothing in flight. It bites only when a trip has hung unresolved for a full day
— exactly when adding a second one is wrong.

**Only the swap's own proceeds settle it.** The proceeds notification comes from the
ratchet's PRIMES wallet, and that wallet notifies honestly for *any* incoming transfer. So a
fill counts only when the jetton-level sender is the venue's PRIMES vault **and** the amount
is at least the swap's `min_out` — a real fill always meets both. Without the second half, a
stranger's 1-nanoPRIMES transfer would mark the trip filled, and a refusal arriving after it
would find nothing in flight and strand its GRAM outside `pending`. The fill is recorded even
when the GRAM the venue forwarded cannot pay for the burn that follows it: the burn is dropped,
never the fill.

**A trip that never settles expires.** After one hour (`getFlushStaleSec` — six times the
swap's ten-minute deadline, so nothing can still answer) the next flush, stake or unstake
closes it *as filled*: `swapped` keeps the amount and `pending` gets nothing back, the
direction that can never overstate `pending`. This is what stops a trip the venue dropped,
or one whose fill notification never ran, from blocking the buyback and the
staked reserve. It is not the stranded-exit timeout (72 h, §4.3.2): that one waits out a
Tonstakers round, and borrowing it let a single cheap flush hold the ratchet shut for three
days.

**A trip is answered by the venue it was sent to** (audit R2-M1, 2026-11-19). A venue change
(§5.5.2) that lands while a flush is in flight is **never refused and never delayed**; the
ratchet keeps that one trip's two reply addresses — the native vault that refunds a refusal,
the PRIMES vault that pays a fill — until the next flush is sent, and settles the trip against
those. Checked against the *new* venue instead, the old vault's refund was rejected on a
non-bounceable message, its GRAM stayed in the gas buffer, and the stale close above booked up
to one `FLUSH_PCT` tranche as filled — and anyone could force it by sending `flush()` and the
timelock's permissionless `execute` back to back. Refusing the change while a flush is open
was the other fix and was not taken: a 1-nanoGRAM flush costs no cooldown, and against a venue
that answers nothing — the case a migration exists for — each one holds the full stale hour,
so that refusal could be held open indefinitely. What a silent old venue can still delay is
the first flush to the *new* venue, by at most `getFlushStaleSec` (one hour). Who settles the
open trip is public: `getFlushReplyVenue` returns the two addresses and whether they are a
pin, where `getVenue` says only where the *next* flush goes (§9.1). The staking
exit's DeDust leg was never exposed: its payout vault is deploy data (§4.3.2).

Proposed: `FLUSH_PCT = 20%`, `FLUSH_COOLDOWN = 1 day`, `FLUSH_MIN = 5 GRAM`,
`FLOOR_GUARD = 0`. `FLUSH_PCT`/`FLUSH_COOLDOWN`/`FLOOR_GUARD` are Phase 1 simulation
outputs; `FLUSH_MIN` is a hand-fed Phase 1 input (the swap-worth-its-own-gas threshold,
not something the sim calibrates), OWNER-SET at 5 GRAM (down from the original 50 GRAM
input) so `flush()` batches in smaller, more frequent tranches.

### 4.3.1 The floor guard: the protocol never buys above its own floor

`min_out` is the slippage limit the swap already needed (§8). Setting it to `amount / p_f`
rather than to a percentage band turns one required line into the protocol's entire
treasury policy:

**The flush fills only if PRIMES is trading at or below the floor price.** Above it, the
venue cannot satisfy the limit, hands the GRAM back, the ratchet restores `pending`, and
nothing is lost but the caller's own gas — a path §4.3 already specifies for
ordinary slippage failure. No new failure mode, no oracle, no price feed. The check is
arithmetic on two counters the contract already keeps.

**A NOTE ON THE WORD "BOUNCE", used throughout this section and §4.3.** It names the
OUTCOME — the GRAM came back, `pending` was restored, nothing moved — and not, as this
document previously assumed, the transport. A refused DeDust swap does not bounce. Its
`limit` is checked in the POOL, one hop past the vault, and the pool commits its refund
before throwing; the vault's own transaction succeeds, and a TON bounce travels exactly one
hop, so there is nothing for the ratchet's swap message to bounce from. The GRAM returns as
a fresh, non-bounceable `payout#474f86cf`, and the ratchet has a handler for it
(`DedustPayout`) alongside the real bounce handler, which still covers the narrower case of
the VAULT refusing outright. Verified against mainnet 2026-09-16; `GAUNTLET.md` R18 carries
the traces and what it cost to assume otherwise.

**THE TRANCHE IS SIZED TO THE VENUE, NOT TO `pending`.** The guard above is a statement
about a PRICE — the swap's average execution price may not exceed `p_f` — and §4.3's
sizing rule (`min(pending, max(pending × FLUSH_PCT, FLUSH_MIN))`) is a statement about a
QUANTITY drawn from a register that has never heard of the pool. For the first year of
this design nothing connected the two, and the consequence is not subtle: a tranche larger
than the venue can absorb is refused by the guard *even when the market is far below the
floor*, because the constant product moves the price as the trade executes. Measured on
testnet 2026-09-19 — pool 1.2826 GRAM against 479,142 PRIMES, the market **2.1× below** the
floor on spot, and a 19.733 GRAM tranche demanding 3,469,538 PRIMES from a pool holding
479,142 in total. It executed at **7.7× above** the floor and was correctly refused, which
on the dashboard is indistinguishable from "the market is above the floor".

No fixed `FLUSH_PCT` repairs this. A tenth, a twentieth and a fiftieth of that same
`pending` all still bounce; a hundredth clears the curve and is then raised back to
`FLUSH_MIN` by §4.3's own rule; and any fraction chosen today breaks again as `pending`
grows, which the sim takes to 210,833 GRAM. The fillable size is a property of the POOL.

Solving the guard for the amount gives it in closed form. With reserves `R_t`, `R_p`, pool
fee `f` and `G = FLOOR_GUARD`, the constraint
`R_p·a(1−f)/(R_t + a(1−f)) ≥ a·(S/T)·(1+G)` has `a` on both sides and it cancels — a curve
is a price, and a price does not care how the trade is denominated:

> **`a_max = T·R_p / (S·(1+G)) − R_t/(1−f)`**

which is positive **exactly when the market is below the floor net of the pool's fee**.
That is the property this section has always claimed and only now delivers: *below the
floor, some flush always fills*.

The contract cannot compute it. TVM has no synchronous cross-contract call and DeDust
publishes its reserves as a get-method, not as a message it will answer, so `flush()` takes
the size as an argument — `flush#b0000006`'s `amount`, computed off `get_reserves` and the
ratchet's own `getFloorCache` by whoever is calling. **This does not weaken the guard and
does not make `flush()` less permissionless**, for one reason: `min_out = amount·S/T` is
LINEAR in `amount`, so the guard is a PER-UNIT price and no choice of `amount` can buy a
nanoton above `p_f`. The clamp is one-directional — the handler takes `min(amount,
autoSize)` and reads 0 as "size it yourself" — so a caller may only ever ask for **less**
than the contract would have sent. The two things a bad `amount` can do are underspend,
which leaves the GRAM in `pending` backing `T` either way, and bounce, which the refund path
already reverses in full.

`FLUSH_MIN` therefore binds the auto-sized path only. A venue whose `a_max` is under 5 GRAM
is precisely the case the argument exists for, and refusing to buy there would be the guard
enforcing a quantity it was never about.

**The cooldown is charged pro rata**, at `FLUSH_COOLDOWN × amount / autoSize`. Once the
caller picks the size, keying the cooldown to the CALL rather than to the amount is a
denial of service: a stranger asking for one nanoton would spend the whole day's allowance
and the real flush would wait 24 hours behind it. `FLUSH_COOLDOWN` rate-limits GRAM
throughput, and now says so. A full-size tranche still locks the full day.

What it buys, in order of importance:

- **The protocol stops selling GRAM to people leaving at their price.** A blind daily buy
  spends the ratchet's own injection into strength, which is precisely when PRIMES needs
  no support. Every GRAM spent above `p_f` buys less backing than it gave up. The guard
  makes that transaction impossible rather than merely unlikely.
- **Buying becomes countercyclical by construction.** The ratchet accumulates while the
  market is healthy and deploys when the price is under the floor — dry powder that grows
  in exactly the regime where it is not needed and discharges in exactly the regime where
  it is. This is the single strongest available answer to §12's "AMM price can trade below
  floor" risk, because it converts the entire accumulated balance into floor defense
  instead of leaving it as a queue.
- **Flush MEV is capped at the floor, not removed** (`DECISIONS.md` D-190). The attack in
  §8 is: pump the pool, trigger the flush, sell into the protocol's buy. Above the floor
  the guard refuses the buy outright. **Below it the guard only caps the price:** the
  caller picks the size, so an attacker pumps first, sizes the tranche to the pumped pool
  (`a_max` above), lets the ratchet fill at an average up to `p_f`, and sells back. The
  ratchet still never pays above its own floor, and `T`, `S` and `p_f` do not move — a
  flush moves GRAM from `pending` to `swapped` inside `T` whatever price it fills at. What
  the attacker takes is **burn efficiency**: fewer PRIMES burned per GRAM than an
  unsandwiched flush would have burned, and only while the market is under the floor.
  Measured in the sim: 1,856 of 3,217 flush attempts over the three-year base run are sandwiched, for **800 GRAM of attacker profit — 3.0% of the 26,387 GRAM the ratchet swapped** (`flush.sandwich_profitability_check`; the unguarded control loses 82%).
- **`T` is untouched.** `T` already counts `seeded + swapped + pending` (§5), so a bounced flush
  changes no counter and the floor does not so much as flicker. The guard reallocates
  *where* backing sits, never how much of it there is.

**The honest consequences, stated rather than discovered:**

- **The ratchet stops being a five-day queue and becomes a real balance.** §12's honeypot
  risk grows accordingly, and it is now the *first* thing an auditor should check: the
  answer must remain that there is no withdraw path in the source at all (§8).
- **Burning slows in healthy markets.** Fewer tokens are destroyed, so circulating supply
  runs closer to `S`, so `p_f` understates backing by a *narrower* margin than §5 promises
  today. The direction of the error is unchanged — `p_f` still never overstates — but the
  copy should not claim a widening gap while the guard is holding GRAM back.
- **`pending` can grow for a long time without a fill, and that must be visible.** The
  dashboard shows `get_pending()` next to `get_floor()` already; it should also show
  whether the last flush attempt filled or bounced, so "the protocol hasn't bought in six
  weeks" reads as *the market is above the floor* rather than as neglect.
- ~~**Idle GRAM earns nothing.**~~ **It does not sit idle any more — §11.14 is reopened and
  adopted** (`DECISIONS.md` D-151, 2026-09-20). The balance the guard accumulates is 87% of
  `T` in the base three-year run (`final_state.pending_growth.pending_share_of_T` = 0.8688),
  and everything above a liquid reserve is now deposited into the Tonstakers pool and held
  as tsTON, counted in `T` **at cost**. The standing bid is unchanged in every respect a
  buyer can observe: the reserve is sized so `flush()` never queues behind unstaking
  latency, and §4.3.2 states the rule, the three permissionless arms, the exit legs and the
  one counterparty the backing now has. The old objections were a counterparty in the
  backing and a discretionary surface; the first is accepted, named and published, and the
  second is refused exactly as it was — **no arm carries an amount.**

**Why not simply buy less often instead?** Because the cooldown controls *rate* and the
guard controls *price*, and only the second one is a statement about value. A protocol
that buys on a schedule is a customer; a protocol that buys under a limit derived from its
own floor is a market maker with a reservation price — and its reservation price is the
same number the landing page is already advertising.

**TON has no scheduler.** A contract cannot wake itself, so "automated weekly buy-and-burn"
is not expressible on-chain. The cooldown is a *ceiling on rate*, not a guarantee of
execution; the guarantee comes from the call being permissionless — anyone may send it, and
below the floor someone is paid to (D-190: the sandwich is a caller's incentive too) — so
there is no gatekeeper to fail. If literally nobody calls it, the GRAM is still on the
ratchet's balance backing `T` — the failure mode is delay, not loss.

**Why a percentage of the ratchet's balance rather than a fixed size:**

- Self-sizing with activity. Busy weeks buy more, quiet weeks buy less, with no parameter
  touched.
- Price impact is bounded as a fraction of what the pool has recently received, rather
  than drifting as the pool grows.
- Buying continues *after* minting stops. The ratchet drains geometrically regardless of
  inflow, so a stalled game still delivers a decaying tail of buy pressure — a small but
  real improvement to the idle-death case in §8. Under the floor guard (§4.3.1) that tail
  is now *conditional on price*, which is the right shape: a stalled game with PRIMES
  under the floor drains the ratchet's balance into defending it, and a stalled game above
  the floor has nothing worth defending.
- The `max(…, FLUSH_MIN)` branch prevents the geometric tail from leaving dust in the ratchet
  forever: once `pending` falls under the floor, one call takes all of it.

**Why daily and not weekly.** At 20% per week the ratchet's steady state is ~5 weeks of
inflow held idle with a 3-week half-life, which starves pool depth during exactly the
bootstrap phase where §5's floor is most fragile. The same 20% on a daily gate gives a
~3-day half-life and buffers ~5 days of inflow, while making each individual buy roughly
7× smaller — less price impact and less worth attacking (below).

**Execution path.** The swap is two-phase, because TON is asynchronous:

```
anyone  → ratchet.flush()
ratchet → DeDust native vault      (amount + payload, limit = min_out, recipient = ratchet)
vault   → pool → jetton vault      → ratchet's PRIMES jetton wallet
ratchet's PRIMES wallet → ratchet  (transfer_notification)
ratchet → PRIMES wallet            burn(received)
```

The burn must originate from the wallet's owner, so the output cannot be routed straight
to a burn address — the ratchet has to take delivery first. On slippage failure the venue
hands the GRAM back (as `payout#474f86cf`, not as a bounce — see §4.3.1's note on the word)
and the ratchet restores `pending`; nothing is lost but gas. **The
floor guard rides this exact field and this exact path** — a flush that would have bought above
the floor is indistinguishable, at the contract level, from one that got sandwiched, and
both are handled by the recovery that already had to exist.

**Amortized cost.** At one flush per day against, say, 100 mints/day, the DeDust leg costs
~0.001 GRAM per mint instead of 0.07–0.23 GRAM. It disappears into the gas & ops line
instead of eating a third of the ratchet.

### 4.3.2 The staked reserve: the standing bid earns while it stands

`DECISIONS.md` D-151, 2026-09-20, which reopens and adopts §11.14. The floor guard turned
the ratchet from a five-day queue into an accumulating balance that may sit unspent for a
long time — 87% of `T` at the end of the base three-year run
(`final_state.pending_growth.pending_share_of_T` = 0.8688; 0.99991 in the
`pending_growth_above_floor_market` stress run, which never flushes at all). That GRAM has a
job and keeps it: it is the reservation-price bid §4.3.1 is built around. **A standing bid
does not have to be idle to be standing.**

**The rule.** `pending` above a liquid reserve is deposited into the **Tonstakers**
liquid-staking pool, held as tsTON, and counted in `T` **at cost** — never at what the tsTON
is currently worth. The reserve is `staked_reserve.reserve_fraction_of_pending` = **0.20** of
the ratchet's *whole obligation*, so `staked_reserve.staked_fraction` = **0.80** is what ends
up in the pool. Both are in `shared/params.json` under `staked_reserve`, both are sim
outputs with the sweep that chose them recorded in that block's own `_source`, and the
day-count they were swept from is published beside them: `_equivalent_reserve_days` = 1.0
reserve-day at `flush_pct` = 0.20. Above four reserve-days the rule stakes exactly nothing
(`_reserve_days_ceiling`), which is why the constant is published as a fraction and not as a
day count.

> **The obligation is the three terms, not the balance.** `pending` on chain is only the GRAM
> physically on the ratchet, because `getSolvency().liability` must keep equalling it exactly
> (§3.4). So the obligation a future `flush()` may have to meet is
> `pending + stakedCost + exiting`, and `reserveTarget` is 20% of *that*. It is **derived on
> every read, never stored** — a stored copy would go stale on the next injection, and a
> stale reserve is wrong exactly when the mint rate is highest. It is also invariant across a
> stake or an exit, since both only move GRAM between the three terms, which is what lets an
> exit be sized in one step.

**The identity, in full.** §5's three-term form becomes six:

```
T = seeded + swapped + pending + stakedCost + exiting + realizedLoss
```

- `stakedCost` — GRAM in the Tonstakers pool, at what it cost. A term of `T`.
- `exiting` — a tranche on its way back out of the pool, at the cost it carried when it
  left. A term of `T`.
- `realizedLoss` — cumulative GRAM that left and did not come back. **No message can lower
  `T`** (§5), so a shortfall cannot be subtracted; it is named instead, and it makes `p_f`
  overstate the backing by exactly `realizedLoss / S`. §5 states the one thing that can move
  it.

Every credit is matched by an equal debit in the same step, so the sum is conserved by
construction: `stake()` moves `pending → stakedCost`, an exit moves `stakedCost → exiting` at
send and `exiting → pending` on arrival, and every failure route reverses exactly what it
wrote. `FuzzInvariants.spec.ts` asserts it as an equality, not as a bound.

**Three arms, and not one of them carries an amount.** This is §11.14's second constraint
made structural rather than promised, and it is the whole reason they can be permissionless
in exactly the sense `flush()` is:

| Arm | When it is callable | The amount, computed where |
|---|---|---|
| `stake()` | nothing in flight, and `pending − reserveTarget > stake_min_ton` | `pending − reserveTarget`, from the three terms |
| `unstake()` | **only when the reserve is short** — `pending < reserveTarget` — and the tranche that refills it is at least `harvest_dust_tston` (a dust tranche redeems to nothing and would park the exit machine for the recovery window) | enough to restore the reserve, sized at the contract's own cost basis and rounded **up**, so the refill lands on the target or a nano above it, never under |
| `harvest()` | no exit open (D-197), `harvest_interval_seconds` = 2,592,000 (30 days) since the last one, accrual at or above `harvest_dust_tston` | `tstonHeld` minus what `stakedCost` is worth at the rate we paid |

A caller supplies gas and a query id and nothing else. **D-155 adds a fourth arm on the same
terms** — `recover_exit()`, the stranded-exit backstop described under the exit legs below;
it too carries no amount, and it is weaker still, because it cannot move value at all. `unstake()` in particular is *not* "an
exit on demand": with the bid already funded there is nothing to refill, and an arm that
unstaked whenever anyone asked would be precisely the discretionary surface §11.14 refused.
The keeper may poke all three on its existing cadence with no authority at all, the same
standing it has for `flush()`.

**The rate is learned, not probed.** A contract cannot call another contract's get-method,
and a Tonstakers withdrawal arrives carrying no amount in its body, so the filled GRAM and our
own returned gas cannot be separated — a probe burn measures a sum, not a rate. A *deposit*
is exact: the pool's `transfer_notification` names the tsTON minted against a GRAM figure this
contract chose, so `lastRate` is read off **every optimistic `stake()`** at no marginal cost —
and **kept only when it raises GRAM per tsTON** (`GAUNTLET.md` B37). Every fill under-states that
ratio (the pool mints against our stake plus the unspent stake gas, the pair books the stake
alone), a small stake by the most, and `harvest()` values the whole position at the one pair:
taking the latest let a small stake after a large one read accrued yield below zero. The higher
of two under-estimates is still one, so nothing becomes less conservative.
`getStaking()` publishes it as the pair it was learned as, so a reader checks the ratio
rather than a quotient we rounded. A stale rate is safe in the only direction that matters:
tsTON appreciates, so an old rate makes `harvest()` compute *less* accrued yield, never more.

**The rate is learned only from a fill that can be authenticated** (audit H2, 2026-11-19).
With Tonstakers' optimistic deposits **off** (a governor setting, `pool.func:269-272`) a
deposit becomes a payout bill, and its tsTON arrives at round end as a jetton *transfer*
from the bill collection — whose address is salted, so nothing about the arrival says it is
ours. Such a fill teaches no rate and never closes the stake. Instead **every tsTON arrival
that is neither the authenticated mint nor an exit leg's answer is valued at the last learned
rate** and credited against the open stake (`stakeCredited`, published by
`getStakingGates()`), the remainder against any past write-off, which it restores
(`stakedCost += c`, `realizedLoss -= c`). A stranger can restore cost only by donating tsTON
worth it at that rate. Under non-optimistic deposits a stake therefore stays open for the
72-hour window below, and `recover_exit()` writes off only the residual — the drift between
the last learned rate and the pool's current one (on a first stake, the 1/1 seed against the
pool's rate), published as `realizedLoss` while the tsTON behind it is still held.

**That write-off is restored before anything is called yield.** The next authenticated fill
values everything held before it at the rate it teaches, and the part of that value above the
cost it carries goes back into `stakedCost`, up to `writtenOff`, in the same transaction — so a
`harvest()` at the new rate never reads the written-off tsTON as yield. **What remains, and is
published rather than hidden:** while no authenticated fill has come (the pool stays
non-optimistic), the written-off cost stays in `realizedLoss`; a tranche that exits in that
time redeems for more than its written-down cost, and the surplus joins the gas buffer, not
`pending`. And while the rate has never been learned (still the 1/1 seed) a refused leg 1
skips the DeDust leg and waits for leg 3's exact-rate bill, because a swap floored at a seed
rate could fill well under the pool's own.

**The exit, in three legs, in order, and never an unguarded sale.**

1. **Tonstakers' own immediate withdrawal, at the pool's exact rate.** Burn tsTON with
   `wait_till_round_end = 0, fill_or_kill = 1`. Two outcomes and no third: GRAM at
   `total_balance/supply`, or the pool re-mints the tsTON and nothing was sold. No venue, no
   price impact, no partial state. It fills when the pool's free GRAM covers the tranche,
   which on a quiet day is most sizes and in a run on the pool is none of them.
2. **The DeDust tsTON/GRAM stable pool, with a floor on the fill.**

   ```
   min_out = amount × max(costBasis, lastRate × (1 − exit_slippage_bps))
   ```

   `exit_slippage_bps` = **50** and is the **owner's** figure, not the sim's
   (`staked_reserve._exit_slippage_bps_source`). Two bounds, and the floor is the
   load-bearing one: the 50 bps governs how far below the *observed rate* we will fill, and
   `costBasis` — this tranche's own GRAM-per-tsTON as booked at `unstake()` — means we never
   fill below what we paid at all. A book that will not pay our cost refuses the swap and the
   exit falls through to leg 3; a discount is not an answer to a bad price. Neither outcome
   is a bounce — a fill arrives as the same `payout#474f86cf` §4.3.1 already handles, and a
   refusal hands the tsTON back as a `transfer_notification`, which is what advances the leg.
3. **The pessimistic bill, at the exact rate.** Burn with `wait_till_round_end = 1,
   fill_or_kill = 0`; the pool pushes the GRAM back at round end, ~36 hours
   (`staked_reserve.leg3_latency_days` = 1.5). When it lands it is `pending` again and `flush()` is
   callable by anyone. This is a *rule*, not a manual action — §8 forbids the admin key a
   manual action would need.

**A fourth thing can happen, and it is that none of the three legs ever answers.** Every
transition above is driven by an *inbound reply*, and a reply is not a guarantee: it can be
lost, malformed, under-gassed in a way that does not bounce, or sent by an address one of
this contract's sender gates rejects. Until `DECISIONS.md` **D-155** the machine had no way
out of a non-idle leg other than that reply, and while a tranche is outstanding `stake()`,
`unstake()` **and `flush()` all refuse** — so a single lost message stopped §4.3.1's core
loop, not merely the staking arms, with no recovery short of a redeploy. It happened on
testnet on 2026-09-21: a leg 2 payout arrived from an address that was not the DeDust native
vault, the handler refused it, the message was non-bounceable so the GRAM was credited while
no accounting ran, and the machine sat on leg 2 forever.

**`recover_exit()` is the backstop, and it is a fourth permissionless arm with no number
either.** Once an exit has been open for longer than the recovery window, anyone may call it,
and its entire effect is to run the same restoration the bounce handlers run: the tranche's
`exitCostBasis` goes from `exiting` back to `stakedCost` — **both terms of `T`, so `T` is
unchanged** — the tsTON claim returns to `tstonHeld`, and the leg returns to idle.

- **It restores and never credits.** `pending` is not written by it. There is nothing for a
  caller to aim and nothing to gain, which is what lets it be permissionless in exactly the
  sense the other three arms are (§11.14), and it is why it adds no admin surface under §8:
  it cannot move value, only undo a bookkeeping state no message can reach any more.
- **It cannot double-credit a payout that arrives late.** After it has run, the outstanding
  tranche is zero, and that is precisely the state the arrival handler already returns on —
  late GRAM joins the gas buffer instead of being counted twice.
- **On legs 1 and 2 it may leave `tstonHeld` overstated**, if the tranche really was sold and
  the proceeds landed unattributed. The tsTON comes back with its whole cost, so `harvest()`'s
  accrual does not move, and the shortfall surfaces as `realizedLoss` at the next real exit.
- **On leg 3 it writes off instead of restoring (`DECISIONS.md` D-197).** Leg 3's burn has
  provably taken — its bounce and the pool's re-mint both abort on arrival — so the tsTON is
  gone. Whatever basis the bill has not paid, all of it if the bill never came, is booked as
  `realizedLoss` and the exit closes. Restoring it instead let a bill that paid *under* cost
  (partially credited, so a forgery cannot close a tranche) come back as full tsTON against
  only the residual cost, which `harvest()` would have sent to the treasury as "yield". A bill
  that pays after the write-off joins the gas buffer, so the error runs one way: a loss
  over-published, never backing given away.
- **A stranded stake is written off the same way.** `stake()` and `unstake()` refuse while a
  deposit awaits the pool's mint notification, and only that notification or the deposit's
  bounce clears it — so a mint that landed without its notification locked staking, and the
  reserve's refill with it, for ever. Past the same window, `recover_exit()` books the
  deposit's cost **not yet matched by arrived tsTON** (`inFlightStake − stakeCredited`) as
  `realizedLoss` and adds it to `writtenOff`: not back to `pending` (the GRAM left), not as
  tsTON at the last rate (the mint may never have happened, and invented tsTON reads as
  yield). tsTON that lands afterwards — a late mint or a late bill, from any sender — restores
  at most its value at the last learned rate and teaches nothing. `writtenOff` is never
  forgotten, and a new stake waits two windows from any stake `recover_exit()` closed, whether
  or not anything was written off (a donation can cover the whole stake). The leg 1 or leg 2
  reply of an exit `recover_exit()` aborted is recognised if it lands late, and not counted a
  second time. The error runs the same one way.
- **Leg 3 does not hold `flush()` shut.** `flush()` refuses on legs 1 and 2, whose replies share
  DeDust's payout opcode with a flush's; leg 3's `payout_distributed_asset` shares nothing, so
  the ~36-hour bill waits without stopping §4.3.1. `harvest()` refuses on every leg.

**The window is 72 hours, and its floor is set by leg 3.** The pessimistic bill pays at
*round end* — ~36 hours (`staked_reserve.leg3_latency_days` = 1.5) — so a timeout at or under
that would abort a leg that is merely waiting its turn, which is the design working rather
than failing. 72 hours is twice the round, so the arm can only ever fire on a reply that has
genuinely stopped coming: it is a liveness backstop and never a competitor to the legs. The
figure is scaled by the same deploy-time `clockDivisor` D-139 applies to the flush cooldown
and the harvest interval, and `getExitLeg()` publishes both the window this deploy enforces
and when the current exit opened, so §9.1 holds against the clock the contract actually runs.

> **The bill's sender cannot be authenticated, and the design absorbs that instead of
> fighting it.** The payout collection's address is salted at deploy, so it cannot be
> precomputed at genesis or whitelisted afterwards without adding the admin surface this
> contract's whole claim is that it has none of. So the arrival handler credits `pending` and
> draws `exiting` down by the same figure — **both terms of `T`** — which leaves `T` unchanged
> under a forged message and the credited GRAM really on the balance, because it *is* the
> message value. Forging it is a donation. That is the whole defence, it is arithmetic rather
> than a check, and it is why leg 3 is buildable at all.
>
> **Every other reply is authenticated by what a trusted hop vouches for, never by a
> `query_id`** — ours is public in the outbound message before the reply lands, and a forger
> writes his own. Concretely (2026-09-26, after all four were shown forgeable):
> - **Leg 3's `payout_distributed_asset` and leg 2's DeDust payout** credit
>   `c = min(value, exitCostBasis)` to `pending` and draw `exiting` and `exitCostBasis` down by
>   the same `c`, only while that leg is open; the exit closes when the basis reaches zero.
>   Leg 2 needs this even though its vault is checked: anyone can make that vault pay the
>   ratchet by naming it as a swap's `recipient_addr`.
> - **Leg 1's `withdrawal`** is sent by the Tonstakers pool itself, so its sender is checked.
>   It is the only arrival that closes an exit whole and books a shortfall as `realizedLoss`.
> - **A tsTON `transfer_notification`** moves the stake or exit machine only when its TEP-74
>   `from` is `addr_none` (Tonstakers' minter, on a mint or re-mint) or DeDust's tsTON vault
>   (leg 2's refund), and a refusal must return the whole tranche. Any other tsTON is valued
>   at the last learned rate and credited against the open stake or a past write-off (above):
>   a stranger's nano-tsTON can no longer teach the rate `harvest()` sizes by, and a
>   non-optimistic fill — from the bill collection, so also unauthenticated — still carries
>   its cost.
> - **A flush's refusal** is recognised only when the vault's payout is at least the swap in
>   flight. A genuine refusal returns the whole input plus leftover gas (mainnet: 50.00 GRAM
>   in, 50.2759 GRAM back), so anything smaller is not ours.

**`harvest()` touches no term of `T` at all.** It moves `tstonHeld`, which is not in the
identity; `pending`, `stakedCost` and `exiting` are not written by it. That sentence is
"realize, never mark" written as arithmetic, and it is why **unrealized yield never enters the
floor price** — an external, unverifiable number inside `p_f` is exactly what §2 forbids. What
leaves is the accrued tsTON **as tsTON**, by a TEP-74 transfer forwarding 0.05 GRAM so the
treasury's own handler runs and counts it (audit M1: at a zero forward a TEP-74 wallet sends no
notification and the tsTON landed uncounted), to the **LP-governed
treasury** (§3.3, §5.5, D-100 point 7), which gains `ASSET_TSTON` in its proposal types and
publishes the balance in `getTreasuryBalances()`. It is new GRAM-denominated value that never
entered `T`, so the backing and the floor are untouched by it, and it reaches the **operator
only if an LP-depositor proposal sends it there** — there is no route from this arm to an
operator address, and `getHarvestDest()` publishes the one address it can pay.

**The counterparty's fees are what shape the parameters, and the CALLER pays them**
(`DECISIONS.md` D-146). Tonstakers credits a deposit **less a flat 1 GRAM** and charges
**~0.5 GRAM per withdrawal** — read from the upstream source on 2026-09-20 and recorded with
file and line in the contract. The 1 GRAM is a **gas reserve, not a fee**: the pool mints with
everything above its reserve and the unspent ~0.89 GRAM comes back as `excesses` (measured on
mainnet 2026-11-23). `stake()` therefore attaches `amount + 1 + 0.01` (the 0.01 only outbids
the deposit's forward fee, so the pool credits at least `amount`), credits
`stakedCost += amount`, and **asserts the caller attached the reserve and the margin** (1.02 GRAM)
before anything moves, refusing by name (225) if not and returning the change if over; when the
pool's `excesses` for that stake arrives (authenticated on the tsTON wallet and the stake's query
id) the ratchet forwards it, inbound value only, to the caller. A stake costs its caller ≈ 0.13
GRAM net, almost all of it the 0.1 GRAM notification that pays the ratchet's fill.
`harvest()` is the same at 0.16 GRAM (its 0.15 GRAM wallet hop includes the 0.05 forward). `unstake()` asks 1.96 GRAM, because it **prepays the
whole exit**: legs 2 and 3 are sent by the replies that refuse the leg before them, when no
caller is present, so their gas is taken up front and held; what the chain does not spend
stays in the ratchet's gas buffer — the only direction the rule allows. The reason for all of
it is the theorem: **a fee taken out of the staked amount would drop `T` by 1 GRAM on every
stake, and `p_f = T/S` with it.** An accounting choice is not allowed to break §5, so the
fee comes from the caller or the stake does not happen.

That flat cost is also why `staked_reserve.stake_min_ton` = **50** is an *economic*
parameter and not a dust guard. The sim charges each stake `deposit_fee_ton` = 0.113 GRAM — what
the reserve does NOT bring back (0.887 of the 1 GRAM, the low end measured on mainnet), not the
1 GRAM it attaches; at the modelled 4% APR that needs ~2.8 GRAM staked for a year merely to
break even. The sim sets the minimum so fee spend stays a stated fraction of yield —
`fee_share_of_yield` = 0.048 at the headline APR, the one constraint the sim applies. (It was
500 until 2026-11-23, sized while the sim charged the whole 1 GRAM reserve as a fee —
`MISTAKES.md` 2026-11-23.) (A second one — stakes rare enough for the ratchet's own
gas accrual to fund their fees — was deleted with D-146, since the caller pays those fees
now. It never bound: fee share implied ~289 GRAM against its ~118.)

**50 is the MAINNET minimum, and a deploy may divide it** — the same concession D-139 makes
for every wall clock in a set, on the value axis instead of the time axis. `DECISIONS.md`
**D-153** adds a deploy-time `stakeDivisor` to `RatchetConfig`; the constant above keeps its
declared value and the contract divides it at its one read site, so a deploy chooses a SCALE
and never a different economics. **Mainnet deploys 1 and the 50 above is exact.** The reason
it exists is that the reserve is 20% of the obligation, so `stake` is illegal until `pending`
exceeds **62.5 GRAM** — which arrives in the ordinary course of the game on mainnet and, on a
test network, only by donating GRAM that §8 makes irreversible. It is init data, no message
reaches it (nobody can lower the gate on a running set), and `getStakeMin()` publishes the
DIVIDED figure so §9.1 holds against the threshold the deployed contract actually enforces.

**What the sim shows, and what it does not.** At the chosen configuration the base run ends
with 159,495 GRAM at cost in the pool against 39,917 GRAM liquid, a reserve target of 39,883
GRAM covering the largest tranche any flush asked for **111×**, **zero** unmet flush demand
across 3,158 stakes (357 GRAM of caller-paid stake cost over three years), and 7,135 tsTON
harvested to the treasury
(`staked_reserve.chosen_configuration`). The modelled APR is **an assumption, swept over
{2%, 4%, 6%} rather than chosen** (`_modelled_apr_source`), and since yield never enters `T`
every other figure in that block is identical at all three rates. **The run produced zero
exits**, because the venue-depth clamp keeps a real tranche two orders of magnitude below the
ceiling the reserve is sized against — so the three legs are **unexercised by the sweep**, and
`unmet_flush_ton == 0` must not be quoted as a measurement of them. They are proved by the
mock pool's branch tests and by the vendored upstream fixture in `@ton/sandbox`; there is no
Tonstakers testnet deployment and no possibility of one that earns.

**One get-method publishes all of it.** `getStaking()` returns `stakedCost`, `tstonHeld`,
`exiting`, `lastRateNum`/`lastRateDen`, the derived `reserveTarget`, `lastHarvestTime` and
`realizedLoss` in a single call — §9.1's rule applied to a mechanic whose every number the
dashboard shows. `getStakingVenue()` names the three venue addresses, `getHarvestDest()` the
one address that receives value, `getExitLeg()` which leg a tranche is on — with, since
D-155, when that exit opened and the recovery window this deploy enforces, so a reader can
tell a waiting leg from a stranded one — and
`getSolvency().liability` stays **exactly** `pending`, unchanged: staked GRAM has physically
left the balance, so counting it would make the solvency delta negative for the whole round
trip.

### 4.4 Acquiring a number before the head reaches it: one auction lane

> ## THE SCORE IS REPLACED — 2026-09-04 (`DECISIONS.md` D-99)
>
> **This box amends every box and every paragraph below it on the subject of `D(n)`, and
> nothing else. The lane structure is untouched.** `desirabilityScore` — the 0..120,
> four-layer score (SCARCITY / PATTERN / CALENDAR / MATH, in which primality weighed 0)
> whose derivation, weights, clamp and histogram are set out at length below — is
> **deleted**, along with `D_MIN`, `PRIME_P0_MIN`, the rarity tiers and their per-tier
> `price_max` / `price_min`. In its place is **one additive score, `D(n)`, clamped at
> `SCORE_MAX = 87`**, summing 33 weighted categories plus a continuous length term. The
> model, the full weight table, its provenance and the two curated lists are **§9.6**;
> §4.4 keeps only what it always kept — the lanes, and the fact that the score sets `P0(n)`
> and the bid increment.
>
> Three consequences bite in this section specifically:
>
> - **`P0(n)`'s formula loses two branches and gains none.** It is
>   `max(LOT_FLOOR, ladder(D))` for a composite and `max(LOT_FLOOR, ladder(D), 1.5 · NPV(n))`
>   for a prime. `PRIME_P0_MIN` is gone: a prime scores 15 points for being prime, so the
>   ladder itself is what makes the prime lane worth opening.
> - **The ceiling is the clamp — on the ladder, not on the NPV term.** `MINT_PRICE · 2^(87/10)
>   = 415.87 GRAM`, just under answer 9's 420 GRAM, is the highest price the *ladder* can ask, so
>   no composite opens above 420 GRAM (D-99 answer 9 is a composite cap). A prime's
>   `1.5 · NPV(n)` term is yield, not score, and is not clamped: `2`, `3`, `5` and `7` open
>   above it — prime 2 at `1.5 × 896.86 ≈ 1,345 GRAM` (`shared/params.json`
>   `trophy_auction.npv_ladder.npv_ton_by_prime`). The "widest achievable score 88 → 446 GRAM" row in the table
>   below is arithmetic from the deleted weights.
> - **The weights are owner-declared again, and §11.25's promotion of them to a sim output
>   is withdrawn** — see the closure appended to §11.25. The sim still owns `NPV(p)`, the
>   increment ladder and the rebate rates; it does not own a guess at demand.
>
> The pre-D-99 score's derivation (old point 1a) was deleted from this section 2026-09-25;
> it is in git at `0408f21d`.

> ## SUPERSEDED AGAIN — 2026-09-01 (`DECISIONS.md` D-90)
>
> **D-90 amends the D-88 box below, which amends the D-30/D-31 box under it, which amends
> the section under that. Where the four disagree, THIS box wins.** The change is one
> sentence: **winning a lot mints the number, in the transaction that closes the lot.**
>
> | | ahead of the head | at / after its turn |
> |---|---|---|
> | **composite** | paid ascending auction, 7 days → **the winner gets the NFT at close** | mints sequentially, 1 GRAM — the core loop |
> | **prime** | paid ascending auction, 7 days → **the winner gets the NFT at close** | descending from `P0(p)` to `restingPrice(p)` over 7 days, then **parks there until bought** |
> | **memorable, either class** | the same lane — the score `D(n)` raises `P0(n)`, nothing else (D-99) | the same — a composite still mints at 1 GRAM; a prime's rest follows its own `P0(p) / 3` |
>
> **The third row is D-99's, 2026-09-04, and it deletes a vocabulary rather than a lane.**
> It used to read "the same, at its tier's `price_max` … resting at its tier's `price_min`".
> There are no tiers, no `price_max` and no `price_min`: one additive score `D(n)` prices
> every number through one ladder (§9.6), and a composite the head reaches mints at 1 GRAM
> whatever it scores.
>
> The only cell that changed is the composite's, and D-88 point 4 is completed rather than
> reversed: it gave a won prime instant delivery because the head would never arrive at one.
> **The head never arrives at an auctioned composite either** — D-45 marks the number off the
> sequential line the moment `open_lot` runs and the head-advance walk skips it forever — so
> the claim it kept was waiting for an event the protocol had already made impossible.
>
> **What is deleted, not rewritten:** the escrowed claim, its never-expiry (D-28), the
> release right and its 90/10 split (D-32), the permissionless `settle(n)`, and the escrow
> shard the record lived on. §3.4's three pools become **two**.
>
> **The one mechanism that had to change.** `executeMint` required every cited prime factor
> to be in the ledger's prime bitmap, and a prime enters it only when the head-advance walk
> crosses it — so a composite bought ahead of the head could cite a factor also ahead of the
> head (`2 × 1,000,003` with the head at 500) and settlement threw. Such a factor is now
> **proved by Miller–Rabin at settlement**. Proving it prime does NOT make it eligible: it is
> not marked, not counted into π(n), and not put on the flat dividend line, so mint order and
> every tribute divisor are untouched. Its divisor-line share **forfeits to the treasury**,
> under §6 point 2's rule for a prime with no owner.
>
> **Nothing about price moves.** The §4.1 split, the premium injection at close and the
> floor step are byte-identical; `RES_GAS` keeps its value and its place in `LOT_FLOOR`.
>
> ---
>
> ## SUPERSEDED — 2026-08-31 (`DECISIONS.md` D-88)
>
> **D-88 amends the D-30/D-31 box below, which amends the section under it. Where the
> three disagree, this box wins.** The change is one sentence: **the lane a number is on
> is decided by WHERE THE HEAD IS, and only then by primality.**
>
> | | ahead of the head | at / after its turn |
> |---|---|---|
> | **composite** | paid ascending auction, 7 days → the winner holds an escrowed claim until the head arrives — **D-90 deletes the claim; it mints at close** | mints sequentially, 1 GRAM — the core loop |
> | **prime** | paid ascending auction, 7 days → **the winner gets the NFT at close** | descending from `P0(p)` to `restingPrice(p)` over 7 days, then **parks there until bought** |
> | **special, either class** | ~~the same, at its tier's `price_max`~~ — **D-99 deletes the tiers; the score raises `P0(n)`** | ~~the same, resting at its tier's `price_min`~~ — **D-99: a composite mints at 1 GRAM, a prime rests at `max(MINT_PRICE, P0(p)/3, NPV(p)/2)`** |
>
> **1. Every prime's descending lane terminates ABOVE 1 GRAM.** The resting price is
> `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)`, ~~lifted to the tier's `price_min` for a special prime~~
> (D-99 §1.2: the `P0(p) / 3` term, which carries the same 3× spread off the score's
> ladder) —
> where `NPV(p)` is the deploy-time table of the tribute a prime is expected to earn over
> the life of the game, the same table `P0(p) = 1.5 · NPV(p)` already comes from. Opening
> to resting is therefore a **3× spread**. Small primes rest high (they earn tribute on
> every multiple, forever); large ones miss the finite table and rest at `P0(p) / 3`, or
> exactly 1 GRAM when they open under 3 GRAM (D-99 §1.2).
> **The lot then stays listed at that price until somebody buys it, with no expiry** —
> `sweep_expired_head_lot`, which used to delete an unbought lot after two decay windows,
> is deleted and `DECISIONS.md` D-50 is dissolved with it.
>
> This **deletes** §12's "no lane may terminate above 1 GRAM" and invariant MKT-1
> (`floorOf(MODE_DUTCH_BUYNOW) == MINT_PRICE`, exactly). MKT-1's liveness argument — that
> the head can never park permanently on a prime nobody will pay a premium for — was
> already vestigial: D-20 defines the head over composites and Unity only, so it does not
> stop at primes and has nothing to park on. What survives of MKT-1 is the half that was
> ever structural: the resting price is **write-once from `n` alone**, computed by
> contract code at the one moment the record is created, carried by no message and updated
> by no handler.
>
> **2. Specialness is PRICE, not mechanism.** SS3's two special-only lanes are deleted —
> the 3-day special-prime window and the 1-day descending route for a curated composite
> the head had passed, with their messages (`open_head_lot_composite`,
> `buy_special_composite`) and their settlement (`settle_special_composite`). A special
> number is an ordinary lot on an ordinary lane over the ordinary 7-day window, whose `p0`
> and resting price are ~~lifted to its tier's figures~~ **set by its own score `D(n)`**
> (D-99 deletes the tiers; §9.6). **Two lot modes remain.**
>
> **3. A number ahead of the head is bought at a paid ascending auction, whatever its
> primality.** This deletes D-31's prime half: a pre-turn prime was a *flat-priced
> descending* lot, "the price of impatience", openable for gas alone. It is now an auction
> opening at that same `P0(p)` — impatience is still what is priced, by an auction instead
> of a fixed quote, and the opener pays it up front instead of merely listing it. The
> `n < headHint` gate D-31 lifted off `open_head_lot` is **reinstated**, which makes the
> two lanes exhaustive and disjoint; the "opened early, standing flat" state and its
> `start_prime_decay` message are deleted with it.
>
> D-22's refusal of primes on the ascending lane is **reversed**. `kind` now selects the
> PROOF the open must carry — a factorization for a composite, nothing for a prime, which
> the contract checks with its own Miller–Rabin — and no longer selects a lane.
>
> This is also what dissolves D-50: a lot record now costs at least `PRIME_P0_MIN` (5 GRAM)
> to create rather than ~0.02 GRAM of gas, so nobody buys permanent storage cheaply and no
> deposit or per-opener cap needs sizing.
>
> **4. A prime's pre-turn auction winner gets the NFT minted at close**, not an escrowed
> claim. Under D-20 the head never arrives at a prime, so there is no later event a claim
> could wait for — which is exactly D-22's original objection, answered at the settlement
> instead of at the gate. Composites keep the waiting claim, whose trigger is real.
>
> > **D-90 CORRECTS THAT LAST SENTENCE.** The composite's trigger was NOT real: D-45 had
> > already taken an auctioned composite off the sequential line permanently, so the head
> > skips it forever and never arrives. Both kinds mint at close.
>
> **The one-route rule is not weakened but simplified.** It used to read "one route to a
> number ahead of the head, and it depends only on primality", with a named exception for
> special numbers. It now reads: **ahead of the head, an ascending auction, full stop** —
> and the special-number exception disappears by becoming the general case. Primality
> decides only what happens *at the turn*.
>
> ---
>
> ## SUPERSEDED IN PART — 2026-08-19 (`DECISIONS.md` D-30, D-31, D-32, D-33)
>
> **The flat-fee reservation lane is deleted**, and its text was cut from this section
> 2026-09-25 (git `0408f21d`). What remains below — `RES_GAS`, point 1b's two lanes, point 3
> — is live, but **where the text below and this box disagree, this box is the
> specification.**
>
> ### What replaces it
>
> There is now **one** way to acquire a number ahead of the head, and it depends only on
> whether the number is prime.
>
> **Composites — the ascending auction lane (D-30).**
>
> 1. **Any reservable composite may be opened as a lot.** The `D(n) ≥ D_MIN` gate is
>    **dropped**; D-6's trigger rule is superseded. D-11's 14-digit `AUCTIONABLE_MAX`
>    survives as the cap on what may be opened, for its original storage and
>    score-computation reasons.
>
>    **`MIN_AUCTION_DISTANCE` is NOT deleted, and this is not a detail** — AS OF D-30. This
>    paragraph is itself now superseded: **`DECISIONS.md` D-45 (2026-08-20) deletes
>    `MIN_AUCTION_DISTANCE` entirely.** D-30 dropped the *desirability* gate
>    `D(n) ≥ D_MIN`; the argument here was that the minimum head-distance gate was a
>    different constraint with a different job — **liveness**, not selectivity — and
>    should survive at 20,000 for exactly that reason. D-45 closes the liveness problem
>    structurally instead: `open_lot` now marks a composite off the ledger's sequential
>    line the moment a lot opens on it, *permanently* (`primes_ledger.tolk`'s
>    `reservedBitmap`, never cleared), so the head can never again reach a number an
>    auction has claimed, at any distance — there is no collision left for a minimum
>    distance to pre-empt. `MIN_AUCTION_DISTANCE`, the head-collision sweep in
>    `HeadUpdate`, and the early-close disjunct on `CloseLot` are all deleted with it. The
>    figures below (collision probability, claim-density bound, the 2.374× velocity
>    figure) are the §11.26 measurement that justified the pre-D-45 design and are
>    retained as history, not as the current mechanism — every other `MIN_AUCTION_DISTANCE`
>    mention in this document (§4.4's formula block, the liveness paragraph, §6 point 4,
>    §11.28, and §12's collision-risk item) means the SAME thing: a figure D-45 deleted,
>    kept here for the record of why the gate existed and how it was replaced.
> 2. **Opening a lot *is* the first bid, and it is paid.** The opener sees the opening
>    price `P0(n)`, pays it, and that payment is the standing high bid. Opening is never
>    free — this preserves D-20's principle that you cannot open a lot you are unwilling
>    to buy.
> 3. **The 7-day clock runs from that first bid** and extends on late bids (D-8's
>    anti-snipe, unchanged). If nobody outbids the opener, the opener wins at `P0(n)`.
> 4. **A won lot becomes an escrowed claim that waits for the head.** The number mints to
>    the winner when the sequential head arrives at it. **The claim never expires**
>    (D-28) — an indefinite hold is what makes the escrow a real demand signal, because
>    locked capital is the cost of signalling and a hold that lapsed for free would make
>    the signal worthless.
> 5. **The winner may release** — see D-32 below.
>
> **Primes — the descending Dutch lane, now openable early (D-31).** D-4, D-20 and D-22
> all stand: primes are never on the ascending lane and `open_lot` still refuses them. The
> one change is *when* a prime lot may exist.
>
> - The `n < headHint` restriction on opening a prime lot is **lifted**. A prime lot may
>   be opened at any time up to `AUCTIONABLE_MAX`.
> - **Before the prime's turn, its price is flat at `P0(p)`** — the rarity-derived opening
>   price, undecayed. The decay clock is not running; `decayStart` is unset.
> - **The decay begins when the prime becomes next among unbuilt numbers** — the condition
>   that used to gate *opening* now gates the *clock*. From there the price decays to
>   exactly `MINT_PRICE` over `PRIME_DUTCH_SECONDS` and rests there forever.
> - Anyone may buy at the standing price at any point, before or during the decay.
>
> This preserves D-4's structural liveness guarantee exactly — every prime still reaches
> 1 GRAM within a week of its turn, so the head can never park on an unprofitable prime —
> and it states §2 principle 7 more cleanly than the old design did: **the flat pre-turn
> `P0` is the price of impatience**, which is the only thing that premium was ever for.
> **The 1 GRAM terminus is untouched**, which is what §12 forbids moving at any price.
>
> ### Release: the winner may hand a claim back for 90% (D-32)
>
> After winning a composite lot and **before the head arrives**, the winner may release
> the claim. The escrow refunds **90%** of what they paid, the number returns to the
> unclaimed line, and the retained **10% routes to treasury**.
>
> - **This is not an exception to §4.1's "never to the team" rule.** That rule governs
>   *split lines* — an unresolvable tribute or referral leg falls to the pool. A release
>   forfeit is a fee on a discretionary action, and **D-20 already routes the unsold-prime
>   forfeit to treasury** on identical reasoning. See §4.1, where this is now recorded.
> - **There is no clock on the release right**, consistent with the claim itself never
>   expiring.
> - **Release ends at the mint.** Handing back a *minted* NFT for 90% was considered and
>   rejected: it would put a permanent protocol bid under every number, interacting
>   directly with the ratchet's solvency and §3.4's three-pool separation, and would need
>   its own sim run.
> - **The 90/10 split is an owner-chosen starting value, not a sim output.** It carries one
>   hard constraint that must be checked against the real gas profile before launch: **the
>   forfeit must exceed the gas cost of the open-and-release round trip**, or releasing is
>   free and opening lots becomes a costless griefing move.
>
> ### What the desirability score does now (D-33)
>
> *(D-99 later replaced the score itself; see the box above.)* What changes is what the score buys. It keeps two jobs and loses one:
>
> 1. **It sets the lot's opening price `P0(n)`** — already D-3's model for lot pricing, now
>    applied to every composite lot rather than only to those at `D(n) ≥ D_MIN`.
> 2. **It sets the minimum bid increment.** A rarer number requires larger bid steps, so a
>    contested rare number resolves in fewer rounds instead of grinding through hundreds of
>    minimum raises. This is a new consumer of the score. **The ladder has been delivered**
>    (2026-08-19): `min_increment_bps` = 1500 for the first three rungs and 2000 thereafter,
>    indexed by `D/10` over 13 rungs, with a derived floor of **0.015 GRAM** — the gas of a
>    bid plus the refund it forces. Note why the floor had to be re-derived rather than
>    kept: the old flat **1 GRAM** floor only worked while `D_MIN` held the cheapest lot at
>    8 GRAM. Dropping `D_MIN` (D-30) makes a 1 GRAM minimum raise absurd on a lot that opens
>    near `LOT_FLOOR`, so the two changes are not separable.
> 3. **It is no longer a fee multiplier.** `RES_PREMIUM` does not exist. Nothing anywhere
>    is charged as a scored fee.
>
> D-21's signed objective for the weights survives and is re-aimed: what the weights should
> optimise *for* is unchanged by their feeding an opening price and an increment rather
> than a fee. The pending sim run stays valid in shape and must be re-run against the new
> consumers, with the increment ladder as an additional output.
>
> ### What is deleted outright
>
> | Deleted | Why |
> |---|---|
> | `RES_PREMIUM(n)` as a fee | The score sets an opening price now, not a fee (D-33) |
> | `RES_PRIORITY_BASE` | There is no book to buy a place in; the auction *is* the price (D-30, D-37) |
> | `D_MIN` as a lane gate | Any reservable composite may be opened (D-30) |
> | The direct `Reserve` entry points | One route: open a lot (D-30) |
> | The two-queue `RES_PRIORITY` design | Already amended into mootness (D-15) |
> | **Cancellation** (`cancel`, 5% → pool) | Replaced wholesale by **release for 90%, 10% → treasury** (D-32). The two are the same mechanic at different prices, so leaving `cancel` beside `release` would make the release forfeit unreachable — nobody pays 10% when 5% sits on the next opcode. D-90 then deleted release too. |
>
> **`RES_GAS` survives; its current figures are in the `RES_GAS` block below.** A won lot becomes
> an escrowed claim that must still fund its own `settle(n)` when the head arrives, or it
> strands the head at `n` — the reservation-side parked head that `RES_GAS` exists to
> prevent. It remains never-waivable, never payable in PRIMES, stored as its own field on
> the shard record, and derived (`sim/primes_sim/gas.py res_fee_split`) rather than chosen.
> **Its derivation has been re-run** (2026-08-19, `sim/primes_sim/gas.py res_fee_split`),
> because the fee it was carved out of no longer exists and the entry points it was priced
> against were rewritten. The result: **`RES_GAS` = 0.060 GRAM**, up from 0.040, and the
> lane floor `LOT_FLOOR = MINT_PRICE + RES_GAS` = **1.060 GRAM** *(since `DECISIONS.md` D-113:
> `RES_GAS` = 0.070, `LOT_FLOOR` = 1.070 — the D-90.4 floor)*. The three legs that moved:
> the reserve-time notify hop became a **close-time claim write**; the worst-case
> **scoring row left** the settle path, because D-33 puts `D(n)` at `open_lot` where the
> opener pays it; and the **rent leg lost its horizon** — a claim never expires (D-30), so
> no head-travel figure bounds it. That last one is the substantive change: ten years is
> now a *declared* horizon published beside the modelled 539-day wait it dominates 6.77×,
> not a derived bound. The table below is superseded by that run; read it for the method.
>
> **§7 era boundaries remain on neither lane**, at any score, for the reasons stated below
> and in §7 — the argument against privatising a public ceremony is unaffected by the route.
>
> ### What this costs, stated rather than discovered
>
> *(Historical — this work is done, and D-90 then went further: `primes_market_shard.tolk`
> and the post-win escrow-and-wait state were deleted, and a won lot mints in its own
> close.)* `primes_market.tolk` and `primes_market_shard.tolk` both carried reservation paths
> that had to be **rewritten, not deleted**. The gas profile of the common acquisition path
> changes, so `GasRegression.spec.ts` and `contracts/gas-baseline.json` are expected to
> move; **that movement is a design question to review, not a baseline to silently
> update**. Every reservation-lane test is rewritten or deleted. §11.26's sim question is
> re-scoped accordingly and stays launch-blocking. *(Re-scoped again 2026-09-24 to the prime
> pre-funding displacement alone, and closed by the owner the same day — see §11.26.)*
>
> ---
>
> *The pre-D-30 text of §4.4 — the prepaid `reserve(n)` lane, `RES_FEE`'s three fields, the
> four-layer desirability ladder (old point 1a) and its histogram, permissionless `settle(n)`
> (old point 2), cancellation and release (old point 4) — was deleted 2026-09-25. It is in
> git at `0408f21d` for anyone auditing the history. Point 1b and point 3 below are live.*

**`RES_GAS` — what a lot pays to fund its own closing transaction.** A won lot mints in the
transaction that closes it (D-90), and `RES_GAS` pays for the hops that transaction adds over
a plain mint (the `settle_confirmed` and `head_update` legs the ledger attaches back, plus
the market's close-path compute). It is part of `LOT_FLOOR = MINT_PRICE + RES_GAS`, so no
rank, sink or discount can reach it.

- **Derived, then floored.** `sim/primes_sim/gas.py res_fee_split` prices it off
  `contracts/gas-baseline.json` and rounds up to the next 0.005 GRAM: **0.035 GRAM** today
  (`shared/params.json` `off_head.res_gas_derivation.derived_res_gas_ton`). The shipped
  figure is **0.070 GRAM** (`off_head.res_gas_ton`; D-113 raised it from 0.060) and is
  floored there on purpose (D-90.4): lowering it would move `LOT_FLOOR` and with it every
  price on the lane. The 0.035 GRAM surplus is published as
  `off_head.res_gas_derivation.retained_headroom_ton` rather than banked.
- **Where it is charged.** On the ascending lane it is carved off the clearing price
  **before** the premium is computed, so a clearing price `C` decomposes as
  `restingPrice(n) + RES_GAS + premium`. On the descending lane it is charged **on top of**
  the standing price, because that lane's terminus is the resting price the seller is owed
  and there is nothing to carve from it.

1b. **Scarce numbers are priced, not queued — and what is priced is the right to buy
   early, never the number.** A first-come book resolves a contested number by whoever
   clicked fastest; this point is where that contest is settled in money. A composite's
   turn still costs the ordinary 1 GRAM mint, and anyone unwilling to pay for earliness waits
   and pays it (§2 principle 7); a prime's descending lot rests at `restingPrice(p)` (§6
   point 1).

   **Superseded 2026-08-16/17.** Everything in this point replaces the three-contract
   description earlier drafts carried — a separate genesis auction, a separate trophy
   auction and a separate reservation book, in `primes_auction.tolk`,
   `primes_trophy_auction.tolk` and `primes_reservation_book.tolk`. Those contracts no
   longer exist (`DECISIONS.md` D-3, D-16); one contract, `primes_market.tolk`, carries
   every lane. ~~plus `primes_market_shard.tolk` for escrow records~~ — **D-90 deleted the
   shard too**, so the router/record pair is now a single contract. The settled storage
   layout is `docs/audit/unified-market-layout.md`.

   **Which numbers are on which lane.** D-6's rule, narrowed by `DECISIONS.md` D-22
   (signed 2026-08-17), and computed from a *verified* class rather than a claimed one:

   ```
   ANY number ahead of the head      →  ascending auction lane (lane B)  [D-88 point 3]
   kind = 1 (prime), at its turn     →  the descending prime lane (lane A)  [D-88 point 1]
   ~~kind = 1 (prime), any D(n) → lane A ONLY; `open_lot` refuses a prime (D-22)~~ VOID (D-88)
   kind = 0, ANY D(n)                →  ascending auction lane   [D-30, 2026-08-19]
   ~~kind = 0 and D(n) ≥ D_MIN       →  ascending auction lane~~   VOID
   ~~kind = 0 and D(n) <  D_MIN      →  reservable exactly as 1a~~ VOID — no fee lane
   §7 primorials                     →  neither lane. They mint at the head only.
   ```

   **Why primes are a class and composites are a score.** A prime carries a perpetual
   tribute claim (§3.2) that no composite does — genuine cash flow, not a look — so "every
   prime is a trophy" is defensible on income grounds at any number of digits, including a
   plain 11-digit prime that scores zero on every pattern predicate. "Every number that
   looks nice is a trophy" is not defensible, which is why composites still need a
   threshold and primes do not. `D_MIN = 30` puts **22,361 composites below 10⁷** on the
   auction lane, 0.2236% of the window, read off the published histogram
   (`score.histogram`); at 40 the composite lane is a curiosity of
   1,454 numbers and at 20 it swallows 209,797, which is every plain four-digit number.

   **`P0(n)` — the opening price, on either lane.**

   ```
   P0(n) = max(  MINT_PRICE · 2^( D(n) / SCORE_HALVING )    the pattern ladder
                 PRIME_P0_MULTIPLE · NPV(p)   if prime      §6's own 1.5× rule
                 PRIME_P0_MIN                 if prime      the floor that makes
                 RESERVE_FLOOR                              the prime lane worth opening
              )
   ```

   with `SCORE_HALVING = 10`, `D_MIN = 30`, `PRIME_P0_MIN = 5 GRAM` and
   `PRIME_P0_MULTIPLE = 1.5`. `RESERVE_FLOOR = 1.05 GRAM` is **asserted equal to
   `MINT_PRICE + RES_GAS + RES_PRIORITY_BASE`** rather than written down beside them, so
   the boundary between the fee lane and the auction lane is a checked equality and not a
   coincidence that drifts the next time `RES_GAS` is re-measured.

   | n | D(n) | class | `P0` |
   |---|---:|---|---:|
   | 4818, 738491, 1000003, any 9+ digit composite | ≤ 20 | composite | fee lane, point 1a |
   | 1234 (run) | 50 | composite | **32 GRAM** |
   | 2023 (year) | 55 | composite | **45 GRAM** |
   | 10000 (power of ten) | 66 | composite | **97 GRAM** |
   | 1000 (power of ten) | 70 | composite | **128 GRAM** |
   | 1111 (repdigit) | 80 | composite | **256 GRAM** |
   | widest achievable score | 88 | composite | **446 GRAM** |
   | `SCORE_MAX` guard | 120 | — | 4,096 GRAM |
   | 17 | 28 | prime | `1.5 · NPV(17)` — the NPV branch binds |
   | 1000003 | 8 | prime | **5 GRAM** (`PRIME_P0_MIN`) |
   | 90000000017 | 0 | prime | **5 GRAM** (`PRIME_P0_MIN`) |

   **`PRIME_P0_MIN` is the number that makes the prime lane worth opening.** A plain
   11-digit prime scores zero and its tribute NPV is negligible, so without it both prime
   branches collapse to `RESERVE_FLOOR` and the descending lane below would open two
   hundredths of a GRAM above its own floor — a ceremony with no price in it. At 5 GRAM there
   is a slope to walk down.

   **Why a threshold for composites rather than a continuous curve.** A continuous convex
   map surcharges the deep line: at `2^(D/10)` a seven-digit number scoring 8 would open
   at 1.74 GRAM, a 74% surcharge on the ~98% of the book that is unremarkable. The
   threshold keeps point 1a's best property literally intact — *the deep number line pays
   nothing, so the floor of the ladder is exactly the status quo.* `2^(D/10)` is also
   exact cheap integer arithmetic on TVM (`P0 = (MINT_PRICE << D/10) · FRAC[D mod 10] /
   2^16`, a fixed ten-entry table of `round(2^(j/10) · 2^16)`), and it runs on the market
   router, so it does not touch point 1's 0.0002 GRAM of `RES_GAS` headroom.

   ---

   **Lane A — the descending buy-now lane. Every prime, and only primes.**

   ```
   open_head_lot(n)  permissionless and UNPRICED. Opens the descending clock on a
                     verified prime that is next among not-yet-built numbers.
   D(t) = max( P0(n) · (1 − t / PRIME_DUTCH_SECONDS) , restingPrice(n) )  standing price
   buy(n)            pay D(t) + RES_GAS. A "bid" on this lane IS the purchase and it
                     SETTLES IN THE SAME TRANSACTION. No clock is opened, ever.
   no buy            D(t) rests on restingPrice(n) and stays there. The lot never
                     expires, is never voided, and never re-opens a bid lane.

   PRIME_DUTCH_SECONDS = 604800 (7 days)
   restingPrice(n)     = max( NPV(n) / 2 , P0(n) / 3 , MINT_PRICE )
                                                           [D-88 point 1, D-99]
   ```

   (The `P0(n) / 3` term is D-99's. It replaces "raised to the tier's `price_min` if `n` is
   special" — there are no tiers, so what lifts a memorable prime's resting price is the
   same score that lifted its opening price, at the same 3× spread.)

   This is the whole of §6's genesis mechanism and the whole of the prime mechanism,
   because they are the same mechanism: `DECISIONS.md` D-20 deleted the genesis-specific
   K-lot, its ascending bid phase, its `P0/100` reserve and its bootstrap, so **there is no
   genesis-specific lot format left and there is no genesis-specific prime**. Every prime
   from 2 onward opens the same way.

   Four properties, each of which is load-bearing somewhere else in this document:

   - **The floor is per-`n` — stored, but never settable.**
     ~~`floorOf(MODE_DUTCH_BUYNOW) == MINT_PRICE` is invariant MKT-1~~ — **deleted by
     `DECISIONS.md` D-88 point 1.** A prime's lane terminates at
     `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` (~~lifted to the tier's `price_min` if it is
     special~~ — D-99 deletes the tiers and the score's own `P0(p) / 3` does that job);
     `MINT_PRICE` is the *lower bound* on that, reached only by a prime past the finite `NPV`
     table that also scores nothing beyond being prime. §12's "auctioning a prime above the head" entry no longer rests on this clause —
     it rests on the head being defined over composites, which is the property that was ever
     doing the work.

     **How the "never settable" half is guaranteed, exactly**, because it is what survives
     and it is load-bearing. Until §9.6/D-47 the floor was *derived* — `floorOf` returned the
     constant `MINT_PRICE` and there was no field at all, so the guarantee was that there was
     nothing to get wrong. SS3 needed a special prime's lane to rest on its tier's
     `price_min`, so `Lot.priceFloor` is now a stored field and `floorOf` returns it. D-99
     deleted the tier but not the field: the floor is still per-`n`, because the score is.

     What survives is narrower and still structural: `priceFloor` is **write-once, from
     `n` alone**. No message carries it — neither `OpenLot` nor `OpenHeadLot` has such a
     field — so no caller, owner or operator can
     propose a value. It is computed by contract code at the single moment the record is
     created, by `restingPriceOf(cfg, n, score)` from the `NPV` table and the number's own
     score (~~`specialNumberTier(n)`~~ — deleted, D-99), and
     none of the three code paths that later update a lot (`closeLot`, `start_prime_decay`,
     a bid) touches it. There is no admin path to it because there is no path to it.

     What does *not* survive is the "cannot be wrong" part. A derived floor was one value
     for every lot; a stored one can be right for some `n` and wrong for others, so
     correctness across the space is now a **test obligation**, and D-88 made it a wider one:
     the floor is per-`n`, so `PrimesMarket.spec.ts` pins an unremarkable prime past the `NPV`
     table at `MINT_PRICE`, a high-scoring one at `P0(p) / 3` (~~a special prime at its
     tier's `price_min`~~ — D-99), and (C6 under D-88)
     every prime's lane at `getPrimeFloor(n)`, with `getLotFloor(n)` asserted to agree with
     `floorOf`'s own value on every lane a lot can be on. That is a weaker argument to
     hand an auditor than "no such field exists", and stating it as the stronger one would
     be the drift, not the field.
   - **A purchase settles in its own transaction and opens no clock.** If a buy started a
     7-day ascending clock the buyer would wait out that clock, which is the shape the head
     stall used to have. There is no bid to be outbid, no escrow held, and no refund path.
   - **The head is never involved.** Primes are not positions on the sequential line
     (§6 point 1), so this lane cannot stall the head, cannot be raced by the head, and
     needs no lookahead: **`DECISIONS.md` D-4a's `lookaheadH` is retired outright, not
     re-derived**, along with the argument that sized it. Eligibility is the plain
     comparison `n < headHint` — the head has passed the last composite before `n` — and
     once true it stays true forever. `headHint` is the market's cached copy of the head,
     and it lags on purpose: nothing on the mint path updates it. It moves only when someone
     sends the ledger the permissionless **`sync_head`** (`primes_ledger.tolk`, caller-funded,
     at least 0.01 GRAM), which changes no ledger state and forwards the real head to the
     market as `head_update`. A stale-low hint only delays a due prime lot; an ascending open
     on a number the head already minted is still refused by `mark_off_head`.
   - **`RES_GAS` rides on top of the price, and only on this lane.** The lane's terminus is
     the resting price the seller is entitled to (D-88 point 1), so unlike `RESERVE_FLOOR`
     it has no room to absorb the 0.070 GRAM that funds the sale's own settlement hop
     (`DECISIONS.md` D-113 re-derives this from 0.060). A purchase at the terminus is
     therefore **`restingPrice(p) + RES_GAS` all-in**, against 1.00 for a composite at the
     head; for a prime past the `NPV` table that opens under 3 GRAM that is `LOT_FLOOR` =
     1.070 GRAM. The difference
     from a composite is the settlement the buyer is funding — plus, for every smaller
     prime, the resting price itself.

   A won prime lot does **not** become a reservation. It is reported straight to the ledger
   as a clearing and minted off-head in the same transaction, so there is no escrow record,
   no `settle(n)` and no wait (`primes_ledger.tolk`'s `settle_prime_clearing`).

   **A closed lot leaves a sold bit, not a record** (`DECISIONS.md` D-188 point 5). A close
   behind the market's `headHint` — every close on this lane — sets `n`'s bit in the market's
   sold bitmap (256 numbers to a cell), and nothing clears it: that bit is what refuses a
   second `open_head_lot` on the same number (1002). A close AHEAD of `headHint` sets none:
   since `DECISIONS.md` D-196 the ledger's claim on `n`, made at open, is that record and
   refuses a second lot itself (Lane B's liveness paragraph). The lot row itself is deleted once the close
   has settled — on the ledger's `settle_confirmed`, or after the mint leg's bounce has
   refunded the winner — so the market's storage grows with open lots, not with every lot
   ever sold. `getLot(n)` on a settled sale answers `found, closed` with the other fields
   zero; the price and the winner are in the closing transaction.

   **A resting lot is a bit too** (`DECISIONS.md` D-200). A descending row (~1.8 cells) lives
   only while it descends. Once its 7 days are over it can only ever sell at its resting
   price, and every field it still needs — `P0(p)`, `restingPrice(p)`, the score — is a
   function of `p` and the market's deploy-fixed config, so the permissionless, caller-funded
   `park_lots` folds it into a `parked` bit beside the sold bit (one 512-bit leaf per 256
   numbers). The lot stays **open**: `bid` buys it at the same resting price, rebuilt from `p`
   by the same `restingPriceOf` that wrote the row, with no expiry; `open_head_lot` refuses
   it (1001); `getLot(p)` answers as the row did, with `openedAt` = 0 (the open time is in the
   open's own transaction, like a sale's price). The keeper pages `park_lots` through the map
   with `getParkScan(from)`. So the market's storage is one leaf per 256-number block behind
   the head, the rows of the last week's opens, the sales in flight and the paid ascending
   bids (~7.8 cells each, living one auction window) — and not one row per unsold prime,
   which before D-200 reached config 43's 65,536-cell cap near 35k unsold primes (n ≈ 425k).

   ---

   **Lane B — the ascending lane. Any number ahead of the head** (`DECISIONS.md` D-88
   point 3, D-90).

   > **Pointer, not spec.** This block used to specify a composite-only lane: `open_lot`
   > refusing primes (D-22), a `MIN_AUCTION_DISTANCE` gate of 20,000 mints, a flat
   > `max(1 GRAM, 5% · high)` increment, a won lot waiting as an escrowed claim for the head,
   > and an early close when the head arrived. **All of it is deleted**: D-88 point 3 opens
   > the lane to every number, prime included; D-45 marks an opened number off the
   > sequential line at `open_lot`, so the head skips it forever and there is no distance
   > gate and no early close; D-33 replaced the increment with a score-banded ladder; and
   > D-90 mints the number in the transaction that closes the lot. The current two-mode
   > design is the D-88/D-90 box at the top of this section; what follows is only its
   > ascending half's arithmetic.

   ```
   open(n, bid)   permissionless, n ahead of the head. Opens the lot AND places the
                  opener's bid, which must be ≥ P0(n). No score gate, no distance gate.
   bid(n)         ≥ high + max(0.015 GRAM, high · bps(D) / 10000)     (D-33 ladder)
                  The previous high is refunded IMMEDIATELY, in the same transaction.
   close(n)       permissionless once now ≥ closesAt. The high bidder wins at their
                  own bid and the number MINTS to them in this transaction (D-90).

   closesAt = openedAt + AUCTION_WINDOW                     AUCTION_WINDOW = 7 days
   closesAt = max( closesAt , now + BID_EXTENSION )          on every bid, 67 minutes
   ```

   **The two clock figures above are the MAINNET clock, and a deploy may divide them.**
   `DECISIONS.md` D-139 adds one deploy-time `clockDivisor` to the market, the ratchet and
   the treasury; it divides `AUCTION_WINDOW`, `BID_EXTENSION`, `PRIME_DUTCH_SECONDS`, the
   ratchet's `FLUSH_COOLDOWN` and the treasury's `NOTICE_DURATION` and `VOTE_DURATION` together, so a test set can
   run a 7-day auction in an hour without a second set of constants for anything to drift
   against. **Mainnet deploys 1 and the arithmetic above is exact.** It is init data on all
   three contracts and no message reaches it — nobody can shorten a lot that is already
   running — and every get-method publishes the DIVIDED figure, so §9.1 holds against the
   clock the deployed contract actually enforces rather than the one this document declares.

   **A lot always has a winner**, because opening requires a bid. There is no expiry path,
   no no-bid path, no reserve-not-met path and no refund-the-opener path. Opening costs a
   real bid locked for the window, so the open-lot count is demand-bounded rather than
   eligibility-bounded, and every lot ratchets the floor by half its premium (D-114; the
   other half goes to the governed treasury).

   **The close extends on late bids** (`DECISIONS.md` D-8): `BID_EXTENSION` = 67 minutes,
   applied as `max()`, so a bid inside the last 67 minutes pushes the close out to a full
   67 minutes of quiet and an earlier bid changes nothing. A hard close is a last-block
   sniping game; Fragment-style extension is what the TON audience expects. **67 is prime,
   and the choice is deliberate.** There is no cap on total extensions, because a cap hands
   the last bidder before it exactly the sniping win the rule exists to remove — and since
   D-45 no head arrival can truncate a lot, so an extended lot costs the game's liveness
   nothing.

   **Liveness: the head is never gated, and never reaches an auctioned number.** The ledger
   marks `n` off its sequential line the moment `open_lot` runs and the head-advance walk
   skips it forever (D-45); the lot runs its own clock wherever the head is. **A run of
   auctioned numbers cannot stop the walk either (D-189):** the walk is gas-bounded, so a
   long run parks the head mid-walk (`getWalkPending`), head mints refund as a lost race
   until it finishes, and the permissionless, caller-funded `advance_head` walks it on —
   landing on exactly the head an unbounded walk would have.

   **Where a far lot's mark lives (`DECISIONS.md` D-196).** A lot may open on any number,
   however far ahead, and its mark is permanent — so a mark kept on a shared contract is a
   word the OPENER chooses, and ~30,000 isolated far lots would fill the ledger's 65,536-cell
   account cap. So the ledger keeps marks only for the 256-number blocks below its **import
   frontier**, which starts `W` numbers past the head (`W` = `shared/params.json`
   `off_head.import_window`, 26 blocks, sized by the sim against a day of keeper downtime at
   the fastest head the base run produced). A mark beyond the frontier — a lot's claim on
   `n`, either kind, or a prime sold ahead — lives on that block's **lot block**, a child
   contract at an address derived from (ledger, block), deployed by the ledger on the first
   mark. The permissionless, caller-funded `import_lot_block` (0.05 GRAM) pulls the next block
   in once it starts below `head + W`: the lot block hands its words over and keeps them, so a call while an import is in flight re-sends it and an answer the ledger failed to process is never lost.
   **The head-advance walk stops at the frontier** exactly as it stops at its gas bound — head
   mints refund until someone imports and calls `advance_head` — so a late import stalls the
   head and can never let it mint a claimed number. What any lot, near or far, adds to the
   ledger is bounded by the head: `⌈(head + W)/256⌉` words.

   **One claim record, on the ledger side.** Every open ahead of the head — either kind — sends
   `mark_off_head`, and the ledger (or the lot block) refuses a number already claimed; the
   refusal cancels the lot and refunds its bid less `REJECT_GAS`. At or behind the head only
   an **unsold** prime may be listed, so a prime sold ahead is refused its descending lot once
   the head passes it. The market keeps its sold bit only **behind its `headHint`**, so the
   buyer of a far lot chooses no word there either.

   ---

   **The winner still pays a normal 1 GRAM mint, on both lanes.** The clearing price `C`
   decomposes identically wherever it came from:

   ```
   C  =  1 GRAM (splits per §4.1)  +  RES_GAS 0.070  +  premium
   ```

   ~~On lane B the 1 GRAM is held as escrow on the shard and splits at settlement~~ —
   **VOID (`DECISIONS.md` D-90): both lanes split immediately, because on both the mint
   happens in the transaction that closes the lot.** Routing the
   whole clearing price through a variable mint price instead was rejected, and the reason
   is worth keeping: it would mean **the tribute line and the referral line receive
   nothing on precisely the highest-value acquisitions in the game**. A
   recruiter who brought the buyer of 1111 would be paid zero, which is against §2's
   *recruitment pays only on the recruit's own spend* in letter and badly against it in
   spirit. Keeping the 1 GRAM leg intact also keeps three claims literally true that a
   variable mint price would break at once: §2 principle 7, §4.1's closed 100%, and the sim
   cross-check. A lane-B settlement runs at **`k = k_min`** exactly as point 3 requires of
   every reservation; a prime runs at **`k = 0`** (§5.1) on either lane — a bought-forward
   number must not also camp the `k(t)` curve.

   **The premium is injected at close, not at settlement**, as `k = 0` money in §5.1's
   exact sense: `S` is untouched, and — since `DECISIONS.md` D-114 amended D-7 (2026-09-10)
   — the premium splits 50/50 between the ratchet and the governed treasury, so `T` rises
   by half the premium, not the full amount. ~~It is **100% ratchet with no treasury cut**
   (`DECISIONS.md` D-7) — the treasury is already paid its 5% out of the 1 GRAM leg, and a
   cut here would put trophy-number money on the team's fee lines against *team takes fees,
   never supply*.~~ D-114 records why this is now signed anyway: the treasury stopped being
   a team wallet at D-100 and spends only by a passed LP-depositor proposal. §5 carries the
   reasons the timing matters; point 4 carries what it means for cancellation.

   **What is declared and what is derived.** `D_MIN`, `SCORE_HALVING`, `PRIME_P0_MIN`,
   `AUCTION_WINDOW`, `BID_EXTENSION`, `MIN_AUCTION_DISTANCE`, `PRIME_DUTCH_SECONDS` and
   this lane's `MIN_INCREMENT` are **declared**: `"_provenance": "declared"` in
   `shared/params.json`, each with the stated constraint above, owned by the owner and not
   dressed as a simulation output — a simulation of tribute flows cannot produce a
   message-spam bound or a snipe window. `NPV(p)` is **derived**
   (`sim/scripts/run_phase1.py`, published as `tribute.prime_tribute_npv`), extended
   analytically past the six reference entries and shipped as a dictionary over primes up
   to a stated bound, with the pattern ladder as the fallback beyond it.
   `PRIME_P0_MULTIPLE = 1.5` is §6's calibration rule reused, and `RESERVE_FLOOR` is the
   asserted identity above. The desirability weights are **being promoted from taste to a
   simulation output** and are open in §11.25 until that lands; both lanes' opening prices
   inherit whatever they currently produce in the meantime.

   **One contract, zero admin surface.** Both lot modes run on `primes_market.tolk`, which
   since `DECISIONS.md` D-90 is the *only* market contract — the escrow shard it used to
   route to is deleted. There is no owner field, no cancel, no reprice, no address setter
   and no withdraw path; `open_lot`, `open_head_lot`, `bid`, `close` and
   `retry_premium_forward` are all permissionless (`reserve`, `cancel`, `settle` and
   `release` were on this list until D-30, D-32 and D-90 deleted them), and the only
   authenticated inbound message comes from the genesis-fixed ledger address. **D-20 removed the last one-shot admin message on the contract**
   (`bootstrap_genesis`, which seeded the K-lot), so the zero-admin claim is now literal
   rather than nearly literal, and it is asserted by a test rather than by convention. The
   merge also deleted an entire cross-contract authentication surface: `trophyAuctionAddr`,
   `trophyLinked`, error 508, `set_trophy_auction` and `trophy_reserve` are gone rather
   than moved, because the two lanes being one contract makes that hop an
   internal function call (`docs/audit/unified-market-layout.md` §1.1).
3. **A lot won ahead of the head settles at k = k_min.** The buyer trades rebate size for
   certainty of getting `n`. This closes every clock-gaming angle: the purchase cannot camp
   on the k(t) curve, and the ratchet gets the *strongest* possible step from every such
   mint. The 1 GRAM leg splits exactly as §4.1, and since D-90 that happens in the closing
   transaction rather than at a later `settle(n)`. (Primes settle at `k = 0`, not `k_min`
   — §5.1, and `primes_ledger.tolk` asserts it.)
Consequences:

- **The order book is public** — ~~`get_reservations()` exposes escrowed forward demand,
  and `get_escrow_aggregate()` publishes the pool-wide totals~~ **VOID: `DECISIONS.md` D-90
  deleted the escrow shard, the escrowed claim and all three get-methods over them.** There
  is no escrowed forward demand to publish because there is no escrow: a won lot mints in
  the transaction that closes it. What is public instead is the **open lots themselves** —
  `getLot(n)`, `getLotPrice(n)` and `getLotFloor(n)` per lot — which is a demand signal of
  the same kind and a stronger one, because a standing high bid is money already committed
  to a specific number rather than a refundable balance. §9.1 is satisfied by those three
  reads; nothing on any surface may show a pool-wide "GRAM escrowed" figure, because there is
  no longer a get-method behind it and no longer a pool for it to describe.
- ~~**Escrowed GRAM is honest backing-in-waiting.** It joins `T` only at settlement (a
  reservation can be cancelled; committed means committed)~~ **— VOID with the escrow
  (D-90); a lot's clearing price joins `T` at close, in one transaction.** The dashboard can show
  the reserved wall marching toward the head.
- **Whale runs are self-defeating.** Taking a block of numbers ahead of the head costs a
  winning bid per number — at least `LOT_FLOOR`, and the auction's own clearing price above
  that — forfeits the k(t) rebate upside, and every settlement ratchets the floor at
  maximum strength. A hostile "buy the whole line" is indistinguishable from enthusiastic
  prepayment, and since D-90 it is also indistinguishable from ordinary buying: the numbers
  mint immediately rather than sitting as claims.
- **The ascending lane is the pressure valve for head contention** (§7): when many
  players want the *same* upcoming composite, the auction resolves the race by price
  instead of by block racing. ~~the book resolves the race by escrow priority~~ — there is
  no book and no escrow priority (D-30, D-90). On primes there is no race to resolve — a
  prime is never at the head, and its lot is a standing price anyone may take (§6 point 1).

~~**Special-numbers carve-out (§9.6, `DECISIONS.md` D-47).**~~ **VOID — `DECISIONS.md`
D-88 point 2 deleted the carve-out rather than narrowing it.** There is no second route and
no special-only lane: a special number takes the same two lanes as every other number —
ascending ahead of the head, descending (prime) or the flat 1 GRAM mint (composite) at its
turn — with `p0` and the resting price set by its own score `D(n)` and nothing else changed
(~~lifted to its tier's figures~~ — D-99 deletes the tiers; §9.6).
**Specialness is price, not mechanism**, so D-30/D-31's one-route rule now holds
with no exception category at all. The old text, for the record: special numbers got a
*second* route (a rarity-tied 7-day advance ascending auction) and special composites a
1-day decaying route down to 1 GRAM, both deleted with `open_head_lot_composite`,
`MODE_DUTCH_BUYNOW_SPECIAL` and `MODE_DUTCH_BUYNOW_SPECIAL_COMPOSITE`.

### 4.5 Gift mints

Any mint or lot bid may name a **beneficiary** distinct from the payer (the reservation
book this once said is gone — D-30). The routing
rule (borrowed from the one referral-scheme pattern worth keeping, with the economics
inverted): **the payer's referral key earns the commission; the beneficiary receives the
NFT and the rebate.** Gifting is a genuine gift — the gifter keeps only their ordinary
referral discount, the recipient gets the asset and the PRIMES.

"I bought you prime 1009" / "I won 2026 at auction for your graduation" is the shareable
moment: numbers carry personal meaning, and a gifted number arrives with visible on-chain
provenance and its own cash-flow rights (referral key, and tribute if prime). Gift mints
are the organic-invite loop; §9's quests measure and reward them.

**A lot won on someone else's behalf delivers, but it is not a gift in §4.6's sense.** A
bid on an auction lot (§4.4, either mode) may name a beneficiary, and winning mints the
number straight to them. But the market does not forward the winner to the ledger on
either settlement path (`mint_won_lot`, `settle_prime_clearing`), so the ledger mints with
`payer == beneficiary`: the win credits the bidder **no recruit** and opens **no newcomer
window** for the recipient. Only a direct mint that names a beneficiary is a recruit edge.
The rule can only under-count recruits, never over-count them, which is the safe direction
for §8.1's sybil argument (`primes_ledger.tolk`, `executeMint`'s `payer` field).

**A gift to a wallet the game has already seen credits no recruit, and the checkout says so
before the signature.** The recruit edge needs the beneficiary's minter card to be fresh
(`getCardOwner().seen == false`, or no card at all): a wallet that has minted, been gifted
or bought a prime is not. The mint still lands; it just earns the payer nothing on §4.7's
ladder. The read-proxy publishes the flag as `fresh` on `GET /ranks/:address`, and the
mint checkout warns when a named beneficiary reads `false`.

### 4.6 Invites: the gift mint as the growth loop

> **STATUS: THE PATRON MECHANIC IS RETIRED (`DECISIONS.md` D-106, 2026-09-07).** This
> section used to describe **patron mode**: a composite minted into an *unclaimed* state
> with the payer written on as its Patron, a claim lock, a GRAM purse released on the
> recruit's first mint, a reclaim right at the next primorial boundary, and a §4.1 **patron
> line** paying the Patron 25% of the recruit's activation mint and 7.5% of every mint
> after, to a cumulative `PATRON_CAP` of 1.00 GRAM.
>
> **It never shipped to a player, and it never could have paid.** Two facts settle it:
>
> 1. `webapp/src/chain/messages.ts` wrote `storeMaybeRef(null)` into the `Mint` body
>    unconditionally. Every mint the app ever sent declared "not a patron mint". No wallet
>    could reach the mechanic, so there is no player investment to protect and no live
>    data to preserve.
> 2. `sim/primes_sim/kill_criteria.py` reported **FAIL** against the published cost basis
>    for its entire life, and §4.6.2 (now deleted) carried both halves of that verdict
>    rather than the flattering one. The root cause is D-57's: `PATRON_CAP` was a **fixed
>    nominal 1.00 GRAM** measured against a cost basis that *rises* as `k_max(n)` decays,
>    so the payoff inverted at **n ≈ 1173** — a third of the way through the first decade
>    of the number line. Every proposed fix spent something real: denominating the cap in
>    cost basis destroyed the exact-refund framing §11.4's ToS argument rested on, and a
>    sixth uplift term spent §5.1's `PRIME_UPLIFT · PRIME_WINDOW < k_max(n)` headroom to
>    paper over a GRAM-vs-cost-basis mismatch.
>
> D-106 deletes it rather than re-basing the criterion to the number that passes. What
> follows is what the repo actually has.

Everything in §4.1–§4.5 converts GRAM into pool depth and hands the payer an asset. The
growth question is what brings in a wallet that has never heard of the game, and the
answer is the one that was already shipped and already reachable: **§4.5's gift mint.**

**The mechanic, in full.** A mint names a `beneficiary` other than the payer. The 1 GRAM
splits exactly as §4.1 — same tribute, same referral, same treasury, same gas, same
injection, same ratchet step; **the split has no line for this and never had one after
D-106**. What changes is delivery and one boolean:

1. The NFT is minted **straight to the beneficiary's address**, inside the mint
   transaction. It is theirs outright from block one — full ownership, transferable, with
   every referral right an ordinary mint carries. There is no unclaimed state, no claim,
   no lock, no purse, no expiry and no reclaim.
2. The PRIMES rebate follows the beneficiary too, exactly as §4.5 already promised. The
   payer keeps their own referral commission and nothing else.
3. **The recruit edge.** If the beneficiary's **minter card** is FRESH — no accepted event
   has ever touched it — the payer is credited with **one recruit** and the beneficiary's
   **newcomer window** is opened. While that edge is unresolved (up to five minutes, or until
   its refusal comes back), the card refuses every other gift, so a race the edge loses can
   never let a second gift through as a non-recruit — and the beneficiary's own mints in
   that interval are priced **without** the window and spend none of it, so a gift built
   to fail cannot lend a fresh wallet the raised ceiling before refunding itself.

**The minter card (`DECISIONS.md` D-191 point 1).** A wallet's whole rebate standing —
prime rank, the §5.1 prime window, the newcomer window, lifetime recruits and the era tally —
lives on its own child contract, `primes_minter_card.tolk`, at an address derived from the
ledger and the wallet. It used to be two dictionaries on the ledger, one row per wallet,
which would have filled config 43's 65,536-cell account cap at roughly 20–30k players
(§3.2.1's wall, reached by a different road); nothing on the ledger grows with the number
of wallets now. **A mint reaches the ledger through the BENEFICIARY's card**: the payer sends
it there (a self-mint to their own card, a gift to the recipient's), the first mint a wallet
is part of deploys the card, and the card forwards the mint with the standing it is priced
off. The ledger trusts the card because it re-derives the card's address, prices `k` off the
attached standing exactly as it priced it off its own row before, and never writes it back:
the card has already spent the mint's window units itself (every accepted head mint is a
clocked composite, so the rule needs nothing the card does not know), and a refused mint —
a lost race refunded through the card, or a throw bounced to it — gives them back. The card
handles one message at a time, so two mints in flight for one wallet each see the other's
spend: a window with one unit left uplifts exactly one of them.

**"Never seen" means "the card is fresh": no mint for that wallet, no prime bought for it
and no recruit credited to it has ever been accepted.** That is "never played", not the
narrower rule this section had before D-191 — "has no ledger row", under which a wallet
that had only ever minted composites with no window counted as new, because a row per
minting wallet would have filled the account. With the standing off the ledger that
compromise is gone: a wallet that has minted is not a newcomer, which is also what the
§4.6 invite list already assumed. A gift mint that is refused (a lost race) leaves a fresh
card fresh, so the next gift to it still counts — **but only if every mint sent to the card since
it was fresh came back refused** (D-195). The ledger reports refusals and never acceptances, so the
card counts what is in flight; one accepted mint in between keeps the card seen for good, and the
refused gift's newcomer window closes. A refused gift can therefore never re-open the window or
let a wallet that has minted count as a recruit. The one thing it can do is uplift the owner's own
mints sent before its refund returns, once per wallet — never more than the five units a real gift
would open, and it forfeits the recruit credit a real gift earns.

**`fresh` is the whole sybil guard, and it costs nothing.** The card reads its own flag
before it forwards the mint and sets it as it does; the ledger reads it off the message it
already authenticated. Gifting the same wallet twice counts once, which means a recruit
costs a **fresh address plus a full 1 GRAM mint** — the same price §8.1 always argued a fake
recruit had to pay, now charged by a single comparison instead of by a dictionary of patron
records, a claim lifecycle and four message types. **Net of §4.1's invite line it is 0.70
GRAM** (`DECISIONS.md` D-202 amends D-106 here): the gift mint may name the gifter's own
wallets as its three invitees and take the 0.30 back. §12 carries that as a named risk.

**The credit is one hop later, and that is harmless.** On a recruit edge the ledger sends
+1 to the PAYER's card (deploying it if absent), which replies with its era tally so the
ledger can keep the running maximum §4.7's trophy needs. The recruit uplift applies to the
payer's *future* mints, so the hop changes no rebate. The one race is at a ceremony: a gift
that mints the era's primorial, or whose card's reply lands after the ceremony, counts in the
era it was made in, and that era's trophy has already been awarded — so the late reply is
dropped rather than moved into the next era. The recruit still counts on the payer's
lifetime rank.

**The hop costs the gas & ops line, and it fits.** The card's compute and its forward come
out of the mint's own 1 GRAM (the ledger accepts up to `CARD_HOP_ALLOWANCE` short of the
price, and refuses a body padded to make the forward dearer), and the recruit credit is a
ledger send. Measured on the heaviest mint the ledger can perform (ω = 12, every leg, a
recruit edge): 0.1913 GRAM of the 0.20 line, from 0.1882 before (`GasRegression.spec.ts`,
`shared/params.json` `fees.gas_ops_line`).

**What a recruit is worth: `k_max` uplift, and nothing else.** Each recruit moves the
payer up §4.7's ladder, which raises the rebate ceiling on **the recruiter's own future
mints**, under the same single `K_CEIL = 0.95` clamp as every other uplift (§5). Three
consequences, and they are why this cannot repeat D-57's failure:

- **There is no payer to be underwater.** The old mechanic asked a Patron to spend 1 GRAM
  now against an annuity that might arrive later; the arithmetic could invert, and did. A
  gift mint delivers a number the giver was willing to buy, at the price they were willing
  to pay, and the ladder is on top. There is no bet to lose.
- **There is no cost basis to drift against.** A ceiling is a fraction, not an amount. It
  cannot be a fixed nominal figure measured against a rising cost, because it is not a
  figure and it is not measured against anything.
- **It cannot drain the pool or break the theorem.** A tier is not a split line. Every
  uplift a wallet holds — prime rank, recruit rank, both windows —
  enters ONE sum bounded by ONE clamp, so no stack of tiers can push `k` to or past 1.

**The recruit gets paid too, in rebate rather than GRAM.** A wallet's first five mints
after receiving its first gifted number run at a raised rebate ceiling —
`k_max + NEWCOMER_UPLIFT`, under the same hard `K_CEIL` clamp. This costs no split line
and moves no GRAM: it is emission inside the bound the ratchet theorem already requires,
spent on the one variable the whole loop depends on — whether a gifted wallet ever mints
one of its own. The window is opened by the recruit edge and spent one unit per clocked
mint; the gift mint that creates it neither consumes a unit nor collects the uplift, so
all five belong to the recruit.

**The recruiting message is shorter than it was, and every clause is still a get-method
away from being checked** —

> **5,764 is yours.** I minted it for you; it is already in your wallet, there is nothing
> to claim and no deadline to miss. Your first five mints of your own run at a raised
> rebate ceiling.

— which is the same standard the old §4.6 message was held to, over the three promises the
contract can still keep. The purse ("0.3 GRAM released when you mint"), the lock ("nobody
else can take it") and the deadline ("it comes back to me at the boundary") are gone with
the unclaimed state that made them true, and any gift message the app composes may not
offer them (§9.1).

**Liveness is unaffected.** A gift mint consumes the head exactly like a normal mint — it
IS a normal mint with a different delivery address — so the sequence advances normally and
nothing about it can stall the line. It is not restricted to composites: §4.6's
composites-only rule existed because an *unclaimed prime* could not be allowed to exist,
and no item is unclaimed any more.

#### 4.6.1 The rejected version, and what the invite line keeps of it

The natural first design is: minting a composite sends the NFT to a **randomly selected
active TON wallet** that has never touched the collection. It is rejected on three
independent grounds, any one of which is fatal. §4.1's invite line sends strangers
something too, so the end of this section says which of the three still apply to it.

- **TVM cannot do it without an oracle.** The VM cannot enumerate accounts, cannot query
  an address's transaction history, and cannot test "holds zero of my collection" for an
  address it has never seen. Selection would require an operator feeding eligible
  addresses on-chain, and `random()` seeds from a block randseed that validators
  influence. §8's promise of *no admin surface* is the project's single most audited
  claim; an address-feeding oracle in the mint path is the first thing a hostile reader
  would find, and they would be right.
- **Unsolicited NFTs are drainer spam.** TON wallets are saturated with pushed NFTs
  advertising off-site claims, wallets hide unknown collections by default, and observed
  activation on cold drops is a fraction of a percent. The mechanic would spend 1 GRAM per
  near-zero-conversion impression *and* make the collection look like the thing it is
  competing against.
- **Push gives the payer no reason to aim well.** A random recipient is not the giver's
  problem, so the payer optimizes nothing. Under a §4.5 gift the payer's recruit tier
  depends on aiming it at a real address the ledger has never seen, which makes finding a
  real interested human the payer's own interest. The protocol does not have to
  identify good users; it has to make its players want to.

The §4.5 gift mint gets the intended effect — a stranger ends up holding a number they did
not pay for — with no oracle, no randomness, no spam, and a self-interested distributor.
*(This argument was first written for patron mode's pull-claiming; `DECISIONS.md` D-106
deleted patron mode, its annuity and its claim step, and the argument carries over to the
gift mint unchanged.)*

**The invite line is the rejected design's shape at a tenth of the price** — 0.1 GRAM and a
line of text to an address that has never played — so each objection is checked against it
(`DECISIONS.md` D-202):

- **The oracle objection does not apply, because the minter chooses.** The contract selects
  nobody and trusts no list: the addresses arrive in the minter's own mint message, exactly
  as a beneficiary does, and nobody signs them. The keeper's Telegram-first default list
  (§4.1) is text the app pre-fills and the minter may overwrite; the ledger cannot tell it
  from an address typed by hand. Under D-101 the operator signed the list, which was this
  oracle in a narrow form, and §8 carried it as a trust edge; D-202 deleted both.
- **The spam objection becomes an accepted risk.** A transfer nobody asked for is
  unsolicited however small it is, and some recipients will read it as spam. What bounds it:
  the comment is fixed in the ledger's code, names `primes.live` and nothing else, and asks
  for nothing — no claim, no off-site signature, nothing a drainer needs — and a plain
  transfer's comment shows as text in Telegram's wallet, where an unknown NFT collection is
  hidden. The owner accepted the rest (D-202), and §12 names it.
- **The aim objection is answered by the referral key.** The comment carries the minter's
  own `n` as `?ref=<n>_tg`, so §4.1's 10% referral line pays the minter when an invitee
  mints, and aiming at a real person is the minter's own interest. A minter who aims at
  their own wallets instead gets 0.30 GRAM back and no invitee (§4.1, §12).

#### 4.6.2 (deleted)

This section priced the patron mint against an ordinary one —
`a · (φ₁ + φ₂ · min(M − 1, 10)) + V > 0.415 GRAM` — and reported the answer as a **FAIL**
at the published cost basis. D-106 deleted the mechanic it was the kill criterion for.
Nothing replaces the inequality, because nothing replaced the payment: the recruit ladder
pays `k_max` uplift, which has no payer, no expectation and no breakeven. What bounds it
is §5's single `K_CEIL` clamp, and `rebate.uplift_stacking` in `shared/params.json`
measures that with every ladder maxed at once.

### 4.7 Ranks: the only unbounded reward currency

There is a hard ceiling on how good a mint can be made to feel in PRIMES. The ratchet
theorem (§5) rests on `k < 1`: the moment a 1 GRAM mint returns 1 GRAM of floor-value, the
floor stops rising and the entire pitch collapses. Emission is therefore not available as
a growth lever — **the protocol cannot buy loyalty with PRIMES without unbuying its own
central claim.** Rights and status carry no such constraint: they cost no supply, move no
GRAM, and cannot run the ratchet backwards. So that is where the reward budget lives.

**Rank is the count of recruits** — addresses this wallet introduced with a §4.5 gift
mint, counted once each on the recruit edge (§4.6). Never drops, never claims, never
wallets touched (principle 6). Two counters:
*lifetime* rank, monotone, which sets standing rights; and *era* recruits, reset at every
primorial boundary (§7), which decide the era trophy. *(The era counter used to set the era
dividend as well; that mechanic is dropped — `DECISIONS.md` D-36 — but the counter is
retained, because the trophy still needs to know who won the season.)* Both are read off
the wallet's **minter card** (§4.6, D-191; the ledger's `getMinterCardAddress(wallet)` names
it, and a never-deployed card reads zero): the lifetime count is `getRecruitRank()`'s
`recruits`, the era count is `getEraRecruits()`'s tally, which counts for this era only while
the seq it was taken under equals the third value of the ledger's `getEraLeader()` — so it
reads 0 for everyone after each primorial ceremony and 0 for a wallet that has not recruited
this era. The running maximum and its holder stay on the ledger (`getEraLeader()`).

Tiers (`shared/params.json` `rebate.recruit_rank_tiers`):

| rank | recruits |
|---|---:|
| I | 1 |
| II | 3 |
| III | 10 |
| IV | 30 |
| V | 100 |

What rank buys, none of it denominated in PRIMES:

- **A higher rebate ceiling.** Rank raises `k_max` on the recruiter's own mints, hard-clamped
  in the contract at `K_CEIL = 0.95 < 1`. This is the most directly felt reward available
  and it is *still* inside the theorem — the clamp is the load-bearing line and belongs in
  the source next to the ratchet comment, since a reader will check exactly this.
  The wallet's minter card's `getUpliftLine()` itemises it: the four legs — prime rank,
  prime window (`PRIME_UPLIFT` while the window is open), newcomer (`NEWCOMER_UPLIFT` while
  the window is open), recruit rank — and their sum; the ledger's `getKMaxFor(n, sum)`
  returns the clamped ceiling and a flag that is 1 when `k_max(n)` plus that sum exceeds
  `K_CEIL`, i.e. when the clamp is eating part of what the ladders granted.
- ~~**A tribute multiplier** on primes the Patron owns, reusing the §3.2.2 constellation
  machinery.~~ **DELETED 2026-08-28 (`DECISIONS.md` D-54), and the reason has since got
  stronger, not weaker.** No code path wired this even when the machinery existed, and
  after `DECISIONS.md` D-102 there is no machinery: the ledger's tribute-weighting pass
  has **no multiplier of any kind** — `w(p) = e·√p` is the whole of the divisor weighting
  (§3.2) — so a rank-keyed multiplier would now be a new mechanic rather than a reuse of
  one, with its own crowding check to run from scratch. There is no rank read anywhere in
  that computation and no cross-contract hop from the registrar (which holds rank) into
  it. Rank's shipped
  rewards are the `k_max` uplift and the era trophy — it does not multiply
  tribute, and it never did.
- ~~**Naming rights.** A rank-III recruiter may attach a permanent on-chain annotation to a
  number they gave away.~~ **DELETED 2026-09-25 (`DECISIONS.md` D-187).** Never built: no
  contract records which
  numbers a wallet gifted, so the rank-III check had nothing to read.
- ~~**A waived `RES_PRIORITY_BASE`** (§4.4).~~ **DELETED 2026-08-19 (`DECISIONS.md` D-37,
  D-30).** This promised rank holders a waived discretionary reservation fee. It was
  never implemented — `primes_market.tolk` charged the constant unconditionally at every
  entry point with no rank lookup anywhere, and honouring it would have required either an
  async round-trip to the registrar (which holds rank state, on a different contract) or
  mirroring rank onto the market's hot path, to deliver a prize CONCEPT itself priced at
  0.01 GRAM. **D-30 then removed the fee entirely** by deleting the flat-fee reservation
  lane, so the clause no longer has a referent to correct. Rank's rewards are the `k_max`
  uplift and the era trophy (the tribute multiplier bullet above it is
  itself struck, D-54) — it does not discount the cost of acquiring a number, and it never
  did.
- ~~**The era dividend.**~~ **DROPPED 2026-08-19 (`DECISIONS.md` D-36).** This would have
  split a slice of each era bounty across recruiters pro-rata to recruits activated within
  that era. It was never implemented — no `ERA_DIV_CAP` exists in `contracts/` or
  `params.json`, no era-scoped recruit counter, no payout path — and it needed a Phase 1
  sim output that was never run. It is dropped rather than deferred because §8.1 names it
  as the one recruitment reward that could make a sybil pair profitable at a market
  premium, precisely because it sat outside the then-live `PATRON_CAP`; dropping it removes that risk
  surface instead of capping it. **The era bounty continues to pay 100% to the primorial's
  minter**, which is what the shipped code already does. The recruitment *season* survives
  through the era trophy below — a prize, not a payout.
- **The era trophy: naming the primorial itself.** The single highest recruiter of an era
  receives permanent naming rights on **that era's primorial number** — 6, 30, 210, 2310,
  30030, 510510, 9699690, 223092870. There will only ever be eight of these and they are the most conspicuous
  numbers in the collection: the only way to *earn* the pen on 30030 is to have brought
  more real players into the game than anyone else while that era was open. **They are
  transferable (§11.13, closed 2026-08-16)**, so a trophy can be bought on the secondary
  market from whoever won it — what cannot be bought is the issuance. The earlier claim
  that "no amount of GRAM can buy one" is withdrawn with that closure, and the trade it
  bought is stated in §11.13: a real market and a headline sale, against a prize that is
  no longer unbuyable. It costs the protocol nothing, it converts the recruiter leaderboard
  from a chart into a contest with a prize, and it is the reason to keep watching the
  countdown rather than merely to have watched it. **Its first engraving is the one free
  naming in the game** (`DECISIONS.md` D-179): the holder strikes it through the
  registrar's `annotate`. A re-engraving costs the rename fee, `renameFee` (200 GRAM), paid
  to the ratchet floor (`DECISIONS.md` D-212), and every refusal refunds. The engraving is
  the trophy's, not the number's: the primorial's own item is named by whoever owns it,
  like any number (§4.7.1).

This is also where the rank ladder answers the objection that §4.6.2's arithmetic is
tight. A rank-V recruiter with a `K_CEIL` rebate ceiling and a name on a primorial is playing
a materially different game from a rank-0 wallet — and every one of those rights was paid
for in recruits, none of it in PRIMES, none of it out of anyone else's line (the tribute
multiplier and reservation-lane priority this sentence used to also list are both struck
elsewhere in this section — D-54, D-37/D-30). It used to also be `V`, the rank term in
§4.6.2's breakeven; D-106 deleted that inequality with the payment it priced, so what is
left is simply the reward itself.

**Two products, one line.** The result is that the same 1 GRAM buys either of two
genuinely different things, and the game is better for the tension:

| | ordinary mint | gift mint (§4.5) |
|---|---|---|
| the number | kept — referral key, tribute if prime | delivered to the beneficiary, owned outright |
| PRIMES rebate | yours | theirs |
| referral commission | yours | yours — the payer keeps their own key's 10% |
| paid in GRAM for recruiting | none | **none** |
| rank | none | +1 recruit, if the ledger has never seen that address |
| what the recruit gets | — | the number, plus five raised-ceiling mints |
| you are buying | an asset | a player |

**`DECISIONS.md` D-106 rewrote two rows of that table and they are the two that matter.**
The gift mint used to be the *patron* mint: the number went to an unclaimed pool locked to
a chosen recipient, the rebate stayed with the payer, and an **annuity** row read "25% of
the activation mint, then 7.5%, to a 1.00 GRAM cap" with a best case of "the gift was free,
and you have a player". Nothing pays GRAM for recruiting now. What a recruiter buys is a
tier on a ladder that raises the ceiling on **their own** future mints — which is why the
best-case row is gone rather than reworded: there is no bet, so there is no best case.

### 4.7.1 Prime rank: the same currency, earned from the number line

Removing the prime rebate (§5.1) removes the only reward a prime minter used to receive in
PRIMES, so it has to be replaced from the one budget that is not capped by the ratchet —
the same budget §4.7 just established. **Rights, not tokens**, for the same reason and
under the same clamp.

Prime rank is a second, independent counter: **the number of primes a wallet has minted**
(the wallet's minter card's `getMinterState()`, the one copy — `DECISIONS.md` D-188 point 6
deleted the registrar's mirror and D-191 moved it off the ledger), lifetime, monotone, alongside an era counter that resets at each primorial boundary (§7)
exactly as recruit rank does. It is not interchangeable with recruit rank and neither ladder
feeds the other; a wallet simply has two standings.

| rank | primes minted |
|---|---:|
| I | 1 |
| II | 3 |
| III | 10 |
| IV | 30 |
| V | 100 |

What prime rank buys — none of it denominated in PRIMES, all of it reusing machinery that
already exists:

- **The pen on every number you own** (`DECISIONS.md` D-212, superseding D-179). Any
  current owner of a minted number — prime or composite — may name it, and the name is
  on-chain: *"1009 is named."* **The first naming of a number costs `nameFee`, about
  50 EUR in GRAM** (chosen from the GRAM/EUR rate on genesis day — a contract cannot read EUR
  — and fixed in the collection's deploy data); **every later naming costs `renameFee`,
  200 GRAM**, whoever owns it by then. Both are GRAM, both are published by the collection's
  `getNaming()`, and both go to the **ratchet floor**: the owner sends `name_number` to the
  collection, item(n) checks the sender is its owner and which fee applies, and the fee
  reaches the ledger as `royalty_to_ratchet` — `T` rises by exactly the fee and `S` does not
  (§5), so every naming lifts the floor for every holder. Every refusal (not the owner,
  underpaid, never minted, a text over one cell) refunds the whole payment. **The pen
  follows the NFT**: the item stores no namer, `getNamer()` is the current owner, so a buyer
  names and the seller cannot; who wrote the standing text is in the transaction history.
  The name and its count live on the number's own item (`getAnnotation()`, `DECISIONS.md`
  D-188 point 6), so naming cannot fill any shared contract. The only free naming is an era
  trophy's first engraving (§4.7). *(Until D-212 only a prime's finder held this pen, for
  ever, and paid in burned PRIMES through a §5.2 sink; both are gone.)*
- **A permanent `k_max` uplift** on the holder's own composite mints, additive with every
  other uplift and clamped with them at `K_CEIL` (§5).
- ~~**A tribute multiplier** on primes the wallet owns, reusing §3.2.2's constellation
  weighting.~~ **DELETED 2026-08-28 (`DECISIONS.md` D-54)**, for the same reason as §4.7's
  identical clause: no code path wires a rank-keyed multiplier into the ledger's tribute
  pass, which since `DECISIONS.md` D-102 carries no multiplier at all.
- ~~**A waived `RES_PRIORITY_BASE`** (§4.4).~~ **DELETED 2026-08-19 (`DECISIONS.md` D-37,
  D-30)**, for the same reasons as §4.7's identical clause: never implemented, and the fee
  it waived no longer exists. Should a rank-ordered tie-break ever be introduced, the
  recorded ordering remains **prime rank first, recruit rank breaking ties within it** —
  but nothing is built and no storage carries it (`DECISIONS.md` D-15, amended).
- ~~**The era finder's board.** Primes minted within an era are a leaderboard next to the
  recruiter one, and the era's top finder shares the ceremony (§7). Eight primorials, two
  trophies each.~~ **DELETED 2026-09-25 (`DECISIONS.md` D-187).** Never built, and it
  contradicted §7, which awards one trophy per era, to the top recruiter. The ledger keeps
  only a lifetime `primesMinted`, and the prime-finders board ranks that. There is no
  per-era prime counter and no finder trophy.

**Why a separate ladder rather than one merged score.** Recruit rank measures recruitment;
prime rank measures participation in the part of the game that is expensive, unglamorous
and structurally under-rewarded. Merging them would let a recruiter buy prime-minter
standing and vice versa, which destroys the information in both.

**Personal bests: a mark to beat, beside two ladders that only count** (`DESIGN.md` U153).
Both ladders are lifetime totals — participation, never improvement. `/me` therefore also
shows a wallet two maxima of its own: the **largest prime** minted to it and the **widest
factorization** it minted (the composite with the most distinct prime factors ω, out of the
ledger's `OMEGA_MAX` = 12 entries per mint). (A third, the most contributors on a
constellation it built, went with constellations, `DECISIONS.md` D-202.) They buy nothing,
touch no contract and are no new chain fact: each is a maximum the read index takes over
indexed mints at read time, attributed at mint time, and drawn as derived (§9.1 as
amended by D-24) — the item named under each is where a reader re-checks it.

## 5. Tokenomics: the ratchet theorem

This is the heart of the project and the answer to "how does it work?".

**Definitions.** Let each mint pay P = 1 GRAM, of which the residual β·P reaches the pool
after every deduction in §4.1. β is not a chosen constant but the residual, and since
`DECISIONS.md` D-106 deleted the patron line it ranges over `[0.25, 0.75]`:

```
β = 1 − 0.05 (treasury) − 0.20 (gas & ops, D-117)
      − 0.10 · 1{n is composite}        // tribute: no recipient on a prime (§4.1)
      − 0.10 · 1{valid referral key}
      − count × (value + 0.001)         // §4.1's invite line (D-202, D-215), ≤ 0.31
```

**0.55 is the planning number for composites and 0.65 for primes** — both assume the
expected case of a valid self-referral and no invite fan-out. The extremes are 0.247 (a
referred composite sending all three genesis invite transfers; 0.24 is the floor under any
operator terms, D-215) and 0.75 (an unreferred prime sending none).
D-106 raised the lower extreme from 0.40, which was a recruit's activation mint, to 0.525;
`DECISIONS.md` D-117's derived 20% gas & ops line (10% before it) took ten points off every
value in this paragraph, so 0.65/0.75/0.525/0.85 became 0.55/0.65/0.425/0.75; and
`DECISIONS.md` D-202's 3 × 0.1 GRAM invite line took the lower extreme from 0.425 to 0.25, and
D-215's fee-on-top to 0.247. β is what
reaches the pool *at mint*, and it is the figure the rebate is priced against; the gas & ops
line's unspent part reaches the pool later, through `sweep_ops`, with no rebate against it
(§4.1), so an ordinary referred composite's effective pool share is ≈0.65. The
contract tracks two cumulative counters:

- `T` = total GRAM ever committed to the pool by the protocol
- `S` = total PRIMES ever emitted as rebates, plus the genesis bounty vault (§3.3)

and defines the **internal floor price** `p_f = T / S` (genesis values from §6 seed the
ratio; no oracle, no external dependency).

**`T` increments at mint, not at flush.** Because the injection is batched (§4.3), `T`
counts GRAM *committed to the pool and under protocol control* — some already swapped into
the DeDust position, the remainder sitting on the ratchet's balance as `pending`. Counting
at
flush instead would mean a mint does not ratchet the floor until some unrelated party
happens to call `flush()`, which would break the central claim that every mint raises the
floor.

This split must be stated in the copy, not discovered: a reader comparing `T` against the
pool's on-chain reserves will otherwise find a gap and assume the worst. The contract
exposes `get_pending()` alongside `get_floor()`, and

```
T = seeded + swapped + pending + stakedCost + exiting + realizedLoss
```

is checkable from get-methods, with one caveat about time. `T` lives on the ledger and
every other term except `seeded` lives on the ratchet, one message hop away. A mint (or any
other credit) raises `T` in the ledger's transaction and raises `pending` in the ratchet's
next one, when the `PoolInject` lands. For those few seconds the six terms sum to less than
`T`, and nothing is wrong. The ratchet stores the `T` each `PoolInject` carried (`tCache`) in
the same transaction as the `pending` credit. So the check splits into two exact claims:
`tCache = seeded + swapped + pending + stakedCost + exiting + realizedLoss`, read from one
ratchet state by `getFloorOracle` and `getStaking`; and `T − tCache`, GRAM still in flight. A
lost `PoolInject` cannot hide in the second. The next one that lands sets `tCache` to a `T`
that includes the lost amount, and the first claim fails. The read-proxy's
`/ratchet/identity` reads the ratchet first and `T` last, so the second is never negative.
The genesis seed is the one credit to `T` that sends no `PoolInject`, so until one follows
it, `tCache < seeded` and the check is against `T` directly. The first three terms are the original identity; the last three
arrived with §4.3.2's staked reserve (`DECISIONS.md` D-151) and are published together by
`getStaking()` on the ratchet — `stakedCost` is GRAM deposited into the Tonstakers pool,
carried at what it cost; `exiting` is a tranche on its way back, also at cost; and
`realizedLoss` is what the external-risk note below is about. **None of the three moves GRAM between
this identity and anywhere else** — a stake moves `pending → stakedCost`, an exit moves
`stakedCost → exiting` at send and `exiting → pending` on arrival, and each is credited in
the same step the other is debited, so the sum is conserved by construction rather than by
reconciliation.

**Mints are not the only credit to `T`.** Besides the floor donation and the royalty's ratchet
share, `sweep_ops` (`DECISIONS.md` D-117) returns the gas & ops line's unspent surplus to the
ratchet and raises `T` and `pending` by the same amount in the same step. It emits nothing —
`k = 0`, `S` untouched — so it is a pure floor raise, and the identity above stays exact.

**The `seeded` term, and why it is `0` in this deployment** (`DECISIONS.md` D-26, D-46).
The field exists for a possible future deployment that funds a real founder seed straight
into `T` — `genesisPipeline.ts` would set `seedT` to GRAM actually deposited as pool
backing, and the ledger's `handleGenesisSeed` would assign it to `T` without ever
crediting the ratchet's `pending`, since that backing would sit in the pool rather than on
the ratchet. **This deployment does not do that.** D-46 removed the deploy-time DeDust
deposit (and D-166 deleted the operator's genesis PRIMES allocation that replaced it,
§6 point 3); there is never a GRAM deposit, so `seedT = 0` and stays `0` for the life of the deployment — `handle
GenesisSeed` is one-shot. The term is kept rather than deleted (checkable via `getSeedT`)
so the identity above remains true and auditable by construction rather than collapsing to
the terms that happen to be non-zero because nobody built the other case yet. The same
argument now covers `realizedLoss`, which also reads `0` on a healthy deployment and is kept
for the same reason. `pending` and `swapped` still behave exactly as documented below — only
`seeded` differs from a deployment that used a real founder seed.

**Swapped GRAM is locked in the pool forever, once there is a pool.** Flush buys add no LP
— so every GRAM the protocol ever swaps lands in pool reserves that **no one can withdraw**
on the protocol's behalf. Under D-46 there is no guarantee a pool exists from genesis: it
comes into being whenever anyone (including the operator) first adds liquidity to it, using
DeDust directly — see §6 point 3. Before that, `flush()` simply cannot fill (the swap
bounces against an empty/nonexistent pool, and `pending` is restored exactly as it is for
any other unfilled flush, §4.3.1). Once liquidity exists, the pool deepens permanently with
every flush that fills, at nobody's expense and to nobody's protocol-level claim — but
third-party LP providers (which, under D-46, includes whoever supplies the pool's very
first liquidity) own a proportional, withdrawable share of reserves that subsequent
protocol buys deepen. The lock is absolute only for whatever LP share is burned, which is
never automatic and never assumed — it is the sole discretion of whoever holds that LP
position (§6 point 3: for the operator's own share, an optional, manual, later action that
gates nothing else).

**`S` counts cumulative emission and is never decremented by burns.** The β injection is
buy-and-burn, so circulating supply is strictly below `S` — meaning `p_f` *understates*
backing per circulating token, deliberately. The gap widens with every flush that
**fills**, not with every mint, and under the floor guard (§4.3.1) fills happen only when
PRIMES trades under the floor. So the understatement is narrower in strong markets and
wider in weak ones — the copy should say "understates" and not promise a rate at which the
margin grows. This is the conservative choice and it must be stated in the copy,
because a sharp reader will compute the circulating-supply version and get a better
number than the one on the landing page. Better they find that than the reverse. The
bounty vault sits in `S` from genesis for the same reason (§3.3): no future bounty can
ever move the floor.

**`S` is also bounded above, at `S_MAX` = 1,200,000,000 PRIMES** (`DECISIONS.md` D-156,
`shared/params.json rebate.S_MAX`, published by `getMaxSupply()`). It was not, and the
reason is worth stating because it is not obvious from the curve: emission here is
*multiplicative* — `ΔS/S = k·β/T` — so with `T` growing linearly in mints, `S` is bounded
if and only if `k` is integrable in `u = ln n`. `k_max(n) = 2.7/log₁₀(n)` is `6.216/u`,
whose integral `6.216·ln u` **diverges**; and the `k_max ≥ k_min` clamp below flattens the
curve entirely past `n ≈ 3·10¹³`, making the tail a power law `S ~ n^0.2`.

D-156 does **not** replace that curve — it is sim-calibrated and it stays. Emission is
multiplied by a second factor:

```
k_eff = k · (S_MAX − S) / S_MAX
```

which makes the dynamics **logistic**: `ΔS/S = k·(1 − S/S_MAX)·β/T`. `S` approaches `S_MAX`
asymptotically and never reaches it. Three consequences worth being explicit about:

1. **The ratchet theorem strengthens rather than changing.** The proof below turns on
   `k < 1` and is agnostic to *why*; the taper only ever makes `k` smaller, so `p_f`
   rises *harder*. `k < 1` now holds by two independent mechanisms — the single `K_CEIL`
   clamp on the summed uplifts, and a factor in [0,1] on top of it.
2. **It is invisible where the game lives.** At `S ≪ S_MAX` the factor is ≈ 1, so the whole
   modelled horizon runs on the unmodified curve; the taper costs single-digit percent of
   the rebate at the three-year `S` and binds at a mint head around 4·10⁹.
3. **It applies at every emission site, including the permissionless one.** The `k_min`
   clamp is not a leak, because the taper is applied *after* it — which is why that clamp
   and `docs/math-note.md` §3 needed no change.
4. **The one-shot genesis seed is the single `S +=` site the taper does not touch, and it
   needs no exception in fact.** The seed handler asserts a virgin ledger, so it runs
   exactly once, at `S = 0`, where the factor `(S_MAX − 0)/S_MAX` is exactly 1: applying
   the taper there would credit the same `S₀`. Every later credit — the donor's
   `donate_floor` mint included (§6) — goes through the taper. The seed also asserts
   `S ≤ S_MAX` after crediting, so no genesis argument can open above the cap.
5. **The taper is not by itself a bound; the headroom clamp is.** `e·(S_MAX − S)/S_MAX`
   stays under `S_MAX − S` only while the pre-taper emission `e ≤ S_MAX`. A mint's rebate
   is bounded that way by construction (`I ≤ 1 GRAM` against `p_f·S_MAX` in the tens of
   thousands of GRAM), but `donate_floor`'s `X` is uncapped, so past `S_MAX/L` = 120,000 GRAM
   of donation the taper alone would overshoot. `donate_floor` therefore also clamps its
   emission to `S_MAX − S`; the donated GRAM still credits `T` in full, so the floor only
   rises harder.

**And `S` is not decremented by a failed mint either — the shortfall is named instead
(D-52).** `S` is incremented in the same transaction that *sends* the PRIMES, not when they
arrive, because TON reports no delivery synchronously. If that `jetton_mint` bounces — the
jetton authority not yet sealed, a mis-wired master, an under-margined value — `S` counts
emission no wallet holds. Rolling it back would be the wrong correction twice over: it
would decrement `S`, and it would do so in the direction that makes `p_f` *overstate*
backing, against the conservatism this section is built on. So the ledger parks the amount
in `unminted_mints`, keyed by the recipient and summed, publishes the total as
`get_unminted_held()`, and exposes a permissionless `retry_mint` that re-sends it — one
opcode anybody may call for anybody, since the PRIMES can only go to the wallet the bounce
recorded. The point of the counter is the identity it makes checkable in three get-calls:

```
S − get_unminted_held()  ==  jetton master total_supply  +  cumulative burns
```

It reads zero on a healthy deployment, and a non-zero reading is a delivery failure to
retry, never a loss of backing.

**Rebate rule.** The rebate for a mint occurring t seconds after the previous one is

```
R(t) = k(t) · β · P / p_f          PRIMES
k(t) = k_min + (k_max − k_min) · min(1, t/T_ramp)
```

with `0 < k_min < k_max < 1` (proposed: k_min = 0.2, `T_ramp` = 1 hour; k_max per the
schedule below). The rebate *share* grows every second — waiting is rewarded — **and it
tops out exactly `T_ramp` after the last mint** (`DECISIONS.md` D-98), where it parks until
somebody mints and resets the clock to `k_min`. The climb is a straight line: at half the
ramp the share is halfway up the band, and past the ramp waiting buys nothing at all.
The rebate is denominated in GRAM-value at the floor price and **never reaches 100% of the
injection** — `k ≤ k_max ≤ K_CEIL = 0.95 < 1` is what the ratchet theorem needs, and the
ramp reaching its ceiling does not touch it.
Lots won ahead of the head settle at k = k_min always (§4.4), and **prime mints use k = 0 always**
(§5.1) — the clock has nothing to modulate on a number that emits nothing.

**The acquisition premium is `k = 0` money too** (§4.4 point 1b). Whatever a buyer pays
above the 1 GRAM mint leg arrives on its own message field and never inside it: the 1 GRAM
splits five ways as §4.1 and buys its rebate, while the premium — **since `DECISIONS.md`
D-114, split 50/50 between the ratchet and the governed treasury (§5.5), not routed to the
ratchet whole** — has its ratchet-bound half forwarded to `pending` with **nothing added to
`S`**. So `p_f = T/S` rises by half the premium (not the full amount, as it did before
D-114) and the ratchet's `k < 1` invariant is not merely preserved but strengthened — the
same argument §5.1 already makes for primes, applied to a different kind of money. The value
must physically arrive for the ledger to credit it (the settle handler asserts
`value ≥ MINT_PRICE + premium`), so a declared-but-unfunded premium cannot inflate `T`
against a balance that does not hold it.

**Since `DECISIONS.md` D-90 the premium arrives immediately on both lanes.** A clearing
price `C` decomposes into a 1 GRAM leg that runs through §4.1, `RES_GAS`, and a premium
`C − 1 − RES_GAS` forwarded **at the moment the lot closes**, split 50/50 between the
ratchet's `pending` and the governed treasury (`DECISIONS.md` D-114, amending D-7 — see
below). ~~On the ascending lane the 1 GRAM is escrowed on a shard and splits when the
head arrives, months later~~ — **VOID: there is no shard, no escrow and no later
settlement. A won lot mints in its closing transaction on both lanes**, so the two legs land
together whatever the number's parity. Nothing is added to `S`, so `p_f = T/S` rises by
half the premium — the ratchet-bound half only — and the argument is §5.1's, applied to a
second kind of money: unchanged in kind, changed in magnitude by two orders (and, since
D-114, halved again on its way to `T`). Two things follow from the timing, and each is why
it was chosen. **There is no escrow pool at all**, which is what makes §3.4's
*balance ≈ declared liability* checkable over two pools instead of three (the treasury's
premium share is fee revenue outside that identity, exactly like the forfeited-tribute flow
it now joins — §5.5.1). And the floor ratchets on the day the lot closes rather than in
month five.

~~There is **no treasury cut on the premium**: 100% ratchet, with the treasury paid its 5%
out of the 1 GRAM leg like any other mint, so no lot size ever turns trophy money into team
revenue (§2 principle 4).~~ **AMENDED — `DECISIONS.md` D-114 (2026-09-10): this was D-7's
original rule and no longer holds.** The premium now splits 50/50 ratchet/governed-treasury.
D-114 records why this is signed despite §2 principle 4's original wording: the treasury
stopped being a team wallet at D-100 and is a governed, no-key contract that spends only by
a passed LP-depositor proposal, so "trophy money into team revenue" no longer describes
where the treasury-bound half goes.

~~**The rebate is credited in full and released over head-progress.** A fraction
`VEST_NOW` of the rebate is transferable immediately; the remainder unlocks linearly as
the head advances the next `VEST_H` numbers (proposal: VEST_NOW = 25%, VEST_H = 300 —
Phase 1 outputs).~~ **DELETED 2026-08-28 (`DECISIONS.md` D-55).** No `VEST_NOW`/`VEST_H`
ever existed in `contracts/` or `shared/params.json` — every rebate is fully liquid the
instant it mints, `primes_jetton_wallet.tolk` is a plain unmodified TEP-74 wallet with no
lock concept, and building this for real would be a large addition (a custom wallet
variant or a separate per-wallet unlock ledger, on the hottest path in the system), not a
small patch. `S` still counts the full rebate at mint time regardless — that half of the
old claim was never about vesting and stays true. What vesting was FOR is §8.1's
mint-valve arbitrage defense; that analysis is corrected below to describe the
mitigations that actually exist rather than a mechanism that never shipped.

**The rebate is capped by what actually survives the split.** β·P here is the real
residual computed at mint time — after NFT and jetton-wallet deploy gas, tribute, the
referral, and treasury — not a hardcoded fraction of the mint price. So the protocol can
never emit more floor-value than the GRAM it actually retained, and this is checkable
per-transaction rather than argued in prose.

**Theorem (monotone floor).** After any mint, the new floor is

```
p_f' = (T + βP) / (S + k·βP/p_f)  >  p_f    for all k < 1.
```

Proof: cross-multiplying, `p_f·T + βP·p_f > p_f·T + k·βP·p_f` iff `1 > k`. ∎

**The proof never uses β being constant** — it holds for any injection `I = βP > 0`. So
the floor rises on every mint regardless of referral status, actual gas draw, or any
future change to the split. β is free to vary per mint; only `k < 1` is load-bearing.

So the floor price is a strictly increasing step function of participation, independent
of external trading, independent of whether rebate recipients dump instantly. Emission
value is always strictly less than injected GRAM, cumulatively and per-event.

**The one external risk to the theorem, stated next to the proof rather than in a decision
record.** Since §4.3.2 the backing has one counterparty — the Tonstakers liquid-staking pool
— and **a slashing event inside that pool is the only thing outside this system that can
falsify anything §5 claims** (`DECISIONS.md` D-151). It belongs here, in full, because the
proof above is the central claim of the whole design and a reader is owed its exception on
the same screen.

The exception exists because of an **asymmetry in `T`: no message can lower it.** `T` is the
ledger's counter, incremented at mint, and *never falls* is precisely what the theorem
asserts — so the ratchet has no opcode that decrements it and must not acquire one. GRAM that
genuinely leaves therefore cannot be subtracted. It is carried instead as a named term,
`realizedLoss`, and the identity above closes only because that term is in it; a design that
silently subtracted would break the theorem, and one that silently omitted would leave the
identity short by exactly the amount lost.

**What a non-zero `realizedLoss` means is exact and worth writing as arithmetic: `p_f`
overstates the backing by `realizedLoss / S`.** That is the *opposite* direction to every
other conservatism in this section — `S` counting burnt supply, the bounty vault sitting in
`S` from genesis, an unminted rebate never rolled back (D-52) all make `p_f` understate — so
it is published rather than absorbed. `getStaking()` returns it beside `stakedCost` and it is
never netted into it, the same separation `getBurnStats()` draws, and a reader subtracting
`realizedLoss / S` from `getFloorNum()/getFloorDen()` gets the corrected figure in three
calls.

**No path the contract chooses can make it non-zero**, which is what makes this a
counterparty risk and not a design risk. Of §4.3.2's three exit legs, only leg 2 names a
price at all, and its `min_out` is floored at the tranche's own cost basis — a book that will
not pay what the GRAM cost is refused, not discounted. Legs 1 and 3 redeem at the pool's own
`total_balance/supply` and name no price. So the only way GRAM comes back short of cost is the
pool paying under it, i.e. slashing. The term is defence in depth against a future change to
leg 2's bound, and an honest place for an external loss to land.

**And the exposure is bounded by a published number rather than by a promise.** The most that
can ever be lost is what is in the pool: `stakedCost + exiting`, held at
`staked_reserve.staked_fraction` = 0.80 of the ratchet's obligation, with the balance liquid
on the contract. §8 carries this as a named counterparty rather than as a reassurance.

**Ratchet step size.** From the theorem, `Δp_f/p_f ≈ (1−k)·βP/T`, so each mint's
contribution decays like 1/T as the pool grows. The floor is a staircase with
ever-shallower steps that never descends — the honest shape to put on the landing page,
rather than an exponential.

**The horizon, and why it is a horizon and not a bound.** Integrating the step size gives
a closed form for the whole trajectory:

```
dp_f / p_f = (1 − k) · dT / T        ⟹    p_f / p_f0 = (T / T₀)^(1 − k̄)
```

The sim fits `1 − k̄ = 0.695` over year one at baseline demand, which is the measured `45.4×`
floor move over that year. Because `k_max(n)` decays with the head, the exponent *rises*
later, so that is the slow end of the range rather than the middle of it.

This has a consequence the copy must state rather than dodge. `1 − k ≥ 1 − K_CEIL = 0.05`
always and `T` grows without bound, so **`p_f` grows without bound** — the ratchet theorem
says so, and it is the whole reason to hold the token. Therefore *no price ceiling on
PRIMES can ever be an invariant*, and writing one into this document would be exactly the
uncheckable economic claim §2 forbids. What `L` buys is a **horizon**: at `L = 10,000` the
floor ~~opens at 1/60,000 GRAM per PRIMES (D-43; up from 1/20,000 under D-42's smaller
vault)~~ **opens at 1.0761e-05 GRAM/PRIMES: D-100 point 2 cut the genesis donation from
240 GRAM to 4.20, D-154 raised it to 132.50 and D-204 to 200, against D-204's `S₀` of 16,600,000, to which the
donation's own mint adds 1,972,333** — 1.55× lower than D-92's floor rather than
47.6×, so the horizon below is understated by that factor too and is due the same
re-derivation.
The mint count to pass 1/1,000 was last derived against the D-42 opening floor (~6,500 to
~10,600 mints, roughly six to eight weeks at baseline demand) and needs re-deriving from a
sim pass against the D-43 vault before it is quoted again — a lower opening floor starts
the same `1 − k̄` climb from three ticks further back, so the old range understates it and
must not be reused as-is. That is the arithmetic, stated with its inputs. It is not a
promise about a price band, and any surface that renders it as one is wrong.

The design consequence is that **no fixed nominal PRIMES amount can be a fixed reward.**
Anything the protocol is supposed to pay at a *constant value* — era ceremonies (§7), quest
rewards (§9.4) — is denominated in GRAM and converted at the floor when it pays. Anything
left in PRIMES inflates against a budget the vault fixed once, at genesis.

**Relation to the AMM price.** The protocol is a **price-disciplined** net buyer on its
DeDust position: β·P per mint accrues to the ratchet, and the batched flush (§4.3) executes
only at or below `p_f` under the floor guard (§4.3.1). So the relationship between the
floor and the market is no longer "the protocol buys on a schedule and hopes" — it is a
standing bid with a published reservation price. If the AMM price sits below the floor
trajectory, the protocol's accumulated balance is spent buying it back and arbitrage
closes the gap; if it sits above, the protocol simply holds GRAM that already counts in
`T`. Cumulative buying is bounded below by the ratchet and now *conditioned* on price,
which is what makes "PRIMES appreciates if participants keep coming, with zero external
buyers" a mechanism rather than a promise — and what makes a sustained detachment below
the floor a self-correcting condition rather than a risk to be apologized for. External traders on
STON.fi/DeDust can add upside; they cannot break the ratchet.

**Emission by prime density (flavor + discipline).** k_max itself decays over the number
line as 1/ln(n) — the density of primes near n — so early participation is structurally
more rewarded, Bitcoin-halving-style but continuous, themed on the Prime Number Theorem.

The decay needs a normalization constant to mean anything. Anchoring at n₀ = 1000:

```
k_max(n) = 0.9                          for n ≤ 1000
k_max(n) = 0.9 · ln(1000) / ln(n)       for n > 1000
         = 2.7 / log₁₀(n)                (equivalent, and cheaper on-chain)
```

| n | k_max |
|---:|---:|
| ≤ 1,000 | 0.900 |
| 10,000 | 0.675 |
| 100,000 | 0.540 |
| 1,000,000 | 0.450 |

Emission halves over the realistic range while the fragile bootstrap phase keeps the full
rate. Anchoring at genesis instead (n₀ = 13) was rejected as too aggressive — it puts
k_max at 0.42 by n = 234, throttling emission before the game has an audience.

The contract must **clamp `k_max ≥ k_min`**. The formula crosses 0.2 at n ≈ 3·10¹³ —
unreachable in practice, but an unclamped k_max below k_min would invert the curve and
make waiting *punitive*, so it is a cheap guard against a term nobody will ever exercise.

**Four uplifts raise k_max, and one clamp is what keeps all of them safe.** §4.7 pays
recruit rank in a higher rebate ceiling rather than in PRIMES, §4.7.1 pays prime rank the
same way, §4.6 pays a new recruit the same way on their first five mints, and §5.1 pays a
prime minter the same way on their next few composite mints. So `k_max` becomes

```
k_max = min( k_max(n)
           + uplift(recruit_rank)
           + uplift(prime_rank)
           + PRIME_UPLIFT      · 1{inside prime-credit window}
           + NEWCOMER_UPLIFT   · 1{inside newcomer window}
           , K_CEIL )
```

with **`K_CEIL = 0.95`, a hardcoded constant strictly below 1**. All four uplifts are
additive and are clamped *together*, not separately — a rank-V recruiter who is also a
rank-V prime finder inside both windows does not stack past the ceiling. **Every one of them
is rationed by something the buyer cannot buy** — recruits, prime mints, newness, a forgone
rebate. *(A fifth, purchasable leg — `STAKE_UPLIFT(tier)`, §5.3's old staking design — sat
here at zero from D-34 until `DECISIONS.md` D-168 deleted it: a purchasable uplift sells
ratchet rate and lowers §8.1's ceiling for the largest holders, and §5.3's staking now pays
PRIMES from the treasury instead of `k_max` headroom.)* **This is the property that
lets the reward layer keep growing without a single new economic argument**: every reward
the design will ever add can be denominated in `k_max` headroom, and the ceiling absorbs
all of them at once. The theorem above is untouched — it only ever
needed `k < 1`, and the clamp is what guarantees that no combination of rank, recruitment
status, era and number size can reach it.
The two clamps together bracket the whole curve: `k_min ≤ k(t) ≤ K_CEIL < 1`, checkable
by reading two constants. Expect this to be the first thing an auditor greps for, so it
belongs on the same screen as the proof.

### 5.1 Primes emit nothing

> **D-88 note (2026-08-31).** What a prime BUYER pays is no longer 1 GRAM at the bottom of
> the lane — it rests at `max(NPV(p)/2, P0(p)/3, MINT_PRICE)` (§4.4's D-88 box, D-99 §1.2). The split below is
> untouched: it runs on the **nominal** `MINT_PRICE` on every lane, and everything paid
> above `MINT_PRICE + RES_GAS` is premium, `k = 0` money, split 50/50 between the ratchet
> and the governed treasury since `DECISIONS.md` D-114 (was injected whole into the ratchet
> under D-7). A higher resting price therefore makes this section's argument *stronger*,
> not different — it just means half the extra reaches `T`, not all of it.

**A prime mint pays the full 1 GRAM, takes the full split, and receives a rebate of zero.**
`k = 0`, unconditionally and regardless of the clock, rank, or how long the head has been
waiting.

The theorem is satisfied at its strongest: `k = 0 < 1`, so `p_f' = (T + βP)/S` — new
backing, no new supply, the largest step the mechanism can produce. Nothing in §5 needed
`k` to be positive; the whole `k(t)` apparatus is a demand mechanism, not an economic
requirement, and switching it off on a class of mints is safe by inspection.

Combined with the tribute line falling to the pool (§4.1), the sentence is:

> **Primes emit nothing. The protocol pays prime minters in tribute rights and standing,
> and keeps 100% of the injection.**

**What the prime minter gets instead.** Four things, none of them PRIMES, none of them
touching any other participant's line:

1. **The asset itself** — a perpetual claim on the tribute of every multiple of `p` ever
   minted, which is the only cash flow in the game that never terminates.
2. **The pen on the number while they hold it** — any owner names a number once for GRAM
   (§4.7.1, `DECISIONS.md` D-212; it no longer stays with the finder after a sale).
3. **+1 prime rank**, feeding a ladder whose rights are the same `k_max` headroom that
   recruit rank pays in (§4.7.1 — the tribute multiplier and the
   `RES_PRIORITY_BASE` waiver this line used to list are both deleted, `DECISIONS.md`
   D-54, D-37, D-102).
4. **A prime credit** — `PRIME_UPLIFT` added to `k_max` on the minter's next
   `PRIME_WINDOW` **composite** mints (proposal: 0.06 over 5 mints; Phase 1 output).

The credit counts composite mints only, so a run of consecutive primes cannot burn it, and
it **does not stack with itself** — a second prime resets the window rather than doubling
the uplift, which stops a prime streak from compounding into the ceiling.

**On gift and beneficiary mints (§4.5), the credit and the prime-rank increment follow the
beneficiary**, exactly as the rebate does. Gifting a prime therefore gives away everything
the mint produced except the referral commission — which is what §4.5 already promises,
and it makes "I minted you prime 1009" a materially bigger gift than before.

#### The liveness problem, and why it is no longer a liveness problem

**Historical statement of the risk, kept because the compensation below was shaped by
it.** While the head passed **through** every prime, `k = 0` removed the protocol's only
self-correcting stall-breaker on precisely the numbers that are most expensive to verify:
the clock `k(t)` climbs until somebody mints, and it had nothing to climb on a prime. If
minting prime `p` was a bad trade, the head parked there and the entire game stopped. That
was the mechanism's kill criterion.

**`DECISIONS.md` D-20 removes the mechanism of that risk rather than mitigating it.** The
sequential head is now defined over composites (and Unity) only; a prime is never a
position on the line and is sold off-head through its own descending lot (§6 point 1,
§4.4 point 1b lane A). So a prime nobody wants delays nobody: the head walks past it, the
lot's price falls to its resting price `max(NPV(p)/2, P0(p)/3, MINT_PRICE)` (D-88 point 1,
D-99 §1.2) and rests there indefinitely, and the number is bought
whenever somebody finally wants it. **There is no prime-head wait distribution any more,
because there is no prime head.**

Two things this does *not* buy, stated so the register can carry them honestly (§12):
nothing here makes anyone *want* to buy a prime — it only guarantees they may, cheaply,
forever — and while a prime is unsold its tribute share is forfeited to the treasury
(§4.1, §6 point 2), so an unpopular prime is a slow bleed of income that its eventual
owner never recovers. The failure mode changed class, from **liveness** to **revenue**.

The compensation below is unchanged by any of that: it is what makes a prime worth buying
at all, and the two forms are strong in opposite regimes, so between them they cover the
whole line:

- **Tribute is strong once the head has moved.** A prime `p` collects a share of the 10%
  tribute line from every multiple, and under the `√p` weighting of §3.2 it takes 60–98% of
  the divisor line on each one. Simulated, `p` repays its full 1 GRAM mint price once the
  head reaches about **12p** for large primes and **20p** for the genesis ones — the large
  primes are *cheaper* to repay in relative terms, they simply need more calendar mints to
  get there (§3.2, "large primes are early, not underpaid"). Phase 1 computes this against
  the mint-arrival model; the order of magnitude is what matters here.
- **Credit headroom is strong for large primes.** `k_max(n)` decays as `2.7/log₁₀(n)`
  while `K_CEIL = 0.95` does not move, so the room available for uplifts *grows* along
  exactly the stretch of the line where tribute NPV collapses.

| n | k_max(n) | headroom to `K_CEIL` | credit value | rebate forgone | protocol nets |
|---:|---:|---:|---:|---:|---:|
| ≤ 1,000 | 0.900 | 0.050 | 0.138 GRAM | 0.585 GRAM | 0.447 GRAM |
| 10,000 | 0.675 | 0.275 | 0.165 GRAM | 0.439 GRAM | 0.274 GRAM |
| 100,000 | 0.540 | 0.410 | 0.165 GRAM | 0.351 GRAM | 0.186 GRAM |
| 1,000,000 | 0.450 | 0.500 | 0.165 GRAM | 0.293 GRAM | 0.128 GRAM |

(Credit value = `min(PRIME_UPLIFT, headroom) · PRIME_WINDOW · β·P` at β = 0.55 on the
composite mints it is spent on; rebate forgone = `k_max(n) · 0.65 · P`. Both β figures are
ten points below their pre-`DECISIONS.md` D-117 values, when the gas & ops line was 10%.)

Two properties to read off that table, both load-bearing:

- **The compensation share rises from 24% to 57% as emission decays** — the credit grows
  in relative terms exactly as tribute weakens. Neither lever was tuned for this; it falls
  out of a decaying `k_max` under a fixed ceiling.
- **The protocol nets on every row.** The binding design constraint is
  `PRIME_UPLIFT · PRIME_WINDOW < k_max(n)` — 0.30 against 0.45 at n = 10⁶ — which
  guarantees the credit is always worth **strictly less** than the rebate that was
  withheld. Prime mints are net-accretive to the floor at every point on the line, not
  merely at the start. **(Corrected 2026-08-28, `DECISIONS.md` D-56: the constraint
  actually stops holding at n ≈ 10⁹** — `2.7/log₁₀(10⁹) = 0.30` exactly — **not 10¹³, and
  the `k_min` clamp is not why it's unreachable: `k_min` does not bind until n ≈ 10¹³·⁵,
  four decades later.** It is unreachable because the head cannot get there — a billion
  composite mints at 1 GRAM each — and because `PRIME_UPLIFT`'s credit only ever applies on
  a head mint (`upliftSum = 0` on every off-head path), so the auction and reservation
  lanes that *can* name an n this large never spend the window.)

#### What this does not break

- **The ratchet.** `k = 0` on primes and `k ≤ K_CEIL < 1` on composites. The theorem holds
  pointwise, with a wider margin than before.
- **The split.** No new line, no new rate — two existing lines resolve to nothing (§4.1).
- **`S`.** Emission is now a function of composite mints only. `S` still never decrements,
  still pre-counts the bounty vault, still understates backing.
- **Primes bought off the lot.** A prime clearing settles at `k = 0` on its 1 GRAM leg,
  with the premium already added to `T` at the close, so the acquisition route changes what
  securing a prime *costs* and nothing whatever about what it emits. Primes are not
  reservable at all (§4.4 point 1b's lane rule), so there is no reserved-prime case left to
  price; §8 still prices the farming version of buying primes cheaply at the floor.

**What it costs, honestly:** ratchet *rate*, later. The credits are emission deferred onto
future composite mints, bounded but real, and they belong in the same unpriced-liability
bucket as rank rights (§12). The stall risk is eliminated structurally rather than by
arithmetic — primes are off the head — and what Phase 1 must now run instead is the
*demand* question: how long an unpopular prime sits at its resting price — `max(NPV(p) / 2,
P0(p) / 3, MINT_PRICE)` since D-88 point 1 and D-99 §1.2, not a universal 1 GRAM — and how much tribute is forfeited
to the treasury (§4.1) while it does.

**What this deliberately is NOT:**

- Not a redemption guarantee. PRIMES holders sell into the AMM at market price with
  slippage; the floor is a lower bound on the protocol's own valuation ratio and a
  buy-pressure schedule, not a deposit. Nothing in this protocol takes custody of anyone's
  money on a promise to return it — which is why §3.4 refuses the word *bank* outright.
- Not NFT exit liquidity. Number NFTs trade on secondary markets only; the contract
  never buys them back. This is stated on the front page.

### 5.2 Sinks: what PRIMES is for

Everything above this line is the supply side, and it is specified to the last constant:
§5 emits, §3.3 pre-counts the vault, §4.3 buys and burns. The demand side has until now
been absent from this document, and the absence is structural rather than an oversight of
copy. **There is no transaction in the design in which a holder spends PRIMES.** Every
recipient of a rebate has exactly one available action, and it is to sell. The protocol's
own bid is the only structural buyer, it is conditional on price (§4.3.1) and finite, and
§12 already admits that a large enough exit clears it.

This is a direct consequence of a decision the document is otherwise right to have made.
§4.7 established that the reward budget lives in *rights*, because `k < 1` is load-bearing
and emission cannot be spent on growth. Rights are earned and never bought — which is what
makes them safe, and also means that no right the design has issued so far creates a
reason to **acquire** PRIMES. The supply problem was solved onto the demand problem.

A **sink** is any mechanism that consumes PRIMES in exchange for something the protocol
can issue. Three families, in ascending order of how much argument they need (family 1
is now one action and family 2 is dropped — see each entry):

1. **Burn-priced cosmetics and rights — EMPTY since `DECISIONS.md` D-212.** The family
   shipped with three named examples and none is left. Naming (§4.7.1), the last, is paid in
   **GRAM** by the number's owner and goes to the ratchet floor, so it is not a sink at all;
   `primes_sink.tolk`, its ledger round trip (`quote_floor`), `shared/schemas/sink.tlb` and
   `shared/params.json`'s `sinks` block are deleted with it. The era-ceremony lot went with
   `DECISIONS.md` D-126 (§7 defined no lot, no reserve and no prize) and the constellation
   registration bond with D-102. Their tags (`ANNT`, `CERM`, `BOND`) stay listed as retired in
   `shared/opcodes.ts`: a tag's meaning is permanent even when nothing answers it.
2. **Burn-priced queue position.** The discretionary half of the reservation fee, above.
   The only one that touches an existing money path, and it touches the half that was
   already discretionary.
3. **PRIMES staking** (§5.3, `DECISIONS.md` D-168). Not a burn: a time lock that takes PRIMES
   off the market for a term the chain enforces, paid in PRIMES the treasury already holds.
   It moves no GRAM, decrements no `S` and touches no split, so it sits under the rule below
   without a burn. *(Until D-168 this entry was "staking for `k_max` headroom", a purchasable
   rebate uplift gated on a simulation result; that design is deleted.)*

**The rule that unites them, and the reason the whole layer is free:**

> A sink may consume PRIMES and may grant rights. It may **never move GRAM**, never
> decrement `S`, and never touch the split.

That single sentence is what leaves the ratchet theorem, the closed 100% split (§4.1) and
the three-pools reconciliation (§3.4) untouched by every sink this design will ever add. A sink contract would hold a jetton wallet and **zero GRAM
liability**, so it would not appear in the balance-versus-declared-liability check at all.
Burning inside a sink does not move `p_f`, because `S` is cumulative emission and never
decrements (§5, §3.3) — it widens the circulating-supply gap in holders' favour, exactly
as a bounty burn does, and by the same conservative accounting.

**What sinks do and do not claim.** They change what PRIMES is *for*; they do not change
what it is *worth*. The floor is still `T/S`, still monotone, still deliberately
understated. What they change is the number of holders whose only available action is to
sell — which is a real problem, was unaddressed until this section, and is worth solving
without pretending it is a valuation mechanism. Any copy that describes a sink as
"supporting the price" is wrong under this document and should be rewritten to the
sentence above.

**One mechanical note, because it constrains any future burn-priced sink** (none exists
since D-212). A TEP-74 `Burn` carries no payload, so a burn cannot say what it paid for,
and every burn-priced sink needs it to.
The intended shape is therefore **transfer-to-sink**: the buyer transfers PRIMES to the
sink with the action in `forwardPayload`, the sink recognises the notification from its
own wallet, burns the full amount received, then performs the action. This is not a new
pattern — §4.3's flush is already `wallet → contract (transfer notification) → burn` — and
it keeps burn authority at one address per sink, which is what makes *"every PRIMES that
entered a sink was burned"* a claim a reader can check against one account rather than a
promise.

### 5.3 Staking: PRIMES locked for a term, paid from the treasury vest

**`DECISIONS.md` D-168 (SIGNED 2026-09-23).** A wallet locks PRIMES
for a fixed term and earns PRIMES while the term runs. The rewards are PRIMES the governed
treasury already holds — its 1,000,000-PRIMES vest (§3.3) — sent once per 30 days by a
permissionless `distribute()` (§5.5.3) and streamed to stakers over the following 30 days.
Its purpose is a **supply lock**: PRIMES that would otherwise sit one sell order away from
the market are committed for a term the chain enforces.

> The contracts, the sim, the backend, the app and testnet (genesis 2026-09-23, deploy
> subwallet `20260927`, `docs/testnet-deployment.md`) all match this section (D-168).

**What staking used to be, and why it is gone.** Until D-168 this section specified a
*fifth `k_max` uplift*: a stake bought `STAKE_UPLIFT(tier)` of rebate headroom, metered by
an entitlement `θ < 1`. D-34 shipped the plumbing at `STAKE_UPLIFT_MAX = 0` because every
figure it needed was bounded and not selected, and two costs sat on it that no parameter
could remove: a purchasable uplift **sells ratchet rate** — more emission per GRAM injected,
taken from every holder who did not stake — and it **lowers `x*`** (§8.1) for exactly the
wallets holding the most PRIMES. D-168 deletes the leg outright: `STAKE_UPLIFT_MAX`,
`stakeUplift` on `MinterState`, `SetStakeUplift`, `SetStakeSink`. The clamp in §5 sums four
uplifts again, and every one of them is earned.

**The mechanic.**

| Tier | Lock term | Weight |
|---|---:|---:|
| 0 | **30 days** | 5 |
| 1 | **3 months** | 6 |
| 2 | **6 months** | 7 |
| 3 | **1 year** | 8 |

(`shared/params.json` `staking.tier_term_seconds` and `staking.tier_weights` — the same
terms and weights the LP ladder carried for those rungs before D-168.)

- **Stake.** A TEP-74 transfer to the stake contract whose forward payload names a tier.
  Several positions per wallet; they live on a **per-owner child contract**
  (`primes_stake_position.tolk`) for the config-43 reason §5.5.3 gives for LP positions,
  and re-deriving the child's address is the whole authentication. A transfer with no tier
  is **refunded, not locked** — a stake with no tier has no term. There is **no minimum
  stake**; the gas the staker attaches is the only dust guard.
- **Share.** A position's share of the stream is `amount × tierWeight / totalWeight`.
- **The lock clock is seconds**, like the LP terms — not head progress. A position matures at
  `lockedAt + term` (clock-divided on testnet by D-139's divisor, like every wall clock here).
- **No early exit.** Principal returns only at or after `maturesAt`, to its owner, and to
  nobody else (**ST-3**).
- **Earning stops at `maturesAt`.** A matured position earns nothing more; `relock(id, tier)`
  restarts a term, and may never shorten one that is still running
  (`newTier ≥ tier || now ≥ maturesAt` — the same assert as the LP relock, for the same
  reason).
- **Payout is pull.** `claim(id)` sends accrued PRIMES to the owner's wallet; `withdraw(id)`
  at maturity returns principal plus the final accrual.
- **Stakes do not vote.** Governance stays with locked LP (§5.5.5); D-100's rejection of
  PRIMES-holder voting stands.

**The stream.** `distribute()` delivers a month's budget in one transfer. Paying it out in
one step would reward whoever held weight at that block, so it is **streamed**: each budget
arriving re-rates the stream to `streamRate = (streamRemaining + budget) / interval` ending
`interval` from now, and an accumulator pays it out linearly:

```
dt              = min(now, streamEnd) − lastAccrualTime
amt             = min(streamRate · dt, streamRemaining)          (only if totalWeight > 0)
rewardPerWeightAcc += amt · SCALE / totalWeight
streamRemaining −= amt
unclaimedTotal  += amt
```

run first on every state-touching message. **With no stakers nothing accrues** — the budget
stays in `streamRemaining` and rolls into the next epoch. The same happens to a slice whose
accumulator step would pass the contract's `2^120` product bound — reachable only with a dust
`totalWeight` (a lone 1-nano stake needs ~360M PRIMES streamed). The slice is skipped, never
thrown on: a throw there would stop every message and lock every principal.

**Maturity, which nobody sends a message for.** `totalWeight` still includes a matured
position until something touches it, so the settle rule prorates: on the first settle at or
past `maturesAt` (`now ≥ maturesAt`, where the ratio is exactly 1 at equality), the position
is paid `full × (maturesAt − lastSettleTime) / (now −
lastSettleTime)` of what the accumulator says, the rest **returns to `streamRemaining`**, and
its weight leaves `totalWeight`. Conservation is exact because the excess goes back to the
stream, not to anybody. The proration is an approximation when `totalWeight` moved inside
that window, and it is disclosed as one; `expire(id)` is a permissionless poke the keeper
sends at maturity, so the window is minutes, not days.

**Invariants, each a contract test and a get-method.**

- **ST-1 solvency:** the stake contract's PRIMES wallet ≥ `lockedTotal + streamRemaining +
  unclaimedTotal`, in one get-call (`getStakeSolvency`), reconcilable against the wallet's
  own `get_wallet_data`.
- **ST-2 conservation:** Σ budgets received = Σ claimed + `unclaimedTotal` + `streamRemaining`.
- **ST-3 no early exit:** principal leaves only to its owner, only at `now ≥ maturesAt`.
- **ST-4 bounded stream:** what is paid over any epoch ≤ that epoch's budget plus the carried
  remainder.

**Get-methods (§9.1).** The stake master (`primes_stake.tolk`): `getStakeSolvency()` →
`(lockedTotal, streamRemaining, unclaimedTotal)` (ST-1); `getStakeStream()` →
`(streamRate, streamRemaining, streamEnd, lastAccrualTime, rewardPerWeightAcc, totalWeight,
accScale)`; `getAccNow()` (the accumulator as the next message would see it);
`getStakeTotals()` → `(budgetsIn, claimedTotal, lockedTotal, livePositions, stakeEvents,
budgetEvents)` (ST-2 is `budgetsIn = claimedTotal + unclaimedTotal + streamRemaining`);
`getTierTerms()` (clock-divided); `getTierWeights()`; `getStakePositionAddress(owner)`;
`getStakeMinForward()`; `getStakeConfig()`. The position child
(`primes_stake_position.tolk`): `getPositions()` → `(positionCount, nextId, stakedTotal)`;
`getPosition(id)` → `(amount, tier, lockedAt, maturesAt, rewardDebt, lastSettleTime, expired,
banked, inFlight)`; `getClaimable(id, acc)` (what a claim pays now, fed `getAccNow()` — the
settle rule run as a read, maturity proration included); `getTierTerms()`;
`getPositionOwner()`; `getPositionMinForward()` → `(ownerMinForward, expireMinForward)`.

**What this does not break**, stated the way §5.1 states it:

- **The ratchet.** Nothing here touches `k`. The §5 clamp sums four earned uplifts and
  `K_CEIL < 1` is unchanged.
- **`S` and `T`.** The rewards are vest PRIMES already counted in `S` at genesis (§3.3);
  staking mints nothing and moves no GRAM, so neither counter moves.
- **The split.** No new line, no GRAM path, no change to §4.1. §5.2's rule holds.
- **Solvency.** The stake contract owes PRIMES and holds no GRAM — it is not a pool of GRAM
  in §3.4's sense, and ST-1 is its reconciliation row.

**What it costs, honestly.** The vest that pays stakers used to pay LP providers (the §5.5.3
miner D-168 deletes). The miner existed to pay for DeDust depth, and §4.3.1's flush swaps
against that depth. Removing it is only safe if the flush can still defend its band without
it, so **D-168's sim phase publishes LP depth and flush slippage with the miner removed
(`shared/params.json`), and if the flush cannot defend its band the owner decides.**
The rate a staker sees floats with the treasury's PRIMES and with total staked weight, so
every surface calls it the current rate and never promises it (§9.1).

### 5.4 The rotation: what the late game pays

§5 emits, §5.2 spends, §5.3 locks. This section answers the question all three leave
open: **where does the value sit once `k_max(n)` has decayed?** It introduces no
mechanism, no parameter and no asset. Every number below falls out of §4.1's split and
§5's decay curve, and the rotation it describes has been true since v5 — it has simply
never been written in one place.

**The claim, in one sentence:** *the asset side's share of each mint rises monotonically
with `n` because the rebate is the only leg of the split carrying a decay term; nothing
grows, the token half shrinks on a published schedule.*

The arithmetic, on a composite mint at the steady-state β = 0.55, with the rebate valued
at the floor:

| n | `k_max(n)` | rebate at floor | referral | divisor line | flat dividend | **asset side** | **asset share** | `x*` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ≤ 1,000 | 0.900 | 0.495 | 0.100 | 0.080 | 0.020 | **0.200** | **28.8%** | 1.82 |
| 10,000 | 0.675 | 0.371 | 0.100 | 0.080 | 0.020 | **0.200** | **35.0%** | 2.42 |
| 100,000 | 0.540 | 0.297 | 0.100 | 0.080 | 0.020 | **0.200** | **40.2%** | 3.03 |
| 1,000,000 | 0.450 | 0.248 | 0.100 | 0.080 | 0.020 | **0.200** | **44.7%** | 3.64 |

(GRAM per 1 GRAM mint. Rebate at floor = `k_max(n)·β·P`; referral is §4.1's flat 10%;
divisor line and flat dividend are §3.2's `1−f` / `f` halves of the 10% tribute line;
asset share = asset side ÷ (asset side + rebate). `x*` is §8.1's ceiling at `c = 0.10`.
Every column is derivable from §4.1, §5 and §8.1; the β-dependent rebate column is a
Phase A output and is quoted here at the planning β. `sim/tests/test_late_game.py`
recomputes it from `economics.asset_share_curve`.)

Read the two bold columns together: **the asset side is a constant 0.200 GRAM at every
point on the line, and the rebate falls by half across three decades.** That is the whole
rotation. It is the same mechanism §3.2 already applies to one narrow case — the
`PRIME_UPLIFT` credit's value rising from 0.138 to 0.165 GRAM "as `k_max(n)` decays away
from the fixed `K_CEIL` and opens headroom" — generalised from the credit to the split.

**Three qualifiers, none of them optional.** Each one is a place where a reader who
checks §3.2 would otherwise catch the section overclaiming:

- **The flat prime dividend's *rate* decays per prime; its lifetime total does not.** The
  line is a constant `f · 0.10` GRAM per mint divided among π(n) primes, so an individual
  prime's dividend *rate* falls like `1/π(n) ≈ ln(n)/n` — 0.119 GRAM per 1,000 mints of head
  progress at n = 10³ against 0.00025 at n = 10⁶. That number is real and it is the wrong
  denominator to stop at, because the mint count grows over the same stretch: cumulative
  flat income sums `Σ 1/π(n)`, which diverges like `ln²(n)`. Measured at equal
  multiplicative age the two effects very nearly cancel, and the residual runs the *other*
  way — a later prime collects **more**:

  | prime minted at | by head 2p | by head 10p | by head 100p | by head 10⁶ |
  |---:|---:|---:|---:|---:|
  | 211 | 0.067 | 0.256 | 0.614 | 1.447 |
  | 1,009 | 0.087 | 0.324 | 0.752 | 1.284 |
  | 9,973 | 0.118 | 0.428 | 0.961 | 0.961 |
  | 99,991 | 0.149 | 0.533 | — | 0.533 |
  | 499,979 | 0.172 | — | — | 0.172 |

  So the flat line is not dying, it is **progressive** — which is exactly the job §3.2's
  "large primes are early, not underpaid" assigns it. As a share of a prime's total tribute
  income to head 10⁶ it runs 0.8% for 211, 2.2% for 1,009, 11.4% for 9,973, 42.8% for
  99,991 and 68.3% for 499,979. It is a rounding error for the blue chips and it is most of
  what a prime minted near the head earns at all, during the long wait before its first
  multiple arrives. Both tables come from `tribute.asset_lifetime_curves` and
  `tribute.flat_dividend_decay`, exercised by `sim/tests/test_late_game.py`.
- **Tribute is flow-linked, not `n`-linked.** A prime `p` earns from multiples arriving at
  density `1/p` with weight `e·√p`; at a constant mint rate that stream is roughly flat per
  unit of head progress. It does not grow with `n`. It fails to decay, which is the
  property this section needs and the only one it claims.
- **Nothing enters the tribute weighting but `e·√p`.** The constellation multiplier this
  bullet used to bound was deleted by `DECISIONS.md` D-102, and constellations themselves by
  D-202, so nothing about a prime's income depends on anything but its multiples.

**The rotation is denominated at the floor, and stops being a rotation at the ceiling.**
`x*(n) ≈ (1−c)/(k_max(n)·β)` is proportional to `1/k_max(n)`, so at the premium ceiling
the rebate is worth `1 − c` = 0.90 GRAM *for every n* and the asset share is a flat 18.2%
all the way along. The decay term divides out exactly. So the honest statement is that the
rotation describes what the protocol pays, not what the market pays — and the band §8.1
publishes widens over the same stretch, which is the reader's compensation for that
caveat, not a hedge against it.

**Both halves of the line rotate, and that is what keeps §3.2's symmetry intact.**
Emphasising tribute alone would read as "primes win", which §3.2 explicitly rejects. The
referral key is the composite's `n`-invariant leg — 10% of every mint it routes, flat, in
GRAM, with no `n` term anywhere in §4.1 — and it is the cleanest instance of this section's
claim in the entire design. Primes get the perpetual claim; composites get the key. Both
are denominated in mint flow, and neither is denominated in `k_max`.

**The vocabulary this section is allowed.** PRIMES is **floor-bound, monotone and
collateral-grade**; the numbers are **the cash-flow half**. Not a "savings account" —
that implies redemption, and §5.1 and §12 are explicit that the floor is a protocol ratio
plus a *conditional* bid. Not "equity" — that implies a claim on enterprise profit, where
the NFTs hold a claim on a fixed protocol fee line and §2's principle is that the team
takes fees, never supply. The compressed version is a good internal shorthand and a bad
public claim; §9 carries the rule where the funnel copy is specified.

**What this section does not do.** It does not create late-game value, and no section
can. The rotation is a consequence of a decaying `k_max(n)` sitting next to legs that do
not decay, and it re-describes where value sits in a protocol that is still moving — it
does not rescue one whose head has stalled, because every leg on the asset side is
flow-proportional. That is the first bullet of §12 and this section is not an answer to
it. The asset side does not grow with `n`; it refuses to shrink, in a game whose token
leg shrinks on a schedule this document publishes.

### 5.5 Treasury, staking budget, locked depth

**`DECISIONS.md` D-100 (SIGNED 2026-09-04), with the CUSTODY LADDER AMENDED BY D-147
(2026-09-20), the treasury's own LP DELETED BY D-167, and the LP MINER DELETED BY D-168
(SIGNED 2026-09-23).** This section specifies the one pot of money
in the system that *can* be spent on a decision, the rule by which it funds §5.3's PRIMES
staking without one, the LP custody that elects it, and the LP balance that can never be
spent by anybody.

> **What D-147 and D-168 changed, in one paragraph, because everything below depends on it.**
> D-100's custody tier was a **withdrawal delay**; D-147 made it a **lock term measured from
> the deposit** — the position matures at `lockedAt + term` and withdraws in one message, and
> at maturity the vote stops. D-147 also kept the custody **mining** PRIMES past maturity on a
> flat seven-rung ladder. **D-168 deletes the mining**: LP custody now buys the vote and
> nothing else, the rungs that only ever mined (no lock / 1 d / 7 d) are gone, and **four**
> remain. The treasury's PRIMES leave instead through a monthly, permissionless
> `distribute()` to the stake contract (§5.3). The contracts, backend, app and testnet match
> this section (D-168). It sits inside §5 rather than beside it because two of
> its three parts are defined by what they must **not** touch: nothing here mints, nothing
> here moves `T`, `S`, `pending`, `owed`, `k`, `K_CEIL` or the split, and the ratchet theorem
> is untouched by every line below.

Contracts: `primes_treasury.tolk` (global state), `primes_lp_position.tolk` (one child per
depositing wallet), `primes_lp_sink.tolk` (locked depth); `distribute()`'s recipient is the
stake contract of §5.3. Constants: `shared/params.json` `treasury` (the LP terms, vote
multipliers, cap and proposer threshold) and `staking` (the distribution rate and epoch),
each figure labelled owner-set, owner-proposed-and-sim-validated, sim-selected or
engineering in that block's own `_source`.

#### 5.5.1 The treasury has no key

`primes_treasury.tolk` holds four assets: **PRIMES** (the genesis vest — §3.3, D-100
point 6 as amended by D-166 — which funds §5.3's staking through `distribute()`), **GRAM** (§4.1's 5% line on every mint since `DECISIONS.md` D-152, plus 58% of every
unsold-prime tribute forfeit (D-166) — §4.1, §6 point 2), **LP**
(DeDust PRIMES/GRAM receipts — depositors' custody positions and nothing else, D-167) and,
since `DECISIONS.md` D-151, **tsTON** (§4.3.2's harvested staking yield, which arrives as
tsTON and is not converted — a DEX leg would be a proposal governance has not made).
**Three of the four are proposable — GRAM, PRIMES and tsTON.** LP is not: every LP token the
treasury holds is a depositor's, and `getTreasuryBalances()` publishes each balance. It has
**no owner field, no admin opcode, no pause, no upgrade and no
beneficiary change.** The only one-shot inbound is `set_wallets`, the circular-address
bootstrap every jetton-custody contract in this repo needs, and it refuses a second call.

**There are exactly two ways an asset leaves, and there is no third:**

1. a **passed proposal** (§5.5.2), or
2. **`distribute()`** (§5.5.3), which sends PRIMES to the stake contract (§5.3), at most once
   per interval and never more than its formula.

That is invariant **TR-2** as D-168 rewrote it (the second exit was the LP miner rule), and
it is the claim a reader checks by enumerating the contract's sends rather than by trusting
this paragraph. The consequence, stated rather than discovered: **a mistake in a deployed treasury is fixed by a fresh genesis, not by a
message.** §8's "no admin withdraw path" is not weakened by the existence of a spendable
pot, because the pot holds none of the protected pools — `pending` is the ratchet's, `owed`
is the prime owners', and the treasury holds neither (§3.4).

`§11 Q1 is reopened narrowly and only here.` The economic core stays immutable at deploy —
split rates and caps, the `k` machinery, tribute weighting, every address the split pays.
The treasury was never part of that core: it is the *team's* fee revenue, and D-100 puts it
under the control of the people who supply the pair's liquidity. Governing it changes
nothing a §5 proof depends on.

#### 5.5.2 Two proposal kinds, and what they must clear

**The spending proposal is: transfer `{GRAM | PRIMES | tsTON}` to an address.** Plain jetton or
GRAM transfers. **LP is not a proposable asset** (`DECISIONS.md` D-167): the treasury owns no
LP of its own, so there is nothing a vote could move without touching a depositor's. There is no
parameter-change proposal and no upgrade proposal, because there is nothing in this system a
vote is allowed to reach but one.

**The one: the venue confirmation** (`DECISIONS.md` D-194, `asset = 3`). A venue change on the
ratchet (§11.1) is queued by the proposer key on `primes_venue_timelock.tolk` and cannot
execute until this electorate passes a proposal naming that record's `seq` (`amount`) and the
timelock (`dest`); its `execute` sends `confirm_venue` and moves no value, so the cap below
does not apply and the executor pays the 0.03 GRAM hop. The reason it exists: a re-pointed
DeDust vault receives every flush tranche of `pending`, so the proposer key alone would be an
admin withdraw path (§8). The rules are the ones below, plus one of its own: **the confirming
vote must close no earlier than the record's `eta`** — open no earlier than `eta − voteDuration`
(`timelock_vote_before_notice_end` 808; `DECISIONS.md` D-194 as amended 2026-11-19, audit H1).
Only LP locked before a vote opens may vote on it (§5.5.5, 1202), so a vote opened at `queue`
time could be opposed only by positions that already existed. Opened at the end of the notice,
it can be opposed by anyone who locked during the whole 30 days. Because every proposal's vote
opens one treasury notice after it is proposed (the table below), the confirming proposal is
**proposed no earlier than `eta − noticeDuration − voteDuration`**; the timelock's two checks
read the VOTE's window (`opens`, `closes`) and did not change. 807 (`voteOpens >= queuedAt`)
therefore bounds when the vote opened, not when the proposal was written; 808 is the binding
check, since the timelock's delay is far longer than a vote. A vote nobody casts fails —
but the proposer's own 30-day lock is a voter, so an empty or passive electorate does NOT stop
a venue change; what stops it is a holder who locks inside the notice and outvotes it.
A change that executes while a flush is in flight does not strand that tranche and is not
held up by it (§4.3: the trip keeps the venue it was sent to).

| Rule | Value | Where it is enforced |
|---|---|---|
| Proposer threshold | **≥ 1%** of eligible weighted LP (`propose_min_bps = 100`) | multiplied out, never divided, so a small electorate cannot round the threshold to zero |
| Open proposals per proposer | **one**, meaning one that has not reached `closes` — in its notice or in its vote | a proposal past `closes` is settled business and frees the slot |
| Notice | **1 day** (`notice_duration_seconds = 86400`, owner-set) between `propose` and the vote opening — for every proposal kind | `opens = proposed + notice`; a vote before `opens` is refused (`treasury_vote_not_open` 1206); `getGov().noticeDuration`, `getProposal(seq).opens` |
| Vote length | **1 day** (`vote_duration_seconds = 86400`) | `closes = opens + voteDuration`, fixed at propose, `getProposal(seq).closes` |
| Passing | **simple majority of votes cast**, `yes > no` — **a tie fails** | the incumbent state keeps the money |
| Quorum | **none** | see §5.5.5 |
| Per-proposal cap | **25%** of that asset's balance **at execute time** (`proposal_cap_bps = 2500`) | TR-3 |
| Execution | **permissionless** after close and for **one more vote length** (D-188 point 7), and **retryable** on a bounce inside that window | `getExecutable(seq)` (1204 once lapsed) |
| One vote per position | recorded on the **voter's own position child**, not the treasury (D-188 point 7) | the child refuses a second (1155); `getHasVoted(seq, id)` on the child |

**Notice, then vote** (`DECISIONS.md` D-173 as amended 2026-11-19; audit R2-H1). A proposal
does not open for voting when it is proposed. It is public for `notice_duration_seconds` first
— row, destination and amount all readable — and only then does its vote run for
`vote_duration_seconds`. So a spend takes **two days end to end** on mainnet (one of notice, one
of vote), and `getProposal(seq).opens` is when the VOTE opens: the proposal was proposed at
`opens − getGov().noticeDuration`, and no separate field stores that. The notice exists because
of §5.5.5's rule that only LP locked before `opens` votes: with no notice, `opens` was the
proposal's own second, and nobody who was not already locked could oppose anything. The notice
and the vote length are two parameters; that they are equal is a property of the values chosen,
and both are divided by the same D-139 clock divisor on a test deploy.

**The cap is measured at execute time, not at open time** (TR-3). A treasury that shrank
between the vote and the execution is respected, and a proposal written against a richer
treasury **fails** rather than draining a poorer one. Three details of "that asset's
balance" are contract facts a surface must not round off:

- **GRAM** is this account's balance **less the value the execute message itself carried and
  less a 0.05 GRAM rent floor**, so a caller cannot inflate the cap by over-funding the
  execute and the account can always pay its own storage.
- **PRIMES** is the whole `primesBalance`. Until D-168 it was the **free** balance,
  `primesBalance − accruedUnclaimed`, because PRIMES accrued to an LP miner were that miner's;
  the miner is deleted, nothing accrues inside the treasury, and TR-1 went with it.
  `distribute()` and a PRIMES proposal draw on the same balance, and each is capped against
  what is left when it runs.
- **tsTON** is the whole `tstonBalance` — nothing accrues out of it and nobody but the
  treasury has a claim on it.
- **LP has no row, by construction.** Depositors' LP (`lpHeld`) is the only LP the treasury
  holds and is never the treasury's to propose — invariant **TR-5**, which since D-167 needs
  no access rule because no proposal asset names LP at all. LP sent with anything but the
  deposit tag is refunded; a giver who wants LP beyond anyone's reach sends it to the LP sink.

**Execute is permissionless** for the same reason `release` is on the vesting lock: the
destination and the amount were fixed when the proposal opened and no field on `execute`
names either, so who calls it cannot matter. A **bounced execute resets `executed` and is
re-executable** — this repo's standing answer to "the send failed and the state already
moved" (`retry_credit`, `retry_mint`).

**The treasury's state is O(live proposals), never O(votes)** (`DECISIONS.md` D-188 point 7).
Config 43 caps an account at 65,536 cells, and a book of one row per (proposal, position)
with no minimum vote weight filled it for roughly 650–900 GRAM of dust positions and votes,
after which `vote` and `propose` failed for ever. So:

- **Who voted lives on the voter's child.** `position_vote` writes
  `voted[(seq, positionId)] = now + voteDuration` on the position child *before* it
  forwards the vote, and refuses a second (1155). The treasury keeps only `yes`/`no` and
  refuses a vote whose proposal closes after that record lapses (1203) — i.e. a proposal
  that opened after the record was written — so the record provably covers the whole
  window it guards. The notice adds nothing to the record's length: a vote is accepted only
  from `opens` (1206), so `now + voteDuration >= closes` whatever the notice is. A refused vote bounces and the child deletes its record (only if it
  is still the same one); every vote first prunes the child's lapsed records. No minimum
  vote weight is added: that would be a governance parameter no sim has produced.
- **A settled proposal is deleted.** A failed one (`yes <= no`) once its vote closes; any
  other once its **execute window** — one further vote length after `closes`, reusing
  `vote_duration_seconds` rather than a new parameter — has passed. `prune(seq)` does it
  permissionlessly (`getPrunable(seq)` answers first), every `propose` prunes the two oldest
  due rows, and the proposer's one-open-proposal slot goes with the row it names. A pruned
  proposal reads back as the empty row, so `getProposal(seq)` answers only for the proposals
  of roughly the last notice plus two vote lengths (a row lives from `propose` through its
  notice, its vote and its execute window; both deletion rules are measured from `closes`, so
  a proposal in its notice or its vote is never prunable — 1205); the per-vote and per-proposal history lives in the
  read index's decoded events.

**`getExecutable(seq)` publishes the answer before the button is pressed:** would this
execute succeed right now, at what cap, against what available balance, and if not, which
error code would it throw. One honest gap is recorded rather than hidden: a
`distribute()` landing between the read and the execute lowers the PRIMES balance, so the
figure is at or above the one the contract will enforce — a UI can show "executable" a
moment before the chain agrees, never the reverse, and it can never show a cap the contract
would exceed.

#### 5.5.3 LP custody: four lock terms that buy a vote, and `distribute()`, the one payout that bypasses it

The treasury is the **custody address** for LP that wants a vote. Anyone transfers DeDust
PRIMES/GRAM LP receipts to it with a tier tag and holds a **position**; several positions per
wallet; a position may be forwarded to the sink (§5.5.4) at any moment. Withdrawal is to the
depositor and nowhere else. Because positions grow per wallet, they live on a **child
contract** (`primes_lp_position.tolk`, one per owner) rather than in a dictionary on the
treasury — config 43's 65,536-cell account ceiling is a consensus limit, not a rent
question, and it is the same finding that put `owed` on the per-prime items (§3.2.1, §3.4).
A child's address is a hash of its code and its owner, and **re-deriving that address is the
whole of the authentication** for every position message the treasury accepts.

**The tier is a LOCK TERM, measured from the deposit** (D-147). A position matures at
`lockedAt + tierTerm(tier)` and `withdraw` is accepted from that instant — one message, no
request behind it and nothing left to serve. `getPosition(id)` publishes `maturesAt` so no
surface has to provoke error 1166 to learn it.

| Tier | Lock term | Vote multiplier |
|---|---:|---:|
| 0 | **30 days** | **1×** |
| 1 | **3 months** | **3×** |
| 2 | **6 months** | **10×** |
| 3 | **1 year** | **30×** |

(`shared/params.json` `treasury.tier_term_seconds` and `treasury.vote_multipliers`.)

**LP custody earns no PRIMES** (D-168). D-147's seven-rung ladder carried a mining weight on
every rung and three rungs (no lock / 1 d / 7 d) that only ever mined; with the miner deleted
those three had nothing left to buy and are gone, and the mining weights, the free-ride bound
and the "vote spread exceeds mining spread" criterion go with them. **The vote stops exactly
at `maturesAt`** — governance is the one thing an expiring term buys, so it is the one thing
the term gates. A matured position is simply LP waiting to be withdrawn, relocked or sunk.

**Restarting a term is one message, and it may never shorten one that is running.**
`relock(id, tier)` moves the position between tiers in the treasury's vote denominator and
restamps the clock at `now`; it pays nothing, because nothing accrues. The assert is
`newTier ≥ tier || now ≥ maturesAt`: a tier free to shorten at will would be a way to hold
the 1-year vote weight on the 30-day clock, which is exactly what D-100's "tier is fixed at
deposit" rule existed to stop. Once the term has been served the old commitment is
discharged and any tier is allowed, shorter ones included.

**Retiring a matured term's vote weight is permissionless, and it changes no rule.** Nobody
sends a message when a term matures, so the two **published** figures — the child's
`getVoteWeight()` and the treasury's `eligibleWeight` — keep counting terms that have ended.
`expire(id)` is the poke that corrects them: anyone may send it, it moves no LP, no PRIMES
and no GRAM, it names no destination, and a second send returns rather than decrementing
twice. **It is not the vote rule.** The rule is the clock: `position_vote` names one
position and weighs it against that position's own `maturesAt`, so a matured term is refused
whether or not anybody has expired it. What the stale figure actually costs is the
denominator of §5.5.2's 1% proposal threshold — an inflated one makes proposing *harder*,
and the party it blocks is the party with both the reason and the permission to fix it
(`flush()`'s argument, with a smaller pot).

**A vote is cast per position** (D-147). A term belongs to a position, so a wallet holding
three live terms casts three votes, and the one-vote record is keyed by `(seq, positionId)`
on that owner's own child — since D-188 point 7 the treasury holds no per-voter state
(§5.5.2). It is not a weaker rule than one-vote-per-wallet: to vote twice
with the same LP a holder would have to withdraw and re-deposit inside the one-day vote
window (deposited again there it would not vote at all — 1202), and the shortest tier is 30 days, so the LP cannot leave in time. The term IS the
anti-replay device.

**Custody keeps the pool's own fee income, and that is the whole of what a position earns.**
The LP receipt never stops being the depositor's (**TR-5**): the treasury holds it and cannot
spend it, so the pair behind it keeps accruing the venue's trading fee for as long as the
position is parked, and a withdrawal returns the same LP now worth more of both sides. The
protocol adds a vote on top of that and nothing else. Neither term touches `S` or `T`.

**The whole path is inside the app, and both halves of it are the player's own
transactions** (D-100 point 5, and the surface rule in §9.1). A player who holds no LP mints
it: a two-sided DeDust deposit — GRAM to the native vault, PRIMES to the jetton vault as a
TEP-74 transfer's forward payload — sent as two messages under one signature, because the
pool pairs the two legs and a player who signed only one would have half a deposit waiting
for a partner that never arrives. **The LP receipt can only ever return to the account that
sent the deposit**: DeDust's deposit schema carries no recipient field anywhere, which is why
parking it here is a second transaction and not a folded-in step. Nothing about this is
protocol — it is the same pool, the same `get_reserves`, and the same vault addresses
`getVenue()` publishes for §4.3's flush — and the app builds it only so that a liquidity
provider is not sent to a front-end that cannot quote this deployment's pool.

**`distribute()`: the treasury's PRIMES go to stakers, once a month, by rule** (D-168,
amending D-100 point 5). Anyone may call it; it runs at most once per interval
(`now − lastDistributeTime ≥ interval`, the interval clock-divided like the ratchet's
`harvest()`), refuses below a named dust figure (`DISTRIBUTE_MIN_BUDGET`, one nano-PRIMES —
it refuses only an empty treasury and is not an economic parameter; the caller pays the gas),
and sends one TEP-74 transfer with a
notification to the stake contract (§5.3):

```
free    = primesBalance                                   (nothing accrues inside the treasury)
budget  = free · rateBps · interval / (10,000 · 86,400)
```

`rateBps` is `staking.distribution_rate_bps_per_day` = **19 bps/day**, the sim-selected figure
the LP miner used to run at, solved from a stated criterion — distribute ~50% of the
treasury's PRIMES in the first year, at roughly the pace the 1,000,000-PRIMES vest funds it.
`interval` is `staking.epoch_seconds` = 30 days, the same beat as `harvest()` but not coupled
to it. So each epoch sends ≈ **5.7%** of the free balance (`19 × 30 / 10,000`). A bounce
restores `primesBalance`, as `harvest()`'s does.

**Why this path is allowed to bypass the vote.** Because the budget is a **fraction of a
balance**, `B_k = B₀·(1 − 0.057)^k > 0` for every finite epoch `k`: **the treasury never
empties.** There is no schedule to exhaust, no cliff, and no "the rewards stopped" state —
the payout shrinks with the pot, and every inflow (a PRIMES donation, the next vest
tranche, a GRAM proposal whose recipient buys PRIMES and sends them back — D-168 Q11)
lifts the whole trajectory from that epoch forward. A rule that *cannot* drain the treasury
has no terminal state a governance process would need to protect against, so putting it to a
vote would buy nothing and would add a governance lever D-100 wanted nowhere. The rule's
other half is the cadence: **`distribute()` at most once per interval, amount = the formula,
never more** — that is TR-2's second exit, and it is checkable by reading one send site.

**Nothing here mints** (**TR-4**). `distribute()` pays from a balance the vest already
emitted; `S` is untouched by every contract in this section, and `p_f` cannot move because of
anything on this page. **TR-1 is deleted** (D-168): it said the treasury's accrual liability
to unclaimed miner rewards was always covered, and nothing accrues inside the treasury any
more. The PRIMES liability lives on the stake contract now, as §5.3's ST-1.

#### 5.5.4 Locked depth, and why it is never summed into `T`

`primes_lp_sink.tolk` takes LP in and has **no outbound message type at all**. Not a guarded
withdraw path — no send to guard. `LpSink.spec.ts` asserts that against the built bytecode,
which is the cheapest possible proof of permanence. Its LP wallet balance is **locked
depth**, published by `getLocked()`, monotone non-decreasing (**TR-6**), and reconciled in
one get-call against that wallet. GRAM sent to that address is also gone; the contract
declares no liability and appears in no §3.4 reconciliation row.

**Locked depth is never summed into `T`, and this is a copy constraint rather than a
preference.** An LP receipt is a claim on a pool whose GRAM/PRIMES composition moves with
every trade, so any figure derived from it is **non-monotonic** — it falls when the pool is
bought through. `T` is the ratchet's GRAM side and §5's theorem is that `p_f = T/S` only ever
rises. Adding a term that can fall would **void the proof outright**, not weaken it. So the
product shows **two guarantees on two panels**:

- **the floor** — `p_f = T/S`, monotone, a redemption ratio (§5); and
- **liquidity** — locked forever (the sink) / committed ≥ 30 days (custody, term still
  running) / withdrawable (custody, matured), each segment its own
  get-method.

No surface — UI copy, doc string, API field name or comment — may present locked depth as
backing for the floor, as collateral, or as part of `T`. It is a *market* guarantee: this
much of the pair can never be pulled. That is worth saying plainly and worth exactly nothing
to `p_f`.

**Locking forever keeps the vote, at the top of the ladder** (`DECISIONS.md` D-214). LP
forwarded from custody to the sink stops being a position — no term, no withdraw, no relock —
but its amount joins **one per-wallet forever total** on the depositor's own position child
(`getForever()`), which votes `amount × forever_vote_multiplier` (×100, owner-set, past the
1-year term's ×30) and never matures. The sink still holds no record and sends nothing; the
vote lives on the child, so the sink's "no outbound message type at all" is untouched. Four
rules make it safe:

- **One total, not a row per lock.** A thousand dust locks write one `coins` field a thousand
  times, so neither the child nor the treasury grows with them; the treasury keeps only the
  aggregate `eligibleWeight` it always kept.
- **Every credit restamps `foreverSince` to `now`.** The whole total is new weight, so LP that
  voted on an open proposal as a term cannot vote on it again once locked forever (1202). A
  top-up delays the total's next vote; it never adds one.
- **Only the position round trip credits it.** `confirm_withdraw` credits the total only for a
  move that left as a sink-forward, and a bounced sink-forward takes the credit back on both
  sides (`restore_position.from_sink`). LP sent to the sink any other way — the genesis seed
  included — carries no vote.
- **It counts in `eligibleWeight`, and so in the 1% propose bar** (owner-accepted). Forever
  weight whose holder stops voting stays in that denominator for good, which raises the bar
  for everyone else; the trade is accepted in writing in D-214.

It votes and proposes under the reserved position id `0xFFFFFFFF` (`FOREVER_POSITION_ID`),
which no deposit can reach.

**The panel shows the SHARE, not the raw LP count, and that is a §9.1 rule rather than a
layout choice.** `getLocked()` answers in LP jetton units whose decimals no get-method
publishes, so the figure on its own is true and uninterpretable — a fourteen-digit integer
in an arbitrary scale, whose digits on the live deployment are an artefact of DeDust's
first-deposit mint rule and not a fact about this game. Divided by
`get_jetton_data().total_supply` on the pool it becomes the share of the venue that can
never be withdrawn, which is the claim the sink actually makes and which is bounded, so it
takes a shape; multiplied by `get_reserves()` on the same pool it becomes that share in GRAM
and PRIMES, which is the depth a seller can count on. Both are derived from three
get-methods and both are labelled as derived; the exact integers stay one press away in
each segment's proof. The remainder of the supply — LP held by outside providers — is a
fourth segment and the only one on that bar that can leave at will. The headline is
therefore **not monotone**, and that is the paragraph above made visible: it falls as the
pair is bought through, which is exactly why locked depth may never be summed into `T`.

*Why a sink and not a TEP-74 burn of the receipt* (D-100, options not taken): a burn is not
**readable**. Turning a supply drop into "how much depth is locked forever" needs an
off-chain baseline somebody maintains and an argument that no other burner exists. A sink
needs neither — the locked depth *is* an account's wallet balance at any block.
Readability beat symbolism.

#### 5.5.5 The electorate, and the two things wrong with it on day one

**The electorate is LP custody, tiers ≥ 30 days WHOSE TERM IS STILL RUNNING, weighted
`amount × voteMultiplier` with multipliers 30 d 1× / 3 m 3× / 6 m 10× / 1 y 30×** — owner-set
as governance rather than economics, carried in `params.json` with a `_source` rather than as
a contract literal — **plus the forever total of §5.5.4 at ×100, which never matures**
(`DECISIONS.md` D-214). A **matured** position loses its vote (§5.5.3, D-147), and since D-168 a
position earns nothing, so the vote is all a term buys. **The operator's LP votes like
anyone's.** Vote weight is a
pure function of `(amount, tier, now)` — no snapshot, no oracle, no `p_f` read (**TR-7**),
enforced per position at vote time against that position's own `maturesAt`. **A position
votes only on proposals whose VOTE opened AFTER it took its current weight** (`weightSince <
opens`, `treasury_vote_locked_late` 1202), so nobody can lock LP — or upgrade a term's
multiplier — once a vote is running to swing it. `opens` is the end of the proposal's notice
(§5.5.2), not the moment it was proposed, so **LP locked during the notice does vote**
(`DECISIONS.md` D-173 as amended 2026-11-19) — **but only as a NO.** A **YES** needs weight
held since the proposal's own second (`weightSince ≤ opens − noticeDuration`, also 1202;
D-173 as amended 2026-11-21). So the notice is the window in which a holder who sees a
proposal can still lock and vote no, and it is NOT a window in which its proposer can lock
more and vote yes. **The opposition moves last.** Every lock is public the moment it lands
(`getGov().eligibleWeight`, each child's `getPosition`), so the whole yes side is readable
when the notice starts; a proposer who tops up during the notice adds nothing to the yes, and
the defenders have the full notice to answer. What it does not stop: a proposer who locked
more before proposing than the defenders can lock in one day, and a proposal nobody opposes. A position whose term matures before `opens` casts nothing — weight is read at
vote time. `weightSince` is stamped at deposit; a relock at the
SAME tier before maturity only extends the term and keeps it, so extending mid-vote never
costs the voter that proposal, while an upgrade or the revival of a matured term restamps it.
A vote cast before an upgrade stays counted. `getPosition(id)` publishes it.

**The two PUBLISHED aggregates are upper bounds, and saying so is part of the spec.** The
child's `getVoteWeight()` and `getGov().eligibleWeight` are maintained by messages, and no
message arrives at a maturity — so between a term ending and its `expire` they still count
it. Neither is ever wrong in the direction that lets somebody in who should be out: the
RULE is the clock and it is exact, and an inflated `eligibleWeight` only makes the 1%
proposal threshold harder to clear. A client that needs the live figure has it, because
`getPosition(id)` publishes `maturesAt` per position.

*Why LP and not PRIMES holders* (D-100, options not taken): TON has no vote snapshot, the LP
custody position is already a lock with a published clock, and liquidity providers are the
natural electorate for a treasury that — when D-100 was signed — existed to pay them. D-168
moved the payout to PRIMES stakers and kept the vote where it was (its Q7: stakes do not
vote), so the electorate is now the people whose depth the flush swaps against, not the
people the treasury pays. A fixed PRIMES threshold was
rejected outright for a different reason — 10,000,000 PRIMES is 3.5 GRAM at genesis and
3.2 M GRAM at the modelled year-3 floor, so any token count is a threshold that means two
completely different things across the game's own horizon.

**Two consequences were accepted in writing (D-100 point 10), and a spec that omitted them
would be marketing.**

**(a) On day one the electorate is EMPTY.** The operator holds no PRIMES since `DECISIONS.md`
D-166, so there is no operator LP position either, and nobody else has locked LP for 30 days
yet, because the game is hours old. `getGov().eligibleWeight` reads 0 and no proposal can be
voted through until someone locks. "Holders govern the treasury" is therefore true **in
mechanism and empty in fact** until strangers lock ≥ 30 days. The mechanism is real and
immediate — the treasury genuinely has no key from block one — but the electorate is a thing
the game has to earn, not a thing the deploy delivers. *(D-100 point 10a said "the operator
alone" and named the operator's 10× six-month position as the first defence below; D-166
removed that position, and the owner ruled 2026-09-23 to state the empty electorate rather
than create one.)*

**(b) With no quorum, the first 30-day locker passes a proposal unless someone with more
weight votes no.** That is what "simple majority of votes cast" means with nobody obliged to
show up, and it is the honest reading of the rule rather than an edge case. There is no
standing position that outweighs a newcomer; the defences are rules, and all three are
get-methods:

1. **the 25% per-asset cap** (`getGov().proposalCapBps`) — a proposal cannot take more than a
   quarter of one asset, measured at execute time, so no single passage empties anything;
2. **the notice, then the vote** (`getGov().noticeDuration`, `getGov().voteDuration`,
   `getProposal(seq)`) — the proposal, its destination and its amount are public for the
   one-day notice before its vote opens, and its running tally for the one-day vote before
   anyone can execute it: **two days end to end**. Anyone may lock ≥ 30-day LP **inside the
   notice** and vote no once the vote opens; a lock made after `opens` does not vote (1202).
   This is the defence in the form that is true: until the 2026-11-19 amendment to
   `DECISIONS.md` D-173 this point said "lock inside that window and vote no" while the
   contract opened the vote in the proposal's own second, so no lock made in response could
   vote at all (audit R2-H1, reproduced). **What it buys is that a spend is OPPOSABLE, and no
   more than that.** A defender has one day to notice the proposal, acquire DeDust LP and lock
   it; the proposer cannot answer, because a yes needs weight held since the proposal was
   made (D-173 as amended 2026-11-21) — the defenders move last. A proposal nobody votes
   against still passes on its proposer's dust. So the notice defeats any proposal whose
   pre-proposal yes weight the watchers can outlock within a day. It does not stop a
   proposer who locked more than that BEFORE proposing, which is what "simple majority of
   votes cast" means. *(For a **venue confirmation** the window is the timelock's
   whole 30 days: the record is public from `queue`, the vote may open only at its end (808,
   §5.5.2), and LP locked at any point before it opens votes no on it — audit H1, 2026-11-19; a yes
   needs LP held since the confirming proposal was made, D-173 as amended 2026-11-21.)*
   **That is two days TOTAL, not two days per step** (`DECISIONS.md` D-130, signed
   2026-09-16, as amended 2026-11-19). The "one open proposal per proposer" rule is keyed by
   ADDRESS, and addresses are free: a proposer willing to split their locked LP across `w`
   wallets opens `w` proposals in the same hour, waits the notice and the vote once, and
   executes them in sequence, because `execute` is permissionless and ordering it is trivial.
   Days to drain 90% is `2 · ceil(9 / w)` — 2, not 18;
3. **the 1% proposer threshold** (`getGov().proposeMinBps`) — multiplied out against
   `eligibleWeight`, so it only bites once the electorate is more than one wallet.

The **fraction** bound needs no electorate to verify: the cap is measured at execute time, so
`k` executes can never leave less than `0.75^k` of the asset, whoever calls them and however
they are timed. What the wallet split defeats is the CALENDAR, and D-130 declined to legislate
it back (a cooldown between executes would delay a legitimate multi-tranche spend by the same
day, and lets a small passing proposal be used to hold up a larger one). So on an empty or
thin electorate **the calendar has no brake beyond the two days**: the treasury's worst case is
the fraction bound alone, reached two days after the proposals appear unless someone locks
inside the notice and outvotes them, and a reader deciding whether to lock LP — or whether to trust the treasury's balance —
should read it that way.

#### 5.5.6 Where each number comes from

Every figure in this section maps to a get-method (§9.1), and the ones that come from the
sim or from an owner decision are in `shared/params.json` with a `_source` — the LP tier
terms, vote multipliers, cap and proposer threshold in `treasury` are owner-set;
`staking.distribution_rate_bps_per_day` is the single sim-selected figure (renamed from
`treasury.miner_rate_bps_per_day` by D-168) and `staking.epoch_seconds` is owner-set. **Nothing
in this section is a literal invented in a contract or in the UI.**

Treasury: `getTreasuryBalances`, `getTreasuryCounts`, `getGov`, `getProposal(seq)`,
`getExecutable(seq)`, `getVotable(seq)` (is the vote open by the block's clock, and if not
which code a vote would throw — 1206 in the notice, 1154 once closed), `getPrunable(seq)`,
`getVoteMultipliers`,
`getTierTerms`, `getPositionAddress(owner)`, `getTreasuryActions`, `getTreasuryMinForward`,
`getTreasuryConfig`, and `getDistribution()` → `(lastDistributeTime, interval, rateBps,
nextBudgetEstimate, distributedTotal, stakeAddr)` — the `distribute()` state, `interval`
clock-divided, the estimate being the handler's own formula over today's balance. **Deleted with the miner (D-168):** `getMiner`,
`getMinerSolvency`, `getTierWeights`. Position child: `getPositions`, `getPosition(id)`,
`getVoteWeight`, `getTierTerms`, `getPositionOwner`, `getPositionMinForward`,
`getHasVoted(seq, positionId)` and `getVotedCount(seq)` (the one-vote record, moved here from
the treasury by D-188 point 7; `getAccrued` goes with the miner). Sink: `getLocked`, `getEvents`, `getLpSinkConfig`. The stake contract's
own get-methods (§5.3) include `getStakeSolvency` (ST-1).

## 6. Genesis: no auction lot, no queue-lock

**Superseded 2026-08-16.** Everything below replaces the K-lot genesis auction this
section previously described (90-day Buy Now ceiling over ascending bids on a
pre-deployed set `{2,3,5,7,11,13}`) and supersedes D-5's genesis-fold amendment to it.
There is no genesis-specific auction format left in this design. Every prime — starting
with 2, and including every prime after it — clears through the same single mechanism
D-4 already defined for "a prime reaching the head": a per-prime descending (Dutch)
auction, buy-now only, resting at `restingPrice(p)` (never below 1 GRAM; D-88, D-99), no expiry. Genesis's only remaining job is
to start the game and open that mechanism; it does not get its own pricing curve, its own
bid lane, or its own bootstrap contract.

**Vocabulary note, because the phrase survives elsewhere in this document.** Where §3.2,
§8, §10 and §11 say *"the genesis auction"*, *"the genesis primes"* or *"the blue chips"*,
read: **the small primes, sold on the same universal descending lane as every other
prime.** They are still the numbers with the largest tribute NPV and still the ones §3.2's `√p` weighting is paid for out of.
What no longer exists is a distinct sale, a distinct format, a distinct set, or a moment
after which the lane closes.

Bootstrap sequence, fully scripted on-chain:

0. **Unity — number 1 — is minted first, and minting it is what starts the game.**

   Genesis is not one transaction. It deploys the whole contract set, seeds the pool,
   funds the bounty vault, seals the jetton authority and seeds `T`/`S` — minutes of
   work on a real network, any step of which can fail. Under a pipeline alone, "the
   game is live" is therefore a property of a script having got far enough: observable
   only by reading five contracts and reasoning about which messages landed. That is
   the wrong shape for the one fact every player, and every auditor, needs first.

   So the deploy script builds the game and leaves it **closed**, and a single
   founder-signed message — `ignite` — starts it:

   - it mints **`n = 1`** to the founder as an ordinary, transferable TEP-62 item
     carrying the `RARITY_UNITY` flag;
   - it flips the ledger's one-shot `launched` bit, opening `mint` and
     `mint_won_lot`;
   - it sends `launch_open` to the market, opening the ascending lane for every number
     ahead of the head (§4.4) and, per point 1 below, the per-prime Dutch lane for **every prime with no
     mintable composite ahead of it** — which at genesis means 2 and 3 open
     simultaneously, since both sit before the first composite, 4.

   **Unity is economically inert, and not by exception.** Nothing in §4.1's split can
   reach `n = 1`, because every line that pays a number requires something 1 does not
   have: the referral key must be `≥ 2`; a cited tribute factor must be a *marked*
   prime, and 1 is never marked; the flat dividend divides among `π(n)`, which does not
   count it. It moves neither `T` nor `S` nor the head, so it is absent from the floor,
   from the supply, and from every other holder's `k`. It costs nothing but gas —
   charging for it would put founder capital through the split at `n = 1`, where
   `k_max(n) = 2.7/log₁₀(n)` is undefined, which is the arithmetic making the same
   point this paragraph does.

   It is an NFT, a founder's artifact, and the on-chain record of who started the game.
   It is transferable like any other item, and it earns its holder nothing in any era.

   **The launch is a starting gun, not a pause switch.** There is no un-ignite message
   on any contract — `launched` only ever goes 0 → 1, and a way to close the game again
   would be exactly the admin lever §8 forbids. The one repair that exists,
   `sync_launch`, is **permissionless** and can only open: it re-sends the `launch_open`
   the market may have missed, and every receiver's handler is one-shot.

   The visible consequence, and the §9.1 obligation it creates: the collection holds one
   more item than the head implies. `head − 2` is the count of sequentially minted
   numbers; the item count is `head − 2 + launched`, and the ledger publishes both from
   `get_launch()` rather than leaving the UI to add the term itself.

   The second §9.1 obligation is about what the app may *offer*. While `launched = 0`
   every gated control must be **absent or disabled, not merely discouraged** — a mint
   button that signs into a `ledger_not_launched` refusal costs the user gas to learn
   what the app already knew. And the converse, which matters more: a client that cannot
   read `get_launch()` — an older deployment without the method, a failed read — must
   treat the game as **open**. There is no gate on a ledger that has no flag, and
   rendering an unread bit as "closed" would black out a running game to protect against
   a refunded transaction. Fail open, and gate only on a positive `launched = 0`.

   Unity also breaks the one place the UI's number-class switch is two-way: n = 1 is
   neither prime nor composite, so any surface that renders `is_prime` as a binary must
   carry a third answer for it rather than calling it composite.

1. **Every prime clears through one uniform, genesis-free Dutch lane — no queue-lock,
   ever.** The sequential head is defined **over composites (and Unity) only**. A prime
   is never a candidate for direct 1-GRAM sequential mint at all, so it can never be the
   thing the head is waiting on:

   ```
   restingPrice(p) = max( NPV(p) / 2 , P0(p) / 3 , MINT_PRICE )
                                              [D-88 point 1; the P0/3 term is D-99's,
                                               replacing the deleted tier `price_min`]
   D(t) = max( P0(p) · (1 − t / DECAY_SECONDS) , restingPrice(p) )   the standing price
   buy(p)      pay D(t) → settles immediately, in the same transaction
   no buy      D(t) rests on restingPrice(p) and stays there —
               the lot never expires and never re-opens a bid lane
   ```

   Since `P0(p) = 1.5 · NPV(p)` comes off the same table, opening to resting is a **3×
   spread** on every prime the table covers.

   This *is* D-4 (`primes_market.tolk` `MODE_DUTCH_BUYNOW`) applied uniformly, with the
   genesis-specific K-lot and its ascending bid phase (previously D-5) deleted rather than
   amended. There is no `bid()`, no escrow, no refund path and no clock re-opening: a buy
   is a purchase, not a bid, and it is final the instant it lands.

   **Every prime decays to its own resting price — not to a universal floor.** This is
   `DECISIONS.md` D-88 point 1, which **deleted invariant MKT-1** and the older claim
   ~~"every prime decays to exactly `MINT_PRICE`, never a per-prime floor"~~ that stood here.
   A small prime rests well above 1 GRAM because it earns tribute on every multiple, forever;
   a prime past the finite `NPV` table rests at `P0(p) / 3`, or at exactly `MINT_PRICE` when it
   opens under 3 GRAM, which is the *lower bound* on the resting price and the only case where the two coincide. The liveness this
   used to be argued from is unaffected and comes from elsewhere: the head is defined over
   composites, so a prime nobody buys blocks nothing at any price (§12). What survives of
   MKT-1 is that the resting price is **write-once from `n` alone** — computed at the moment
   the lot record is created, proposed by no message and updated by no handler.

   **The clock starts automatically, with no click, no admin trigger and no lookahead
   window.** A prime `p` opens the moment it is *next* among not-yet-built numbers — i.e.
   the moment the head (which only ever advances over composites) reaches the last
   composite before `p`. Where a run of consecutive primes sits between two composites,
   all of them open simultaneously: after Unity, 2 and 3 both open at once, because
   nothing composite precedes either of them, and **4 is the next number available to
   build.** This retires D-4a's `lookaheadH` parameter entirely — there is nothing to look
   ahead of, because a prime never blocks the head in the first place, so there is no
   stall to buy insurance against with a lookahead window.

   **`P0(p)` is a Phase 1 sim output per prime**, on the same `1.5×`-fair-value logic §9.6
   already describes, but it no longer sets a clearing *deadline* the way the old 90-day
   slope did — `DECAY_SECONDS` (one sim-derived constant, shared across every prime) is
   the only schedule term, and it governs how fast the price *approaches* `restingPrice(p)`,
   not when a sale must happen. A prime that never sells simply sits, indefinitely, sellable
   at its resting price at any time — there is no "genesis primes cost nothing to leave
   unsold" liquidity failure to defend, because the resting price is derived from the
   prime's own tribute value and never falls below the 1 GRAM a composite costs.

   Fair value has three of the four legs the old K-lot copy enumerated, and the auction
   surface must disclose all three: inbound tribute (§3.2), the self-tribute minting
   discount (§3.2) and referral-key income (§3.1 — `r2` is the most memorable key on TON).
   The fourth, constellation potential, was a collectible leg after `DECISIONS.md` D-102 and
   is gone with constellations (D-202). Buyers
   receive the pen on their number (§4.7.1) **and +1 prime rank,
   like any prime holder** — 2 and 3 included. *(Corrected 2026-08-19, `DECISIONS.md`
   D-38. This passage used to carve out "no prime rank and no credit" for lot buyers. That
   carve-out predates D-20: it existed to avoid rewarding a bootstrap path that granted a
   pre-verified prime as richly as a real sequential mint. **D-20 erased that distinction
   structurally** — since there is exactly one lane, every prime including 2 and 3 settles
   through the same on-chain Miller–Rabin-verified mechanism, so there is no easier path
   left to tell apart. `primes_ledger.tolk` has always granted the rank unconditionally;
   the code was right and this sentence was describing a world that no longer exists.)*
2. **While a prime has NO OWNER, its tribute line is forfeited — never to
   the pool, and never to any NFT holder, Unity included.** Every mint that lands while
   prime 2 sits unsold sends 2's share of the tribute line out as fee revenue
   instead of accruing anywhere, permanently and visibly (`getForfeited(p)`, one counter
   per such prime). The forfeit is settled at the moment of the mint — since D-100 point 6
   it is **two sends in that same transaction, 58% to the governed treasury contract and
   42% to the operator** (D-166; §4.1, §5.5), nothing held anywhere — and the
   counter is monotonic: a sale stops it, nothing rewinds it.

   **D-90 widens "unsold" to "no owner", which is what it always meant.** There are two ways
   a cited prime factor can have no owner, and they now both land here. The first is the
   original: the prime is on the market and nobody has bought it. The second arrives with
   instant mint — a composite bought ahead of the head may cite a factor that is itself ahead
   of the head, so the head-advance walk has never crossed it, it is not marked, and no item
   for it exists to credit. Sending `credit_tribute` to a nonexistent item would simply
   bounce; forfeiting is the rule already written, applied to the second way of having no
   owner. Nothing about the counter changes: `getForfeited(p)` still means "tribute forfeited
   while `p` had no owner".

   **The counter moves house at the sale** (`DECISIONS.md` D-188 point 4): while `p` has no
   owner it is the ledger's `getForfeited(p)`; the sale deletes that row and hands the total
   to `p`'s new item, where `getForfeited()` publishes it, frozen. A prime's lifetime figure
   is the two read together — the ledger half is zero once `p` is owned, except for a share a
   mint decided while `p` was unsold and whose `mint_confirmed` (D-117) landed after the sale.

   **Beyond the import frontier the counter is a sum, not a row** (`DECISIONS.md` D-196). That
   far ahead the ledger cannot tell an owned prime from an unowned one — a prime sold there is
   marked on its lot block — so a cited factor beyond the frontier is **credited to its item as
   if owned**. An owner is paid as always. With no item, none waiting in `retry_item`'s
   lane and none on its way, the credit bounces, and the bounce forfeits it. "On its way" is
   a prime whose `mint_item` has left the ledger and whose item has not yet sent its
   `mint_confirmed` (GAUNTLET V32, D-199): a credit can overtake its item's deploy (one hop against
   two), so while one is in flight a bounced credit goes back to the retry lane instead.
   The receipt comes from the item and not the collection because TON orders messages only
   between one sender and one receiver: the item's own receipt is the one message certain
   to arrive after a credit that item bounced. An item that exists but was never
   populated counts as no item: its empty state is public, so anyone can deploy it, and it
   refuses every credit (`item_not_populated`, 307) so that nobody can park a far prime's
   forfeit on it and then win the lot. The bounce forfeits it: paid 58/42 with the next mint's fee
   legs and summed into `getForfeitedBeyondWindow()`, because a per-prime row there would be a
   word the buyer of a far lot chooses on the ledger. `getForfeited(p)` for such a prime counts
   only what was forfeited once its block was inside the frontier. The money is fully
   accounted; the per-prime attribution of the far part is what is given up.

   **Behind the head, once a block is flushed, the counter is a sum too** (`DECISIONS.md`
   D-198, for the same reason: a row per unsold prime filled the ledger). `flush_unsold` moves
   each unsold prime's counter, frozen, to its block's lot block (`getBookmark(p)`); a forfeit
   on that prime afterwards is paid 58/42 exactly as before and summed into
   `getForfeitedBeyondWindow()`. A prime's lifetime figure is the ledger's row, its item's
   counter and its lot block's frozen counter, plus its share of that sum.

   **Routing to the treasury, not the ratchet pool, is a deliberate change from the old
   K-lot design** (which forfeited to the pool) **and treasury was chosen over both the
   pool and any NFT holder for the same reason the old design rejected accrual-to-holder**:
   crediting Unity or any other specific item would make that item a passive-income asset,
   directly contradicting "Unity is economically inert... earns its holder nothing in any
   era" (point 0 above). Crediting the pool was the K-lot's original choice, and is still a
   legitimate alternative, but treasury was chosen instead because forfeited tribute is
   revenue the protocol failed to *deliver* to a prime owner who doesn't yet exist — it
   is closer in kind to the ordinary treasury cut of §4.1 than to the ratchet's floor-price
   mechanism, and routing it there keeps the ratchet's `T`/`S` accounting untouched by a
   number that has nothing to do with rebate emission.

   Waiting still has no upside: the prime's own tribute income is never escrowed for its
   eventual buyer, so nobody profits from a coalition holding out for a lower price, and
   the price only ever falls toward — never below — `restingPrice(p)`, which is written once
   from `p` and moved by no bid.
3. **Genesis allocation — disclosed, nominal-sized, none to the operator; the pair is posted
   by hand after the donation, not by the deploy script**
   (`DECISIONS.md` D-46, supersedes D-19 and this point's earlier founder-seed reading;
   D-140/D-154 put a floor-priced genesis pair back into the launch sequence;
   D-166 deleted the operator's share).
   The genesis `S` allocation is declared at deploy from a **nominal** sizing input, never
   from a real GRAM deposit and never from auction proceeds:

   ```
   T₀ = 200 GRAM (nominal)          sizes supply only — NOT deposited into any pool
   L  = 10,000 PRIMES per GRAM      the sizing ratio (same knob the old LP ratio used)
   V  = 7.80 · T₀ · L = 15,600,000 the bounty vault: contract-held, pre-counted in S (§3.3; D-204)
   A  = T₀ · L / 2   = 1,000,000   the treasury's vesting lock (D-100 point 6; D-166 deleted the operator's half)
   S₀ = A + V        = 16,600,000 PRIMES  (no PRIMES mint to the operator, §2 principle 4)
   T (real, at deploy) = 0         no deposit; p_f = T/S₀ = 0 until the floor donation below opens it
   ```

   **No deploy step deposits into DeDust; the launch sequence does.** The `T₀·L` figure that
   used to fund a seeded LP minted, under D-46, to the operator (later into a vesting lock,
   then half of it into the treasury's, D-100 point 6); **D-166 deletes the operator's
   share**, so only the treasury's 1,000,000-PRIMES lock survives in `S₀`. Between the
   donation and `ignite` the operator pairs the PRIMES the floor donation mints them (below)
   with their own GRAM into the DeDust pool by hand, using DeDust's own permissionless deposit
   flow, and sends the LP receipt to the LP sink (D-154) — so the game opens against a
   floor-priced, locked pair rather than an empty pool. The **internal floor** `p_f = T/S` is `0`
   at the instant of deploy — no deposit backs `S₀` — and is opened by the **floor donation**
   below rather than by any deploy step (D-91 point 4, D-92, D-100 point 2, D-154): the
   operator donates **200 GRAM** (D-204; 132.50 under D-154).

   ~~It is not a chosen figure but the solution of `p_f = X/(S₀ + X·L)` for the declared
   opening floor, `X = S₀/(1/p_f − L) = 12,000,000/(60,000 − 10,000)` = **240 GRAM**, landing
   `p_f` on `1.667e-5` = `1/(6L)` — one sixth of the `L` market price, which is what
   `genesis.market_over_floor_at_open = 6` states.~~ **Superseded by D-100 point 2:** the
   operator will not fund 480 GRAM (240 donated plus 240 paired), so the *input* changed and
   the derivation did not. `genesis_donation_ton` is **owner-set, not sim-selected**, and the
   sim re-derives the floor from it. **D-154 sets it to `132.50`** — D-100 point 3's whole
   150 GRAM commitment, front-loaded into genesis instead of dribbled in afterwards, because
   the pair below is pinned at the floor and that makes opening depth *quadratic* in this one
   figure. **D-204 sets it to `200`** and grows the vault by the PRIMES the extra 67.50 GRAM
   backs at that same floor, so the floor holds (it was 1.0761e-05 at D-154's 132.50). So
   `p_f0 = 200/(16,600,000 + 1,972,333)` (the second term is what
   `donate_floor` mints to the donor — `X·L` under D-156's taper — since `S` counts it) =
   `genesis.genesis_floor_price_ton_per_primes` = **1.0769e-05 GRAM/PRIMES** (≈92,862 PRIMES
   per GRAM at open). The opening floor
   is therefore no longer a declared `1/(6L)` constant — it is
   whatever the donation buys. From
   there it ratchets on real mint injections (`pending`/`swapped`) like any other floor step.
   Note the two numbers are different jobs and neither is stale: `T₀ = 200 GRAM` is the
   **nominal** that sizes `S₀` and is deposited nowhere; the **200 GRAM donation** — the same
   figure since D-204, by the owner's choice and not by construction — is the only money
   that actually moves at genesis, and `params.json`'s `_donation_vs_modelled_depth` records
   the modelling gap between them rather than burying it — a gap D-154 narrows to the same
   order of magnitude for the first time, without closing it.

   **THE OPENING PAIR IS POSTED AT THE FLOOR, NOT AT `L` (D-140).** The market price at
   genesis is not a protocol quantity at all — it is the ratio of the two sides of the one
   DeDust deposit the operator makes by hand, and on an empty pool that ratio *is* the price.
   Quoting it at `L` was an inherited convenience: `L = 10,000 PRIMES/GRAM` is the rate
   `donate_floor` mints at (D-39's **denomination knob**, never a price), and while D-92's
   donation equalled the nominal seed the donated PRIMES paired against an equal number of
   GRAM exactly. D-100 point 2 unpinned those, and nothing re-read the pairing: the book would
   have opened at `genesis.market_over_floor_at_open` = **285.7×** the floor. Two consequences,
   both measured rather than argued:

   - **§4.3.1's floor guard would have refused every `flush()`.** The guard buys only at or
     below `p_f`; 286× above it, the protocol's own bid is two orders of magnitude out of the
     money and `pending` accumulates with no outlet. In the sim's own calibration
     `FLOOR_GUARD = 0` bounces **1,082 of 1,089** attempts.
   - **The first mint's rebate outweighed the pair's whole PRIMES side.** Both figures in
     this bullet were measured at D-100 point 2's 4.20 GRAM donation, which is what made the
     mis-pricing extreme: mint 1 emitted **1,168,800 PRIMES** (9.74% of `S₀`) against a book
     holding 42,000 — 28× — so one 1 GRAM mint sold into it took **≈4.05 of the 4.20 GRAM** the
     operator posted. The premium is not upside the protocol captures; it is a transfer to
     whoever mints first, after which the price is at the floor anyway. **D-154 shrinks both
     halves** — a 132.50 GRAM donation lifts `p_f0` 31.5×, so an `L`-quoted book would open
     9.1× over the floor rather than 285.7×, and mint 1 emits 31.5× fewer PRIMES
     (`docs/audit/genesis-emission-curve.md` is regenerated from the donation). Neither
     change makes `L`-pairing correct; the rule below is what fixes it.

   So the pair is posted at `PRIMES × p_f` GRAM instead, and
   `genesis.market_over_floor_at_open` is **1.0 by construction**. The PRIMES side is the
   binding side — at the floor every PRIMES posted buys only `p_f` GRAM of depth — so it is
   the operator's whole reachable inventory: the **1,972,333 PRIMES** the donation mints
   (`genesis.genesis_donation_primes`: `X·L` tapered by D-156, rounded down to whole PRIMES),
   **against 21.24 GRAM** (`1,972,333 × 10,768 nanoGRAM`, the floor rounded down to the chain's
   granularity). Until D-166 the operator's first vest tranche (250,000) joined it; the
   operator lock is deleted, so the pair is the donation's PRIMES alone.
   The treasury lock's first 250,000 is *not* available and must not be planned around: its
   beneficiary is a keyless contract whose electorate is LP positions in tiers ≥ 30 days
   (D-100 points 7/9), and at genesis there are none. `genesisPairingPrimes` /
   `genesisPairingTon` in `contracts/scripts/genesisPipeline.ts` compute both sides, the
   runbook `runGenesis` prints them, and `seedDedustLiquidity.ts` posts them.

   **Pinning the ratio is also what makes the depth a decision rather than a leftover.**
   Because the GRAM side is `inventory × p_f` and *both* factors rise with the donation,
   opening depth is close to quadratic in it: `m·X / (S₀ + m)` GRAM with `m = L·τ·X` the
   donation's own mint (`τ` D-156's taper) since D-166 (it was `(L·X + 250,000)·X / S₀` with
   the operator's tranche in the pair), which is **14.13 GRAM at D-154's `X = 132.50`**. D-154 chose `X` so the two sides together posted 149.89 GRAM —
   the whole of the operator's 150 GRAM commitment. Without the tranche they post
   **146.63 GRAM**; D-166 leaves the owner-set donation where it is rather than re-solving
   it for 150. **D-204's `X = 200` against `S₀ = 16,600,000` makes the pair 21.24 GRAM —
   221.24 GRAM posted in all, 200 of it donated.**

   **That commitment is D-100 point 3's and D-154 spends it here** rather than
   post-genesis and incrementally through the same permissionless `donate_floor`. It is an
   operator commitment recorded in the decision record, **not a contract rule**: nothing
   enforces it, nothing stops a further donation by anyone at any time, and nothing in this
   document should be read as if something did. What the front-loading buys, beyond the
   book: the ratchet's `pending` — which grows by β on every mint and is the only bid in
   this system that scales — is a live bid from mint one into a market deep enough for
   §4.3.1's `flush()` to fill against, rather than after an unbounded wait.

   **The donation happens BEFORE minting opens, and `ignite` enforces it** (D-93). The launch
   order is **seed → donate → ignite**, and a ledger whose `T` is still `0` refuses to launch
   (error 218, `ledger_floor_unbacked`). This is not tidiness: the rebate is `R = k·I·S/T`
   (§5), unbounded as `T → 0`, so a mint against an unbacked floor emits ~20% of the genesis
   supply for 1 GRAM where the same mint after the donation emits 0.28%
   (`contracts/tests/UnbackedFloorLaunch.spec.ts` measures both). The guard is `T > 0` rather
   than a target floor, because `donate_floor` is incremental — a testnet launch may fund
   itself in tranches, or for less.
   This is also why the §4.3.1 floor guard needs no special genesis case: `flush()` against
   an empty or nonexistent pool simply fails to fill and bounces exactly like any other
   flush the venue can't meet, restoring `pending` unchanged.

   **The vault's share of `S₀` grew 16.7% → 33.3% (D-41) → 50% (D-42) → 83.3% (D-43) →
   90.9% (D-166) → 94.0% (D-204)**, as it went from 20% to 50% to 100% to 500% of the nominal-sized `T₀·L`
   allocation, then D-166 removed the operator's half of that allocation from `S₀`, and
   D-204 took the fraction to 780% alongside a 200 GRAM donation; the
   D-43 jump was made to fund a puzzle campaign (3 riddles at genesis, then one a week for
   3 years, each worth 1 GRAM at claim time) that D-47 replaced with §9.6's special-number
   rebates; the fraction stayed. That is the whole price of the decision and it
   is worth stating in the direction that costs something: the vault is minted, not bought,
   so every PRIMES it adds is backed by no additional GRAM, and the eventual real floor (once
   liquidity and mint injections exist) absorbs the difference. A larger vault is a larger
   giveaway budget paid for by a lower real floor once one forms — nothing else moves, and
   no later mint is affected, because `p_f` ratchets from wherever it starts.

   What the change cannot do is conjure GRAM, and the shape of that limit is the reason
   D-43 will be the last vault-fraction increase without a nominal-seed increase
   alongside it. The vault's worth is `T₀ · pct/(1 + pct)` (still read against the nominal
   `T₀`, since that is what the vault's PRIMES-per-GRAM ratio is calibrated to): 33 GRAM at
   20%, 67 at 50%, 100 at 100%, 166.67 at 500%, converging on `T₀` however large `pct`
   grows. Each doubling buys strictly less than the last, and none of them reaches 200 GRAM.
   **A stock-funded growth budget is bounded by the nominal seed**, which is why §9.4
   cannot pay 10,000 players 0.5 GRAM each — that is 5,000 GRAM, twenty-five times the
   nominal figure — and why D-42 buys the headcount with time instead. Past 500% the only
   lever left is `T₀`. **D-204 pulled the other one that exists since D-100 unpinned the
   donation from `T₀`:** 500% → 780% *with* 132.50 → 200 GRAM donated, sized so the opening
   floor did not fall — the larger vault is paid for in GRAM, not in a lower floor.

   `T₀` sets `S₀`'s sizing, not price. There is no "day-one depth" any more (D-46): the
   real floor is `0` at deploy regardless of `T₀`'s size, and only becomes nonzero once
   real mint injections accrue `T`, or once someone adds real DeDust liquidity that later
   protocol buys can trade against. What `T₀` still determines is the operator's own
   allocation and, through it, the vault's share of `S₀` and every PRIMES-denominated
   figure calibrated against the nominal genesis floor (era bounties, quest rewards, the
   special-number rebates — §7, §9.4, §9.6).

   **`L` is a pure denomination knob, and that is a measured claim, not an assertion.**
   Holding everything else fixed and varying only `L`, the sim produces a bit-identical
   `T` trajectory, an `S` that scales exactly with `L`, and an identical `p_f / p_f0` at
   every sampled day (DENOMINATION_PLAN §1.1: `L = 1,000` and `L = 10,000` both give
   `T = 48,527.4 GRAM` and `45.41×` at day 365). The same argument covers the vault
   fraction's effect on `p_f0`: it moves where the ratchet *starts*, never how it climbs.
   So moving `L` re-derives nothing —
   not `k_min`, not `k_max(n)`, not `K_CEIL`, not the §4.1 split, not the auction
   reserves — and the only obligation it creates is that every PRIMES-denominated
   quantity in the repo moves with it in the same change.

   **The allocation is vested, not liquid** (D-77, re-cut by D-91; since D-166 it is the
   treasury's lock alone). It is minted into `primes_vesting.tolk` and leaves in **four equal
   25% tranches 90 days apart** — one at the lock's start, the last at day 270 (9 months).
   D-91 changed what the allocation is FOR: under D-46 point 3 it was the PRIMES side of the
   pool `flush()` trades against, and the genesis tranche existed so that leg was not dark
   for the first quarter (§4.3.1); D-91 mints the pool's PRIMES side separately at the
   ledger's permissionless floor-donation op (below), leaving this allocation an
   **operations runway** and nothing else — and a runway paid out over two years does not fund a launch.
   **D-100 point 6 split the allocation across two locks** (§3.3): 1,000,000 PRIMES to the
   operator and 1,000,000 to the governed treasury. **D-166 deletes the operator's lock**:
   the operator acquires PRIMES by minting at the head like any player, so §2 principle 4
   has no exception. What remains is the treasury's 1,000,000 PRIMES, same 4 × 25% / 270-day
   schedule, nothing liquid to the operator at block one. The lock has no owner, no cancel, no re-schedule and no beneficiary
   change; `release` is permissionless and can only ever pay the deploy-fixed beneficiary.
   The cost, stated rather than discovered: a lost beneficiary key strands the unreleased
   remainder forever, which is what "no admin surface" costs and is why §8 forbids recovery
   paths everywhere else too.

   **The pool's PRIMES side is minted at a permissionless floor donation, at any time,
   by anyone** (D-91 point 4 as amended by D-100 point 1, `donate_floor` on
   `primes_ledger.tolk`). Send `X` GRAM to the
   ledger and three things happen in one transaction: `T` rises by `X` and the GRAM is
   forwarded to the ratchet as `pending` like every other injection; **`seedT` is not
   touched** (D-100 point 1 — see the correction below); and `S` rises by the **emitted**
   amount, minted **to the sender**, who pairs and
   locks them on DeDust themselves. It is incremental — unlike the one-shot genesis seed,
   which asserts a virgin ledger — so the operator can send 10 GRAM, read the floor, and then
   send the rest. It takes money in and never out, so §8's no-admin-withdraw rule has
   nothing to gate here, and it is open to strangers by design: anyone who calls it is
   donating backing to every holder at once.

   **The rate is the floor, and error 217 is deleted** (D-100 point 1). The emission is

   > `emitted = min(X·L, X·S/T)`, and `X·L` when `T = 0`.

   ~~At a fixed emission rate a donation moves the floor from `T/S` to `(T+X)/(S+X·L)`,
   which converges on `1/L` from below and would *dilute* above it, so the contract refuses
   a donation that would lower the floor (error 217).~~ **Superseded.** `X·S/T` is not a
   rate the contract invented (CLAUDE.md rule 3): it is *the* floor — a donation at the
   floor buys exactly what a redemption at the floor would return, which is the only rate
   that neither dilutes the holders nor overpays the donor. D-91's own closing note
   pre-approved the clamp as "the one-line change" if late donations were ever wanted, and
   D-100 point 1 takes it. **The clamp makes dilution unreachable by construction**, so
   there is nothing left for a guard to throw and error 217 stays retired and unassigned.
   Rounding is **down**, and that direction is load-bearing: the floor after the donation is
   `(T+X)/(S+⌊X·S/T⌋) ≥ T/S`, equal only when the division is exact. A donation so small
   that the floor rate rounds it to zero is refused rather than taking the GRAM for nothing.

   **`seedT` is not incremented, and this is a correction, not a refinement** (D-100 point
   1, amending D-26's propagation). D-91 specified two contradictory halves — a `seedT`
   credit *and* `handleClearingCleared`'s forward-to-the-ratchet shape — and the contract
   implemented both, so every donation raised the identity's right-hand side by `2X`
   against `X` on the left. On the live testnet the ratchet panel reported `beyond T
   4.000 GRAM` against `seedT = 4.000 GRAM`: the alarm was right and the books were wrong.
   `seedT` returns to meaning exactly what D-26 says — capital credited **straight into
   `T`** that never passes through the ratchet's `pending` — which in this deployment is the
   one-shot genesis assignment and nothing else. §5's `T = seeded + swapped + pending` closes
   from get-methods alone, with the donation's `X` counted once, in `pending`.

   **And the pair-and-lock is not atomic** (D-91 point
   6, D-100 point 4): between the mint and the operator's DeDust deposit those PRIMES sit
   liquid in a wallet. Closing that would need an on-chain `mint → pair → lock` in one
   transaction; the DeDust deposit wire format is now verified in the sandbox (`GAUNTLET.md`
   R13), but the owner kept the manual sequence (D-120, signed 2026-09-24), so no contract
   sends a DeDust deposit. **At genesis the
   donation is 200 GRAM, not 240, not D-100 point 2's 4.20 and no longer D-154's 132.50** (D-204; the
   derivation method is unchanged and only its input moved, three times). The operator's stated
   sequence: donate
   200 GRAM, receive 1,972,333 PRIMES, pair all **1,972,333 PRIMES against 21.24 GRAM** of
   their own (D-166: no vest tranche joins the pair any more) — the floor rate, D-140, not
   the 197.2 GRAM a pairing at `L` would have taken — and send the
   LP receipt to the **sink** (§5.5.4) rather than burning it — a sink balance is directly
   readable as locked depth where a burn needs an off-chain baseline somebody maintains.
   **D-154 makes that last step the decided one rather than a choice of two**: the whole
   opening pair goes to the sink, so the depth the game opens with is locked depth and no
   key can pull it.
   `genesis.genesis_floor_price_ton_per_primes` is re-derived by the sim from 200 GRAM and
   lands at **1.0769e-05 GRAM/PRIMES** against D-204's `S₀ = 16,600,000` plus the donation's
   own 1,972,333; the emission curve that
   follows from it is published *before* deploy in `docs/audit/genesis-emission-curve.md`
   (see the second honest cost at the end of this section).

   **Liquidity is still added manually — but the LP receipt now has a protocol home**
   (D-46 point 4 as amended by D-100 point 4). Nothing is deposited at deploy and no
   contract in this repo builds a DeDust deposit. Whenever the operator (or anyone else)
   adds liquidity to the pool, they hold a normal, withdrawable LP position like any
   other provider, and they then have three choices for the receipt, all of them theirs
   alone: keep it, deposit it into the **treasury's LP custody** for a vote on a 30-day to
   1-year term (§5.5.3, §5.5.5), or send it to the **LP sink**, which has no
   outbound message type and makes that depth permanent (§5.5.4). `flush()` needs none of
   this: it only ever needs the pool to have liquidity, never for any LP to have been locked
   or burned. §8's no-admin-withdraw claim is unaffected — the custody contract holds no
   protocol GRAM, and its only LP paths are back to the depositor or into the sink.

   **A prime-lane clearing splits at exactly `MINT_PRICE`.** The nominal 1 GRAM runs
   through the ordinary §4.1 five-way split like any composite mint; every GRAM above it —
   the entire premium, which for a popular prime is most of the clearing price — splits
   50/50 between the ratchet's `pending` and the governed treasury (`DECISIONS.md` D-114,
   amending D-7's original "no treasury cut"). `T` rises by the ratchet-bound half only, `S`
   does not move at all, and that half of every prime sale's premium is a pure floor step,
   deployed under the same floor guard as any flush (§4.3.1) — this is unaffected by D-46
   and still closes §11.17. **There is no first-clearing special case for a different reason now: minting
   and both market lanes open in the same block regardless of whether a DeDust pool exists**
   (point 4 below) — nothing in the market depends on the pool, only `flush()` does, and
   `flush()` tolerating "no pool" needs no special case either (point 3 above). The genesis mints are the treasury's
   vesting lock named above and the bounty vault (§3.3), both contract-held and
   pre-counted in `S`; the operator holds none (D-166).

   **One consequence worth stating rather than discovering:** the bounty vault is 780% of
   the nominal `T₀·L` (D-204; 500% under D-43), so a 200 GRAM nominal seed sizes it at
   15,600,000 PRIMES rather than the 2,750,000 a sale-funded seed would have produced. The
   *proportion* is fixed — the vault is 78/83 (94.0%) of `S₀` at any nominal-seed size
   (10/11 before D-204, 5/6 before D-166) —
   and its GRAM value ratchets upward with the real floor once one forms, so the first real
   backing that accrues multiplies the vault's purchasing power without minting a single
   new token. But the absolute early-era bounties (§7) are correspondingly small and the
   schedule in `params.json` must be regenerated against `T₀`, not hand-scaled. Since the
   schedule is GRAM-denominated (§7), regenerating it against a different `T₀` moves what
   each ceremony is *worth*, which is the decision being made — where hand-scaling the
   PRIMES amounts would move the token counts and leave the value to the floor.
4. The market (§4.4) opens at the same block as minting — the ascending lot lane for any
   number ahead of the head, prime or composite (`MIN_AUCTION_DISTANCE` is deleted, D-45;
   the reservation lane is deleted, D-30/D-88), and the descending prime lane for every
   prime already eligible. One `launch_open` opens both, because they are one contract
   (§3.4).

The genesis ratio `L` is a real design decision — it sets how "cheap" early rebates feel —
and point 3 fixes it at **10,000 PRIMES per GRAM**. ~~The floor opens at 60,000, the gap
between them being the bounty vault rather than slack; `p_f0 = 1/60,000` holds at any seed
size, so there is nothing for the simulation to solve.~~ **Amended by D-100 point 2:**
`p_f0` is no longer a declared constant that holds at any seed size. It is
`genesis_donation_ton / (S₀ + the donation's own mint)` — **200 / 18,572,333 = 1.0769e-05 GRAM/PRIMES** (D-204; 132.50 / 12,312,854 = 1.0761e-05 under D-154/D-166) — because the
donation stopped being derived *from* a target floor and became an owner-set figure the sim
consumes. `L` is unchanged and is still a pure denomination knob; what moved is where the
ratchet *starts*, never how it climbs (§5). What `T₀` buys is depth, and that is the number the
simulation prices (§10, phase 1).

**Why 10,000 and not 1,000.** The token has to open cheap enough that a small reward is
pocket change rather than a fraction of a mint. At `L = 1,000` the floor opened at
1/1,200 GRAM per PRIMES, so a 100-PRIMES quest reward was 0.083 GRAM — a tenth of the mint
price, which is not what "100 PRIMES" is supposed to feel like. At `L = 10,000` the same
reward is 0.0083 GRAM and a mint's rebate is ~7,020 PRIMES instead of ~702. `10,000` is
chosen over the 8,333⅓ that would land the floor on exactly 1/10,000 because every
derived PRIMES quantity then stays integral (`toNano` refuses more than nine decimals),
and because the exact target buys only a few days of a horizon the ratchet moves through
either way — see §5's horizon note.

The prime lane reduces to **two Phase 1 numbers, shared across every prime** —
`DECAY_SECONDS` and the `1.5×` fair-value multiplier that derives each `P0(p)` — because
every prime's opening price is that multiplier applied to its own simulated NPV, and every
prime decays on the same slope toward its own resting price
`max(NPV(p)/2, P0(p)/3, MINT_PRICE)`
(`sim/scripts/run_phase1.py`, `market.prime_lane`). There is no separate public anchor:
the sim's per-prime NPV table is published in `shared/params.json`, so anyone can argue
with a price before its lot opens.

The honest costs of this format, stated here rather than discovered:

- **The era bounties are symbolic at launch, and that is a decision rather than an
  oversight.** `T₀ = 200 GRAM` funds a 15,600,000 PRIMES vault, of which 3,000,000
  PRIMES (30% until D-204 grew the vault around it) funds all eight era ceremonies (§7). The first one fires
  at n = 6 — within hours of launch, and the one a launch-day audience actually sees —
  and is worth **10 GRAM**. The schedule is front-loaded, so later ceremonies are worth
  less (5.0 GRAM from the 30030-era onward). Those figures moved again with D-43 without
  anyone sizing them by hand: the schedule is a share of the vault's GRAM worth, and the
  vault's GRAM worth went 33 → 67 → 100 → 166.67 GRAM across D-40/D-41/D-42/D-43. It is the
  clearest illustration of what that decision actually did — the ceremonies got more
  valuable again and the opening floor paid for all of it. The bet this encodes: what
  draws a player to a primorial is the trophy, the permanent naming rights and the
  tribute roll call, not the cash. If that bet is wrong, the levers that fix it are a
  larger `T₀` or a larger vault fraction, and they are not equivalent: `T₀` buys the
  value outright, while the vault fraction buys it by lowering the opening floor
  (D-41 through D-43 did exactly that, 20% → 50% → 100% → 500%). Neither can take the
  vault past `T₀`, because `pct/(1 + pct)` converges on 1.

  The ceremonies are **denominated in GRAM, not in PRIMES**, and pay whatever that GRAM buys
  at the floor when they fire, capped by their nominal amount at the genesis floor. A
  fixed nominal PRIMES bounty would inflate with `p_f` — the 30030-era ceremony would be
  worth ~45× its designed value at year one — against a vault sized once, at genesis. The
  GRAM denomination is what makes "the schedule is front-loaded" a statement about value
  rather than about token counts, and it makes the vault drain *more slowly* as the floor
  rises rather than faster.

- **The genesis pair is an operator commitment, not a contract rule** (D-154). Point 3's
  launch sequence posts a floor-priced pair, locked in the LP sink, before `ignite`, so the
  game is designed to open against a real pool. But `ignite` checks `T > 0`, not pool depth:
  if the pair were skipped, rebates would still be provably backed by `T`/`S`
  (§5), and `flush()` would simply fail to fill and bounce like any other unfilled flush,
  restoring `pending` unchanged (§4.3.1). This is not a liveness failure for a prime specifically: a prime can
  sit unsold indefinitely without that being a liquidity failure either, because it is
  always payable at its resting price directly through the market contract (§4.4) — that path
  never depended on a DeDust pool existing. There is no "the primes find owners in weeks,
  not indefinitely" clock to state, because there is no clock: the decay approaches the
  floor and then simply holds there, forever, until bought.
- **The resting price is `max(NPV(p)/2, P0(p)/3, MINT_PRICE)`, not near-zero, and that is
  the entire liveness guarantee** (D-88 point 1, D-99 §1.2). A prime nobody wants clears,
  whenever somebody finally wants it, at a price written once from `p` — never below the
  1 GRAM the game already charges at the head, and for a prime the NPV table covers, half its
  tribute value or a third of its opening price, whichever is higher. Unlike the old K-lot's
  1%-of-`P0` reserve, this floor is never embarrassingly cheap and never a liquidity failure
  to defend: the number is never worth *less* on the auction than it would be as an ordinary
  mint, so there is no scenario where "cheap" is even the right complaint. What is still a
  real cost is time: every mint that lands while a prime sits unsold forfeits that prime's
  tribute share (point 2) rather than paying it to a future owner, so an unpopular
  prime is a slow bleed of revenue the game will never recover, not merely an unsold item.

- **A small genesis makes the early mints hyper-emissive, and the curve is published
  before deploy rather than discovered on the hero** (D-100 point 2, D-154). A mint's rebate
  is `R = k·I·S/T` (§5) and `S/T` is `1/p_f`, so a smaller genesis floor makes every GRAM of
  injection buy proportionally more PRIMES: at D-100 point 2's 4.20 GRAM the floor was 47.6×
  below D-92's and the first mints emitted 47.6× the PRIMES. **D-154's 132.50 GRAM takes
  31.5× of that back** — the same front-loading that buys the opening book also buys down
  the front-loaded emission, and the table below is regenerated from the donation, never
  hand-patched. `docs/audit/genesis-emission-curve.md` measures the
  first 100 mints from the base-case run and is the authority over any prose summary,
  including this one:

  | claim | measured |
  |---|---|
  | largest single mint's emission | **0.15% of `S₀`** (mint 1 emits 0.07%) |
  | first ten mints | **16.5% of all emission over the curve**; no later mint exceeds 0.116% of `S₀` |
  | first hundred mints, cumulative | **4.5% of `S₀`** — `S` grows 1.05×, `T` grows 1.1× |
  | `p_f` over the same span | **monotone at every step**, ending **1.08×** where it started |

  *(As measured 2026-11-11 from D-204's 200 GRAM donation, with §4.1's invite line on at
  3 × 0.1 GRAM — `DECISIONS.md` D-202.
  `S₀` here is the audit file's 18,572,333, the donor's own mint included.)*

  **It decays harmonically, not within ten mints**, and D-100 point 2's drafted phrase
  "self-correcting within ~10 mints" overstated how fast it settles — the correction is
  recorded in the decision itself. What it is **not** is a solvency problem: `p_f` cannot
  fall, `S` is never decremented (§3.3), and every emitted PRIMES is backed by the same `T`
  that received the injection. It is a **dilution schedule**, front-loaded by construction,
  and whoever mints first buys at a floor 1.55× cheaper than D-92's would have been — it was
  47.6× under D-100 point 2's 4.20 GRAM, and D-154's donation is most of that gap. That is
  the cost, and it is a choice rather than an accident.

- **There is no operator breakeven panel, and none is coming without an owner-supplied
  figure** (`DECISIONS.md` D-110). A breakeven stat would be one division —
  `min_launch_budget_ton / revenue_per_mint_ton` — but `min_launch_budget_ton` is the
  operator's own runway target, and no simulation run can produce another party's
  hosting budget. Rather than invent one (`CLAUDE.md` rule 3) or quietly drop the
  figure, the gap is declared: an absent panel is honest, a panel built on a
  placeholder is not.

## 7. Primorial eras

Bitcoin has halvings; PRIMES has **primorials**. The number line is partitioned into
eras by the primorials p# — 6, 30, 210, 2310, 30030, 510510, 9699690, 223092870 — each
era named by the generating prime of the primorial that *ends* it ("the 7-era ends at
210 = 2·3·5·7"; the last is the 23-era, ending at 223092870). There will only ever be
eight, and the enumeration is the contracts' own (`isPrimorial` in the ledger and the
market) and the bounty schedule's (`genesis.era_bounty_schedule`, eight entries). Past the
last boundary the app has a **ninth era state** — index 9 of `shared/eras.ts`
(`ERA_INDEX_MAX = 8 + 1`), "past 223092870" — which carries its own ground tone so the ambient
era gradient keeps working where the boundaries stop. It is a display state, not a ninth era:
no boundary, no ceremony, no bounty. Era boundaries are protocol-recognized:

- **The primorial mint is a ceremony, and it is not for sale in advance.** Whoever mints a
  primorial number receives an era bounty from the bounty vault — a **GRAM-denominated**
  amount, paid in the PRIMES that GRAM buys at the floor when the ceremony fires, capped by
  its nominal PRIMES amount at the genesis floor (§5's horizon note: a nominal bounty would
  inflate ~45× over year one against a vault sized once) — and
  the mint pays tribute to *every* smaller prime factor at once — 30030 = 2·3·5·7·11·13 is
  the one number whose tribute line reads like a roll call of the first six primes.
  **An era boundary is therefore not for sale ahead of the head**, and it is one of the
  numbers the head does arrive at: there is no reservation book (`reserve(n)` was deleted
  by `DECISIONS.md` D-30, genesis lots by D-20), and a primorial cannot be opened as a lot
  at any score (§4.4 point 1b), so it is on neither lane and `getLotLane(n)` answers `-1` for the same
  numbers `getIsOpenable(n)` answers `false` on (D-30/D-31 rename `getIsAuctionOnly`/
  `getIsReservable`; `getLotPrice(n)` refuses these numbers too, GAUNTLET.md C1.4). Every
  argument for closing the hole applies with more
  force at 128 GRAM than at 0.075: a scored fee made a public ceremony cheap to buy years
  in advance, and an auction would make it merely expensive to buy years in advance, which
  is the same privatisation with a better price attached — and a *worse* look, because the
  price would be the headline. Earlier
  drafts of this section expected the reservation book to carry a bidding history on these
  numbers long before the head arrived; that would let one wallet buy a public ceremony
  years in advance, and flat pricing made it *cheap* to do so. The contest is still the
  point — it is now a contest at the head, in the open, when the moment comes, rather than
  a purchase settled quietly in advance.
- **Era rollover refreshes the game board.** Each new era pays its primorial bounty and
  trophy (§7, §4.7) — so the content calendar is written by the number
  line itself, not by a marketing team.
- **The countdown is the retention widget.** "1,204 numbers until the 30030 ceremony" sits
  next to the k(t) clock on the dashboard — a shared, verifiable FOMO event that the
  continuous k_max decay (§5) deliberately lacks.

- **The ceremony also settles the recruit season.** The era's recruit counters close and
  reset, and the season's top recruiter takes the **era trophy**: permanent naming rights
  on the primorial being crossed (§4.7). This gives the recruitment layer the thing a pure
  lifetime leaderboard cannot have — a season with an end date the whole dashboard is
  already counting down to — and it is why recruit rank keeps two counters rather than one.
  **The season's settlement is a prize, not a payout** (`DECISIONS.md` D-36, 2026-08-19):
  the era dividend that used to split a slice of the bounty across recruiters is dropped,
  and the whole era bounty goes to the primorial's minter. What the season pays out is the
  trophy. Eight exist, ever, and none can be bought at issuance.
  (`DECISIONS.md` D-106 removed the two other things a boundary used to settle: unclaimed
  numbers became Patron-reclaimable at it, and every claim lock below it lifted. Neither
  state exists.) It is the one recurring event in the game where all three
  clocks fire together, which is why it deserves the countdown rather than sharing it.

Era bounties are budgeted from the genesis bounty vault (§3.3), so they are pre-counted
in `S` and touch neither the split nor the ratchet. The schedule
(`genesis.era_bounty_schedule`) carries two numbers per boundary: `bounty_ton`, the value
the design fixes, and `max_primes`, what that value buys at the genesis floor. The vault
pays `min(bounty_ton · S / T, max_primes)`. The cap is not expected to bind — the ratchet
only lifts `p_f`, so the opening floor is the cheapest PRIMES ever get — it is there
because the vault cannot call a get-method and is handed `(T, S)` by the ledger, and a
wrong snapshot must be able to under-pay but never to drain. The second-order effect is
intended: as the floor rises the vault drains *more slowly*, so its life extends rather
than its payouts inflating. k_max's continuous 1/ln(n) decay is
unchanged — eras add *discrete, celebrated* milestones on top of it, not a second
emission curve.

## 8. Anti-abuse mechanics

- **Front-running / MEV on juicy rebates: accepted, not mitigated.** The mint is ONE
  message — `mint(n, kind, factorization, referral_key, beneficiary)` with 1 GRAM
  attached, settled in the transaction that receives it, so `k(t)` is read at execution.

  On a saturated clock a bot watching the mempool can therefore land its own mint ahead
  of yours and take the high `k`; the exposure is accepted because what it wins is
  bounded by `k_max · β · P` — cents at any head anyone would bother sniping — and it
  pays the same 1 GRAM you would have, leaving the ratchet indifferent to which of you
  paid it. §4.4's ascending lane (on the market router) is the answer to "I want number *n*
  specifically", which is the contention case that actually has money in it, and it
  resolves by **bidding** rather than by block racing. ~~a direct reservation lane, which
  resolves by escrow~~ — **amended (`DECISIONS.md` D-88/D-90):** there is no reservation
  and no escrow; opening *is* the first bid at `P0(n)`, and winning mints the number in
  the transaction that closes the lot.
- **Race contention on the sequential head:** two mints for the same head land in some
  order; the second one is for a number that no longer exists. A mint against an
  already-minted number must **fail cheaply and refund the attached value in full** —
  losing a race costs gas, never principal. That refund is the whole of the head-
  contention guarantee.
  The same rule holds on §4.4's ascending lane: an `open_lot` on a number a direct mint
  took first (the market's `headHint` lags) is unwound by the ledger's `mark_rejected`,
  which refunds the bid less `REJECT_GAS` — the gas the failed open burned, so the
  market's float never pays for the attempt — and carries the ledger's head back into
  `headHint`, so the same stale gap cannot be opened into twice.
- **Bot loops, at the floor:** k_max < 1 guarantees rebate value < injected GRAM < price
  paid, so looped minting is always net-negative *in floor terms* — the pump is closed by
  the same inequality as the ratchet. Worst case is a self-referring rank-V recruiter who
  also owns the genesis primes: 0.10 GRAM referral, up to
  ~0.09 GRAM of self-tribute on a smooth composite, and at most `K_CEIL`·0.55 = 0.5225 GRAM
  of floor-value — **~0.71 GRAM returned against 1 GRAM paid**, before the value of the NFT
  itself. (An earlier draft quoted 0.7175 by omitting self-tribute; the corrected bound
  is what §8.1's premium arithmetic must start from.) The rank uplift of §4.7 moves this
  bound but cannot break it, because `K_CEIL < 1` is the same constant the ratchet rests
  on — and the clamp sits on the *sum* of all four uplifts (§5), so prime rank and prime
  credits cannot widen it either. Any loop that passes through a prime returns its cash
  lines and nothing else on that mint, so the bound above is the composite-only case and
  therefore the loosest one available. **This bound is denominated at the floor, and it is
  not the whole story: rebates are sold at market, and above a computable premium the loop
  turns profitable — that regime gets its own subsection, §8.1.** Bots minting anyway are
  just participants, and every loop they run raises the floor.
- **Self-referral:** not prevented, and not pretended otherwise. Referral requires
  owning *some* NFT (§3.1), which any minter has from their first mint onward; an unset
  or invalid key routes the 10% to the pool, so self-referral is strictly rational
  (0.10 GRAM in hand beats k·0.10 GRAM of PRIMES for any k < 1) and should be assumed
  universal — β = 0.55 is the planning number, not 0.65. The docs call the referral
  exactly what it is: **a 10% discount for people who read the contract and own a
  number.** Unreferred mints are first-timers and people who didn't read, subsidizing
  the pool. There is deliberately no owner/default key: orphan attribution backs the
  floor, not the team.
- **Sybil recruiting** — gift numbers to wallets you control, harvest rank. This is not
  defended against; it is **priced**, and `DECISIONS.md` D-106 made the price simpler to
  state rather than higher. A recruit is credited only when the beneficiary's minter card
  is fresh (§4.6, D-191), so **gifting the same wallet twice counts once**: a recruit costs one fresh address plus one full 1 GRAM mint. The farmer pays the
  mint price in full, every one of those mints ratchets the floor, and what they buy is
  **one tier on a ladder that raises the ceiling on their own future mints** — no GRAM
  comes back at all.
  - *What changed, and why it is stronger.* The old attack ran against patron mode: a
    farmer minted in patron mode, claimed from wallets they controlled, and harvested rank
    *and* the annuity. It was priced at **1.00 GRAM back against 12 GRAM of mints paid in
    full**, and the maximum possible outcome was getting one of those twelve refunded —
    the annuity's ceiling was a refund by construction. That bound was sound but it rested
    on a constant (`PATRON_CAP`) that D-57 showed inverts against a rising cost basis. The
    D-106 bound rests on no constant at all: there is nothing to get back.
  - There is no cheaper wallet-count check worth adding: any rule keyed on wallet age,
    balance or history is both bypassable and unavailable to TVM (§4.6.1), and the spend
    gate is strictly stronger than all of them.
- ~~**Claim farming**~~ — sweeping the unclaimed pool with fresh wallets to accumulate
  free NFTs. **NOT REACHABLE (D-106):** there is no unclaimed pool. A gift mint delivers
  the number to the beneficiary's own address inside the mint transaction, so there is no
  inventory sitting unowned for a sweeper to take, and no purse for one to be waiting on.
- **Rank inflation via low-value recruits** — recruiting wallets that mint once and stop.
  It works, and it is supposed to: one mint is one customer. The tier thresholds are the
  control. Note what D-106 removed from this threat rather than added: with no annuity, a
  recruit who never mints again has cost the recruiter a full mint and paid them nothing
  in GRAM, so the incentive to farm low-value recruits is weaker than it was.
- ~~**Unclaimed inventory as a griefing surface**~~ — patron-minting a large block to hide
  numbers from the market. **NOT REACHABLE (D-106):** every mint delivers an owned number,
  so there is no way to mint one into a state where the market cannot see an owner. It was
  already self-defeating on price (full 1 GRAM each, no NFT retained, every one ratcheting
  the floor) and self-limiting in time; now it has no mechanism.
- **Open-lot griefing** (~~Reservation griefing~~ — **amended (`DECISIONS.md` D-88/D-90):**
  there is no reservation to grief). ~~a reserved number cannot stall the line — `settle(n)`
  is permissionless with gas prepaid from `RES_GAS`~~ and ~~Cancellation carries a 5% fee to
  the pool~~, then ~~**release** refunds 90% and forfeits **10% to treasury** (D-32)~~ — all
  three are **deleted**: `settle(n)`, the escrow and the release right went with the
  escrowed claim, because a won lot mints in its own closing transaction. What survives is
  the argument, in a stronger form: an open lot **cannot stall the line at all**, since
  D-45 marks an auctioned number off its sequential line the moment `open_lot` runs and the
  head-advance walk skips that position forever — and a run of them long enough to outgrow
  one transaction's gas is walked across several by `advance_head` (D-189), where before it
  froze the head for ~60 GRAM of lots. Mass speculative opening is still the
  protocol being prepaid at its best ratchet rate — the premium splits 50/50 between the
  ratchet and the treasury (D-114) — and there is no OPENER-INITIATED exit that returns a
  bid. The only two refunds are being outbid and `MarkRejected`'s unwind when a direct mint
  won the race, so open-and-abandon spam pays the floor in full rather than 10% of itself,
  which retires the old bullet's "the forfeit must exceed the round-trip gas"
  pre-launch check (§11.26): there is no round trip left to price.
- **Ascending-lane abuse (§4.4 point 1b, lane B): five surfaces, and the format closes
  four of them by construction.** The descending prime lane (lane A) has none of them: it
  has no bid, no clock, no refund and no opener's stake, so squatting, refund-griefing,
  sniping, extension-griefing and wash bidding have no referent there. Its one abuse
  surface is buying at the floor, which is priced by the floor being `MINT_PRICE`.

  1. **Lot squatting without intent does not exist.** `open(n, bid)` places the opener's
     own bid at `≥ P0`, so you cannot open a lot you are unwilling to buy, and the no-bid,
     reserve-not-met and refund-the-opener states are *absent* rather than defended. A lot
     costs at least 5 GRAM of locked capital to exist, which is why the open book is
     demand-bounded rather than eligibility-bounded.
  2. **Bid-refund griefing** — walking the high bid up in dust steps, each forcing a
     refund message at the contract's expense — is bounded by `MIN_INCREMENT`, sized since
     D-33 as `max(MIN_INCREMENT_FLOOR, high · bps(score))` — a **0.015 GRAM floor**, not
     1 GRAM, and a score-banded percentage (D-33's increment ladder, 5% below score 10
     and 30% from 10 up — `incrementBpsAt`, published by `getIncrementLadder()`) rather than a flat
     5%: a rarer, more contested number requires a larger step so it resolves in fewer
     rounds. (This paragraph previously stated the pre-D-33 flat formula,
     `max(1 GRAM, 5% · high)`; GAUNTLET.md C1.7 reconciled it against the shipped
     `incrementBpsAt`/`MIN_INCREMENT_FLOOR` — the code value is the one to keep, since the
     percentages are D-33's own signed sim output and 1 GRAM was never re-derived against
     it.) The anti-dust argument is §6's; the percentage is not, and point 1b says why §6's
     upper bound does not transfer to an ascending-only lane.
  3. **Sniping** is the characteristic failure of a hard close, which is why this lane no
     longer has one: it is answered by the 67-minute `BID_EXTENSION` (`DECISIONS.md` D-8),
     not left to bidder vigilance. The residual surface is the
     opposite one — **extension griefing**, walking a lot forward one increment an hour —
     and it is bounded by cost: every step is a real, attached raise of at least 10% (D-33's
     ladder). There is no early close on head arrival any more — D-45 took the number off
     the head's line at `open_lot`, so the head never reaches it. A griefer who keeps
     bidding eventually owns the number at their own price, which is the same self-defeat
     this section already documents for whale runs.
  4. **Wash bidding is structurally pointless, and this is stronger than it looks: there
     is no seller.** The protocol is the counterparty and half the premium goes to the
     ratchet (D-114), so a bidder bidding against themselves burns real GRAM into every
     holder's floor.
     There is no party on the other side to collect an inflated price, which is why this
     lane needs no bid-history rule at all — the usual reason to write one does not exist
     here.
  5. **The 1 GRAM bypass is intended, not a leak, and it is documented here so nobody later
     "fixes" it.** Every lot on this lane is bypassable by waiting for the head (§2
     principle 7). Closing the bypass means putting a gate on the head, which §12 forbids
     at any price and which would trade the game's fairness claim for auction revenue.
- **Prime-credit farming:** buying primes to harvest `PRIME_UPLIFT` credits (§5.1). Since
  `DECISIONS.md` D-20 every prime is selectable — it sits on a standing descending lot —
  so the "nobody can choose a prime" argument the earlier draft leaned on is withdrawn and
  the pricing argument has to carry the whole weight. It does: the cheapest a prime is ever
  available is `getPrimeFloor(p) + RES_GAS` — at least `LOT_FLOOR` = 1.070 GRAM, and since
  D-88 point 1 strictly more than that for every prime the `NPV` table covers — at which the
  farmer trades the ~0.11 GRAM
  of rebate a composite would have paid for a credit worth 0.14–0.17 GRAM — an edge under
  0.06 GRAM (at β = 0.55, `DECISIONS.md` D-117) — which is then spendable *only* across five further composite mints the farmer
  pays 1 GRAM each for. **The attack is committing six full-price purchases to capture under
  0.06 GRAM of uplift**, and it is worse than that for the farmer, because a prime bought
  before its decay finishes costs the undecayed premium on top. The structural constraint `PRIME_UPLIFT · PRIME_WINDOW < k_max(n)` (§5.1)
  guarantees the credit never returns as much as the rebate the prime mint gave up. Every
  mint in the loop ratchets the floor, and the prime ones do it at maximum strength. This
  is the same shape as sybil recruiting: the cheapest way to farm it is to be a customer.
- **Flush MEV:** `flush()` is permissionless and rate-gated, so its timing is public and
  roughly predictable — the classic attack is to pump the pool, trigger the flush, and sell
  into the protocol's buy. **The floor guard (§4.3.1) caps that attack at the floor; it
  does not remove it** (`DECISIONS.md` D-190). Above `p_f` a pump makes the flush bounce,
  which costs the protocol one message of gas and the attacker the whole pump. Below `p_f`
  the caller sizes the flush (§4.3.1), so an attacker pumps, sizes the tranche to the
  pumped pool, lets the ratchet fill at an average up to `p_f`, and sells back. The cost is
  **burn efficiency** — PRIMES not burned per GRAM spent — and never backing: `T`, `S` and
  `p_f` are untouched, and the ratchet never pays above its own floor. Measured in the sim
  with a best-responding attacker who pumps up to 8× the flush and then sizes it:
  1,856 of 3,217 flush attempts over the three-year base run are sandwiched, for **800 GRAM of attacker profit — 3.0% of the 26,387 GRAM the ratchet swapped** (`flush.sandwich_profitability_check`; the unguarded control loses 82%). The owner accepted this as the price of an oracle-free standing bid; a
  second price anchor under `p_f` would close it and was declined (D-190).
  Three oracle-free guards remain, since TVM has no synchronous get-calls and §5
  deliberately avoids price feeds: (a) the `limit`, now derived from `p_f` rather than from
  a slippage band, which is strictly stronger — it bounds price *and* slippage in one
  field; (b) `FLUSH_COOLDOWN`, which bounds extractable value per unit time; (c)
  `FLUSH_PCT`, which caps a single buy's price impact and chunks any backlog across many
  days. What remains extractable is the ordinary sandwich *inside* a filling swap, bounded
  by `FLOOR_GUARD` and `FLUSH_PCT`, and only available while the market is already under
  the floor.
- **Draining the protocol's GRAM:** ~~three~~ **two** distinct balances sit on-chain at all
  times, with two different owners — `pending` on the ratchet (nobody's, and
  unwithdrawable) and `owed` on the ledger (the prime owners', claimable).
  ~~plus purses held on unclaimed items (§3.4)~~ **D-106 deleted the purse** along with
  patron mode: every minted number has a real owner from the transaction that minted it, so
  there is no unclaimed item left to hold one. ~~and reservation escrow (the reservers',
  refundable)~~ **D-90 deleted the escrow**: a won lot mints in its own closing transaction,
  so there is no refundable customer GRAM in this system at all. There must be **no admin
  withdraw path on either of them** — not timelocked, not multisig, none. The only outbound
  GRAM paths are the split, tribute claims, `flush()` and §4.3.2's staking legs, each with
  contract-computed amounts. Their destinations matter as much as their amounts: §4.3.2's
  staking addresses are deploy data with no setter, and the flush venue changes only with
  the proposer key AND a passed LP vote, after 30 days in public (`DECISIONS.md` D-194 —
  before it the proposer key alone could re-point both, which was this bullet's forbidden
  path under another name). A sweep over either
  would be the single most Ponzi-looking line in the codebase, and this audience
  greps for it first (§12). Keeping the balances in separate contracts is what makes
  the grep conclusive rather than merely reassuring, since each one's outbound set can then
  be read in isolation.

  **The governed treasury does not weaken this, and the reason is which GRAM it holds**
  (§5.5, D-100 point 7). `primes_treasury.tolk` can spend, so a reader who greps for a
  spendable balance will find it and should be told what it is before they guess. **The
  treasury has no key and no admin** — no owner field, no admin opcode, no pause, no
  upgrade — and it spends **only by a passed proposal or by `distribute()`** (§5.5.3,
  `DECISIONS.md` D-168), with no third path (invariant TR-2). What it holds is *fee revenue*: §4.1's 5% line (D-152), 58% of the unsold-prime forfeits (D-166)
  (§4.1), which nobody is owed. It holds **none of the protected pools** — not `pending`,
  not `owed`, not a purse, not refundable customer money — which is precisely the property
  the §3.4 decomposition exists to make greppable. The one custody relationship it does
  have is in a different token: depositors' LP receipts, withdrawable by the depositor and
  by nobody else, and excluded from what a proposal can move (§5.5.2). The
  **LP sink** makes the same point in its strongest form: it declares **no outbound message
  type at all**, so there is no withdraw path to guard rather than a guarded one.

  **The one sweep that does exist, and why the sentence above survives it.** §4.1's gas-&-
  ops line leaves a residual on the ledger, and `sweep_ops` moves
  `balance − declared_liability − OPS_RESERVE` of it **into the ratchet pool** — crediting
  `pending` and `T`, emitting nothing (`DECISIONS.md` D-117; until then it paid a
  deploy-fixed operations address). It is not an operator line at all, and it is not the
  thing this bullet forbids: the forbidden shape is *discretion over other people's money*,
  an amount someone chooses over a balance someone else owns, and this sweep has neither.
  The amount is a subtraction with no argument, the function is permissionless and has no
  destination argument, and the money moves from the protocol's unspent gas budget into the
  floor's backing, where no key can reach it. `OPS_RESERVE` is what keeps the ledger's
  deferred obligations funded; it is a target rather than a liability (see §4.1 for why that
  distinction is load-bearing) and it is published by `getOpsSweep()` alongside the amount
  currently sweepable. **No function in the system pays the operator out of a contract
  balance *by rule*.** D-100's treasury does not become one: a proposal can name any
  destination including the operator's wallet, but it is not a function that pays them — it
  is an electorate's decision, capped at 25% of one asset, visible for a day before anyone
  can execute it, and the operator cannot pass it alone once anybody else has locked LP
  (§5.5.5). The §4.1 leg that pays the operator directly — since D-152 only the
  operator's 42% of a forfeit (D-166) — is a *split* leg, computed and sent in-flight during the
  mint, never a withdrawal from a resting balance.

  *(A second power stood here until `DECISIONS.md` D-202: the operator signed the list of
  addresses §4.1's invite line paid. D-202 moved that choice to the minter and deleted the key,
  so no operator key is on the mint path at all, and §4.6.1 records what that changes.)*
- **One counterparty in the backing, and this section names it rather than claiming there is
  none.** Until `DECISIONS.md` D-151 (2026-09-20) the answer here was that the backing had
  no counterparty at all, and §11.14 had been *closed* on the strength of that sentence.
  §4.3.2 spends it deliberately: `staked_reserve.staked_fraction` = **0.80** of the
  ratchet's obligation sits in the **Tonstakers** liquid-staking pool as tsTON, counted in
  `T` **at cost** and never at market. The exposure is therefore bounded, published and
  checkable, in that order:
  - **Bounded** by `stakedCost + exiting` — at most 80% of the obligation, the remaining 20%
    liquid on the contract as the reserve the floor's standing bid draws on.
  - **Valued at cost**, so the counterparty's price never enters `p_f` in the upward
    direction. Unrealized appreciation is not marked into `T` (§4.3.2's "realize, never
    mark"), which means a tsTON rate that is wrong, stale or manipulated cannot inflate the
    floor by a single nanoton.
  - **Loss published, not absorbed.** `realizedLoss` on `getStaking()` is cumulative GRAM
    that left and did not come back, reported beside `stakedCost` and never netted into it.
    A non-zero reading means `p_f` overstates the backing by `realizedLoss / S`, and §5
    states the arithmetic and the one event — a slashing inside that pool — that can move
    it. No path this protocol chooses can: the only leg that names a price floors it at
    cost, and the other two redeem at the pool's own rate.

  What this bullet does **not** concede is the second half of §11.14's original objection.
  There is still no discretionary surface: the three arms are permissionless exactly as
  `flush()` is, **none of them carries an amount**, and the allocation is a constant in
  `shared/params.json` with a `_source`, not a size somebody chooses. "There is no
  discretionary surface anywhere in this system" is still literally true and still greppable;
  "there is no counterparty" is not, and is retired wherever it was written.
- **Idle-death:** if nobody mints, nothing is emitted and the floor simply holds. The
  protocol cannot deflate; it can only stall. The ratchet keeps draining geometrically
  under §4.3 *while PRIMES trades under the floor* (§4.3.1), so a stalled game whose holders are
  selling still delivers a decaying tail of buy pressure until `pending` is exhausted —
  and a stalled game whose holders are not selling keeps the GRAM on the ratchet, backing `T`,
  where it is worth more than it would have been spent for. VRGDA-style *price* adaptation was
  considered and rejected in favor of the flat 1 GRAM + variable rebate share, which
  achieves demand-responsiveness on the reward side while keeping the cost side
  legible.

### 8.1 The premium regime: the mint is the market maker

Every bound above is denominated at the floor, and every one of them must also be checked
at a market premium, because rebates are paid in tokens and sold at market. Let
`x = p_m / p_f`. A self-referred composite loop returns `0.10 + k·β·P·x` (plus
self-tribute for a wallet that owns the factors), so it turns profitable at

```
x*(n) ≈ (1 − c) / (k_max(n) · β)
```

where `c` is the cash recovered outside the rebate — 0.10 for self-referral alone, up to
~0.19 for a wallet holding the small primes (bought off the descending lane; there is no
genesis set under D-20) — the corrected loop bound above. The constellation multiplier
this clause used to list as a third leg is deleted (`DECISIONS.md` D-102), which can only
lower `c` and raise `x*`, never the other way. Above `x*`, minting-and-dumping is the dominant strategy for
anyone with a script, and it runs until the premium is compressed back toward `x*`:

| n | k_max(n) | x* (self-referral) | x* (small-prime-equipped) |
|---:|---:|---:|---:|
| ≤ 1,000 | 0.900 | 1.82 | 1.64 |
| 10,000 | 0.675 | 2.42 | 2.18 |
| 100,000 | 0.540 | 3.03 | 2.73 |
| 1,000,000 | 0.450 | 3.64 | 3.27 |

**The ceiling is not one number — it is a function of the wallet's own uplift, and the
best-equipped wallets sit under the lowest one.** `k_max` in the formula is the
summed-then-clamped value of §5, not `k_max(n)`, so every uplift a wallet carries pulls
its personal `x*` down. The column that matters is the wallet that has earned its way to
the clamp:

| n | k_max(n) | x* (self-referral) | x* at `K_CEIL = 0.95`, small-prime-equipped |
|---:|---:|---:|---:|
| ≤ 1,000 | 0.900 | 1.82 | 1.55 |
| 10,000 | 0.675 | 2.42 | 1.55 |
| 100,000 | 0.540 | 3.03 | 1.55 |
| 1,000,000 | 0.450 | 3.64 | 1.55 |

Read the last column as the point: **the clamp flattens the ceiling.** The band's upper
half widens with `n` for an ordinary wallet and does not widen at all for a maximally
uplifted one, whose break-even stays near 1.5× the floor (1.3× before D-117 cut β to 0.55) everywhere on the line. That is
tolerable because uplifts are earned — high-rank wallets are few, and each of them paid in
recruits or prime mints. It was a different proposition while §5.3 specified a
*purchasable* uplift, because then the wallets sitting at the lowest ceiling would have been
exactly the largest holders; that design carried a kill criterion on this table and
`DECISIONS.md` D-168 deleted it rather than run it. §5.3's staking pays PRIMES from the
treasury and touches no wallet's `k_max`, so it moves no row here.

Transaction costs do not rescue the naive bound: exit gas amortizes over batched sales
(the same dust arithmetic as §4.3, run by the other side), the LP fee is 0.25% on a mainnet
volatile pool — read per venue, §9.1 — and price
impact is not a deterrent but the harvest ending — the only question it settles is who
pocketed the excursion, and the answer is sellers in order of latency.

**This is a ceiling on the market price, stated as a formula, and it is a feature —
provided it is disclosed with the same prominence as the floor.** PRIMES trades in a
band: a ratcheting floor defended by the flush below it (§4.3.1), and an arbitrage valve
above it whose every activation pays `β·P` into `T`. A pump above `x*` does not escape
the protocol; it is minted into backing. The honest one-liner: **the floor can only
rise, and the ceiling rises with it** — `x*` loosens from ~1.8× to ~3.6× as `k_max`
decays. **That widening belongs in the pitch, not only in the defence:** it is the same
`k_max(n)` decay that rotates each mint's value toward the asset side, read from the other
end, and §5.4 carries both halves in one table — the band widens over exactly the stretch
where the token's per-mint emission shrinks and the floor beneath it only rises. §5.4 also
states the caveat this section implies and does not spell out: because `x*` is
proportional to `1/k_max(n)`, the rotation is a floor-denominated statement and the asset
share at the ceiling is `n`-invariant. The dishonest one-liner this replaces: any
implication that PRIMES can run like
a memecoin. It structurally cannot, the copy must never suggest otherwise, and the
moonshot energy belongs to the numbers — names, provenance, the
primorial trophies — not to the jetton.

Three consequences, stated rather than discovered:

- ~~**Vesting is what makes the ceiling soft.**~~ **CORRECTED 2026-08-28 (`DECISIONS.md`
  D-55).** §5's progress-vesting (`VEST_NOW`/`VEST_H`) was never built — every rebate is
  fully liquid the instant it mints — so, read literally, this bullet's own premise was
  false: `x*` is today a **hard** ceiling, not a soft one, and a single flip above it is
  risk-free for whoever executes it, exactly as this bullet warned would happen *without*
  vesting. Two mitigations do exist today, neither of them vesting, and neither turning
  the ceiling soft the way a holding-period risk premium would: **(1)** `k(t)`'s own
  stall-breaker curve resets low after every mint and climbs back toward `k_max(n)` only
  as time passes (§5), so *repeated* harvesting by the same actor drains its own rebate
  rate — sustaining the arb at `k_max(n)` requires patience between flips, not
  instantaneous automation, even though the first flip is not throttled at all; **(2)**
  every harvesting mint is an ordinary mint, so it injects `β·P` into the ratchet at the
  same 100% as any other and raises `p_f` under its own feet — since `x = p_m/p_f`, a
  harvester who does not also move the market price up in lockstep compresses their own
  `x` toward `x*` with each flip. Neither claim has been re-derived against Phase 1's sim
  parameters to say whether the arbitrage is economically live today at realistic market
  depth; that remains open, and this correction only fixes what CONCEPT.md asserts, not
  what the numbers currently are.
- **The valve never closes at primes, because a prime is never at the head** (D-20 —
  the head walks composites and Unity only, and every prime sells off-head on its own
  descending lot). The pre-D20 design had a real coupling here — a prime at the head
  emitted nothing, so the valve suspended until it cleared, and at high premium bots
  paid to unpark it. That mechanism is retired along with the parked head itself (§12):
  harvesting requires composites, composites are always what the head serves, so the
  valve's availability no longer depends on the prime line at all.
- **Every priced attack in this section is repriced at `x*` before Phase 3.** The two
  that move: sybil recruiting — at `x = x*` the rebates recover most of both mints, so
  the cost of a sybil recruit approaches zero exactly during pumps — and, formerly, the
  era dividend. **The dividend is dropped (`DECISIONS.md` D-36, 2026-08-19)**, which
  removes the second of the two rather than capping it: it was the one recruitment reward
  sitting outside the then-live `PATRON_CAP`, and `ERA_DIV_CAP` existed only to
  bound it. With the dividend gone the era trophy replaces it, and a trophy is not
  repriced by `x` — it pays no GRAM and no PRIMES, so a sybil pair cannot profit from it
  at any premium. Nothing else in this section is repriced by `x`: the one-message
  mint of §8 holds no position open across a price move, so there is no free option on
  `x` crossing `x*` to price.

## 9. Distribution: the funnel is a designed system

The old plan — "no ads, nerd-snipe only" — named a conversion mechanism and no reach
mechanism. The revised stance: **the read-the-contract layer converts (special numbers, the discovery race — D-47); the
Telegram layer reaches;
attribution makes both measurable; and every growth claim obeys principle 5** (verified
on-chain or by counted events, never self-reported). Paid promotion, if any, advertises
the *game* (the special numbers), never the token.

**The gift mint (§4.5/§4.6) is the layer under all of it.** The bounty tracks and the
Telegram surfaces are things the team builds and pays for; a gift mint is a mechanism that
makes *players* pay to acquire players, priced by the protocol at 1 GRAM a head and settled
without an operator. It converts the growth budget from an expense line into an ordinary
mint, and it is the only part of the funnel that keeps working when nobody is running a
campaign. Everything in §9.1–§9.7 should be read as the surface that makes it usable — a
share link needs somewhere to be posted and something to open into.

### 9.1 Surfaces

- **The welcome rite, once per player** (`DECISIONS.md` D-163). A first visitor opens on a
  ten-second takeover that is all arithmetic: an Ulam spiral of the first 24,000 integers
  crossing the real primorial eras, sealing into a cluster of its primes as stars, over the
  ledger's own floor series. Skip closes it from the first frame. It is remembered in the
  browser and, for a connected (ton_proof-proved) wallet, on the account, so it does not
  replay on any browser that has proved that wallet.

- **The Riemann launch dedication, and Schoenfeld's band** (`DECISIONS.md` D-210). The game
  launches on 2 December 2026, twelve days after Levent Alpöge's proof of the Riemann
  hypothesis with Claude (20 November 2026, `alpo.ge/remark.pdf`), and is dedicated to it:
  one line on the launch curtain, the welcome rite's first line, `/`'s
  title and share text, and a note on `/verify` that the proof's GRH makes Miller's test
  exact for every n — all behind one campaign flag (`webapp/src/lib/riemann.ts`). Beside it,
  permanently, `/` draws **Schoenfeld's band**: the ledger's `getPrimesCount` (π(n)) against
  li(n), inside `±√n·ln n / 8π`, the error term the hypothesis controls. The band is a
  theorem for `2657 ≤ n ≤ 1.1·10²⁶` with or without any proof (Büthe 2016, Johnston 2022);
  li(n) and the edges are computed in the browser from n, as the era boundaries are, and the
  count is plotted at an n where π(n) equals it exactly, so the two reads' different polling
  tiers can never place the marker where no chain state was. Below n = 2657 it draws the
  climb toward that bound instead. The band is a small card in the dashboard's left column,
  under the bot card (§9.10), and its title opens **the hypothesis's story**: six dated
  stations from Riemann's 1859 memoir to the Clay prize, why the hypothesis matters (it is
  the bound on π(x) − li(x) the band draws), and what follows from it. PLAY draws the
  stations and one line per section; the sentences are auditor-class, one press away on the
  view lever (D-85). Only the closing 2026 station says "proved", and it is behind the
  campaign flag; everything else is stated as what the hypothesis implies. Beside the card's
  π(n) reading a pixel **dancing man** (after Conan Doyle's cipher) dances an eight-beat
  phrase of four figures and their mirrors, opening on figure π(n) mod 4 — a new opening each
  time a prime is found; he is ornament, the
  digits are the value.

- **Telegram Mini App as the primary surface.** The audience is TON-technical; they live
  in Telegram. The Mini App carries: the live mint feed (real on-chain events — social
  proof the game is alive *right now*), the ticking k(t) clock, the floor-price
  staircase, the primorial-era countdown (§7), the reservation order book (§4.4),
  tribute/referral earnings and claim buttons, quests (§9.4), the **prime lot** (below),
  and leaderboards — with the viewer's own rank shown even outside the top 10. `/leaders`
  is four blocks and no more (`DECISIONS.md` D-149): the **season** (era recruits, the era
  trophy race and its standings, §4.7/§7), **the eight** (which primorial ceremonies have
  fired and who holds each pen), **your two ladders** (recruit rank and prime rank, §4.7,
  §4.7.1), and the two **lifetime boards** (recruiters by the minter card's `getRecruitRank`,
  prime finders by its `getMinterState` prime count with tribute GRAM claimed as the row's label). A referral key is a *number* (§4.1) and its right travels with the NFT
  (§3.1), so "mints that quoted this key and paid" is a fact about the number, shown on the
  number's own page and on no `/leaders` board — §9.11's referral board on `/earn` is the one
  place numbers are ranked by what their key has paid (D-177); the count includes only mints the ledger actually
  paid (a key below the head, sold, and never an off-head lot) and self-referral is allowed
  and counted.

  **A board keyed by wallet is served as a BAND, not a top-10** (`DECISIONS.md` D-124). A
  top-10 answers "who is winning" and nothing a reader outside it can act on: ten strangers,
  no self, and no visible next step. So a wallet-keyed board on `/leaders` — the era
  standings and the two lifetime boards (D-149) — answers the contiguous run of rows
  *centred on the connected wallet*, four above and five below, with the board's own leader
  kept at the head of the list. The leader stays because every bar is drawn against the maximum of what was
  served, and a band alone would silently rescale the column to a local maximum. The band
  pays **nothing**: no GRAM, no PRIMES, no `k_max` uplift, no naming right. It is a window
  over the same ranking, not a second contest, so §5's clamps and §4.1's split are untouched
  by it. A wallet with no row on a board has no band, and that board answers its top-N.
  Every served row carries its **true** rank, so a band at 8..17 prints 8..17 — the ordinal
  is a served figure like every other number on the screen, never `index + 1`.
  *(The referral-key board and the era mint-count board — D-79 facet 1 — were listed here
  until D-149 removed both from `/leaders`.)*
  *(The **unclaimed board** — expired gifts and open offers sorted by purse size — was
  listed here until `DECISIONS.md` D-106. There is no unclaimed state and no purse, so the
  board has no rows; the route and its `getUnclaimed` selector, which never existed in any
  contract, are deleted rather than left answering an honest 501.)*

- **One open loop on the home screen, and only one.** Everything above is a reading about
  the *protocol*; none of it is a thing the reader can finish, and a dashboard of true
  readings that the player cannot close is the shape this bullet exists against. So the
  Mini App's main screen carries, above the mint and below the head, exactly **one** ring:
  the nearest-to-done of the connected wallet's own unfinished bounded things. Two
  candidates, in the order that breaks a tie — the **newcomer window** (the minter card's `getNewcomerWindow()` `left / total`,
  §4.5), and the **recruit ladder** (its `getRecruitRank()` `recruits / nextTierAt`, §4.7) —
  and the highest fraction wins. The ring's filled circumference *is* that fraction and the
  count is its label, per the usual shape obligation.

  Three constraints, and each is the honesty rule applied to a loop rather than to a figure:

  1. **Every term is a get-method.** There is no tally, no streak, and no notion of
     "today" — the chain has none, so a daily reset or a streak counter would be geometry
     tracking no chain state, the same class of bug as an invented parameter. A loop is
     open because the thing is unfinished, and it closes when the player closes it.
  2. **Started and unfinished, or it is not drawn.** `0 < done < total`. A ring at zero
     states no progress and a ring at one is not a loop; either way the slot **collapses**
     and the hero is what it was. A disconnected visitor gets the same nothing — a stranger
     has no loop, and inventing one for them is the failure this bullet names.
  3. **One ring, one destination.** Whatever it shows links to the single place that
     closes it, or to nothing at all when that control is already on the screen (the
     newcomer window is spent by the mint button directly beneath the ring). A second ring
     beside it would be the dashboard again at smaller size.

- **The nameplate.** Naming (§4.7.1, §7) is a reward the document cites throughout, so the
  app must *show* it: every minted number's page carries the name its owner gave it, the
  owner who holds the pen, and — for that owner alone — the naming as a control, priced in
  GRAM at `nameFee` for the first naming and `renameFee` after (`DECISIONS.md` D-212), both
  read from the collection's `getNaming()` and chosen by the item's `getAnnotation()` count.
  A primorial also carries its era trophy's engraving, held and written by the trophy's
  holder on the registrar (`getTrophy(n)`, `getTrophyAnnotation(n)`, free the first time,
  `getTrophyRenameFee()` after). Every half is a get-method, so §9.1 holds unchanged. Two
  states are rendered honestly rather than collapsed: an unminted number has no owner and
  no nameplate, and a minted number nobody has named shows as unnamed. Composites render
  amber, primes cyan (the semantics rule). The engraving is a §9.1 *shape* obligation on the
  write side: the name's character budget is bounded, so it renders as a fill rather than a
  printed ratio, and the commit gets a ceremony rather than a re-render.

- **The prime lot.** A prime is never at the head (§6 point 1), so its moment is a
  different event: **a prime lot opening**, which happens the moment the head clears the
  last composite before it. Every surface should say so loudly, with the standing
  descending price on it and a live countdown to the next opening. A newly opened prime is
  the game's recurring event: it emits nothing, it moves the floor ~12× harder than an
  ordinary mint (§4.2.1), its buyer gets the pen on it (§4.7.1), and it is
  gone the moment somebody takes it. **This is the best conversion moment the game
  generates on its own** — roughly one number in ln(n), on a schedule no marketing team
  writes — and unlike the k(t) clock it is discrete and shareable rather than a curve.
  *"233 is on the block at 12.4 GRAM, falling to 1 GRAM by Friday. No rebate, maximum
  ratchet, and whoever owns it names it."* The app says it; nothing pushes it —
  there are no notification bells, in the app or the bot (`DECISIONS.md` D-169).

  **The descending price is a §9.1 shape obligation, not a number.** It is bounded — from
  `P0(n)` down to **that lot's own resting price**, which `getLotFloor(n)` publishes per lot
  and `getPrimeFloor(n)` per number (D-88 point 1) — so it renders as a falling meter whose
  geometry *is* the standing price, with the digits as its label, and it must land on what
  `getLotPrice(n)` returns. Three things the surface may never do: quote the opening price
  without the terminus (the resting price is the honest half of the story), print the global
  `getPrimeDutchTerms().floorNanoton` as *this* prime's terminus — it is only the lower
  bound on it, and drawing a meter against it is exactly the "geometry that does not track
  chain state" bug — and imply the lot expires. It does not — it rests on its floor forever.

  The gift flow is the single most important conversion path in the product and should be
  the shortest — and since `DECISIONS.md` D-106 it is shorter than it was, because there
  is no claim step: the number is already in the recipient's wallet when the message
  arrives. The link opens straight into the Mini App with the number and the "your first
  five mints run at a raised ceiling" step visible in one screen. A number delivered as a
  Telegram message from a human is a fundamentally different object from an NFT appearing
  unbidden in a wallet (§4.6.1), and the app is what makes the difference legible.

- **Ceremony mode: the rebate clock at its ceiling.** The prime lot's counterpart on the
  composite side. `k(t)` climbs for every second nobody mints and **reaches** `k_max(n)`
  one ramp later (§5, D-98), so a head that has sat untaken for an hour is paying the
  largest rebate share it ever will — the exact moment the clock was designed to produce, and the
  moment the stall-breaker is supposed to be *felt*. When `k(t)/k_max(n)` crosses a stated
  closeness to 1, the Mini App's main screen raises a ceremony surface above the hero: a
  wound ratchet that reacts to touch, the two get-method values that put it there, and one
  tap into the mint wizard. Below that closeness but past a lower band, the same surface
  shows the climb in progress rather than the ceiling.

  Three constraints, none of them cosmetic:

  1. **The two closeness thresholds are display thresholds, not economic parameters.** They
     gate a banner and change no payout, and they are expressed as fractions of `k_max(n)`
     — a value the contract computes — never as a `k` of the front-end's choosing. Nothing
     here is a number to hardcode in a contract or to add to `shared/params.json`.
  2. **It cannot fire on a prime.** `k = 0` unconditionally there (§5.1); the prime lot is
     the correct state and it emits nothing to celebrate a rebate for.
  3. **The trade-off is on the same screen as the reward.** A peak-`k` mint pays the minter
     the most and moves the floor the least — the ratchet coefficient is `(1−k)·β` — and
     the floor rises anyway, because `k` is clamped below 1 at `K_CEIL`. Ceremony copy that
     omitted this would be the first place in the product where the celebration outran the
     invariant, and §2's "the audience is the auditor" does not pause for a good mood.

  **The clock's origin is published, not inferred.** `get_k(n, t)` is a pure curve, so
  without the timestamp it is read against, the *current* point on it cannot be
  reconstructed from chain state and the live clock would rest on an indexer's assertion.
  The ledger therefore exposes `get_last_mint_time()` alongside `get_k` — `0` is the
  cold-start sentinel, not a timestamp — and the UI reads `t` as `now − last_mint_time`.
  Where a deployment's ledger predates that get-method the surface falls back to the
  indexer's newest mint row. (It used to print an "indexed" marker beside that clock;
  `DECISIONS.md` D-206 deleted the marker, and the proof drawer still names the source.)

- **The gifting composer — DEFERRED (owner, 2026-09-24).** The design: a gift mint's
  default output is a shareable Telegram message carrying the number and the newcomer
  rebate, in the voice of §4.6's example, A/B-tested with the same seriousness as the
  split, because whether a gifted wallet ever mints one of its own is the binding
  constraint on whether the loop compounds. **It is not built.** The bot carried an
  unwired `composeGift` until 2026-09-24, when the owner deferred bot-side gift mechanics
  and it was deleted as dead code; the §4.5 gift mint itself is unaffected. If it returns,
  **it may promise only what the ledger can deliver**: the purse, the lock and the
  deadline are gone with the unclaimed state (D-106).

- **The `Earn` block.** *(Shipped 2026-08-17, EARN_PLAN E5.)* One top-level screen that
  makes every earning pathway legible and every share one tap away: your key and its
  source-labelled links, the funnel they produced, one card per way to be paid with its
  rate and its source get-method, the invite panel, the quest board, the bot, and claims.
  It owns ACQUISITION; `/me` owns HOLDINGS, and no component is duplicated across the two.
  **Which number carries the key is the holder's choice**, offered from the holdings the
  portfolio has already confirmed on chain: §4.1 pays the current owner of `rN`, so every
  number a wallet holds is an equally valid key, each keeps its own clicks and its own
  funnel, and a number sold takes its line with it. The screen says that, and the picker is
  what makes it actionable — a second, typed invite surface on `/me` (a field you named a
  number in, which then checked whether you owned it) was the duplication the sentence
  above forbids, and it is deleted.

  Two obligations distinguish it from the partner dashboard it is modelled on. First, it
  carries the strictest reading of the honesty rule below: a tile is badged *proved*
  (a get-method a reader can re-run) or *counted* (an off-chain tally nobody can reproduce),
  and the two are never rendered alike. An *indexed* figure (our index of a real event)
  carries no badge since `DECISIONS.md` D-206. A page
  that blurs them is the exact failure §2 principle 5 exists to prevent. Second, the invite
  panel must carry, visibly, the three sentences that make recruiting structurally not a
  referral scheme. **D-106 changed all three of them, because it changed what has to be
  defended**: they used to argue a real GRAM payout was bounded (single-level with no
  second-level field, a ceiling equal to one mint price, a line paid from the residual
  that never touches tribute); nothing pays GRAM now, so they say instead that recruiting
  pays no GRAM at all, that a recruit costs a full mint to an address the ledger has never
  seen, and that every uplift lands under the single `K_CEIL` clamp. If those three are
  not on the screen, the panel is not finished.

  A visitor with no wallet gets the whole page, not a locked one — but **the key block is
  per-wallet data, so it does not exist until that data does** (owner directive,
  2026-09-21; it replaces the earlier cold start, which issued a link immediately). The
  10% line resolves against the owner of `rN`, so until this wallet owns a number there is
  no key: no seal, no `?ref=` URL, no copy control and no number in the masthead accent.
  The block used to stand the MINT HEAD in as "your key would be #n" beside a real link —
  a number the reader did not own, on a URL whose clicks would have been counted under
  whoever minted that number next. What the panel shows instead is the one action that
  makes it true: mint a number, and the key, the link and the funnel arrive with it.

- **PRIMES staking on `/earn` and on the main page** (§5.3, `DECISIONS.md` D-168 Q18). `/earn` carries the whole mechanic and the
  main page carries one compact element; both obey the shape rules, and every figure is a
  stake-contract or treasury get-method.

  - **`/earn`** replaces the zeroed fifth-leg uplift row and every LP-miner reward figure it
    used to draw. Per position: a **ring filling from `lockedAt` to `maturesAt`** (bounded,
    so a shape), claimable PRIMES as a **rolling counter** (unbounded, so motion), and the
    tier as a lit step on the four-rung ladder. The pot: an **epoch ring** to the next
    `distribute()` and the stream still to pay. The controls are stake (amount + tier),
    `claim`, `relock`, and `withdraw` — enabled only at maturity, because ST-3 refuses it
    before. A `claim` gets a settle-scale ceremony, not a prime-scale one.
  - **The main page** gets one element and no more: the pot's epoch ring and, for a
    connected wallet, its total staked and claimable. It sits inside the 40-word PLAY budget;
    the explanation is AUDITOR-only prose.
  - **LP custody surfaces lose every "earns PRIMES" claim** and the three rungs below 30 days:
    an LP position shows its vote weight and its term, and nothing it does not get.

- ~~**The provenance map.** `gifted_by` (§4.6) makes the recruitment graph public and
  permanent, so render it: who brought whom, as a growing tree.~~ **DELETED 2026-09-25
  (`DECISIONS.md` D-187).** Never built. D-106 deleted `gifted_by` along with patron mode,
  so no contract field is left for the map to read.
- **Landing page** with the same live stats for the browser funnel, plus verified source
  links (Tonviewer from day one; the contract *is* the whitepaper).
- **Backend index and caching proxy** for chain reads: constant RPC cost regardless of
  audience size, and the browser never touches a node. Honesty constraint: cached display
  is the operator's assertion, so **every number the UI shows must map to a public
  get-method** (`get_floor`, `get_pending`, `get_owed`, `get_seed_t`,
  `get_flush_status`, `get_last_mint_time`, `getOpsSweep`, `getLiabilityBreakdown`,
  `getLotPrice`, `getStaking`, …) and the UI links each stat to its source call. Trust, verifiable.

  **The market price is one of them, and for most of this project's life it was not.** The
  PRIMES spot price is the only figure on the dashboard that describes something outside
  this system, so it was read from a DEX aggregator's public API — and that made the one
  number the market card exists to compare against `p_f` the one number on the card a reader
  could not check. It is read from the **pool itself** now: `get_reserves` and `get_assets`
  on the DeDust pool `getVenue()` names, so the spot is `reserveTon / reservePrimes` and both
  halves of the premium row are calls a reader can re-run. Three consequences worth stating,
  because each was a defect before:

  - The figure is a **mid price** — what a zero-size swap would pay, before the venue's fee
    and its own slippage — and the card says so. That is the correct thing to set against
    `p_f`, which is also a marginal price and not a quote.
  - **"No pool yet" became a chain fact.** An aggregator that does not index a chain and a
    pool that has never traded are indistinguishable from outside, and the app asserted the
    second when it was looking at the first. Undeployed, not-a-pool and deployed-but-empty
    are now three answers from the chain, not one silence from a vendor.
  - **A testnet deployment shows the same card as mainnet**, because a get-method answers on
    both and no public DEX indexer covers testnet. A surface that cannot be rehearsed before
    launch is a surface that launches untested.

  **And the pool is where a holder trades, so the app offers the trade.** A swap form sits
  above the ratchet on `/`: buy PRIMES with GRAM, or sell PRIMES for GRAM, against that same
  pool. It is the one ordinary thing a holder previously had to leave for a DEX front-end,
  and leaving meant a surface that knows nothing about `p_f` and cannot quote a testnet pool
  at all. Every figure in the form is a get-method reading like the rest of this list — the
  two reserves, the pool's own `get_trade_fee`, and the two wallet balances — and the quote
  is arithmetic over them rather than a vendor's quote endpoint. Two obligations come with
  it, and both are in the code: the minimum-out on the wire is always a real limit, never
  zero (DeDust refuses under it by paying the input back, which is a refusal and not a
  bounce), and the fee is READ rather than assumed. `get_trade_fee` on the live testnet venue
  answers 40/10000; the same call on a mainnet volatile pool answers 25/10000, and mainnet
  also runs 0.05%, 0.1%, 0.5% and 1% pools besides — same factory address on both networks,
  different code behind it. A venue's fee is a property of that venue, so quoting a swap from
  a constant would have under-stated every fill on this pool by 60%. §4.3 and §8.5 keep 0.25%
  because they cost the **mainnet** venue, and now say so.

  The two figures an aggregator *could* answer and reserves cannot — realised 24h volume and
  a 24h trade count — are **not replaced by an estimate**. The card publishes the pool's
  depth instead, which is a get-method, and the price history it plots is this deployment's
  own log of the `get_reserves` readings it has taken, labelled as readings rather than as
  a trade tape. Only the USD denomination is still borrowed: a GRAM/USD mark, applied to a
  price the chain gave us, shown beside the GRAM figure and never instead of it.

  **The treasury, LP custody and locked depth add these** (§5.5, D-100; the list is as D-168
  leaves it — `getMiner`, `getMinerSolvency`, `getTierWeights`, the position's `getAccrued`
  and its reward-debt fields are deleted with the LP miner, and the stake contract's own
  get-methods, `getStakeSolvency` among them, are §5.3's). Every
  number on `/governance` (the route D-142 renamed from `/treasury`; the CONTRACT keeps its
  name, and so do the `GET /treasury*` reads) or on a liquidity surface comes from this list
  and from nowhere else:

  | Contract | Get-methods |
  |---|---|
  | `primes_treasury.tolk` | `getTreasuryBalances` (GRAM less the rent floor, PRIMES, lpHeld, primesIn, tsTON), `getDistribution` (lastDistributeTime, interval, rateBps, nextBudgetEstimate, distributedTotal, stakeAddr — **the inputs; the chain computes no APY**. The stake form and the main page's stake card derive an *estimated* one from them and `getTreasuryBalances`' PRIMES: the fixed per-epoch share compounded over a year's epochs, split by weight with the stake counted; on an empty pot the form prices the typed amount as the first stake (the whole stream) and the card stays blank (`DECISIONS.md` D-182)), `getTreasuryCounts` (deposit and distribute events, for indexer reconciliation), `getGov` (next seq, eligibleWeight, cap bps, propose-min bps, vote duration, notice duration), `getProposal(seq)` (`opens` is when the vote opens, a notice after it was proposed), `getVotable(seq)` (is the vote open by the block's clock, and if not which error — 1206 in the notice), `getExecutable(seq)` (would it execute now, at what cap, and if not which error), `getPrunable(seq)` (D-188 point 7 — would `prune` delete it now), `getVoteMultipliers`, `getTierTerms` (the four LOCK TERMS, clock-divided), `getPositionAddress(owner)`, `getTreasuryActions` (the deposit payload tag), `getTreasuryMinForward`, `getTreasuryConfig` |
  | `primes_lp_position.tolk` | `getPositions` (count, nextId, voteWeight), `getPosition(id)` (amount, tier, lockedAt, expired, inFlight, **maturesAt** — the instant `withdraw` stops throwing AND the vote stops, which under D-147 are the same instant), `getVoteWeight` (this wallet's, less what `expire` has retired — an UPPER BOUND between a maturity and its poke, and the get-method says so), `getTierTerms` (the enforced copy of the ladder), `getPositionOwner`, `getPositionMinForward`, `getHasVoted(seq, id)` / `getVotedCount(seq)` (the one-vote record, D-188 point 7 — per POSITION since D-147) |
  | `primes_lp_sink.tolk` | `getLocked` (**locked depth**, TR-6), `getEvents`, `getLpSinkConfig` |
  | `primes_ledger.tolk` (changed) | `getOperatorTotals` is a **quadruple** — `(operatorPaidTotal, treasuryPaidTotal, opsSweptTotal, premiumTreasuryPaidTotal)` (D-100 made it a triple; `DECISIONS.md` D-114 adds the fourth; `opsSweptTotal` keeps its name but since D-117 counts gas & ops surplus returned to the ratchet pool, not operator income) — because the 5% line, the forfeit share, and now an auction premium's treasury share are three distinct revenue events that must not land in one counter, which is exactly the misreading §9.1 exists to prevent; and `getFeeDests` publishes `(treasuryAddr, operatorAddr, FORFEIT_TREASURY_BPS)`, so the 58/42 forfeit split (`DECISIONS.md` D-166) is a number the chain states rather than one the UI asserts (the 50/50 premium split is `PREMIUM_TREASURY_BPS`, a separate owner-set constant, §4.4) |

  **Naming adds one, and the burn sink's are gone** (`DECISIONS.md` D-212). The
  collection's `getNaming()` publishes `(nameFee, renameFee, named, renamed, toFloor)` —
  the two fees from deploy data and what naming has paid the floor — and the registrar's
  `getTrophyRenameFee()` a trophy re-engraving's fee; the item's `getNamer()` (its owner)
  and `getAnnotation()` say who may name it and which fee applies. A surface quoting a
  naming fee reads these, never `shared/params.json` (the first-naming fee has no figure
  there: it is chosen on genesis day). `primes_sink.tolk` and its five get-methods are
  deleted, and with them §3.3's sink-burn term: the identity's last term is the ratchet's
  burns alone.

  **And the treasury's LEDGER is the event log's, not a get-method's, which is the one
  place on this route where that is true.** `/governance` draws the three balances from
  `getTreasuryBalances()` and every governance figure from the table above — but *how a
  balance got to be what it is* is a question this contract cannot answer, because it
  stores no history. `GET /treasury/ledger` on the read-index serves it from the observed
  message stream (`treasury_events`), on exactly the footing D-24 grants `/feed/floor`:
  every row carries the seqno the index last confirmed and the get-method that settles the
  standing figure, and nothing on it is live-only because nothing on it is signed against.

  Two obligations specific to it. **An asset label on a ledger row is a JOIN, and the two
  that need one are named rather than guessed.** PRIMES and LP both arrive here as a TEP-74
  `transfer_notification` — the same opcode with the same body — so which jetton an inflow
  carried is decided by which of `getTreasuryConfig()`'s two wallets forwarded it, and by
  nothing else; and an `execute` message names only a proposal `seq`, whose asset is on
  `getProposal(seq)`. The index publishes both keys and refuses to resolve either, and
  `/governance` resolves them because it already holds both responses. **A row neither join
  resolves shows in no asset lane** — an un-bootstrapped treasury (`walletsSet: false`), a
  proposal outside the live book, or a vote, which moves nothing. Defaulting one of those
  into a lane would put a figure under a heading the chain does not support, which is the
  same class of bug as an invented parameter. And **an `execute` row is an ATTEMPT, never
  proof of a transfer**: a bounced execute resets `executed` on chain and is re-executable,
  so the amount stays on the proposal card, where it is read live.

  Five obligations follow, and they are §9.1 rules rather than copy preferences.
  **`maturesAt` is a bounded quantity, so the tier ring fills toward it** and the term
  ladder is never recomputed client-side. **A term ladder is printed in the clock the
  contract ENFORCES** — `getTierTerms()` divides by D-139's deploy-time divisor, so a
  testnet rung really is the hour it says; the mainnet term is named beside it as an
  annotation and never substituted for it, because printing what a different deployment
  would enforce is a lie about what this one will do. **A matured LP term is drawn as matured
  and not as finished** — the LP is still parked and still the depositor's, only its vote has
  stopped (D-147) — **and a matured stake is drawn as no longer earning**, because under
  D-168 it is not: earning stops at `maturesAt` and only `relock` restarts it. **The staking
  rate is drawn as an estimate and labelled one** — it floats with the treasury's PRIMES and
  with total staked weight, so a surface that renders it as a promised yield is making a
  claim the contract refuses to make. **No surface may present `getLocked()` as backing, collateral, or part of `T`**
  (§5.5.4): the floor and liquidity are two guarantees on two panels, and merging them would
  be the same class of bug as an invented parameter.

  And **an LP amount is chosen as a fraction of a read balance, never typed as a decimal.**
  The DeDust LP jetton carries its own decimals and *no get-method in this system publishes
  them* — the pool answers `get_jetton_data`, but the scale lives in its content cell and
  nothing here reads it. A control that multiplied a typed figure by 1e9 would be the app
  inventing an economic scale, which is the rule-3 bug one layer down; a control that offers
  four percentage detents over `get_wallet_data`'s integer needs no scale at all, sends an
  exact integer of the units the chain answered in, and draws the fraction as the shape it
  is. The depositor's own LP wallet is itself a derivation and not a configured role:
  **a DeDust v2 pool is the jetton master of its own LP token**, so it is
  `get_wallet_address(owner)` on `getVenue().dedustPool`, which is the same pool `/market`
  already prices PRIMES from.

  The same missing scale binds the READOUT as well as the input: **no surface writes a raw
  LP count as a figure a reader is asked to read.** A quantity in a unit with no published
  decimals is not a readable quantity, and printing its magnitude does not make it one. An
  LP holding is shown as its share of `get_jetton_data().total_supply` on the pool, and
  where the pair's own units are wanted, as that share of `get_reserves()` — derived,
  labelled as derived, with the exact integer in the proof (§5.5.4).

  **The minter card moves the per-wallet standing** (§4.5–§4.7.1, `DECISIONS.md` D-191 point 1).
  Every rank, window, uplift and era-tally figure on `/earn`, `/me`, `/leaders` or a mint
  quote comes from this list; a card that was never deployed is a wallet with zero standing:

  | Contract | Get-methods |
  |---|---|
  | `primes_minter_card.tolk` | `getMinterState()` (primes bought, prime tier, its uplift, prime window left), `getRecruitRank()` (lifetime recruits, tier, uplift, next tier's count), `getNewcomerWindow()` (left, `NEWCOMER_WINDOW`, `NEWCOMER_UPLIFT`, opened), `getUpliftLine()` (the four legs and their sum), `getEraRecruits()` (era seq, tally), `getStanding()` (all of the above in one call, for a reader that polls), `getCardOwner()` (ledger, owner, seen) |
  | `primes_ledger.tolk` (changed) | `getMinterCardAddress(wallet)` (where the card lives), `getKMaxFor(n, upliftSum)` (the clamped ceiling and whether `K_CEIL` bites), `getEraLeader()` (leader, count, **era seq** — a card's tally is this era's only under the same seq). The five per-wallet getters that took `owner` are the card's now |
  | `primes_lot_block.tolk` (D-196) | `getWords()` (the block's claim and sold-prime bits, n at bit `(n − 2) & 255`), `getLotBlockOwner()` (ledger, block) |
  | `primes_ledger.tolk` (changed, D-196) | `getLotBlockState()` (window in blocks, frontier block, block being imported or 0, whether an import is due now), `getLotBlockAddress(block)`, `getForfeitedBeyondWindow()` (§6 point 2's forfeit against primes beyond the frontier, summed); `isNumberOffHead(n)` answers −1 beyond the frontier, meaning "read the lot block" |

  **The invite line and the vault's payout journal add four** (§4.1, `DECISIONS.md` D-202;
  the build line's getters went with constellations and generators). Every invite figure in a
  checkout or on a dashboard comes from this list:

  | Contract | Get-methods |
  |---|---|
  | `primes_ledger.tolk` | `getInviteTerms()` (the live operator-set count and value, then `INVITE_SEND_FEE`, `INVITE_LINE_CAP`, `INVITE_COUNT_CEILING` — the three fixed bounds, D-215), `getInviteComment(n)` (the exact comment an invite from `n` carries), `getInviteText()` (the operator-set words alone, D-211), `getInviteSpend()` (slots funded, transfers sent, slots returned to β, GRAM delivered, GRAM the line cost — so the invite line closes against `count` in public and §4.1's "unspent → β" rule is checked rather than asserted) |
  | `primes_bounty_vault.tolk` | `getVaultFunded()` (the genesis funding an era bounty or rebate must fit under, `funded − paid`; V26.7), `getDeferredPayouts()` (bounties owed but not delivered — the count and the journal-key bound a retrier walks; D-129), `getRetryEntry(key)` (one journal row and whether a retry of it would pay, so a retrier reads before it sends; GAUNTLET.md G59) |

  **AMENDED 2026-08-19 (`DECISIONS.md` D-24): the rule gains a second clause, because the
  app now reads primarily from an index rather than reconstructing every screen from live
  get-methods.** Response time is a game-feel property and a read path that re-derives
  everything per load is what makes the app slow — but a cache that cannot say how old it
  is turns the honesty rule into a claim about the operator's plumbing. So:

  > **Every number the UI shows maps to a public get-method *and states when it was last
  > read from chain*.** *(D-206: "states" means on request — the proof drawer — not a mark
  > drawn beside every figure.)*

  Four obligations follow, and they are the acceptance criteria for the index:

  1. **Provenance is mandatory, not optional.** Every value the index serves carries the
     block sequence number and timestamp it was read at. A value with no provenance is not
     servable — which makes it structurally impossible to render a stale reading as a
     fresh one, rather than merely discouraged.
  2. **~~Staleness is drawn, not printed.~~ Deleted by `DECISIONS.md` D-206 (2026-11-18).**
     No per-value age mark is drawn — no ring, no "9s" label: it shifted layout every poll.
     Data refreshes in the background; a value's read time stays one press away in its
     proof drawer (`source`, `fetched_at`), and obligation 4's strip is the app's one
     "behind" signal.
  3. **Money-critical surfaces still read live.** Mint price, floor `p_f`, `T`/`S`, escrow
     balances, standing lot price, and anything a user is about to sign a transaction
     against. The index is for *browsing*; a number you are about to spend against comes
     from the chain.
  4. **A degraded index is visible.** When the indexer falls behind or restarts, the app
     says so on its face. The read-proxy stops being stateless under this decision, and a
     catch-up story plus a visible degraded mode is the price of that.

  **`getLiabilityBreakdown()` is the case that shows the rule applies to the operator's own
  numbers hardest.** `getSolvency()` already published the total, and a total was enough
  right up until the question became *which* obligation the delta moved — because the sweep
  moves everything above that total (to the operator until D-117, to the ratchet pool since), and a reader watching one number cannot
  tell protocol float from money already promised to named owners (see §4.1's enumeration).
  Publishing the three components costs one get-method and converts an assertion the reader
  has to accept into a subtraction they can perform.

  **`getLotPrice(n)` (named `getReservationPrice(n)` before D-30/D-31's rename) is the case
  that shows what the rule really demands.** Since
  §9.6's score prices every lot, the bid button quotes a price that varies per number, so a constant in
  the frontend would be wrong for most numbers and the transaction would be rejected
  on-chain after the user signed. But mapping the *total* to a get-method is not enough on
  its own: the form also explains *why* the number costs what it costs, and an explanation
  is a claim too. So the get-method returns `D(n)` **and the category bitmask `flags`**
  alongside the price, `getScoreBreakdown(n)` re-publishes the same pair from `n` alone, the
  weight table is published entry by entry by `getScoreWeights()` (~~`getDesirabilityParams()`~~
  — deleted with the old score, `DECISIONS.md` D-99), and the UI recomputes the score locally
  only to name the predicate — showing a warning if its own score disagrees with the chain's.
  Since D-99's factorization phase (§9.6) that mapping has a second half: some categories are
  decided by the factorization rather than by `n`, so a surface quoting a composite whose
  factor list the buyer is about to send must read `getLotPriceFrom(n, factors)` — the
  from-`n` quote is a published LOWER BOUND (§9.6), and showing it as the price would quote
  a number the chain will not charge, which is the exact failure this rule exists to
  prevent.
  The rule is *recomputable*, not merely *sourced*. `get_flush_status` is new
  and not optional: under the floor guard (§4.3.1) a long gap between buys is normal and
  informative, and the UI must show *why* — "last flush bounced: market above floor" — or
  the same silence reads as abandonment.

  **AMENDED 2026-09-09 (`DECISIONS.md` D-112): the rule gains its FIRST and only exception,
  and it is an exception about a number no contract can ever produce.**

  §12's royalty leg and §5.4's holder thesis both depend on trades happening on a secondary
  market, and the app must therefore point at one. But *how that market is doing* —
  cumulative trading volume, the standing floor price, how many are on sale right now — is
  not chain state and cannot be made into chain state: no contract in this system records
  what its items later sold for on a third-party venue, and none ever will. The choice was
  between showing nothing about the market the game's own royalty depends on, and showing a
  number that is true but not ours. The second, under conditions:

  1. **It is a DIFFERENT TYPE on the wire, not a fourth `source` value.** Chain reads carry
     `Provenance` (`getMethod`, `contractAddress`, `source: live|cached|stale`); a
     marketplace figure carries `MarketplaceProvenance` (`source: "marketplace"`, the venue,
     the endpoint, and the URL a human opens to check it). A client cannot pass one where
     the other is expected, which is what stops a marketplace figure reaching a proof
     drawer that cites get-methods. This is the same discipline `ConfigProvenance` already
     established for deployment addresses, and for the same reason.
  2. **It is drawn differently, not merely labelled differently.** A marketplace figure is
     never offered the `ProofLink` control — there is no get-method to cite — and sits in a
     visually separate block under the venue's own badge.
  3. **It never substitutes for a chain figure.** The issued-item count on the collection
     card is a get-method return (`getLaunch().itemsMinted`), never the index's own item
     count.
  4. **Its absence is stated, never rendered as zero.** No market file, figures not yet
     computed for these addresses, or an unreadable file each produce a named reason on the
     card; the chain-side half renders regardless. And a collection that has simply never
     traded is NOT an absence — it reports zeros with a null floor, because "nothing has
     sold yet" and "we could not find out" are different answers.

  **The source is an aggregate, not a venue.** The figures are computed daily from the free
  GRAM data lake's `nft_events` (`tools/lake/market.sql`, `DECISIONS.md` D-201) — every
  marketplace on TON, rather than one shop's view of its own order book — and anyone can rerun
  them with no account. **Volume is secondary only**: a venue's
  headline blends its own primary mint revenue in, and this game's primary sales are the
  1 GRAM mints the same card already reports from a get-method, so blending would
  double-count what the chain answers. Validated against GetGems' own published figures for
  a third-party collection: the live listing count agrees to within 1.4%. The lake indexes
  mainnet only, so a testnet card states `not-indexed` rather than a row of zeros.

  The exception is bounded to these quantities on this one collection and does not
  generalise. Nowhere else may a surface show a number the chain did not return.

  **The collection has a name, and the name is a §9.1 surface obligation too.** The game
  issues one TEP-62 collection, §3.1's numbers, and its TEP-64 document names it **PRIMES:
  Certificates** (every item is a certificate — a submitted factorization for a composite,
  an on-chain Miller–Rabin certificate for a prime), published under the GetGems short link
  `certificates`. (It issued three until `DECISIONS.md` D-202 deleted *PRIMES: Generators*
  and *PRIMES: Constellations*; `validatePresentation` checks the collection and the jetton.)

  **The auction lane adds four get-methods, and turns one existing one into a refusal.**
  `getLotLane(n)` (formerly `getIsAuctionOnly(n)`) says which lane a number is on — and runs Miller–Rabin itself
  rather than trusting a caller-supplied `kind`, because since §4.4 point 1b the lane
  depends on primality; `getLotPrice(n)` returns the opening bid `P0(n)` with the score, the
  category bitmask and the settlement gas, so *"why does 1000 open at
  73.5 GRAM"* is answerable without reading bytecode and the same recompute-don't-trust rule
  applies as above; `getLot(n)` returns the standing high bid, the high bidder,
  `MIN_INCREMENT` and the live `closesAt` **including every snipe extension**, which is
  the one field a UI must never cache; and `getMarketStats()` publishes the open book's
  size (`openLots`). There is no on-chain enumeration of the book (and no reservation book —
  D-30): the list of open lots comes from the read-index (`GET /lots/open`), and each row it
  serves is checkable against `getLot(n)`.

  **On the descending prime lane three of those four read differently, and one more is
  required.** `getLot(n)` on a `MODE_DUTCH_BUYNOW` lot returns no high bid and no
  bidder — there are none — and a `closesAt` of zero, which the UI must render as *"no
  close: this price rests at its resting price"* (`max(NPV(p)/2, P0(p)/3, MINT_PRICE)`) rather than as an expired or malformed lot.
  `getLotPrice(n)` must publish the **standing** price alongside `P0` and the floor, since
  on this lane the number that matters changes every block. And the ledger's
  `getForfeited(p)` / `isPrimeUnsold(p)` are the surface for §4.1's treasury carve-out:
  **a prime lot page must state, on the page, that its tribute is being paid to the
  treasury until it sells, and how much has been so far.** That is the disclosure §4.1
  makes and §9.1's honesty rule turns into an obligation.

  **`getLotPrice(n)` must now refuse
  rather than quote for any auction-lane number** — the same rule `getIsOpenable(n)`
  already applies to §7 primorials, that *a number that is not for sale is not quoted at
  zero as if it were free*. The case that makes this load-bearing is a plain prime scoring
  `D(n) = 0`: a threshold-only implementation would quote it at 1.05 GRAM and the
  transaction would be rejected on-chain after the user signed. The webapp computes the
  lane locally to name the reason, exactly as it does the score, and a disagreement with
  the chain's answer is a warning on the screen rather than a silent divergence.

  Two obligations on the lot surface itself, both §9.1 rules rather than copy preferences.
  It shows the score **with its named contributing predicate** next to `P0`, for the same
  reason the reserve form does. And it states the bypass in plain words — on an ascending
  lot, *you can also just wait for the head and mint it for 1 GRAM*; on a prime lot, *you
  can also just wait for this price to reach 1 GRAM, and it always does* (§2 principle 7) —
  because omitting it would be the single most misleading thing this product could leave
  off a screen.

  **The operator's own revenue is not exempt from this rule** — it is the number a hostile
  reader most wants to check, so it gets a get-method before it gets a recipient.
  `getOperatorTotals()` meters every GRAM the operator has been paid (since D-117 only the
  forfeit remainder), and `getOpsSweep()` publishes the currently-sweepable gas & ops
  surplus and the reserve it is measured against — a surplus that goes to the ratchet pool,
  not to any address (§4.1). The treasury line is already
  visible as a split output on every mint, and the §3.1 royalty is a marketplace
  convention that this project deliberately excludes from every published projection.

- **Two prices, both on screen, both named.** The floor and the market price are different
  numbers by construction (§6 point 3: the bounty vault sits in `S` with no `T` behind it),
  and a dashboard that shows one invites the reader to assume it is the other. Quote both
  as **PRIMES per GRAM** — at genesis, 10,000 at the market and 20,000 at the floor — because
  `0.0000833` is the same fact in a denomination nobody can read at a glance, and a
  mis-parsed exponent is the most likely way this dashboard lies by accident. At `L = 10,000`
  every PRIMES figure on the dashboard gains a digit, so **thousands separators are part of
  the rule, not a styling preference**: an ungrouped five-figure reward is a number the
  reader has to count.

- **The asset side needs surfaces, and today it has none.** §5.4 argues that value rotates
  toward the numbers; a holder currently cannot see the cash position of anything they own,
  which makes the asset side unpriceable in practice and leaves selling the rebate as the
  only legible action. Three surfaces close that, all on routes that already exist:

  - **The `Number` route** shows the number's own cash position — referral `owed` from the
    item, tribute `owed` and claimable flat dividend for a prime. This is the use §3.2.1 already names as the reason
    `get_owed(p)` exists: price a prime from its actual cash flow rather than from a story
    about divisor density.
  - **The `Me` route** shows portfolio cash flow. *(It also showed the PRIME GENERATORS the
    wallet was sent and the constellations it built, which `DECISIONS.md` D-202 deleted, and
    before that a near-miss board that D-102 deleted with the set registry.)*
  - **The rotation panel** renders §5.4's table as the demand-side twin of the floor
    staircase, with the current head marked on it.

  **The derived-rate rule, because the asset side is the one place the §9.1 constraint
  bites hardest.** Every asset exposes a *stock* — `getOwed()`, `getDivAcc()`,
  `get_owed(p)` — and none exposes a *rate*, so "prime 211 earns X GRAM per 1,000 numbers of
  head progress" cannot be read off a single get-call. Storing trailing accrual counters
  on-chain is rejected: it spends real gas and state rent against the gas & ops line (20% since `DECISIONS.md` D-117) §12
  calls the tightest budget in the system, to store a number that is arithmetically implied
  by state that is already public. So the rule is stated rather than the counter added:

  > **A rate may be displayed if the derivation from get-methods is published next to it.**
  > The inputs — the two `owed` readings, the two heads they were read at, and the
  > get-methods they came from — are rendered with the output, so a reader recomputes the
  > rate rather than trusting it. A derived rate carries a distinct marker from a
  > get-method value and from a `SIMULATED` one; the three are never rendered alike.

  This satisfies §9.1's actual requirement — recomputable from chain state — without buying
  it with gas, and it is the honest boundary of §12's "the growth backend is a trusted
  display layer": the stocks are on-chain, the rate is the operator's arithmetic over two
  of them, and the UI says which is which.

  One genuine hole closed with the flat dividend itself: `div_acc` alone does not make
  `claimable(p) = div_acc − entry[p]` readable. The stamp is published where it lives —
  the ledger's `getDivEntry(p)` / `getClaimableDividend(p)` while `p` is unsold (−1 once the
  item holds it), and the item's `getDivEntry()` / `getClaimableDividend(div_acc)` after the
  sale (D-188 point 4).

- **Copy constraint, and it is a constraint rather than a preference.** The shipped
  vocabulary is **PRIMES — floor-bound, monotone, collateral-grade** and **the numbers —
  the cash-flow half** (§5.4). "Savings account" and "equity" are forbidden in any public
  surface: the first implies redemption, which §5.1 and §12 explicitly deny, and the second
  implies a claim on enterprise profit, where the NFTs hold a claim on a fixed protocol fee
  line and §2 holds that the team takes fees, never supply. "Equity" additionally imports a
  securities register into a document whose §12 defence against the Ponzi label is
  structural and would be weakened by a loose analogy. Both are good internal shorthand and
  neither survives contact with a reader who checks. The same discipline as §12's *no
  return promises anywhere in copy*, applied to two specific words.

### 9.2 Referral links and attribution

The referral key is an NFT number (§3.1), which makes the deep-link layer almost free:

- **One grammar everywhere:** `{key}_{source}_{clickid}`, carried as `?ref=` on the web,
  `?start=`/`?startapp=` on Telegram (64-char cap, degrade by dropping clickid then
  source, never the key), baked into QR creatives, and — on-chain — as the `rN` field of
  a mint. Direct-to-Mini-App links (`?startapp=`) are the default for shared links:
  every extra tap costs users.
- **Attribution rules, stated openly:** last-touch, 30-day sliding window, resolution
  priority at transaction time = explicit key in the mint > key recorded for this
  Telegram user > key recorded for this wallet. Off-chain attribution exists *only* to
  pre-fill the `rN` field and score quests; **the payment always follows the on-chain
  key in the mint itself.** Once a wallet's first mint lands, its off-chain mapping is
  frozen to the key that mint cited — read back from the chain's own mint record, never
  written by the operator, so it rebuilds from chain — and retroactive attribution wars
  are not a thing.
- **No operator capture:** unattributed traffic has no default key; its referral line
  backs the pool (§3.1). Partner links can never be silently overwritten by the
  protocol's own links.

### 9.3 Minting by text comment (withdrawn)

**Withdrawn by `DECISIONS.md` D-178.** There is no comment-grammar mint: the ledger accepts only
typed message bodies and refuses a text comment. A mint is a typed message built by the app
(TON Connect) or by a program through the agent SDK (§9.10), either of which reads the head first. The section number is kept so older citations
resolve; nothing else lives here.

### 9.4 Quests and verified virality

Quest rewards pay in PRIMES from the bounty vault, and **every social quest pays only on
measured outcomes**:

- *Social quests (the acquisition funnel):* join the announcement channel
  **@gram_primes**, join the community group **@primes_community**, still be in
  both seven days later, and **connect** — link the wallet to a Telegram account (D-73
  option 3, D-118; point 5 below). These are the quests that exist to grow the player base, and
  they are the ones a farmer would attack, so three things hold them up at once:

  1. **Telegram answers, not the player.** Membership is a `getChatMember` call the
     bot makes with its own token at the moment of issuance, and the Telegram
     identity behind it arrives as a Mini App `initData` payload that Telegram
     HMAC-signs. Neither is a chain fact and neither is ever labelled `proved` —
     they are `counted` — but neither originates with the claimant either, which is
     the property that distinguishes this track from the story track above. `initData`
     vouches for a Telegram account, not for the wallet a request names, so it scores
     only for a caller holding that wallet's sign-in session — otherwise anyone's
     membership could complete a stranger's join quests (security audit 2026-11-20). Outside
     Telegram the identity is the wallet's stored link instead (point 5 — every link row
     was written with both halves proved), asked about only for a caller holding the
     wallet's sign-in session, the same gate `/link-status` has. A forged or absent
     `initData` yields the same result: the stored link if there is one, otherwise no
     membership facts at all.
  2. **The mint gate, unchanged.** Nothing here pays before an on-chain mint is
     attributed to the wallet (decision 0.2.1). So the cheapest attack is: make a
     Telegram account, join two chats, and spend 1 GRAM — to collect a reward worth
     a small fraction of it. Farming is a loss-making trade by construction rather
     than by policing, and it stays one however cheap Telegram accounts get.
  3. **A ceiling that is an invariant, not a budget.** Everything one wallet can
     ever earn from voucher-settled quests is capped at **`β · MINT_PRICE`** — the
     ratchet injection of the mint that unlocks it. Below that line a quest-paid
     wallet strictly *raises* `p_f`: the payout leaves `S` untouched (§3.3
     pre-counts the whole vault) while the gating mint adds `β` GRAM to `T`. Above
     it, the program stops being self-funding and becomes a claim on other holders'
     backing. The cap is in `params.json` and asserted in the backend's tests
     against the summed board, so a future quest addition fails loudly rather than
     quietly.

     **D-42 changed where that assertion has to happen, and the change is
     load-bearing.** While the social rewards were GRAM-denominated, the cap could be
     checked once, at design time: the board's worth never moved. Now that they are
     PRIMES-denominated their worth is the floor path, so the board grows into the
     ceiling on its own — around the sim's second year. The payout is therefore
     **clamped at claim time** to `β · MINT_PRICE / p_f` nano-PRIMES, and the
     backend's test sweeps floors well past the sim's end state rather than checking
     genesis alone. A genesis-only check would pass forever while the real payout
     climbed past the line.

  4. **"Seven days later" is a RECORD, not a subtraction.** The third social quest
     asks the player to still be in both chats a week on, and the only honest way to
     answer that is to have looked on each of those days. So the bot sweeps
     `getChatMember` over every Telegram identity the service holds a wallet link for
     and writes one row per identity per UTC day — a membership *observation*, with
     the same `counted` provenance as point 1, because it is the same call. The
     quest's progress is the number of consecutive days, ending today, on which that
     record says the player was in both. Three consequences, all of them checkable:

     - **A leave restarts the clock rather than banking it**, which is what the quest
       card promises, because the walk stops at the first day the record says no.
     - **A day nobody observed breaks the streak exactly as a leave does.** Gaps are
       never backfilled: this service does not get to assert a membership it did not
       see, and the absence of evidence is not evidence in the player's favour any
       more than against them.
     - **Our own outage is not a leave.** A day Telegram could not be *asked* about —
       the bot removed from a chat, a rate limit, a network failure — is written by
       nobody rather than written as a `false`, because a refusal to answer is a fact
       about us and never a fact about the player. The sweep runs twice daily so a
       transient failure usually costs nothing at all.

     A player whose wallet the service holds no Telegram identity for has nothing for
     the sweep to ask about, and therefore no record and no streak. There are two ways
     to hold one — opening the Mini App from inside Telegram, or confirming the link in
     the bot (§9.9) — and until the second existed this sentence read "has never opened
     the Mini App", which was the whole requirement. That is the same requirement the
     two join quests already carry, and it is why the board says so in the app rather
     than showing a counter that cannot move.

  5. **"Connect" is scored from the stored link, not from the request.** The fourth
     quest (D-118) reads whether the wallet has a `wallet_telegram_links` row, and only
     §9.9's two doors write one: a Mini App request whose `initData` Telegram signed, or
     a one-time code the wallet's own session minted and the Telegram side confirmed in
     the bot (D-150). It is therefore the one social quest a browser can move, and `/earn`
     walks a browser player to `/me`'s Connect Telegram card instead of telling them to
     open Telegram. The bot's `/connect` command *reads* the link and the mint gate — the
     same event-index gate the voucher signer reads — and writes nothing; `/unlink`
     deletes the row and the quest reads 0 again. The mint gate (point 2) and the ceiling
     (point 3) apply to it exactly as to the other three.

  **There is deliberately no "bring a friend" quest here, and the omission is the
  decision** (D-41, upheld by D-42). §4.1 already pays 10% of every mint to the
  recruiter, in GRAM,
  forever. That line is funded by the *flow* of mints, so it grows with the thing it
  is buying; a vault-funded bonus on top would spend the scarcest budget in the system
  paying twice for one event. Recruitment therefore belongs in §9.1's presentation
  problem — the referral line made vivid — and not in the quest board.

  **What bounds this program is inventory, not solvency, and the bound is `T₀`.**
  The bounty vault is pre-counted into `S` with no `T` behind it, so the whole vault
  is worth `T₀ · vault_pct / (1 + vault_pct)` GRAM at the nominal genesis floor (D-46:
  `T₀` is a sizing input, not a real deposit — this figure is a calibration reference, not
  a claim about real backing at deploy). Raising the
  vault fraction *does* raise that figure — D-41 took it from 33 to 67 GRAM, D-42 to
  100 GRAM at 100% of the nominal-sized `T₀·L`, and D-43 to 166.67 GRAM at
  500% (D-166's smaller `S₀` makes it `T₀ · V / S₀` = 10/11 of `T₀`, 181.8 GRAM; D-204's 780% makes it 78/83, 188.0 GRAM), to fund a puzzle
  campaign that D-47 replaced with §9.6's special-number rebates — and pays for the raise entirely in the nominal opening floor reference (§6
  point 3). What it
  cannot do is pass `T₀`, because `pct/(1 + pct)` converges on 1,
  and each doubling buys strictly less than the last. So a social-quest budget is a
  slice of a fixed quantity bounded by the nominal seed, and the honest place to fund
  *growth at scale* remains the flow rather than the stock.

  This is the constraint that decided D-42's shape. Paying 10,000 players 0.5 GRAM each
  is 5,000 GRAM — twenty-five times the entire nominal seed, and at opening prices
  75,000,000 PRIMES against a genesis supply of 4,000,000. No vault fraction reaches it
  and no reallocation of the other tracks comes close; only a `T₀` around 15,000 GRAM
  would. The headcount and the per-player prize cannot both be chosen.

  **What the program offers, and what that buys (D-42).** Given that the two cannot both
  be chosen, the owner chose the **headcount**: the `quests` track is divided into
  **1,000 equal rewards** (`DECISIONS.md` D-204; D-42 set 10,000, and D-204 traded nine
  wallets in ten for a reward ten times the size), and every player who finishes the board
  draws the same number of PRIMES whenever they finish it. The track is **2,450,000 PRIMES**
  (26.4 GRAM at the opening floor) — so one player's whole board is **2,450 PRIMES**, split
  in **equal fifths across five quests — these four and the story quest below**, 490 each
  (D-118, owner-signed 2026-09-22 as quarters over the four, amended 2026-11-20 to fold the
  story quest in; it was 30/30/40 across three before `connect` joined). The split is
  owner-set and the sim publishes it as whole PRIMES by largest remainder, so the five rows
  sum to exactly the per-player reward and the track is unchanged. This is also the `QSTS`
  voucher's per-wallet cap (§9.5).
  The track is spent first come, first served, until it is empty.

  **The reward is therefore denominated in PRIMES, and its worth is the floor path.**
  2,450 PRIMES is **0.0264 GRAM** at the opening floor (`p_f0` = 1.0769e-05, D-204); alone it
  would reach `β · MINT_PRICE` once the floor has risen **~9.5×** (`genesis.quest_rewards.cap_binds_at_floor_multiple`), but
  the cap is shared with the contract-fact board below, and the two together — 8,800 PRIMES —
  reach it at **~2.6×** (`prime_quests.combined_cap_binds_at_floor_multiple`). The clamp above catches it there, and
  the sim's three-year horizon ends at 428.9× the deploy floor (`final_state.floor_appreciation`).
  **So since D-204 the nominal PRIMES figure is an opening-weeks figure**: past roughly twice
  the opening floor a claim pays a fixed worth and a falling count. D-42's bet — a small
  reward that appreciates for years — is no longer what this board does; D-204 chose a reward
  that reads as one on day one.

  *(Reconciled 2026-09-23 by owner ruling: the sim's `genesis.quest_rewards` — then 245 PRIMES over
  a 2,450,000-PRIMES track, five times the pre-D-43 figures this paragraph used to carry — is
  right, and the paragraph now quotes it.)*

  **This deliberately reverses the denomination rule below for this one track**, and the
  reason is that the two tracks are promising different things. The in-game quests promise
  a *worth*, so the worth is fixed. The social board promises that a *stated number of
  players gets paid*, and a fixed headcount out of a PRIMES-fixed stock is only possible
  if the per-player draw is fixed in PRIMES too. Under the previous GRAM denomination the
  early players were the expensive ones — 0.25 GRAM cost 3,750 PRIMES at the opening floor
  and roughly 10 PRIMES at the end state — so the track funded 65 players in the first
  months and the remaining 9,935 only years later, which is backwards for an acquisition
  funnel. Fixing the PRIMES inverts it: the count is guaranteed and the value is what
  grows. Inflating with the floor is the feature here, and the clamp is what keeps that
  feature from crossing §5.

- *Story shares:* the bot renders a personal 9:16 QR image (live floor staircase + the
  sharer's key baked in) for Telegram Stories; the share quest — a fifth of the social board
  above, in PRIMES (D-118 amended 2026-11-20; it was a legacy GRAM figure, ~6,191 PRIMES at
  the opening floor, outside the `quests` track) — pays only after **N
  counted arrivals tagged with that story's source label** — a bot `/start` or a wallet
  connected in the app, one per Telegram user or wallet (`DECISIONS.md` D-213: the QR opens
  the Mini App directly, so a scan never reaches the bot as a start). Reach, not a
  screenshot — and every quest pays at most `target_wallets` distinct wallets per voucher
  instance, so a farmed quest cannot spend another's share of its track. Counted arrivals are
  still just Telegram accounts and fresh wallets, which cost cents or nothing —
  the one place the growth stack was cheaper to farm than to use — so the quest pays
  only when **at least one on-chain mint** citing the sharer's key has paid its referral
  line: principle 6, applied to the last line that was exempt from it. *(`DECISIONS.md`
  D-160: checked at KEY granularity — a paid referral mint on a number the sharer owns —
  not per card, because the event index publishes counts, not which arrival minted. A
  sharer with two story cards meets it from either. The social quests' own mint gate is
  the claimant's: a mint they paid for whose referral line paid — `GAUNTLET.md` J9.)*
- *Referral quests:* first referred mint, N active referees (measured by their on-chain
  mints), first gift mint (§4.5).
- *Recruit quests:* first recruit introduced, rank tier reached, era-recruit streak,
  era-trophy contention (§4.6, §4.7) on the giver's side; first mint → fifth mint on the
  recipient's, timed to land inside the `NEWCOMER_UPLIFT` window (§4.6) so the newcomer's
  best rebates and their first quest rewards arrive together. Every condition is already a
  contract fact — "was gifted" is the minter card's `getNewcomerWindow()` `opened` bit, set by the gift
  and never cleared, not `left > 0`, which reads 0 again after the fifth mint (`GAUNTLET.md`
  G80). They pay through §9.5's **prime-quests voucher** (`DECISIONS.md` D-171):
  no contract verifies a quest in its own claim transaction, so the operator signs a total
  computed from chain facts the event index observed — a `proved` fact relayed by a
  signature, capped by the vault at `prime_quests`.
  *(`DECISIONS.md` D-106 merged what were two tracks into this one, and dropped the three
  quests whose subject it deleted: "first patron mint", "first purse released" and "first
  gift claimed inside 24 hours". Two tracks over one event would have paid twice for one
  act.)*
- *Prime quests:* first prime minted, first prime named, first tribute received on a prime
  you found, prime rank tier reached. Like recruit
  quests every condition is a contract fact, paid through the prime-quests voucher, and
  they are the quest track pointed at the game's one liveness risk (§5.1).
- *Game quests:* first tribute claim, first reservation.
- Locked-but-visible quests tease the next step; a browser visitor's Telegram-bound
  quests deep-link into the bot carrying their live attribution.

**In-game quest rewards are denominated in GRAM, not in PRIMES**, and the board shows the
PRIMES that GRAM buys at the current floor, labelled with the rate. A fixed nominal PRIMES
reward is not a fixed reward: §5's ratchet lifts `p_f` forever — ~45× over year one at
baseline demand — so a reward written as "100 PRIMES" quietly multiplies its own value
against a budget the vault fixed once, at genesis. What the design decides is what a quest
is *worth*; the token count is a quote.

**The two headcount boards are the exceptions, and they are exhaustive** — the social board
(D-42) and, since `DECISIONS.md` D-171, the contract-fact board (referral, recruit, prime,
game), sized by the sim as `prime_quests / 1,000` wallets = 6,350 PRIMES split across its twelve
quests, 104 to 1,301 each (`DECISIONS.md` D-204; it was `/ 10,000` = 75 PRIMES, 1 to 15 each). No voucher-paid quest is GRAM-denominated since D-118's 2026-11-20 amendment folded the story quest into the social board. Both boards live under **one**
`β · MINT_PRICE` ceiling per wallet, each row clamped to its share of it, so two boards never
pay twice the cap. D-42 fixes these rewards in PRIMES because there the
design decides a *headcount* rather than a worth; the argument is above, and the clamp is
what keeps the exception from becoming the inflation this rule exists to prevent. Whichever
unit is fixed, the UI must lead with that one: presenting a moving quote as the promise is
the §9.1 problem in a different costume.

One consequence is load-bearing enough to belong in the spec rather than only in the code.
A rising floor makes a GRAM-denominated reward worth *fewer* PRIMES over time, and §9.5's
voucher total is a high-water mark that strands rather than refunds any decrease. So the
GRAM→PRIMES conversion happens **once, at the moment a quest completes, and is persisted**;
the PRIMES-denominated social rewards are persisted at completion too, for the same reason
running the other way — the clamp can only ever *lower* a payout as the floor rises, so an
unfrozen social reward would regress across the clamp's crossover exactly as a GRAM-
denominated one regresses everywhere;
it is never recomputed at read time from the current floor. A quest completed at open keeps
what it was worth at open. Re-deriving it would shrink an earned total on every mint, the
signer would refuse the regression — correctly — and a player who had earned money would
be unable to collect it.

### 9.5 Bounty claims: signed vouchers

Off-chain-scored rewards (quests, puzzle placements) are paid by **Ed25519-signed
vouchers**: the backend signs `(wallet, cumulative_total, valid_until)`; the claim
contract pays only the delta over what that wallet already claimed, and the claimant
pays their own gas. Idempotent by construction (replaying a voucher pays zero), cheap
for the protocol, and the signing key can be burned to end the program without stranding
anyone's earned balance. On-chain-checkable rewards (era
bounties, puzzle answers expressible as contract calls) skip vouchers entirely and
verify in the claim transaction.

**STATUS: SHIPPED** (EARN_PLAN E2, `contracts/contracts/primes_voucher.tolk`). Three
details this section left open, resolved in the implementation and recorded here because
each one is a promise that had to become arithmetic:

- **"the signing key can be burned … without stranding anyone's earned balance"** is now
  an assert, not a policy. `burn_signer` requires `claim_deadline >= now + 90 days`, so a
  burn always leaves every holder of an already-signed voucher a full quarter to redeem.
  Signatures stay valid after the burn — refusing them would be exactly the stranding this
  clause forbids — so the end of the program is the DEADLINE, not the flag. The burn is
  one-shot, so the deadline cannot be walked forward to fake a live program.
- **The burn is authenticated by the signing key itself**, not by an owner address. The
  contract has no owner field. Whoever holds the key may retire it and nobody else can,
  and holding the key is already strictly more power than retiring it — so the path adds
  no authority that did not already exist, and §8's "no admin withdraw" is untouched.
- **A voucher total may never go down, and the reward denomination is why that is not
  automatic.** The contract pays `cumulative_total − already_paid` and stores the total, so
  a total that ever decreases pays zero from then on and the difference is *stranded*, not
  clawed back. Every voucher-paid reward is a PRIMES row clamped at claim time to its share
  of `β · MINT_PRICE` (§9.4; no GRAM-denominated one is left since D-118's 2026-11-20
  amendment), and that clamp quotes fewer PRIMES as the floor rises, so the per-quest figure
  is frozen at completion and the cumulative total sums those frozen amounts. The signer additionally keeps its own high-water mark per
  wallet, program and voucher instance (the contract's address, so a fresh genesis starts every
  wallet clean — the frozen per-quest figures are keyed the same way) and refuses to sign below
  it, which turns any scoring bug into a refusal instead of into a balance quietly disappearing.
- **The budget is the vault's, not the program's.** The claim contract holds no PRIMES and
  cannot mint any; it asks the bounty vault to pay, and the vault refuses unless the
  program is in the allow-list baked into its deploy data, up to that entry's `remaining`
  (`params.json genesis.era_bounty_schedule.remaining_vault_split.tracks.quests`). A
  refused payout bounces and rolls back the claimant's high-water mark, so a program that
  is not allow-listed cannot silently consume anyone's balance.
- **…and each instance bounds what ONE wallet can take (audit 2026-11-19 R2-M2).** The track's
  `remaining` bounds the program, not the wallet: a stolen key could sign "this wallet earned
  the whole track" and drain it in one claim. So every instance carries a write-once
  `maxPerWallet` in its deploy data, and a claim whose signed total is above it is refused
  (716) before the receipt is touched. The receipt stores the signed total, so this bounds a
  wallet's lifetime payout however many vouchers it redeems; `getMaxPerWallet()` publishes it.
  The figures are params.json's, one definition (`shared/voucher.ts` `VOUCHER_MAX_PER_WALLET`)
  read by genesis and by the signer, which refuses to sign above it: `QSTS` one wallet's whole
  social board (`quest_rewards.reward_nanoprimes`, 2,450 PRIMES), `PQST` one wallet's whole
  contract-fact board (`quest_rewards.prime_quests.reward_primes`, 6,350), `SECU` the whole
  1,000,000-PRIMES track, because D-170 pays one prize to one wallet. A key thief now needs a
  fresh wallet per cap's worth — about 1,000 per track — each claim carrying its own ≥ 0.15 GRAM.
  **Resolved the same day (owner, D-118 amended 2026-11-20):** §9.4's `story-verified-reach`,
  then GRAM-denominated outside `reward_nanoprimes` (~6,191 PRIMES at the genesis floor, above
  this cap), is now a fifth of the 2,450-PRIMES social board, so every `QSTS` quest is inside it.
- **The high-water mark lives on a per-claimant receipt, not on the claim contract
  (`DECISIONS.md` D-191 point 2).** A mark per wallet in one dictionary would grow with every
  claimant toward config 43's 65,536-cell account cap (D-188's rule), so each wallet's mark is
  its own child contract, `primes_claim_receipt.tolk`, at an address derived from (claim
  contract, wallet). A claim goes wallet → claim contract (signature and deadlines) → the
  wallet's receipt (deployed on first use; moves the mark, or refunds a replay and stops) →
  claim contract → vault; a vault refusal sends the receipt back the refused amount. The
  claim contract keeps only its two program counters, and the paid figure a player sees is
  the receipt's `getPaid()`, found by the claim contract's `getReceiptAddress(wallet)`.
- **A signature is good on one claim contract only.** Beyond the triple above, every signed
  claim and every signed burn also carries the instance's program tag (`DECISIONS.md` D-171),
  the network's global id (config param 19, read on-chain with `blockchain.configParam(19)`) and the claim
  contract's own address (audit 2026-11-19 M2). The tag keeps two instances apart even on one key;
  the network and the address together keep two deployments apart, so a key reused on a
  redeploy, or from testnet to mainnet, cannot replay a voucher against receipts that start at
  zero or end a program with an old burn. The address alone would not do it: the genesis wallet
  is v4r2, so one mnemonic deploys every instance at the same address on both networks. The
  signer is configured with each instance's address and with `TON_NETWORK`, and signs nothing
  when either is missing.

**Where a player claims (DESIGN.md G51).** `/earn`'s claims panel: one press fetches the signed
voucher for each instance with a standing balance and sends each `claim_voucher` to its own
instance in one wallet approval. The standing balance is the board's score minus `getPaid` on
the wallet's receipt for that instance, and an instance past its deadline (`isProgramClosed`) draws its balance as
stranded rather than offering a claim that would throw 710.

The vault↔program address circularity (each one's address depends on the other's) is
broken by a one-shot `set_vault`, the same shape as the vault's own `set_wallet`.

**Two instances, one code (`DECISIONS.md` D-170).** The track tag is init data, so genesis
deploys the voucher twice: `QSTS` on the attribution service's key for the quests above, and
`SECU` on a key the owner holds offline for §10 Phase 4's single security prize, allow-listed
for `remaining_vault_split.tracks.security_bounty` (1,000,000 PRIMES). Separate keys and
separate entries, so no quest payout can spend the prize and the quests signer cannot sign it.

**A third instance pays the contract-fact quests (`DECISIONS.md` D-171).** `PQST`, on its
own attribution-service key (D-171 amended 2026-11-20, audit R2-M2 — it shared the `QSTS` key
until then), allow-listed for `prime_quests` (6,350,000 PRIMES since D-204; 750,000 before), pays the referral,
recruit, prime and game tracks of §9.4. Genesis refuses any two of the three instances on one
key, so one leaked key reaches one track. **The tag is in every signed hash** too — claim and
burn alike — so a voucher or a burn signed for one instance is a bad signature on the other
even under one key. The §9.4 social board's `quests` cap and its per-player
reward (`quests / 1,000` since D-204) are untouched.

### 9.6 Memorable numbers: one score, one price, and what the vault pays back

> ## REWRITTEN — 2026-09-04 (`DECISIONS.md` D-99)
>
> **There are no rarity tiers.** The three tiers in a fixed 0.15 : 1.00 : 1.05 ratio —
> `discount`, `free`, `bonus` — their per-tier `price_max` / `price_min`, the
> `specialNumberTier` predicate that assigned them, `PRIME_P0_MIN`, and the 0..120
> four-layer `desirabilityScore` that ran beside them are all **deleted**. In their place
> is one additive score `D(n)`: every category a number belongs to carries a weight, the
> weights sum, and the sum is the price. The old model is kept at the end of this section
> as **the record of what this replaced**, because the reasoning that produced the tiers
> is the reasoning that condemns them.
>
> **The rebate stops wearing a rarity badge.** A tier used to do two jobs at once — lift a
> price and size a bounty-vault payout — under names (`discount` / `free` / `bonus`) that
> described the payout. So the rim of `/lot/5` said "free" beside a 10 GRAM lot. The two
> jobs are now two mechanisms with two populations, and neither is called a tier.

No ads for the token. The funnel is: nerd-snipe → read contract → call contract.
Memorable numbers are the conversion mechanism (`DECISIONS.md` D-43 → D-47 → D-99) — the
design goal, a contract that markets itself to people who can untangle it, is unchanged,
but the mechanism has never depended on anyone being *stumped*. There is no signer, no
proof submission, no "first correct answer wins" race. A number either matches a category
predicate or it does not, and every predicate runs on chain, from `n` alone.

**The score.**

```
D(n) = clamp( LEN(n) + max(DIGIT) + Σ LIFE + Σ FORM + CULTURE + POSITION , 0 , SCORE_MAX )
```

- **`SCORE_MAX = 87`, and the clamp IS the ceiling.** `MINT_PRICE · 2^(87/10) = 415.87 GRAM`,
  so the one clamp on the sum is the whole of the owner's 420 GRAM ceiling. There is no
  second ceiling anywhere — the same one-clamp-over-a-sum discipline `K_CEIL` gives §5.
- **DIGIT takes a `max`; every other group sums.** The six digit predicates imply one
  another — a repdigit is also a palindrome and an `abab` — so summing them would pay
  three times for one observation. Nothing else in the table implies anything else in it.
- **LEN is continuous and has no bit:** `LEN_W · (LEN_REF − digits)` while
  `digits < LEN_REF`, zero beyond. Short numbers are scarce; scarcity stops mattering at
  nine digits.
- The score and the bitmask of the categories that produced it are published by
  `getScoreBreakdown(n)`, and the weights themselves by `getScoreWeights()`, so a reader
  can recompute the sum line by line (§9.1). A UI that shows a category the chain did not
  return is a bug, not a decoration.
- **THERE ARE 54 CATEGORIES, AND A 55TH RE-PITCHES THE RING.** §9.6's orb pitches a
  satellite every `360°/54 ≈ 6.67°`, one slot per bit, and a bit's angle is fixed once
  numbers are minted (a satellite that moved would change a minted number's picture).
  D-99 spent 0..32, its factorization phase spent 33..38, `GAUNTLET.md` N6 (`DECISIONS.md` D-185) spent 39..47
  — the last of the original 48-slot ring at 7.5° — and `DECISIONS.md` D-162 appended
  48..53, re-pitching the ring once, pre-launch, when nothing minted wore an angle yet.
  `flags` travels as a uint64 (`class_flags:uint64`), so the wire format did not change;
  bit 53 is past a JS number's exact range, which is why every reader carries it as a
  bigint or a decimal string. A category proposed after this is a **tag**
  (`shared/prime_tags.json`, which scores nothing and sets no bit) or a decision to
  re-pitch the ring again, which is not a patch.

- **Seven of the first 48 are decided by the factorization, not by `n`** — bits 33..38,
  added by D-99's factorization phase: semiprime (Ω = 2, the standard definition, so `p²`
  carries both semiprime and prime power — the categories were never a partition, 3 pts),
  prime power (5), square-free (2), 7-smooth (3), and abundant / deficient (1 each); plus
  N6's bit 39, `carmichael` (30), which needs Korselt's criterion over every prime factor.
  (Ruth–Aaron was considered and skipped: it needs a neighbour's factorization.) They exist
  for the density goal — a number that belongs to no category at all should be rare — and
  they are computed from the factor list a composite **already submits** at `open_lot`, so
  they cost no new proof and no new message field. The head mint carries the same list and
  scores it too (one width, below).

- **N6's other eight are decided from `n` alone, and that is where the batch's cost
  actually landed.** `pandigital` (40 pts), `narcissistic` (30), `automorphic` (25),
  `square_triangular` (25), `kaprekar` (20), `highly_composite` (20), `keith` (20) and
  `catalan` (15). The batch is composite-first on purpose: `shared/prime_tags.json` already
  names 78 prime families, while the core loop mints **composites**, which had no taxonomy
  of their own. Because the ledger's mint leg scores every head mint (`scoreOfFrom`, below),
  all eight run on **every head mint** — which is what §4.1's gas & ops line (0.20 GRAM since
  `DECISIONS.md` D-117, 0.10 when they were admitted) pays for, and the measurement that admitted them is recorded in `DECISIONS.md` `## N6`.
  `square_triangular` is free: both of its predicates already ran.

- **D-162's six (bits 48..53), from numbersaplenty.com's families, chosen for being cheap
  on chain.** Four are decided by the factorization and join bits 33..39 in every respect:
  `smith` (48, 3 pts — digit sum equals the prime factors' digit sums with multiplicity),
  `sphenic` (49, 2 — three distinct primes, each once), `powerful` (50, 4 — every exponent
  ≥ 2) and `achilles` (51, 6 — powerful and not a perfect power, i.e. exponent gcd 1). Two
  are decided from `n` and run on every head mint: `lucas` (52, 15) and `pronic` (53, 3 —
  `k(k+1)`). Neither adds a square root to the mint path: `pronic` reads the same `⌊√n⌋`
  the SQUARE test already takes, and Fibonacci and Lucas are now decided together from one
  `isqrt(5n²)` and three squarings, where Fibonacci alone used to take two roots.

  **`getLotPrice(n)` and `getScoreBreakdown(n)` therefore answer a LOWER BOUND, and that is
  a published fact rather than an approximation.** They return bits 33..39 and 48..51 clear because
  `n` alone cannot decide them. `getLotPriceFrom(n, factors)` and
  `getScoreBreakdownFrom(n, factors)` take the same factor list the caller is about to send
  and return the score `open_lot` will actually charge — an empty list reproduces the
  from-`n` answer exactly, so the pair can never drift into two definitions of the price.
  A surface quoting a composite the buyer is about to open **must** quote the factored one;
  the unfactored quote is for a reader who does not have the factorization yet. (No
  surface does yet: the read-proxy, the agent SDK and `/lot/:n`'s open flow all quote
  `getLotPrice(n)` — `GAUNTLET.md` F65.) They are two
  methods and not one optional argument because a TVM get-method has no optional arguments,
  and widening `getLotPrice` would have broken every existing caller to buy nothing.

  Abundant and deficient partition every non-perfect number, so the pair is a near-constant
  +1 on any composite priced with its factors rather than a discriminator. That is the
  density filler doing exactly what it was asked to do, and it is stated here because a
  reader comparing a factored quote against an unfactored one will see the point. Perfect
  numbers earn neither and keep the 40 the `perfect` bit already pays them.

  **`D(n)` means one thing: the factored score.** An auction is **priced** on
  `scoreOfFrom` (all 54 categories), and a head mint is **rebated** on the same
  `scoreOfFrom(n, factors)` over the factor list the mint already submits and the ledger has
  already verified (§9.6's payback below, `DECISIONS.md` D-99, D-180). A prime passes an
  empty list, where the two methods agree exactly. Until 2026-09-24 the rebate read the
  from-`n` score (43 categories): the factored walk cost ~842 gas when §4.1's gas & ops line
  was a FIXED 0.10 GRAM with ~529 left, so C14 (2026-09-07) signed two widths. D-117 made the
  line 0.20 GRAM, derived from the heaviest measured mint, and `GAUNTLET.md` C15 closed the
  split: the owner adopted the factored rebate (D-180), and the worst mint rose from 0.184 to
  0.186 GRAM (0.192 since, chiefly from D-191's minter cards). `getLotPrice(n)` and `getScoreBreakdown(n)` stay what they were — the documented
  lower bound for a reader without the factorization.

  **Said plainly, because the next reader will want to add something here: §4.1's gas & ops
  line has almost no headroom.** Since `DECISIONS.md` D-117 it is 0.20 GRAM, sized to the
  heaviest measured mint (0.192 GRAM, ω = 12, since D-180's factored rebate and D-191's minter
  cards), which leaves **0.008 GRAM** at the worst row.
  Under the old fixed 0.10 line it stood at 99.79 of 100 after D-101's invite fan-out and at
  **98.17 of 100** from 2026-09-19, when the rebate mint began carrying a TEP-74
  `transfer_notification` (without one no wallet shows the rebate at all) and the hop that
  carries it was shaved 0.02 -> 0.018 GRAM to pay for it — the master was retaining ~0.0183
  of that 0.02 per mint, on a contract nothing sweeps. Any new feature that wants gas on the
  mint path will find none, and must either buy it from a line that already has an
  owner-signed figure, find a leg that is over-funded the way that one was, or not ride the
  mint path at all. That is a budget statement, not a temporary condition to be waited out.

**The price.** One ladder, `ladder(D) = MINT_PRICE · 2^(D / SCORE_HALVING)` with
`SCORE_HALVING = 10` — ten points doubles the price — evaluated in exact integer
arithmetic off the ten-entry `FRAC` table `getFracTable()` publishes.

```
composite:  open = max( LOT_FLOOR , ladder(D) )
            rest = none — the head mints it at 1 GRAM (§4.4)
prime:      open = max( LOT_FLOOR , ladder(D) , 1.5 · NPV(n) )
            rest = max( MINT_PRICE , open / 3 , 0.5 · NPV(n) )
```

`LOT_FLOOR = MINT_PRICE + RES_GAS` = 1.07 GRAM is the absolute floor on either lane (`DECISIONS.md` D-113). The
`NPV` term survives the rewrite for the reason D-89 gave: it is **yield, not vanity** —
what the prime is modelled to earn in tribute over the life of the game
(`docs/math-note.md`). It binds only on the 555 primes up to 6,577
(`shared/params.json` `trophy_auction.npv_ladder.npv_branch_binding_prime_count` /
`npv_branch_last_binding_prime`), which is the owner's "majority" carve-out and the only
way past the 420 GRAM ceiling: 2, 3, 5 and 7 open above it (prime 2 at ≈ 1,345 GRAM), and
only 2 also rests above it (≈ 448 GRAM).
`open / 3` carries D-88 point 1's 3× open-to-rest spread to every prime the finite table
misses, so a 300-point prime does not rest at 1 GRAM.

**A composite the head reaches mints at 1 GRAM, whatever it is worth.** The head-advance
walk's special-composite skip is **deleted** — it was also a live bug, and `MISTAKES.md`
2026-09-04 records why: D-88 point 2 deleted the lane the skip fed, so the **125 composites**
matching the old `isCuratedNumber` predicate — drawn from the calendar years 1918–2030 and
the twelve constant truncations — were being marked off the sequential line permanently,
with no route left to buy them at all. **Memorability is priced
only ahead of the head.** "You should have bid" is the intended answer, and it is the same
answer §1 point 7 gives for every other composite.

**The weight table.** Reproduced from `shared/opcodes.ts` `SCORE_BITS` and `SCORE_TERMS`,
which is what the contract's `getScoreWeights()` is asserted against by
`SimCrossCheck.spec.ts`. A **bit number is a permanent identifier** — it keys the `flags`
word, the weight table's stack position, and the orb's fixed satellite angle
(`(360°/54) · bit`) — so a bit is never renumbered, only appended; D-162 appended 48..53 and
re-pitched the ring from 48 slots to 54. The table below lists bits 0..32; 33..53 are
described in the bullets above.

| Group | Bit | Category | Points |
|---|---:|---|---:|
| LEN | — | per digit under `LEN_REF` = 9 | `LEN_W` = 2 / digit |
| DIGIT (max) | 0 | repdigit | 40 |
| | 1 | power of ten | 40 |
| | 2 | palindrome | 25 |
| | 3 | ascending / descending run | 25 |
| | 4 | `abab` / `aabb` | 12 |
| | 5 | trailing zeros | 8 / zero, `TZ_CAP` = 3 |
| LIFE (sum) | 6 | valid `YYYYMMDD` | 30 |
| | 7 | valid `DDMMYYYY` / `MMDDYYYY` | 25 |
| | 8 | year in `[1900, 2100]` | 25 |
| | 9 | valid `YYMMDD` | 12 |
| | 10 | valid `MMDD` / `DDMM` | 5 |
| FORM (sum) | 11 | Mersenne prime | 40 |
| | 12 | Fermat prime | 40 |
| | 13 | perfect number | 40 |
| | 14 | primorial | 30 |
| | 15 | factorial | 25 |
| | 16 | prime | 15 |
| | 17 | power of two | 15 |
| | 18 | Fibonacci | 15 |
| | 19 | cube | 8 |
| | 20 | twin prime | 6 |
| | 21 | Sophie Germain prime | 6 |
| | 22 | safe prime | 6 |
| | 23 | emirp | 5 |
| | 24 | square | 4 |
| | 25 | triangular | 2 |
| | 26 | Harshad | 2 |
| | 27 | happy number | 2 |
| | 28 | prime digit sum | 2 |
| CULTURE | 29 | iconic | 30 |
| | 30 | listed | 20 |
| POSITION | 31 | landmark prime | 30 |
| | 32 | constant truncation / taxicab | 20 |

**Life dates are real calendar dates.** Month 1–12, day within the month, the Gregorian
4/100/400 leap rule, years in `[1900, 2100]` in every form. At most one 8-digit form can
match an `n` — a `YYYYMMDD` in range read as `DDMMYYYY`/`MMDDYYYY` has a month of 19, 20 or
21 — so the group sums without double-counting, and its only internal stack is a 4-digit
year that is also a valid `MMDD`/`DDMM` (`1207`: 30 points). An integer has no leading
zero, so `09091972` is not a number this game sells; the contract asks `DDMMYYYY`/`MMDDYYYY`
only for a leading pair ≥ 10, which eight digits guarantee, so `25011999` counts (D-99's text
says day **and** month ≥ 10 — unreconciled drift, see D-99's retirement note). `YYMMDD` carries no century and is
validated against 2000, so a 29 February counts. A prime date stacks its FORM bits on top — the
mathematician's-birthday premium is intended. D-99 also specifies a **date finder** on
`/acquire` (a native `<input type="date">` listing every `n` that represents the picked date,
with its live price and owner, and naming the forms a leading zero makes unrepresentable) —
built in `/auction`'s lookup sheet (`/acquire` redirects there) as `DateFinder`, its forms read
back off `shared/score.ts`'s LIFE predicates by `webapp/src/math/dateForms.ts` (`GAUNTLET.md` F66).

**Which of these numbers are owner-declared and which are sim-derived.** §2 and CLAUDE.md
rule 3 make this the load-bearing distinction, so it is stated per line rather than left
to be inferred:

- **Owner-declared (`DECISIONS.md` D-99):** every weight in the table above, `LEN_REF`,
  `LEN_W`, `TZ_CAP`, `SCORE_MAX = 87`, the year window `[1900, 2100]`, and the membership of
  both curated lists below. They are a **guess at demand**, which is what a price is here,
  and a guess at demand is exactly the kind of number the sim cannot produce. They live in
  `shared/opcodes.ts` (`SCORE_BITS` / `SCORE_TERMS`) and in
  `contracts/contracts/score_block.tolk.inc`, which is the authority (one canonical block,
  copied byte-for-byte into the market, the ledger and the registrar by
  `node tools/sync-score-block.mjs`; `SpecialNumbers.spec.ts` asserts the deployed copies
  and the `shared/score.ts` mirror answer identically over a sweep of `n`). They are carried
  into `shared/params.json`'s top-level `score` block under
  `_provenance: "owner-declared (D-99)"`, parsed out of `SCORE_BITS` / `SCORE_TERMS` at
  generation time so the sim cannot hold a different table — the same standing D-96's two
  constants have. That block also publishes the worked examples (`score.worked_examples`:
  `n`, score, categories, per-term points, whether the clamp bound), which is where a
  reader checks a price by hand.
- **Sim-derived:** `NPV(p)` (`trophy_auction.npv_ladder`, unchanged by D-99),
  `SCORE_HALVING = 10` and the `FRAC` table (`trophy_auction`), the bid-increment ladder
  (`acquisition.bid_increment_ladder`), the score's distribution over the horizon
  (`score.histogram`), and the rebate rates below (`genesis.score_rebate`).

**The two curated lists.** Both are contract constants — `isIconicNumber`,
`isListedNumber`, `isLandmarkPrime`, `isCuratedConstantOrTaxicab` in
`score_block.tolk.inc` — fixed at genesis, and neither is sim output.

- **Iconic (bit 29, 30 points), owner-signed:** 2 (the only even prime), 42, 69, 420, 666,
  777, 1337, 1729, 8008.
- **Listed (bit 30, 20 points), owner-signed:** 7, 13, 23, 47, 88, 99, 101, 108, 404, 418,
  451, 495, 911, 1234, 1984, 2001, 2049, 4096, 6174, 8086, 9000, 9001, 24601, 31337, 65536,
  80085, 90210, 142857, 5318008, 8675309. The rule for a future addition: a reader who is
  not a mathematician recognises it **without** explanation. Anything needing a footnote is
  not culture.
- **Constant truncations and the taxicab (bit 32, 20 points):** π (3141, 31415, 314159), e
  (2718, 27182, 271828), φ (1618, 16180, 161803), √2 (1414, 14142, 141421) and 1729 —
  13 entries, the one surviving half of the old curated list. Its other half, every calendar
  year 1918–2030, is **deleted**: the LIFE group prices years now, and prices them properly.
- **Landmark primes (bit 31, 30 points):** 43 entries, **sieved not estimated**, generated by
  `sim/scripts/landmark_primes.py` into `shared/landmark_primes.json` and from there into
  the score block — the largest prime below and the smallest prime above each `10^k`
  for `k = 1..14`, the `10^m`-th prime for `m = 1..8`, and the largest prime below each of
  the eight primorial era boundaries. Each entry carries how it was established (`scan`,
  `sieve`, or `primality`), the same provenance discipline as `owed_dict_ceiling_resolution`.

**The rebate: money, not rarity.** Two populations draw the bounty vault's `puzzles`-track
bonus and nothing else does. **This is not the ratchet's rebate.** Every head mint of a
composite already emits PRIMES worth `k(t)` times the injected residual (§4, §5); that
emission is the ratchet's, it is bounded by `K_CEIL`, and D-99 does not touch it. What
follows is the other one — a one-time vault payout to the first owner, sized the same
`min(reward_ton · S/T, max_primes)` claim-time-clamped way the quest and era-bounty tracks
already are (D-42/D-43).

- **A composite minted AT THE HEAD**, the 1 GRAM path — `REBATE_PER_POINT · D(n)`, per point
  of the factored score (`scoreOfFrom`, the same `D(n)` the auction prices on — D-180). **An auction-won composite gets nothing**:
  the premium is the price of impatience.
- **A prime of the rebate family**, by whatever route it minted — flat, and `D(n)` is
  ignored. The family is D-96's `dirichlet_primes` exactly as signed: `p > 100,000` and
  `p ≡ 1 (mod 101)`, which Dirichlet's theorem makes **1 in 100 primes at every depth**, so
  it is never exhausted and keeps paying along the whole line. **D-99 narrows D-96 without
  withdrawing it:** the family keeps its ceiling (≤ 1 in 1,000 integers, owner-declared) and
  its two constants, and loses its rarity meaning entirely — it **scores no points, sets no
  bit, lifts no price and wears no badge**. It selects a rebate and nothing else.

`primes_bounty_vault.tolk`'s schedule has exactly **two** entries,
`REBATE_COMPOSITE_PER_POINT` and `REBATE_PRIME_FAMILY` (`shared/opcodes.ts` `REBATE_KIND`),
keyed by `n` in `paidSpecials` so a retried send after a bounced transfer cannot double-pay.
The words `discount`, `free` and `bonus` appear nowhere in contracts, params, copy or tests.

**The owner signs targets; the sim sizes the rates.** The signed targets are 0.005 GRAM per
point (D-99 answer 16) and a flat 0.132 GRAM for the family
(`genesis.score_rebate.signed_targets_ton`). `sim/scripts/run_phase1.py`
`score_rebate_report` projects both over the `n ≤ 10⁶` horizon — every head-minted
composite, exhaustively scored, and the family drawn on the auction path too — and applies
ONE scale to the pair, ratio preserved, so the projection lands at 50% of the `puzzles`
track; it never inflates a signed figure, only clamps it. At the targets the projection
overran the budget roughly thirteenfold, so the shipped rates are the clamped ones in
`genesis.score_rebate.rates` (`composite_per_point`, `prime_family`: `reward_ton` and the
genesis-floor `max_primes` cap), which `contracts/scripts/deployGenesis.ts` writes into the
vault's two-entry schedule. Quote those, never the targets.

**Where the rebate is shown.** `SpecialRebate`, under the orb on `/lot/:n` and `/number/:n`,
is the one surface: for a composite, "+X PRIMES back at the head" from the per-point rate
and the live floor; for a rebate-family prime, the flat figure; for everything else it
renders nothing. It is green, because green earns, and it is **never a satellite** — the
orb draws rarity, this draws money.

**The orb draws the categories.** One satellite disc per set bit on the full orb's
circumference, at a **permanent angle** `(360°/54) · bit` clockwise from 12 o'clock over 54
slots (48 at 7.5° until `DECISIONS.md` D-162), radius `3 + points / 4` in the orb's 100-unit box, so the same angle means
the same category on every number forever and a heavier category is a bigger disc. Groups
are colour tokens in `webapp/src/styles/tokens.css` — DIGIT silver, LIFE peach, FORM violet,
CULTURE magenta, POSITION indigo — and the four semantic hues (cyan prime, amber composite,
green earns, red spends) are not reused. **Primality is not a satellite**; the prime/composite
class badge already carries it, unchanged. `RarityMarks` and `SpecialNumberBadge` are
deleted. Satellites render from `getLotPrice(n).flags`, never from the client-side mirror in
`shared/score.ts` — a mirror that has drifted must show as a disagreement, never as a picture
(§9.1).

**Every disc says which category it is, on every surface.** One hand-drawn mark per
category — all 54, no exceptions — from `shared/art/satelliteGlyphs.ts`, the single table
the webapp orb, the NFT and the `.tgs` sticker all read, so the page and the owned item wear
the same marks. Angle, radius and hue are untouched by it: the mark adds no channel, it only
stops the disc being nameless. The mark, the disc's rim and its glow are drawn at **one line
weight, `0.14 · r`**, derived from the mark's own design box so the two cannot drift apart —
a category is never hairline SVG laid over a much heavier ring. Marks are point lists and
circles, never SVG path strings, because `sh`/`el` are the only shapes rlottie draws.
`ScoreTerms`' rows print each mark beside its category's name and are the legend. **The
number and its categories arrive as one event**: an orb told to expect `flags` holds the
artwork until they land, with a ceiling for a read that has failed rather than one that is
slow — the page still owes the reader the number (§9.1). See `DECISIONS.md` D-99 and its
2026-09-14 addendum.

**Each group moves in its own language: sparks, smoke, glimmer — never rotation.** DIGIT
glimmers (a highlight sweep, four-point stars scaling 0→1→0), LIFE rises in embers, FORM
flashes cold sparks, CULTURE drifts smoke and flickers like neon, POSITION pulses a beacon's
expanding rings. Position, scale and opacity only, every loop ≤ 3 s; within a group each
category's particle count, phases and angles are seeded from its bit (`variantFor(bit)`), so
every category is visibly its own and deterministic. Two renderings read that one variant:
- **The NFT and the sticker.** `shared/art/satellites/gen.mjs` emits one Lottie
  (`<bit>.json`) and one `.tgs` per bit — 512×512, 60 fps, under Telegram's sticker limits
  (no expressions, images, mattes or 3D layers, < 64 kB, no rotation keyframe, one file per
  `SCORE_BITS` entry — `backend/read-proxy/test/satellites.test.ts`; `--check` fails CI if the checked-in files are not a function of the
  source). The read-proxy composites a number's satellites at their angles into
  `/nft/<n>.lottie.json` and `/nft/<n>.tgs` (`server.ts` `withSatellites`), so the item on
  getgems and the sticker in Telegram carry the same categories as the orb. The still
  `.png` does not draw them.
- **The webapp.** A `NumberOrb` alone on its page or popup (`solo`) draws the language as
  SVG + CSS keyframes (`SatelliteFx.tsx`) with a breathing glow — no Lottie player; a
  non-solo orb draws the still disc and its mark, and a board's `LotOrb` draws no satellites
  at all. Under `prefers-reduced-motion` neither plays and
  the rest disc — angle, size, hue, mark — carries the whole value (frontend rule 7).

**No change to `K_CEIL`, `k_max(n)`, `PRIME_UPLIFT`, the ratchet, or `T`/`S` accounting.**
The vault payout is a payout like era bounties and quests already are, and the acquisition
price — however the score shapes it — still flows through §4.1's ordinary five-way split
exactly like any other mint.

---

**The record of what this replaced.** Kept because the failure is the argument for the
current design, and because D-47, D-64, D-68, D-88 and D-89 all cite it.

Every price was a `max()` over four curves that never added: the 0..120 `desirabilityScore`
(digit patterns, digit count and a bare-year check, in which **primality weighed 0**), the
tribute-NPV term, a flat lift per rarity tier (6 / 10 / 15 GRAM to open, 1.32 / 1.06 / 6.29
GRAM to rest), and `PRIME_P0_MIN` = 5 GRAM. Whichever curve was loudest won and the others
vanished, so a number rare in two ways was priced as if rare in one. Measured on the
2026-09-01 genesis: the composite `1111` opened at 181 GRAM, twelve times `8191` — the fifth
Mersenne prime ever — which opened at the same 15 GRAM as `131071`, because a tier was a flat
population price; `2024` and the prime `2027` both opened at 32 GRAM, because primality scored
nothing; `42`, `420` and `1337` opened at the 1.06 GRAM floor, because culture did not exist;
`999983`, the largest six-digit prime, rested at 1 GRAM; and a birthday like `19720909` was an
ordinary number. The `free` tier, meant as a rarity, covered 1 in 6 integers below 100.

Five categories were "special" — Mersenne primes (bonus), twin / Sophie Germain / safe primes
(free), palindromic and repunit primes (discount), D-96's deep-line primes (free), and a
curated list of dates, years and constants (assigned per entry) — for a worst case of 20,974
numbers to the `n ≤ 10⁶` horizon. **Every one of those categories survives as a scored bit**;
what does not survive is the population-flat price a tier gave them. The sim output that sized
the tiers is superseded by the two rates above and is gone from `shared/params.json`. (The
figures this section used to quote — discount 0.0198, free 0.1320, bonus 0.1386 GRAM — had
already drifted from what the deleted `special_numbers.tier_value_ton` held, 0.0036 /
0.0242 / 0.0254; the drift is recorded rather than reconciled, because both numbers
now describe a deleted mechanism.)

The lanes went first and the prices second. **D-88 point 2** deleted the two special-only
lanes — a 3-day descending window for a special prime, and a 1-day descending route for a
curated composite the head had already passed, with `open_head_lot_composite`,
`MODE_DUTCH_BUYNOW_SPECIAL`, `MODE_DUTCH_BUYNOW_SPECIAL_COMPOSITE`, `settle_special_composite`
and D-64's vault purchase and re-listing — on the reasoning that **specialness is price, not
mechanism**. That sentence survives D-99 verbatim in spirit; what changed is that the price is
now one sum instead of a tier's flat figure. **D-89** deleted D-68's crown overlay
(`max(tier price, 5000 GRAM / n)` opening, `max(tier price, 500 GRAM / n)` parking) for being a
second pricing mechanism that competed with NPV and won below `n ≈ 834`, making D-88's
promised 3× spread measure 3.26×–5.86× in practice. D-99 finishes the same job on the tier
itself: there is now **one expression, and every axis is a term in it**.

### 9.7 Seed audience

A referral tree grows from a seed, not from zero — the honest lesson of every
Telegram-native scheme that actually got users. Named channels, in priority order: TON
dev chats and the Tolk/Tact/FunC communities (they can audit, which is the pitch), TON
Research forum, CTF and smart-contract-security circles (the testnet bug bounty is native
content for them), Project Euler / competitive-math communities (the game is
literally their hobby with cash flows), and TON ecosystem newsletters. Optional paid
line: a small Telegram Ads budget pointed at the *game* landing (never the token), decided
after the testnet bounty round (§10, Phase 4) shows conversion numbers. Zero paid
promotion of the token itself, ever.

### 9.7b Demand-side audience: the collectors (D-65)

§9.7 names the **seed** — the root of the referral tree. This section names the **buyers**,
and the two are deliberately different populations doing different jobs, because conflating
them is the failure this section exists to prevent.

**Why they are not the same list.** §4.1's referral line (`rN`) pays only on a mint the
payer made themselves, and §4.6's recruit ladder is earned only by paying for a mint
somebody else receives: the entire apparatus monetizes *chains*. A seed audience is
therefore chosen for its propensity to recruit, which is what §9.7's dev chats, TON
Research, CTF circles and Project Euler communities have — they are dense, they talk, and
crucially **they audit for free**, which is the pitch. What they conspicuously are not is
big spenders. A collector who paid five figures on Fragment for a repeating-digit anonymous
number is the mirror image: a terminal node who buys once and does not recruit, and whose
spend is worth more than a hundred recruits' mints. **Retargeting §9.7 at collectors would
have removed the referral tree's root while keeping the machinery that only pays out when a
root exists.** So this is an additional section, not a replacement, and §9.7 stands
unchanged.

**Who they are, and why the fit is real rather than aspirational.** The Fragment /
TON-anonymous-numbers / Telegram-username market has already established, with realized
prices, that this audience: (a) holds GRAM and transacts natively in it, so there is no
bridge and no onboarding cliff; (b) understands a 7-day ascending auction with anti-snipe
extension, because that is Fragment's own mechanism (§4.4 point 1b already matches it —
`DECISIONS.md` D-11 chose that shape because it is what GRAM bidders expect); (c) already
pays a premium for **digit patterns on an otherwise arbitrary integer**, which is one of the
six things `D(n)` measures (§9.6; under D-99 the score also prices life dates, mathematical
form, culture and position on the line, not digit patterns alone); and (d) already treats the number as an
identity object, which is what §9.9's Telegram surfaces make visible. The overlap with what
this project already built is not a coincidence — §4.4's auction was designed against
Fragment comps in the first place.

**What they buy here, stated honestly, including the part that is worse for them.** The
point 1b's ascending lot ahead of the head — on any number, at an opening price §9.6's score
lifts — is the Fragment-shaped product. The honest disclosure a collector is owed, and which must
appear on the surface that sells to them, is that **an ordinary number has a 1 GRAM route**
(§4.4, §12) — waiting is a complete strategy and it caps what any lot can fetch. What they
are buying above 1 GRAM is priority and certainty, not scarcity, **except** for a **prime**,
whose lane parks at `max(MINT_PRICE, P0(p) / 3, NPV(p) / 2)` and where the 1 GRAM
alternative genuinely does not exist. **For a composite there is no exception left at all**
— D-99 deleted the last special-composite skip, so every composite the head reaches mints
at 1 GRAM however it scores (§9.6). ~~D-64/D-47's parked price for a special composite~~ is
gone with the lane that carried it. A surface that blurs those two cases is mis-selling, and §2's "the audience is the
auditor" applies with more force here, not less, because the sums are larger.

**What this does not change.** Not the split, not the ratchet, not `K_CEIL`, not the seed
audience, not "zero paid promotion of the token itself, ever" (§9.7), and not §8.1's
prohibition on memecoin framing. The auditor-grade honesty of §9.1 is **load-bearing for
this audience specifically** — a six-figure bidder's diligence is the get-method surface,
so the honesty rule is the sales mechanism rather than a constraint on it.

**The two consequences that are not free**, both filed rather than waved at:

1. **If auditors are no longer the only audience, they are still the only auditors.** The
   free security review before mainnet is a service §9.7's population renders, and it is
   not fungible with buying volume. Nothing here reduces the obligation to keep that
   audience courted on its own terms (GAUNTLET.md N5).
2. **Whale-facing markets fail differently from sybil-facing ones.** §8's anti-abuse is
   built against many small fake actors; a comp-driven market's characteristic abuse is one
   large real actor **wash-trading a lot to print a public clearing price**, then selling
   the neighbouring number against that comp. Anti-snipe extension does not touch it, and
   §8 does not stop the bid itself — it is real, on-chain, and only the intent differs, so
   the answer is disclosure rather than detection (GAUNTLET.md N4). Every surface that shows
   a closed lot's winning bid — the public `/lot/:n` page and a wallet's own claim list —
   shows the bid count and the distinct-bidder count beside it, sourced from
   `backend/event-poller`'s per-bid history (the contract's own `getLot(n)` carries no bid
   history at all, only the current standing bid). A single self-bidding wallet can still
   print a number, but it cannot hide that only one wallet produced it.

### 9.8 The artwork: generated, animated, and derived from the number

Every minted integer is an NFT, and an NFT with no picture renders as a blank tile
however correct its on-chain data is. The artwork is therefore part of the product
surface, not decoration bolted on afterwards — and, like everything else here, it is
constrained by what a reader can check.

**What the standard actually gives us.** TEP-64 defines exactly five item fields —
`uri`, `name`, `description`, `image`, `image_data` — and nothing for motion; its own
text still lists "shall we standardize attributes, traits, and non-image content" as an
open question. Animated items on TON run on the de-facto Getgems extension: `lottie` for
a vector animation document, `content_url` + `content_type` for video (mp4/webm/mpeg,
100 MB ceiling), plus `attributes` and `buttons`. This project already depended on
`attributes`, so the extension is not a new commitment. The rule it imposes is: **`image`
must stand alone.** A wallet that knows only TEP-64 sees the PNG and nothing else, so the
still is a finished picture rather than a poster frame.

**Three tiers, each degrading into the one below.**

| Tier | Field | Content | Applies to |
|---|---|---|---|
| 1 | `image` | 512×512 PNG, frame 0 of the animation | every number |
| 2 | `lottie` | vector animation, JSON, tens of KB | every number |
| 2b | `content_url` (`image/gif`) | 256×256 animated GIF, 24 frames, ~200 KB | served for every number, **advertised for composites** (D-174) |
| 2c | `tgs` | the same Lottie, gzipped to Telegram's sticker profile, single-digit KB | every number |
| 3 | `content_url` (`video/mp4`) | mp4, rendered on demand and cached | **primes only** |

Tier 2 is Lottie rather than video for an operational reason that is also an economic
one: Lottie is JSON, so emitting it is string work on the same small host that already
hand-rolls a PNG encoder — no headless browser, no ffmpeg, no render queue — across a
collection with one item per integer. Tier 3 is restricted to primes because primes are
the tribute-bearing asset (§3.2), the thing bought for the claim rather than for the tile;
roughly one integer in ten is prime, which is the only thing that makes a frame-by-frame
encode tractable at all. **The asymmetry in the artwork budget is the same asymmetry the
economics already assert.** Tier 3 is also optional: a host without ffmpeg serves tiers 1
and 2 and stops advertising a prime's `content_url`, rather than publishing a URL that 404s.

**Tier 2b, the GIF, exists because tier 2 is an extension almost nothing plays.** Lottie is
the right format for a marketplace that supports it, and Getgems does. A Telegram forward, a
social card, a Discord embed, a wallet that knows only TEP-64, a screenshot in a thread — none
of them do; they render exactly two things, a still and a GIF. So the animation is offered
twice, from the same scene sampled around the same loop, and `/nft/<n>.gif` is served for
**every** number. It is not the video tier by another name: the encoder is hand-rolled in the
same spirit as the PNG encoder — median-cut quantisation, one global palette, LZW, no native
dependency, ~300 ms and ~200 KB per number — so the compute argument that restricts tier 3 to
primes simply does not apply to it. **A composite's metadata advertises it** (D-174, closing
Q29): `content_url` = `/nft/<n>.gif`, `content_type: image/gif` — the same slot a prime's mp4
occupies, so each number names exactly one primary medium. A prime keeps its mp4 there, and
its GIF stays route-only. The composite's GIF is not gated the way tier 3 is: the encoder has
no native dependency, so every host that serves the document serves the URL it names.

**Tier 2c, the `.tgs` sticker, exists because this game is played inside Telegram.** A `.tgs`
file is not a new format and not a new picture — it is the *same* Lottie document, gzipped,
under Telegram's constraints: 512×512, 30 or 60 fps, a loop of at most three seconds, shape
layers only, 64 KB compressed. It is a profile of the tier-2 renderer rather than a fifth
renderer, and that is load-bearing: the Mini App, the bot and every forward of a mint live on
the one surface that cannot play a Lottie or an mp4 but *can* play a sticker, and a sticker
that had been authored separately would be a different picture of the number from the one on
the item page.

One constraint costs something and is stated rather than hidden. Scenes loop between 1.8 s and
14 s; a scene longer than three seconds is **time-compressed** into the window, not truncated,
because truncating would leave every body mid-arc at the loop point and a sticker that jumps
every loop is worse than one that runs hot. Compression alone, though, is not enough: the
choreography is defined *per loop*, so three revolutions still meant three revolutions in
whatever window they were given, and a 14 s piece replayed at 4.7× made the slowest and most
expensive-looking numbers in the collection the ones that played hottest in Telegram — the
rarity ladder upside down, in the one surface people share. A compressed scene therefore also
has its revolutions **clamped to one per loop** (120°/s, and the loop still closes because a
whole number of revolutions is all closure ever required); direction is preserved, so a
counter-rotating body still counter-rotates. Scenes already inside the window keep their own
tempo, so the fast/slow contrast between them survives even though the long tail flattens. The rules are
enforced in code (`tgsViolations`), not asserted in a comment: the renderer is shared, and a
change made for the web tier would otherwise produce a sticker that renders blank in Telegram —
the failure nobody notices until an item is already minted.

**Every artwork URL a document emits carries `?v=<ART_VERSION>`.** The artwork routes are
served `immutable` — the drawing for a given id is meant to be frozen — so a deliberate
repaint under an unchanged URL is invisible forever to an indexer's image cache. The
documents themselves are `max-age=3600`, so the version belongs in the URL they publish
rather than in the picture, and a bump of `ART_VERSION` (`shared/art/traits.ts`) re-keys
every cached render within the hour. *(The generators' tab and the constellations' plate,
the other two artwork lines, were deleted with their collections by `DECISIONS.md` D-202.)*

**The seed is `n`, and that is a constraint, not a shortcut.** `/nft/<n>.json` makes zero
chain reads — the property that makes an unbounded-cardinality route affordable against the
rate-limit budget — so the artwork cannot depend on anything the proxy would have to look
up, including a seed stored on the item. It does not need to: numbers mint **exactly once
and strictly in sequence** (§4), so `n` is already one-to-one with mints. Seeding from `n`
gives every mint a unique piece and keeps the document immutable and cacheable forever.

**The one thing that is not derivable from `n` is when the number was minted — so the picture
is two layers.** A tile that says nothing about *when* is a worse asset than one that does: a
buyer looking at a listing wants era, class, rarity and date without opening the metadata. But
a mint date does not exist before the mint, so the artwork splits along the line the facts
themselves split along:

- The **base layer** — the number, the palette, the bodies, the lattice, the era ground, the
  brand mark — is still a pure function of `n`. Because it is, it can be rendered *ahead of
  demand*, and the trigger is a **reservation** (§4.4): the moment somebody pays to reserve a
  number, a listing for it may need a picture, and the set of reserved numbers is bounded by
  who actually reserved rather than by the number line.
- The **overlay strip** — mint date, era and position-within-era, class-and-rarity badge, and
  the printed factorisation — is composited once the mint settles.

Either way the outcome is **rendered once, served from cache after**. A number minted with no
prior reservation, which is the common case since reservation is optional, renders both layers
together on the first request for it.

**The mint date is on chain, and that is the point.** `ItemMutable` carries `minted_day`, a
`uint24` of days since the Unix epoch, written once by the item's `Populate` handler and
published by `getMintedDay()`. §9.1's rule is that every number the UI shows maps to a public
get-method, and the date is a number the UI shows — putting it only in the indexer would make
it the single figure on the tile a reader could not check. Days rather than a Unix timestamp
because the image only ever renders a date and the item's storage cell is the one already
split to stay under TVM's 1023-bit budget; 24 bits buys ~45,000 years for a third of what a
timestamp would cost. The consequence for the proxy is bounded and stated plainly: the
**metadata** document still makes zero chain reads, and the **raster** routes make exactly one
per number — cached for a year, because a value written once can never change.

**Era themes the ground; rarity themes everything else.** §7's era index sets the tile's base
tone through the same `208 + era·47` rotation `tokens.css` uses for the app shell, so a holder
browsing during an era sees their tile agree with the screen around it — one definition,
consumed everywhere. It is deliberately a *different axis* from the rarity palette, which keeps
driving ink, accents and the radial wash: collapse the two and an old-era common number becomes
visually indistinguishable from a genuinely rare one, which is the opposite of what a trader
needs. The project's diamond mark sits small and semi-transparent in the corner of every tile,
subordinate to the number by the same rule that governs the contrast guard.

**Half the entropy is the number itself.** Body count is ω(n), rotational symmetry order
comes from the exponents, hue anchors come from the factors' residues, and the
rarity-gated palettes unlock on the published `rarity_bits` from `shared/prime_tags.csv`.
Two consequences: numbers sharing a factor visibly rhyme, so the output reads as one
collection; and every visual trait is *explainable* in `attributes` and countable against
the factorization printed in the same document. Primes and composites draw from disjoint
archetype families, and prime bodies hold station and breathe rather than orbiting —
§5.1's "a prime emits nothing" stated in geometry.

**The bodies carry a verb, and the factorisation picks it.** Until `ART_VERSION` 10 every
composite did one thing — its bodies went round the number — and every prime did one thing —
its facets pulsed together — so nine neighbouring integers showed two movements, prime and
composite, and nothing else. The verb is now the `Motion` attribute, and it is read off the
number rather than rolled:

| Number | Example | `Motion` | What the bodies do |
|---|---|---|---|
| `p^k` | 32 = 2⁵ | Convoy | one body, `k` times: identical cars in a train on one orbit (at most five) |
| a cube or higher in it | 24 = 2³·3 | Rewind | every body winds half a turn each way — a full turn end to end — and comes back |
| a square in it, nothing higher | 12 = 2²·3 | Pendulum | every body swings a quarter-turn either side |
| `p·q` | 35 = 5·7 | Duet | the two factors share one orbit, at opposite ends of it |
| `p·q·r` | 30 = 2·3·5 | Rose | the bodies trace a flower: three petals when 3 divides the number, five when it does not |
| four or more primes, once each | 210 = 2·3·5·7 | Polygon | the bodies run the edges of a polygon with one side per prime (at most seven) |
| nothing to read: 1, and a number too large to factor | 1 | Circle | the bodies go round, as all of them once did |
| prime, by `p mod 30` | 7, 11, 13, 31 | Chase / Alternate / Pairs / Unison | the order the held facets light in — one after another, odd against even, neighbours together, or all at once; residues 17–29 repeat the four at two pulses a loop |

Rose and Polygon arrived with `ART_VERSION` 11, and are the two verbs that need more than an
angle: a body's **distance from the centre** became a function of where it is on its way round,
defined once beside the angle and drawn by all five renderers from that one definition. A path
only ever brings a body *in* from its ring, so nothing leaves the disc; it makes one trip a
loop, carries no trail and is not paced by `Tempo` — a flower is read by following it round
once, and both of the others would be a second rhythm over the one the number gave it.

Three smaller bindings ride on it. A body standing for the prime `p` turns `1 + ((p+1) mod 3)`
times a loop — its **gear** — so 2 turns once in every number it divides and 7 three times, and
two numbers of the same shape still differ (on a Duet, a Convoy or a Pendulum; a path makes its
one trip whatever its factors). A stepped (`tick`) orbit takes
`4 + (largest factor mod 7)` held steps a revolution, capped so a step always outlasts a frame.
And a `Chase` runs clockwise for `p ≡ 1 (mod 4)` and counter-clockwise for `p ≡ 3`. Measured
over n = 2..2000, a window of nine consecutive numbers shows 5.7 distinct movements on average
and never fewer than three (5.7 and three around 10⁶), and no composite verb covers more than
33% of composites. A prime still **holds station** — §5.1 is untouched; what varies is the
order of the pulse, never whether a facet travels. A composite too large to factor falls back
to a seeded draw among Circle, Duet, Pendulum and Rewind, and every surface that draws a number
factors it under the same bound (`factorizeWithinBudget`, `shared/primality`), so the live tile
and `/nft/<n>.png` cannot disagree about which numbers those are. Every verb closes at the
loop: a swing is a whole number of sine cycles, and the sticker profile clamps pulses to one a
loop exactly as it clamps revolutions.

**The ground carries a gesture, and primality picks it.** The tile's background is not a plate:
over one loop it draws one of eight named movements, published as the `Ground` attribute.
Primes draw only from the **held** set — `breathe` (swell and return), `ripple` (a ring
expanding outward and fading), `tilt` (a slowly turning ellipse), and rarely `still`, the
one ground in the collection that does not move. The held gestures preserve the wash's
CENTRE, and a radially symmetric falloff is very nearly invariant under scaling and rotation
about its own centre, so each of the three carries its gesture on **brightness** as well as on
geometry — otherwise the trait is published, measurable, and invisible. Composites draw only from the **travelling**
set — `drift` (a closed Lissajous wander), `orbit` (the wash centre revolving), `sweep` (a long
traverse and back), `parallax` (two washes, opposite directions, different rates). That split is
the same §5.1 statement the bodies make, carried into the background rather than repeated as a
second decoration: a prime's whole tile holds, a composite's whole tile travels. Every gesture
closes at the loop, for the reason body revolutions are integers — a marketplace tile loops
forever and a gesture that did not close would pop once per cycle. It is a trait like any other:
one shared formula (`groundFrame`), sampled by all five renderers, so the still is frame 0 of
the same movement the sticker and the live tile play.

**The picture has depth, and the depth is derived like everything else.** A tile is four planes,
not one. The **lattice** — the field of marks behind the bodies — draws its radii with a heavy
tail rather than uniformly, so a few marks are large and most are dust, and couples size to
opacity in one of two directions published as the `Depth` attribute: `Near`, where bigger is
brighter and the field reads as a sharp starfield, or `Bokeh`, where bigger is fainter and it
reads as thrown out of focus. Far marks are tinted toward the wash, near ones stay on the ink,
and anything landing under the number is dimmed — the contrast guard's rule again, that
legibility of the number is the one thing no trait may trade away. The lattice **moves**, by the
same primality split the ground obeys: a held ground twinkles its marks in four phase buckets, a
travelling one carries three depth planes at 0.20/0.36/0.56 of the ground's own rate, which is
the parallax that makes a background a volume rather than a plate with dots printed on it; only
`still` leaves it motionless, and that is the one piece in the collection whose background is
deliberately a plate. A composite's **orbits** are ellipses — a static squash and tilt outside
the animated sweep — with the body swelling and brightening as it comes round the near side, so
it passes *around* the number instead of over it; `braid` alternates the tilt so its two
counter-rotating families visibly cross. The sweep itself is paced by a `Tempo` attribute rather
than by the single linear rotation the whole collection used to share: `Glide` (constant),
`Surge` (a dwell then a rush) or `Tick` (six held steps a revolution, mechanical). And the prime
archetypes finally draw the shapes their names promise — `crystal` a polygon turning on its own
axis, `halo` a ring, `monolith` a square, `beacon` the disc it always was — while `cascade` and
hero `velocity` pieces trail two fainter copies of each body behind it, a comet out of the same
stacked-copy trick the halo already uses.

**One generator, five renderers.** `shared/art` resolves traits and then a scene once; the
PNG rasteriser, the Lottie emitter (and its `.tgs` sticker profile), the GIF encoder and the
webapp's CSS builder all consume that same scene. The still is literally frame 0 of the animation. **The generator is
consensus-critical for art**: its draw order defines the artwork of every already-minted
number, so it is versioned (`ART_VERSION`, published in `attributes`) and pinned by
snapshot test. A change to it is a repaint of things people own, and must be deliberate.

**The mint performance.** A mint has a genuinely undetermined interval between signing and
settlement. The webapp draws that interval as undetermined — several candidate artworks
superposed, drawn with live entropy, none committed — and collapses to the true piece when
the mint settles. The candidates are unpredictable and never repeat; the resolved piece is
the pure function of `n` the marketplace will serve forever. Landing the collapse anywhere
else would be a lie told at the most memorable moment in the product. **The collapse is the
number's own, too.** Each body waits just outside its place and arrives in an order the number
sets: a composite's bodies smallest factor first — a Convoy car by car — each sweeping in along
the direction it is about to travel, by an angle its gear sets; a prime's facets straight in,
with no turn, in the order they pulse — together for a Unison, one after another for a Chase.
Inward only, and inside the budget the outcome already had: a composite is still a 260 ms
settle and a prime's scene still comes forward in 420 ms before its mark strikes.

### 9.9 The number as identity: Telegram surfaces

A number here is a cash-flow claim (§3), but the referral key (§3.1) already makes it
something more: `r42` is a vanity handle with cash-flow pricing — the username pattern.
The chain side of identity is complete: naming rights and annotations are on-chain
(registrar, §4.7.1), the webapp renders them (`Nameplate`), and §9.8 draws every number.
What was missing until D-63 is the **Telegram side** — nothing put ownership in front of
other people inside the app the game is played in. D-63 (owner, 2026-08-27) closes that
with five bounded surfaces (`DECISIONS.md` D-203 added a chat-widget sixth and D-205 deleted it;
D-207 deleted the lineage card, leaving four),
all off-chain, none touching the split or any invariant:

1. **Per-owner sticker sets.** The bot builds a personal sticker set per player
   (`createNewStickerSet`), adding the `.tgs` of any number they own on request — the
   §9.8 tier-2c file, already rendered, finally sendable from the sticker drawer.
   Ownership is verified against chain state **at add-time only**; a sticker is a
   souvenir, not a title — transfer of the NFT does not revoke it, because chain state
   remains the only truth about ownership and the sticker never claimed to be one.
2. **`/whois` and `/flex` bot commands, opt-in.** In the community group, `/whois @user`
   lists their numbers, names and rank from the read-index. `/flex` takes no number: it
   switches the caller's OWN linked wallet(s) to a public profile and replies with that
   profile (the same answer `/whois` now gives), and `/flex off`
   switches it back. `/whois` answers only for users who enabled a public profile in the
   Mini App **or ran `/flex`** (flexing is consent); everyone else reads as private. The attribution service holds the one boolean. The
   handle↔wallet↔holdings mapping is derivable from public data, but the bot does not
   volunteer it for people who never asked to be seen.
3. **Emoji status: wearables for named numbers only.** The Mini App offers "wear your
   number" via `setEmojiStatus`, backed by a bot-owned custom-emoji set. A wearable is
   minted into the set **only when a number is named** (§4.7.1 naming, or an era trophy
   §7) — so status supply is bounded by the naming fee that already prices status
   (`DECISIONS.md` D-212: the owner's GRAM fee, ~50 EUR; only an era trophy's first
   engraving is free). Telegram caps one emoji set at 200, so the bot fills numbered sets
   (`primes_wearables_by_<bot>`, then `primes_wearables_<k+1>_by_<bot>`), all owned by one
   account (`WEARABLE_SET_OWNER_ID`), one wearable mint at a time. Premium-only
   wearability is Telegram's constraint, accepted.
4. **Collectible-shaped metadata.** One bounded conformance pass: the TEP-64 document's
   `attributes` are audited against Telegram's own gift/collectible rendering conventions
   so forwards render richly today. No code against a third-party Gifts API is written
   until Telegram ships one — the positioning is shape, not integration.

**All four stand on one row, and that row has two doors** (D-150). A Telegram surface can
only answer "which numbers are *yours*" because the attribution service holds a
`wallet_telegram_links` row pairing a wallet with a Telegram id; `/whois`, `/flex`,
`/sticker` and the wearables all read that one table. Only Telegram may create such a row,
because only Telegram can vouch for the identity half — the browser holds a proved *wallet*
and nothing else. So there are exactly two ways in, and both end with Telegram speaking:

- **Inside Telegram**, the Mini App's HMAC-signed `initData` is the vouching, and the row is
  written on arrival — auto-link with opt-out, the owner's call of 2026-08-27. `initData`
  vouches for the Telegram half only, so the wallet half is the request's `ton_proof` session
  for that same wallet (asked for on every connect); a wallet named without one is linked to
  nothing, or any caller could attach their Telegram to a stranger's numbers.
- **Outside it**, the browser mints a one-time code against its proved wallet, hands it to
  the bot through a `?start=link_<code>` deep link, and the bot asks the human to confirm
  the pairing by name before writing anything. The code is single-use and expires in ten
  minutes, because a code sitting in a chat log is a standing offer to attach an identity
  to someone else's wallet.

The consent is given by the Telegram side, so **the Telegram side can withdraw it**: `/unlink`
in the bot drops a pair, deriving the identity from the sender and never from the button. The
wallet side keeps its own switch (the `/me` card, which flips `enabled` and deletes nothing) —
two parties to a link, two revokes, neither needing the other's key.

**And the wallet side is told WHO it is linked to.** Both doors above end with Telegram
vouching for an identity, so the row records that identity — display name, @handle and
avatar — alongside the pair, and the `/me` card renders it. The reason is the same one that
makes the bot's confirm button name the wallet before the player agrees: the pairing is
completed in the other app, usually on another device, so a card reading only "connected"
asks the holder of the wallet to take the service's word for which account it attached. A
face and a handle are checkable; a numeric id alone is not. Every field but the id is
optional at the source and the card degrades to whatever the row has.

None of these surfaces shows an economic number, so §9.1 is not in play; where a surface
repeats a chain fact (ownership, a name, a factorization), the read-index it queries is
itself fed by get-methods, and the surface must not cache a mutable fact into an
immutable artifact — that is the same class of bug as decorative geometry.

### 9.10 Programs as players

The audience is the auditor (§2.2), and an auditor with a wallet is a player. Nothing in this
section adds a rule; it names a consequence of the rules already written. D-131 (owner,
2026-09-16) adopts it as a distribution channel: the game is advertised as one an agent can
audit before it plays, and the project ships the packaging that lets it — a single shared
message builder, a Node SDK, and an MCP server over the SDK (`backend/agent` and
`backend/mcp`, published to npm as `@ton-primes/agent` and `@ton-primes/mcp`).

What a program is told, and why each line is honest:

1. **Every rule is a get-method** (§9.1), so an agent can verify the ratchet (§5), the split
   (§4.1) and the floor before spending 1 GRAM. This is a description of the interface.
2. **A referral key pays the owner of that number on every mint the program makes** (§4.1,
   §9.2). Running an agent under one's own number is the operator loop and the KOL loop in
   one sentence.

What a program is **not** told: that any loop returns more than it pays. §8 prices every
automated behaviour at the floor — bot loops return `k · β · P < P`, self-referral is assumed
universal, sybil recruiting costs a fresh address plus a full mint (0.70 GRAM net of the
invite line, §4.6) and returns no GRAM — and
§8.1 names the one inversion: above `x* = (1 − c) / (k_max(n) · β)` the self-referred loop is
profitable, and an advertised agent population is one that computes `x*` in public and turns
on together. That is bounded by `K_CEIL` like everything else and is published, not hidden.
§9.4's social quests are Telegram-gated and are the one surface this section does not cover.

No contract path gains a cooldown, per-wallet cap or proof-of-humanity for this, and none is
removed: there is nothing to relax. Read surfaces stay anonymous and rate-limited per IP
(`ops/rate-limit-budget.md`); money-critical numbers are read live from the chain, never from
the index (§9.1). Keys are signed locally — no service of this project ever holds a player's
key. A leaderboard never flags a holder as a program: that fact is not recomputable from chain
state, so §9.1 forbids showing it.

What the packaging promises, each half enforced by a test rather than stated:

- **One builder for every player action.** The bodies a player or program signs live once, in
  `shared/messages.ts`; the webapp and the SDK build every send from it, so a program signs the
  same bytes the app does. Contract wrappers import it only for those player-facing bodies (13
  of the 56 wrappers, 2026-10-04); a wrapper's operator, keeper and test-only sends still encode
  their own bodies, checked against `shared/schemas/*.tlb` by the contract tests.
- **The whole surface, or a named reason.** `backend/agent/test/coverage.test.ts` requires every
  builder in `shared/messages.ts` and every path in both OpenAPI specs to be wired to an SDK
  method or excluded with a stated reason (the governed-treasury LP position messages are
  excluded: the SDK cannot acquire the LP they need, since the two-sided deposit takes a
  multi-message send it does not have; the LP miner they once sat beside is deleted, D-168),
  and fails on a stale entry.
- **A refusal before the wallet opens.** The actions read the handler's own `assert`s through
  get-methods first and throws locally, so a program never pays gas to learn a precondition.
- **Nothing published is not zero.** `null` means the chain has no such state — an undeployed
  wallet, an unread account — never a fabricated `0` (§9.1); a route that fails throws. Every
  getter the proxy reads exists on the deployed contracts, so no route answers "not on this
  deployment" any more.
- **A write quotes before it spends.** Each MCP write tool echoes the GRAM it would send and sends
  only on an explicit `confirm: true`; the server is local stdio, because signing is local.

### 9.11 The referral board: what each key has paid

`DECISIONS.md` D-177 (owner, 2026-09-24). A referral key is a number (§4.1) and its right
travels with the NFT (§3.1), so a number that recruits pays whoever holds it, and until now
nobody could see which ones do. The board shows it as a **figure, never a promise**: GRAM the
ledger has actually sent down each key's referral line, ranked. It turns §4.1's 10% line
into a holder's reason to market a number, which is §2 principle 4's shape: the growth budget
is a fee line that already exists, and no PRIMES, no `k_max` uplift and no new split line
pays for it.

- **What it ranks: numbers, not players.** A row is a key `rN`. Its figure is the lifetime
  GRAM the ledger relayed through that number's item to its holder of the day, across every
  wallet that has held it (D-149 finding 1). The current holder is a label on the row, read
  from `get_nft_data`, never the thing ranked.
- **The §9.1 source is a get-method on the item.** Each paid referral is one
  `ForwardToOwner` (`0xc1000002`) from the ledger's `payHeldSplit`, sent only after the
  minted item's `mint_confirmed` (D-117, D-199) and only for a key the ledger judged valid at mint
  (`key >= 2`, below the head, not an unsold prime, not reserved; D-149 finding 4). The item
  counts what that arm received in a never-decremented `referralPaidTotal`, published as
  **`getReferralPaid()`**, the same shape as `getTributeTotal()` (§3.2.1). A row's GRAM figure
  is that reading and nothing else: not a count multiplied by `REFERRAL_AMOUNT`, and never
  the index's own arithmetic (§9.10: money-critical figures come from the chain).
- **The ranking is the read-index's, the way `/boards/recruiters` is.** There is no key
  enumeration on chain, so `backend/read-index` reads `getReferralPaid()` for every key that
  has appeared as `referral_key` in an indexed mint and serves them sorted
  (`GET /boards/referrals`), each row carrying its own seqno. A key that never appears in an
  indexed mint has paid nothing and has no row.
- **Where it lives: `/earn`, below the reader's own key block, and not on `/leaders`.**
  `/leaders` ranks players (D-149); this ranks numbers, next to the link that earns on one.
  A number-keyed board is served as a top-N, not D-124's band (the band is for wallet-keyed
  boards); the connected wallet's own keys are marked where they appear and appended below
  with their true rank where they do not. The same reading is the paid figure on
  `/n/:number` beside D-149's paid-referral count.
- **Form.** Each key is drawn in a `NumberOrb` (the orb rule; a key is a number's portrait, not a lot, so `LotOrb`'s lane and clock do not apply), its row a fill against the
  board's leader. The figure rolls to its reading. Cyan and amber keep their prime and
  composite meanings, and the fill is green: GRAM paid out to a holder (CLAUDE.md frontend rule 5).
- **PLAY** says the heading and the figures and nothing else. **AUDITOR** adds one
  sentence naming `getReferralPaid()`, the `ForwardToOwner` hop and the validity rule, and
  says the ranking is the index's while each figure is the chain's.
- **What it must never claim.** No rate, no APY, no "yield", no projection of what a key
  will pay, no price or value for a number derived from its row, and no suggestion that
  buying a number buys its past: the figure is lifetime GRAM already sent to past and present
  holders, and a buyer receives only future referrals. The copy says "paid", never "earns"
  or "returns". A board of what already happened is all §9.1 lets it be.

## 10. Build plan

**Phase 1 — Economic simulation (2–3 weeks).**
Agent-based simulation (Python): mint arrival processes (Poisson + hype bursts),
adversarial agents (instant-dump rebaters, bot loops, whale PRIMES sellers, floor
snipers on the prime Dutch lane, reservation squatters — "auction
snipers" in the hard-close sense are retired with D-8's extending close, §8.1). Outputs: k_min, the k_max anchor n₀,
τ, genesis ratio, validation of the 10% tribute share **and of its internal split — the
divisor-weight exponent (proposed ½) and the flat-dividend fraction `f` (proposed 0.2),
both immutable after deploy (§3.2)**, the flush parameters
`FLUSH_PCT` / `FLUSH_COOLDOWN` / `FLUSH_MIN` / `FLOOR_GUARD` (§4.3, §4.3.1) against
modeled pool depth, expected time-below-floor and sandwich profitability — including **how
large the ratchet's balance grows in a market that stays above the floor for months**,
since that
balance is now a design output rather than a five-day queue — the prime-side parameters
`PRIME_UPLIFT` and `PRIME_WINDOW` and the prime rank tiers and their uplifts (§4.7.1,
§5.1), the invite line's effect on β (`DECISIONS.md` D-202 — the PRIME GENERATORS tier and
drop-weight tables and the constellation discovery-bounty schedule this list used to ask for
are deleted with the mechanics), the bounty vault size and era-bounty schedule (§3.3, §7),
`RES_GAS` (~~`RES_PRIORITY_BASE`~~ — deleted, `DECISIONS.md` D-30/D-37), the desirability
ladder's `PREMIUM_UNIT` and its `PREMIUM_CAP` bound — **now setting a lot's opening price
`P0(n)` and its minimum bid increment, no longer any fee** (D-33) — and the release
forfeit's gas floor in place of the withdrawn cancellation fee (§4.4, D-32), ~~the rebate
vesting parameters `VEST_NOW` / `VEST_H` against the §8.1 premium-harvest model~~ (deleted
— §5's vesting mechanism never shipped and is struck, `DECISIONS.md` D-55; there is no
parameter left for Phase 1 to size here) (~~and `ERA_DIV_CAP`~~ —
the era dividend is dropped, so §8.1's sybil bound no longer has this term to price,
`DECISIONS.md` D-36), the **prime lane's two numbers** — `NPV(p)`, the input to the
NPV branch of every prime's opening price `P0(p) = max(1.5 · NPV(p), ladder(D), LOT_FLOOR)`
(§4.4 point 1b; ~~`PRIME_P0_MIN` binds for most primes~~ — deleted by D-99, and the ladder
binds instead, since a prime scores 15 points for being one), and
`PRIME_DUTCH_SECONDS`, the one
slope shared by every prime (§6; the per-lot start price, the `P0/100` reserve and the
90-day schedule are all withdrawn with the K-lot) — and the
invite parameters — `NEWCOMER_UPLIFT` and its five-mint window, the recruit-rank tiers and
the `k_max` uplift per tier (§4.6, §4.7); plus the charts for the landing page. β is no
longer a free parameter — it is the residual of §4.1 — but the simulation must confirm
the residual stays healthy under universal self-referral and a full invite fan-out.
*(`DECISIONS.md` D-106 removed the deepest part of this check with the patron line: the
list used to include φ₁, φ₂ and `PATRON_CAP`, and the trough to watch was β = 0.40 on
activation mints and 0.575 through the annuity window. The worst case is 0.247 now, and 0.24 under any operator terms (0.525 until `DECISIONS.md` D-117's 20% gas & ops line, 0.425 until D-202's 3 × 0.1 GRAM invite line, 0.25 until D-215 put its fees on top), and it
does not depend on who the minter is.)* The quantity to watch is the floor trajectory
during a *growth spike*, when the share of
activation mints in the mix is at its highest — the one regime where recruitment success
and ratchet rate pull against each other.

**The demand side has its own Phase 1 block, and its own stop condition** (§5.2, §5.3).
Outputs: the staking block — `staking.distribution_rate_bps_per_day` (the rate the LP miner
ran at, re-stated for stakers), `staking.epoch_seconds`, `staking.tier_term_seconds` and
`staking.tier_weights`, with the tier weights validated monotone and diminishing per locked
day; **LP depth and flush slippage with the LP miner removed** — if §4.3.1's flush can no
longer defend its band, the build stops and the owner decides (`DECISIONS.md` D-168); and a
burn-volume model for the §5.2 sinks whose output is the expected circulating-versus-`S` gap
over the horizon. *(Until D-168 this block sized a purchasable `k_max` uplift —
`STAKE_TIERS` / `STAKE_UPLIFT` / `θ` — against an `x*` kill criterion; that design is
deleted and so are its outputs.)*

The constellation registration bond and the transferable discovery-certificate NFT were
shipped under D-2 and D-35 and are **retired by `DECISIONS.md` D-102** along with the
predicate registry they priced: there is no standing right to charge for and no `set_id`
to issue a certificate against. The `sinks.bond_burn` block is gone from
`shared/params.json` and `kill_criteria` runs without it; nothing about the burn-volume
model above depends on it, because a sink that no longer exists burns nothing.

**The tribute split has its own kill criterion, and it cuts both ways.** The `√p` weighting
and the flat dividend exist to make primes above 200 worth minting (§3.2), and they are
paid for out of the small primes — so Phase 1 must report the prime-lane loss as
explicitly as the tail-side gain. Two failures to look for: `f` and the ½ exponent set so
low that the tail stays a rounding error and §5.1's stall risk returns, or set so high
that 2, 3 and 5 sell at or near their resting price instead of the premium their tribute
claims justify — there is no reserve and no LP bootstrap to protect any more (D-20; D-46
removed the deploy-time LP deposit, and the genesis pair D-154 posts by hand is funded by the
floor donation, not by lot proceeds, §6 point 3; the descending lane's only floor is
`max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)`, D-88 point 1 and D-99 §1.2 — which for 2, 3 and 5 is itself derived from the
same tribute expectation the exponent moves, so the two are coupled and the sim must move
them together), so the failure is forgone premium, not a failed bootstrap.
The simulation models the prime Dutch lane; it must model it *against* the chosen
exponent rather than as an independent number.

~~Patronage adds agents the earlier plan did not have: the **recruiter**, the **sweeper**
and the **sybil patron**, and a recruit-activation process — claim probability, activation
probability, and the mint distribution of an activated recruit.~~ **RETIRED with the
mechanic (`DECISIONS.md` D-106).** Those were the least grounded assumptions in the whole
simulation, which is why the sensitivity was published rather than a point estimate; none
of them has a subject now. A recruiter pays the mint price and receives a `k_max` tier, so
there is no payoff process to model — what bounds the tier is §5's clamp, which
`rebate.uplift_stacking` already measures with every ladder maxed at once. Model the
locked and open claim paths as **separate** activation processes (§4.6): collapsing them
into one rate throws away the entire argument for the claim lock and would make the
simulation agree with itself by construction.

**The prime lane is a first-class object in the model, not a detail — and since D-20 it is
a *demand* object rather than a liveness one.** There is no prime head to wait at: primes
are off the sequential line entirely (§6 point 1), so the distribution to track is **time
from lot open to sale, and where on the decay slope the sale lands**, conditional on the
prime's tribute NPV, its `D(n)`, and the standing floor. Two outputs fall out of it and
both are needed elsewhere in this document: the fraction of the opening price actually
captured as premium (which is what §5's floor projections credit), and the **tribute
forfeited to the treasury while unsold** (§4.1, §6 point 2), which is the number §12's
revenue-risk entry is accepted against and the one an adversarial reader will ask for
first. A model that treats mints as an undifferentiated Poisson stream cannot see either.

**The mint stream must be segmented by agent type**, with the bot share a swept parameter
rather than an assumption. Humans and timing bots value the same mint differently — a bot
discounts tribute NPV hard and values naming rights and rank at zero — so an
undifferentiated arrival process overstates prime-lot demand and cannot see who captures
the emission. Tracked outputs: the fraction of calendar time spent at
`x ≥ x*` (§8.1), the share of emission collected above each k threshold by agent type,
the prime-lot time-to-sale conditional on bot share, ~~the effective ceiling `x*·(1+ρ)` as
a function of `VEST_H`~~ (deleted — §5's vesting never shipped, `x*` is a hard ceiling
today with no risk premium `ρ` to sweep, `DECISIONS.md` D-55). (~~`ERA_DIV_CAP` checked
against the premium-adjusted sybil cost~~ — dropped with the era dividend, `DECISIONS.md`
D-36. §8.1's sybil bound is now checked without it, which only tightens the result: the
dividend was the one recruitment reward sitting outside the then-live `PATRON_CAP`, and
D-106 has since deleted the cap and the line it bounded.)

Kill criteria: any parameterization where **the share of primes still unsold at their 1
GRAM floor grows without bound as the head advances** — the successor to the old
prime-head-wait criterion, which D-20 retired along with the prime head; it no longer
threatens liveness, it threatens revenue, because every unsold prime forfeits its tribute
to the treasury indefinitely (§4.1) — where the AMM price detaches persistently
below floor trajectory *and the floor guard's accumulated balance is insufficient to
close it* (§4.3.1), where tribute yields round to zero too fast (the boosted-constellation crowding criterion
that used to sit here is deleted with the multiplier, `DECISIONS.md` D-102), **where 10% tribute
leaves a small prime's modeled fair value so low that `1.5 · NPV(p)` opens below the
score's own ladder across the whole early line, i.e. there is no slope to walk down**
(~~`PRIME_P0_MIN`~~ — deleted by D-99; the ladder is the comparison now) —
that one sends tribute back toward 15–20%.

~~**Or where the achievable activation rate `a` stays below 41.5%** and the rank rights
needed to close the gap are worth more to a Patron than the mint volume required to earn
them (§4.6.2).~~ **THE CRITERION FIRED, AND `DECISIONS.md` D-106 IS THE ANSWER TO IT.** It
was called the sharpest kill criterion in this document precisely because it was a
*necessary* condition no other parameter could rescue: `PATRON_CAP` bounded the payout at
1.00 GRAM, so below `a` = 41.5% the annuity could not clear the 0.415 GRAM cost of the
surrendered NFT however engaged the recruits were. Phase 1 measured `a` = 0.370 and
`sim/primes_sim/kill_criteria.py` reported **FAIL** at the published cost basis for the
mechanic's entire life. This section already named the remedy — "that criterion kills
patron mode specifically, not the protocol: the patron line is conditional, so the
mechanic can be dropped by never issuing patron-mode mints, and β returns to 65/75 with
nothing else touched" — and establishing that severability was a Phase 1 deliverable in
its own right. D-106 exercises it, and deletes the line rather than leaving it dark.

**Phase 2 — Math note + spec (1–2 weeks, overlaps).**
Short paper: the ratchet theorem, emission curve, the `e·√p` tribute weighting, the
self-tribute corollary, the one-message mint and reservation protocols, full message schemas, and the reference valuation model for `NPV(p)`
across the prime line (released after the contest, §9.6 — there is no genesis prime set
under D-20; the model prices the small primes every reader can buy off the descending
lane). This is a marketing asset for this audience.

**Phase 3 — Contracts (4–6 weeks).**
**Tolk** (`contracts/contracts/*.tolk`, `@ton/blueprint`), chosen for readability on the
same grounds earlier drafts named Tact — the contract is the whitepaper. Miller–Rabin is
written in Tolk too, on `MULDIVMOD`, and is duplicated into each contract that needs it
(ledger, market, registrar) from one source, `prime_mr.tolk.inc`, by
`tools/sync-score-block.mjs`; `pnpm check:score-block` fails on a drifted copy, every copy is
published through a get-method, and the specs compare the get-methods. (This once said Tolk
1.4 has no import mechanism. It has one — the ledger and the minter card both
`import "minter_standing"` — and the copy-and-check pattern is kept for the MR and score
blocks.) As built, `contracts/contracts/` holds **25** `primes_*.tolk` contracts, and every one
is named below with the section that specifies it.
- Miller–Rabin library on `MULDIVMOD` — **gas-benchmark first, riskiest unknown.**
- NFT collection + sequential minter (`primes_collection.tolk`, a thin TEP-62 relay, and
  `primes_item.tolk`; the verification itself is the ledger's) with factorization verification, one-message mint
  (cheap-fail refunds on a lost race per §8), gift-mint beneficiary
  routing (§4.5), and referral-key resolution (owner-of-NFT lookup, §3.1).
- ~~Patronage: patron-mode mint, unclaimed item state, purse, `claimHash`, claim,
  lock-lift and reclaim-open at the primorial boundary, the activation hook, the two-rate
  patron line with its `PATRON_CAP` termination, purse release, the `gifted_by`
  inscription and permissionless expiry-reclaim.~~ **DELETED (`DECISIONS.md` D-106).** The
  whole list is gone from `contracts/`, and what replaced it is one boolean the mint
  already carries: a §4.5 gift mint whose beneficiary's minter card is fresh credits the
  payer one recruit and opens the beneficiary's newcomer window (D-191 moved the standing
  onto that per-wallet card). No per-recruit state, no lifecycle.
- Rank registry, two ladders — the counters the uplift sum reads live on each wallet's
  **minter card** (`DECISIONS.md` D-191), which attaches them to the mint it forwards (it is
  on the mint path), and `primes_registrar.tolk` publishes prime
  rank and holds the naming annotations. Recruit rank (lifetime and per-era recruit counters) and
  **prime rank (a lifetime primes-minted counter, §4.7.1; D-187 deleted the per-era one)**, tier resolution on
  each, the `k_max` uplifts **summed with `PRIME_UPLIFT` and `NEWCOMER_UPLIFT` before a
  single `K_CEIL = 0.95` clamp** (§5), the newcomer and prime-credit window counters — the
  latter decrementing on composite mints only and resetting rather than stacking (§5.1) —
  ~~the `RES_PRIORITY_BASE` fee waiver~~ (deleted with the fee, `DECISIONS.md` D-30/D-37),
  era-trophy engraving storage (a number's own name is on its item, D-188 point 6 and
  D-212; gifted numbers deleted by D-187), and era-trophy and finder's-board accounting (§4.7, §4.7.1; the era dividend is
  dropped, D-36).
- **Market** (`primes_market.tolk`), which is one contract where three used to be
  (`DECISIONS.md` D-3, D-16; layout in `docs/audit/unified-market-layout.md`) and where two
  used to be until **D-90 deleted `primes_market_shard.tolk` outright**, along with the
  escrowed claim, `settle`, `release`, `cancel` and the `get_escrow_aggregate` /
  `get_reservations` counters over them. What is left is two lot modes: the ascending lane
  (`open_lot` / `bid` / `close`, 7-day clock with the 67-minute extension, the route to any
  number ahead of the head, **which mints the number in the closing transaction** — D-90),
  and the descending lane a number gets at its turn (`open_head_lot`, buy-now, resting at
  `max(NPV(n) / 2, P0(n) / 3, MINT_PRICE)` — the `P0(n) / 3` term is D-99's and replaces the
  deleted tier `price_min` — and published per lot by `getLotFloor(n)`; D-88 point 1,
  invariant MKT-1 is deleted). It also carries the score: `scoreOf(n)` is a block duplicated
  byte-for-byte with `primes_ledger.tolk` (D-99), and `getLotPrice` / `getScoreBreakdown` /
  `getScoreWeights` publish it.
  `n` is `uint64` here and `uint256` everywhere else (`DECISIONS.md` D-18), asserted
  against `AUCTIONABLE_MAX` on every entry point that takes an `n`.
- Registrar (`primes_registrar.tolk`): the eight era trophies (§4.7) and the paid-annotation
  door (§4.7.1). Its constellation build lifecycle, the constellations collection and item,
  and the vault's discovery bounty are **deleted** (`DECISIONS.md` D-202), as D-102 deleted
  the predicate registry before them.
- PRIMES jetton (`primes_jetton_master.tolk` / `primes_jetton_wallet.tolk`) with mint
  authority restricted to the ledger; genesis bounty vault (`primes_bounty_vault.tolk`)
  under contract-only spend paths (§3.3), and the voucher claim verifier
  (`primes_voucher.tolk`, §9.5).
- ~~PRIME GENERATORS (`primes_generators_collection.tolk` / `primes_generator_item.tolk`,
  §3.5, D-101).~~ **Deleted** (`DECISIONS.md` D-202).
- Per-wallet and per-block children (`DECISIONS.md` D-188's storage cap): the **minter card**
  (`primes_minter_card.tolk`, one per wallet — rebate standing, newcomer window, era tally;
  D-191, D-195), the **claim receipt** (`primes_claim_receipt.tolk`, one per claimant — the
  cumulative voucher mark the vault used to keep; D-191), and the **lot block**
  (`primes_lot_block.tolk`, one per block of numbers — far-ahead lot marks and, once the head
  has left the block, its unsold primes' bookmarks and forfeit counters; D-196, D-198).
- **Splitter + Ledger are one contract**, `primes_ledger.tolk` (§3.4); the two bullets below
  are its two halves.
- **Splitter**: proof verification — including the **submitted-`⌊√p⌋` check
  `s² ≤ p < (s+1)²` per factor (§3.2)**, head advance, the split's five deductions and its
  residual β — including the invite line's up-to-three text transfers and its "unspent → β"
  rule (`DECISIONS.md` D-101, D-202) — with `e·√p`-weighted tribute over the divisor line and the O(1)
  `div_acc` accrual for the flat prime dividend, **the empty-tribute path on prime mints (line falls to the
  pool, §4.1) and the zero-rebate path that skips jetton-wallet deploy entirely on primes
  (§5.1)**, §4.5 beneficiary routing and D-106's recruit edge, referral-key resolution.
- **Ledger**: cumulative `T`/`S` counters, the `owed[p]` dictionary and its GRAM balance,
  `p_f`, all public get-methods (§9.1), tribute distributor. Holds tribute owed to prime
  owners and nothing else.
- **Ratchet** (`primes_ratchet.tolk`): `pending`, `flush()`, the DeDust leg, burn. Holds the protocol's own
  backing and nothing else. **No admin withdraw path** — and under §4.3.1 it now carries a
  materially larger standing balance, which raises the stakes on that requirement rather
  than changing it.
- ~~**Escrow**: the market shards' GRAM, structurally separate from the other two so that
  refundable customer money never shares a contract with unwithdrawable backing (§3.4).~~
  **Deleted by `DECISIONS.md` D-90** with `primes_market_shard.tolk`: a won lot mints in its
  close, so no contract holds refundable customer money at all.
- **Benchmark the decomposition itself.** Splitter+ledger fused, ratchet separate is the
  §3.4 design, but each boundary is a message hop charged to the
  gas & ops line. Measure the hops against the same budget as Miller–Rabin and the
  per-owner balance index; if it lands badly, re-argue the ratchet split. Whatever the result, each contract must satisfy
  `balance ≈ declared liability` in one get-call — that reconciliation is the property
  the separation exists to produce.
- DeDust vault integration: `flush()` with cooldown/pct/min guards, **the floor guard
  `min_out = amount·S/T·(1+FLOOR_GUARD)` (§4.3.1)**, two-phase swap → notification → burn,
  bounce recovery that restores `pending` unchanged, `get_flush_status` exposing the last
  attempt's outcome. **No contract deposits LP and nothing burns it** (D-46) — the genesis pair
  is posted by hand from the floor donation's PRIMES at `p_f`, its receipt locked in the LP
  sink (D-140, D-154, §6 point 3); no contract builds the deposit.
  **Benchmark actual flush gas** — the
  0.05–0.20 GRAM swap estimate is quoted from DeDust's docs, not measured. Watch the
  `amount·S/T` arithmetic for overflow and precision: `S` is a jetton supply in
  nano-units and `T` is nanotons, so the multiplication must be ordered and widened
  deliberately rather than left to whatever the compiler does.
- The supply side and its custody (the burn sink, `primes_sink.tolk`, is deleted by
  `DECISIONS.md` D-212); staking (`primes_stake.tolk` with one `primes_stake_position.tolk` child per wallet,
  §5.3, D-168); the governed treasury (`primes_treasury.tolk` with one
  `primes_lp_position.tolk` child per depositor, §5.5); the LP sink (`primes_lp_sink.tolk`,
  §5.5.3, §6 point 3); the treasury's vesting lock (`primes_vesting.tolk`, one instance,
  D-166); and the venue timelock (`primes_venue_timelock.tolk`, the §11.1 exception and the
  protocol's whole admin surface).
- ~~Auction contract for genesis primes.~~ **Withdrawn.** There is no genesis auction and
  no genesis-specific contract: `primes_auction.tolk`, `primes_trophy_auction.tolk`,
  `primes_reservation_book.tolk` and `primes_reservation_shard.tolk` are all deleted, and
  the market bullet above is what replaces them (`DECISIONS.md` D-3, D-16, D-20).

**Phase 3b — Growth stack (overlaps Phase 3).**
Telegram Mini App + bot (mint feed, k(t) clock, era countdown, **the prime lot and
next-prime countdown (§9.1)**, order book, recruiter and prime leaderboards,
era-trophy race, quests), backend caching
proxy with get-method-linked stats (§9.1), attribution service and deep-link builders
(§9.2), **the gifting composer (deferred, §9.1) and the one-screen gift → first-mint path (§9.1) — the
highest-leverage surfaces in the product, since the whole loop runs through whether a
gifted wallet ever mints one of its own**, story-QR renderer with counted-arrival
verification (§9.4), voucher signer (§9.5). *(Secret generation and custody for claim
locks was listed here — client-side, never on the backend, because a lock the operator can
open is not a lock. `DECISIONS.md` D-106 deleted the lock, so there is no secret.)*

**Phase 4 — Testnet + bug bounty (2–3 weeks).**
Public testnet run with **one 1,000,000-PRIMES prize for a bug that can drain the system**
— GRAM moving against §8 — paid to the first valid report on a merged fix, from the mainnet
bounty vault's reserved `security_bounty` track through a second instance of §9.5's voucher
on the owner's own key (`DECISIONS.md` D-170, superseding D-141's 30 GRAM pool). Every other
finding earns public credit. The terms are published on `/verify` before the round opens. For this audience the bounty program is also the
pre-launch marketing.

**Phase 5 — Launch.**
Immutable parameters (bar the §11.1 venue timelock), the treasury's vesting lock minted
(D-46/D-100 point 6; no operator allocation since D-166), the floor donation and the
floor-priced genesis pair posted by hand into the LP sink (D-154, §6 point 3), `ignite` mints Unity and
opens the market — the ascending lane for every number ahead of the head, and the
descending lots for 2 and 3, which open simultaneously because nothing composite precedes
either (§6 point 0). Live dashboard with the floor-price staircase front and center.
*(The launch list read "**patron mode live** (§11.11)" and put the unclaimed board one tab
away; `DECISIONS.md` D-106 deleted both.)*

## 11. Closed questions

**Status index, current as of 2026-10-04.** Every closure below is signed in
`DECISIONS.md`; this table is the map, and the numbered entries are the reasoning.

| | question | status | if open, waiting on |
|---|---|---|---|
| 1 | immutable vs. timelocked | **closed** — hybrid; **reopened narrowly 2026-09-04** (D-100 point 7): the economic core stays immutable, the *treasury* is governed; **amended 2026-09-28** (D-194): the staking venue is deploy data and a flush-venue change needs the proposer key AND a passed LP vote | |
| 2 | genesis set `K` and per-lot `P0` | **CLOSED 2026-08-19** | analytic extension built, laddered, tested and deployed; regresses to a uniform +5.3% offset that is explained, not reconciled away (`DECISIONS.md` §11 closures) |
| 3 | DeDust version dependency | **resolved** by Q1 | |
| 4 | jurisdiction / ToS framing | **CLOSED 2026-09-24** — counsel accepted the draft (D-183); Lithuanian law, courts of Lithuania (D-181) | |
| 5 | gas & ops fixed vs. pass-through | **closed** — fixed; 10%, re-derived to 20% by D-117, unspent part swept to the pool | |
| 6 | reservation horizon (now: the acquirable range) | **closed** — capped at 14 digits; re-justified 2026-09-24 and 2026-10-04 by what `AUCTIONABLE_MAX` bounds now, there being no reservation book (D-30) | |
| 7 | bounty vault size and split | **CLOSED 2026-08-19** | size and era schedule are sim outputs; the remaining-70% split is accepted as a Phase A design allocation, not promoted to a sim output |
| 8 | claim eligibility | **closed** — check dropped | |
| 9 | per-owner balance index | **closed** — removed | |
| 10 | which rank rights are reversible | **superseded** by Q1 — none are | |
| 11 | patron mode at launch | **moot** — the mechanic is deleted (D-106) | |
| 12 | is 25% on the activation mint too deep? | **moot** — there is no activation mint (D-106) | |
| 13 | era trophy transferable? | **closed** — transferable | |
| 14 | standing ratchet balance / liquid staking | ~~closed — not adopted~~ **REOPENED AND ADOPTED 2026-09-20** (D-151) | the four constraints the 2026-08-17 closure attached to any reopening are all met; built as §4.3.2 |
| 15 | prime compensation instrument | **closed** — `PRIME_UPLIFT`, no fallback | |
| 16 | one `RES_PRIORITY` queue or two? | **closed** — moot, there is no queue | |
| 17 | where clearings after the first route | **closed** — all to the ratchet | |
| 18 | does the staking sink ship? | **superseded** by D-168 (signed 2026-09-23) — staking ships as a PRIMES-paid supply lock, not a `k_max` uplift | the `x*` kill switch has no subject left; D-168's own stop condition is LP depth without the miner |
| 19 | entitlement meter vs. rate | **superseded** by D-168 — there is no uplift to meter; staking pays a streamed rate in PRIMES from the treasury | |
| 20 | purchasable uplift vs. immutability | **superseded** by D-168 — nothing is purchasable in `k_max` | |
| 21 | burn sinks vs. bounty vault | **closed** — two separate rows | |
| 22 | is staked PRIMES circulating? | **closed** — never netted out | |
| 23 | flat dividend's `1/π(n)` decay | **closed** — `f` stays 0.2 | |
| 24 | constellation non-reslicing reward | **closed in the negative** | moot since D-202 deleted constellations |
| 25 | desirability weights | **RE-CLOSED 2026-09-04** (D-99): the four-layer score is deleted and 33 owner-declared category weights replace it (54 today: the factorization phase, `GAUNTLET.md` N6 and D-162 appended bits 33..53); the 2026-08-27 closure (D-64..D-67: sim output, comps as a checked-in input, a `DIGIT` layer) is **withdrawn** — the sim run came back BOUNDED and a guess at demand is not a measurement | — (§9.6) |
| 26 | prime pre-funding displacement (re-scoped 2026-09-24) | **CLOSED 2026-09-24** by the owner — accepted: 96% of primes bought ahead of the head at the 0.30/day baseline interest, ~67% at 5× `P0` (upper bound; interest ASSUMED and swept); early sale is the D-88/D-90 design, the descending lot is the fallback | `determinations.q26_auction_lane.prime_prefunding_displacement`; §12 carries the accepted risk; realised clearing prices are post-launch telemetry |
| 27 | the auction consolidation | **record of decisions**, not a question | |
| 28 | primes on the ascending lane | **CLOSED 2026-08-17** (D-22, option 1: `open_lot` refuses primes) — amended by D-88 point 3: ascending is the route to *any* number ahead of the head, prime included; the descending lane is what a prime gets at its turn | |
| 29 | does the GIF tier get advertised in the metadata, and to which numbers? | **CLOSED 2026-09-24** (D-174): composites only, in `content_url` with `content_type: image/gif`; primes keep the mp4 there | §9.8 |
| 30 | a calendar-date desirability layer | **CLOSED 2026-09-04** (D-99): yes — the five-form LIFE group, against real Gregorian validity | §9.6 |


1. Immutable parameters vs. timelocked governance — immutability is the stronger pitch,
   timelock is the safer engineering choice.
   **CLOSED (2026-08-15): hybrid.** The economic core is **immutable at deploy** — the
   split rates, the `k` machinery (`K_CEIL`, `k_min`,
   `k_max(n)`, the uplift ladders and windows), tribute weighting, and every address the
   split pays; no admin path, no timelock, nothing to govern. The **only** mutable
   surface is the DeDust **venue address set on the ratchet**, behind the public venue
   timelock contract — which is exactly Q3's escape hatch and nothing more. *(D-194,
   2026-09-28: that set is where flush sends `pending`, so the escape hatch needs two keys —
   the proposer queues, the LP electorate (§5.5.2) confirms — and §4.3.2's staking addresses,
   which D-151 had put behind the same timelock, are deploy data.)* This is
   Q10's split applied at the top level: freeze everything that touches the split, leave
   the one external dependency replaceable in public, on a delay. Implemented as
   `primes_venue_timelock.tolk`; the pitch sentence survives intact because the
   timelock cannot reach a single economic parameter — though it can reach a destination
   of `pending`, which is why D-194 requires the LP vote as well.

   **REOPENED NARROWLY 2026-09-04 (`DECISIONS.md` D-100 point 7), and the narrowness is the
   whole of it.** The economic core stays immutable exactly as closed above — split rates
   and caps, the `k` machinery, tribute weighting, every address the split pays. What is now
   governed is the **treasury** (§5.5), which was never part of that core: it is the team's
   fee revenue, it holds none of the protected pools, and it spends only by a passed
   proposal of the LP electorate or by `distribute()` (§5.5.3, D-168). So the answer to Q1 becomes a
   *hybrid over two things* rather than one: the venue address set is timelocked, the
   treasury is voted, and everything the ratchet theorem depends on is still frozen at
   deploy with no path to it. The honest cost is that this system now contains a vote, and
   a vote is a surface an auditor has to read — which is why §5.5.5 states, in the spec's
   own voice, that the day-one electorate is empty (D-166) and that there is no quorum.
2. ~~Exact genesis auction set K and the per-lot start price `P0`.~~ **Restated
   2026-08-17 by `DECISIONS.md` D-20: half of this question no longer exists.** There is no
   genesis set — no `K`, no pre-deployed lots, no genesis-specific format — so "which primes
   are in it" has no referent. What survives is the **opening price of every prime's
   descending lot**, `P0(p) = PRIME_P0_MULTIPLE · NPV(p)` floored at `PRIME_P0_MIN`, which
   is a Phase 1 output per prime at `≈ 1.5×` fair value (§6). The reserve is no longer a free parameter either, and not for the old reason: it is
   not `P0/100` and, since `DECISIONS.md` D-88 point 1, not a universal `MINT_PRICE` either:
   it is `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` (D-99 §1.2), read off the same `NPV` table `P0` comes from, so it
   is not a free parameter for the same reason `P0` is not. Invariant MKT-1 is deleted; what
   survives is that the figure is write-once from `n`. One slope, `PRIME_DUTCH_SECONDS`, is
   shared by
   every lot. ~~**Still open:** `NPV(p)`'s analytic extension past the six reference entries
   and its regression against them.~~ **CLOSED 2026-08-19** (`DECISIONS.md` "§11 closures —
   2026-08-19"): the extension is built, laddered to p = 7297, wired into the deployed
   `npvTable`, and regresses to a uniform +5.3% offset that is published, not reconciled away.
   (`PRIME_P0_MIN` above is since deleted by D-99; `P0(p) = max(LOT_FLOOR, ladder(D), 1.5 ·
   NPV(p))`.)
3. **DeDust version dependency.** Immutable parameters (Q1) mean hardcoding DeDust v2
   vault and pool addresses forever. If DeDust ships v3 or retires the pool, the flush path
   dies with no upgrade route and `pending` accumulates permanently.
   **RESOLVED by Q1's hybrid closure:** the venue address set is the one timelocked
   surface in the system (`primes_venue_timelock.tolk`), so a venue migration is a
   public, delayed, venue-only operation — the flush path survives a DeDust v3 without
   any economic parameter becoming governable.
4. Jurisdiction/ToS framing review: game with fees, no promised returns, appreciation
   described only as the floor mechanism.
   **CLOSED 2026-09-24 (`DECISIONS.md` D-183):** counsel reviewed
   `docs/terms-of-service-draft.md` and accepted it as drafted; governing law and venue are
   Lithuanian (D-181). The excluded-territory list (§10) and the liability clause, cap and
   indemnity (§12) were written 2026-09-25 (D-186); the terms come into force at launch.

   **`DECISIONS.md` D-106 STRENGTHENED THIS, and the review's headline sentence changes.**
   It used to be "the mechanism's ceiling is a refund" — the patron line's `PATRON_CAP` =
   1.00 GRAM gave the review a *finite, disclosed* maximum any recruiter could ever earn
   from one recruit, exactly the price of the mint that started it, which was the
   difference between an acquisition cost and a downline. That line is deleted. **There is
   now exactly ONE mechanism in the game that pays GRAM for bringing somebody in — §4.1's
   referral line, single-level, paid only on a mint the payer made themselves.** What
   replaced the patron line pays *no currency at all*: a recruit raises the recruiter's own
   rebate ceiling by a tier, which is a limit on what their own future purchases can earn
   them, not a payment from the person they introduced. The sentence to build the review on
   is now: **recruiting pays no GRAM, and the one line that does is capped at a single
   level by the absence of any field that could hold a second.** `webapp/src/routes/Terms`
   §4 already says exactly this.
5. ~~Whether the gas & ops line should be a *fixed* 10% or a measured pass-through with the
   remainder falling to the pool.~~ **CLOSED (2026-08-16): fixed 10%.** The benchmark the
   question deferred to now exists, and the 2026-08-16 measurement came in under the 0.10
   GRAM line, which is the condition the question named as favouring pass-through. *(That
   figure was taken under a `RES_GAS`/`RES_PRIORITY` split D-30 deleted, and it undercounted
   the draw — see the D-117 note below; the current measured worst case, headroom and rule
   are `shared/params.json` `fees.gas_ops_line`.)* It is decided
   the other way anyway, and the reason is that the benchmark answered *honesty* while the
   decision turns on *legibility*: β is a constant in every worked example in §4.2 and
   §4.2.1 and in every sim run, and making it vary per mint would complicate every floor
   projection to hand a few percent of one mint back to the pool. The worst-case headroom
   is a monitored quantity (`fees.gas_ops_line.headroom_ton`, asserted non-negative by
   `sim/tests/test_res_gas.py`) rather than an open question.
   `shared/params.json`'s `mint._gas_ops_pct_note` is updated to match (`DECISIONS.md` D-9).
   **Superseded in figure, not in kind, by `DECISIONS.md` D-117 (2026-09-22):** the line stays
   fixed, but at **20%**, derived by the sim as the heaviest mint measured on the ledger's own
   balance (0.192 GRAM, ω = 12) rounded up to a 5% step, and its unspent part is swept back to
   the ratchet pool rather than to the operator. The 2026-08-16 benchmark undercounted the draw
   (§4.1).
6. Reservation horizon: should `reserve(n)` be unbounded (any n up to the Miller–Rabin
   exactness bound) or capped at head + H? Unbounded is purer and the escrow prices the
   risk; a cap keeps the book legible early. Lean unbounded; confirm the `reservations`
   dictionary rent against state-size limits alongside the §3.2.1 check.

   §4.4 point 1a puts something new on the table here and moves the question in both
   directions at once. Against unbounded: a trophy number far past the head becomes a cheap
   option on the game surviving long enough to reach it. For unbounded: the premium now
   *prices* that option instead of handing it out, which is exactly what the ladder is for.
   No change proposed; noted so that when Q6 is decided it is decided with this on the
   table rather than against the flat-fee version of the question.

   One implementation-side bound already exists and is not a design decision: the market's
   shard layout put `shardId` in a `uint32` over `n / 10,000`, which capped an acquirable
   `n` at about 4.29 × 10¹³ — 14 digits — far below the Miller–Rabin exactness bound this
   question assumes. Whether that accidental cap should become the deliberate one, or be
   lifted, belongs to whoever answers Q6.

   **CLOSED (2026-08-16): capped, and the accidental bound becomes the deliberate one.**
   The reservable range is `n ≤ 4.29 × 10¹³` (14 digits), which is the `shardId` layout's
   existing limit adopted as policy rather than discovered as a surprise — zero code
   change, and the `reservations` dictionary's state-size exposure is bounded by
   construction instead of by argument. The "lean unbounded" of the original text is
   withdrawn, and point 1a is why the reversal is comfortable rather than merely
   convenient: the objection to unbounded was that a far-future trophy number is a cheap
   option on the game surviving long enough to reach it, and the premium ladder now
   *prices* that option. The cap bounds what the ladder has to price, so the two answers
   stopped being in tension. 14 digits is far past anywhere the head reaches in any
   modelled run (`DECISIONS.md` D-11).

   **Still closed, on a different footing (2026-09-24).** The reasoning above leans on two
   things that are gone: `reserve(n)` and the `reservations` book (deleted by D-30), and the
   market shard whose `shardId` layout produced the bound (`primes_market_shard.tolk`,
   deleted by D-90). The cap itself survives unchanged as `AUCTIONABLE_MAX` =
   10,000 · 2³² − 1 in `primes_market.tolk`, now bounding what `open_lot` accepts, and it
   carries its own justification there: at `n < 2⁴⁶` Miller–Rabin's squared residue stays far
   inside TVM's 257-bit integers, and 37# is the largest primorial under it, which is §3.2's
   ω(n) ≤ 12 bound. Nothing is left open.

   **What the cap bounds today (2026-10-04), stated against the code rather than the
   history.** `AUCTIONABLE_MAX` is asserted on every market entry point that takes an `n`
   (`open_lot`, `open_head_lot`, a bid, `getLotLane`/`getLotPrice`), and the market caps the
   ledger's head hint to it. It is therefore the bound on (1) the `lots` map's key — `n` is a
   `uint64` inside the market (D-18); (2) Miller–Rabin's intermediate width, as above; (3)
   since `GAUNTLET.md` V34, the exactness of the market's and ledger's seven-base
   Miller–Rabin shortcut, which is deterministic only below ψ₇ ≈ 3.4·10¹⁴ and is safe because
   no market argument can exceed the cap; and (4) ω(n) ≤ 12 on `open_lot`'s factor list. It
   bounds nothing about storage — the `lots` map's cell bound is its rows (descending lots of
   the last week and ascending bids, since D-200 folded resting lots into a bit per number),
   not their key range (D-188, D-200) — and nothing on the head's own line, which
   mints sequentially with no such cap.
7. Bounty vault size and split across programs (puzzles / discoveries / eras /
   conjecture pots / quests) — Phase 1 output, with the constraint that the vault is
   fixed at genesis and pre-counted in `S`.

   **CLOSED 2026-08-19** (`DECISIONS.md` "§11 closures — 2026-08-19"): the vault size and
   `era_bounty_schedule` are sim outputs sized against the pre-counted-into-`S` constraint;
   the split of the remaining 70% is accepted as a Phase A design allocation, not promoted to
   a sim output. (The 30% that closure left unallocated was since spent on the quest track by
   D-39, and the vault fraction raised to 500% of the seeded LP by D-43 and to 780% by D-204,
   which also made the tracks whole-PRIMES amounts rather than fractions.)
8. **Claim eligibility: zero-balance, or something stronger?** "Holds none of this
   collection" is the only test TVM can run without an oracle (§4.6.1), and it is
   trivially satisfied by a fresh wallet. The spend gate (principle 6) is what actually
   defends the economics, so the eligibility check is arguably decoration — the question
   is whether to keep it at all, or whether dropping it in favour of *anyone may claim,
   the purse still releases on first mint* is simpler and equally safe. Leaning keep: it
   costs one lookup and it is the rule that makes the mechanic *legible* as onboarding
   rather than as a giveaway. The claim lock (§4.6) weakens the case for keeping it
   further — a locked gift is already restricted to one person, so the zero-balance test
   is doing nothing there and only binds on expired gifts in the open pool. If Q9's
   benchmark comes in expensive, *lock-only eligibility* is a third option: no balance
   index at all, restriction by preimage while locked, open to anyone after expiry.

   **CLOSED (2026-08-16): drop the check. Anyone may claim; the purse still releases on
   the recruit's own first mint.** Decided against the "leaning keep" written above, and
   the paragraph above is its own best argument for the reversal — the test is trivially
   satisfied by a fresh wallet, **the spend gate (principle 6) is what actually defends
   the economics**, and the claim lock already restricts a locked gift to one person, so
   the balance test only ever bound on expired gifts in the open pool. What tipped it is
   that "legible as onboarding rather than as a giveaway" is a copy problem, and it was
   being paid for in contract storage. The mechanic is made legible in §9.1's surfaces and
   in `FAQ.md` instead. Note this is *not* the lock-only third option: the lock still
   governs while it is live, but no eligibility predicate runs at claim time at all
   (`DECISIONS.md` D-13).

   **SUPERSEDED (2026-09-07, `DECISIONS.md` D-106, which supersedes D-13 by name):** the
   question is closed by deletion rather than by answer. Patron mode is gone, and with it
   the unclaimed state, the claim, the lock and the purse — so there is nothing to be
   eligible for and nothing to release. A §4.5 gift mint delivers the number to its
   beneficiary's own address inside the mint transaction, and the recruit edge is one
   boolean (the beneficiary's minter card's `fresh` flag, D-191) the mint already carries.
9. ~~**Should the collection index per-owner balances at all?**~~ **CLOSED (2026-08-16):
   no — the index is removed entirely.** Q9 existed only to serve Q8's check, and Q8 is
   closed by deleting the check, so the question is answered by removal rather than by the
   Phase 3 benchmark it was waiting on. The collection carries no per-owner balance index,
   which is what standard TEP-62 does and therefore one less place where this collection
   is non-standard. Real storage removed, plus one lookup on the claim path
   (`DECISIONS.md` D-13).
10. **Recruit rank rights: which ones are reversible?** The `k_max` uplift and the tribute
    multiplier are economic and must be immutable under Q1. Naming rights, reservation
    priority and the era dividend (both since deleted — `DECISIONS.md` D-37, D-36) were
    cosmetic-to-operational and could sit behind the
    timelock without weakening the pitch. Splitting the rank rights across the two
    regimes may be the cleanest resolution of Q1's immutable-vs-timelock tension: freeze
    everything that touches the split, leave the status layer editable.
    **Superseded by Q1's closure:** the hybrid took the principle but not the proposal —
    rank rights are immutable *in their entirety*, status layer included; the only
    timelocked surface anywhere is the DeDust venue address. Nothing rank-related is
    governable.
11. ~~**Whether patron mode ships at launch or after.**~~ **CLOSED (2026-08-16): patron
    mode ships live at launch.** The "probably right" of the original text — ship the
    contract surface, keep the mechanic dark — is withdrawn on its own stated cost: the
    growth loop would be absent from exactly the period that needs it most. The dark
    configuration also turned out to be worse than neutral in the code rather than merely
    cautious: `primes_ledger.tolk` declares the `patronOf` map and **reads it on every
    mint**, while nothing anywhere writes it, so an auditor reads a live economic path
    that provably never fires and the split leg resolves to the pool 100% of the time.
    Shipping the writer is what makes the surface honest. The B4 work attaches: the
    patron-mode mint path, `gifted_by`, purses, per-recruit `PATRON_CAP` counters, patron
    rank, and the `NEWCOMER_UPLIFT` window (`DECISIONS.md` D-1).

    **Shipped 2026-08-16 (EARN_PLAN E0/E1), with the inequality resolved as a split
    decision rather than a pass.** Phase 1 now derives `V` instead of asserting it and
    publishes the `(a, M, V)` surface (§4.6.2). The patron mint returns 0.387 GRAM against
    0.415 GRAM unranked — a **fail by 0.028** — and against 0.374 GRAM for an already-ranked
    patron — a **clear by 0.013**. The kill criterion is left reporting FAIL at the
    published cost basis rather than re-based to the flattering one, and §4.6's STATUS
    block carries both halves. The first patron mint anyone makes is the one on the wrong
    side of the line; that is the exposure this decision accepts, and the composer ships
    instrumented so mainnet falsifies it in weeks rather than arguments.

    **This promoted Q12 from deferred to blocking**, and Q12 has since returned and closed
    (2026-08-17, below): φ₁ = 0.25 from the pool, unchanged.

    **REOPENED AND ANSWERED BY DELETION (2026-09-07, `DECISIONS.md` D-106).** The exposure
    this decision explicitly accepted — "the first patron mint anyone makes is the one on
    the wrong side of the line" — was never taken, because the mechanic was never reachable:
    `webapp/src/chain/messages.ts` wrote `storeMaybeRef(null)` into every `Mint` body the
    app ever sent, so no wallet could submit a patron mint at all. The composer that was to
    ship instrumented and let mainnet falsify the inequality in weeks was not built either.
    So the decision's own falsification path never opened, and the kill criterion stayed at
    FAIL. D-106 exercises the severability this section already established rather than
    waiting on data that had no way to arrive.
12. ~~**Is 25% on the activation mint too deep a cut to the ratchet?**~~
    **MOOT since `DECISIONS.md` D-106**, which deleted patron mode and φ₁ with it
    (`shared/params.json` marks it MOOT). The closure below is kept as the record.
    **CLOSED (2026-08-17): no — φ₁ = 0.25 GRAM stays, and it stays funded from the pool
    injection.** The question asked whether β = 0.40 on an activation mint is too deep a
    cut, and the answer is no by roughly an order of magnitude. Phase 1 priced all three
    variants the question named, over five seeds and ~166,500 mints
    (`docs/phase1-determinations-report.md`):

    | variant | final floor (mean ± sd) | vs no-patron baseline | treasury (GRAM) |
    |---|---:|---:|---:|
    | dark — no patron line at all | 0.156861 ± 0.007870 | — | 9,523 |
    | **A — φ₁ 0.25 from the pool** *(adopted)* | 0.154750 ± 0.004033 | **−1.35%** | 9,736 |
    | B — φ₁ 0.10 from the pool, longer tail | 0.155983 ± 0.004244 | −0.56% | 9,736 |
    | C — φ₁ 0.25 from the treasury | 0.156807 ± 0.004385 | −0.03% | **3,087** |

    **The headline 25% is a per-mint figure and the floor is a mix-weighted one**, and
    conflating the two is the error the question's own framing invites. Activation mints
    are a minority of the mix even during the spike the question worries about, so a 25%
    cut on that slice costs 1.35% of the year-end floor. The whole best-to-worst spread is
    0.0021 against a per-variant sd of ~0.0043 — the three variants are **less than half a
    standard deviation apart**, which is the honest reading: the sim cannot distinguish
    them, and no player will perceive the difference either.

    **Option C's objection turns out to be price, not capacity.** The paragraph above
    predicted a structural recruitment cap — treasury is 5% of a mint, so it funds one
    0.25 GRAM bonus per five mints protocol-wide. **That cap never bound on any seed.** What
    kills C instead is that it costs **6,650 GRAM/yr — 68% of all treasury revenue** — to buy
    back a floor difference of 0.03%, indistinguishable from zero. D-19 adds a second
    objection the paragraph predates, and it is about timing rather than capacity:
    launch-month operator revenue is ≈0.30 GRAM in total, so in month one C would fund
    acquisition out of money the operator does not yet have.

    **Option B is dominated and is the worst of the three.** It pays exactly the cost this
    section names — a shallower bonus with a longer tail "re-creates the problem
    front-loading solved", so the recruiter collects after the recruit may already have
    churned — in exchange for a floor gain that is also inside the noise. B is the worse
    half of both alternatives.

    **What is being bought, stated plainly.** 1.35% of floor growth, which nobody can
    perceive, in exchange for a recruitment hook that pays the recruiter instantly on the
    recruit's first own mint and costs the operator nothing. **The protocol funds its own
    growth**, which is also the only variant that works in month one.

    **The caveat is recorded rather than buried.** Phase 1 priced the *cost* of φ₁ and
    cannot price the *benefit*: the elasticity of the activation rate with respect to φ₁
    does not exist before mainnet, exactly as the `newcomer_lever_sweep` note says of its
    own levers. A is therefore adopted as *the cheap option whose benefit is unmeasured*,
    not as a proven optimum, and §4.6.2's inequality remains the thing mainnet must
    falsify. See DECISIONS.md **D-23**.
13. ~~**Should the era trophy be transferable?**~~ **CLOSED (2026-08-16): transferable.**
    Decided against the "leaning soulbound" written above, and the counter-argument is
    **conceded rather than refuted** — a prize that money can buy is genuinely not a prize
    for recruiting, and that is the price being paid for a real market in the scarcest
    objects in the game and for the headline sale that comes with it.

    **The propagation this forces is not cosmetic.** §11's "Resolved in this draft" entry
    on *where the loyalty budget comes from* describes the era trophies as "permanent
    naming rights on the primorials themselves, **which no amount of GRAM can buy**". That
    sentence is now false and is corrected there. The loyalty-budget claim itself survives
    on the remaining rights — the rebate ceiling and naming rights, both still earned and
    unbuyable (the tribute multiplier, the `RES_PRIORITY_BASE` waiver and the era dividend
    were also listed here and are all now deleted — `DECISIONS.md` D-54, D-37, D-36) —
    but **every surface carrying the trophy version of the claim is out of date until it
    is rewritten**, §4.7 and the §9.1 copy included (`DECISIONS.md` D-14).

14. **What to do with the standing ratchet balance.** The floor guard (§4.3.1) turns the
    ratchet from a five-day queue into an accumulating reserve that may sit unspent for long
    stretches. Deploying it into liquid staking would raise `T` with no mint and no
    emission — **a floor that rises while nobody is playing**, which is a strictly better
    answer to idle-death than the one §8 currently gives. Against it: a liquid-staking
    token is a counterparty inside the backing, unstaking latency competes with flush
    liquidity, and any allocation call that is not fully rule-based and permissionless
    reintroduces exactly the discretionary surface §8 promises does not exist.

    **CLOSED (2026-08-17): not adopted.** Decided rather than deferred, and the reasoning
    is worth recording because the idle-yield argument will be made again by somebody
    reading the ratchet's balance. **Keeping a counterparty out of the backing, and keeping
    §8's no-discretionary-surface claim literally true, is worth more going into a public
    bug bounty than the yield would be.** A liquid-staking token inside the collateral is a
    second protocol whose failure is now this protocol's failure, and the sentence "there is
    no discretionary surface anywhere in this system" stops being checkable the moment an
    allocation exists that somebody has to size. The floor guard already gives the idle
    balance a job — it is a standing bid, and §4.3.1's whole point is that it is *supposed*
    to sit there until the market comes to it.

    **The pre-specified shape is kept on record for any future adoption**, so that a later
    proposal starts from these constraints rather than re-arguing them: it must be
    permissionless in exactly the sense `flush()` is; every amount must be computed by the
    contract, never named by a caller; it must hold a **target liquid reserve** so the flush
    is never competing with unstaking latency; and the yield must route to the **bounty
    vault** (§3.3), never to a protocol-run mint, which would put the contract in the
    business of choosing recipients (§4.6.1). A proposal missing any one of those four is
    not this question reopened, it is a different and worse question.

    **REOPENED AND ADOPTED — 2026-09-20 (`DECISIONS.md` D-151).** The closure above stands
    as the record of what was decided and why; it is amended here rather than deleted,
    because the argument it makes is the one a reader should weigh against what replaced it.
    The reopening is an owner decision, and it is adopted on the pre-specified shape — the
    four constraints were written to be a gate, and the design is what passes it:

    1. **Permissionless in exactly the sense `flush()` is.** `stake()`, `unstake()` and
       `harvest()` have no privileged caller and no schedule that depends on the operator
       being alive.
    2. **Every amount computed by the contract, never named by a caller.** This is the
       constraint that made the rest buildable: **not one of the three arms carries an
       amount.** `stake()` sends `pending − reserveTarget`, `unstake()` sends exactly enough
       to restore the reserve and is callable only when the reserve is short, `harvest()`
       sends `tstonHeld` less what `stakedCost` is worth at the rate we paid. A caller
       supplies gas and a query id.
    3. **A target liquid reserve, so the flush never competes with unstaking latency.**
       `staked_reserve.reserve_fraction_of_pending` = 0.20 of the whole obligation, sim-sized
       from a 1..14 reserve-day sweep, and in the base run covering the largest tranche any
       flush actually asked for 68.9× with zero unmet demand.
    4. **Yield routes away from any protocol-run mint.** Here the *destination* has moved
       and the constraint has not: 2026-08-17 named the **bounty vault** (§3.3), and D-151
       routes the harvest to the **LP-governed treasury** (§3.3, §5.5, D-100 point 7), which
       did not exist in its governed form when this was closed. The prohibition the
       constraint encodes — the contract must never be in the business of choosing
       recipients (§4.6.1) — is satisfied by both: the harvest names one address, fixed at
       genesis and published by `getHarvestDest()`, and what happens to the tsTON afterwards
       is an LP-depositor vote, not a contract's decision.

    **What was genuinely conceded, stated plainly.** The closure's own headline was that
    keeping a counterparty out of the backing was worth more than the yield. That trade is
    now taken the other way, and §8 carries the cost as a named, bounded, published exposure
    rather than as a reassurance: one counterparty, valued at cost, `realizedLoss` on
    `getStaking()`, and the slashing case written into §5 beside the theorem it qualifies.
    The half of the closure that was *not* conceded is the one the four constraints protect:
    no allocation that somebody has to size exists anywhere in the path, so "there is no
    discretionary surface anywhere in this system" is still literally true.

    The built mechanism is **§4.3.2**, and it is the specification; this entry is the record
    of the question.
15. ~~**Is `PRIME_UPLIFT` the right instrument, or should primes keep a floor rebate at
    `k_min`?**~~ **CLOSED — `PRIME_UPLIFT`, no `k_min` fallback.** See "Resolved in this
    draft" below.
16. ~~**Should prime rank and patron rank share a single `RES_PRIORITY` waiver and priority
    queue, or two?**~~ **CLOSED (2026-08-16): two queues.** Decided against §4.7.1's
    single-queue proposal. Prime rank and patron rank resolve separately, so the
    reservation book expresses *which kind of standing* it is rewarding instead of
    flattening both into one ordering — earning the line by minting primes and earning it
    by bringing players are different achievements and the book now says so.

    **AMENDED 2026-08-16 during the layout work: moot, not implemented — because there is
    no queue to split.** The question presupposed a priority queue. **None has ever
    existed.** Contention on a reservation is a hard reject (the first message wins, the
    second is refused), so there is no pending-claim set for rank to order and nothing for
    a tie-break to break. Two queues cannot be made from zero.

    §11.27's lane trigger independently removes the subject matter: every prime and every
    composite at `D(n) ≥ D_MIN` goes to the auction lane, where §4.4 already says a rank
    waiver **is worth nothing** because there is no `RES_PRIORITY_BASE` there to waive.
    What remains on the direct lane is by construction the numbers nobody competes for.

    **So `RES_PRIORITY_BASE` is a fee and only a fee**, waivable by rank, and §4.7/§4.7.1
    are corrected to stop promising an ordering. The owner's ordering preference is
    recorded unbuilt, in case a tie-break is ever introduced: **prime rank first, patron
    rank breaking ties within it.** No storage carries it (`DECISIONS.md` D-15, amended;
    layout in `docs/audit/unified-market-layout.md` §6).

    **Moot on every premise (2026-09-24).** `RES_PRIORITY_BASE` and the reservation book
    are deleted (D-30), the `D_MIN` lane trigger with them (D-30; every number ahead of the
    head is on the ascending lane since D-88 point 3), and patron rank is deleted (D-106).
    There is no fee to waive and no second rank to order, so nothing remains open.
17. ~~**Where do genesis clearings after the first route?**~~ **CLOSED — all clearings
    route to the ratchet as `pending`, with no first-clearing special case.** `T`/`S`
    never read the auction's clearing price at all — every clearing's premium leg credits
    `pending` at face value, the identical accounting path every mint uses (§6 point 3,
    D-7) — so this holds regardless of whether a DeDust pool exists (D-154's genesis pair is posted by hand, not
    by any contract; see §6 point 3's "the genesis pair is an operator commitment" paragraph
    for the separate question of market *depth*, as opposed to this question of clearing
    *accounting*). The protocol itself never one-sidedly tops up
    LP as a flush side-effect: that would deepen a pool at no cost and, unlike a `pending`
    credit, outside the floor guard. Whether a *third party* (including the operator) adds
    two-sided liquidity is unrelated and is exactly what D-46 opens up.
18. > **SUPERSEDED by `DECISIONS.md` D-168 (SIGNED 2026-09-23).**
    > §5.3 staking is now a PRIMES-paid supply lock funded by the treasury vest; the
    > purchasable uplift this question gated is deleted. The record below is kept as history.

    **Does the staking sink ship at all?** Gated on Phase 1's `x*` result under a stake
    uplift (§5.3, §8.1): if a maximally-staked wallet's ceiling drops below the band the
    flush can defend, staking is dropped. The burn sinks (§5.2) and the collateral track
    do not depend on the answer and are sequenced so they can ship without it. This is the
    single decision the sinks work exists to make, and the default in the absence of a
    result is **no**.

    **CONDITIONALLY ANSWERED (2026-08-16): yes — build it, and the sim still holds the
    kill switch.** The owner's intent is that staking ships; the gate above is *not*
    waived and is restated here as binding, because it is the one part of this question
    that was never an opinion. **If a maximally-staked wallet's `x*` drops below the band
    the flush can defend, staking is dropped** and only §5.2's two burn families ship.
    Phase 1 must publish the pessimistic floor trajectory **with maximum staking** beside
    the existing pessimistic rank-and-credit case, and the delta is part of the go/no-go.

    The cost of the yes is recorded rather than argued (`DECISIONS.md` D-10): a
    purchasable uplift sells the *rate* at which the floor climbs, taken from every holder
    who did not stake, and it lowers `x*` for exactly the wallets holding the most PRIMES.
    `k < 1` is untouched — the same single `K_CEIL` clamp bounds any number of uplifts —
    so no invariant breaks and the ratchet theorem stands. What is being spent is ratchet
    *rate* and the last remaining bound on §12's unpriced-liability line.

    §11.19–§11.22 are answered with it: the meter, not a rate; tiers immutable; staked
    PRIMES never netted out of circulating.
19. > **SUPERSEDED by D-168.** There is no uplift left to meter. The objection below — "a rate
    > is a yield, and a yield cannot be paid without unbuying `k < 1`" — was about paying the
    > yield in *emission*; D-168 pays it from PRIMES the vest already emitted, so `k` is not
    > touched and the objection has no object.

    **Entitlement meter vs. time-locked rate.** §5.3 proposed the meter: a stake buys
    `θ · Q` of extra emission and then lapses. A rate is simpler and is what every other
    staking product does — which is the argument against it, not for it. A rate is a yield,
    and a yield cannot be paid without unbuying `k < 1`. The meter is also the only version
    of this an auditor can check in one inequality. Leaning meter; the question is whether
    the UX cost of an expiring uplift is acceptable.
    **CLOSED (2026-08-16): the meter, and it is not negotiable.** The UX cost of an
    expiring uplift is accepted. A stake **comes back** at unlock while every other uplift
    is paid for with something non-recoverable, so without the meter `Q` PRIMES buys an
    unbounded stream of extra emission across unbounded mints and
    `buy → stake → mint → extra rebate → sell` is a money machine that dilutes `S` for
    everyone who did not stake. The invariant is `θ < 1`: extra emission purchased by a
    stake is strictly less than the capital locked to buy it — the same shape, the same
    reason and the same one-inequality auditability as
    `PRIME_UPLIFT · PRIME_WINDOW < k_max(n)` (§5.1). The lock is denominated in head
    progress, not seconds.
20. > **SUPERSEDED by D-168.** Nothing is purchasable in `k_max` any more.

    **Is a purchasable uplift compatible with Q1's immutability position?** Q10 splits rank
    rights into economic (immutable) and cosmetic (timelockable). A stake uplift is
    economic, therefore immutable, therefore the tiers can never be recalibrated after
    deploy — a heavier commitment than any existing uplift, because it is the one people
    paid cash for. If the tiers turn out mis-sized, the only available remedy is that the
    meter drains and nobody re-stakes.
    **CLOSED (2026-08-16): yes, and the commitment is accepted as written.** The tiers are
    immutable at deploy like every other economic right under Q1's hybrid, with no timelock
    reachable to them. This is the heaviest irreversible commitment in the system and the
    remedy named above is the *only* remedy — it is disclosed on the staking surface rather
    than discovered by a staker. `STAKE_TIERS`, `STAKE_UPLIFT`, `θ` and the lock length are
    Phase 1 outputs and **none may be hardcoded ahead of the sim**, which is precisely
    because they can never be corrected afterwards.
21. ~~**Do burn sinks compete with the bounty vault?**~~ **CLOSED (2026-08-16): two
    numbers, and both are now measured.** No conflict was found — both change circulating
    supply in holders' favour and neither moves `p_f` (§3.3, §5.2) — so the only live
    question was the display one, and it is answered the conservative way: the burn total
    (`getBurnStats` on the ratchet) and the vault payout total (`getVaultPayouts` on the
    vault) are separate rows with separate provenance, because netting them would hide
    which one is doing the work. Closing it required a contract change rather than a copy
    change: burning was previously a pass-through with no counter, so "how much has been
    burned" had no get-method and could only have been asserted. §3.3 carries the full
    read map.
22. **Does staked PRIMES count as circulating?** It is not burned and it can come back.
    Recommend showing it separately and **never netting it out of circulating** — the
    conservative direction, matching §5's treatment of `S` and §3.3's treatment of the
    vault. The dashboard shows three quantities where it used to show one: `S`,
    circulating, and staked. **Partially settled by the same change as Q21:** the supply
    block reserves the staked row and renders it as *not shipped in v1* rather than as
    zero, so if §11.18 lets staking ship, the row is already there and already outside
    circulating. The decision itself stays open until §11.18 does.
    **CLOSED (2026-08-16), with §11.18:** staked PRIMES is shown separately and is
    **never netted out of circulating**. It is not burned and it can come back, so the
    conservative direction is the one taken — matching §5's treatment of `S` and §3.3's
    treatment of the vault. The reserved supply-block row now renders live rather than as
    *not shipped in v1*, and the dashboard shows three quantities where it once showed
    one: `S`, circulating, and staked.

23. ~~**Does the flat dividend's `1/π(n)` decay want a response, or only disclosure?**~~
    **CLOSED — it wanted a correction, not a response. `f` stays at 0.2.** The question
    was posed on the decay of the per-prime *rate*, and that is the wrong denominator: the
    mint count grows over the same stretch, cumulative flat income sums `Σ 1/π(n)` and
    therefore diverges like `ln²(n)`, and at equal multiplicative age a *later* prime
    collects more, not less (§5.4's table). The line is progressive rather than dying —
    0.8% of prime 211's tribute income and 68.3% of a prime minted at 499,979 — which is
    precisely the role §3.2 assigns it. Raising `f` would solve a problem that does not
    exist and would take the money from the divisor line, which is the leg that makes the
    small primes worth buying at a premium; dropping `f` to zero would leave a prime near
    the head earning essentially nothing for the whole interval before its first multiple
    arrives, and would remove the one leg holding up §3.2's fairness argument. §5.4's
    qualifier has been rewritten to state the cumulative picture instead of the bare rate.
24. **Should constellations carry a non-reslicing reward?** The honest reading of §3.2.2
    is that constellations are a *collection* game with a tribute reslice attached, not a
    yield asset — the multiplier reweights a fixed 10% line and §5.4 is required to say so.
    If the late game wants them to carry value, the lever is the **discovery bounty**
    (bounty vault, `S`-neutral, §3.3), never the multiplier, which cannot be made to
    inflate without reopening the split. Named here so that it cannot be resolved silently
    inside a copy pass: any surface that describes constellations as appreciating is
    answering this question in the affirmative without it having been asked.

    **CLOSED (2026-08-17) in the negative: no reward beyond the discovery bounty.**
    Constellations are a **collection game with a tribute reslice**, and that is the whole
    of what they are. The multiplier reweights a fixed 10% line and cannot be made to
    inflate without reopening the split; the discovery bounty §3.2.2 already specifies is
    the only value that enters from outside, it is `S`-neutral, and it got *smaller* rather
    than larger once the sim sized it against the vault's allocation. Nothing further is
    added.

    **The prohibition is now test-enforced, which is why this can be closed rather than
    watched.** The webapp's constellation namespace is asserted, in every locale it
    ships (English alone while the app is in development), to contain no appreciation
    vocabulary and to state positively that the multiplier never
    adds to the line. A copy pass can no longer answer this question in the affirmative by
    accident; it can only do so by deleting a test, which is a visible act.

    **The consequence, stated explicitly because the old prohibition was broader than the
    closure is:** front-end surfaces **may** now describe constellations positively — as a
    collection mechanic, as a discovery race, as the metagame §3.2.2 claims. What they may
    not do is describe them as **appreciating**: no yield, no return, no "worth more over
    time", no implication that completing a set changes what anything is worth rather than
    how a fixed line is divided. "Collect" is allowed; "appreciate" is not.

    **AMENDED 2026-09-05 (`DECISIONS.md` D-102): the closure stands and its reasoning got
    stronger, not weaker.** D-102 replaced the predicate registry with the built number
    line and deleted the tribute multiplier outright, so the reslice this question was
    asked about no longer exists at all: a constellation does not appear in the tribute
    weighting of §3.2, and there is nothing to inflate even in principle. The answer is
    unchanged — **no reward beyond the discovery bounty**, still drawn from the vault,
    still `S`-neutral, and now conditional on the vault ceiling of D-39..D-42 rather than
    merely sized against it (§3.2.2, §12). The copy prohibition survives the deletion
    with one clause retired: the locale assertion is that constellation surfaces carry no
    appreciation vocabulary, and the positive statement it used to require — that the
    multiplier never adds to the line — is replaced by the fact that there is no
    multiplier. This question is **closed, not withdrawn**; nothing in this repo may cite
    it as open.

    **MOOT 2026-11-07 (`DECISIONS.md` D-202):** constellations and their discovery bounty are
    deleted, so there is nothing left for this question to reward. The closure stands as
    the record.
25. **Do the desirability weights want retuning now that they set a 128 GRAM opening bid
    rather than a 0.075 GRAM fee?** §4.4 point 1a's weights are the owner's taste and were
    chosen when the stakes were eight cents; point 1b maps the same score through
    `2^(D/SCORE_HALVING)`, so the widest achievable score now opens a lot at 446 GRAM.
    `POW10_W = 50` putting 1000 above 2023 is defensible at any magnitude; `RUN_W = 30 >
    PALI_W = 25` — 1234 opening above 1221 — is worth a second look at these. **The
    weights ship unchanged and no change is proposed**; this is recorded as open so that a
    retune is a decision rather than something that happens inside a copy pass, and so that
    whoever makes it knows what it now moves. Note what is and is not on the table: the
    weights are taste, `SCORE_HALVING` and `D_MIN` are declared, and the only simulation
    output anywhere in `P0` is `NPV(p)` on the prime branch.

    **DECIDED (2026-08-16): retune. "The weights ship unchanged" is withdrawn — but the
    retune is BLOCKED pending the numbers.** The stakes rose a third time and this one is
    qualitative rather than another order of magnitude: under the prime Dutch lane
    (§11.27) `desirabilityScore` sets the **opening price of every prime at the head**, on
    a lane that has no reserve and decays to 1 GRAM regardless of what the score said
    (D-88/D-99 later gave it a reserve: the lot now rests at `max(NPV/2, P0/3, MINT_PRICE)`,
    so the score lifts the resting price through the `P0/3` term). The
    weights therefore now decide whether primes undersell — which is the exact problem the
    Dutch lane was introduced to fix — so they have stopped being taste-with-consequences
    and become the mechanism's calibration. `RUN_W = 30 > PALI_W = 25`, putting 1234 above
    1221, is the specific line to look at first; `POW10_W = 50` putting 1000 above 2023 is
    still defensible at any magnitude.

    **RESOLVED IN PART (2026-08-17): the weights are promoted to a simulation output.** The
    fork the previous paragraph left open is taken in the sim's direction, and for the
    reason CLAUDE.md rule 3 gives: a number that decides whether primes undersell is an
    economic parameter, and economic parameters come from `sim/`, not from taste and not
    from this document. §4.4 point 1a's "the weights are the owner's" is withdrawn along
    with "the weights ship unchanged"; what stays the owner's is the **objective** the sim
    optimises against, because choosing what the ladder is *for* is a design decision and
    not a measurement.

    **The stated objective — SIGNED 2026-08-17 as `DECISIONS.md` D-21, exactly as
    drafted.** Sim runs against this objective are authoritative. The first such run
    landed the same day (`sim/scripts/run_determinations.py` →
    `shared/params.json` `determinations.q25_desirability_weights`,
    `docs/phase1-determinations-report.md`): its status is **BOUNDED** — the argmax moves
    across the bidder-model premise sweep, so no single vector is selected and the
    sweep's range is published instead; the shipped weights stay within it. What would
    make it decidable is realised clearing prices from a comparable market, or one month
    of this lane's own bids.

    **CLOSED 2026-09-04 (`DECISIONS.md` D-99) — and the promotion to a sim output is
    WITHDRAWN, which is the opposite of where the paragraphs above were heading.** The whole
    question dissolves with the score it was asked about: `desirabilityScore`, `RUN_W`,
    `PALI_W`, `POW10_W` and the four layers are deleted, and 33 weighted categories replace
    them (§9.6; 54 since bits 33..53 were appended). The fork D-21 took — "a number that decides whether primes undersell is an
    economic parameter, and economic parameters come from `sim/`" — is answered by observing
    that the sim never resolved it: run `determinations.q25_desirability_weights` came back
    **BOUNDED**, the argmax moving across the bidder-model premise sweep, so no vector was
    ever selected. It could not be, because the thing being fitted is **a guess at demand for
    an object with no realised market**, and no amount of simulation produces one. D-99 puts
    the weights back where the owner signs them, and states the standing explicitly: they are
    owner-declared with an `_provenance` string in `shared/params.json`, exactly as D-96's two
    constants and the tier prices before them. **CLAUDE.md rule 3 is not relaxed** — what the
    sim owns here is unchanged and named in §9.6: `NPV(p)`, `SCORE_HALVING` and the `FRAC`
    table, the bid-increment ladder, and the two rebate rates. What the owner owns is which
    numbers people want.

    > **Primary objective: maximise expected premium captured to the ratchet across the
    > whole auction lane** — the sum, over a modelled bidder-arrival process, of
    > `clearing price − MINT_PRICE − RES_GAS` on ascending lots plus the same quantity on
    > prime lots, per unit of head progress.
    >
    > **Subject to three constraints, each of which kills a weight vector outright:**
    >
    > 1. **Lane participation.** The fraction of opened lots that receive at least one bid
    >    (ascending) or sell above the floor (descending) must not fall below a stated
    >    threshold. A weight vector that maximises premium by pricing a handful of lots
    >    enormously and leaving the rest to decay to 1 GRAM fails, because unsold primes
    >    forfeit tribute to the treasury (§4.1) and that cost is not in the objective.
    > 2. **Head velocity is not reduced.** No weight vector may lower modelled mints per
    >    day relative to the flat-fee baseline. The ladder prices earliness; if it prices
    >    it so highly that players wait instead, it has traded the thing every leg in §5.4
    >    is paid out of for a one-off premium.
    > 3. **Monotonicity in perceived rarity is preserved.** The published ordering of the
    >    predicate classes may not invert — a repdigit outranks a palindrome outranks a
    >    run, and so on — because the ladder's stated job (point 1a) is to be legible, and
    >    a vector that fits a bidder model while ranking 1234 above 1111 has optimised
    >    against the reader.
    >
    > **Why premium capture is primary and the other two are constraints, rather than the
    > reverse:** participation and velocity are *floors* — they say what must not break —
    > while premium is the quantity the mechanism exists to produce and the only one whose
    > maximum is meaningful. Making participation primary would be maximised by a ladder
    > that opens everything at `RESERVE_FLOOR`, which is the flat fee this point replaced.

    ~~Until the run becomes decidable, the weights **ship unchanged by default** and both
    lanes' opening prices inherit whatever they currently produce (`DECISIONS.md` D-12);
    the objective is no longer the blocker — realised market data is.~~

    ~~**CLOSED (2026-08-27) by `DECISIONS.md` D-66/D-67**~~ — **WITHDRAWN by D-99's
    2026-09-04 closure above, which dissolves D-66 and D-67; kept as the record of what it
    decided.** It read: the "realised market data" the sim
    named as the thing that would decide this is obtainable, and is now being obtained.
    The 2026-08-17 run's `BOUNDED` status rested on a premise that turned out to be wrong:
    that a comparable market's realised clearing prices did not exist pre-launch. They do —
    Fragment's anonymous-number and username sales are exactly the "comparable market" the
    sim's own `_status` note asked for, they are public, and §9.7b makes that population a
    named audience rather than an analogy. Three things follow, and each is a separate
    decision record:

    - **The comps become a checked-in sim input, not a rationale in prose** (D-67). A
      provenanced dataset in `sim/` that the objective fits against keeps CLAUDE.md rule 3
      intact: the sim still emits the weights. Citing comps in this document while
      hand-picking the constants would replace "the owner's taste" with "the owner's taste,
      sourced," which is not the same thing as a measurement.
    - **The score gains a fifth `DIGIT` layer** (D-66, §4.4 point 1a). Retuning the existing
      four layers against comp data fits the wrong model to the right data: digit
      composition is the single largest driver in the realised prices and no existing layer
      can express it. This reopens the constant block in `primes_market.tolk`, not just its
      values.
    - **The infeasible incumbent is not held hostage to any of that** (D-64's session
      re-affirms D-12's recommendation (a)). `RUN_W = 30 > PALI_W = 25` is *proven* to
      invert constraint 3 above, so the deployed vector fails the owner's own signed
      objective outright. Adopting a feasible point is a separate, smaller, immediate
      change and must not wait on the comp dataset or the `DIGIT` layer.

    ~~What remains genuinely open is only *which* feasible point, and that is now a question
    with a data source attached rather than an indefinite wait. Tracked as GAUNTLET.md
    Track N.~~ Nothing remains open: D-99 replaced the score and its weights are
    owner-declared (§9.6).
26. **Prime pre-funding displacement: how many primes are bought ahead of the head.**
    *(Re-scoped 2026-09-24 by the owner; the figure is published; **closed 2026-09-24**,
    see the end of this entry.)* Under `DECISIONS.md` D-88 point 3 every number ahead of the head — prime
    included — can be bought on the ascending lane by opening a lot at `P0(n)`, and D-90
    mints it in the close. So a prime has two routes: **ahead of the head** at `P0(p)` or
    more, or **at its turn** on the descending lot that opens at the same `P0(p)` and
    decays to `max(NPV(p)/2, P0(p)/3, MINT_PRICE)`. The question is **what fraction of primes take
    the first route, and how far the `P0` level moves that fraction.** It was
    **launch-blocking** until the owner's verdict: it is the number the pre-turn prime lane
    is accepted against, and a hostile reader will ask for it.

    **The figure (sim output, `BOUNDED`).** `shared/params.json`
    `determinations.q26_auction_lane.prime_prefunding_displacement`, from the lane-aware
    buyer model `sim/primes_sim/market.py` `prime_prefunding_displacement`, over the
    17,959 primes in the head range `[100, 200,000)` (≈2 years of head travel):

    | buyer interest per prime (ASSUMED, swept) | shipped `P0` | `P0` × 2 | `P0` × 5 |
    |---|---|---|---|
    | 0.005 / day | 51% | 49% | 39% |
    | 0.02 / day  | 68% | 63% | 60% |
    | 0.10 / day  | 88% | 70% | 66% |
    | **0.30 / day (the lane model's baseline)** | **96%** | 81% | 67% |

    A buyer opens early only when the risk of a rival taking the descending lot at its
    opening price outweighs the carry of paying before the prime earns anything (a prime
    earns no tribute until the head passes it). Both simplifications in the model push the
    share **up**; the valuation, dispersion and discount rate are the ones the lane and
    NPV models already use. The `_source` string names every assumption. **Almost all of
    the displacement is in floor- or ladder-priced primes** — only 203 of the 17,959 have
    `1.5 · NPV(p)` as their binding `P0` branch, and those displace 2–52%.

    **What is no longer asked here.**
    - **Clearing-price distribution by score band** — delivered,
      `determinations.q26_auction_lane.clearing_price_distribution`.
    - **Head-collision probability** — retired by D-45: opening a lot takes the number off
      the sequential line, so the head can never reach it.
    - **Simultaneously-open-lot volume and post-win queue depth** — delivered in
      `acquisition.open_lot_volume_and_queue_depth`; D-90 deleted the post-win queue.
    - **Unsold-prime forfeit** — delivered, `q26_auction_lane.unsold_prime_forfeit`
      (§12's revenue-risk entry).
    - **Realised clearing prices** — **post-launch telemetry, not launch-blocking.** They
      can only come from real lots. No modelled clearing figure may be shown publicly
      until they exist (§9.1).

    **CLOSED 2026-09-24 by the owner: accepted as stated.** The figure is **96%** of primes
    bought ahead of the head at the 0.30/day baseline interest, and **67%** at `P0` × 5
    (`determinations.q26_auction_lane.prime_prefunding_displacement`). Two caveats travel
    with it wherever it is quoted: it is an **upper bound** — the model ignores rival bids
    on the ascending lot and buyers who wait for the descending price to fall — and the
    buyer interest rate is **ASSUMED** and swept, not measured. Early sale is the design,
    not a leak: D-88/D-90 auction every number ahead of the head from `P0`, which is never
    below the descending lot's resting price, so the descending lot at a prime's turn is a
    fallback, not the main route. No mechanic change follows. §12 carries the accepted
    risk.

27. **The auction consolidation and the prime Dutch lane** (decided 2026-08-16;
    `DECISIONS.md` D-3 through D-8, then amended by D-20). Recorded here rather than
    silently in §4.4 because it supersedes two entries in the "Resolved in this draft" list
    below and adds a mechanic the earlier drafts did not contain.

    > **Read points 1–6 as the decision session recorded them, then point 10, which
    > overrides parts of 1, 2 and 6.** `DECISIONS.md` D-20 (2026-08-16, signed after this
    > entry was written) deleted the genesis lot, retired the lookahead and made one Dutch
    > format universal. Points 1–6 are kept in their original voice because the reasoning
    > in them is still the reasoning; point 10 says which clauses no longer hold.

    **The problem.** Three separate systems answered "who gets which number" —
    `primes_auction.tolk` (genesis: 90-day descending Buy Now over ascending bids),
    `primes_trophy_auction.tolk` (ascending, hard close) and the reservation book with its
    shard (direct reserve, full-price escrow) — together **3,269 of 9,030 lines of Tolk,
    36% of all contract code in the repo**, for one question asked three ways.

    1. **One mechanism, Fragment-style.** A lot's opening price is derived from the rarity
       score; **the first bid starts a 7-day clock**; the lot closes to the high bidder.
       This is the format the TON audience already knows from Telegram number and username
       auctions, which is worth more here than novelty would be. Genesis lots, trophy
       numbers and rare reservations all clear through it.

    2. **Primes at the head clear by descending (Dutch) auction, opening on rarity and
       decaying to exactly 1 GRAM over one week.** A flat 1 GRAM undersells a prime — the
       asset carries a perpetual tribute claim, immediate naming rights and prime rank, and
       the flat price captures none of it. Anyone may buy at the standing price at any
       point on the slope.

       **This is a liveness result, not only a pricing one, and it is the strongest thing
       the decision buys.** §11.15's closure removed the `k = k_min` fallback and with it
       the contract's ability to absorb a head parked on an unprofitable prime; §12 records
       the consequence as "the floor is safer under this design and the liveness is not",
       carried operationally rather than structurally. **Guaranteeing that the price reaches
       the ordinary mint price within a week puts the guarantee back in the contract**: the
       head can never park permanently, because within seven days every prime is available
       at the price every composite costs. §5.1 and §12 must both be rewritten to say so.

       The clock **starts when the head is `H` numbers behind the prime**, not when the head
       arrives. Near n = 1000 roughly one number in seven is prime, so a decay week at the
       head would advance the line ~7 numbers and then freeze it for up to 7 days,
       repeatedly — and mint flow is what every leg in §5.4 is paid out of. With the
       lookahead the price has already decayed, or the lot has already sold, by the time the
       head reaches it. **The head never waits.** `H` is a Phase 1 output (§11.26).

    3. **Lane trigger unchanged: every prime at any score, plus composites at
       `D(n) ≥ D_MIN`; primorials in neither lane** (§7). Ordinary composites ahead of the
       head stay cheap to reserve directly. This is the rule §12's prime pre-funding
       displacement risk is accepted against, and it is what makes §11.25's weights
       load-bearing.

    4. **The close extends on late bids.** A bid inside the final `N` minutes pushes the
       close out by `N`. This **supersedes** the hard close asserted below, on two grounds:
       it is what Fragment does and therefore what bidders expect, and it raises clearing
       prices, which under point 5 flows entirely to the floor. `N` is declared, not
       simulated.

    5. **All premium above the nominal 1 GRAM goes 100% to the ratchet as `pending`, with no
       treasury cut** — for every lane, genesis and Dutch included. The nominal 1 GRAM runs
       through §4.1's ordinary five-way split (six-way when written). Three properties follow and are the acceptance
       criteria: **the split stays closed at 100%**, because the premium is never in the
       split; **the ratchet arithmetic is unchanged and strictly favourable**, because a
       premium is a `T` increment against *zero* emission, making a 40 GRAM prime a larger
       floor step than 39 patient composite mints; and **principle 6 is not violated**,
       because splitting the full clearing price would pay a referrer 4 GRAM on one recruit's
       single mint — a windfall unrelated to that recruit's own spend.
       **Amended by `DECISIONS.md` D-114 (2026-09-10): the premium now splits 50/50 between
       the ratchet and the governed treasury (`PREMIUM_TREASURY_BPS` = 5000); the split
       still stays closed and the premium still emits nothing.**

    6. **Genesis folds in, keeping its guaranteed clearing.** §6's format existed because of
       the fallback: an unsold genesis prime is *never minted at all*, while a trophy lot
       always has the head arriving behind it, so genesis needed a guaranteed clearing and
       only the trophy lane could afford a hard close. The property is preserved inside the
       single mechanism rather than by a second one — **the genesis lot's opening price
       descends until somebody bids, and the first bid starts the 7-day ascending clock**.
       The decay *is* the pre-bid state. Retained unchanged from §6: forfeit-not-escrow; an
       unsold genesis prime's tribute falls to the pool permanently and visibly; minting
       opens concurrent with the auctions; the genesis ratio is declared at deploy (D-46
       later removed the LP deposit-and-burn this point originally described; D-154's
       hand-posted, sink-locked pair replaced it — see §6 point 3); and every clearing credits the ratchet as `pending`
       with no special case (§11.17). **Superseded:** the fixed 90-day linear slope from
       `P0` to `P0/100` with the opening bid at `P0/10` — the slope and its endpoints are
       now inputs to the unified mechanism and are re-derived by the sim. `P0 ≈ 1.5×` the
       valuation-contest anchor survives as the anchoring rule (§11.2).

    **What this does not touch**, stated the way §5.1 states it: the split, `T`, `S`, the
    `K_CEIL` clamp, the floor guard, and the absence of an admin withdraw path. No auction
    lane emits PRIMES, so none of them appears in the ratchet theorem at all.

    ---

    **Determined during implementation, 2026-08-16** (`primes_market.tolk`,
    `primes_market_shard.tolk`). Three properties the six points above did not fix, resolved
    while building and recorded here rather than left in the code:

    7. **A standing lot never blocks the direct mint.** When the head reaches `n`, the
       number is mintable at 1 GRAM through the ledger whether or not a lot is open on it.
       *(Superseded by `DECISIONS.md` D-45: `open_lot` marks `n` off the sequential line, so
       the head never reaches an auctioned number and skips it forever; D-90 mints it in the
       close.)*

       **This is the same bargain the ascending lane already struck.** §4.4 point 1b sells
       *the right to buy early*, not the number: every lot is bypassable by waiting, and
       that bypass is both §2's fairness claim and the ceiling on every price any lane can
       fetch. The alternative — blocking the mint while a lot stands — is a gate on the
       head, which §12 forbids at any price.

       **Amended by point 10.** The "head voids an unbought Dutch lot" clause this point
       originally carried, and the `H`-undersizing cost that came with it, are both gone:
       the head never reaches a prime, so there is no void path and no lookahead to
       undersize. `voidLot` is deleted from the contract rather than left dormant. What
       survives is the economic point underneath it: the descending lane earns only where a
       buyer values earliness above the standing price, so most of its revenue comes from
       the top of the slope and a prime bought at the floor pays the ratchet nothing at all.

    8. **On the prime Dutch lane the decayed price is the *number's* price; `RES_GAS` is
       charged on top.** The lane's terminus is the resting price the seller is entitled to,
       so unlike every other lane it cannot absorb the `RES_GAS` that funds the won lot's own
       settlement — `RESERVE_FLOOR` = 1.05 GRAM is what made that absorption possible
       elsewhere. A purchase at the terminus is therefore **`restingPrice(p) + RES_GAS`
       all-in**, against 1.00 for waiting at a composite's head position. *(As recorded
       2026-08-16 this read "the floor is exactly 1 GRAM … 1.04 GRAM all-in"; `DECISIONS.md`
       D-88 point 1 made the terminus per-`n` and D-30/D-33, D-90 and D-113 moved `RES_GAS` to
       0.070, so the shape of the point survives and both its numbers do not.)*

    9. **`launch_open`'s fan-out collapses from three messages to one.** §6 point 0's ignite
       opens three contracts because there were three; under point 1 there is one, so
       `launch_open_trophy` and `launch_open_auction` retire with their receivers and the
       market accepts `launch_open_book` alone. The permissionless `sync_launch` retry is
       unchanged, and the handler is idempotent so a repeat is a no-op rather than a throw.

    ---

    **10. `DECISIONS.md` D-20 (signed 2026-08-16) overrides points 1, 2, 6 and 7 above.**
    Recorded as an override rather than by editing them, because the reasoning in those
    points is still the reasoning and only their conclusions moved. Four changes:

    - **There is no genesis lot and no genesis-specific format.** The pre-deployed K-lot
      `{2,3,5,7,11,13}`, its bootstrap, its `P0/100` reserve, its ascending bid phase and
      `bootstrap_genesis` itself are all deleted. Point 6's "genesis folds in, keeping its
      guaranteed clearing" is superseded: the guarantee is now supplied by the universal
      floor rather than by a pre-bid descent that turns into a clock.
      `MODE_DUTCH_CLOCK` is removed from the contract and its numeric value retired rather
      than reassigned.
    - **Every prime, from 2 onward, uses one uniform `MODE_DUTCH_BUYNOW` lane with a
      universal `MINT_PRICE` floor.** Point 2's "primes *at the head*" framing is
      superseded twice over: primes are never at the head (the head is defined over
      composites and Unity), and the floor is one derived constant rather than a per-prime
      reserve. A prime opens the moment it is next among unbuilt numbers, decays to 1 GRAM,
      and rests there indefinitely. *(D-88 point 1 and D-99 §1.2 later replaced the 1-GRAM
      rest with `restingPrice(p) = max(NPV(p)/2, P0(p)/3, MINT_PRICE)`, §6 point 1.)*
    - **`lookaheadH` (D-4a) is retired, not re-derived.** It existed so the head would not
      stall on a prime it could not skip; primes are not in the head's path at all, so
      there is nothing to look ahead of. The field is deleted from `MarketConfig` and the
      parameter is removed from §11.26's list.
    - **Unsold-prime tribute forfeits to the treasury** (§4.1, §6 point 2) rather than to
      the pool as the K-lot did. This is the one carve-out from "an unresolvable split line
      falls to the pool, never to the team", it was signed knowingly after the first answer
      (route it to Unity's holder) was flagged back as contradicting §6 point 0, and it is
      disclosed in §2 principle 4, §3.1, §4.1 and §6 point 2 rather than left to be found.

28. ~~**Can a prime be opened as an *ascending* lot far above the head, and if it is, what
    settles it?**~~ **CLOSED (2026-08-17): `open_lot` refuses primes** — `DECISIONS.md`
    D-22, signed option 1, implemented in `primes_market.tolk` (the ascending lane is the
    composite lane; `kind = 1` is refused with its own error and a test pins both the
    refusal and the unreachability of the stranded state).

    The contradiction this closed: D-20 says every prime uses the identical
    `MODE_DUTCH_BUYNOW` mechanism, while D-6's lane rule, read literally, put every prime
    on the ascending lane at any score. A prime won ascending would have closed into a
    reservation record on a shard that settles when the head reaches `n` — and under D-20
    the head never reaches a prime, so the reserver's 1 GRAM would have sat cancellable but
    never settleable. D-22 removes the state rather than adding a second settlement path.

    **The accepted cost, stated so it is not rediscovered as a bug (historical — see
    below):** at the time this was written, a prime more than `MIN_AUCTION_DISTANCE` above
    the head was not purchasable at all until the head came within range. `MIN_AUCTION_DISTANCE`
    is deleted (D-45, §4.4's box), and — separately — every prime has its own dedicated
    descending Dutch lane, openable before its turn regardless of distance (§4.4 point 2,
    §9.6): a prime's purchasability was never actually gated by this constant post-D-22, so
    this paragraph's premise predates that lane existing in its current form. Retained for
    the historical reasoning about why primes were pulled off the ascending lane, not as a
    current purchasability rule.

**Resolved in this draft** (previously open):

- *How are contested numbers priced?* → **§4.4 point 1b's trophy-auction lane: an
  ascending, hard-close auction on the right to buy.** Primes at any score and composites
  at `D(n) ≥ D_MIN` leave the reservation book entirely and are sold by auction, opening at
  `P0(n) = max(ladder, 1.5 · NPV(p), PRIME_P0_MIN, RESERVE_FLOOR)` (`PRIME_P0_MIN` and
  `RESERVE_FLOOR` are since renamed and deleted: the live expression is
  `max(LOT_FLOOR, ladder(D), 1.5 · NPV(p))` — D-30, D-99); the winner still pays a
  normal 1 GRAM mint through §4.1 at settlement and the premium goes 100% to the ratchet at
  the close, with no treasury cut (amended by `DECISIONS.md` D-114: 50/50 ratchet/treasury). The two sub-questions this closes are worth naming
  separately. **The format is not §6's**, and the reason is the fallback: a genesis prime
  that never clears is never minted, while a trophy lot always has the head arriving behind
  it — so genesis needs a guaranteed clearing and the trophy lane can afford a hard close
  (§6). And **`NPV(p)` past 13 is extended analytically by the simulation**
  (`tribute.prime_tribute_npv`) and shipped as a dictionary over primes up to a stated
  bound, with the pattern ladder as the fallback beyond it, rather than as an on-chain
  closed form. The six engine NPVs (`trophy_auction.npv_calibration`) are its regression: the
  extension must reproduce `p ∈ {2,3,5,7,11,13}` before it is trusted for 17. No cheap
  extrapolation was available — NPV/√p runs 583, 312, 167, 116, 73, 62 over those six, so
  "scale by √p" is not a function.

  **Superseded in part, 2026-08-16/17 by §11.27 and by `DECISIONS.md` D-20.** Four things
  in the entry above did not survive:

  - **The separate genesis format is gone, and then the genesis lot itself is gone.**
    §11.27 point 6 folded genesis into the one mechanism; D-20 then deleted the genesis lot
    outright (§11.27 point 10). The fallback argument the entry rests on — "a genesis prime
    that never clears is never minted" — no longer describes anything: **every** prime rests
    at a floor it cannot fall below and stays listed there forever, so no prime can fail to
    clear, and there is nothing for a special format to guarantee. (That floor was 1 GRAM
    when this was written; since `DECISIONS.md` D-88 point 1 it is
    `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` (D-99 §1.2). The argument is unaffected — what matters is that the
    lane terminates and the lot never expires, not where it terminates.)
  - **The hard close is gone** — the close extends on late bids (§11.27 point 4), so the
    early-close branch and its head-collision probability must be re-derived (§11.26).
  - **"An ascending auction" is no longer the answer for primes.** Ascending applies to
    scoring composites; every prime clears on a descending buy-now lot (§4.4 point 1b lane
    A). §11.28 (closed, D-22) removed the one case where the two lanes still overlapped:
    `open_lot` now refuses primes outright. **Amended by D-88 point 3:** ascending is the
    route to *any* number ahead of the head, prime included; the descending lane is what a
    prime gets at its turn.
  - **`RESERVE_FLOOR` is no longer a branch of `P0` for the prime lane's *floor*** — the
    floor is `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` (D-88 point 1, D-99 §1.2), stored and write-once from `n`.
    `RESERVE_FLOOR` remains a branch of the opening price.

  What survives untouched, and is now the rule for **every** lane: the lane trigger and the
  buyer still paying a normal 1 GRAM mint through §4.1. **The premium going 100% to the
  ratchet with no treasury cut (§11.27 point 5) does not survive untouched: `DECISIONS.md`
  D-114 (2026-09-10) amended D-7 to a 50/50 ratchet/governed-treasury split** — see §4.4
  point 1b and §5's acquisition-premium passage for the current rule. The `NPV(p)` extension
  and its six-entry
  regression are unaffected — they price the opening price, and the opening price survives
  every format change. (The six engine NPVs it regresses against are published as
  `trophy_auction.npv_calibration.by_prime` in `shared/params.json`; the old
  `genesis.auction_reference_prices` key is gone.)

- *Does the late-game thesis appear in the pitch, or stay a disclosure?* → **In the pitch.**
  §1 now carries the two-halves paragraph and §5.4 carries the table it is read off. The
  conservative alternative was to add §5.4 and leave §1 alone; it was rejected on the
  grounds that a value story appearing only in the anti-abuse section and the risk register
  is not a position, it is a hedge. The constraint that comes with the promotion is §9's
  vocabulary rule — no adjective in §1 that §5.4's table does not back.
- *Is "the numbers are the cash-flow half" compatible with §5.1's prime/composite
  symmetry?* → **Yes, and only because of the referral key.** §3.2 is careful that neither
  asset dominates; a late-game section emphasising tribute alone would read as "primes
  win". The key is the composite's `n`-invariant leg — flat 10%, no `n` term (§3.1, §4.1) —
  and §5.4 gives it equal weight for exactly that reason. Both halves of the line rotate.
- *Prime compensation instrument (§11.15)* → **`PRIME_UPLIFT`. The `k = k_min` fallback is
  not carried.** Primes emit nothing (`k = 0`) and are paid entirely in rights: the
  perpetual tribute claim, immediate naming, +1 prime rank, and the `PRIME_UPLIFT` credit
  on the minter's next `PRIME_WINDOW` composite mints (§5.1). Three consequences follow.
  §4.2.1's arithmetic holds at full strength — a prime injects β = 0.65 against zero
  emission, moving the floor as much as ≈11.8 patient composite mints, and it is the one
  ratchet contribution a minter cannot dilute by waiting. `PRIME_UPLIFT` and
  `PRIME_WINDOW` become load-bearing parameters rather than proposals, sized in Phase 1
  against §5.1's headroom table, with `PRIME_UPLIFT · PRIME_WINDOW < k_max(n)` promoted to
  a contract-level invariant with a test — it is what guarantees the credit is always
  worth strictly less than the rebate withheld, and therefore that prime mints stay
  net-accretive to the floor at every point on the line. And because the fallback is gone,
  **the liveness risk loses its escape hatch and moves from design to operations**: the
  mitigations named in §5.1 and §9.4 have to carry it, and a stall at a prime head is now
  watched and responded to rather than absorbed by the contract. §12's honest statement
  stands unchanged — the floor is safer under this design and the liveness is not.
- *Push vs. pull tribute* → pull, credit-at-mint / settle-on-claim (§3.2.1).
- *Tribute recipients* → prime factors only; divisor-based variant rejected on fan-out
  (§3.2).
- *Tribute concentration* → the 10% splits 80/20 into a divisor line weighted `e·√p`
  (√p submitted by the minter, verified in two multiplies) and a flat per-prime dividend
  accrued O(1) per mint. Moves primes above 200 from 25% to 58% of the line at n = 10⁵.
  Full `p` weighting rejected: it buys the tail under 6% more against the structural
  ceiling `0.10·N/p` while cutting the small primes 82% (§3.2).
- *Lifetime cap on a prime's tribute* → rejected; the uncapped perpetual claim is the
  whole of §5.1's compensation, so capping it reopens the sequential-stall risk (§3.2).
- *Tribute share* → 10%, down from 20% (§4.1).
- *Referral mechanism* → NFT-number keys only, no address referrals; owner-of-NFT paid
  at mint time; unset/invalid → pool; no default/owner key (§3.1, §4.1).
- *Referral interaction* → 10% to key owner, taken from the pool injection, never from
  tribute; self-referral assumed universal from the second mint (§4.1, §8).
- *Composite value proposition* → referral income + rebate + rarity; tribute stays
  prime-only (§3.1, §3.2).
- *Gas model* → all-in 1 GRAM, protocol pays all deploys (§3.1, §4.1).
- *k_max normalization* → anchored at n₀ = 1000; k_max(n) = 2.7/log₁₀(n), clamped
  ≥ k_min (§5).
- *Burn accounting* → `S` is cumulative emission plus the genesis bounty vault, never
  decremented; `p_f` deliberately understates backing (§3.3, §5).
- *Buy-and-burn vs. one-sided protocol LP add* → buy-and-burn, batched via the public
  `flush()` schedule (§4.3). Per-mint swapping was rejected on dust economics; the
  protocol itself topping up LP one-sidedly on every flush was rejected because burned LP
  makes the 0.2% LP fee share on protocol buys accrue to reserves nobody can ever claim,
  which permanently deepens the pool at no cost — that argument is about the *protocol*
  adding LP as a flush side-effect, and is unaffected by D-46's separate change: DeDust
  liquidity add is inherently two-sided (pairs GRAM+PRIMES) and is something *anyone*,
  including the operator, may do with their own capital, never the protocol acting on
  `pending`/`swapped`.
- *Injection timing* → credit at mint, swap on flush; `T` counts committed GRAM
  (`seeded + swapped + pending`), incremented at mint (§4.3, §5). D-46: `seeded = 0` in
  this deployment (no real founder seed), so `T` is effectively `swapped + pending` here.
- *Vanity demand vs. sequential purity* → **one** ascending auction lane ahead of the head,
  open to every number (§4.4, `DECISIONS.md` D-30, D-88 point 3). ~~The winner's escrow waits
  for the head and settles at k_min~~ — **escrow deleted by `DECISIONS.md` D-90**: the number
  mints in the transaction that closes the lot, and the head skips it forever (D-45). The flat-fee reservation lane this line used to describe
  was deleted on 2026-08-19.
- *Constellation rewards* → the discovery bounty and the NFT, and nothing else. **Amended
  2026-09-05 (`DECISIONS.md` D-102):** this line used to read "tiered: one-time discovery
  bounty + ongoing tribute multiplier that reweights within the fixed 10% line; lazy
  permissionless challenge". The multiplier and the challenge are deleted with the
  predicate registry; the bounty survived, accrued and conditional on the vault ceiling,
  until `DECISIONS.md` D-202 deleted constellations and the bounty with them.
- *Bounty funding* → single genesis vault, contract-held, pre-counted in `S` (§3.3).
- *Should the operator hold a PRIMES allocation?* → **No, at genesis or ever, under any
  name** — not a bounty-vault tranche, not an ops reserve denominated in PRIMES, not
  retained LP (`DECISIONS.md` D-19). §2 principle 4 stays absolute. The operator is funded
  by GRAM fee lines only: the secondary royalty (§3.1, its ratchet share carved out by D-128)
  and — since D-20 — unsold-prime forfeited tribute, of which D-166 gives them
  **42%** (D-100 point 6's 20%, raised) and the governed treasury the rest (§4.1, §5.5). **§4.1's 5% line is no longer on
  this list: D-152 points it at the governed treasury contract; nor is the gas-&-ops sweep
  surplus: D-117 returns it to the ratchet pool.** The operator's only per-mint income is
  therefore the forfeit remainder — up to 0.0336 GRAM on a mint whose every cited factor is
  unsold, zero whenever every factor has an owner. Recorded here because the question will recur in other clothing.
  The consequence D-19 states and does not reopen: the treasury takes **no cut of auction
  premium** (§11.27 point 5), so launch-month operator revenue is approximately zero and
  the promotion budget must be external capital.
- *Distribution* → full measured-virality stack: Mini App, deep-link grammar on NFT
  keys, counted-arrival story quests, signed-voucher claims, seeded reach plan (§9).
- *Recruitment mechanic* → **the §4.5 gift mint** (`DECISIONS.md` D-106). A mint names a
  beneficiary; the number and the rebate go there, the payer keeps their referral
  commission, and a beneficiary the ledger has never seen credits the payer one recruit.
  Random-recipient selection stays rejected on the three grounds §4.6.1 records — TVM
  cannot do it without an oracle, pushed NFTs are drainer spam, and push removes the
  payer's incentive to target well — and *pull-claiming from an unclaimed pool*, which was
  the answer to that for a year, is rejected too: it needed a lifecycle (claim, lock,
  purse, reclaim, expiry) to deliver a number the mint could simply have delivered.
- *Recruitment reward trigger* → the gift mint itself, on a fresh address. Repeat gifts to
  the same wallet, drops, claims and wallet counts pay nothing (principle 6, §4.6).
- *What recruiting pays* → **a `k_max` tier and no GRAM.** The earlier answer was an
  annuity: 25% of the recruit's activation mint, 7.5% thereafter, terminating at
  `PATRON_CAP` = 1.00 GRAM, front-loaded and refund-capped. D-106 deletes it — a fixed
  nominal cap against a cost basis that rises with `k_max(n)`'s decay inverts at n ≈ 1173
  (D-57), and every fix spent something real. A tier has no cost basis to drift against.
- *What the recruit gets beyond the number* → a raised rebate ceiling for five mints
  (`NEWCOMER_UPLIFT`, clamped with rank at `K_CEIL`), and the §3.1 referral discount from
  mint one. Both act on the activation rate — whether a gifted wallet ever mints one of its
  own — which is the loop's binding constraint (§4.6). **Amended 2026-09-07
  (`DECISIONS.md` D-106):** the list opened with "a purse released on their first mint" and
  cited §4.6.2 for the constraint; the purse is gone with the unclaimed state, and §4.6.2
  was the patron mint's kill criterion and is deleted with the mechanic it priced.
- *Where the loyalty budget comes from* → rights, not PRIMES. `k < 1` is load-bearing,
  so emission cannot be used as a growth lever; rank pays in a higher rebate ceiling
  (clamped at `K_CEIL = 0.95`), naming rights, and the eight era trophies — permanent
  naming rights on the primorials themselves (§4.7, §5).
  **Amended 2026-08-19:** the `RES_PRIORITY_BASE` fee waiver and the era dividend used to
  appear in this list and are both deleted (`DECISIONS.md` D-37, D-36) — the first was
  never implemented and its fee no longer exists under D-30; the second is dropped
  outright. **Amended 2026-08-28:** the tribute multiplier also used to appear here and is
  deleted the same way (`DECISIONS.md` D-54) — no code path wires rank into the ledger's
  tribute pass. **Amended 2026-08-16 by §11.13's closure:** the trophies are now
  *transferable*, so the clause that used to end this sentence — "which no amount of GRAM
  can buy" — is withdrawn. The load-bearing half of the claim survives untouched: the
  budget is paid in rights rather than in emission, because `k < 1` forbids the
  alternative. The remaining rights are still earned and unbuyable. The trophies are not.
- ~~*Provenance as an incentive* → `gifted_by` written permanently into every claimed
  number, making the recruitment graph public and renderable at zero cost.~~ **DELETED
  with the claim it was written at (`DECISIONS.md` D-106)**, and the §9.1 map that would
  have rendered it went too (`DECISIONS.md` D-187).
- ~~*Patron downside on an unclaimed number* → permissionless expiry-reclaim after one
  primorial era, purse included.~~ **NOT REACHABLE (D-106):** a gifted number is owned by
  its recipient from block one, so there is no downside to bound.
- *Do prime mints earn a rebate?* → **No. `k = 0`, always.** Primes emit nothing, the
  tribute line has no recipient and falls to the pool, so a prime mint injects β = 0.65
  against zero emission and ratchets the floor ~12× harder than a patient composite mint
  (§4.1, §4.2.1, §5.1). The prime minter is paid in the §4.7 currency instead — the asset's
  perpetual tribute claim, immediate naming rights, prime rank (§4.7.1), and a bounded
  `k_max` credit on their next composite mints, structurally constrained to be worth less
  than the rebate withheld. The liveness risk this creates — a sequential head parking on
  an unprofitable prime — is the mechanic's kill criterion and a named Phase 1 output. It
  is carried **operationally, not by a fallback**: §11.15 is closed in favour of
  `PRIME_UPLIFT`, and no `k = k_min` escape hatch exists in the contract.
  **Amended 2026-08-16 by §11.27 point 2, and again by `DECISIONS.md` D-20: the liveness
  risk is not mitigated, it is gone.** No `k = k_min` fallback was reinstated — `k = 0` on
  primes is untouched and remains absolute. First the *price* moved: a prime opens on
  rarity and **decays to a floor it cannot fall below** — read as "exactly 1 GRAM" when this
  was written, and as `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` since `DECISIONS.md` D-88
  point 1 and D-99 §1.2 — so
  no prime is ever priced out of reach of a patient buyer. Then D-20
  removed the mechanism entirely — **the head is defined over composites and Unity only, so
  there is no prime head to park on**. What is left is not a liveness risk but a revenue
  one: an unbought prime forfeits its tribute to the treasury for as long as it sits
  (§4.1), which costs the eventual owner and pays the operator, and costs the game's
  liveness nothing. §5.1 and §12 both carry the correction; the sentence "the floor is
  safer under this design and the liveness is not" is withdrawn.
- *What is "the bank"?* → **There isn't one, and the word is retired** (§3.4). It was an
  undefined noun doing four jobs. The components are the **splitter**, the **ledger**
  (holds tribute `owed`) and the **ratchet** (holds `pending`, runs `flush()`) — **two**
  distinct pools of GRAM with two different owners, previously fused and therefore
  unreconcilable against any single balance. (There was a third, the market's escrow, until
  `DECISIONS.md` D-90 deleted it along with `primes_market_shard.tolk`; no contract in the
  system now holds refundable customer money at all.) "Bank" is rejected because it claims
  custody-and-return, which is the one thing the protocol never does; "vault" was already
  spent twice (DeDust's, and the bounty vault's).
- *When does the protocol buy PRIMES?* → **Only at or below its own floor.** The flush's
  slippage limit is set to `amount·S/T`, so a flush that would buy above `p_f` bounces and
  the GRAM stays on the ratchet as backing (§4.3.1). This makes protocol buying countercyclical,
  caps the flush-MEV attack at the floor (above `p_f` a pump makes the flush bounce; below it
  a sandwich can cost burn efficiency but never backing — D-190), and converts the
  ratchet from a five-day queue into standing floor defense. Costs: a larger honeypot,
  slower
  burning in strong markets, and a large standing balance — which since D-151 is no longer
  idle: §11.14 is reopened and adopted, and §4.3.2 stakes everything above a liquid reserve
  at cost, with one named counterparty.
- *The premium regime* → disclosed rather than discovered: `x* ≈ (1−c)/(k_max(n)·β)` is
  a market-price ceiling created by the rebate valve — above it, mint-and-dump is
  profitable and runs until the premium compresses. Embraced as the upper half of the
  band ("the mint is the market maker"); it remains a **hard** ceiling, not a carry
  trade — §5's progress-vested rebates (`VEST_NOW`/`VEST_H`) that would have softened it
  never shipped and are struck (`DECISIONS.md` D-55), so §8.1's analysis is corrected to
  describe the mitigations that actually exist (`k(t)`'s reset-on-mint curve, the
  harvester's own mint raising `p_f` under it) rather than an unbuilt risk premium.
  Separately, the era dividend is dropped outright rather than capped (`DECISIONS.md`
  D-36 — `ERA_DIV_CAP` was never built and is no longer needed), and every §8 bound is
  repriced at `x*` in Phase 1 (§8.1).
- *Genesis auction format* → **there is no genesis auction. Superseded twice: 2026-08-16 by
  §11.27 point 6 (genesis folds into the single mechanism), then by `DECISIONS.md` D-20,
  which deleted the genesis lot altogether** (§11.27 point 10, §6). The current answer, in
  full: every prime from 2 onward opens as a per-prime descending buy-now lot at
  `P0(p) = max(1.5 · NPV(p), ladder(D), LOT_FLOOR)` (~~`PRIME_P0_MIN`~~ — deleted by D-99),
  decays on one shared
  slope `PRIME_DUTCH_SECONDS` to **that prime's own resting price**, and rests there forever
  until bought. No K, no set, no pre-deployed lots, no bid lane, no reserve, no expiry, and
  no `bootstrap_genesis` message on the market at all. `ignite` mints Unity and opens the
  market; 2 and 3 open immediately because nothing composite precedes them; **4 is the
  first number anyone can build.**

  Two clauses of the retired design changed rather than vanished, and both matter: the
  **floor** is not `P0/100` — since `DECISIONS.md` D-88 point 1 it is
  `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` (~~lifted to the tier's `price_min` for a special
  prime~~ — D-99 deletes the tiers and the `P0(p) / 3` term does that job), so
  the opening-to-resting spread is exactly 3× on either term; it is **stored but write-once from `n`**,
  which is all that survives of the deleted invariant MKT-1 — and **forfeited tribute now
  routes to the treasury**, not to
  the pool (§4.1, §6 point 2, D-20 point 4). Everything else in the paragraph below marked
  "retained" remains in force. The original entry, for the record:
  **ascending bids under a descending Buy Now ceiling**, on a
  fixed 90-day linear slope from `P0` to `P0/100`, with the opening bid at `P0/10` and no
  expiry: a lot rests on the floor until somebody takes it. Three ratios and one slope
  replace the old "start price, decay half-life, reserve" triple, so Phase 1 sets exactly
  one number per lot. The earlier open-ended Dutch decay from deliberately indefensible
  start prices toward contest-anchored reserves is **superseded** — under a fixed slope a
  start price is no longer free, because it *is* the schedule, and `P0 ≈ 1.5×` the contest
  anchor is what puts the expected clearing near one month. Retained unchanged:
  **forfeit-not-escrow**, an unsold genesis prime's tribute falls to the pool,
  permanently and visibly. Accrual-to-item ("the unsold prime accumulates value")
  rejected — it subsidizes waiting, guarantees a crossover where the protocol pays the
  buyer out of the players' own tribute, and piles the bootstrap's tribute line onto
  operator-adjacent inventory (§6). Minting opens concurrent with the auctions; the
  genesis ratio is declared at deploy; the LP was **founder-seeded at deploy and burned**
  at the time this entry was written (D-46 later replaced this with a disclosed operator
  allocation and no deploy-time deposit — see §6 point 3),
  and **every** clearing — first and last alike — is credited to the ratchet as `pending`,
  a pure floor step with no special case (§11.17, closed). The earlier "first clearing
  seeds the LP, later ones step the floor" rule is **superseded**: it existed only while
  the pool waited on a sale to exist.

29. **Does the GIF tier get advertised in the metadata, and to which numbers?** §9.8's tier
    2b, the animated GIF, is served at `/nft/<n>.gif` for every number, but no metadata
    document named it, and its only slot is `content_url` + `content_type` — the one a
    prime's tier-3 mp4 occupies. **CLOSED 2026-09-24 (`DECISIONS.md` D-174): composites
    only** — a composite's `content_url` is its GIF with `content_type: image/gif`; a prime
    keeps its mp4 there; Unity advertises neither (§9.8).
30. **Should "reads as a calendar date" be its own desirability layer?** *(Numbered 29 until
    2026-09-24, when D-174 closed a different question under that number.)* `desirabilityScore`
    (§4.4 point 1a) currently has exactly four layers — SCARCITY (digit count), PATTERN
    (repdigit / power-of-ten / trailing zeros / palindrome / ascending-or-descending run,
    combined by `max`, not summed), CALENDAR (`YEAR_W` if the *entire number* falls in
    `[YEAR_LO, YEAR_HI] = [1900, 2100]`) and MATH (hardcoded 0, primality is priced
    elsewhere). None of these decomposes a longer integer into sub-fields, so an 8-digit
    number that reads as a birthdate in `YYYYMMDD` form is invisible to every layer except
    SCARCITY. Concretely: **19930909** (1993-09-09) scores `s=3, p=0, c=0` — the
    `CALENDAR` layer never fires because `19930909 ≫ 2100` — for a total score of 3 and an
    opening price of `1 GRAM · 2^(3/10) ≈ 1.231 GRAM`, priced entirely off "one digit shorter
    than 9," with nothing about the number's date-shape entering at all. This was found by
    inspecting a live auction lot, not proposed speculatively.

    **What a `DATE` layer would need to decide, none of which is settled here:**
    which orderings count (`YYYYMMDD` only, or also `DDMMYYYY`/`MMDDYYYY` — the same eight
    digits can validate as more than one of these, e.g. a number that is a valid date under
    two different field orders); which year window counts as a plausible birth year (the
    existing `YEAR_LO`/`YEAR_HI` = 1900–2100 is one candidate reuse, or a narrower
    "plausible living person" band); whether a 6-digit `YYMMDD`/`DDMMYY` short form
    (common on real-world ID documents) is in scope alongside the 8-digit form; and,
    per N2's precedent for the sibling `DIGIT` layer (`GAUNTLET.md`), whether this is a
    **new summed layer** (so it stacks with PATTERN rather than being swallowed by
    PATTERN's `max`) or folds into the existing CALENDAR layer as a second sub-case
    alongside the bare-year check.

    **Recorded as open, not decided, and no weight is proposed.** Per §11.25's precedent
    (the desirability weights stopped being taste once they set the auction-lane opening
    price and became an economic parameter under CLAUDE.md rule 3): any weight for a
    `DATE` layer must come from a sim run against a signed objective, the same path N2's
    `DIGIT` layer is already queued behind, not from a number picked here. Tracked for
    build sequencing as `GAUNTLET.md` N6.

    **CLOSED 2026-09-04 (`DECISIONS.md` D-99): yes, and it is a group of five, not a layer.**
    The **LIFE** group prices a date in every representable form — `YYYYMMDD` 30 points,
    `DDMMYYYY` / `MMDDYYYY` 25, a bare year in `[1900, 2100]` 25, `YYMMDD` 12, `MMDD` / `DDMM`
    5 — against **real Gregorian validity**, month 1–12 and day 1–days-in-month with the
    4/100/400 leap rule, because a birthday that never happened must not be priced as one.
    Each of the four open sub-questions is answered rather than deferred: **all** the
    orderings count and they **sum**, because at most one 8-digit form can match a given `n`
    (a `YYYYMMDD` in 1900–2100 read as `DDMMYYYY` has a month of 19, 20 or 21, which is
    invalid, and the converse fails the same way), so the only stack inside the group is a
    4-digit `n` that is both a year and a valid `MMDD`; the year window is the existing
    `[YEAR_LO, YEAR_HI] = [1900, 2100]` in every form; the 6-digit `YYMMDD` short form **is**
    in scope; and it is a **summed group**, not a sub-case of a `max`. The worked example
    that opened this question settles it: **19930909** scored 3 for a 1.23 GRAM opening bid,
    and now scores 32 (LEN 2 + `YYYYMMDD` 30) for **9.19 GRAM** — the gift-grade band the
    owner asked for. The weight comes from a signed owner decision rather than a sim run;
    §11.25's closure above is where that reversal is argued.

## 12. Honest risk register

- **Participation stalls** → floor holds but nothing grows; game dies quietly. Accepted:
  this is the honest failure mode, and it harms no one who understood the docs.
- **The late-game thesis depends on mint flow continuing.** §5.4's rotation is
  a statement about how each mint's value divides, and every leg on the asset side —
  divisor tribute, the flat dividend, the referral key — is paid out of a mint. So the
  rotation re-describes where value sits in a protocol that is still moving; it does not
  rescue one whose head has stalled, and a reader who takes it as insurance against the
  bullet above has read it wrong. This is the same failure mode, not a second one, and
  §5.4 is required to say so in its own voice rather than leave the correction to this
  register. The narrower version of the same caveat: the rotation is denominated at the
  floor, and at §8.1's ceiling the asset share is `n`-invariant, so the rotation is what
  the protocol pays and not what the market pays.
- **AMM price can trade below floor trajectory temporarily** — floor is a protocol
  ratio + a *conditional* buy schedule, not an instant redemption price. Must be
  communicated plainly. The floor guard (§4.3.1) makes this materially better than it was:
  a price under the floor is the one condition that unlocks the entire accumulated
  balance as buy pressure. It does not make it a guarantee — the balance is finite, sell pressure is not,
  and a large enough exit clears the bid.
- **Collateral listing amplifies the one failure mode above.** A monotone,
  contract-verifiable, oracle-free floor is unusually legible to a lending venue, and
  §9.1's get-methods make PRIMES easy to underwrite — which is a distribution win and a
  risk in the same sentence. Leveraged holders liquidating into the pool is precisely the
  scenario in which the ratchet's finite bid is asked to absorb correlated, unbounded sell
  pressure, arriving all at once and for reasons that have nothing to do with the game.
  Lending does not create that failure mode; it concentrates it in time. It is also
  **partially self-correcting**: liquidations below the floor are exactly the condition
  that unlocks the ratchet's accumulated balance (§4.3.1), so the protocol is a buyer in
  the same event that produces the sellers — and it is a buyer with a finite balance, so
  the honest statement is that lending shortens the fuse on a bid the register already
  describes as clearable. Mitigations: the risk note for lenders states the non-claims
  explicitly (the floor is not redeemable, the bid is conditional and finite, `S` never
  decrements, and the ceiling `x*` is public — a lender should price the *band*, not the
  floor alone), and §2's constraint holds absolutely: no listing that requires the team to
  hold, supply, seed or market-make PRIMES. Team takes fees, never supply.
- ~~**The head can park on a prime.**~~ **RETIRED 2026-08-17 — the mechanism no longer
  exists, and this entry is kept in the register rather than deleted because it was the
  highest-severity risk in three prior drafts and a reader who remembers it deserves to be
  told where it went.** `DECISIONS.md` D-20 defines the sequential head over **composites
  and Unity only**; a prime is never a position on the line, so there is nothing for the
  head to park on. The old chain of reasoning — `k = 0` on primes removes the `k(t)`
  stall-breaker (§5.1), minting is strictly sequential, therefore an unattractive prime
  stops the game outright — fails at its second premise. What used to be a *total stop* is
  now not a stop at all: the head walks past the prime, the prime's lot decays to its
  resting price `max(NPV(p)/2, P0(p)/3, MINT_PRICE)` and rests there, and the game continues at full speed whether anybody buys it or not.

  Three earlier answers to this entry are withdrawn along with it, and none of them should
  be re-argued: the `k = k_min` fallback (§11.15, closed and still closed — `k = 0` on
  primes is absolute), the `PRIME_W` reservation surcharge (§4.4 point 1a, still 0), and
  the D-4a lookahead `H` (retired outright, §11.27 point 10). The Phase 1 prime-head wait
  distribution is withdrawn as a deliverable and replaced by the prime-lot time-to-sale
  distribution (§10).

  **What is left is a revenue risk of the same shape, and it is the entry below.**

- **An unpopular prime bleeds tribute to the treasury for as long as nobody buys it, and
  nothing bounds how long that is.** This is the successor to the parked-head entry, and it
  is genuinely open. While prime `p` sits unsold, every composite mint citing `p` pays
  `p`'s tribute share to the treasury rather than to a holder (§4.1, §6 point 2, D-20 point
  4). The lot never expires, so the interval is unbounded: a prime that nobody ever wants
  forfeits forever. Three honest observations, none of them a fix:

  - **It is not a solvency or supply problem.** `S`, `T`, `pending` and `owed` are all
    untouched, the split stays closed at 100%, and the ratchet theorem is not involved.
  - **It is an alignment problem, and it points the wrong way.** The operator earns more
    the longer primes go unsold, which is the one place in this design where the operator's
    revenue rises when the game is doing worse. Nothing in the contract lets the operator
    *cause* it — lots are permissionless, prices are derived, and there is no lever to pull
    — so it is an incentive that cannot be acted on rather than one that is defended
    against. That distinction is worth stating precisely, because "the operator profits
    when primes don't sell" is true and will be quoted.
  - **The measurement exists before the risk is accepted.** `getForfeited(p)` is a
    per-prime monotonic counter and `isPrimeUnsold(p)` says whether it is still running, so
    the total is public and per-number rather than aggregated into a treasury balance
    nobody can decompose. §9.1 requires the prime lot page to show both.

  The alternatives were routing the forfeit to the ratchet pool (the old K-lot rule, which
  has none of this exposure) and accruing it on the unsold item (rejected in §6 on
  Ponzi-shape grounds). The owner chose treasury knowingly. **If this entry is ever the one
  that draws blood, the fix is a one-line destination change with no other consequence** —
  which is worth recording here, because it means the exposure is reversible and the
  reversal costs nothing structural.
- **An invite is a text transfer sent by a contract, and Telegram decides whether anyone is
  told.** Measured on mainnet (owner's probes, 2026-11-07 and 2026-11-22, `DECISIONS.md` D-215):
  a contract-sent comment shows as text in Telegram Wallet, but a **push notification**
  arrives only when the amount received is **at least 0.1 GRAM** and the comment passes
  Telegram's spam filter — the launch dedication was silent at 0.1, 0.15 and 0.2, with or
  without the link, and `Hi from @primes_live_bot` alone pushed from a contract. Whether those
  words still push with the ledger's ` primes.live/?ref=<n>_tg` after them is unmeasured
  (`DECISIONS.md` D-215 point 4). Neither rule is published by Telegram,
  both may change without notice, and repeat sends to one wallet were not reliable. What the
  design does about it: the ledger pays each transfer's fee on top so the full value lands,
  and the operator can change the words, the count and the value on chain (`set_invite_terms`)
  inside a fixed 0.31 GRAM cap, so a channel that stops pushing can be traded for another
  shape without a redeploy. **If invites stop reaching anyone, the fix is the count** —
  `count = 0` costs nothing structural, because every unspent slot is β.
- **Invites are unsolicited, and some recipients will call them spam — accepted, not
  solved** (`DECISIONS.md` D-202, §4.6.1). What bounds it: the comment is fixed in the
  ledger's code apart from the minter's `n`, names `primes.live` and asks for nothing, so the
  game's address can never carry scam text a minter wrote; the default list names an address
  at most once; and the transfer is real GRAM, not an item to hide. What is not bounded: a
  wallet vendor or a public label set may class the ledger's address as a spammer, which
  would hide the comments, and nothing in this repo can prevent that. `getInviteSpend()`
  publishes the spend, and `?ref=<n>_tg` attribution counts the invitees who arrive.
- **A minter who names their own wallets gets 0.30 GRAM back.** The owner accepts it
  (D-202): the mint costs them 0.70 GRAM net, the 0.30 comes out of β, and the floor books it
  exactly as an honest invited mint — the sim's three-year run sends all three slots on every
  mint and still ends at 428.9× the deploy floor (`final_state.floor_appreciation`). §8.1's
  mint-and-sell loop gets harder, not easier: with self-referral at n = 10,000 it pays from
  3.56× the floor, up from 3.14×, because the smaller injection shrinks the rebate with it.
- **A fake recruit costs 0.70 GRAM, not a full 1 GRAM** (D-202 amends D-106). A gift mint to a
  fresh address may name the gifter's own wallets as its three invitees, so a §4.7 recruit
  tier costs a fresh address plus 0.70 GRAM net. It still pays no GRAM: what a recruit buys is
  `k_max` uplift under the single `K_CEIL` clamp, so the most a farm of fake recruits can
  reach is the clamp itself, which every rebate in the game already respects.
- **Pricing a prime above 1 GRAM is safe because the head does not wait on primes — and
  the ambiguous reading is the catastrophic one, which is why it is written down.**
  π(10⁶) = 78,498. If a prime could only be obtained by winning an auction with a reserve,
  or by an ascending price with no ceiling, then every prime nobody bid on would be
  permanently unobtainable and the collection would be full of holes — and under the *old*
  head semantics, where the head passed through primes, it would have ended the game
  outright about 1,500 years short of a million.

  **This entry rested on two properties and now rests on one** (`DECISIONS.md` D-88 point 1,
  signed 2026-08-31). The deleted property was invariant MKT-1, "the descending price
  reaches exactly `MINT_PRICE` and stops": a prime's lane now terminates at that prime's own
  resting price, `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` (~~lifted to its tier's `price_min`
  if it is special~~ — D-99), and for a small prime that figure sits well above 1 GRAM. MKT-1's rationale here
  was *liveness* — "the head can never park permanently on a prime nobody will pay a premium
  for" — and D-20 had already made that argument vestigial by defining the head over
  composites and Unity only. It was safe to delete because the property doing the actual
  work is, and always was, the second one:

  1. **The head does not depend on it.** Primes are off the sequential line (D-20), so a
     mispriced, overpriced or long-unsold prime delays nothing and blocks nobody. This is
     now the *whole* of the safety argument, and **if it is ever removed this entry becomes
     live again**.
  2. **The lane still terminates, and the terminus is not settable.** A descending price
     that stops is not a gate; an ascending or non-terminating one is. What survives of
     MKT-1 is that the stopping point is **write-once from `n` alone** — computed by
     contract code at the single moment the lot record is created, carried by no message
     field and mutated by no handler, so it cannot be *set* to anything, only computed.
     The lot then rests there until bought, with no expiry.

  **What this costs, stated rather than buried.** A small prime is no longer obtainable for
  1 GRAM by anyone patient enough; patience now buys it at `NPV(p) / 2` instead of at
  `1.5 · NPV(p)`, a 3× discount rather than an unconditional 1 GRAM. That is a real narrowing
  of §1's bypass promise for primes and it is disclosed there, not only here. What it is
  *not* is a gate: no number the head must reach is priced above 1 GRAM.

  Any proposal to put primes back on the head's path, to make a resting price settable by a
  message or an operator, or to remove termination altogether, re-creates the failure this
  entry describes and must be read against it before it is read against anything else.

  **Special numbers no longer carry an exception here, because there is no longer a rule to
  except them from.** D-88 point 2 deleted the special-only lanes: a special prime is an
  ordinary descending lot whose resting price is `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)`
  (~~its tier's `price_min`~~ — D-99 deletes the tiers), and a memorable
  composite is an ordinary composite — it mints sequentially at 1 GRAM when the head reaches
  it, exactly like every other composite, and its score prices only what an *early*
  buyer pays on the ascending lane. **D-99 makes that last clause true of every composite
  without exception**, by deleting the head-advance walk's curated-composite skip — the one
  place a composite could still be taken off the 1 GRAM line (`MISTAKES.md`, 2026-09-04). D-64's vault purchase and re-listing went with that
  deletion. **Composites still have no priced terminus at all**, which is the clause to
  check if this is ever revisited: a composite *is* the head, so a composite that could only
  be obtained above 1 GRAM would re-create this entry's catastrophic reading in its purest
  form — one unsold trophy composite and the sequence stops permanently.

- **Most primes are bought before their turn, so the descending lot is a fallback —
  accepted 2026-09-24 against a published figure (§11.26).** Under D-88/D-90 every prime
  ahead of the head can be bought on the ascending lane from `P0(p)`, which is never below
  its descending lot's resting price. The sim puts the share bought early at **96%** at the
  0.30/day baseline buyer interest and **67%** with `P0` raised fivefold
  (`shared/params.json` `determinations.q26_auction_lane.prime_prefunding_displacement`).
  That is an **upper bound** — the model ignores rival bids on the ascending lot and buyers
  who wait for the descending price to fall — and the interest rate is **ASSUMED** and
  swept (51–96% at shipped `P0`), not measured. The owner accepted it: early sale is the
  intended route, and the descending lot exists so an unwanted prime still clears. It costs
  no liveness — the head never waits on a prime (the entry above) — only the "patience buys
  a prime at `NPV(p)/2`" path, which most primes will not reach.

- **A comp-driven market invites wash trading — disclosed, not detected (filed 2026-08-27,
  §9.7b; disclosure built 2026-08-30, GAUNTLET.md N4).** §8's anti-abuse is built against
  many small fake actors farming referrals. The characteristic abuse of a market that
  prices by comparison — which is what §9.7b's audience brings — is the opposite shape:
  **one large real actor bidding up their own lot to print a public clearing price**, then
  selling the neighbouring number against that comp. The money is real, the bid is real,
  the transaction is on-chain and indistinguishable from genuine demand; only the intent
  differs, and intent is not checkable from chain state. Anti-snipe extension does not
  touch it, and no mechanism was ever going to: the ratchet is *helped* rather than harmed
  by a wash bid (the premium is really injected, `p_f` really rises), so the harm lands on
  the next buyer's information rather than on solvency. That made it a **disclosure**
  problem rather than a mechanism problem, and the disclosure is now built: `/lot/:n`'s
  closed-lot summary and a wallet's own claim list both show a winning bid's bid count and
  distinct-bidder count beside it (`backend/read-index`'s `/lots/:n`, sourced from
  `backend/event-poller`'s per-bid history — the contract's own `getLot(n)` has no bid
  history at all). A single wallet can still print a number by bidding against itself; it
  can no longer do so without the "1 wallet" label sitting next to the price.

- **Head collision on the ascending lane — ELIMINATED, D-45 (2026-08-20).** This entry
  described a live risk before D-45: if the head reached `n` while a lot was still open,
  §4.4 point 1b closed the lot early and the standing high bidder won at their own bid,
  reachable if head velocity ran ~7× the sim baseline against the then-live
  `MIN_AUCTION_DISTANCE = 20,000` gate. D-45 removes the collision structurally rather than
  by margin: `open_lot` now marks a composite off the ledger's sequential line the moment a
  lot opens on it, permanently, so the head cannot reach `n` while any lot on it is open, at
  any velocity — there is no early-close branch left to test or to rot. Retained as the
  record of a risk that was real and is now closed, not as a current mitigation list.

- **The descending
  prime lane cannot collide with the head at all** (D-20), so this entry is the ascending
  lane's alone.
- **Gas cost of primality** could make prime acquisition expensive at large n; mitigated by
  a benchmark-first plan, by the fact that most mints are composites (cheap verification),
  and by the fact that the check runs at lot-open time and never again — a purchase does
  not re-run Miller–Rabin.
- **The all-in 1 GRAM could go gas-insolvent — measured, and now sized from the measurement.**
  The benchmark this entry called for runs on every gate (`GasRegression.spec.ts`, against
  `contracts/gas-baseline.json`, reconciled by `sim/primes_sim/gas.py`). Since `DECISIONS.md`
  D-117 the gas & ops line is not a guess checked against a benchmark but *derived* from it:
  the largest measured `gas_ops_spend.*` row (the ledger's own surplus drop across one mint's
  whole trace, seeded with every leg firing at once), rounded up to the owner-set 5% step —
  `shared/params.json` `fees.gas_ops_line` carries the row, the spend, the headroom and the
  rule. A heavier mint path is therefore a red gate and a re-derived line, never a silent
  subsidy, and what an ordinary mint leaves unspent goes back to the pool through
  `sweep_ops`. Off-head purchases do not draw on the line at all: a lot's buyer pays
  `RES_GAS` on top of the price, the market forwards its `SETTLE_GAS` slice to the ledger
  with the close, and the harness asserts that slice against what the ledger attaches (§4.4).
  *(This entry used to describe a reservation settlement through an escrow shard that
  overran the 10% line on a three-factor number and was closed by pricing the settle hop
  separately. D-30 deleted reservations and D-90 the shard and `settle(n)`; winning a lot
  now mints in the closing transaction. §4.4's note on `SETTLE_GAS` keeps the history.)*
  The estimate this entry was first written against is preserved below, because being able
  to see what was guessed next to what was measured is worth more than a tidy paragraph.

  The original estimate: the 10% gas line rests on an unbenchmarked
  ~0.10 GRAM estimate covering NFT item deploy, jetton wallet deploy plus rebate mint,
  `owed` dictionary rent, referral-key owner resolution, and the amortized flush gas from
  §4.3 (~0.001 GRAM/mint at 100 mints/day — but it scales inversely with mint rate, so a
  quiet protocol pays more per mint for the same daily flush). If real cost exceeds
  0.10 GRAM — most plausibly on prime mints at large n, where Miller–Rabin lands in the
  same budget — the protocol subsidizes each mint from somewhere else in the split.
  ~~**This is the highest-priority Phase 3 measurement**~~ *(done — see above)*, and the
  honest fallbacks are raising the gas line at the pool's expense, charging differential
  gas for prime vs. composite mints, or abandoning all-in pricing. Decide from the
  benchmark, not from this estimate. **`DECISIONS.md` D-117 (2026-09-22) took the first
  fallback:** measured on the ledger's balance the worst mint is 0.192 GRAM (ω = 12), and the
  line is now a derived 20%, at ten points of β — most of which the pool gets back on an
  ordinary mint, because `sweep_ops` now returns the unspent line to the ratchet.
- **Tribute at 10% may be too thin** to make prime NFTs worth a serious clearing price —
  and under D-20 this is now purely a test of *where on the slope a prime sells*, since
  every prime clears eventually at its resting price and that floor tells you nothing about
  demand — which would hollow out §6 and the whole "primes are the aristocracy" thesis.
  Phase 1 kill criterion; the lever is obvious and reversible before deploy. Note the thesis
  now has more legs — self-tribute discount, referral income — so the
  premium case no longer rests on tribute alone. **§3.2's `√p` weighting sharpens this
  risk rather than easing it**: it deliberately cuts the first ten primes from 62% to 22%
  of the tribute line, so the premium that 10% has to justify is being tested against a
  much smaller share (there is no reserve to clear under D-20 — the test is whether small
  primes sell above their own resting price at all, and since D-88 point 1 that floor is
  itself `NPV(p) / 2`, so for the smallest primes the test is sharper again). The two
  parameters are not independent and
  Phase 1 must not treat them as such — if the premium case fails, raising the tribute
  share and lowering the divisor exponent are the same lever pulled from opposite ends.
- **The ratchet is a honeypot, and the floor guard made it a bigger one.** Batching (§4.3)
  plus reservation escrow (§4.4) always meant a live GRAM balance; under §4.3.1 that balance
  is no longer bounded by a five-day queue but by *how long the market stays above the
  floor*, which could be indefinitely. The protocol may end up holding a very large,
  unwithdrawable reserve. It is the highest-value target in the system and the most
  attractive thing to put a "temporary" admin function over. **The separate temptation — to
  write a "productive use" proposal over it — was taken, on terms** (§11.14, reopened and
  adopted by D-151): §4.3.2 stakes 80% of the obligation at cost, which does not add a
  withdraw path and does add a counterparty, priced in §8 and in §5. The two temptations
  still have the same answer and it still has to hold under both, and the second one has now
  been answered in public rather than deferred. Mitigations: no withdraw path in the
  source at all; `flush()`, claims and the §4.3.2 legs as the only outbound GRAM paths, every
  destination a venue address or the treasury, every amount computed by the contract rather
  than the caller.
- **DeDust dependency.** The ratchet's execution leg lives in someone else's protocol
  (§11.3). Venue failure, pool retirement, or a v3 migration stalls buy-and-burn even
  though the backing GRAM is safe on the ratchet. The floor guard adds a monitoring wrinkle:
  a bounced flush is now *normal*, so "the venue is gone" and "the market is above the
  floor" look identical from the outside. `get_flush_status` must distinguish them
  (§9.1), or a dead venue hides behind months of legitimate-looking non-execution.
- **Tonstakers dependency, which is a different kind of dependency from DeDust's** (D-151,
  §4.3.2). DeDust holds none of the backing — a dead venue stalls buy-and-burn and the GRAM
  stays safe on the ratchet. Tonstakers *holds* 80% of the ratchet's obligation, so its
  failure is a loss of backing rather than a loss of execution, and that is the honest
  distinction to draw before a reader collapses the two. Three bounds on it, none of them a
  promise: the position is carried **at cost**, so the counterparty's price cannot inflate
  `p_f`; the loss that a shortfall causes is published as `realizedLoss` on `getStaking()`
  rather than absorbed, and overstates the floor by exactly `realizedLoss / S`; and the exit
  never sells under cost — the only leg that names a price floors it at the tranche's cost
  basis and otherwise waits for the pool's own rate. What is genuinely unmitigated is a
  slashing event inside that pool. It is stated in §5 next to the theorem, and it is the one
  external event that can make anything §5 claims false.
- **Constellation concentration.** ~~Multipliers favor whoever can afford to assemble
  sets, which skews tribute toward whales even though the total is fixed.~~ **DELETED
  2026-09-05 (`DECISIONS.md` D-102)**, and constellations themselves by D-202.
- **The growth backend is a trusted display layer.** Caching proxies, quest scoring, and
  voucher signing are off-chain and operator-run. Mitigations: every displayed stat maps
  to a get-method (§9.1), payments follow only the on-chain key (§9.2), vouchers are
  delta-paid and key-burnable (§9.5). The honest statement: the *money paths* are
  trustless; the *scoreboard* is not, and says so.
- **The growth loop may simply not convert, and this is still the risk — it has just
  stopped being an arithmetic one.** Patronage rested on an activation rate above **41.5%**
  with no prior for that number, and `PATRON_CAP` bounding the payout at 1.00 GRAM against a
  0.415 GRAM cost meant a shortfall made every patron mint a donation dressed as a growth
  loop. `DECISIONS.md` D-106 removes that half: **nobody is underwater if a gift does not
  convert.** A gift mint delivers a number the giver chose to buy, at the price they chose
  to pay; the recruit tier is on top and costs the protocol emission inside a clamp it
  already enforces. There is no threshold to clear and no criterion left to fail.

  What survives is the ordinary product risk: **people may not open gifted numbers.** That
  is a human problem, not an arithmetic one, and it is why §4.6's newcomer uplift and the
  (deferred, §9.1) gifting composer point at the same variable. If nobody mints one of their own, the loop
  does not compound — the game simply grows the way it would have without it.
- ~~**The unclaimed pool can look like a graveyard.**~~ **NOT REACHABLE (D-106).** Every
  patron mint nobody claimed was a public, permanent record of a failed recruitment on the
  same dashboard as the floor staircase, and a large backlog read as *this game has no
  players* far more loudly than the mint feed read as the opposite. There is no unclaimed
  state: a gift lands owned, so a gift nobody acts on is indistinguishable from any other
  number somebody holds and has not minted beside. The funnel's failure mode is no longer
  visible by design — which was the right choice under principle 5 while the state existed,
  and is simply moot now.
- **Claimable state decays irreversibly — the protocol has a Muller's ratchet as well as
  a monotone one.** §5's ratchet is the good kind: `p_f` only rises. Running alongside it
  is the biological kind, and it points the other way. Muller's ratchet is the population
  model in which a sexless population accumulates deleterious mutations that can never be
  removed, because the mutation-free class, once lost, has **zero probability of coming
  back** — the transition is one-way, so the count of healthy genotypes is monotone
  downward for the same structural reason `p_f` is monotone upward.

  This protocol has exactly that structure in its claimable state. A prime whose owner
  loses their key keeps accruing tribute into `owed` and its share of `div_acc` forever
  (§3.2, §3.2.1), and nothing can ever move it: `claim_tribute` is owner-gated by design,
  there is no admin path (§8), and the number is permanent and non-reissuable. The same
  is true of a burned referral key, an abandoned reservation, and any composite whose
  factor owner is gone. Each such event moves a slice of the number line from *claimable*
  to *permanently unclaimable*, and there is no reverse transition — so **the fraction of
  accrued value that anyone can still collect is monotone non-increasing, and it converges
  to zero over a long enough horizon.**

  What this is and is not. It is *not* a solvency risk: the GRAM is where it always was,
  the ledger's `balance ≈ declared liability` property (§3.4) still holds exactly, and no
  other holder is diluted — the divisor line simply never leaves the item. It is *not* the
  team's to reclaim, and an expiry-and-resweep mechanic is deliberately **not** proposed
  here: any such path is a withdraw path with a story attached, and §8's "no admin withdraw
  on any GRAM balance" is not negotiable for this. What it is, is a slow, permanent
  divergence between two numbers the dashboard shows next to each other — total tribute
  *accrued* and total tribute *collectable* — and a reader who finds that gap unexplained
  will assume the worst, exactly as they would with `pending` (§5).

  So it is disclosed and measured rather than fixed. The **attrition metric** reports the
  dormant share directly: the count of minted primes that have never claimed, the count
  whose last claim predates a configurable dormancy window, and the GRAM sitting in both
  groups. Every component is derivable from public state — mints and claims are on-chain
  events, `owed` is `get_owed` on the item, and the unconverted flat dividend is
  `getClaimableDividend(p)` (§9.1) — so the number is checkable and not merely published.
  A rising dormant share is the honest early signal for "the collection is drifting into
  dead hands", and it should be read as a health indicator, not as a liability.
- **Rank rights, prime credits and — if it ships — a purchasable uplift are an unpriced
  liability.** §4.7, §4.7.1 and §5.1 all issue power because emission is capped by the
  ratchet, but "costs no supply" is not "costs nothing": a large cohort of high-rank
  wallets minting at `K_CEIL` permanently slows the floor's climb relative to the headline
  schedule, and prime credits are emission deferred onto future composite mints. (A
  rank-keyed tribute multiplier was proposed as a third cost here too, but it is deleted —
  `DECISIONS.md` D-54 — no code path wires rank into the ledger's tribute pass, so it
  redistributes nothing.) Bounded by `K_CEIL < 1`, by the closed 10% tribute line, and by
  `PRIME_UPLIFT · PRIME_WINDOW < k_max(n)` — so neither can break an invariant — but the
  *rate* of the ratchet is a marketing number, and both erode it. The offset is real and
  should be measured rather than assumed: zero emission on primes adds back more than the
  credits take out at every point on §5.1's table.

  **The bound that makes this bullet tolerable holds again.** The liability is rationed by
  the fact that every uplift has to be *earned* — high-`k_max` wallets are rare because
  recruits and prime mints are scarce. §5.3 once proposed a stake uplift rationed only by
  capital, which would have let every large holder sit at `K_CEIL` from day one;
  `DECISIONS.md` D-168 deleted it, and §5.3's staking now pays PRIMES the vest already
  emitted, so it adds nothing to this line.
- **Staking took the LP miner's budget, and the miner paid for flush depth.** Until D-168
  the treasury's vest paid LP custody positions, which rewarded DeDust depth — the pool
  §4.3.1's flush swaps against. D-168 moves the whole vest to PRIMES stakers and leaves LP
  custody a vote and nothing else, so depth now rests on the pool's own fee income and on
  the LP sink. Phase 1 publishes LP depth and flush slippage with the miner removed, and if
  the flush can no longer defend its band the build stops and the owner decides (§5.3).
- **The price ceiling is load-bearing disclosure.** §8.1's `x*` is derivable by any
  reader from two public constants, so it will be derived. Documented, it is the second
  half of the band — a floor that can only rise under a ceiling that rises with it;
  discovered, it reads as a hidden emission valve that sells every rally, which is
  arguably worse press than the Ponzi label this register already defends against. The
  honest cost stands either way: PRIMES cannot run like a memecoin, and the moonshot
  energy has to live in the numbers, not the jetton.
- **Every prime can clear at its resting price, and the risk changed shape rather than
  going away.** The old version of this bullet was about a genesis auction whose `P0/100`
  reserve was "genuinely reachable"; there is no genesis auction and no `P0/100` (§6,
  `DECISIONS.md` D-20). What replaces it is the same risk across the whole line rather than
  six lots. **If primes attract no real interest they all clear at their resting price** —
  `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` since D-88 point 1 and D-99 §1.2, so a third of
  the opening price rather than 1 GRAM, and exactly 1 GRAM only for a prime that opens under
  3 GRAM. The ratchet
  then receives only that floor's premium leg from the prime lane, and the most valuable
  assets in the collection go to whoever is patient rather than to whoever values them.
  Nothing in the mechanism defends against that: the resting price is a clearing guarantee,
  not a valuation. **D-88 moved the number, not the risk** — it raised what patience costs
  on a small prime, which narrows the discount patience earns without removing it.

  Three things are genuinely better than they were, and one is worse. Better: the floor is
  the ordinary mint price rather than 1% of a start price, so a cheap clearing is never
  *embarrassing* — the number sold for exactly what every composite sells for; `p_f`
  cannot be corrupted by a cheap clearing regardless of clearing price, because `T`/`S`
  never read the auction's clearing price at all — every clearing's premium leg credits
  `pending` at face value (§6 point 3, D-7), the same accounting path every other mint
  uses; and the sim's NPV table is published before any price starts falling, so the
  anchor is public before the irreversible step. Worse: **there is no longer a deadline forcing
  the question.** The old fixed slope guaranteed the blue chips could not sit unsold
  indefinitely; the current lot has no expiry, so "unsold" is a state that can persist
  forever, and it costs the eventual owner its tribute the whole time (§4.1, and the
  forfeit entry above). **The honest cost: market depth rests on an operator commitment.**
  The genesis pair (D-154; ≈21.24 GRAM since D-204, against the donation's PRIMES, sink-locked) is posted by
  hand and no contract enforces it; were it skipped, rebates would be backed but not
  sellable on the open market — a prime is still always payable at its resting price through the
  market contract directly (§6 point 3's "the genesis pair is an operator commitment"
  paragraph), so this is not a liveness failure, only a market-depth one.

- **Perception risk**: any pyramid-adjacent mechanic invites the Ponzi label — and the
  design includes a referral program, which sharpens the question. Defense is structural,
  not rhetorical: **referrals are single-level, capped at 10%, and are the ONLY mechanism
  in the game that pays GRAM for bringing somebody in** (`DECISIONS.md` D-106 deleted the
  second one). What replaced it pays no currency at all — a recruit raises the recruiter's
  own rebate ceiling by a tier, which is a limit on what their own future purchases earn
  them, not a transfer from the person they introduced. *(This paragraph used to rest on
  the patron line's cap: "lifetime extraction from a recruit is a disclosed 1.00 GRAM —
  exactly the price of the mint that bought them, which makes the mechanism's best case a
  refund rather than a profit". That was a strong sentence and it is superseded by a
  stronger one: there is no extraction.)* There is no second-level field anywhere, so
  depth is absent from the data model rather than merely unimplemented; there is no
  default key routing orphan traffic
  to the operator; unattributed referral value backs the floor; every claim is a
  get-method; team takes fees, never supply — since `DECISIONS.md` D-166 with no exception:
  the operator's one-time genesis PRIMES allocation (D-46) is deleted, and the operator buys
  PRIMES by minting at the head like anyone; no return promises anywhere in copy.
  The sharpest available framing, and the true one: **the protocol refunds one mint at
  most to acquire a customer who pays it twelve**, and it does so out of that customer's
  own spending rather than out of anyone below them. That is a customer-acquisition cost,
  not a downline. A pyramid's defining feature is that recruitment income is unbounded in
  depth and in total; here it is bounded in both, by an absent struct member and by a
  single constant. Batching adds one line to defend — "why is GRAM sitting in the
  contract?" — answered by `get_pending()`, each contract's `getSolvency()` (§3.4), and the absence of a
  withdraw function. §4.3.2 adds the mirror-image line — "why is GRAM *leaving* the contract
  for a staking pool?" — answered by `getStaking()`, by the destination being a venue this
  contract cannot choose, and by the same absent withdraw function: the GRAM comes back to
  `pending` by rule and reaches no wallet on the way.

  **The ops sweep is the one function in this list that a hostile reader will find before
  finding its justification, and it must be disclosed in the same breath as the rest.**
  §4.1 moves the unspent remainder of the gas budget off the ledger by a permissionless
  function with no amount argument. Until `DECISIONS.md` D-117 it paid an operations
  address — "the team can call a function that sends them money from a contract" was the
  worst available reading of it. It now pays the **ratchet pool**: the amount is a
  subtraction anyone can recompute from `getOpsSweep()`, it credits `pending` and `T` and
  emits nothing, the caller can be anybody, and no wallet — the operator's included —
  receives any of it. The alternative — leaving the residual to pile up unclaimed and
  unexplained — would be the same money with no stated owner and a §3.4 invariant quietly
  drifting.

  **The second such line, and the one most likely to be found first, is the unsold-prime
  tribute forfeit.** Said badly — "this document says unresolvable split lines never go to
  the team, and there is a path that sends them to the team" — it is the sharpest available
  attack on §2 principle 4, and it is *true as stated*. Said accurately: while a prime is
  unsold there is no owner to pay, the money is GRAM out of the fixed 10% tribute line and
  never PRIMES, it cannot touch `S`, `T`, `pending`, `owed` or escrow, no admin function can
  reach or accelerate it, it stops permanently the moment somebody buys the prime for as
  little as that prime's own resting price plus `RES_GAS` (at least 1.070 GRAM, and more for
  every prime the `NPV` table covers — D-88 point 1), and every satoshi of it is published
  per-prime by `getForfeited(p)`
  (§4.1, §6 point 2, `DECISIONS.md` D-20 point 4). The owner signed it knowing the first
  version — route it to Unity's holder — had already been rejected on Ponzi-shape grounds.
  It is **disclosed in four places in this document rather than defended in one**, because
  the failure mode here is not the money, it is a reader discovering a carve-out the spec
  did not admit to.
- **A bounced direct-head-mint `MintItem` is parked, not orphaned** (`DECISIONS.md`
  D-117). `primes_ledger.tolk`'s `onBouncedMessage` arm still does not roll `head` back (the
  rollback races every other player's mint and has no sound value to roll back to); instead
  it stores the original message body in `Aux2.unroutedItems` under `n`, declares its
  held split lines in `unroutedHeld`, and the permissionless `retry_item(n)` re-sends it
  — same owner, same held split. A deploy the ITEM refuses lands in the same lane: the
  collection relays the bounced `populate` as `mint_item_refused` (D-199). `GAUNTLET.md` V1.1 found the scheduled trigger (the collection
  running out of its own gas headroom around mint #900) and V1.2 fixed it at the root, so what
  is left is a genuine anomaly — a collection bug or a TVM-level failure — and it now
  recovers rather than costing the minter the number.
