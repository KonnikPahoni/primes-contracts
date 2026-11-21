# Threat model — assets, actors, trust boundaries, attacker gets

`GAUNTLET.md` Track I, item I4. `docs/audit/scope.md` (I1) already drew the boundary —
"every path TON can move through, and every figure the webapp or bot shows a player" —
and its §1–§4 is the asset list. This document adds the layer scope.md itself says I4
owes: **who the actors are, where the trust boundaries sit, and what each actor gets if
it turns hostile or is compromised.** Not a measurement script like `contract-surface.md`
— a judgement call, argued from `docs/audit/sender-gates.md` (122 arms, who authorises
each), `docs/audit/withdraw-surface.md` (77 outbound sends, classified by destination),
`docs/audit/money-arithmetic.md` (14 subtractions), and CONCEPT.md §8's own guarantee
("no admin withdraw path on any TON balance, not timelocked, not multisig").

## Assets

Grouped by what is actually at stake, not by file:

1. **TON held in the two pools** (CONCEPT.md §3.4): `pending` (the ratchet's, nobody's
   until `flush()`) and `owed` (per-prime-item purses, the item owner's). Each lives in
   its own contract so `balance ≈ declared liability` is a single get-call
   (`DecompositionSolvency.spec.ts`). **There used to be a third — escrow, for open
   reservations awaiting the head — but `DECISIONS.md` D-90 deleted the escrowed claim,
   the release right and `primes_market_shard.tolk` itself: a won lot mints in the same
   transaction that closes it, so no contract in this system holds refundable customer
   money anymore.** This document originally listed three pools and was stale against
   that decision; corrected here rather than left standing, since an auditor sent
   looking for an escrow contract that no longer exists would waste real time on it.
2. **Emitted PRIMES supply (`S`) and the floor identity (`T`, `p_f = T/S`)** — not TON
   itself, but the ratchet-theorem invariant (`k < 1`, `S` never decremented, `T`'s
   three-term identity) every economic claim in the app rests on. Corrupting the identity
   without moving a single nanoton is still a protocol-breaking attack.
3. **NFT custody and metadata** — the 16-contract item/collection/constellation set;
   who owns a numbered prime, a named string in the registrar's `names` dict, a rank in
   `primeRanks`, an era trophy.
4. **The voucher-signing key** (`backend/attribution/src/voucher-signer.ts`, Ed25519,
   `@ton/crypto`). `primes_voucher.tolk`'s `BurnSigner`/`ClaimVoucher` arms are the only
   two places a *signature*, not a sender comparison, is the authorisation mechanism
   (`sender-gates.md`'s one `signature` row) — the private half of this key is the single
   piece of off-chain material that can make the voucher contract release TON to an
   address of the signer's choosing, up to whatever `paidTotal` bound is live. Since audit
   R2-M2 these are two keys, one per track (QSTS, PQST), and each instance caps what one
   wallet can ever be paid (`maxPerWallet`, 716 above it).
5. **The keeper's TON wallet** (`backend/keeper/src/wallet.ts`) — not an authorisation
   asset (see Trust boundary 3 below), but a custody asset in its own right: it holds real
   TON to pay gas for the permissionless calls it automates.
6. **Read-path honesty** — every figure `read-proxy`/`read-index` serve, which
   `stat-provenance.md` traces back to a get-method. Not custody, but the auditor-facing
   claim CLAUDE.md rule 4 makes: a reshaped or invented number here is a false claim even
   when the underlying contract is correct.
7. **The deployed webapp bundle and the deploy host** — the code a player's wallet
   actually signs against. `CLAUDE.md`'s honesty rules constrain the *contracts*; nothing
   stops a compromised bundle from building a different message than the ring on screen
   implies.

## Actors

- **Player** — any wallet interacting with the contracts directly or through the webapp/
  bot. Fully untrusted by design; every arm they can reach is either a sender-compares
  check, "sender is the key" (their own dictionary row), or deliberately permissionless
  (`sender-gates.md`'s 27-row table).
- **Operator / team** — controls the treasury address, the deploy subwallet used for
  genesis (`docs/testnet-deployment.md`), the attribution voucher-signing key, and the
  keeper wallet. The one class of actor CONCEPT.md §8 is specifically written to bound.
- **The keeper automation** (`backend/keeper`) — a scheduled process holding a TON wallet,
  distinguished from "operator" because it is not a privileged caller: every function it
  calls (`flush()`, retry sends) is permissionless, reachable by anyone with the same
  message. It is convenience, not authority.
- **The attribution service** (`backend/attribution`) — holds the voucher-signing key and
  is the one off-chain component whose output the chain trusts on signature alone rather
  than re-deriving.
- **The deploy host operator** — whoever holds the Hetzner SSH key / `deploy.ps1`
  credentials (`docs/testnet-deployment.md`'s HOSTING section). Controls what bundle is
  served and whether the backend services are live, not what the contracts do.
- **read-proxy / read-index** — no keys, no custody (`scope.md` §2); trusted only for
  arithmetic honesty on numbers a player could otherwise derive by calling the get-method
  themselves.
- **External attacker** — anyone else: a malicious player, a party that compromises one
  of the above actors' credentials, or a network-level adversary (front-running, replay).

## Trust boundaries

1. **Player wallet ↔ contracts.** The only boundary that is fully trustless by
   construction — TVM signature verification and the sender-gate mechanisms in
   `sender-gates.md` are the entire trust model here. No off-chain actor sits in this
   path for a direct contract call.
2. **Contract ↔ contract (peer sends).** 49 of `withdraw-surface.md`'s 73 outbound sites
   are `peer` class — money that has not left the protocol. Each receiving contract
   re-checks its own sender gate; a router "forwarding" a call (`sender-gates.md`'s
   `forwarded to peer` mechanism, 3 arms) does not itself decide authorisation, the peer
   does.
3. **Attribution service ↔ voucher contract.** A one-way trust boundary: the contract
   trusts the Ed25519 signature completely (`primes_voucher.tolk`'s `BurnSigner`/
   `ClaimVoucher`), with no on-chain re-derivation of "should this wallet get this many
   PRIMES" beyond the instance's write-once per-wallet cap (R2-M2) — the rest of that
   judgement lives entirely in `voucher-signer.ts`. This is the closest
   thing the protocol has to an off-chain admin key, scoped narrowly: it can only sign
   payloads shaped like a voucher claim, not move funds directly, and the signer's own
   header documents a short redemption window precisely so a compromised signer's damage
   is time-bounded, not permanent.
4. **Keeper wallet ↔ permissionless functions.** Deliberately *not* a privileged
   boundary — `scope.md` §2 already states this: "it moves no money the contract wouldn't
   otherwise release to anyone who called the same function." The keeper is in scope
   because it is a live TON-holding process reachable from this repo's code, not because
   it holds authority a player lacks.
5. **Deploy host ↔ webapp bundle / backend services.** The boundary CONCEPT.md §8
   deliberately does **not** cover: §8's "no admin withdraw path" is about the
   *contracts*, and says nothing about the frontend a player's wallet trusts to build the
   right message in the first place. See "What a compromised deploy host gets," below —
   this is the one place a non-custodial guarantee still has a real, if narrower, teeth.
6. **read-proxy/read-index ↔ player.** An honesty boundary, not a custody one: every
   number is independently re-derivable from a get-method (CLAUDE.md rule 4), so a lie
   here is falsifiable by any player willing to call the contract directly, not
   undetectable.

## What an attacker gets from each

- **A player's own wallet, compromised.** Only that player's own funds, items and
  reservations. No cross-player or protocol-wide effect — every arm gated on sender
  identity only ever authorises the sender's own state (`sender-gates.md`'s "sender IS
  the key" rows are the strongest form of this: the caller cannot even name anyone else's
  record).
- **The voucher-signing key, compromised.** The most severe single-key compromise in the
  system: an attacker can mint arbitrarily many valid-looking vouchers, each redeemable
  for real PRIMES up to whatever bound the contract enforces, until the key is rotated
  (baked into `primes_voucher.tolk` at deploy — rotation needs a redeploy, per
  `CLAUDE.md`'s pre-launch freedom to do so) and every voucher issued under the old key
  expires (short window, by the signer's own design). `scope.md` already calls this "the
  off-chain equivalent of a contract authorisation bug" — this document agrees and adds:
  it is the only off-chain key whose compromise is a direct fund drain, distinct from every
  other actor on this list. Since audit R2-M2 (2026-11-20) the drain is capped twice: one key
  reaches one track, and one wallet at most that instance's `maxPerWallet` (QSTS 2,450 /
  PQST 6,350 PRIMES), so emptying a track takes ~1,000 fresh wallets each paying ≥ 0.15 TON
  per claim. Both service keys share one host's `.env`, so a host compromise takes both.
- **The keeper wallet, compromised or drained.** An attacker gains nothing they could not
  already do by calling the same permissionless functions themselves (§4 above). The only
  real loss is the TON balance the wallet itself holds for gas — bounded to whatever
  operating float it carries, not protocol funds.
- **The operator or deploy subwallet's private key, compromised.** Lets an attacker act
  as the operator for the specific arms `sender-gates.md` gates to the deploy subwallet
  (e.g. re-running genesis-adjacent setter arms like `SetSinks`/`SetPeers`/`SetBoost`
  before they are one-shot-locked), or receive the two `operator`-class sends on the mint
  path that `withdraw-surface.md` lists — the `sweepable` ops float and the operator's 20%
  remainder of an unsold prime's forfeited tribute. **D-152 took §4.1's per-mint 5% line
  off this list, and that is a reduction in blast radius rather than a rename.** The line
  used to pay `configA.treasuryAddr` when that was a bare wallet; D-100 point 6 made
  `treasuryAddr` the governed treasury CONTRACT and moved the 5% to
  `feeDests.operatorAddr`; D-152 moved it back to the contract. So the only send an
  operator key can redirect on an ordinary mint is the ops sweep — the forfeit remainder
  fires only when a cited prime has no owner — and the key at risk here is the operator's,
  still the *only* key on any fee line. It does **not**
  unlock a withdraw path from `pending` or `owed` — those have none, by §8 — so the blast
  radius is "redirect what the protocol already routes to the operator," not "drain player
  balances."
- **The governed treasury (`primes_treasury.tolk`), and the electorate that spends it.**
  D-100 adds a pot with **no key at all** — no owner field, no admin opcode, no upgrade,
  no pause — holding its vest half in PRIMES, 80% of forfeits in TON, and any LP sent to
  it. There is therefore no private key whose compromise reaches it, and that is a real
  reduction in what an operator-key compromise gets. What replaces the key as the attack
  surface is **the vote**: a proposal transfers `{TON | PRIMES | LP}` to an address a
  simple majority of votes cast approved, with no quorum, so an attacker who accumulates
  more weighted LP than anyone who bothers to vote no can move up to 25% of one asset per
  proposal, one day at a time. D-100 point 10b accepts this in writing and names the
  defences in order: the operator's own 6-month position at the 10x multiplier, the 25%
  per-asset cap measured at execute time, and the 1-day window in which the proposal is
  public. Note what it cannot reach: the treasury holds no `pending` and no `owed`, and
  nothing in it mints, so the worst case is the loss of the team's own pot — never a
  player's floor, balance or NFT.
- **The LP custody child (`primes_lp_position.tolk`), one per depositor.** Holds nobody's
  money: the LP itself sits in the treasury's jetton wallet and the child holds only the
  book. Its owner is fixed in the init data that decides its own address, so there is no
  "set owner" arm to steal and a different owner is simply a different contract. A
  compromised depositor key gets that depositor's own LP back after their own tier's
  delay — which is what the key is for.
- **The deploy host / SSH key, compromised.** Cannot move a single nanoton out of
  `pending` or `owed` — §8's guarantee holds regardless of host compromise,
  because there is no contract-side admin-withdraw arm for a compromised host to call.
  What it *can* do: take the service offline (availability, tracked under `GAUNTLET.md`
  Track G, not this pack per `scope.md`), or — the sharper risk — **serve a modified
  webapp bundle that builds a different transaction than the UI displays**, turning every
  connected player's own wallet-signing action against them. This is the one attacker-gets
  line item CLAUDE.md's contract-side invariants do not reach at all; the closest mitigation
  today is `docs/audit/reproducible-build.md` (source-to-bytecode, not source-to-served-JS)
  and the rollback mechanism in `docs/testnet-deployment.md`'s "Rollback" section, neither
  of which is a subresource-integrity or bundle-signing control. **Gap, not a fix**: filed
  as `GAUNTLET.md` **I4.1** below.
- **A malicious player, no compromise, just adversarial use.** Everything the permissionless
  set already allows anyone to do: open/bid/close lots, retry sends, sweep expired lots,
  challenge a registrar claim. `sender-gates.md`'s point stands — an arm in this set is
  permissionless *by design*, so "a malicious player can call it" is not itself a finding;
  a finding is a permissionless arm whose effect is not bounded the way `NoAdminWithdraw
  .spec.ts`/`FuzzInvariants.spec.ts` assume. None found while writing this document beyond
  what Tracks B–D already filed.
- **A read-proxy/read-index bug or compromise.** A wrong number shown to a player — a real
  honesty defect (CLAUDE.md rule 4), traced and caught by `stat-provenance.md`'s chain, but
  never a custody event: nothing routes TON through either service, per `withdraw-surface
  .md`'s totals (no read-service contract appears as a destination class at all).

## New finding filed

- **I4.1** (filed while writing this threat model): no subresource-integrity, bundle-hash
  pinning, or signed-deploy verification exists between "the deploy host serves a JS
  bundle" and "a player's wallet signs whatever transaction that bundle builds." §8's
  "no admin withdraw path" protects the contracts from a compromised operator; nothing
  equivalent protects a player from a compromised **frontend**. Not fixed here — sizing a
  real control (SRI hashes pinned in the vhost config, a signed-manifest check, or simply
  documenting this as an accepted residual risk in I5) is a judgement call for whoever
  picks this item up, and touches `ops/deploy/` config, not contract code, so it does not
  block the rest of Track I.

## What this document does not cover

Availability-only risks (host downtime, log-shipper failures) are `GAUNTLET.md` Track G's
job, not this pack's, per `scope.md`'s own boundary. Economic-parameter *provenance* (is
`K_CEIL` the right number) is I8's job, not a trust-boundary question. This document is
about **who can make TON or a claim move against the rules**, not about correctness of the
rules themselves (that is Track A/B/C's invariant work, already cited throughout).

Log: written from `docs/audit/scope.md`, `sender-gates.md`, `withdraw-surface.md`,
`money-arithmetic.md`, `CONCEPT.md` §3.4/§8, `docs/testnet-deployment.md`'s HOSTING
section, and a direct read of `backend/attribution/src/voucher-signer.ts` and
`backend/keeper/src/wallet.ts`. `graphify` unavailable in this sandbox (binary not on
`PATH`) — fell back to grep/direct reads, per the skill's "never let the graph block"
rule. No code changed — pure Track I documentation. One new item filed (I4.1, above).

**Corrected, readiness Sweep #29 (2026-09-04, `GAUNTLET.md` iter #370).** Written
2026-08-29 (I4), before `DECISIONS.md` D-90 (2026-09-03) deleted the escrow shard
(`primes_market_shard.tolk`), the escrowed claim and the release right. This document
still listed "three pools" with escrow as a live asset and trust-boundary participant
throughout the Assets and "What an attacker gets" sections — stale against a change
`CONCEPT.md` §3.4 and `contracts/tests/DecompositionSolvency.spec.ts` already reflect
correctly ("two pools now, `pending` and `owed`", D-90.3). Corrected in place: the
Assets section now names two pools and states D-90's deletion explicitly; every
"`pending`, `owed` or escrow" phrase in "What an attacker gets" drops the third term.
`docs/audit/money-arithmetic.md`'s "C8's escrow reconciliation" phrase, cited by this
document's own methodology mechanism list, carried the same stale name and is corrected
alongside it. No other `docs/audit/*` file mentions escrow as a live asset (checked
`withdraw-surface.md`, `sender-gates.md`, `scope.md` — none do; they were regenerated
or written after D-90).
