# What breaks when a key is lost

**GAUNTLET.md X6.** `privileged-credentials.md` is the *inventory* — what exists and what each
one can do. This page is the *failure* half: **what stops working the day each one is lost,
whether the system degrades or halts, and whether it can be replaced without a genesis
redeploy.**

Over ten years one of them will be lost. Track X's owner answer (2) puts rotation ceremonies
out of scope on purpose — succession is the treasury's governance, not a key handover — which
makes **the written blast radius the whole deliverable.** Where the honest answer is *"this
cannot be replaced without a redeploy"*, it is said in those words, because that is the fact a
ten-year holder is entitled to.

Every row below was read out of the contract or the service that holds the key. Nothing here
is inferred from the item that asked for it.

---

## Summary

| credential | if lost | degrades or halts | replaceable without a redeploy? |
|---|---|---|---|
| `DEPLOYER_MNEMONIC` (deploy key, laptop only) | no new genesis can be run from it; the venue proposer in §2 is its subwallet | **degrades** | **yes** for deploying; **no** for the proposer it carries |
| `KEEPER_WALLET_MNEMONIC` (keeper gas wallet, on the host) | nobody is *running* the permissionless calls | **degrades** | **yes** — move GRAM to a new wallet |
| `primes_venue_timelock.tolk`'s `proposerAddr` | the DeDust venue addresses can never be repointed | degrades, then halts `flush()` **only if** a venue dies | **no** |
| `primes_voucher.tolk`'s `signerPubkey` | no quest voucher can be signed | degrades | **not applicable in v1** — see below |
| `primes_ledger.tolk`'s `operatorAddr` on `set_invite_terms` (D-211, D-215) | the invite words, count and value are frozen at their last value | **degrades** (invites still send, link intact) | **no** — the address is ledger deploy data |

---

## 1. `DEPLOYER_MNEMONIC` and `KEEPER_WALLET_MNEMONIC` — two wallets, split on purpose

Until 2026-11-24 these were ONE mnemonic, and the public host held it. They are now two, and
`deploy.ps1` refuses to ship when they are equal; it ships only the variables
`docker-compose.yml` names, so `DEPLOYER_MNEMONIC` cannot reach the host at all.

### 1a. `KEEPER_WALLET_MNEMONIC` — the keeper's own gas wallet (on the host)

**What it signs.** The keeper's lanes and nothing else. The keeper's own header calls the
process *"permissionless by design — a convenience runner, not infrastructure anyone has to
trust"*, and that is the load-bearing fact here: its lanes — `flush()` (§4.3.1), `sync_head`,
opening descending prime lots, and the expiry/distribute sweeps — are **permissionless and
caller-funded**. Anyone may call them from any funded wallet. It holds no protocol role and no
contract stores its address.

**What stops working.** Nothing, structurally. What stops is somebody *doing* it on a timer.

**Degrades, does not halt.** The visible consequence is that `pending` sits unswept past its
cooldown and the market's `headHint` lags, so a passed prime gets no descending lot until
somebody calls `sync_head`. Both are recoverable at any later moment by any caller, and the
keeper already alerts when flush sits eligible-but-uncalled past cooldown times two.

**Replaceable: yes.** This key pays gas and can be replaced by moving GRAM to a new wallet.
Point a new mnemonic at the same `.env` and the lanes resume. **A leak** costs its gas balance
and nothing else, which is why it is the one wallet key allowed on the host.

### 1b. `DEPLOYER_MNEMONIC` — the deploy key (laptop only)

**What it signs.** Every deploy/genesis script in `contracts/scripts/`. It is never on the
host.

**Degrades, does not halt.** Losing it stops nobody playing; it stops the operator deploying
from it.

**But there is a coupling, and it is the thing to know.** `PRIMES_PROPOSER_ADDR` **must be a
subwallet of this same mnemonic** — `genesisPrep.ts` checks it explicitly, and two genesis runs
(2026-08-17, 2026-08-29) died at the last step when it was not. So **losing this mnemonic also
loses the venue-proposer credential in section 2**, which is *not* replaceable — and leaking it
leaks the proposer. That is why it stays off the public host.

---

## 2. `primes_venue_timelock.tolk`'s `proposerAddr` — the venue proposer

**What it signs.** `queue` and `cancel` on the venue timelock, and nothing else. The contract's
own header calls it *"the ONLY privileged credential in the entire v1 system"* and bounds it:
it *"cannot touch T, S, pending, escrow, owed balances, treasury routing, or any compiled-in
economic parameter — its blast radius is exactly the three addresses `update_venue` overwrites
on the ratchet."*

**What stops working the day it is lost.** Nothing, immediately. The three DeDust venue
addresses stay exactly where they are, `flush()` keeps selling into them, and `execute` on any
already-matured queued change is **permissionless** — anyone can still push one.

**What stops working later, and this is the real cost.** The venue addresses become
**permanently fixed**. A DeDust pool that is redeployed, deprecated or abandoned can never be
repointed, and `flush()` then sends into a dead vault — §5's floor loses its depth on the one
path it depends on. That is a slow failure with no on-chain remedy: it does not arrive the day
the key is lost, it arrives the day the venue moves.

**Replaceable without a redeploy: NO.** `proposerAddr` is in the contract's address-determining
init data with no message that can change it. A new proposer means a new venue timelock at a
new address, and the ratchet bakes `venueTimelockAddr` into *its* init data in turn — so it
means a genesis redeploy.

**What a holder should expect to see.** Nothing at all, until a venue moves. `getQueued()`
answers the same `hasQueued: 0` it always did. There is no surface that says "this credential
is gone", and there cannot be — the chain cannot tell a lost key from an idle one.

---

## 3. `primes_ledger.tolk`'s `operatorAddr` — the invite-words setter (D-211)

D-202 deleted the invite-list signer; nothing on the invite line is signed. What D-211 added is
one address that may rewrite the words at the start of the invite comment. **Lost:** the words
stay as last set, every invite still sends with the ledger's own link and referral key, and
nothing else depends on it — the game **degrades** by one copy change, never halts. **Stolen:**
the thief can put its own words (86 bytes at most) before the real link until the owner sets
them back; it moves no value. **Replaceable without a redeploy: no** — the address is in the
ledger's deploy data, and there is no setter for it.

---

## 4. `primes_voucher.tolk`'s `signerPubkey` — the quest voucher signer

**What it signs.** A voucher naming a wallet and a cumulative PRIMES total, and the one-shot
program burn that closes the claim window.

**Not applicable in v1, and this is a fact about the deployment rather than about the key.**
The bounty vault's allow-list is **deployed EMPTY** (`primes_bounty_vault.tolk`: *"In v1 the
allow-list is deployed EMPTY, so this opcode is unreachable in practice: every possible sender
fails the check"*). No voucher contract is allow-listed, so no voucher can pay anything today
whether or not the key exists.

**When a program does ship:** losing the key means no new voucher can be signed and no
already-signed voucher can be superseded; **vouchers already in players' hands still redeem**,
because redemption checks the signature against the deployed pubkey and needs no fresh signing.
The program's budget is the bound in both directions — `remaining` on the vault's allow-list
entry is genesis-fixed, so a **leak** cannot exceed it either.

**Replaceable without a redeploy:** the voucher contract itself is deployed separately, so a new
one with a new key is a new deploy of *that contract* — but it must then be allow-listed on the
vault, and the vault's allow-list is genesis-fixed with no message that writes it. **So: no,
not without a genesis redeploy**, on the deployment shape as it stands.

---

## What this page does not do

It adds, removes, rotates and re-scopes nothing. It also does not tell anyone where the private
halves are kept or how they are backed up — that is an operations question and
`threat-model.md` is where it belongs. And it makes no claim that a loss is *detectable*: in
every case above the chain reports the same state for a lost key as for an idle one, which is
itself part of the blast radius.

Kept honest by `contracts/tests/KeyLoss.spec.ts`, which asserts this page still names each
credential, its degrade-or-halt verdict, and — for the three that cannot be rotated — says so
in those words.
