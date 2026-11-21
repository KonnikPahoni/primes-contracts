# Reproducible contract build

GAUNTLET.md G10: "An auditor must be able to rebuild your bytecode." This records the exact
toolchain, the exact procedure, and the code hash every contract compiled to as of the
commit this file was last regenerated at — so an auditor rebuilds from source and diffs
against a fixed target, rather than trusting that a build "looks right."

## Toolchain, pinned

- **Package manager**: `pnpm@11.21.0`, pinned via `package.json`'s `packageManager` field
  and enforced by Corepack — `pnpm install` refuses to run under a different pnpm version
  unless overridden.
- **Dependency graph, including the compiler**: `pnpm-lock.yaml`, committed. The Tolk
  compiler is not a separately-fetched binary — it is the `@ton/tolk-js` npm package (a
  WASM build of the compiler), so `pnpm install --frozen-lockfile` resolves the exact same
  compiler build every time, not just the exact same TypeScript dependency versions.
- **Tolk compiler version actually used**: `1.4.2` (confirmed by the build's own log line,
  `🔧 Using tolk version 1.4.2...`; the exact resolved version is `@ton/tolk-js@1.4.2` in
  `pnpm-lock.yaml`).
- **Node.js**: `>=20` (`package.json` `engines`), CI pins `20`. WASM execution is
  deterministic independent of the host Node minor/patch version — the compiler runs
  inside the WASM sandbox, not as native V8-JIT'd code whose output could vary — so this
  bound is generous on purpose rather than an exact pin. Not independently verified
  against a second Node major version in this pass (see "What this does not prove" below).

### The version-mismatch warning, and why the pin above is what actually matters

Every `.tolk` source file declares `tolk 1.4` (a *language* version), while the installed
compiler is `1.4.2` (an *implementation* version) — a real, deliberate patch-version gap
this repo carries. The compiler itself warns about this on every build:

```
warning: the contract is written in Tolk v1.4, but you use Tolk compiler v1.4.2;
probably, it will lead to compilation errors or hash changes
```

This is not a bug to silence — it is Tolk's own way of saying "a different patch version of
me might compile this source to different bytecode." That is exactly why the toolchain pin
above is `@ton/tolk-js@1.4.2` (an exact resolved version in the lockfile), not `tolk 1.4`
(the source's own declaration, which several different compiler patch releases could
satisfy). **Rebuilding without honouring the lockfile's exact `@ton/tolk-js` resolution is
not a valid reproduction attempt**, even though nothing would stop `pnpm install` (without
`--frozen-lockfile`) from picking up a newer compatible patch release and silently
producing different bytecode.

## Procedure

```
pnpm install --frozen-lockfile
cd contracts
pnpm exec blueprint build --all
```

Each contract's compiled BOC is written to `contracts/build/<Name>.compiled.json`
(gitignored — this is a build artifact, not source). The `hashBase64` field in each file is
the value to compare against the table below.

## Verified reproducible, this pass

Two separate `blueprint build --all` invocations (separate Node processes, same lockfile,
Node v24.16.0, pnpm 11.21.0) at commit `ac3eab67` produced **byte-identical output on all 21
contracts** — every `.compiled.json` file diffed with zero differences between the two runs,
not just matching hashes. This is what "reproducible" is actually being claimed to mean here:
not merely two runs agreeing, but the full serialized BOC (hex + hash + hashBase64) matching
exactly.

**Regenerated 2026-11-22** from the build the `20261123` testnet set was deployed from (every deployed contract's on-chain code hash matches its row). **Earlier: regenerated 2026-09-16 (the `/verify` page).** The previous table had gone badly stale and
nobody had noticed, because nothing read it: it listed 16 contracts against the 21 in
`contracts/contracts/`, still carried `PrimesMarketShard` (a contract `DECISIONS.md` D-90
deleted along with the escrow), omitted `PrimesLpPosition`, `PrimesLpSink`, `PrimesToolItem`,
`PrimesToolsCollection`, `PrimesTreasury` and `PrimesVesting` entirely, and 12 of the 16
hashes it did carry no longer reproduced. The webapp route `/verify` publishes this table
now, parsed straight out of this file, which is the reason the staleness surfaced — and the
reason it has to be regenerated with any change to a `.tolk` source, not merely "should be".
The two `Mock*` artifacts in `contracts/build/` are test fixtures for the DeDust vault and
are deliberately not listed: they are never deployed.

| Contract | Code hash (base64) |
|---|---|
| `PrimesBountyVault` | `G5T49iV0tHADJwkNjj1mYCzEz3bKRXf7e9GTHGxjf/w=` |
| `PrimesClaimReceipt` | `wqlg57E7XUl2wDK13CzkjFtC201iXynzCXHHGKpcifE=` |
| `PrimesCollection` | `ogkY7ms3jOnv6MzaYyvRYDKGSY2n+g4jrVzO3OzS5GE=` |
| `PrimesItem` | `eQn1rq3EJTUhKuxHHHFsQiz9IQTwRBWRKaedd/UtlnY=` |
| `PrimesJettonMaster` | `Zg3HTsjW/Hy4gistDLk6q0CLWpR0BOANttGVATH2UGY=` |
| `PrimesJettonWallet` | `/nclzZn5maltbEK+Bw+36MTTVWKwf3BnmnAAX3w2x88=` |
| `PrimesLedger` | `8R/l+i7h8uKdGwYrGcoRRz52JDiXOj4hG277pqS3zm8=` |
| `PrimesLotBlock` | `KWjRw9TBAInCLGKRiEHujhxbi/rgzZZxiEQyxIV2PLc=` |
| `PrimesLpPosition` | `Hufiz1Nbhwln8ExBLGXlk29a3wfM0vVYpQ1FQr6KCUQ=` |
| `PrimesLpSink` | `Wyd8aihB2HdtunCtdNrAXX0kqO+kgujP+PW0Rc+eWHU=` |
| `PrimesMarket` | `mS928yu4uTRUXp4yTR/Vn+WMnSbZlRdEesVaXEu4haM=` |
| `PrimesMinterCard` | `PnJ6roNuruo36aSzh0arg3X/nPujq+CsKRqaSQXvWIQ=` |
| `PrimesRatchet` | `dYPoBA0s9YiK7amA4rlOR4r9uhIDLDx57kdbueBWbuI=` |
| `PrimesRegistrar` | `dQh+nKi5leFyoNM8+kdiAjfJLsup2OjmzMuczxvU940=` |
| `PrimesStake` | `X38tmHr0I0TOeLlAdmeii+gbknrMuF4gXGPLAMxAlWs=` |
| `PrimesStakePosition` | `sIX0phKTf+OHA7nUydrCwKBChakCRKuOWRQd8ZLURcE=` |
| `PrimesTreasury` | `6z4gsvrD2PrGkeqdCMLjz7dLQ2syRAHRRcEsIk301Lg=` |
| `PrimesVenueTimelock` | `rI5IH8nrv7OS1MFtf0r+XY8ZH/EKXcSJ6gZZkpN2c4U=` |
| `PrimesVesting` | `b6GvNk7ST9eeffFSQKw5rhjz1zaI3053RmoQtBjte2M=` |
| `PrimesVoucher` | `BBz+jyX/cjxd89COvdHVk0hO02O5howkQbtFD4vTTJw=` |

**This table goes stale the moment a `.tolk` source file changes** (correctly — a real
source change should change the hash) or the moment `@ton/tolk-js`'s pinned version moves
in `pnpm-lock.yaml`. Regenerate it (rerun the procedure above, paste the new
`hashBase64` values) as part of any change that touches `contracts/contracts/*.tolk` or the
lockfile's `@ton/tolk-js` entry — the same discipline `docs/audit/contract-surface.md` and
`wire-format.md` already follow for their own regeneration.

## What this does not prove

- **Not verified across a different OS or Node major version.** Both runs were on the same
  machine, same Node v24.16.0. WASM execution is architecture-independent by design, so a
  different OS/CPU is not expected to matter, but that expectation has not been tested here
  against a second real environment (a second CI runner, a different developer's machine).
- **Not verified against the actual bytecode deployed on testnet.** This table records what
  the CURRENT source compiles to; `docs/testnet-deployment.md` records which contracts are
  live and when they were deployed, but the two have not been cross-checked hash-for-hash
  in this pass — a genesis redeploy or a `.tolk` change since the last deploy would make
  today's rebuild NOT match what is actually live, which is expected and correct (the whole
  point of a redeploy), not a reproducibility failure.
