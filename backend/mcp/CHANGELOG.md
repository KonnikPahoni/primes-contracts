# Changelog

All notable changes to `@ton-primes/mcp`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); the game is pre-launch and
testnet-only, so the major version stays at 0 while contract wire formats can still change.

## 0.5.0

### Added

- **`primes_name_number`** (`DECISIONS.md` D-212): name a number this wallet owns, for GRAM,
  through the collection — `nameFee` for the first naming, `renameFee` after, both read live
  from the collection's `getNaming()`. The server now registers 23 tools: 14 reads and 9 writes.
- **Official MCP Registry listing**: `package.json` carries `mcpName`
  (`io.github.KonnikPahoni/ton-primes`), which the registry checks against `server.json`.

### Removed

- **BREAKING: the generator and constellation tools are deleted** (`DECISIONS.md` D-202,
  `TELEGRAM_INVITES_PLAN.md`). Invite generators, the second number line and its discovery
  bounty are gone from the contracts, so 13 tools go with them: the reads `primes_open_builds`,
  `primes_build_state`, `primes_discovery_owed`, `primes_discovery_tier`, `primes_generators`,
  `primes_constellation` and `primes_invite_config` (there is no invite signer key to report),
  and the writes `primes_build`, `primes_prove_input`, `primes_send_generator`,
  `primes_close_build`, `primes_expire_build` and `primes_claim_discovery`. The server now
  registers 22 tools: 14 reads and 8 writes.

### Changed

- **BREAKING: naming is paid in GRAM, and the PRIMES sink is gone** (D-212). `primes_audit`
  returns `supply` and `solvency` only (no `sink`). `primes_name` reports the current owner
  as the namer, plus `nameFee`/`renameFee`/`nextFee`, and a primorial's `trophy` engraving.
  `primes_annotate` is the era trophy alone: the first engraving free, later ones at the
  registrar's `getTrophyRenameFee()`.

- **BREAKING: the discovery bounty is per constellation, not per wallet** (`DECISIONS.md`
  D-193). The bounty vault's per-wallet book is deleted; the unclaimed bounty lives on the
  constellation item of the build that earned it and follows the NFT.
  `primes_discovery_owed` and `primes_claim_discovery` take `target` (was `address` / no
  argument); the claim is refused before signing unless this wallet owns the item and it
  holds a bounty. `primes_wallet` no longer returns `discoveryOwedNanoprimes` — there is no
  per-wallet figure to report.

## 0.4.0

### Changed

- **Built on `@ton-primes/agent` 0.4.0** (`GAUNTLET.md` G72): the SDK's reads now target
  `/lp/positions/:address`, the path read-proxy serves since the LP miner's route was renamed.
  The quote-gated writes pick up that release's F65 factored lot quote and F68 prime lot opens.
  No tool was added, removed or renamed.

## 0.3.0

Seven composite reads, and the registry properties asserted rather than documented.

### Added

- **Seven read tools**, each answering a question an agent asks *before* it acts rather
  than mirroring one HTTP route:
  - `primes_wallet` — GRAM, PRIMES, both §4.7 rank ladders and any unclaimed bounty, in one
    call. A wallet missing any of them is the normal state for a new player, so each is
    settled separately and one absence does not blank the rest.
  - `primes_ratchet` — pending, swapped, the floor and the last flush outcome. `bounced` is
    the field that tells a venue refusing from a venue nobody has called.
  - `primes_lot_price` — what opening a lot would cost, and which lane, including `-1` for
    "not openable".
  - `primes_confirm_numbers` — up to 24 numbers settled against their own items. The
    portfolio list is replayed from indexed transfers and goes stale on a sale; this is the
    read that drops one, on the chain's evidence.
  - `primes_constellation`, `primes_invite_config`, `primes_audit`.
- **`test/tools.test.ts`** — the registry guard: no read takes `confirm`, every write does,
  each of the SDK's fourteen actions has a tool behind it, no two tools share a name, and
  every tool carries a description long enough to choose it by.
- A `LICENSE` file, so the MIT declaration ships with the package.

### Changed

- **`primes_flush` quotes the amount it would move**, and refuses the ratchet's own two
  asserts before signing: `208` on an empty `pending`, `207` inside the 24-hour cooldown.
- **The tool handlers are type-checked against their own schemas.** `read`/`write` are now
  generic over the zod shape, so a handler reads `a.n` and the compiler compares it to the
  schema declared beside it. The thirty-five `as unknown as { … }` casts that stood there
  asserted a shape TypeScript had never checked — a renamed field compiled cleanly and
  failed at runtime as `BigInt(undefined)`. One cast remains, at the SDK boundary.
- `primes_portfolio`'s description now says its rows are candidates and names the tool that
  settles them.

## 0.2.0

- **Fifteen new tools**, 13 → 28: the seven v2 SDK actions (`primes_send_generator`,
  `primes_close_lot`, `primes_prove_input`, `primes_close_build`, `primes_expire_build`,
  `primes_claim_tribute`, `primes_claim_discovery`, `primes_annotate`) and seven reads.
- The three irreversible writes say so **in the quote**, before they ask.
- `PRIMES_EVENTS_URL`, for the event poller's indexed history.

## 0.1.0

First release. 13 tools over stdio; every write quotes before it spends.
