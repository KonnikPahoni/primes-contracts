# Deployment story — genesis sequence, addresses, who holds what key

`GAUNTLET.md` Track I, item I6 (last re-derived at I9, iteration #324, 2026-09-03).
`docs/testnet-deployment.md` is the append-only session log this document distils from —
every claim below cites a section there rather than repeating its full narrative (the log
also carries five superseded genesis attempts and two historical pre-v5 sessions, kept
for provenance, not summarised here). This document answers three questions an auditor
asks once, not per-session: **how does a genesis happen, what is live right now, and
which private key can do what.**

## 1. What is live right now

Network: GRAM **testnet only** (`CLAUDE.md` "Project status: pre-launch" — no mainnet
deployment exists). **Current genesis: 2026-11-21**, deployed by
`contracts/scripts/deployGenesis.ts --skew-safe` at commit `58fc759e` from subwallet
`20261123` of the keeper mnemonic, floor-donated (D-92/D-93, mandatory before ignition —
see §2; 50 GRAM on this set, a testnet-only shortfall against D-204's 200 recorded under the LIVE table), then **ignited the same
day** (`scripts/ignite.ts --skew-safe` minted Unity and opened every player-facing path).
**Fifteen contracts** in the address table (D-212 deleted the burn sink; D-166 deleted the operator's vesting lock; D-168's
stake master replaced the dormant staking sink in the same row; G76/D-170/D-171 added three voucher instances; D-202 deleted the generators and constellations collections), a mandatory floor donation, an
ignition, and a DeDust v2 pool address (`PRIMES_DEDUST_LP_STANDIN=0`, D-140) that on THIS set is keyed on its own jetton master and seeded at the live floor, LP receipt locked in the sink (`seedDedustLiquidity.ts`) — see §2 for the mechanics of each phase. Like the set
before it, it also carries CONCEPT.md §4.3.2's **staked reserve** (D-151) and therefore a
deployed address that is NOT in the table: `mock_tonstakers_pool.tolk`, a test double that every
one of §4.3.2's five venue slots points at, deployed only on testnet (its init data does not name the deploy subwallet, so sets share one instance until its code
moves). See the bullet list under the LIVE table for what it stands in for and
why a rate reading from it is a knob rather than a market.

The full address table is `docs/testnet-deployment.md`'s
**"LIVE — genesis 2026-11-21 (deploy subwallet `20261123`)"** section; it is not
duplicated here because a second copy is a second place to go stale.

> **This date and that section name are CHECKED, not typed** (`GAUNTLET.md` **I11**).
> `tools/check-env-genesis.mjs` — already the thing that reads which genesis table is
> marked `## LIVE` — now also asserts that the two strings above name it, and
> `pnpm check:env-genesis` (a `gate:checks` leg) fails if they drift. I11 measured why
> that was needed: this paragraph spent three weeks citing the **2026-09-02** genesis,
> which **ten** later deployments had superseded, and pointed the auditor at a section
> the deployment log itself heads `## SUPERSEDED`. The paragraph below warning that a
> stale paste fails silently was, itself, the stale paste. Nothing checked a PROSE
> document against which table is live; now something does.

Everything on testnet is disposable by design (`CLAUDE.md`): a storage-layout change is
answered with a fresh genesis, not a migration. Every prior address table in
`docs/testnet-deployment.md` — and at the time of writing there are fifteen of them, back
through the pre-v5 sessions — is dead. Do not mint, bid, or wire against any of them.
**After any redeploy, run `pnpm check:env-genesis` (`tools/check-env-genesis.mjs`,
`GAUNTLET.md` **H4a**) before touching chain state** — no script writes this sandbox's
`.env`, every `PRIMES_*_ADDRESS` is a manual paste from whichever table is current, and a
stale paste fails silently: a dead-but-still-answering old genesis returns a
plausible-looking number instead of an error (measured cost: a full day of gauntlet
iterations at `GAUNTLET.md` **H4**, iter #315, 2026-09-03, before the mistake was found).

**What changed contract-set-wise since the 2026-09-02 genesis this document once tracked.**
That set had **twelve** contracts; the live one has **fifteen** (`GAUNTLET.md` I15 rewrote this
paragraph when it read eighteen; D-202 then deleted the generators and constellations collections, and D-212 the burn sink).
None is a new mechanic bolted on:

- **Governed treasury** (`primes_treasury.tolk`, D-100) — the §4.1 5% fee line's
  destination. D-100 point 6 pointed that line at the operator and **D-152 pointed it
  back**, so the operator's only claim on an ordinary mint is the **42%** remainder of an
  unsold-prime tribute forfeit (D-166; it was 20% before).
- **LP sink** (`primes_lp_sink.tolk`, D-100 point 4) — LP in, nothing out. The DeDust LP
  minted at seeding is forwarded here and locked; `getLocked()` equals the sink's LP
  jetton wallet balance to the unit, checked both ways.
- **Three voucher instances** (`primes_voucher.tolk`: Voucher, Security voucher, Prime-quests
  voucher; G76/D-170/D-171) — §9.5's signed-voucher claims, each its own program on the bounty
  vault's allow-list.
- **The vesting row changed hands.** 2026-09-02's single "Vesting lock (D-77)" was the
  operator's; D-100 point 6 added a **treasury vesting lock** (beneficiary the governed
  treasury, four 25% tranches 90 days apart, D-91 point 2), and **D-166 deleted the
  operator's**. The treasury's is the only genesis PRIMES allocation left.
- **The staking row changed contracts.** D-168's **stake master** replaced the dormant staking
  sink in the same row.

The escrow shard (`primes_market_shard.tolk`) was already gone at 2026-09-02 — D-90 deleted it,
a won lot mints in the transaction that closes it, and the market router's init data dropped
`shardCode` and `treasuryAddr` with it.

`read-proxy` exposes the treasury vesting lock at `GET /vesting` (the webapp's `VestingLock` ring
reads `tranches` off the get-method rather than a local copy, per `CLAUDE.md` rule 4);
`read-index`, `event-poller` and `keeper` still have no code path that reads them, the
same reasoning H1.1 gave for the sinks.

## 2. The genesis sequence — four phases, in order, and why the order is forced

The pipeline is `contracts/scripts/genesisPipeline.ts`, run by
`deployGenesisSkewSafe.ts` (the clock-skew-safe wrapper — see §4). The order within each
phase is not a preference: each deploy embeds an already-known peer address in its own
init data, and each bootstrap wire is a **one-shot** link that throws `already_processed`
(104) on a second attempt, so a strand mid-sequence cannot be resumed — the standing
procedure is to abandon a stranded set and redeploy from a fresh subwallet
(`docs/testnet-deployment.md` gotcha 3/7).

**Phase A — deploys (15 contracts, `deployAndWire`).** Each embeds the previously-deployed
contracts' addresses in its own init data, in this order: collection → jetton master →
venue timelock (before the ratchet, whose init embeds the timelock's address) → **LP sink**
→ **governed treasury** (before the ledger, whose `ConfigA.feeDests` names it — D-100, and
D-152 pointed §4.1's 5% line back at it) → ledger → ratchet → registrar → **market router**
(embeds ledger, ratchet and the NPV table only — D-90 drops `shardCode` and `treasuryAddr`,
since a won lot now mints in its own closing transaction and there is no escrow shard left
to address or forfeit to) → **voucher** (G76, §9.5 — before the vault, whose allow-list
names it; it carries the genesis address as a placeholder until Phase B's `set_vault`) → **security voucher** (D-170 — the same code on the owner's own key, tagged `SECU`, allow-listed for the one 1,000,000-PRIMES prize) → **prime-quests voucher** (G78 / D-171 — the quests key again, tagged `PQST`, allow-listed for `prime_quests`; the tag is in every signed hash, so the two instances on one key cannot redeem each other's vouchers) → bounty vault → staking sink (D-34, deployed inert) → **the
treasury vesting lock** (D-100 point 6; its beneficiary IS the treasury, so it cannot
precede it, and it must exist before Phase C mints anything, since its address is the
allocation's mint destination; `DECISIONS.md` D-166 deleted the operator's lock that used
to precede it). D-212 deleted the burn sink that closed this list. Market
shards no longer exist (D-90 deletes `primes_market_shard.tolk`), and D-202 deleted the generators and
constellations collections with their items.

**On testnet there is a twentieth deploy, and it happens BEFORE all of these.**
`resolveStakingVenue()` (`deployGenesis.ts`) deploys `contracts/test-mocks/mock_tonstakers_pool.tolk`
and returns its address five times over — the pool, the tsTON minter, the ratchet's own
tsTON wallet and DeDust's tsTON and native vaults are one account on testnet, deliberately,
so one address is the correct answer for all five rather than a shortcut. It must precede
Phase A because §4.3.2's venue is **address-determining init data** and `deployAndWire`'s
first act, before any message, is `validateStakingVenue`. **The network decides, not a
config value**: the branch is reachable only when `provider.network() === 'testnet'`, so
there is no flag, env var or file that can point a mainnet genesis at a stand-in — stricter
than `PRIMES_DEDUST_LP_STANDIN`, which is an opt-in flag guarded by a network check. What a
testnet run proves about §4.3.2 is therefore the WIRING; the economics are proved in
`@ton/sandbox` by `RatchetStaking.spec.ts` against the same mock (D-151 P0 point 1: the
tsTON rate only moves when a Controller lends to a validator that wins a testnet election).

**Phase B — one-shot bootstrap wiring (11 messages, all from the genesis script wallet).**
Sets each contract's peer addresses, in order: `collection.set_ledger`,
`master.set_ledger`, `timelock.set_ratchet` (the venue lives on the **ratchet**, not the
ledger — CONCEPT.md §3.4), `ledger.set_peers`, `ratchet.set_ledger`,
`registrar.set_ledger`, `registrar.set_collection` (D-202: the collection address alone, where
`set_item_code` used to carry the item code for builds),
`ledger.set_sinks` (without it, every mint throws 233), `voucher.set_vault` (G76), `securityVoucher.set_vault` (D-170) and `primeQuestsVoucher.set_vault` (D-171), which point
the three vouchers at the vault whose allow-list names them. **The count is read off the script, not maintained by
hand** — `pnpm check:env-genesis` fails if the number in the sentence above stops matching
`genesisPipeline.ts`. That guard exists because this phase has been mis-described twice:
it read 13 with `collection.set_auction` in the list until `GAUNTLET.md` X16 (D-20 retired
that opcode and the pipeline has never sent it), and it read 12 until `GAUNTLET.md` I12,
which is the same error in the other direction — four links (both generators wires,
`registrar.set_generators_collection` and `ledger.set_invite_config`) were live, read back
by the pipeline's own verification loop, and absent from this paragraph. D-202 then removed
those four and the constellation pair, which is how it reached 12 again with a different list.

An eight-predicate readback then polls every link — `collection.ledgerAddr`,
`ledger.peersSet`/`sinksSet`, `registrar.collectionSet`/`sinkSet`, and all three vouchers' `vaultSet` (against the vault's own address) — and `verifyPresentation` reads TEP-62/64/66 back off
the deployed contracts and aborts the genesis if the collection, items, or jetton came out
nameless. That is the last point at which a bad set is cheap to abandon.

**Phase C — completion (`completeGenesis`), twelve messages since D-166 (fifteen before;
the operator lock's mint, `set_wallet` and `release` are gone).** The treasury's vested
PRIMES allocation (`master.mint_genesis`, D-46 sizing halved, D-166) mints **into the
vesting lock, not into any wallet** (D-77, retuned by D-91 point 2 to **four equal 25% tranches, 90 days apart,
the last at day 270**); the bounty vault's genesis mint plus `vault.set_wallet`;
`ratchet.set_jetton_wallet` (arms the burn counter); **`ratchet.set_tston_wallet`** (D-151,
new — the second of §4.3.2's two one-shot bootstraps and the one no chain had ever
performed before the 2026-09-21 set); `stake.set_wallet` (which also names the treasury, D-168) / `sink.set_wallet` (both start
empty/unfunded by design); `lpSink.set_wallet`; `treasury.set_wallets` (three of them —
PRIMES, LP and tsTON); **`set_wallet` on BOTH vesting locks**, which also **starts each
vest clock** (`startTime` is stamped here, not baked into deploy data, and both are stamped
in the same block so the two schedules are the same schedule and not merely the same
shape); **`release` on both locks** for tranche 0 — the one that matures at `startTime`
itself, run here so `flush()` has PRIMES to trade against from block one rather than
waiting on day 90 (§6 point 3); `master.seal_authority` (**irreversible** — no more
genesis-mint budget after this); `ledger.genesis_seed` (writes `T = 0`, `seedT = 0` — D-46
point 2, no real GRAM is deposited at deploy — and `S`, and walks the head to the first
composite, `n = 4` under D-20); and `timelock.queue` (a queue, not an execute —
permissionless thereafter, and maturing in 30 days at the mainnet clock or ~4.3 hours at
the testnet `clockDivisor` D-139 added).

**Between deploy and ignition: the floor donation, and it is mandatory (D-92/D-93).**
`genesis_seed` leaves `T = 0`, so `p_f = T/S` does not exist yet.
`scripts/donateFloor.ts` (`donate_floor#b000000c`, D-91 point 4) is what creates it —
**132.50 GRAM**, owner-set by `DECISIONS.md` **D-154** and read out of `shared/params.json`
(`genesis.genesis_donation_ton`), which the sim consumes and does not choose; a smaller,
incremental sum on testnet, since the op takes any amount from anyone at any time. D-154
front-loads what D-100 point 2 had split into 4.20 GRAM at genesis plus up to 150 GRAM
afterwards, because D-140 pins the DeDust pair AT the floor and so makes opening depth
quadratic in this figure. `donate_floor` stays permissionless and incremental for anyone
afterwards. `ignite` **refuses to run while `T = 0`** — enforced on chain (error 218,
`ledger_floor_unbacked`) and in both ignite scripts' preflight, not merely documented —
because a mint against an unbacked floor emits roughly 20% of the genesis supply for 1
GRAM where the same mint after the donation emits ~0.28%
(`contracts/tests/UnbackedFloorLaunch.spec.ts`).

**Ignition is a separate, deliberate step**, not part of genesis: `deployGenesis` /
`deployGenesisSkewSafe` land the set complete but closed; `ignite.ts` /
`igniteSkewSafe.ts` mints Unity and opens every player-facing path — refusing to do so,
per the paragraph above, until the floor is backed. Full per-value deploy config
provenance (which sim parameter or env var populates each init field) is
`docs/testnet-deployment.md`'s "Deploy-time config" table — not repeated here, since it is
generated data, not sequence.


## 3. Who holds what key

Four private keys/credentials exist across the whole stack; nothing else can move GRAM or
change protocol state.

| Key | Held by | Custodies / authorises | Compromise blast radius |
|---|---|---|---|
| **`KEEPER_WALLET_MNEMONIC`** (24-word, `/.env`) | The operator/team, off-chain | The keeper's **own gas wallet** — pays trigger-message gas for `flush()`/`settle()` calls. Also the wallet genesis was deployed from (via a fresh, disposable subwallet per cycle — never the main wallet itself, see §4). **Custodies no protocol funds** (`backend/keeper/src/wallet.ts`'s own header comment, confirmed by reading the file). | An attacker can spend the keeper's own gas balance and impersonate its permissionless calls — but every function it calls is reachable by anyone with the same message (`docs/audit/threat-model.md` actor "the keeper automation"), so this is a convenience loss, not an authority loss. |
| **The deploy subwallet** (derived from the same mnemonic, a fresh subwallet id per genesis cycle) | Same operator | The **genesis script address** baked into every contract's init data, and the **proposer** address the venue timelock's `queue`/`execute` checks against. It was also the operator vesting lock's fixed beneficiary (D-77/D-91) until **D-166 deleted that lock**; the one left, the treasury's, pays the governed treasury. | Whoever holds this can queue/execute venue changes through the timelock once matured (CONCEPT.md's own timelock design — a 30-day delay is the mitigation, not secrecy). Vesting releases are permissionless, so the key adds nothing there. No direct fund custody either way. |
| **The voucher-signing keys** (Ed25519, `@ton/crypto`, `backend/attribution/src/voucher-signer.ts`) — two since audit R2-M2: `QUESTS_VOUCHER_SIGNER_SECRET_KEY` (QSTS) and `PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY` (PQST) | The attribution service, off-chain (both in one `.env` on one host) | The **only signature-based authorisation** in the whole system (`docs/audit/sender-gates.md`'s single `signature` row) — `primes_voucher.tolk`'s `BurnSigner`/`ClaimVoucher` arms trust this signature completely, not a sender comparison. | One key reaches its own track only, and each wallet at most that instance's write-once `maxPerWallet` (QSTS 2,450 / PQST 6,350 PRIMES; 716 above it), so a thief needs ~1,000 fresh wallets per track; a host compromise takes both keys. Otherwise an attacker can mint valid-looking vouchers, redeemable up to the vault's allow-list `remaining`, until the key is rotated (a redeploy, per `CLAUDE.md`'s pre-launch freedom — no rotation-without-redeploy path exists) — see `docs/audit/threat-model.md` §"attacker gets" for the full writeup. |
| **The security-prize key** (Ed25519, D-170) | The owner, offline — never a service | The security voucher's `ClaimVoucher`/`BurnSigner` arms; the deploy reads only its public half (`SECURITY_BOUNTY_SIGNER_PUBKEY`). | Bounded by the vault's `SECU` allow-list entry: at most the one 1,000,000-PRIMES prize, to any address, once. The genesis refuses a key equal to either service key (R2-M2). |
| **The Hetzner SSH key / `deploy.ps1` credentials** | The deploy host operator | What JS bundle `primes.live` serves, and whether the backend containers are up. **Not** a fund-custody key — `CONCEPT.md` §8's "no admin withdraw path" means no amount of host access moves a single nanoton directly. | Can serve a bundle that builds a different mint message than the ring on screen implies (`GAUNTLET.md` **I4.1**/**D-76**, open, pending — no subresource-integrity control exists yet to catch this). Cannot touch the contracts' funds directly. |

**What holds no key at all, by design:** `read-proxy` and `read-index` (arithmetic
honesty only, `docs/audit/scope.md` §2); the Telegram bot (`bot/`) — confirmed by grep
(`mnemonic|privateKey|WalletContractV`) across `bot/src`, zero hits, every money-adjacent
action is a call into an in-scope backend package (`docs/audit/scope.md`'s I1 finding);
and the deployed contracts themselves, none of which have an admin-withdraw path on any
GRAM balance (CONCEPT.md §8, confirmed structurally by `docs/audit/withdraw-surface.md`'s
73-send classification: the `operator` class is exactly 4 sites, none of them a raw
withdraw).

## 4. Standing procedure for the next genesis

Everything below is operational discipline `docs/testnet-deployment.md`'s "STANDING
GOTCHAS" section derived the hard way across five genesis attempts (2026-08-16,
2026-08-17, 2026-08-27, 2026-08-29, 2026-09-01) that led to the live 2026-09-02 (R6)
set — restated here as the auditor-facing summary, not a replacement for that section's
full detail:

1. Deploy key is `KEEPER_WALLET_MNEMONIC`, never `/seed.txt` (a different, unfunded
   wallet).
2. Run scripts with `tsx`, never `ts-node` (`ts-node` fails on `shared/opcodes.ts`'s ESM
   import).
3. **Always deploy from a fresh `PRIMES_DEPLOY_SUBWALLET_ID`.** Reusing one re-derives
   dead contracts' addresses for any contract whose other init fields are unchanged —
   the 2026-08-17 collision cost a full abandoned set.
4. This machine's clock lags chain time (113 s → 134 s and drifting) — use the
   `*SkewSafe` script variants, which measure the offset from the chain's own
   `sync_utime` rather than assuming a constant.
5. On-chain messages must carry the nominal price **plus** a fee margin, never the exact
   quoted figure, or the contract rejects them.
6. Every bootstrap link in Phase B is one-shot; a run that stops halfway cannot be
   repaired, only abandoned.
7. After a genesis: fill in a new address table in `docs/testnet-deployment.md`, export
   every `PRIMES_*_ADDRESS` var into the shell (the scripts do not load dotenv — they
   only regex `/.env` for the mnemonic and the API key), wipe the indexer database (a
   retained DB silently discards every mint of a number that also existed on the dead
   chain — `mints` is `ON CONFLICT (number) DO NOTHING`), and re-run
   `completeGenesisQueue.ts` for the read-back proof.
8. **New since the 2026-09-02 genesis: the floor donation must land before ignition**
   (D-92/D-93 — see §2). `ignite` throws 218 rather than opening the game against an
   unbacked floor.
9. **New since the 2026-09-02 genesis: re-paste `.env` and verify it, every time.** No
   script writes it, a stale paste answers plausible-looking numbers instead of erroring,
   and this cost a full day of gauntlet iterations before being found (`GAUNTLET.md`
   **H4**, iter #315). Run `pnpm check:env-genesis` (`GAUNTLET.md` **H4a**) after every
   redeploy, before sending anything against the new set.

## Provenance

Sources read directly while writing this document, not summarised from memory:
`docs/testnet-deployment.md` (the full session log, all sections, especially the current
"LIVE" genesis section and "THE GENESIS PROCEDURE"; the 2026-09-02 section this line
once named is superseded), `shared/contracts.ts`
(`ContractAddresses`, `CONTRACT_ENV_VARS`), `contracts/scripts/genesisPipeline.ts`
(`deployAndWire`, `completeGenesis`, `donateGenesisFloor`, read directly rather than
trusted from the prior version of this document), `backend/read-proxy/src/server.ts`
(`GET /vesting`), `backend/keeper/src/wallet.ts`,
`backend/attribution/src/voucher-signer.ts`, `docs/audit/threat-model.md` (I4),
`docs/audit/scope.md` (I1), `docs/audit/withdraw-surface.md`, `docs/audit/sender-gates.md`,
`DECISIONS.md` D-77/D-89/D-90/D-91/D-92/D-93, and a fresh grep confirming
`PRIMES_VESTING_ADDRESS` has exactly the one reader `shared/contracts.ts` declares plus
`read-proxy`'s `/vesting` route.
`graphify` unavailable in this sandbox (binary not on `PATH`) — fell back to grep per the
skill's "never let the graph block" rule.
