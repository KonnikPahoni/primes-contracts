# TON PRIMES — smart contracts

The on-chain half of [TON PRIMES](https://primes.live), a number-theory game on TON:
integers are minted strictly in order as NFTs, composites with a submitted factorization,
primes proved by on-chain Miller–Rabin, and every mint feeds a ratchet whose floor price
`p_f = T / S` can only rise. This repository is the code under review for the bug-bounty
round: the Tolk contracts, their TypeScript wrappers, the jest/`@ton/sandbox` test suite,
the deploy scripts, and the published spec and audit pack.

## Layout

| Path | What it is |
|---|---|
| `contracts/contracts/*.tolk` | The contracts (Tolk, compiled with `@ton/tolk-js` 1.4.2) |
| `contracts/wrappers/` | TypeScript wrappers and `*.compile.ts` configs (`@ton/blueprint`) |
| `contracts/tests/` | The test suite, run against `@ton/sandbox` |
| `contracts/scripts/` | Testnet deploy/verification scripts (need a `.env` with a funded wallet; not needed for tests) |
| `shared/` | Opcodes, TL-B schemas (`shared/schemas/*.tlb`), message builders, `params.json` |
| `sim/` | The Python economic simulation that produces `shared/params.json` |
| `backend/agent/`, `backend/mcp/` | Source of the [`@ton-primes/agent`](https://www.npmjs.com/package/@ton-primes/agent) SDK and the [`@ton-primes/mcp`](https://www.npmjs.com/package/@ton-primes/mcp) MCP server. Source only: they are not in this repo's npm workspaces, and their `workspace:*` dependencies and `pnpm` scripts are the main project's. Install from npm to use them. `backend/common/src/` holds the three helpers the SDK imports |
| `CONCEPT.md` | The specification |
| `docs/audit/` | The audit pack — start at [`docs/audit/index.md`](docs/audit/index.md) |

A few files from the main project are present only because tests read them:
`backend/attribution/src/` (the off-chain voucher signer, used by `PrimesVoucher.spec.ts`),
`tools/*.mjs` (generators for four `docs/audit` pages the tests check are current),
`webapp/src/chain/messages.ts` and `webapp/public/*.json`.

## Build and test

Node.js 20 or newer:

```bash
npm install
npm test          # the full jest suite
npm run build     # blueprint build --all → contracts/build/*.compiled.json
```

`SimCrossCheck.spec.ts` replays a simulation trace through the sandbox and is skipped
when that trace is absent. To include it (Python 3.12+):

```bash
cd sim && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && cd ..
npm run test:full   # generates sim/output/chain_replay_trace.json, then runs npm test
```

## Deployed addresses

The live testnet address set is served at <https://primes.live/api/contracts>. The genesis
sequence that produced it, and who holds which key, is
[`docs/audit/deployment-story.md`](docs/audit/deployment-story.md).
