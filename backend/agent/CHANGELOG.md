# Changelog

All notable changes to `@ton-primes/agent`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); the game is pre-launch and
testnet-only, so the major version stays at 0 while contract wire formats can still change.

## 0.6.0

**Breaking: the mint wire format changed** (`DECISIONS.md` D-215). `Mint`'s invite count is
now `uint7` (it was 3 bits), so 0.5.0 cannot mint against a ledger deployed from the D-215
code (testnet genesis `20261124` onward), and 0.6.0 cannot mint against an older one.

### Changed

- **§4.1's invite line is operator-set** (D-215): `MintInvites.count` runs 0..the ledger's
  live count (genesis 3, never above the fixed ceiling 100); a count over it is refused 221.
  Each slot delivers the live value whole, with the 0.001 GRAM send fee paid on top. The
  invite comment carries the operator's words alone, with no link.
- **The coin is GRAM, the network is TON** in every doc comment, tool description and error.
  No identifier changed: the `*Nanoton` field names stay.

### Added

- **`read.inviteTerms()`**: `/ledger/invite-terms`, `getInviteTerms` verbatim (count, value,
  send fee, line cap, count ceiling). Read it before building an invited mint rather than
  assuming the genesis 3 × 0.1.

- **`harvest()` and `sweepOps()`**: §4.3.2's permissionless `harvest()` on the ratchet and
  D-117's `sweep_ops` on the ledger, both caller-paid. `harvestable()` and `sweepable()` make
  the contract's refusals first (an open exit 230, the interval 228, dust yield 229; a no-op
  sweep) and return what the call would move; the send and the MCP quote both use them.
- **`read.harvestGates()` and `read.opsSweep()`**: `/ratchet/harvest-gates` and
  `/ledger/ops-sweep`.

## 0.5.0

### Added

- **`name({ n, text })`** (`DECISIONS.md` D-212): the current owner of any minted number names
  it for GRAM, sent to the collection with `buildNameNumberMessage`. The fee is read live —
  `getNaming()`'s `nameFee` for the first naming, `renameFee` after — and the call refuses
  before signing unless this wallet is item(n)'s `getNamer()`. `chain.namingFees`,
  `chain.trophyAnnotationCount`, `chain.trophyRenameFee` and an optional
  `ContractAddresses.collection` (picked from `/contracts`) come with it.

### Removed

- **BREAKING: `read.sink()`** (D-212). Naming is paid in GRAM and `primes_sink.tolk` is deleted,
  so read-proxy's `/sink` is gone.

- **BREAKING: generators and constellations are deleted** (`DECISIONS.md` D-202,
  `TELEGRAM_INVITES_PLAN.md`). The second number line, its builds, the invite generators and
  the constellation discovery bounty are gone from the contracts, so their SDK surface goes too:
  the actions `openBuild`, `proveInput`, `sendGenerator`, `closeBuild`, `expireBuild` and
  `claimDiscovery`; the reads `inviteConfig`, `generator`, `generatorsOf`, `generatorRefusal`,
  `build`, `openBuilds`, `constellation`, `buildTotals`, `constellationsOf`,
  `recentConstellations`, `discoveryOwed` and `discoveryTier`; `chain.build`,
  `chain.generatorData`, `chain.constellationItemAddress`, `chain.discovery` and
  `chain.discoveryOwed`; the types `BuildState`, `GeneratorState` and `InviteConfig`;
  `ContractAddresses.constellationsCollection`; and `FeedKind`'s `"invited"`. The
  `examples/prospector.ts` reference agent enumerated constellation targets and is deleted with
  them.
- **`proxyOptional` and the `Optional<T>` type.** read-proxy no longer answers
  `501 GET_METHOD_NOT_AVAILABLE` on any route (its capability probes are deleted), so the
  501-to-`null` layer had nothing left to translate. A 501 now throws like any other non-2xx.

### Changed

- **BREAKING: `read.name(n)` and `annotate()` follow D-212.** `name()` returns the CURRENT
  OWNER as `namer` (every number, composites included) plus `nameFee`, `renameFee` and
  `nextFee` (bigint nanoGRAM; `nextFee` null while unminted), and `trophy` for a primorial.
  `chain.namer` / `chain.annotationCount` read item(n) for every n, primorials included.
  `annotate()` is the era trophy alone: the first engraving free, later ones carry the
  registrar's live `getTrophyRenameFee()`.

- **BREAKING: `mint({ invites })` takes an UNSIGNED address list** (`DECISIONS.md` D-202).
  `MintInvites` is `{ count, addresses: [{ slot, address }] }` with `count` 0..3 and slots
  1..3 (was 0..5, plus a 128-hex `signature`). Each addressed slot is a plain 0.1 GRAM transfer
  the ledger sends with a fixed comment; there is no operator signature, and the minter may
  put any **workchain-0** address in a slot — the ledger refuses the whole mint (236,
  `invite_bad_workchain`) for a slot anywhere else, so `mint()` throws before sending (audit
  R2-L1, 2026-11-19). The keeper's `GET /api/invitees?count=` answers in this shape.

- **BREAKING: the discovery bounty is read and claimed per constellation, not per wallet**
  (`DECISIONS.md` D-193, `GAUNTLET.md` V26.8). The bounty vault's per-wallet book is deleted;
  the unclaimed bounty lives on the constellation ITEM of the build that earned it and follows
  the NFT. `read.discoveryOwed(target)` reads `/constellation/:t/discovery` (was
  `discoveryOwed(address)` over the deleted `/vault/discovery/:address`);
  `chain.discoveryOwed(target)` and the new `chain.discovery(target)` read the item's
  `getDiscoveryOwed()` (and owner) via the constellations collection;
  `claimDiscovery(target)` checks this wallet owns the item and it holds a bounty before
  sending, then sends `claim_discovery` (0x94000002) to the ITEM. `ContractAddresses.bountyVault`
  is replaced by `constellationsCollection`.
- **`expireBuild` reads the registrar's clock, not the ledger's** (`DECISIONS.md` D-192,
  `GAUNTLET.md` V27.3). `expire_build` is refused (908) until the registrar's `headHint`
  reaches `expiryHead`, and the hint lags the ledger's `getHead()`, so the pre-send check read
  the wrong head and could sign a refused send. `getBuild` now returns `headHint` as its 14th
  value, `BuildState.headHint` carries it, and `expireBuild` (and MCP's `primes_expire_build`)
  gate on it.
- **BREAKING: a build is named by (target, registrant)** (`DECISIONS.md` D-192, `GAUNTLET.md`
  V27.2). The registrar keys builds by both, so a target carries one open build per registrant
  and the first confirmed close wins; another wallet's open build no longer blocks yours.
  `chain.build(target, registrant)` and `read.build(target, registrant?)` take the registrant;
  `proveInput({ ..., registrant? })`, `closeBuild(target, registrant?)`,
  `sendGenerator({ ..., registrant? })` and `expireBuild(target, registrant?)` take an optional
  one and default to this wallet's own build. Every body (`prove_input`, `close_build`,
  `expire_build`, the generator's forward payload) now carries the registrant after `target`.
- **`openBuild` sends to the LEDGER, with 0.04 GRAM + margin** (`DECISIONS.md` D-192,
  `GAUNTLET.md` V27.1). The ledger relays it to the registrar with the sender as registrant
  and its real head, so a build's expiry is stamped from the real head. The registrar now
  refuses an open sent to it directly (`wrong_sender`, 100). Same method signature.
- **`read.feeSplit` reads `/lots/fee-split`.** The route was `/reservations/fee-split`; the
  reservation lane is retired (D-30/D-90) and read-proxy serves only the new path. The method
  name and the payload are unchanged.
- **These return plain values, never `null`:** `flushStatus`, `floorCache`, `staking`,
  `lastMintTime`, `seedT`, `ranks`, `earn`, `lotPrice`, `feeSplit`, `eraSchedule`, `rebate`,
  `eraLeader`. Their `null` meant only "not on this deployment".
- **`balance`, `seqno` and `lotFloor` keep a `| null`,** each with its real reason: the account
  read failed, the wallet is not deployed, the route answered `found: false`.

## 0.4.0

### Changed

- **`read.lpPositions` reads `/lp/positions/:address`** (`GAUNTLET.md` G72). The route was
  `/miner/positions/:address`, named after the LP miner D-168 deleted; read-proxy serves only
  the new path, so 0.3.0's `lpPositions` 404s against a current proxy. The method name and the
  payload are unchanged.
- **`PrimesChain.lotPrice` quotes `getLotPriceFrom(n, factorize(n))`** (F65). A composite is
  priced on its factored score, which is what `open_lot` charges; the from-`n` `getLotPrice`
  was a lower bound, and an opening bid at it was refused 1003. `openLot` and
  `primes_open_lot` gate on this figure.
- **`openLot` opens a prime ahead of the head** (F68, D-88 point 3): `kind: 1` with no factors.
  It used to refuse every prime citing the deleted D-22 rule.

### Removed

- **`generatorKind`, `generatorSlots` and the `GeneratorSlot` type.** DECISIONS.md D-165 draws
  a generator's kind at deploy, so the collection's `getGeneratorKind`/`getGeneratorAddress`
  and read-proxy's `/generators/kind/*` routes are gone: there is no prediction to publish.
  An issued generator's item address is on `generatorsOf` rows (`itemAddress`); read it with
  `generator(itemAddress)`.

## 0.3.0

The whole published READ surface, and a guard that keeps it whole.

### Added

- **Fifty-eight new reads**, covering every route in `shared/openapi/read-proxy.yaml` and
  `shared/openapi/read-index.yaml` that carries a figure. Grouped in the README's API
  section; the notable ones a decision depends on:
  - `counters`, `pending`, `swapped`, `flushStatus`, `seedT` — the §5 ratchet state,
    including D-26's third term, without which solvency reads as a permanent gap.
  - `balance`, `seqno`, `primesBalance`, `ranks`, `earn` — what one wallet has and has earned.
  - `numbers`, `lot`, `lotPrice`, `lotFloor`, `score`, `runway`, `yieldOf` — the per-number
    reads a purchase or a claim turns on.
  - `inviteConfig`, `generatorSlots`, `constellation`, `buildTotals`, `constellationsOf`,
    `generatorRefusal` — the invite line and the second number line.
  - `supply`, `solvency`, `sink`, `treasury`, `vesting`, `miner`, `lpLocked` — §9.1's
    auditor surfaces, returned as the route sends them.
  - `board`, `feed`, `indexStatus`, `claimsOf`, `historyOf`, `contestOf`, `lotHistory`,
    `cheapestLot`, `unclaimedOffers` — the read-index's own tables.
- **`proxyOptional<T>()` and 501 handling.** A route whose get-method is not on the
  *deployed* contract answers `501 GET_METHOD_NOT_AVAILABLE`, and the ten methods over such
  routes now return `null` instead of throwing. `null` is a fact about the deployment and
  never a figure; do not render it as zero.
- **A pre-check on `flush()`.** The ratchet's own two asserts, read live and refused before
  a wallet opens: `208` on an empty `pending`, and `207` inside the 24-hour cooldown — which
  on a quiet venue is the state the call is in almost all of the time.
- **`PrimesChain.pending()` and `PrimesChain.flushStatus()`**, backing the above.
- **Twelve exported types** — `LedgerCounters`, `FlushStatus`, `LotReading`, `LotPrice`,
  `NumberRow`, `InviteConfig`, `GeneratorSlot`, `Ranks`, `PrimesBalance`, `BountyStatus`,
  `Optional<T>`, `Read<T>` and the two board/feed unions.
- **`test/coverage.test.ts`** — the surface guard. It reads the builder list out of
  `shared/messages.ts` and the path lists out of both OpenAPI specs, and requires every
  entry to be WIRED to a method or NAMED as excluded with its reason. A new builder or a new
  route fails the suite until somebody classifies it. It also fails on a *stale* entry, so a
  deleted route cannot sit in the list pretending to be covered.
- **`test/read.test.ts`** — one case per endpoint: the body its route actually sends, the
  URL the request must land on, and the value it decodes to.
- A `LICENSE` file, so the MIT declaration ships with the package rather than only in
  metadata.

### Fixed

- **`numbersOf()` returned `[]` for every wallet.** It read `data.rows`; that route serves
  `data.numbers`. The boards and lot lists use `rows` and the per-wallet routes do not, and
  because both are valid JSON the wrong key never threw — it just reported an empty
  portfolio, forever. It now returns `bigint[]`, and two regression tests pin the key.

### Changed

- `Read<T>.provenance` is `Provenance | Provenance[]`. Eleven routes assemble several
  get-methods and send an array; typing it as the common case was a lie a consumer would
  only find at runtime.
- `numbersOf(address, limit?)` returns `bigint[]` rather than `unknown[]`.

## 0.2.0

The whole program-player action surface.

### Added

- **Seven actions**, completing every flow the game has: `sendGenerator` (the only way a build
  can close — a build closes only while the registrar *holds* its generator, and there is no
  `send_to_build` opcode), `closeLot`, `proveInput`, `expireBuild`, `claimTribute`,
  `claimDiscovery` and `annotate`.
- Every action reads the contract's own asserts first and throws before a wallet opens.
- **Eight chain reads** behind them: `itemAddress`, `numberData`, `owed`, `build`, `namer`,
  `annotationCount`, `generatorData`, `discoveryOwed`.
- The event poller as a third base URL, for the indexed history no get-method answers.

### Fixed

- **`mint()` took an `inviteCount` it silently ignored**, so §4.1's invite line was
  unreachable from the SDK. It now takes `invites`, the signed list the keeper serves.

## 0.1.0

First release. Read the published projections, compute a factorization proof, and sign the
mint, lot and build-opening messages locally.
