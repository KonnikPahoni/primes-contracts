# `@ton-primes/agent`

[![npm](https://img.shields.io/npm/v/@ton-primes/agent.svg)](https://www.npmjs.com/package/@ton-primes/agent)
[![types](https://img.shields.io/badge/types-included-blue.svg)](#api)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Play [TON PRIMES](https://primes.live) from a program.

Integers are minted strictly sequentially as NFTs for a flat 1 GRAM. Composites need a
submitted prime factorization, primes are verified on chain by Miller–Rabin, and the
residual of every mint is injected into a ratchet whose internal floor price `p_f = T / S`
is strictly increasing on every mint. That last one is a contract-verifiable invariant, not
a promise — which is the point of this package.

Programs are welcome players (`CONCEPT.md` §9.10). Nothing here is a privilege: there is
no API key, no allow-list, and no contract path with a cooldown or a per-wallet cap. This
package is the published read endpoints, the same message builders the app signs with, and
a wallet that signs locally.

**Complete by construction.** Every message a program-player can send has a method, and
every route in the two published OpenAPI specs has a read. That is not a claim in this
file — it is `test/coverage.test.ts`, which reads all three lists out of the repository and
fails until a new builder or a new route is either wired or named as excluded **with its
reason**. See [What is deliberately not here](#what-is-deliberately-not-here).

- [Install](#install)
- [Read first, spend second](#read-first-spend-second)
- [Play](#play)
- [The rules this enforces for you](#the-rules-this-enforces-for-you)
- [API](#api)
- [Errors](#errors)
- [What the game rewards a program for](#what-the-game-rewards-a-program-for)

## Install

```
npm install @ton-primes/agent
```

Node 20+, ESM, TypeScript declarations included. Peer-free: `@ton/core`, `@ton/crypto` and
`@ton/ton` are regular dependencies.

## Read first, spend second

```ts
import { PrimesAgent } from "@ton-primes/agent";

const agent = new PrimesAgent({ network: "testnet" });   // read-only: no mnemonic

await agent.read.head();       // the next integer to be minted
await agent.read.floor();      // p_f as { numNanoton, denPrimes } — a ratio, never pre-divided
await agent.read.counters();   // T and S, and the two counters that are not deployed yet
await agent.read.number(7n);   // who owns 7, and what tribute stands to it
await agent.routeFor(1234n);   // "head" | "lot" | "claimed" | "past", read live off the chain

await agent.read.openLots();            // candidates from the index
await agent.read.lotPrice(5040n);       // what opening a lot would cost, and which lane
await agent.read.contracts();           // which address holds which role
```

Every read-proxy response carries a `provenance` object naming the get-method and the
contract address behind the figure, so anything the SDK returns can be recomputed by
calling that method yourself. Verify before you spend; the design assumes you will.

Two things the read layer will not do to you:

- **No `Number()` on a money figure.** Everything monetary decodes to `bigint`. A nanoGRAM
  balance past 2⁵³ is ordinary, and rounding one is not an option.
- **No index figure priced into a transaction.** `read.*` is for browsing. Everything
  under `chain()` is a live `runMethod`, and that is what the `act` methods check
  themselves against.

## Play

```ts
const agent = new PrimesAgent({
  mnemonic: process.env.PRIMES_MNEMONIC,  // 24 words, a DEDICATED wallet
  network: "testnet",
  referralKey: 42,                        // a number you own: it is paid on every mint
});

await agent.mint();                       // 1 GRAM for the number at the head
await agent.mint({ invites: { count: 3, addresses: [{ slot: 1, address: "UQ..." }] } });
                                          // §4.1: up to 3 slots of 0.1 GRAM, plain transfers to
                                          // addresses YOU choose (keeper's /api/invitees is a default)
await agent.openLot({ n: 5040n });        // any number ahead of the head, prime or composite — opening IS the first bid
await agent.openHeadLot(9973n);           // a prime's descending lot
await agent.bid({ n: 9973n });            // on a descending lot, the bid IS the purchase
await agent.closeLot(5040n);              // permissionless, once an ascending clock has run
await agent.flush();                      // permissionless: TON has no scheduler
```

### Getting paid

```ts
await agent.claimTribute(7n);             // §4.1's divisor share, off 7's own item
await agent.name({ n: 9n, text: "the first odd square" });     // D-212, a number you own, for GRAM
await agent.annotate({ n: 30n, text: "the third primorial" });  // §4.7.1, an era trophy's engraving (first free)
await agent.transferTrophy({ primorial: 30n, newHolder: "EQ..." });   // D-14, holder only
```

The factorization and each `⌊√p⌋` are computed for you from the same modules the contract
tests use, so a mint cannot carry a proof the ledger will reject.

## The rules this enforces for you

1. **A number you are about to spend against is re-read from the chain.** `mint` checks the
   live head, `bid` checks the live `getLot(n)`. The HTTP index finds candidates; it never
   prices a transaction.
2. **Every refusal the contract would make is made first, off chain.** Not the owner, a
   zero `owed`, a claimed number, a naming right already spent, an empty
   `pending`, a flush inside its 24-hour cooldown. Each is a thrown `Error` before a wallet
   opens, where the contract's version of the same refusal is gas already paid.
3. **Nominal price plus a fee margin, never the exact price.** The contract compares the
   value that *arrives*, after GRAM deducts the message's forward fee. Sending the exact
   nominal reverts.
4. **Throttled at the client.** read-proxy allows 600 requests a minute per IP, read-index
   120; both answer `429` with `Retry-After`. The default is 2 requests a second with one
   bounded retry, and it fails loudly rather than queueing on your behalf.
5. **Your key never leaves your process.** No service in this project holds one.

## API

### `new PrimesAgent(options)`

| Option | Default | |
| --- | --- | --- |
| `mnemonic` | — | 24 words. Omit for a read-only agent: every action then refuses by name. |
| `network` | `"testnet"` | Selects the default Toncenter endpoint. |
| `tonEndpoint`, `tonApiKey` | Toncenter public | Your own RPC, if you have one. |
| `addresses` | from `/contracts` | Skip the manifest fetch by passing the roles yourself. |
| `referralKey` | `0` | §4.1's referral line: a number **you** own. `0` routes it to the pool, never to the team. |
| `readProxyUrl`, `readIndexUrl`, `eventsUrl` | `primes.live` | The three services. |
| `rps` | `2` | Client-side pacing, across all three. |
| `fetchImpl` | `globalThis.fetch` | Injectable, for tests and proxies. |

### Actions — every message a program-player can send

| Method | Sends to | Costs |
| --- | --- | --- |
| `mint({ n?, beneficiary?, referralKey?, invites? })` | ledger | 1 GRAM |
| `bid({ n, bidNanoton?, beneficiary?, referralKey? })` | market | the bid |
| `openLot({ n, bidNanoton?, … })` | market | the opening bid |
| `openHeadLot(n)` | market | gas |
| `closeLot(n)` | market | gas |
| `claimTribute(n)` | `n`'s **own item** | gas |
| `topUp(n, multiples?)` | `n`'s **own item** | `multiples` x the item endowment — **permissionless on ANY number** |
| `name({ n, text })` | collection | `nameFee` first, `renameFee` after, read live — **owner only** (D-212) |
| `annotate({ n, text })` | registrar | gas for the first engraving, the registrar's `getTrophyRenameFee()` after — **era trophies only** |
| `transferTrophy({ primorial, newHolder })` | registrar | gas — **holder only** (D-14) |
| `flush()` | ratchet | gas |
| `swap({ side, amount, slippageBps? })` | DeDust's **native vault** (buy) or this wallet's **own PRIMES jetton wallet** (sell) | the amount + the venue's gas |

### Reads

`agent.read` is a [`PrimesRead`](./src/read.ts) over the three published services, and
`agent.chain()` is a [`PrimesChain`](./src/chain.ts) of live `runMethod` calls. Grouped:

- **the ratchet and the ledger** — `head`, `floor`, `counters`, `pending`, `swapped`,
  `flushStatus`, `floorCache`, `staking`, `ratchetIdentity`, `k`, `kMax`, `lastMintTime`, `seedT`,
  `eraLeader`, `bootstrap`
- **one wallet** — `balance`, `seqno`, `primesBalance`, `ranks`, `earn`, `numbersOf`,
  `claimsOf`, `historyOf`, `contestOf`, `portfolioOf`
- **numbers, lots and prices** — `number`, `numbers`, `isKnownPrime`, `itemAddress`,
  `name`, `numberTrophy`, `runway`, `tributeTotal`, `yieldOf`, `lot`, `lotPrice`, `lotFloor`, `score`,
  `trophy`, `trophyParams`, `isOffHead`, `feeSplit`, `openLots`, `lotHistory`,
  `cheapestLot`, `unclaimedOffers`
- **the collection market** — `collections`
- **the bounty vault** — `vault`, `eraSchedule`, `rebate`, `vaultProgram`
- **the auditor's surfaces** — `supply`, `solvency`, `venue`, `market`, `vesting`,
  `treasury`, `treasuryProposals`, `treasuryLedger`, `stake`, `stakePositions`, `stakeLedger`, `lpPositions`, `lpLocked`,
  `lpWallet`, `contracts`
- **the index's own tables** — `indexStatus`, `board`, `feed`

Anything not named: `read.proxy<T>(path)`,
`read.index<T>(path)` and `read.events<T>(path)` are the escape hatches, one per service.

### Helpers

`factorize(n)`, `isqrt(v)`, `isProbablePrime(n)` — the contract's own arithmetic, so a
proof you build with them is a proof the ledger accepts. `NAME_MAX_CHARS`,
`BID_FEE_MARGIN`.

## Errors

Everything throws a plain `Error` with a message written to be read by whoever has to fix
it. Four kinds, and they are worth telling apart:

| Looks like | Means |
| --- | --- |
| `this agent is read-only: …` | constructed without a `mnemonic`. Thrown **before** any network call. |
| `n=99 is not the head (12); …` | a pre-check refused what the contract would have refused. Nothing was sent, nothing was spent. |
| `GET …/ledger/head -> 429 twice; slow down` | the rate-limit budget is genuinely spent. Lower `rps`; the SDK will not queue for you. |
| `wallet seqno did not advance within 45000ms` | the transfer was signed and sent, and confirmation timed out. **The message may still land** — re-read state before retrying. |

`null` from a read is never an error: it is a route whose get-method is not on the deployed
contract, and the methods that can return it say so in their own doc comments.

## What the game rewards a program for

- **A referral key is a bearer asset.** `rN` pays the current owner of number `N` on every
  mint made under it, including your own.
- **`flush()` is permissionless.** TON has no scheduler, so the ratchet relies on someone
  calling it.

What it does not reward: a loop. Every automated behaviour is priced at the floor in
`CONCEPT.md` §8 — a mint loop returns less than it pays, self-referral is assumed universal
rather than prevented, and a recruit costs a fresh address plus a full 1 GRAM mint. §8.1
names the one regime where that inverts and publishes the threshold. Read it before you
model a return.

## What is deliberately not here

**The LP miner and the governed treasury** (`DECISIONS.md` D-100 — eight message builders).
A deposit has to leave from the depositor's DeDust LP jetton wallet, and read-proxy reports
that address as `null` on every deployment because the DeDust master is not a configured
role. Every position message needs a position, and a position needs a deposit. They are not
wrapped as though they worked.

**Ten read routes**, each for a stated reason: a liveness probe, an SSE stream, rendered
artwork, TEP-64 metadata served for a wallet's own fetcher, and four narrative surfaces the
webapp computes for its own charts. `test/coverage.test.ts` carries the list with the reason
per line, and a new route in either spec fails that test until somebody classifies it.

## Reference

- The action loop and the OpenAPI specs: <https://primes.live/llms.txt>
- The spec: <https://primes.live/docs/CONCEPT.md> (§9.10 is the stance on programs)
- The audit pack: <https://primes.live/docs/audit/>
- The MCP server over this SDK: [`@ton-primes/mcp`](https://www.npmjs.com/package/@ton-primes/mcp)
- Changelog: [CHANGELOG.md](./CHANGELOG.md)
