# Build and test reproduction — verified from a clean checkout

> **In this repository** (`primes-contracts`, the contracts published for the bug-bounty round):
> `npm ci && npm test` runs every contract suite; `npm run build` compiles every contract.
> The sections below were written for the full monorepo (pnpm, sim, backend, webapp, e2e) and
> describe more than this repository contains — the contract steps are the ones that apply.


`GAUNTLET.md` I7: "Build and test reproduction instructions, verified from a clean
checkout." `docs/audit/reproducible-build.md` (G10) already proves the CONTRACT
BYTECODE reproduces byte-for-byte; this document is the wider claim — that an auditor
who has never seen this machine can clone the repo, follow only the steps below, and
get every one of this repo's test suites green, plus a webapp production build, without
consulting anyone who has run it before. Every command below was re-run against a
genuinely fresh `git clone` (not the working tree this document was written from) at
commit `7e7bfe4` on 2026-08-30, not assumed from memory of a prior pass.

## What "clean checkout" means here

`git clone https://github.com/KonnikPahoni/primes-contracts` into an empty directory (no copied `node_modules`, no copied
`.venv`, no copied `.env`) followed only by the steps below. `.env` itself is not
required for any gate — every suite that would otherwise need a real GRAM endpoint stubs
it (contracts run against `@ton/sandbox`, the webapp's e2e specs stub `read-proxy` at
`page.route`, backend services test against fakes). `.env` is only needed for the
one-off deploy/verification scripts under `contracts/scripts/` that talk to a live
chain (H1–H9's provenance), which are out of this document's scope — `docs/audit/
deployment-story.md` covers those.

## Toolchain

- **Node.js** `>=20` (`package.json` `engines`; this pass used `v24.19.0`).
- **pnpm** `11.21.0`, pinned by `package.json`'s `packageManager` field. `corepack
  enable` is the documented way to get it; if the sandbox's corepack is already
  read-only/broken (hit in this pass — a permissions error unrelated to the repo), a
  system `pnpm@11.21.0` that already matches the pin works identically, since the pin
  is enforced by `pnpm`'s own version check, not by corepack specifically.
- **Python** `3.x` with `venv` (sim only — see below). This pass used the system
  Python 3; `sim/README.md`'s own setup section has carried this instruction unchanged
  since the sim was written.

## Procedure, and what it proved

```bash
git clone https://github.com/KonnikPahoni/primes-contracts && cd primes-contracts
npm ci
```

`--frozen-lockfile` is deliberate, not decoration: it is what makes "the same
`pnpm-lock.yaml`" mean "the same resolved dependency tree," including `@ton/tolk-js`
(the contract compiler, distributed as an npm package — see `reproducible-build.md`
for why that specific pin matters). Completed clean in this pass (10.1s, 818 packages
resolved).

### `npm test` — jest / `@ton/sandbox`

No extra setup beyond `npm ci`. Reproduced: **46 of 47 suites, 572 passed / 33
skipped / 605 total**, 128.6s, identical shape (same one pre-existing skip) to the
working tree this document was written from.

### `pnpm gate:sim` — pytest

Needs its own Python virtualenv, undocumented by `gate:sim` itself (the gate assumes
`sim/.venv` already exists — it is gitignored, so a genuinely clean checkout does not
have it):

```bash
cd sim
python3 -m venv .venv
source .venv/bin/activate      # POSIX; sim/README.md has the Windows form
pip install -r requirements.txt
pytest -q
```

Reproduced: **201 passed**, 15.2s, matching the working tree. **One environment
wrinkle, already tracked as `GAUNTLET.md` G16, reproduces identically on a clean
checkout too**: this sandbox's system Python resolves `numpy`'s C extension against a
`libstdc++.so.6` that is not on the default `LD_LIBRARY_PATH` (a Nix-store system, not
a defect in the repo), so a bare `pytest -q` fails at collection with `ImportError:
libstdc++.so.6: cannot open shared object file`. `pnpm gate:sim`'s own wrapper hits the
same fault for the same reason (already logged in G16/I1/I5's records) — this is a
sandbox property, not something a "clean checkout" can route around, and it is not
present on `sim/README.md`'s target environment (a stock Windows/Linux dev machine with
an ordinary `libstdc++`). The workaround, needed only on a Nix-store host:

```bash
LD_LIBRARY_PATH=$(dirname $(find /nix/store -name 'libstdc++.so.6' | head -1)) pytest -q
```

### `pnpm gate:backend` — typecheck + test, all six `backend/*` packages

No extra setup. Reproduced: **read-proxy 316/331 (15 skipped), event-poller 138/138**,
plus the other four packages, 12.1s total, matching the working tree. `ioredis`'s
"Unhandled error event: ECONNREFUSED" line in the log is expected noise, not a
failure — `backend/read-proxy/test/redisOptional.test.ts` is the test proving the
service degrades correctly when Redis is absent, and a clean checkout has no Redis
running by construction.

### `pnpm gate:web` — typecheck + vitest + production build

No extra setup. Reproduced: full vitest suite green and `vite build` succeeded within
the budget `tools/gate-timer.mjs` checks (`index` 273.6 kB gzip against a 300 kB
ceiling, `tonconnect` 126.5 kB gzip against a 160 kB ceiling — both `OK`), 10.7s for
the build step, matching the working tree's numbers to within noise.

### `pnpm gate:lint` — eslint over the whole workspace

A leg of `gate:full` since `GAUNTLET.md` F36 (2026-09-17); before that `pnpm lint` ran only
in CI, and it was **red on `main`** when the leg was added — seven errors across five files,
which is the CI-only gap F35 named, proven a second time. No setup beyond `pnpm install`.
Warnings (320 of them, mostly deliberate `any` at chain-decoding boundaries) do not fail it;
`eslint .` exits non-zero on errors only.

### `pnpm gate:e2e` — Playwright, the second gate

The **last leg of `gate:full`** since `GAUNTLET.md` F35 (2026-09-17); before that it was
a convention ("run it if `webapp/` moved") that no local gate contained, which is how a
red spec sat on `main` for a day. Needs one extra one-time step a clean checkout does not
have — the browser binary — which is why it is still worth naming separately here:

```bash
pnpm --filter @ton-primes/webapp exec playwright install chromium
pnpm gate:e2e
```

Reproduced: **76 passed**, 41.5s, both the `desktop` and `miniapp-390` (390×844)
projects. The config (`webapp/playwright.config.ts`) builds and serves its own preview
server (`webServer.command`), so no manually-started dev server or backend is needed —
the only external dependency is the browser binary itself, which `playwright install`
fetches.

## What this does not prove

- **Not verified on a second OS or a second machine.** All five runs above were on the
  same Linux sandbox as the working tree. `reproducible-build.md` already notes the
  Tolk compiler is WASM (architecture-independent by design) for the contracts half;
  the same expectation-not-measurement caveat applies here to the Node/Python
  toolchains generally.
- **Not a `git clone` over the network** — the clone used in this pass was a local
  filesystem clone (`git clone /path/to/repo`) to keep the verification fast and
  offline-safe; this exercises exactly the same commit-to-working-tree path a network
  clone would (same `.git` object store, same checkout), so it is not expected to
  matter, but a literal `git clone https://...` was not separately re-run to confirm.
- **`.env`-dependent scripts are out of scope here.** Anything under `contracts/
  scripts/` that deploys to or reads from live testnet (the H1–H9 provenance scripts)
  needs real credentials and a funded wallet; `docs/testnet-deployment.md` and
  `docs/audit/deployment-story.md` cover that path, not this document.
- **This table goes stale the same way `reproducible-build.md`'s does** — a real
  change to `pnpm-lock.yaml`, `sim/requirements.txt`, or a suite's pass/skip counts
  should be reflected here, not left to silently drift.
