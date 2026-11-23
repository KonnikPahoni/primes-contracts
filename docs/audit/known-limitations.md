# Known limitations and accepted risks

`GAUNTLET.md` Track I, item I5. `docs/audit/scope.md` (I1) drew the boundary,
`threat-model.md` (I4) named the actors and trust boundaries, `invariant-coverage.md`
(I3) and `test-coverage-map.md` (A3) proved what is tested. This document is the last
piece an auditor needs before it all adds up to a verdict: **the things that are true
about this repo today, on purpose or not yet fixed, that the other seven documents do
not already resolve.** Nothing here is a surprise to the team — every line either cites
a signed `DECISIONS.md` entry (the owner already chose to accept the risk) or an open
one (the owner has not yet chosen, and the option analysis is already written).

This is a judgement document, not a regenerated one, and it goes stale the moment a
`DECISIONS.md` status changes from `open`/`pending` to `signed`/`closed` — whoever closes
one of the open items below should update this file in the same change, the same rule
`CLAUDE.md` states for CONCEPT.md drift.

## 1. Accepted-by-design (owner has already signed off)

These are not bugs; they are choices, made deliberately and cheaper to document than to
build around. Listed because an auditor reading the code cold could mistake any of them
for an oversight.

- **The number line ENDS. `AUCTIONABLE_MAX = 42949672959999`** (10⁴·2³² − 1, ≈4.29·10¹³,
  fourteen digits) is the largest `n` this protocol can mint or auction, asserted on every
  entry point that takes an `n` (`primes_market.tolk`, and mirrored by the ledger's
  `OMEGA_MAX` derivation). It is not a rate limit or a phase-one setting — it is the last
  number, and nothing in the system raises it. Signed **D-11/D-18**; CONCEPT.md §3.2 uses
  it as the input to the ω(n) ≤ 12 bound (37# ≈ 7.42·10¹² fits under it, 41# ≈ 3.04·10¹⁴
  does not), and it is what makes Miller–Rabin overflow-safe here: at n < 2⁴⁶ a squared
  residue stays under 2⁹², four orders inside int257, so the 78-digit argument that threw
  exit 4 as `P2.C1` has no reachable value left. **Reaching it is a horizon, not a risk:**
  mints are strictly sequential at 1 GRAM each, so the head arriving at the cap would mean
  ~4.29·10¹³ mints. Listed here because a reviewer reading the app sees an unbounded
  number line and either misses the ceiling or finds it in the contract and reports it as
  undisclosed. Bound to the contract by `contracts/tests/ReservableCap.spec.ts` — the
  figure above is compared against `primes_market.tolk`'s own constant, never retyped by
  hand.
- **`T` is not `swapped + pending`.** The ledger's `T` (ratchet numerator) includes a
  `seeded` term — founder capital genesis credits straight into `T` to back `S` from the
  DeDust LP, and it never passes through `pending`. A two-term reading reports a
  permanent, false "solvency gap." Signed **D-26** (2026-08-19); pinned by `C3`'s
  three-term property test. `CLAUDE.md`'s own invariant list states this explicitly so
  the mistake is not repeated.
- **`flush()` bounces every time on testnet, and that is correct.** The DeDust vault
  address configured today is a throwaway stand-in with no real liquidity pool behind
  it — every `Flush` that clears the cooldown and finds `pending > 0` sends a real
  message that bounces for lack of a pool, and `getFlushStatus().lastOutcome` records
  `Bounced` honestly. Proven live in **H6** (2026-08-29): a brand-new, never-used wallet
  flushed permissionlessly and got the identical state-based rejection any wallet would.
  Not a defect — it is what "no real DEX pool exists yet" looks like from outside.
- **The swap payload's wire format is verified against DeDust's published schema and
  round-trip proven against a schema-faithful mock vault — still not against a real,
  live DeDust pool.** Filed as **GAUNTLET V2** (2026-09-09): the pre-fix payload (`op`,
  `query_id`, `coins(min_out)` and nothing else) had no `pool_addr` and no
  `swap_params` ref at all — checkably wrong, not merely unverified, against
  `docs.dedust.io/reference/tlb-schemes`. Rebuilt field-for-field against that
  published schema (`primes_ratchet.tolk`'s `handleFlush`, `shared/schemas/ratchet.tlb`).
  `WireFormatDeDustSwap.spec.ts` parses the real outbound cell field-by-field to prove
  it matches. **V2.1** (2026-09-09) went a step further: `contracts/test-mocks/
  mock_dedust_vault.tolk`, a TEST-ONLY contract (never deployed, no opcode in
  `shared/opcodes.ts`, excluded from every `docs/audit/*` generator's contract count)
  parses the real schema and genuinely fills or genuinely throws on a slippage
  rejection, and `MockDedustVaultSwap.spec.ts` proves the ratchet's `TransferNotification`
  fill-detection (GAUNTLET B2.1) and `onBouncedMessage` bounce-reversal both round-trip
  correctly against it — stronger than every other flush-path spec, which stands a
  plain treasury in for the vault and would accept any payload at all. What this still
  does NOT prove: that a REAL DeDust pool, running DeDust's actual deployed bytecode,
  accepts this exact cell. No live testnet pool exists (the bullet above) — that would
  need an owner action (funding a real pool) this loop cannot take on its own.
- ~~**Patron mode goes negative-EV for the patron above `n ≈ 1173`.**~~ **RETIRED
  2026-09-07 — the mechanic no longer exists.** `DECISIONS.md` **D-106** deleted patron
  mode in its entirety (the §4.1 patron line, `patronOf`, `PATRON_CAP`, the purse and the
  whole ownerless-item lifecycle) and amended **D-57**, which is what put this entry here.
  Kept rather than deleted because an auditor who read an earlier copy of this pack, or
  D-57 itself, deserves to be told where it went rather than find it silently absent.
  **What replaced it:** §4.7's recruit ladder now runs on the §4.5 gift-mint edge — a
  gift to an address the ledger's `minterState` has never seen credits the payer +1
  recruit — which pays **no GRAM at all**, so the negative-EV question this entry asked
  has no referent. There is no cap to decay, because nothing is paid back.
- **A Telegram alert page can be silently dropped if two ERROR/CRITICAL lines land in
  the same fluent-bit flush window** — the second is coalesced away before it reaches
  Telegram. Accepted, not fixed, alongside **G9d** (2026-08-29): every alert record is a
  clone of a `docker.*` record, so the full record still reaches Cloud Logging via that
  parallel route regardless of whether the Telegram page itself lands — a human paged by
  the surviving alert can always pull the complete picture there.
- **Special composites above 1 GRAM is a named, bounded exception, not a lane leak.**
  `CLAUDE.md`'s "no lane may terminate above 1 GRAM" invariant carries one signed carve-out
  (**D-47**/**D-64**, §9.6): a special number's post-decay parked price may remain above
  1 GRAM until bought, via a vault purchase and re-listing rather than a lane exception.
  `C6`/`C6.1` pin that this is the only exception in the route-selection function.
- **`STAKE_UPLIFT_MAX = 0`.** Staking ships live but buys nothing — signed **D-34**
  (2026-08-19), gated pending a future sim answer on headroom sizing. **B11** proved the
  gate holds and the disabled path cannot be reached; the custody arms (`Unstake`,
  `TransferNotification`) are live and tested independently of the uplift being zero.
- **English only.** The RU bundle was deleted rather than left to drift — signed **D-74**
  (2026-08-29) — while the app is still in active development; re-localizing is a future
  decision, not a regression.
- **No operator PRIMES allocation at genesis, but a 9-month vesting grant exists.**
  Signed **D-46** (disclosed operator genesis allocation, no seeded/burned LP at deploy),
  **D-77** (2026-08-29, nine equal tranches 90 days apart, no admin surface on the vesting
  contract) and **D-91** (2026-09-01, re-cut to four equal 25% tranches 90 days apart, the
  last at day 270, when the allocation's purpose changed from the pool's PRIMES side to an
  operations runway). D-91's own point 3 records the cost it accepts: **25% — 500,000
  PRIMES, ~4.17% of `S₀` — is liquid at block one**, against D-77's 1.85%. All are on-chain
  and auditable via `getVesting`/`getVestingSchedule` (live since **E14a**, 2026-08-29).
- **`read-proxy`/`event-poller`'s `/health` were liveness-only; both now publish
  `degraded`.** Signed **D-70** (2026-08-31, `read-proxy`: a rolling 60s/3-failure window
  of classified upstream errors) and **D-71** (2026-08-31, `event-poller`:
  `consecutiveFailures >= 2`, threaded from the poller loop's own already-tracked state).
  `keeper` was deliberately left liveness-only per D-71's own analysis — its two candidate
  signals each answer only half of "is this keeper actually working," which is a real
  design call, not a same-run one. Closed `GAUNTLET.md` **E1.1**/**E8.1**.
- **No subresource-integrity or signed-manifest check protects the mint builder from a
  compromised deploy host.** Signed **D-76** (2026-08-31, option 3: accepted risk, no
  code) — genuine protection needs new runtime security code on the mint's hot path, and
  this is pre-launch testnet with no funds at risk yet. **This remains the single largest
  true security gap in the stack that is not a contract bug** (D-76's own framing,
  unchanged by accepting it) — revisit alongside `F12b` once a mainnet date exists.
  Closed `GAUNTLET.md` **I4.1**.
- **The treasury can be drained by a proposal nobody opposes — ACCEPTED RISK, do not
  re-open** (owner, 2026-11-21, `DECISIONS.md` D-173's 2026-11-21 amendment; audit R2-H1).
  There is **no quorum**, and the electorate is **empty at launch** (D-166). So a wallet with
  a dust 30-day LP lock passes a 25% spend of one treasury asset two days after proposing it,
  unless someone sees it during the one-day notice and votes no with more weight. A YES needs
  weight held since the proposal's own second, so the proposer cannot top up during the notice
  and the defenders move last. A proposer who locked more BEFORE proposing than the defenders
  can lock in a day still passes, and `w` wallets take `1 − 0.75^w` in the same two days
  (D-130). It reaches the treasury's GRAM, PRIMES and tsTON only — never `pending`, `owed`, `T`
  or `S`. A quorum was weighed and declined twice (D-100 point 8, D-173 2026-11-19: an empty
  electorate would pass nothing). The only mitigation is operational: launch gate M4's
  proposal alert and standing LP lock (`docs/mainnet-launch-gates.md`). Bound by
  `Treasury.spec.ts` (the R2-H1 tests) and `VenueGovernance.spec.ts`.

## 2. Open decisions — brief written, owner has not yet chosen

Each of these has a full options-and-recommendation brief already sitting in
`DECISIONS.md`; nothing below is a gap in analysis, only in sign-off. Referenced by ID so
whoever signs one can grep straight to it.

| ID | One line | Where it bites |
|----|----------|----------------|
| **D-48** | Delete `primes_item.getRarityFlags()`/`getIsUnity`, or keep them? | Dead-code question, no economic exposure. |
| **D-50** | `open_head_lot` lets anyone permanently occupy contract storage for ~0.02 GRAM gas — bound it how? | A storage-griefing vector on the auction lane, cheap to execute, not yet capped. `B3.1b` is blocked on this and on a second, sharper conflict: `CLAUDE.md` rule 3 (never invent an economic parameter) versus D-50's own delegation of "size the deposit/cap" to the implementing iteration — this loop cannot pick a number under its own standing authority. |
| **D-51** | A bounced `MintItem` leaves the registrar's naming rights and prime rank permanently wrong. | Reachability proven on a real test (`RecordMintBounceGap.spec.ts`, **B5.1**); the owner signed a direction (bounce-aware registrar) but a later mechanism-clarification pass (iter #9) found the signed brief pointed at the wrong contract's `onBouncedMessage` and left the undo semantics (unconditional clear vs. guarded) unresolved — still open pending a second, sharper sign-off. |
| **D-52** | A bounced rebate mint is silently lost and permanently inflates `S`. | The ratchet's own floor denominator can drift upward against value nobody received. Signed once (`S` rollback + retry re-send), then found not-yet-safe-to-implement-as-signed at iter #10 — a live conflict note, not a stalled brief. |
| **D-53** | A bounced era/special-number bounty is marked paid but never delivered. | Same shape as D-52, three siblings (`B12.1`, `B5.3`, `B11.1`) folded into one decision so the owner answers "retry journal or accept the loss" once. |
| **D-54** | §4.7/§4.7.1's "rank buys a tribute multiplier" claim has no code behind it. | A CONCEPT.md claim with nothing checkable behind it — wire it or strike it. |
| **D-55** | Rebate vesting (`VEST_NOW`/`VEST_H`) does not exist in code. | §8.1 calls the current state "a prevented risk-free race"; today it is simply the current, unprevented state. Doc-vs-code drift, not a fund-safety issue. |
| **D-72** | A composite's storage runway (D-62's ~9-year rent clock) has no client-reachable data to render at all. | Blocks a `DESIGN.md` surface, not a fund-safety gap — the top-up path itself is already signed (D-62, option 2) and built. |
| **D-73** | `/connect`/`/story` bot commands are unregistered because bot-side quest scoring is deliberately v1.1. | A live-paying quest (`story-verified-reach`) whose only advertised delivery channel does not exist yet — sequencing gap, not a security issue. Blocks `S11b`. |
| **D-75** | `tokens.css` is "dark only, on purpose," but `F10b` asked for Telegram theme-syncing. | A design-vs-engineering conflict on a cosmetic surface, no economic or custody exposure. |
| **D-78** | S86's vesting-lock UI needs a read-proxy route design-iteration cannot add itself. | Scope-boundary escalation, not a risk question — `GET /vesting` already exists (E14, E14a) once the owner or an in-scope loop wires the read; the design lane is blocked only on that plumbing existing, which it now does. |
| **D-194** (2026-11-19 amendment, residual) | A flush-venue change passes against a passive LP electorate; the owner-approved fix (audit H1) makes the confirming vote close at or after the record's `eta` (808), so every holder has the 30-day notice to lock LP and vote no (only LP locked before a vote opens counts, 1202). NOT yet ruled: the record has no expiry and the proposer picks when after `eta − voteDuration` the vote opens, so an opponent must keep a term running (a same-tier relock before maturity keeps `weightSince`, `primes_lp_position.tolk` `Relock`) until the record is confirmed or cancelled. | No quorum: the proposer key plus a dust lock re-points `flush()` if nobody opposes inside the notice. Bound by `VenueGovernance.spec.ts` and `PrimesVenueTimelock.spec.ts` (808). |


## 3. Structural gaps — real, not a decision away, blocked on time or resources

Not owner-decision items. These need either real wall-clock time to elapse on the live
testnet deployment, or more GRAM in a wallet than this loop has authority to mint from
nothing (`CLAUDE.md` rule 3 — a gauntlet iteration cannot fund itself an economic input).

- **H4/H5 — the ascending lot's CLOSE, which mints, unproven on the current genesis.**
  *(Read — this entry was "settle/claim, and the release-for-90% path" until
  `DECISIONS.md` **D-90** deleted all three: the escrowed claim, the permissionless
  `settle(n)` and D-32's release right with its 90/10 split. A won lot now mints the
  number in the transaction that closes it, so `close(n)` is the whole of what is left
  unproven here. The entry already cited D-90 for the redeploy below without updating
  its own subject — corrected rather than left standing.)* D-45 deleted the
  early-close-on-head-arrival shortcut for ascending lots; `close(n)` now asserts
  `blockchain.now() >= rec.closesAt` unconditionally, and
  `closesAt` is `open time + AUCTION_WINDOW` (7 real days). **Updated 2026-09-04
  (Sweep #19, iter #351) — the E14a genesis this entry described is dead**: R6
  (`DECISIONS.md` D-88/D-89/D-90/D-91) redeployed the whole market 2026-09-02. The
  boring `n = 2^30` lot this loop's own precedent opens is live again on R6
  (`getLot(1073741824)`, opened 2026-09-03T18:47:52Z, `closesAt`
  **2026-09-10T18:47:52Z**) — no ascending lot on this genesis can be provably settled
  before that date. The mechanic itself (`open`, `bid`) is proven on R6 too; only the
  post-window half is not yet exercised live.
- **H7/H8 — era trophy award/transfer, and the referral payout shape, unproven
  on the current genesis.** *(Read — the patron payout shape was the second half of this
  entry until `DECISIONS.md` **D-106** deleted patron mode on 2026-09-07. It is not
  unproven; there is nothing left to prove. The live figures below were measured
  2026-09-04, before that deletion, and are left as measured rather than re-estimated.)*
  **Updated 2026-09-04 (Sweep #19, iter #351) — re-checked live against R6, not
  carried over from the dead E14a numbers.** Era 1's trophy closed
  with no winner before the redeploy (D-14/D-36's "nobody is invented" branch, a real,
  permanent, correctly-decided outcome, not a bug); on R6, `getEraLeader()` again shows
  a leader with `recruits = 1` and `getTrophy(30)` = `(holder: null, transferable: 1)`
  — era 2's boundary at `n = 30` is the only remaining live opportunity, same as before
  the redeploy. `getHead()` = **16** (live-read 2026-09-04), so **14 more composite
  mints** away (skipping auto-skipped primes), a smaller gap than pre-redeploy but not
  a closed one. The combined balance of every keeper/treasury/deploy-subwallet this
  mnemonic controls is **≈1.23 GRAM**, against the ~14.7 GRAM the remaining mints plus a
  gift-mint→primorial-mint→`sendTransferTrophy` sequence need — a figure measured when
  that sequence still carried D-106's now-deleted claim and activation legs, so the true
  requirement is *lower* than 14.7 and has not been re-measured —
  funding is *further* from sufficient than the pre-redeploy reading (~5.81 GRAM right
  after R6 ignited), because other loops' proofs (H8a's patron-line proof, concurrent
  minting) have been spending down the same shared wallets since. Neither wallet can be
  topped up by this loop under its own authority (an owner/faucet action, the same
  class as `J5`'s GA4→BigQuery export — testnet faucets were already checked and found
  unusable headlessly from this sandbox, `docs/testnet-deployment.md`). Whoever next has
  funding authority and sees `getHead()` closer to 30 should re-check before attempting
  the sequence — do not force it on a wallet shared with unrelated concurrent chain
  activity, which risks seqno collisions that cost the OTHER actor's in-flight work, not
  just this one.
- **H12 — a bounty vault that is short of `TRANSFER_GAS` forfeits a one-shot payout in
  silence, and cannot retry it.** Filed 2026-09-16, open, `GAUNTLET.md` H12. The vault
  spends 0.1 GRAM of its own balance on each jetton hop; below that the compute phase
  succeeds (`exit 0`) and the ACTION phase fails with result 37, reverting the whole
  transaction. The mint that triggered it survives — the ledger's leg is deliberately
  `BounceMode.NoBounce` so that a vault failure never unwinds a mint — so nothing reports
  anything, `RetryBountyPayout` finds no journal entry (it would have been written by the
  transaction that reverted) and `onBouncedMessage` never fires because an action-phase
  failure is not a bounce. Each trigger is one-shot, so the payout is permanently forfeit.
  **The funding half of this finding is FIXED and must not be read as open**
  (`GAUNTLET.md` H11, closed 2026-09-16): `payOut`'s `responseAddr` now names the vault, so
  TEP-74's excess comes home and each payout nets **+0.0124 GRAM** — measured on the live
  2026-09-14b set across eight consecutive payouts, vault balance 2.13 GRAM after 11. The
  vault therefore cannot drain itself into this state any more; it can only be short if it
  starts short. What remains open is the choice between adding a pre-send balance check that
  journals without sending (a contract change and a redeploy) and accepting the hole with
  operational monitoring — an owner decision, briefed when H12 is taken.

  *(This bullet previously described a different H11 — a live wrong-tier answer on
  `/trophy/special/:n`. That entry was doubly superseded and is deleted rather than kept as
  provenance, because an audit-facing limitations note that names a live §9.1 violation must
  not describe a mechanic that no longer exists: D-99 replaced the three rarity tiers with
  one additive score, and `/trophy/special/:n` was replaced by `/trophy/score/:n`
  (`backend/read-proxy/src/routes/trophy.ts`); the redeploy it was waiting on has since
  happened twice. `GAUNTLET.md` H11 is, and since 2026-09-04 has been, the bounty-vault
  item.)*
- **G25 — is `AppHost` rate-limiting `deploy.ps1`'s SSH connections under this repo's
  own connection frequency?** G15 (closed 2026-09-02) shipped the retry that makes a
  momentary `ssh` exit 255 survivable, but deliberately left the root cause open. Needs
  a real host's `sshd`/fail2ban logs around a steward run to answer; this sandbox has no
  live host to observe, so `/ops-steward` — not this loop — is where it closes.

## 3a. Audit Lows, 2026-10-01 — accepted, not fixed

The security audit of 2026-10-01 (commits `370e0bf7` onward) fixed every Medium and six of
its Lows (treasury `execute`, `donate_floor`/`retry_credit` float, the vault allow-list's
workchain, tribute forfeit on a frozen owned item, a Dutch buyer's margin, plus the
referral relay). These remain, each small, plausible rather than demonstrated, or a
documented trade-off. None moves `T`, `S` or `pending` against holders.

- ~~**Voucher replay across deployments**~~ **RESOLVED 2026-11-19**
  (`docs/audit/contract-audit-2026-11-19.md` M2, `DECISIONS.md` D-171 amendment). The claim
  and burn hashes now bind the network's global id and the voucher contract's own address (the
  address alone is the same on testnet and mainnet under a v4r2 genesis wallet), and the
  attribution signer carries both, so a voucher or burn signed for one deployment is a bad
  signature (712) on any other. **Operating rule, kept as defence in depth: never reuse a
  voucher signing key across deployments.**
- **A refused program payout leaves the claimant's receipt mark raised**
  (`primes_bounty_vault.tolk`, `primes_claim_receipt.tolk:96`). The vault restores its track
  but the cumulative voucher's mark stays, so that slice is never paid. Needs the vault's
  own wallet to refuse (balance below `fundedPrimes`, or a fee spike).
- **A recipient-side jetton failure strands PRIMES at the sender**
  (`primes_jetton_wallet.tolk:300`, `primes_vesting.tolk:242`). The refund returns to the
  sending wallet, not to the vesting lock or vault that started the send, whose
  `releasedAmount`/`paidEras` has already advanced. Current gas sizing makes the abort
  unlikely.
- **A bounced mint delivery leaves `S` above supply** (`primes_jetton_master.tolk:298`).
  Safe direction: `p_f = T/S` reads lower, never higher. Needs a mis-sized mint hop.
- **Established players can still be "recruited"** (`primes_minter_card.tolk`). A card turns
  `seen` only on a mint, a prime bought or a recruit credited; a wallet that won a composite
  lot, holds generators or builds constellations is still fresh. Each recruit still costs a
  full 1 GRAM mint, so the sybil price is unchanged; the ladder can be farmed from existing
  players.
- **`recover_exit` on legs 1–2 may restore tsTON that was really sold**
  (`primes_ratchet.tolk`, D-155). The in-code note says the shortfall surfaces at the next
  exit; if a later burn then exceeds the real balance, that last tranche re-aborts. Since the
  2026-11-08 fix leg 2's payout is checked against the tsTON pool's own deploy-time vault, so
  a venue change no longer strands it; what remains needs a leg-2 payout that never arrives.
- **A bounced LP sink-forward comes back matured** (`primes_treasury.tolk:1184`,
  `primes_lp_position.tolk:456`), so a locked position could exit early. No attacker path to
  make the treasury's LP wallet throw was found.
- **Staking reward rounding** (`primes_stake.tolk:400-617`): `debtAt` rounds down, and
  nano-scale overpayments can briefly leave `unclaimedTotal` below one position's banked
  reward, stalling its settle until another budget accrues. Self-healing.
- **A won near-cap prime lot costs the market float ~0.035 GRAM** (`RES_GAS`, D-113). `RES_GAS`
  is a params-derived economic constant (`LOT_FLOOR` = 1.07); re-sizing it is a sim run,
  not a code fix.
- **A lost `lot_block_release` cannot be re-requested** (D-198, `primes_ledger.tolk` sale
  path). A flushed unsold prime's sale asks its lot block for the bookmark with a fixed
  0.1 GRAM, non-bounceable hop, which also pays the block's accrued rent (LOW-4: the block
  keeps only a 0.01 GRAM floor, so ~0.08 GRAM of debt, a dozen idle years at its densest,
  is the ceiling). If that hop ever failed (a frozen lot block), the buyer's
  item would stay unstamped and that prime's flat dividend would sit, still counted in
  `divOutstanding`, unclaimable. The lot block keeps the row (marked released), so a
  permissionless re-request is a small addition if it is ever observed.
- **A refused `lot_block_bookmarks` batch is restored from its bounce** (LOW-5, D-198,
  `primes_ledger.tolk` bounce arm `0x9c000004`). Measured on the heaviest state (a full
  26-block window, forfeit rows on every prime): the bounce brings ~0.058 GRAM back and
  restoring 16 rows costs 270,553 gas = 0.018 GRAM, a 3.2× margin that only a config 21 gas
  price rise past it would eat. The trigger is a frozen lot block, which needs 0.1 GRAM of
  rent debt on a block the head has only just left. A merge out of gas sends no bounce at
  all, so the hop is sized on the merge (≤ 59k gas). `LotBlock.spec.ts` pins the restore
  under half the bounce value, and the re-flush afterwards.
- **`soldAheadEntry`'s bound is a keeper liveness dependency** (LOW-3, D-198 point 3,
  `primes_ledger.tolk` `Aux2.soldAheadEntry` ~L989; `backend/keeper/src/cycle.ts`
  `runStampClaimLane` ~L508). Rows still park there for a prime sold ahead of the head (the
  walk adds no send to the mint path) and for a flushed prime whose item refused its stamp.
  Only a `claim_dividend` removes one, and no owner is obliged to send it, so the map stays
  under config 43's cell cap only while something walks `getNextSoldAhead` and claims every
  row — the keeper's parked-stamp lane, 5 rows a cycle. The claim is permissionless and each
  row was a paid lot, so anyone can drain it; but if the keeper stops for long enough and
  nobody else claims, the ledger's storage grows toward the freeze D-198 exists to prevent.
  Watch: the keeper's stamp lane outcomes, and `getNextSoldAhead(0)` returning a row older
  than a few cycles.
- **The market's resting-lot bound is a keeper liveness dependency** (D-200,
  `primes_market.tolk` `ParkLots`; `backend/keeper/src/cycle.ts` `runParkLane`). A descending
  lot keeps its 1.83-cell row until `park_lots` folds it into a bit, and nothing on chain sends
  that. The keeper pages `getParkScan(from)` one call a cycle (16 rows a call, worst 106,434
  gas ≈ 0.007 GRAM, paid by the sender, change returned). If it stops and nobody else folds,
  rows accumulate one per unsold prime opened, toward the ~35k-row freeze D-200 exists to
  prevent. Watch: `getParkScan(0)` answering a non-zero fold count for more than a few cycles.
- **A parked prime's purchase recomputes its score** (D-200, `parkedLot`). 182,778 gas at
  n = 509, out of `RES_GAS`'s 0.045 GRAM float share; near `AUCTIONABLE_MAX` the score alone is
  ~680k gas (V34), about all of it. No modelled head reaches such an `n`.
- **Build Prove is offered to non-owners in the webapp.** Since the consent fix the item
  refuses a stranger's proof (300); the Build page still shows the button, so a non-owner
  pays the gas of a refused send. Gating it needs a per-input owner read.

## 3b. Audit Lows, 2026-11-08 — accepted, not fixed

The 2026-11-08 review fixed its two Mediums (an LP `expire` racing an in-flight withdraw
double-cut `eligibleWeight`; leg 2 of the staking exit checked its payout against the
re-pointable flush vault) and six Lows (mint-path `S_MAX` headroom clamp, masterchain
rebate notification, the newcomer window lent to an unresolved edge, the burn tally,
`itemsMinted` on lot closes, the TEP-62 forward fee, `getLotLane`). These remain:

- **A flush the venue never answers still closes as filled** (`primes_ratchet.tolk`
  `flushIsStale`, 1 h). Audit R2-M1 (2026-11-19) removed the forcible cause — a venue change
  mid-flight; the trip now keeps the venue it was sent to (`getFlushReplyVenue`) — so what
  remains needs the venue itself to drop a swap. **The close is lazy:** nothing happens at the
  hour; the trip closes only when `flush`, `stake` or `unstake` next runs. Until one does, a
  refund from the trip's own vault still restores `pending`, however late
  (`RatchetStaking.spec.ts`). After the close the same refund credits nothing: its GRAM joins
  the gas buffer, `getSolvency`'s delta is higher, and no arm moves it back into `pending`
  (refused 100 if the venue has moved since, accepted and ignored otherwise).
- **A late refund can restore the wrong trip, but never overstate `pending`** (audit R2-L3;
  the BOUNCE arm closed by the security audit of 2026-11-20). The swap bounce now reads the
  bounced body's own `amount` and restores only when it is the open trip's
  (`RatchetStaking.spec.ts`), so a late bounce of a trip closed stale credits nothing — that
  was the harmful case, `pending` overstated by the difference. The REFUND arm
  (`payout#474f86cf`) still restores the CURRENT `inFlightFlush`: the payout carries no amount
  and its `query_id` is not known to echo ours, so its only correlation is
  `value >= inFlightFlush`. A late refund of trip A therefore restores a newer trip B only when
  A >= B, and the net is +A − B >= 0 — a misattribution between the terms, never `pending`
  above its backing. R2-M1's pin decides WHICH vault may answer, never which trip.
- **OPEN, not accepted — a 1-nanoGRAM flush costs no cooldown** (no owner decision exists).
  `cooldownSec * amount / autoSize` floors to zero, so a dust flush is repeatable and holds the
  one in-flight slot (223, and 230 for stake/unstake) until it settles — seconds on a live
  venue, the stale hour on a silent one — for about the 0.25 GRAM of venue gas its caller
  attaches. It cannot delay a venue change (R2-M1) and cannot move `T`, `S` or `p_f`; what it
  leans on is flush and staking liveness. A minimum flush size would close it and is a
  parameter the sim must supply.
- **A late ledger refusal charges the raiser, not the opener** (`primes_market.tolk`,
  `MarkRejected`). An open on a stale `headHint` is refused a round trip later; a raise in
  that gap refunds the opener whole and the unwind refunds the raiser `highBid − REJECT_GAS`
  (0.1 GRAM). The window is seconds, so only automated bidders are exposed. A fix needs the
  ledger to confirm an accepted `mark_off_head`, a new message on every open.
- **A refused `mint_won_lot` removes a composite ahead of the head for good**
  (`primes_market.tolk`, the `0xb0000020` bounce arm). The winner is refunded, but the
  ledger's off-head mark is permanent (D-45), so the head skips `n` and every later
  `open_lot` on it is refused. No attacker input that makes the settle throw was found.
- ~~A stranger can poison the ratchet's learned tsTON rate~~ — **withdrawn and replaced,
  2026-11-19** (`contract-audit-2026-11-19.md` H2). Upstream pays a deposit bill with a
  jetton transfer whose `from` is the payout collection, never `addr_none`, so a stranger's
  bill cannot teach the rate. The real defect was the ratchet's OWN fill under
  non-optimistic deposits, taken as a zero-cost donation and harvested; it is FIXED
  (`creditStakeArrival`: any unauthenticated tsTON is valued at the last learned rate and
  credited against the open stake or a past write-off). What remains, accepted:
  - **Under non-optimistic deposits every stake is held open ~72 h.** Its fill cannot be
    authenticated, so it never closes the stake; `stake`/`unstake` refuse (230) until
    `recover_exit` writes off the residual `inFlightStake − stakeCredited` — the drift
    between the last learned rate and the pool's current one, published as `realizedLoss`.
    `flush()` is not held. The drift is small once a rate has been learned, but a FIRST
    stake made non-optimistically is valued at the 1/1 seed: at the live ~1.18 GRAM per
    tsTON that writes off ~15% of it as `realizedLoss`. The tsTON is still held, and the
    next authenticated (optimistic) fill restores the write-off from it before `harvest`
    can see it; until then a tranche that exits redeems above its written-down cost and
    the surplus lands in the gas buffer, never `pending`. On the seed rate a refused leg 1
    skips the DeDust leg for leg 3's exact-rate bill.
    If the pool stays non-optimistic for good the rate is never
    re-learned: each stake writes off its drift and `harvest` pays less. Safe, lossy.
  - **The safety of a stale rate rests on D-151's "tsTON only appreciates"**, an
    assumption, not an upstream guarantee: `pool.func:478-493` allows a negative round.
  - **A `from = addr_none` mint more than 144 h late, during a newer open stake,** would be
    read as that stake's fill. It needs an optimistic-mode pool fault.
- **The burn tally counts DeDust proceeds whose burn may still be dropped.** Since the fix
  only `transfer_notification`s whose jetton sender is the venue's PRIMES vault count, but a
  third party's swap paid to the ratchet chooses its own forward GRAM; an underfunded one is
  counted and its burn dropped by `IGNORE_ERRORS`. The PRIMES stay on the ratchet's wallet.

## 4. Frontend/mainnet-readiness notes, deferred on purpose

- **F12b** — `resolveTonNetwork()` silently defaults to `"testnet"` when
  `VITE_TON_NETWORK` is unset or unrecognized. Today's default happens to be the safe
  direction (nobody accidentally builds a mainnet bundle by omission); revisit whether a
  missing value should instead refuse to build once a real mainnet deploy is on the
  table.
- **D-76** (noted again from §1 above because it is also, structurally, a mainnet-readiness
  item, not only a signed-off risk) — SRI/signed-manifest protection for the mint builder
  is the one item on this whole list that changes character between "pre-launch testnet"
  and "real money is at stake." Track H's own mainnet path should re-open it rather than
  let it stay closed by the pre-launch deferral indefinitely.

## Sign-off

This document is drafted, not signed. Per this loop's standing authority
(`.claude/skills/gauntlet/SKILL.md`, "Standing authority"), a gauntlet iteration may not
close a `DECISIONS.md` item or invent the owner's answer to one — it can only compile
what is already true and already briefed. The owner's review of §2's table (accept as
listed, or resolve one or more entries) is the one action outstanding against this
document.

**Owner sign-off:** _______________________ Date: _______________
