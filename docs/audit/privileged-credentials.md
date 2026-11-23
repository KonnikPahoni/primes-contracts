# Privileged credentials, and who controls the money in year three

CONCEPT.md §8 says there is **no admin withdraw path on any GRAM balance, not
timelocked, not multisig**, and `NoAdminWithdraw.spec.ts` proves it against
`withdraw-surface.md`'s enumeration of every outbound send. That claim is true and it
is narrow. It is a claim about **moving GRAM**, and a reader who takes it as "there are
no privileged keys at all" has read more into it than it says.

So this page is the other half: **every standing credential in the system, what it can
do, what it cannot, where the chain publishes it, and which test bounds it.** There
are two kinds (§2's are two keys since R2-M2). (D-202 deleted the ledger's invite-list signer; `DECISIONS.md` D-211 added §3, the operator's invite-words setter, in its place.) Each was already honest in its own source file; what was missing was one
place that lists them together, which is the difference between an accurate claim and
a credible one.

Enumerated from source, not from memory:

- **Address credentials** — every `in.senderAddress == …` comparison across all 21
  contracts, minus the ones naming a peer protocol contract (a fixed or derived address
  that is itself bound by these same rules, and whose own sends are in
  `withdraw-surface.md`). Exactly two survive: the venue timelock's proposer and, since
  D-211, the ledger's `operatorAddr` on `set_invite_terms` (`set_invite_text` until D-215).
- **Key credentials** — every `isSignatureValid(…)` call site. They hold one key, the
  voucher signer's.

**The other half of each row is [key-loss.md](key-loss.md)** (`GAUNTLET.md` X6): this page is
the inventory — what exists and what each can do — and that one is the failure story, what
stops working the day each is lost and which of them cannot be replaced without a genesis
redeploy.

`sender-gates.md` is the machine-generated census these were read off; it classifies
every arm on every contract as authorised or deliberately permissionless, and
`SenderGates.spec.ts` fails the build when an arm appears in neither.

**Section 4 is a different question and it is here because the answer is next door.** The
three credentials above are what exists *today*; the owner's stated succession plan for year
three is the treasury's governance, and how thin its electorate may legally be is the single
most important fact about who controls this money over a decade. Until now it lived only in a
source comment (`GAUNTLET.md` X5).

---

## 1. The venue proposer — `primes_venue_timelock.tolk`

| | |
|---|---|
| **What it is** | An address, `Storage.proposerAddr` (`primes_venue_timelock.tolk:82`), fixed in the contract's deploy-time (address-determining) data. |
| **What it can do** | `queue` and `cancel` a change to the **seven venue addresses** `primes_ratchet.tolk` trades and stakes into: the three DeDust addresses `flush()` sells into, plus §4.3.2's Tonstakers pool, tsTON vault, tsTON pool and **harvest destination** (D-151). Nothing else. The harvest destination is the one worth reading twice — this key can re-aim where accrued yield is sent, after thirty days in public view, while still touching no term of `T`. |
| **What it cannot do** | Move GRAM or PRIMES; touch `T`, `S`, `pending` or any `owed` balance; change treasury routing; alter any compiled-in economic parameter; or execute its own proposal early. The contract's own header calls it "the ONLY privileged credential", and that is the finding this page confirms rather than the claim it repeats. |
| **What bounds it in time** | `TIMELOCK_DELAY` = 30 days (`:70`). A queued change carries an `eta` and `execute` is **permissionless** — anyone may push a matured change, and nobody can push an unmatured one. **It is also not enough alone** (`DECISIONS.md` D-194): `execute` refuses a record the treasury's LP electorate has not confirmed (804), and since the 2026-11-19 amendment (audit H1) the confirming vote must close at or after `eta` (808), i.e. open no earlier than `eta − voteDuration`. Only LP locked before a vote opens counts (treasury 1202), so every holder has the whole 30 days to lock and vote no; an empty electorate is not a defence, because the proposer's own lock votes. |
| **How a reader sees it** | The *pending action* is published: `getQueued()` returns `(hasQueued, fired, dedustNativeVault, dedustPool, primesJettonVault, eta, staking)` — every address the pending `execute` will write, the staked reserve's block (§4.3.2 / D-151) included as the same opaque cell `update_venue` will carry, decodable with `ratchet.tlb`'s `VenueStaking`. So any proposal is visible **in full** for its 30 days before it can land. The *holder* is not on a get-method — it is a storage field, readable off-chain from the account's data cell like any other, and it is address-determining, so it is also recoverable by re-deriving the contract address from its init data. **Stated rather than glossed:** there is no `getProposer()`. |
| **What bounds it in test** | `PrimesVenueTimelock.spec.ts` — "rejects queue from a non-proposer sender", "rejects cancel/queue from a non-proposer, and cancel with nothing queued", "rejects an eta below the 30-day minimum delay", "rejects execute before eta matures", and "queue → wait 30 days → permissionless execute updates the ratchet venue addresses". |

**Why this credential exists at all.** A DEX venue address is not a constant: a pool can
be redeployed, and a `flush()` pointed at a dead vault is a `flush()` that cannot sell.
The alternative to a timelocked proposer is a hardcoded address that can never be
corrected, which fails closed in the worst possible way — silently, on the one path §5's
floor depends on.

---

## 2. The quest voucher signer — `primes_voucher.tolk`

| | |
|---|---|
| **What it is** | **Two** Ed25519 public keys since audit 2026-11-19 R2-M2 (`DECISIONS.md` D-171, amended 2026-11-20): one per service-signed instance, each `Storage.signerPubkey` (`primes_voucher.tolk:113`) fixed at deploy — `QSTS` (§9.4 social board, `QUESTS_VOUCHER_SIGNER_SECRET_KEY`) and `PQST` (contract-fact quests, `PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY`). The attribution service holds both private halves. Genesis refuses any two instances — these two and D-170's owner-held `SECU` — on one key. |
| **What it can do** | Sign, for its own instance only, a voucher naming a wallet and a **cumulative** PRIMES total (`:273`) up to that instance's per-wallet cap, and sign the one-shot program burn that sets the claim deadline (`:289`). |
| **What it cannot do** | Move GRAM. Name itself as a beneficiary in any sense that pays a bearer — a voucher is signed **for a specific wallet** and nobody else can redeem it. Pay one wallet more than the instance's write-once `maxPerWallet` (`:159`): a signed total above it is refused 716 (`:331`) before the receipt is touched, and the receipt stores the total, so this bounds the wallet's lifetime payout. Exceed the program's budget: the PRIMES come from `primes_bounty_vault.tolk`'s allow-list entry, and `remaining` is genesis-fixed there, so a total past it is refused **by the vault**. Spend the other track: the instance's key and tag are both in the check. Pay twice: totals are a high-water mark, so a replay settles to zero. Strand an earned balance: the burn cannot set a deadline inside `BURN_MIN_GRACE`. |
| **How a reader sees it** | `getSignerState()` returns `(signerPubkey, burnedAt, claimDeadline, minGrace, programTag)` — the key itself, on chain, so "the key that signs is the key baked in at deploy" is checkable by inspection and a holder can verify a voucher **off-chain before spending gas on it**. `getMaxPerWallet()` returns the per-wallet cap. `isProgramClosed()` answers the time question on its own. |
| **What bounds it in test** | `PrimesVoucher.spec.ts` — "a voucher signed by the wrong key is refused", "a voucher is NOT bearer paper: bob cannot redeem a voucher signed for alice", "REPLAY PAYS ZERO", "a signed total above the genesis-fixed budget is refused BY THE VAULT, and rolls back", the "R2-M2: the per-wallet cap" block (at cap pays; cap + 1 refused 716 with no receipt and no PRIMES; two vouchers cannot pass it; replay after it pays zero), "a program that is NOT allow-listed cannot pay, however valid the signature", "is authenticated by the KEY, not by an owner", and "CANNOT strand an earned balance: the grace floor is an on-chain assert". `GenesisRehearsal.spec.ts` — "every voucher instance carries its params.json per-wallet cap", "genesis refuses to deploy two voucher instances on one key", and the prime-quests key test. |

**The honest shape of the risk.** A stolen service key can sign vouchers for **its own
track only**, each at most one wallet's cap (`QSTS` 2,450 PRIMES, `PQST` 6,350 —
params.json via `shared/voucher.ts` `VOUCHER_MAX_PER_WALLET`). Draining a track therefore
takes about 1,000 fresh wallets, each claim carrying its own ≥ 0.15 GRAM — a slow, visible,
paid attack rather than one transaction, and still bounded by the allow-list entry. It
cannot reach the ratchet, the ledger, any GRAM balance, or one PRIMES beyond that entry.

**When it pays the thief.** One claim costs ~0.15 GRAM (`CLAIM_MIN_VALUE`) and yields one cap,
so at floor `p_f` it is worth `cap · p_f` GRAM. It breaks even at `p_f = 0.15 / cap`: on `QSTS`
0.15 / 2,450 = 6.12e-5 GRAM per PRIMES, **≈ 5.7×** the opening floor (`p_f0` =
`genesis_floor_price_ton_per_primes` = 1.0769e-05); on `PQST` 0.15 / 6,350 = 2.36e-5, **≈ 2.2×**.
Below those multiples a stolen key loses its holder GRAM on every claim; above them it is a
profit at the floor, which is why the key split and storing the keys apart still matter.

**What the split does not buy.** Both service keys live in the same `.env` on the same host
and are read by the same process. A host compromise takes both, and with them both tracks
(8.8M PRIMES at ~1,000 wallets each). The two-key split narrows a leak of ONE key — a logged
secret, a copied env var, one misconfigured service — and helps against a host compromise
only if the keys are stored apart. There is still no pause and no rotation (a new key is a
new genesis); the burn needs 90 days' grace.

---

## 3. The invite-words setter — `primes_ledger.tolk` (D-211)

(It replaces D-202's deleted invite-list signer: `inviteSignerPubkey`, `SetInviteConfig` and
`getInviteConfig()` are gone, and there is still no list for anyone to sign.)

| | |
|---|---|
| **What it is** | An address, `FeeDests.operatorAddr` — the operator's wallet, fixed in the ledger's deploy data with no setter. Before D-211 it was a pay destination only (the forfeit's 42%). |
| **What it can do** | `set_invite_terms` (D-215): replace `Config.inviteText`, the words at the start of every later invite transfer's comment, AND `Config.inviteCount` / `Config.inviteValue` — how many invites a mint may fund and what each delivers. That sizes §4.1's invite line, a split line, between 0 and 0.31 GRAM of every mint. Nothing else. |
| **What it cannot do** | Move GRAM or PRIMES to itself or to any address it names — the recipients are the minter's; take the invite line past `INVITE_LINE_CAP` = 0.31 GRAM including fees or past `INVITE_COUNT_CEILING` = 100 transfers (refused 238, at the setter and at every mint), so β never drops below 0.24; remove or alter the link — `inviteComment(n)` writes ` primes.live/?ref=<n>_tg` after the words itself; write more than 86 bytes, a ref, or a partial byte (refused 237). |
| **What bounds it in time** | Nothing: a change applies to the next invite mint. |
| **How a reader sees it** | `getInviteTerms()` returns the live count and value beside the three fixed bounds; `getInviteText()` the live words; `getInviteComment(n)` the exact body for `n`. |
| **The honest shape of the risk** | A stolen operator key can make the ledger send its words — with the real link after them — to every invitee the keeper pre-fills, paid by honest minters' invite lines, until the owner sets them back; and it can move up to 0.31 GRAM of every mint between the ratchet pool and the minter-named invitees (or set the count to 0 and switch invites off). That is a reputation and floor-growth risk, never a money path to the key holder. |
| **What bounds it in test** | `InviteTransfers.spec.ts` — "D-211: the operator rewrites the words; the next invite carries them, at the cap, with the link" and "D-211: anyone but the operator is refused 100; over-long or ref-carrying words are refused 237". |

---

## The fourth thing a reviewer will find, and why it is not on the list

`genesisScriptAddr` appears in almost every contract and is compared against the sender
on a `SetLedger` / `SetCollection` / `SetWallet` / `SetRatchet` arm.
It is a **bootstrap credential, and it is spent.** Each of those arms is one-shot behind
its own flag (`walletSet`, `collectionSet`, `vaultSet`, `ratchetSet`, …) and refuses a second
call with `already_processed` (104). The flags are published — `getVaultConfig()` returns
`walletSet`, the registrar's `getPeers()` returns `collectionSet`, `getVault()` returns `vaultSet` —
so "the bootstrap is closed" is a read, not a promise. One-shot-ness is tested per
contract (for example `PrimesBountyVault.spec.ts`'s `SetWallet` replay returning 104).

It is named here rather than omitted precisely because a reviewer grepping for sender
gates *will* find it, and an undisclosed credential looks worse than a spent one.

---

---

## 4. Governance — the succession plan, and how thin its electorate may legally be

`GAUNTLET.md` X5. The three credentials above are what exists *today*. This section is about
who controls the money in **year three**, because the answer is not a credential at all: it is
`primes_treasury.tolk`'s governance (D-100), and the owner's stated succession plan is that
holders propose and vote GRAM out of it. That mechanism is built, tested and surfaced at
`/treasury`.

**What was not published anywhere a holder reads is how thin the electorate may be.** The
contract states it plainly in its own header and this section exists so that a reader does not
have to find it there. **None of it is a defect** — it is D-100 point 8 as signed, and point 10
accepts the consequences in writing. It is also the single most important fact about who
controls this money over a decade.

### The rule, verbatim from the contract

| | |
|---|---|
| **Vote** | One day, **simple majority of votes cast, NO QUORUM** (`primes_treasury.tolk:162`). |
| **The electorate** | Positions in the tiers at **30 days and above** — `VOTE_MULT` is `0` for instant/1-day/7-day, then `1` (30d), `3` (3mo), `10` (6mo). Weight is `amount × voteMultiplier`, a pure function of the position: no snapshot, no oracle, no `p_f` read (TR-7). A position in withdrawal cooldown does not vote. |
| **So a lone voter can pass a proposal** | Stated in the contract's own words: *"with no quorum a single 30-day locker passes a proposal unless someone with more weight votes no"* (`:179`). |
| **On day one the electorate is EMPTY** | The operator holds no genesis PRIMES and no LP position since `DECISIONS.md` D-166, so the "operator's 6-month position at 10×" this row used to name as the stated defence does not exist (corrected 2026-11-19). The operator's LP, if any is ever locked, votes like anyone's. No standing position outweighs a newcomer. |
| **The defences, all rules** | A **25% cap** per proposal (`PROPOSAL_CAP_BPS = 2500`, of that asset's balance **at execute time**, not at open); **a day of notice and then a day of voting** before anything can execute — two days in total, and total across a multi-wallet proposer, not per proposal (D-130); and a proposer must hold at least 1% of the electorate's weight (`PROPOSE_MIN_BPS`) and may have one open proposal at a time. |
| **A notice before every vote** (added 2026-11-19, `DECISIONS.md` D-173's amendment, audit R2-H1) | `NOTICE_DURATION` = 1 day (`treasury.notice_duration_seconds`). A proposal's vote opens that long after it is proposed (`opens = proposed + notice`); a vote before it is refused (`treasury_vote_not_open`, 1206). Only weight held since before `opens` votes (1202), so **LP locked during the notice votes no (a YES only with weight held since the proposal was made — D-173, 2026-11-21) and LP locked once the vote is open does not**. A spend is two days end to end. This makes a proposal opposable by a holder who reacts within a day; it does not stop one nobody opposes, and the proposer may lock more during the same notice — up to its last second, after which no defender lock counts, so a proposer with more locked LP than the opposition still passes. |
| **A tie does not pass** | Simple majority means strictly more yes than no; `Treasury.spec.ts` — *"refuses an execute on a tie — the incumbent state keeps the money"*. |
| **Execute is permissionless** | After `closes`, anyone may push it: the destination and amount were fixed when the proposal opened and no field on `execute` names either, so who calls it cannot matter. A bounced execute resets `executed` and is re-executable. |
| **An EMPTY electorate** | No eligible weight means no proposal can open at all — `Treasury.spec.ts`'s *"refuses a proposal from a wallet with no eligible weight"* and *"refuses a proposal from below 1% of the electorate"*. The failure mode of an abandoned project is **paralysis, not capture**: the money stays where it is. |
| **Published, not just written** | `getGov()` returns `(proposalSeq, eligibleWeight, PROPOSAL_CAP_BPS, PROPOSE_MIN_BPS, VOTE_DURATION, NOTICE_DURATION)` — the live electorate weight and all four thresholds from the contract itself, which is what `/treasury` renders (§9.1). |

### What the treasury can and cannot reach

This is the half that bounds everything above, and it is why a thin electorate is a bounded
risk rather than an unbounded one. From the contract's own header (`primes_treasury.tolk:17-24`):

> **Nothing in this file can move `T`, `S`, `pending`, `owed`, `k`, `K_CEIL` or the five-way
> split, and nothing in it mints.**

`pending` is the ratchet's and `owed` is the prime owners' — §3.4 puts each protected pool in
its own account precisely so that a contract which *can* spend is distinguishable at a glance
from one that cannot. §11 Q1 said the economic core is immutable; D-100 point 7 reopens it
**narrowly and only here**, on the grounds that the treasury was never part of that core.

Depositors' LP is not the treasury's to propose either: for LP, "the asset's balance" is
`ownLp` and not the wallet, which is invariant **TR-5** (`Σ positions[].amount == LP wallet
balance − ownLp`), enforced as an access rule rather than only asserted in a test.

**There is no admin inbound at all** (D-100 point 7): no `update_config`, no owner field, no
pause, no upgrade, no beneficiary change. The only one-shot message is `set_wallets`, the same
circular-address bootstrap every jetton-custody contract here needs, and it is spent.

### What bounds it in test

`contracts/tests/Treasury.spec.ts` — *"publishes the vote parameters it enforces"*, *"refuses a
proposal from below 1% of the electorate"*, *"refuses a proposal from a wallet with no eligible
weight at all"*, *"allows one open proposal per proposer, and a second once the first closes"*,
*"tallies one wallet one vote at its full weight, and refuses a second"*, *"refuses a vote after
the window closes"*, *"refuses an execute on a tie"*, and *"reports the six tiers from the
contract, not from a config file"*.

**This section is disclosure only.** It adds no quorum, changes no tier and re-opens no part of
D-100. `DECISIONS.md` D-130 is where the calendar-vs-fraction question about the proposal cap
is briefed, and it is a separate, open question.

---

## What this page does not do

It does not add, remove or re-scope a credential, add a quorum, change a tier or re-open any
part of D-100 — it is disclosure only. It also does
not claim the three keys are **operationally** well held: where the private halves live,
how they are rotated and what happens if one leaks are operations questions, and
`threat-model.md` is where they belong.

Kept honest by `PrivilegedCredentials.spec.ts`, which re-derives the credential set from
the contract sources — every `isSignatureValid` call site and every non-peer sender
comparison — and fails if one appears that this page does not name.
