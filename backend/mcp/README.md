# `@ton-primes/mcp`

[![npm](https://img.shields.io/npm/v/@ton-primes/mcp.svg)](https://www.npmjs.com/package/@ton-primes/mcp)
[![mcp](https://img.shields.io/badge/MCP-stdio-blue.svg)](https://modelcontextprotocol.io)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

An MCP server for [TON PRIMES](https://primes.live). Point an agent at it and it can read
the game's published chain state and, with a local key, play.

**25 tools: 14 reads and 11 writes.** The eleven writes are every message a
program-player can send — there is no action in this game that the library can take and the
model cannot. Each one **quotes before it spends** and sends only on `confirm: true`.

## Install

Claude Code:

```
claude mcp add ton-primes -- npx -y @ton-primes/mcp
```

Claude Desktop, Cursor and anything else that reads a JSON config:

```json
{
  "mcpServers": {
    "ton-primes": {
      "command": "npx",
      "args": ["-y", "@ton-primes/mcp"],
      "env": { "PRIMES_NETWORK": "testnet" }
    }
  }
}
```

Read-only with no `PRIMES_MNEMONIC`. Add one to play:

```json
"env": {
  "PRIMES_NETWORK": "testnet",
  "PRIMES_MNEMONIC": "<24 words for a DEDICATED wallet>",
  "PRIMES_REFERRAL_KEY": "42"
}
```

The key stays in this process. The server runs over stdio on your machine and no service of
this project holds a key, which is why there is no hosted version.

## Tools

### Read

| Tool | What it does |
| --- | --- |
| `primes_head` | The next integer to be minted. |
| `primes_floor` | `p_f = T / S`, as a ratio. Strictly increasing on every mint. |
| `primes_route` | How a number can be acquired right now: at the head, as a lot, or already minted. |
| `primes_lot` | One lot's live mode, standing price and minimum next bid. |
| `primes_open_lots` | Lots open now. |
| `primes_portfolio` | The numbers a wallet holds — CANDIDATES; `primes_confirm_numbers` settles them. |
| `primes_number` | Who owns one number, and what tribute stands to it. |
| `primes_name` | Who may name a number (its owner), what it is called, and the GRAM the next naming costs. |
| `primes_contracts` | The deployment manifest, by role. |
| `primes_wallet` | One wallet in one call: GRAM, PRIMES, both rank ladders. |
| `primes_ratchet` | Whether `flush()` is worth calling: pending, swapped, floor, last outcome. |
| `primes_lot_price` | What opening a lot would cost, and which lane — including "not openable". |
| `primes_confirm_numbers` | Settle up to 24 numbers against their own items. Ownership, confirmed. |
| `primes_audit` | Supply and solvency, together. Every figure names its get-method. |

The last five are **composite on purpose**. A tool per HTTP route would hand a model forty
names to choose between; these answer a question an agent actually asks before it acts —
*what do I hold, is flushing worth it, what would this cost, do I really own these* — in
one call. The per-route reads all exist in [`@ton-primes/agent`](https://www.npmjs.com/package/@ton-primes/agent)
for a program that wants them.

### Write

| Tool | What it does |
| --- | --- |
| `primes_mint` | Mint the head for 1 GRAM. The factorization proof is computed for you. |
| `primes_bid` | Bid on a lot. On a prime's descending lot the bid is the purchase. |
| `primes_open_lot` | Open an ascending lot on a composite ahead of the head. |
| `primes_open_head_lot` | Open a prime's descending lot. Gas only. |
| `primes_close_lot` | Close an ascending lot whose clock has run. Permissionless. |
| `primes_claim_tribute` | Claim the tribute owed to a number you own. |
| `primes_name_number` | Name a number you own, for GRAM (D-212): `nameFee` first, `renameFee` after. The fee goes to the floor. |
| `primes_annotate` | Engrave an era trophy (one of the eight primorials). The first engraving is free; later ones cost the registrar's rename fee in GRAM. |
| `primes_flush` | Call `flush()`. Permissionless; TON has no scheduler. |
| `primes_harvest` | Call `harvest()`: the staked reserve's yield to the treasury. Permissionless, caller-paid. |
| `primes_sweep_ops` | Call `sweep_ops`: the gas & ops line's unspent balance into the floor pool. Permissionless. |

**Every write tool quotes first and sends only on `confirm: true`.** The quote runs the
same live chain reads the send does, so a refusal shows up before anything is signed — and
for the two that spend on a name (`primes_name_number`, `primes_annotate`) the quote states
the live fee before it asks.

The split is enforced rather than documented: `test/tools.test.ts` asserts that no read
takes `confirm`, that every write does, that each of the SDK's eleven actions has a tool
behind it, and that no two tools share a name — a collision is silent in the registry and
fatal at startup, and it has happened once.

**What is deliberately absent:** the LP miner and the governed treasury (`DECISIONS.md`
D-100). A deposit has to leave from the depositor's DeDust LP jetton wallet, and the
read-proxy reports that address as `null` on every deployment because the DeDust master is
not a configured role — so those messages are not shipped as though they worked. The social
quests are absent too: `CONCEPT.md` §9.10 says they are the one surface the agent stance
does not cover.

## Environment

| Variable | Default |
| --- | --- |
| `PRIMES_MNEMONIC` | unset — read-only |
| `PRIMES_NETWORK` | `testnet` |
| `PRIMES_REFERRAL_KEY` | `0` (that line goes to the pool, never to the team) |
| `TONCENTER_API_KEY` | unset |
| `PRIMES_READ_PROXY_URL` | `https://primes.live/api` |
| `PRIMES_READ_INDEX_URL` | `https://primes.live/idx` |
| `PRIMES_EVENTS_URL` | `https://primes.live/events` |

Every variable is optional. With none of them set the server starts read-only against
testnet and the published hosts.

## Notes for the client author

- **stdio only.** Signing is local (`DECISIONS.md` D-131.2). A hosted remote MCP would mean
  custody of a player's key, which is why there is not one.
- **Every integer crosses as a decimal STRING**, in both directions. JSON has no bigint and
  a nanoGRAM figure routinely exceeds 2⁵³, so `n`, `target` and every `*Nanoton` are strings.
- **`null` is not an error.** It is a route whose get-method is not on the deployed
  contract. Do not render it as zero.
- **An error comes back as `isError: true`** with the message the SDK threw, which names
  what was refused and why.

## Before you spend

Read `CONCEPT.md` §8. Every automated behaviour in this game is priced rather than banned,
and none of the loops returns more than it pays at the floor. §8.1 names the one regime
where that inverts and publishes the threshold. The game is pre-launch and testnet-only.

Changelog: [CHANGELOG.md](./CHANGELOG.md). The SDK underneath: [`@ton-primes/agent`](https://www.npmjs.com/package/@ton-primes/agent).
