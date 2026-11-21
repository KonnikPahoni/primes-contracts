# Rebuilding the index from the chain — the procedure, and what it measured

**GAUNTLET.md X7.** `G4` closed the backup **restore** drill, which proves the backup works.
This is the other recovery path: **the one for the day the backups are gone, corrupt, or from
a schema three migrations old.**

Everything in `event-poller`'s tables is *derived* from chain events that are still on chain,
so a rebuild is possible in principle. It had never been done. This page is the run.

**Performed 2026-09-17** against the live testnet deployment (genesis 2026-09-16), from a
genuinely empty Postgres, and diffed against the running index at `primes.live`.

---

## The procedure — there is no tooling, and that is the finding

**Point the poller at an empty database and start it.** That is the whole of it.

`PollerCheckpoints.getLt()` returns `0n` when no checkpoint row exists, and the event source
pages forward from there, so **an empty database *is* "start from genesis"**. Nothing has to be
told to backfill; the absence of a cursor is the instruction.

```bash
# 1. An empty database with the current schema.
docker run -d --name rebuild -e POSTGRES_PASSWORD=… -e POSTGRES_DB=ton_primes -p 55432:5432 postgres:16-alpine

# 2. The poller, against the SAME contract addresses, with DATABASE_URL pointed at it.
#    Migrations run on boot; no separate step.
DATABASE_URL=postgres://…@localhost:55432/ton_primes \
PRIMES_LEDGER_ADDRESS=… PRIMES_RATCHET_ADDRESS=… (…all eight…) \
  pnpm --filter @ton-primes/event-poller start

# 3. Watch the cycle log. `fetched=N inserted=N duplicates=0` with every account's cursor
#    populated, followed by `fetched=0`, is "caught up".
```

**It is safe to run beside the live one.** A rebuild is reads plus inserts into its own
database; it sends no transaction and touches no chain state.

---

## What the run measured, 2026-09-17

| | |
|---|---|
| **Wall-clock to fully caught up** | **16.7 s** from process start — one cycle |
| **Rows reconstructed** | `raw_events` 31, `flushes` 1, `pool_injects` 1, everything else 0 |
| **Accounts covered** | all **eight** the poller watches, each with its own cursor advanced |
| **Page cap hit?** | no — `MAX_PAGES_PER_CYCLE` (50) was never approached |
| **Errors** | none |

Per-account transaction counts, which is the number the extrapolation below rests on:
ledger 7, registrar 6, ratchet 6, treasury 3, tools collection 3, LP sink 3, constellations
collection 2, market 1.

### The diff against the running index

The live index at `primes.live` reports, in full: `mints: []`, and **one** event — a `flush`
from the ratchet at `2026-09-16T21:43:58Z`, `tx_hash`
`3Ntqw2pCpPVYlDD02jRvhqzrzxR/Shxf652esXPV8kY=`.

The rebuilt database reports the same flush, at the same timestamp, with a **byte-identical
`tx_hash`**, and the same zero mints. The chain agrees: `getHead()` = 4 with nothing minted,
which is the un-ignited state `docs/testnet-deployment.md` records for this genesis.

**So the rebuild reconstructs the same rows.** That is the claim X7 asked for, and it is now
made against a measurement rather than a design argument.

---

## What 16.7 seconds does NOT prove, stated plainly

**This deployment has 31 transactions across eight accounts.** A ten-year mainnet index will
have orders of magnitude more, and the honest reading of the number above is "the mechanism
works end to end", **not** "a rebuild is fast".

The extrapolation the source's own constants support:

- `PAGE_LIMIT` = 100 transactions per request.
- `MAX_PAGES_PER_CYCLE` = 50, so **5,000 transactions per account per cycle**, then it logs
  the cap and resumes next cycle — deliberately, because *"a silent cap is indistinguishable
  from caught up"*.
- Requests are paced at ~1.1 s, so a full 50-page cycle is ~55 s per account.

So a rebuild is roughly **(transactions ÷ 5,000) cycles**, and a busy account with a million
transactions is ~200 cycles — hours, not minutes, but bounded and resumable, and it reports
its own progress the whole way. **Nothing in the design fails at scale; what changes is the
clock.**

### The gaps this exposed

1. **The upstream's own retention is the real limit, and it is untested here.** The poller can
   only reconstruct what the indexer it queries will still serve. A provider that prunes
   transaction history below some depth silently bounds the rebuild, and nothing in this run
   probed that — the deployment is a day old. `docs/rpc-failover.md` §4 names the same class of
   gap for a provider switch. **This is the one thing that could turn the rebuild from a
   recovery path into a theoretical one**, and it deserves its own measurement against an
   account with real history.
2. **A rebuild is not verified against a NON-empty divergence.** This run started from empty
   and ended matching. It does not prove the poller repairs a *partially* wrong database — and
   it should not be assumed to: `ON CONFLICT DO NOTHING` on `raw_events` means a corrupt row
   already present is kept, not corrected. **The procedure is "empty database", not "repair in
   place"**, and using it the other way would preserve exactly the corruption it was run to fix.
3. **Derived state outside `event-poller`'s own tables is out of scope.** `read-index` owns the
   `index_*` tables in the same database; this run rebuilt the poller's and says nothing about
   those.

---

## Relationship to the backup drill

`G4`'s restore drill and this are different failures and both are needed:

- **Restore** is faster and recovers *everything*, including anything not derivable from chain
  events — but only as good as the newest backup, and worthless if the backups are corrupt or
  schema-stale.
- **Rebuild** is slower and recovers only what the chain still carries — but needs nothing
  except the contract addresses and an upstream that still serves history.

The second is the one that survives losing the first.
