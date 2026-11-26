# TON PRIMES — FAQ

**Why the game works the way it does.** One entry per non-obvious design decision, each
citing the `CONCEPT.md` section that specifies it and, where one exists, the §11 closure or
`DECISIONS.md` brief that settled it.

`CONCEPT.md` remains the specification. This document explains it; it does not extend it.
Where the two disagree, `CONCEPT.md` wins and the disagreement is a bug in this file.

> **Status: pre-launch.** Nothing has launched. There is no mainnet deployment, no real
> users, and no real money. Testnet is a scratch environment.

---

## The basics

### What is this?

A number-theory game on TON. Integers are minted **strictly in order** as NFTs, one after
another, starting from the beginning of the number line. Composites require you to submit a
prime factorization; primes require the contract to run Miller–Rabin on-chain.

Each mint splits five ways, and the leftover — called **β** — is injected into a mechanism
called **the ratchet**, which makes a published internal floor price go up and never down.

### Why do numbers have to be minted in order?

Only the 1 GRAM mint is sequential. The head is a shared clock everyone is watching, and every
number it passes gets a position, a date and a minter.

You *can* have 1729 on day one — but not for 1 GRAM. Any number ahead of the head is sold by
paid ascending auction: opening the lot is the first bid at its starting price, and winning
mints the number in the transaction that closes the lot. The head then skips 1729 forever
(§4.4, D-45/D-88/D-90). So the interesting numbers are not a free-for-all; they are priced,
and what they sell for feeds the ratchet. *(There is no separate reservation lane — D-30
deleted the flat-fee route, and D-90 the escrowed claim behind it.)*

### What does a mint cost?

**1 GRAM, all-in**, for an ordinary composite at the head. The protocol pays every deploy
cost out of that — there is no separate gas charge (§3.1, §4.1).

Two exceptions, both auctions:

- **Primes at their turn** clear by descending auction (see below).
- **Every number ahead of the head**, prime or composite, clears by ascending auction (§4.4, D-30, D-88).

### Where does my 1 GRAM go?

Five ways, and the split is **closed at 100%** (§4.1):

| Line | Share |
|---|---|
| Tribute to the number's prime factors | 10% |
| Referral (to the owner of a *number*, not an address) | 10% |
| Treasury (governed — spendable only by a passed vote) | 5% |
| Gas & ops (sized to the measured worst-case mint, D-117; the unspent part is swept to the ratchet) | 20% |
| Invites (0..3 text transfers of 0.1 GRAM to wallets you name; the app pre-fills them) | up to 0.30 GRAM |
| **Residual β → the ratchet** | **the rest** |

*(Six until 2026-09-07. `DECISIONS.md` D-106 deleted a conditional **patron line** that
took 25% of a recruited player's first mint and 7.5% of each one after, up to a lifetime
1.00 GRAM. Nothing pays GRAM for recruiting now.)*

β ranges over `[0.25, 0.75]`. With no invites sent it is **0.55 for a referred composite**
and **0.65 for a prime**; each invite sent takes 0.1 off, so a referred composite that sends all
three injects **0.25**, the worst case (`shared/params.json` `invites.beta_table`, D-202). An
ordinary mint also spends well under its 20% gas & ops line, and the permissionless
`sweep_ops` returns what it does not spend to the ratchet pool with no emission (D-117), so
the pool's effective share is about 0.10 above β.

### Why does an unresolvable line fall to the pool instead of to the team?

Design principle: **the team takes fees, never supply** (§2). If you mint without a referral
key, that 10% does not become operator revenue — it falls into the ratchet and raises the
floor for everybody. Same for the tribute line on a prime mint, which has no recipient by
construction. The same holds for the gas & ops line's unspent surplus, which the sweep
returns to the ratchet rather than to any wallet (D-117). Unclaimed value always goes to the
players collectively, never to the operator (§3.1, §4.1).

---

## The ratchet — the central claim

### What is the "floor price"?

`p_f = T / S`, where:

- **`T`** = total GRAM ever committed to the pool by the protocol
- **`S`** = total PRIMES ever emitted as rebates, plus the genesis bounty vault

No oracle, no external dependency. Both numbers are on-chain counters you can read (§5).

### Why does the floor only ever go up?

Because every mint injects `β` GRAM into `T`, and pays back a rebate worth **`k × β`**, where
**`k` is always strictly less than 1**. You always get back less value than you put in. That
gap is the ratchet, and it is the whole theorem (§5).

`k < 1` is enforced by a **single clamp**: all uplifts are summed and then clamped once at
`K_CEIL = 0.95`. One clamp, on the sum, is what makes it checkable — an auditor does not
have to reason about how many uplifts a wallet has stacked.

### What is `k`, in one sentence?

**The fraction of your own pool injection that comes back to you as PRIMES.**

Two things set it:

1. **Patience.** `k(t) = k_min + (k_max − k_min)·min(1, t/T_ramp)` — it climbs in a straight
   line from the moment of the last mint and hits its ceiling exactly one hour later, then
   stays there. Waiting is rewarded, and an hour is the whole of the reward.
2. **Your personal ceiling.** `k_max(n) = 2.7/log₁₀(n)`, which *shrinks* as numbers get
   bigger, plus any uplifts you have earned.

### Why does `k_max` shrink as numbers get larger?

Because otherwise the rebate would be a constant tax on the ratchet forever. Anchoring at
n₀ = 1000 and decaying with `log₁₀(n)` means the early game is generous and the late game
ratchets harder, which is the correct direction: early players take the risk that the game
does not work, and later players are buying into something that already does (§5).

### Do prime mints earn a rebate?

**No. `k = 0`, always** (§5.1).

A prime mint injects its whole β against **zero** emission, so it moves the floor about as much
as **11.8 patient composite mints**. It is the one ratchet contribution a minter cannot
dilute by waiting.

### Then why would anyone mint a prime?

You are paid in **rights** rather than in tokens (§4.7, §5.1):

- The **perpetual tribute claim** — every future composite divisible by your prime pays you,
  forever.
- **The pen on the number** while you own it — any owner names a number once for GRAM
  (`DECISIONS.md` D-212).
- **+1 prime rank.**
- **`PRIME_UPLIFT`** — a bounded credit to your `k_max` on your next `PRIME_WINDOW`
  composite mints.

That last one is deliberately constrained: **`PRIME_UPLIFT · PRIME_WINDOW < k_max(n)`** is a
contract-level invariant with a test. It guarantees the credit is always worth strictly less
than the rebate you gave up, so prime mints stay net-accretive to the floor at every point
on the line.

### Why is `S` never decremented when tokens are burned?

Because it makes the floor **understate** the backing rather than overstate it (§3.3, §5).
Circulating supply is strictly below `S`, so the real backing per circulating token is
better than `p_f` says.

This is the conservative choice on purpose. A sharp reader who computes the
circulating-supply version will get a *better* number than the one on the landing page.
Better they find that than the reverse.

### Why does `T` count at mint rather than at flush?

Because the injection is batched. Counting at flush would mean your mint does not raise the
floor until some unrelated stranger happens to call `flush()` — which would break the
central claim that **every mint raises the floor** (§5).

`T = seeded + swapped + pending + stakedCost + exiting + realizedLoss` and is checkable per
block. Quote the whole form even though two of the six read `0` on a healthy deployment — a
short reading reports a solvency gap that is not there. `seeded` is founder capital credited
straight into `T` without ever passing through the ratchet, and it is **`0` in this
deployment** (D-26); since D-100 point 1 a **floor donation no longer touches it** either —
that raises `T` and lands in `pending` like every other injection, counted once. The last
three arrived with the staked reserve (§4.3.2): `stakedCost` is GRAM sitting in the Tonstakers
pool at what it cost, `exiting` is a batch on its way back out of it, and `realizedLoss` is
GRAM that left and did not come back. One call, `getStaking()`, returns all three.

### There's a gap between `T` and what's actually in the DeDust pool. Is that bad?

No, and it is disclosed rather than discovered (§5). `pending` is GRAM sitting on the ratchet
that has not been swapped yet. Under the floor guard it can be large and long-lived by
design.

If anything it is **better** backing than pool reserves: it has not been exposed to price
impact, and it remains available to buy at a price the protocol chooses. `pending` belongs
on the dashboard next to the floor, with the reason it is there.

**Part of that gap is now in a third place, and it is named.** Since 2026-09-20 (D-151)
everything above a liquid reserve of 20% is deposited into **Tonstakers**, TON's largest
liquid-staking pool, and held as tsTON — so the standing bid earns while it stands instead
of sitting still. It is counted in `T` **at what it cost**, never at what the tsTON is worth
today, so the staking rate cannot flatter the floor. `getStaking()` publishes the amount.
See §4.3.2, and the next answer for the catch.

### So the backing depends on somebody else now?

**On one somebody, yes, and it is named rather than glossed over.** Until D-151 this FAQ
could say the backing had no counterparty at all. It cannot any more: 80% of the ratchet's
obligation sits in the Tonstakers pool. Three things bound what that costs you:

- **It is carried at cost.** A tsTON price that is wrong, stale or manipulated cannot raise
  the floor by a nanoton, because the floor never counts the position at market.
- **Nothing is sold under cost to get it back.** Of the three ways GRAM comes home, only one
  names a price, and that one refuses any fill below what the GRAM cost — it waits for the
  pool's own rate instead. Waiting is the right answer to a bad price.
- **A loss would be published, not buried.** `getStaking()` returns `realizedLoss`. If it is
  ever non-zero, the floor is overstating the backing by exactly `realizedLoss / S`, and the
  protocol says so on its own dashboard.

**What is genuinely not mitigated is a slashing event inside Tonstakers** — validators being
penalised for misbehaving, which would make the pool pay back less than we put in. That is
the one outside event that can make the ratchet theorem's promise fall short, it is written
into §5 next to the proof rather than hidden in a footnote, and `realizedLoss` is the number
that would show it.

**What did not change:** nobody can withdraw any of it. The three staking functions are
permissionless like `flush()`, **none of them takes an amount**, and the share that gets
staked is a constant from the simulation, not a number anyone decides. The yield goes to the
LP-governed treasury as tsTON, spendable only by a vote of LP depositors — never to the
operator by rule.

---

## Buying and burning

### When does the protocol buy PRIMES?

**Only at or below its own floor** (§4.3.1). The flush's slippage limit is set to
`amount·S/T`, so a flush that would buy above `p_f` simply bounces and the GRAM stays on the
ratchet as backing.

Three consequences:

- Protocol buying is **countercyclical** — it buys weakness, not strength.
- It **caps the flush-MEV attack at the floor.** Above `p_f`, pumping the pool makes the buy
  bounce. Below it, a sandwicher can still make the ratchet fill at up to `p_f` and sell
  back: that costs burn efficiency (fewer PRIMES burned per GRAM), never backing — `T`, `S`
  and `p_f` do not move (`DECISIONS.md` D-190).
- The ratchet stops being a five-day queue and becomes **standing floor defense**.

### Who can trigger a flush?

Anybody. `flush()` is **permissionless** and fills only at or below `p_f` (§4.3, §4.3.1).
There is no privileged caller and no schedule that depends on the operator being alive.

**Whoever calls it pays for it** (`DECISIONS.md` D-146). A flush attaches DeDust's 0.25 GRAM
of swap gas plus a little compute — 0.26 GRAM, and the contract refuses anything less — and the
change comes back. The same holds for the three staking arms (stake 1.02 — about 0.89 of it refunded — unstake 1.96, almost all of it refunded when the exit ends, harvest
0.16 GRAM). No call can spend the ratchet's own balance above `pending` beyond what its own caller put there (an exit's refund returns only the `unstake` caller's prepay), so nobody can drain it
by calling in a loop; the keeper pays its own calls like anyone else.

### Can the team withdraw the GRAM?

**No.** There is **no admin withdraw path on any GRAM balance** — not timelocked, not
multisig, not "emergency" (§8). This is the strongest claim in the system and it is a
structural property, not a policy.

### What happens to GRAM that gets swapped into the pool?

It is locked there **forever**. Flush buys add no LP, so every GRAM the protocol swaps lands
in pool reserves **nobody can withdraw on the protocol's behalf** (§5). The genesis pair's LP
receipt is not burned and nothing happens to it at deploy: the launch sequence sends it to
the **LP sink**, `primes_lp_sink.tolk`, a contract with no outbound message type (§6 point 3,
`DECISIONS.md` D-154 point 4; D-46 deleted the deploy-time seed-and-burn this answer used to
describe). The pool deepens permanently, at nobody's expense and to nobody's claim.

Two honest nuances. If third parties add LP later, they own a proportional, withdrawable
share of reserves that subsequent protocol buys deepen — the lock is absolute only for LP
sitting in the sink, which at launch is the whole genesis pair. And sending the receipt there
is a hand action in the launch sequence (D-120), not a contract rule, so check it rather than
take it on trust: the sink's `getLocked()` is the figure.

### Is there anything I can *do* with PRIMES besides sell it?

**Stake it** (§5.3, below). There is no longer a burn-priced sink: naming, the last thing one
sold, is paid in **GRAM** since `DECISIONS.md` D-212, and `primes_sink.tolk` is deleted.

### How does naming a number work?

Any **current owner** of a minted number — prime or composite — sends `name_number` to the
collection with the fee attached (§4.7.1). The first naming of a number costs `nameFee`
(about 50 EUR in GRAM, fixed at genesis from that day's rate, because a contract cannot read
EUR); every later naming costs `renameFee`, **200 GRAM**, whoever owns it then. Both are in
the collection's `getNaming()`. The fee goes to the **ratchet floor**: `T` rises by exactly
the fee and `S` does not, so every naming lifts the floor for every holder. If you are not
the owner, underpay, or name a number nobody minted, the whole payment comes back. The pen
follows the NFT: sell the number and the buyer may rename it (for 200 GRAM); you may not.
An era trophy's first engraving stays free.

### What happened to the §5.2 sink families?

D-2 signed three; none is a burn any more:

1. **Burn-priced cosmetics and rights** — **empty** since D-212. It listed name annotations
   (now paid in GRAM, above), constellation registration bonds (**deleted**, D-102) and
   era-ceremony lots (**deleted**, D-126).
2. **Burn-priced queue position** — **dropped, not re-aimed.** D-30 deleted the reservation
   fee it was to be paid against, and pricing a place in a GRAM auction in burned PRIMES would
   put a second currency inside a lane whose whole point is one clearing price
   (`DECISIONS.md` D-35).
3. **PRIMES staking** (§5.3, `DECISIONS.md` D-168) — **redesigned, and not a burn.** It used to
   be a purchasable `k_max` uplift, shipped inert at `STAKE_UPLIFT_MAX = 0` (D-34). D-168
   deletes that and makes staking a time lock paid in PRIMES from the treasury's vest —
   signed and built 2026-09-23 (`primes_stake.tolk` + `primes_stake_position.tolk`, the
   treasury's `distribute()`, `/earn`). See below.

### What is a sink allowed to do?

One rule, and it is what keeps the whole layer free:

> A sink may consume PRIMES and may grant rights. It may **never** move GRAM, never decrement
> `S`, and never touch the split.

So a sink contract holds a jetton wallet and **zero GRAM liability** — it does not appear in
the solvency check at all. Burning inside a sink does not move `p_f`; it widens the
circulating-supply gap in holders' favour (§5.2).

### Do sinks "support the price"?

**No, and any copy that says so is wrong under this document.** Sinks change what PRIMES is
*for*. They do not change what it is *worth*. The floor is still `T/S`, still monotone,
still deliberately understated (§5.2).

### Why transfer-to-sink instead of just burning?

A TEP-74 `Burn` carries no payload, so a burn cannot say what it paid for — and every
burn-priced sink needs it to. Instead you transfer PRIMES to the sink with the action in
`forwardPayload`; the sink recognises the notification from its own wallet, burns the full
amount, then performs the action (§5.2).

This keeps burn authority at **one address per sink**, which makes *"every PRIMES that
entered a sink was burned"* something you can check against one account rather than a
promise.

### If I stake, what am I actually staking, and what does it cost everyone else?

*(Built per `DECISIONS.md` D-168, 2026-09-23: `primes_stake.tolk` and its per-owner
position contract replace the old inert uplift.)*

You lock **PRIMES** for a fixed term — **30 days, 3 months, 6 months or 1 year** — and earn
PRIMES while the term runs (§5.3). Longer terms weigh more (5 / 6 / 7 / 8), and your share of
each month's payout is `amount × weight` over everyone's.

- **Where the rewards come from:** the governed treasury's own PRIMES — its 1,000,000-PRIMES
  vest. Once every 30 days anyone can call `distribute()`, which sends the treasury a fixed
  fraction of what it holds (19 bps a day, so about 5.7% a month) to the staking contract.
  That month's budget is then paid out **evenly over the next 30 days**, so nobody gains by
  staking the minute before it lands.
- **What you give up:** your PRIMES, until the term ends. There is **no early exit**. At
  maturity earning stops; you withdraw, or `relock` to start a new term.
- **What it costs everyone else: nothing new.** The rewards were already minted into `S` at
  genesis, so staking mints nothing, moves no GRAM and changes neither `T` nor `S` — the floor
  `p_f = T/S` does not care whether you stake. It does not touch your `k_max` either.
- **Stakes do not vote.** Governance stays with LP locked in the treasury (§5.5.5).

### Why does staking pay PRIMES, not GRAM?

**Because the only GRAM the protocol could pay you with is GRAM it has promised to somebody
else** (§5.3, `DECISIONS.md` D-168).

Look at where GRAM sits (§3.4). `pending` on the ratchet is the floor's backing — it belongs
to nobody, and paying it out would lower `p_f`, which the ratchet theorem forbids. `owed` on
the ledger is the prime owners' tribute. The treasury's GRAM is fee revenue that only a passed
vote can spend. A GRAM reward line would need a new cut of the §4.1 split — a new pool of GRAM
with a new owner — and the split is closed at 100%.

PRIMES has none of those problems. The treasury already holds 1,000,000 of them from its
vest, they are already counted in `S`, and handing them to stakers moves nothing the floor
depends on. The stake contract ends up **owing PRIMES and holding no GRAM**, and its books
close in one call (`getStakeSolvency`: what it holds ≥ principal + stream + unclaimed).

**And why not the old design — a bigger rebate for stakers?** Because that one *did* cost
everyone else. Extra `k_max` means more PRIMES emitted per GRAM injected, so `S` outruns `T`
and the floor climbs more slowly for every holder who did not stake. It also lowered the
price at which minting-and-dumping pays off, for exactly the wallets holding the most PRIMES
(§8.1). It shipped switched off (D-34) and D-168 deletes it.

**Does the treasury run out?** Not by this rule. Each month pays a *fraction* of what is
left, so the balance shrinks toward zero and never reaches it — and any PRIMES sent back to
the treasury (a donation, the next vest tranche) lifts every later month.

---

## Numbers, primes and tribute

### What is tribute?

10% of every composite mint is paid to the owners of that number's **prime factors** (§3.2).
Mint 234 = 2 · 3² · 13, and the owners of 2, 3 and 13 get paid.

This is why primes are valuable: a prime is a **perpetual claim on every future multiple of
itself**.

### What happens to the tribute on a prime that hasn't sold yet?

It is split **58% to the treasury contract and 42% to the operator** (D-166; 80/20 before
it), not to the protocol pool. This is one of two disclosed
exceptions to "unresolvable lines fall to the pool, never to the team" (§4.1, §6 point 2,
D-20 point 4) — while a prime sits unsold on its Dutch lane, every composite mint that cites
it as a factor pays that prime's share of the tribute line to that 58/42 split instead. It
reverts to the ordinary per-factor split the moment the prime is bought. The same rule now
covers a second case: a composite bought ahead of the head may cite a prime factor that is
itself ahead of the head, so that factor has no owner either and its share forfeits the same
way (D-90). *(There used to be a second disclosed exception — the 10% release forfeit — but
D-90 deleted the release right, so this is the only one left.)*

### How is the tribute split between factors?

80/20 (§3.2):

- **80% — the divisor line**, weighted `e · √p`. You submit `⌊√p⌋` with your mint and the
  contract verifies it in two multiplies (`s² ≤ p < (s+1)²`).
- **20% — a flat per-prime dividend**, accrued O(1) per mint.

The `√p` weighting moves primes above 200 from 25% to 58% of the line at n = 10⁵. Full `p`
weighting was rejected: it buys the tail under 6% more while cutting the genesis blue chips
by 82%.

### Doesn't the flat dividend die off as more primes exist?

No — this was asked and **answered wrong the first time** (§11.23, closed). The per-prime
*rate* decays as `1/π(n)`, but that is the wrong denominator. The mint count grows over the
same stretch, so cumulative flat income sums `Σ 1/π(n)` and **diverges like `ln²(n)`**.

At equal multiplicative age a *later* prime collects **more**, not less. The line is
progressive, not dying.

### Why is tribute pulled rather than pushed?

**Credit at mint, settle on claim** (§3.2.1). A push would mean every mint sends a message to
every prime factor's owner — unbounded fan-out, unbounded gas, on a path that must never
fail. Pulling makes the mint O(1) and puts the gas cost on the person collecting the money.

### Why are referrals keyed to a *number* and not to a wallet address?

Because a number is an asset you own, can display, can trade, and can put in a link (§3.1,
§4.1). Your referral key is an NFT you already care about, and the referral income follows
whoever owns it — not whoever created the link.

There is no default key and no owner key: an unset or invalid key means that 10% **falls to
the pool**, not to the operator.

### Is the referral system a pyramid?

No, and the structure is what makes that answer checkable rather than a promise (§11.4).

**Exactly one mechanism in this game pays GRAM for bringing somebody in: §4.1's referral
line, 10%, single-level, paid only on a mint the payer made themselves.** There is no second
one. Depth is what turns a discount into a pyramid, and there is **no second-level field
anywhere in the data model**, so depth is *absent* rather than merely disallowed.

*(Until 2026-09-07 there was a second: a **patron line** paying a recruiter 25% of a
recruit's first mint and 7.5% of each one after, to a disclosed lifetime maximum of
`PATRON_CAP` = 1.00 GRAM — exactly the price of the mint that started it, so the mechanism's
ceiling was a refund. `DECISIONS.md` D-106 deleted it, which makes the answer here shorter
and stronger: there is no extraction to bound.)*

### What actually triggers a recruitment reward?

**A mint somebody actually paid for.** The referral line pays on a mint the payer made
themselves; the recruit ladder is earned by paying for a mint somebody *else* receives.
Drops, claims, wallet counts and signups pay **nothing** (design principle 6, §4.6).

---

## Auctions

### How do I get a number the line hasn't reached yet?

**Updated 2026-08-19 (D-30, D-31), then D-88 point 3.** One route at a time, decided by one
thing only — where the head is:

- **Any number ahead of the head, prime or composite** — you **open a lot** on it, which starts an ascending auction. There is
  no separate direct-reserve route any more, and no rarity threshold to clear: if you want a
  composite early, you bid for it. *(The old design had ordinary composites reserve directly
  at a flat fee and only composites scoring ≥ `D_MIN` go to auction. That two-route split
  was deleted — one intention, one mechanism.)*
- **Every prime, at its turn** — descending (Dutch) buy-now (D-4, D-20). The price opens
  high on the prime's score and falls over a week to **that prime's own resting price**,
  then stays there forever until somebody buys it. **Before its turn**, a prime is bought
  the same way a composite is: at a paid ascending auction (D-88 point 3). *(This replaced
  the older rule, where a prime's lot sat flat at `P0(p)` ahead of its turn and the
  ascending lane refused primes outright.)*

Primorials are in neither lane; they belong to the era system (§7).

### How does the auction work?

**Fragment-style**, the format the TON audience already knows from Telegram numbers and
usernames (D-3), and since D-30 and D-88 it applies to **every number ahead of the head**, not just rare ones:

1. The opening price is derived from the number's **score** — see the next question.
2. **Opening the lot is itself the first bid, and you pay it** — you cannot open a lot on a
   number you are not willing to buy.
3. **That first bid starts a 7-day clock.**
4. A bid in the final minutes **extends** the close, so the lot cannot be sniped (D-8).
5. If nobody outbids you, you win at your opening price — and **the number mints to you in
   the transaction that closes the lot** (D-90). No waiting, no claim, no separate step.
   *(Until D-90 a won number waited in line and minted when the head reached it. The head
   never actually arrives at an auctioned number — D-45 marks it off the sequential line
   permanently — so the wait was for an event that could not happen.)*
6. ~~**You can change your mind** and release the claim for 90% back.~~ **Not any more.**
   There is nothing to release once you already hold the NFT, so there is no refund path
   and no 10% forfeit. If you want out, sell it on the secondary market (D-90 deletes
   D-32's release right, which had itself replaced cancellation).

This one mechanism replaced three separate systems that were 36% of all contract code. There
is no genesis-specific lot format anymore, for primes or anything else — D-20 deleted the
genesis K-lot bootstrap outright, and `primes_market.tolk` now only has two lot modes — the
ascending lot ahead of the head and the Dutch lot for a prime at its turn — nothing
genesis-shaped.

### Why does my birthday cost more than the number next to it?

Because it is a better number, and the contract says so out loud (§9.6, D-99).

Every integer gets one score, `D(n)`, and the score is a **sum**. Each thing a number *is*
carries a weight and they add: how short it is, whether its digits do something (a repdigit,
a palindrome, a run, trailing zeros), whether it **reads as a real calendar date**, what
mathematical form it has (Mersenne, Fermat, perfect, primorial, factorial, prime, power of
two, Fibonacci, twin, square, triangular, Harshad, happy, …), whether it is culturally
recognisable, and where it sits on the number line. Ten points doubles the price:
`price = 1 GRAM × 2^(D/10)`.

So `19720909` — 9 September 1972 — scores 30 for being a valid `YYYYMMDD` date, 2 for being
only eight digits long and 2 for having a prime digit sum, and opens at about **10.6 GRAM**.
Nine digits away, `19720900` is not a date at all — there is no zeroth day — and opens at
**3.48 GRAM**, on eight points of trailing zeros and its length. `20240230` opens at
**2.30 GRAM** for the same reason: 30 February has never happened. The score is checked
against **real Gregorian validity**, leap years and month lengths included, because a
birthday that never happened must not be priced as one.

Three things worth knowing before you feel cheated:

- **This only applies ahead of the head.** If you wait for the sequential line to reach a
  composite, it mints for exactly **1 GRAM**, however memorable it is. There is no exception
  and no skip. What you are paying for early is *earliness*, and "you should have waited" is
  a complete answer.
- **Nothing is hidden.** `getScoreBreakdown(n)` returns the score and a bitmask of every
  category that produced it, and `getScoreWeights()` returns the whole weight table, so you
  can add the number up yourself and check the price. If your sum and the contract's differ,
  the contract is wrong, not you.
- **The weights are the owner's, not the simulation's** — deliberately, and it is written
  down that way in `shared/params.json`. A price here is a guess at demand, and no
  simulation produces one of those. What the sim owns is what it always owned: a prime's
  tribute NPV, the bid-increment ladder and the rebate rates.

*(Until D-99 this worked differently and worse: there were three rarity "tiers" with flat
prices, so the fifth Mersenne prime ever cost the same as an ordinary twin prime, `1111`
cost twelve times more than either, `42` and `1337` cost the floor, and a birthday was an
ordinary number. Four separate pricing curves took a `max()` and only the loudest survived.
Now they add.)*

### Why does a prime cost more than 1 GRAM?

Because 1 GRAM undersells them (D-4). A prime carries a perpetual tribute claim, naming
rights and prime rank; a flat price captures none of that.

So a prime is sold by **descending (Dutch) buy-now**: it opens high according to its score
and falls over one week to that prime's **resting price**, then sits there forever if nobody
buys. You can buy at the standing price at any point on the slope.

**What the resting price is, since D-218:** the tribute that prime collects from the
**5,000 composite mints after its own turn**, never below 1 GRAM and never above what it
opened at (`restingPriceOf` in `primes_market.tolk`, from a table the sim generates). Prime 3
rests at about 29 GRAM, 97 at about 3.5, and every prime past 509 at exactly 1 GRAM, whatever
its score. *(Until D-218 it was `max(NPV(p) / 2, P0(p) / 3, 1 GRAM)`, which rested 3 near
294 GRAM and a top-scoring prime near 139 — high enough that the lots nobody wanted sat.)*

So: **a small prime still does not fall to 1 GRAM** — its floor is what its multiples pay it
over the next 5,000 mints. A large prime does, because at 1 GRAM it already pays itself back
by the time the head reaches about 12p. The week-long descent from the opening price is where
the real price is found; the resting price is only where a lot nobody wanted waits.

### Doesn't that stall the line? Primes are common.

They are — near n = 1000, roughly **one number in seven** is prime — which is exactly why,
as of D-20, **primes are not in the sequential head's path at all**. The head advances over
composites and Unity only; it skips primes structurally rather than waiting on them or
looking ahead of them. After Unity (`n = 1`) mints, primes 2 and 3 both open on the Dutch
lane immediately, and 4 — the first composite — is the next number the head builds.

This supersedes the earlier design (D-4a) where the Dutch clock started once the head was
`H` numbers behind a prime; that lookahead window, and the `H` parameter itself, are retired
outright — under D-20 there is nothing left for a lookahead to protect against, since the
head can never reach a prime in the first place.

What remains gated by the frontier is **which lane you are on**, not whether you can buy
(D-31, then D-88 point 3). Ahead of its turn a prime is bought at a paid ascending auction
opening at `P0(p)`, exactly like a composite. The descending clock only starts once no
unbuilt composite sits below the prime. *(Until D-88 the pre-turn price sat flat at `P0(p)`
and the ascending lane refused primes outright; one route, decided by where the head is, was
simpler than two decided by primality.)*

### What is the point of the descent stopping at all?

The stopping point is a **contract-level guarantee about the prime**, not about the head —
under D-20 the head cannot stall on a prime, because it never touches one. What the descent
guarantees is that a prime nobody will pay a premium for still reaches a known, published
price within a week and stays purchasable there forever, instead of drifting or expiring.

The price it stops at is `getPrimeFloor(p)`, computed by the contract from `p` alone at the
moment the lot is created. **Nobody can set it** — no message carries it and no handler
updates it — which is the part that actually protects you. *(This used to be the stronger
claim "every prime decays to exactly 1 GRAM"; D-88 point 1 deleted that, because a small
prime's tribute claim is worth far more than 1 GRAM and pricing it at 1 GRAM gave the number
away.)*

### Where does the money above the 1 GRAM mint leg go?

**Half to the ratchet, half to the treasury contract** (D-114, which amended D-7's 100% to
the ratchet). `RES_GAS` (0.07 GRAM) is carved off first to pay for the settlement, the nominal
1 GRAM runs through the normal five-way split, and the premium above `MINT_PRICE + RES_GAS`
splits 50/50: the ratchet half is credited as `pending`, the treasury half goes to the
governed treasury (no key, spends only by a passed vote).

Three things follow:

1. The split stays closed at 100% — the premium is not in the split at all.
2. The ratchet half is a `T` increment against **zero** emission, so it is purely
   floor-accretive. A 40 GRAM prime's premium alone still puts ~19.5 GRAM into `T` with no PRIMES emitted.
3. Nobody gets a windfall. Splitting the full clearing price would pay a referrer 4 GRAM on
   one recruit's single mint, which is unrelated to that recruit's own spend.

### Is there a limit to how far ahead I can buy?

Yes — about **4.29 × 10¹³, or 14 digits** (§11.6, closed by D-11). This started as an
artifact of the since-deleted reservation book's storage layout (`shardId` was a `uint32`
over `n / 10,000`) and is now a
deliberate, documented cap. It bounds the dictionary's state-size exposure, and 14 digits is
far beyond anywhere the head will reach. Since D-30 it caps **which numbers you can open a
lot on**, the reasoning being unchanged by the change of route.

### Why does a number won at auction settle at `k_min`?

Because winning a lot is not a patient mint. The rebate curve rewards waiting *since the
last mint*, and the settlement is triggered by the auction clock, not by a person choosing
to wait; paying the patient rate on it would hand out the maximum rebate for no patience at
all (§4.4). This survived every lane rewrite — D-30 moved it from a direct reservation to an
auction win, and D-90 moved the settlement itself into the transaction that closes the lot,
but the rate is the same.

---

## Ranks and eras

### Why are rewards paid in "rights" instead of tokens?

Because `k < 1` is load-bearing (§4.7, §5). Emission **cannot** be used as a growth lever —
every extra token emitted slows the floor for everyone. So the loyalty budget is paid in
things the protocol can issue for free: a higher rebate ceiling (clamped at `K_CEIL`),
naming rights, and the eight era trophies.

Two things this list used to include and no longer does, both removed on 2026-08-19
(`DECISIONS.md` D-36, D-37). **A waived reservation fee** — rank was said to waive
`RES_PRIORITY_BASE`, a 0.01 GRAM fee. It was never implemented, and the fee itself has since
been deleted along with the whole flat-fee reservation lane (D-30), so there is nothing left
to waive. **Era dividends** — a slice of each era bounty was to be split across Patrons by
recruits activated that era. It was never implemented either, and it is dropped rather than
built, because it was the one recruitment reward that sat outside the then-live `PATRON_CAP` and could
therefore make a fake self-recruited pair profitable. The whole era bounty now goes to
whoever mints the primorial, and the recruitment season pays out in the **era trophy**
instead — a prize, not a payout.

This is also why rights are **earned and never bought** — which is what makes them safe, and
which is why `DECISIONS.md` D-168 deleted the one uplift that could be bought (§5.3).

### How do I bring somebody into the game?

**Mint a number for them** (§4.5). Name their address as the `beneficiary` and the NFT — and
its PRIMES rebate — go to them, in the mint transaction. It is theirs from block one: there
is nothing for them to claim, no deadline to miss, and no step where it can go wrong. You
keep your own referral commission.

If the ledger has never seen that address, you are also credited **one recruit**, which moves
you up §4.7's ladder. Their first five mints of their own run at a raised rebate ceiling.

### What does recruiting pay?

**No GRAM at all.** A recruit raises *your own* rebate ceiling by a tier — a limit on what
your future mints can earn you, not a payment from the person you introduced, and bounded by
the same single `K_CEIL = 0.95` clamp as every other uplift in the game.

This is a deliberate change and it is worth knowing why, because the old answer was better
marketing. Until 2026-09-07 there was **patron mode**: you minted a composite into an
*unclaimed* state locked to one recipient, with an optional GRAM purse released on their first
mint, and you were paid an annuity — 25% of their first mint, 7.5% of each one after, to a
1.00 GRAM cap. The pitch wrote itself: bring one real player and your gift was free.

It did not survive its own arithmetic. The cap was a **fixed 1.00 GRAM**, but the cost of the
mint that bought it *rises* as the rebate ceiling `k_max(n)` decays with the head — so the
whole thing inverts at around **n ≈ 1173**, a third of the way through the first decade of
the number line. The simulation's kill criterion reported FAIL for the mechanic's entire
life, and it was never reachable from the app in the first place: every mint the webapp ever
sent declared "not a patron mint". `DECISIONS.md` D-106 deletes it rather than re-basing the
criterion to a number that passes.

What replaced it cannot fail the same way. **Nobody is underwater if a gift does not
convert** — you bought a number at the price you were willing to pay, and the tier is on top.
A ceiling is a fraction, not an amount, so there is no cost basis for it to drift against.

### Can't I just gift numbers to my own wallets and farm the ladder?

You can, and it is **priced rather than defended against**. A recruit is credited only when
the beneficiary is an address the ledger has never seen, so **gifting the same wallet twice
counts once**: each recruit costs you one fresh address and one full 1 GRAM mint, paid at the
same price everyone else pays, and every one of those mints ratchets the floor. Since D-202 the
net cost is **0.70 GRAM**: the gift mint may name your own wallets as its three invitees and
send 0.30 GRAM back to you.

What you get for it is one tier on a ladder that raises the ceiling on your own future
mints. **No GRAM comes back.** The cheapest way to farm it is to be a customer.

### Why not just airdrop numbers to random wallets?

Because a pushed NFT is drainer spam and wallets hide it — that is exactly how the old invite
NFTs reached nobody (D-202). What a mint pushes now is up to three 0.1 GRAM transfers whose
comment carries the minter's referral link, to wallets **the minter** names (the app pre-fills a
list; anyone may replace it). The contract picks no one, so no oracle is needed, and the payer
keeps the incentive to target well. A text transfer to a stranger is still unsolicited, and
that spam is an accepted risk (§4.6.1, §12).

### What are eras?

Primorial boundaries (6, 30, 210, 2310, 30030, 510510, 9699690, 223092870) divide the
game into eight eras (§7) — the same eight the contracts' `isPrimorial` enumerates and
the bounty schedule funds. Each carries an **era trophy**: permanent naming rights on the
primorial itself.

### Can I sell an era trophy?

**When one is awarded, yes — but none ever has been yet.** Transferability is decided
(§11.13, closed by D-14): era trophies are not soulbound, so a sale is a real market rather
than a policy question. Issuance is a different matter: today there is no ceremony trigger,
no era-scoped recruit tally, and no code path that has ever written an era trophy's naming
right to anyone. So there is nothing to sell yet, not because of a restriction, but because
issuance has not been built. **As of 2026-08-19 it is decided that it will be**
(`DECISIONS.md` D-36): the trophy is being built — the registrar already holds the
naming-rights storage it writes into — and what it still needs is the era recruit tally and
the ceremony write. Until that ships, treat every sentence about trophies here as describing
a decided mechanic, not a live one.

D-14's reversal is still worth stating plainly, for whenever issuance ships: the earlier
argument was that unbuyability was the whole reason for issuing them — *a prize that money
can buy is not a prize for recruiting*. That argument was conceded, not refuted. Any surface
describing era trophies as currently existing, awarded, or as "what no amount of GRAM can
buy" is **wrong on both counts** — none has been issued, and if one ever is, it will be
transferable.

### What happened to generators and constellations?

Both are deleted (`DECISIONS.md` D-202, 2026-11-07). An invite used to be a generator NFT
deployed to the invitee's address, and no wallet ever told the invitee it had arrived; a
constellation could not be built without one, so the two went together, with the discovery
bounty that paid early builds — its PRIMES stayed in the bounty vault for §9.6's riddles. An
invite is now a plain 0.1 GRAM transfer whose comment carries the minter's referral link, which
Telegram shows as text when a wallet sends it — whether it does when the ledger sends it is
the owner's Phase 0 probe (`contracts/scripts/mainnet/inviteProbe.ts`), not yet run.

---

## Playing from a program

### Can a bot play this?

Yes, and that is a decision rather than an oversight (§9.10, D-131). The audience is the
auditor, and an auditor with a wallet is a player. No contract path has a cooldown, a
per-wallet cap or a proof-of-humanity check; every read surface is anonymous with `CORS *`;
every write is an ordinary TON message any wallet can sign. A program and a person pay the
same 1 GRAM, submit the same proofs, and are checked by the same asserts.

Nothing was relaxed to allow this and nothing was added to discourage it. §8 already priced
every automated behaviour before the packaging existed, which is why saying so out loud
costs nothing.

### Is there an SDK?

Two published packages, both MIT:

- **`@ton-primes/agent`** — a TypeScript SDK for Node 20 or later. Sixteen actions, one per
  message a program-player can send, each pre-checking the contract's own asserts against a
  live get-method read before a wallet is ever opened. It also exports the reference
  arithmetic the contract itself uses: `factorize`, `isqrt`, and `isProbablePrime` running
  deterministic Miller–Rabin over the same 13 bases as `primes_ledger.tolk`.
  `npm install @ton-primes/agent`.
- **`@ton-primes/mcp`** — a stdio MCP server whose tools are one SDK call each. Every write quotes what it is about to spend and sends only on
  `confirm: true`; an irreversible one — spending a number's once-only annotation — says
  so in the quote.
  `npx -y @ton-primes/mcp`, or `claude mcp add ton-primes -- npx -y @ton-primes/mcp`.

The raw path is documented too, at [/llms.txt](https://primes.live/llms.txt): the read APIs
carry OpenAPI 3.0 specs, `shared/opcodes.ts` holds every opcode and `shared/schemas/*.tlb`
the wire format. The SDK is a convenience over that, not a gate in front of it.

### Do you hold my key if I run the MCP server?

No, and there is no way for us to. Signing is local and the transport is stdio only — a
hosted remote MCP was proposed and refused for exactly this reason (D-131.2), because a
hosted one would mean custody of a player's key. With no mnemonic set, both packages are
read-only and throw before any network call rather than after one.

### Does running a bot make money?

Not at the floor, and the copy will not pretend otherwise. §8 prices an automated loop at
`k · β · P < P` — a self-referred composite loop returns roughly 0.81 GRAM against the 1 GRAM
it spends. Self-referral is assumed universal in that model rather than treated as an
exploit.

§8.1 names the one regime where it inverts: above `x* = (1 − c) / (k_max(n) · β)`, the
self-referred loop is profitable. That threshold is published rather than hidden, precisely
because an advertised agent population is one that computes it in public and switches on
together. It is bounded by the same single `K_CEIL` clamp as everything else, so the floor
still cannot fall while it happens.

### What is actually worth automating, then?

Strategy, and it is encouraged rather than tolerated. Every rule is a get-method, so a
strategy is a computation over public state, not a guess about a hidden one. Four of them:

1. **Wait out the clock.** `k(t)` ramps from `k_min` to `k_max` over `T_ramp` since the last
   mint (§5.1); a bot that mints near the top of the ramp takes the largest rebate the
   ratchet allows — and still `k < 1`, so the floor rises on its mint like on any other.
2. **Run under your number** — below.
3. **Trade the floor band.** The ratchet buys only at or below `p_f = T / S` and `flush()`
   is permissionless (§4.3.1), so a program can verify the floor from the two counters,
   trade PRIMES around a bound it computed itself, and call the flush when the market sits
   under it. The floor is an accounting ratio and a standing bid, not a peg.
4. **Price a prime lot.** A prime at its turn descends from `P0(p)` toward
   `max(NPV(p) / 2, P0(p) / 3, MINT_PRICE)` over seven days and parks there (§4.4, D-88,
   D-99); the tribute
   NPV is a sum over public state, so a bot can value the lot and bid when the curve crosses
   its own number.

The honest one to automate is the referral key: a program running under a number you own pays its
10% referral line to you on every mint it makes (§4.1, §9.2). That is the operator loop and
the influencer loop in one sentence.

### Will a leaderboard show which players are bots?

No. That fact is not recomputable from chain state, and §9.1 forbids the interface showing
a number a reader cannot recompute. The project does not tag a transaction by who sent it,
so "agent share of mints" is not a figure this game can honestly publish either.

---

## Governance and risk

### Can any parameter be changed after deploy?

Essentially no (§11.1, closed). The economic core is **immutable at deploy**: the split
rates and caps, the `k` machinery (`K_CEIL`, `k_min`, `k_max(n)`, every uplift ladder and
window), tribute weighting, and every address the split pays.

**The only mutable surface in the entire system is the three DeDust venue addresses**, behind
a public timelock contract (`primes_venue_timelock.tolk`). That exists so that a DeDust v3 or
a retired pool cannot kill the flush path forever — and it cannot reach a single economic
parameter. It does decide where flush sends `pending`, so a change needs **two keys**: the
proposer queues it for 30 days, and the treasury's LP electorate must pass a vote confirming
it (D-194). That vote may open only at the END of the 30 days (it must close no earlier than
the change's `eta`), and only LP locked before a vote opens counts, so anyone who disagrees has
the whole 30 days to lock LP and vote no. (Like every treasury proposal it also has its own
one-day notice before its vote opens, so it is proposed a day before that.) A vote nobody casts fails, but the proposer's own LP
lock is a vote, so an empty electorate is not a defence — the notice is. The
Tonstakers staking addresses are fixed at deploy and nothing can change them.

Since D-100 there is a second thing a decision can move, and it is deliberately *not* a
parameter: the **treasury's money** can be spent by a vote (§5.5). No parameter changes when
it is, and nothing the ratchet depends on is reachable from it. See the next three entries.

### Why is even that one exception acceptable?

Because immutable parameters would otherwise mean hardcoding DeDust v2 addresses **forever**
(§11.3). If the venue died, the flush path would die with it and `pending` would accumulate
permanently with no route out.

A venue migration is therefore a **public, delayed, voted, venue-only** operation. The pitch
sentence survives intact.

### Who controls the treasury?

**Nobody with a key** (§5.5, D-100 point 7). `primes_treasury.tolk` has no owner field, no
admin opcode, no pause and no upgrade. There is no message anyone can send it that spends
money, and that includes the operator, and that includes on day one.

Money leaves it in exactly two ways, and there is no third:

- a **passed proposal**, or
- **`distribute()`**, which once every 30 days sends a fixed fraction of the treasury's PRIMES
  to the staking contract (§5.3, `DECISIONS.md` D-168 — it replaced the LP miner rule).

A proposal is one thing only: *transfer `{GRAM | PRIMES | tsTON}` to an address.* It cannot
change a parameter, call a contract, or upgrade anything — there is nothing in this system a
vote is allowed to reach. To spend, it has to clear all of this:

| | |
|---|---|
| Who may propose | someone holding **≥ 1%** of the eligible weighted LP, one open proposal at a time |
| Who votes | LP locked in custody for **30 days or more**, weighted `amount × 1/3/10/30` for the 30-day, 3-month, 6-month and 1-year terms, while the term is still running |
| Notice | **1 day** between proposing and the vote opening. LP locked during the notice votes no; a yes needs LP locked before the proposal; LP locked once the vote is open does not vote. |
| How long | **1 day** of voting after the notice — two days end to end |
| To pass | **more yes-weight than no-weight**. A tie fails. |
| How much | **at most 25%** of that one asset's balance, measured **when it executes**, not when it was written |
| Who executes | **anyone**, after the vote closes. A bounced execute can be retried. |

**`distribute()`** is the one payout nobody votes on, and the reason is that it cannot drain
anything: it pays a fixed *percentage* of what is left, once a month, so the balance decays
toward zero and never reaches it. A rule that cannot empty the treasury does not need a vote to
authorise it — and putting it to one would add a governance lever for no benefit.

**The honest part.** On day one, the electorate is **empty**: the operator holds no genesis
PRIMES and so no LP position since `DECISIONS.md` D-166, and nobody else has locked LP for
30 days yet. `getGov().eligibleWeight` reads 0 and no proposal can pass until someone locks.
"Holders govern the treasury" is true in mechanism from block one and empty in fact until
strangers show up. That is written into the spec (§5.5.5) rather than left for you to notice.
*(Until D-166 this read "the operator alone".)*

### What stops the treasury from being drained?

Three things, in the order they bite (§5.5.2, §5.5.5):

1. **The 25% cap.** No proposal can move more than a quarter of one asset, and the cap is
   measured at execute time — a proposal written against a richer treasury *fails* rather
   than emptying a poorer one. Each proposal is public for two days before it can execute —
   though several proposed together from several wallets wait those two days once, not each
   (D-130).
2. **The 1% proposer threshold.** Opening a proposal takes ≥ 1% of the eligible weighted LP
   — which only bites once the electorate is more than one wallet. *(This point used to be
   "the operator's own vote", a 6-month position at the 10× multiplier. D-166 deleted the
   operator's genesis lock and that position with it: the operator's LP, if they ever lock
   any, votes like anyone's, and no standing position outweighs a newcomer.)*
3. **A day of notice, then a day of voting.** The proposal, its destination and its amount
   are get-methods for a full day before its vote even opens, and its running tally for
   another day before anybody can execute it. The notice is what lets you act on what you
   see: lock LP for 30 days or more during it and you can vote no (a yes needs LP locked before the proposal was made). (Lock after the vote has
   opened and you cannot — that rule stops last-minute vote buying.) This was added on
   2026-11-19 after an audit showed the old rule let nobody new oppose anything
   (`DECISIONS.md` D-173's amendment).

**What the notice does not do.** It makes a spend *opposable*; it does not stop one. Somebody
has to see the proposal, get DeDust LP and lock it inside that one day, then actually vote no
during the vote. The proposer cannot answer that: a yes vote only counts LP that was already
locked when the proposal was made, so the opposition moves last (`DECISIONS.md` D-173's
2026-11-21 amendment). The notice beats any proposal whose up-front weight the watchers can
out-lock in a day; it does not beat a proposer who locked more than that before proposing. If nobody votes no,
a proposal passes on a single dust-sized lock.

**And the answer nobody should have to dig for: there is no quorum.** A single 30-day locker
can pass a proposal if nobody with more weight votes no. That was accepted in writing when
the design was signed (D-100 point 10b) rather than discovered later. A quorum was considered
and not taken: a quorum that is not met is a treasury that cannot act at all, which is the
failure mode a small early electorate would hit constantly.

**What a drained treasury would not touch.** Nothing in it is yours, and nothing in it is the
protocol's. It holds fee revenue — §4.1's 5% line on every mint (D-152), half of every
auction premium (D-114) and 58% of the unsold-prime tribute forfeits (D-166) —
plus the genesis vest (the only one since D-166 deleted the operator's). It holds **no `pending`, no `owed`, no purse and no refundable
money** (§3.4). The floor `p_f = T/S` cannot move because of anything that happens to it, and
`S` is untouched by every contract involved. The one thing it holds that belongs to somebody
else is **depositors' LP**, and a proposal cannot reach that: LP is not a proposable asset at
all (`DECISIONS.md` D-167).

### Does locked LP back the price?

**No.** This is the answer most worth getting exactly right.

The floor is `p_f = T/S` and **locked depth is never part of `T`** (§5.5.4, D-100 point 4).
The reason is not conservatism, it is arithmetic: an LP receipt is a claim on a pool whose
GRAM/PRIMES composition **moves with every trade**, so a term derived from it can *fall*. `T`
only ever rises, and the whole of §5 is a proof that `p_f` therefore only ever rises. Adding
a term that can fall would not weaken that proof — it would void it.

So there are **two guarantees, and they are on two different panels**:

| | What it is | Does it move down? |
|---|---|---|
| **The floor** | `p_f = T/S` — a redemption ratio backed by GRAM the protocol actually holds | **No.** Monotone by construction. |
| **Locked depth** | LP receipts sent to `primes_lp_sink.tolk`, a contract with **no outbound message type at all** | The *balance* never falls — nobody can withdraw it, ever. What it is *worth* moves with the pool. |

Locked depth is a **market** guarantee: this much of the pair can never be pulled, so the
pool cannot be abandoned by its own liquidity providers. That is worth saying plainly, and
worth exactly nothing to `p_f`. Any surface, doc string or API field that calls it backing,
collateral, or part of `T` is a bug — the same class of bug as an invented parameter.

*Why a sink and not a burn?* Because a sink is **readable**. Burning the LP receipt also
makes the liquidity unrecoverable, but turning a supply drop into "how much depth is locked
forever" needs an off-chain baseline somebody maintains. The sink's locked depth is just an
account's wallet balance, at any block, checkable by anyone.

### Can staking tiers be adjusted if they turn out mis-sized?

**Not by a message.** The terms and weights are fixed in the contract at deploy, like every
other rule here; changing them means a fresh deployment. The question used to be heavier
(§11.20): the old design sold a `k_max` uplift, an economic right people paid for, so a
mis-sized tier could never be corrected. `DECISIONS.md` D-168 deleted that design — a stake
now buys a share of a PRIMES stream for a term, and the term ends.

### Does staked PRIMES count as circulating supply?

It is shown **separately and never netted out** (§11.22). It is not burned and it can come
back, so the conservative treatment is three quantities rather than two: `S`, circulating,
and staked.

### Can the price trade below the floor?

**Yes, temporarily** (§12). The floor is a protocol ratio plus a *conditional* buy schedule
— **not an instant redemption price**. There is no redeem button.

The floor guard makes this materially better than it sounds: a price under the floor is the
one condition that **unlocks the entire accumulated ratchet balance** as a buyer. But it must
be communicated plainly, and it is not a promise.

### What is the honest failure mode?

**Participation stalls.** The floor holds, nothing grows, and the game dies quietly (§12).
This is accepted: it harms nobody who read the documents.

The related caveat matters and is easy to misread: §5.4's late-game "rotation" describes how
each mint's value **divides**. Every leg on the asset side — divisor tribute, the flat
dividend, the referral key — is paid **out of a mint**. So the rotation describes a protocol
that is still moving. It does **not** rescue one whose head has stalled, and a reader taking
it as insurance against the failure mode above has read it wrong. That is the same failure
mode, not a second one.

### Where can the numbers on the dashboard be verified?

**Every number the UI shows maps to a public get-method** (§9.1). No dashboard stat exists
that a reader cannot recompute from chain state. If you find one that does not, that is a
bug against §9.1, not a design choice.

### Why is there no "bank"?

Because it was an undefined noun doing four jobs, and the word is **retired** (§3.4).

There are **two separate pools of GRAM with two different owners**, each in its own
contract so that `balance ≈ declared liability` is checkable in one get-call:

| Component | Holds | Whose money |
|---|---|---|
| **Ledger** | `owed` | the prime owners' |
| **Ratchet** | `pending` | nobody's |

The **treasury** added by D-100 is not a third one, and the reason is which GRAM it holds: fee
revenue that nobody is owed. It holds no `pending`, no `owed`, no purse and no refundable
money, it has no key, and it spends only by a passed proposal or by `distribute()` (§5.5).
The **LP sink** holds no GRAM liability at all — it declares no outbound message type, so
there is no withdraw path to guard rather than a guarded one.

There was a third — an **escrow** holding refundable reservation money — until D-90 deleted
it. A won lot now mints in its own closing transaction, so **no contract in this system
holds refundable customer money at all**, which makes the solvency check shorter rather than
longer.

"Bank" was rejected because it claims custody-and-return, which is the one thing this
protocol never does. Fusing them was what made the balances unreconcilable in the first
place.

---

## Document map

| Read this | For |
|---|---|
| `CONCEPT.md` | **The specification.** Everything else defers to it. |
| `FAQ.md` | This file — why the spec says what it says. |
| `DECISIONS.md` | Owner decisions, with the cost of each stated. |
| `docs/math-note.md` | The ratchet theorem, formally. |
| `docs/testnet-deployment.md` | Live testnet addresses. |
| `shared/params.json` | Every simulation-derived constant. Generated, not hand-edited. |

**Never hand-edit an economic parameter.** Simulation-derived constants come from
`sim/scripts/run_phase1.py`. `CONCEPT.md` states the proposals and the constraints; the sim
decides the values. A number in a contract or in the UI that traces to neither is a bug.
