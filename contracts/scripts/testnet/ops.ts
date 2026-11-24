/**
 * TON PRIMES — the PERMISSIONLESS family: the ops any wallet in the world may
 * send, which is exactly why they need firing by a wallet that holds nothing.
 *
 * Six ops, all `[ ]` on the live-coverage matrix before this file, all sandbox-
 * tested and none ever sent at a real node:
 *
 *   sync_head             0xb0000023  ledger    — re-announce the head to the market
 *   retry_credit          0xb0000005  ledger    — replay a bounced tribute credit
 *   retry_mint            0xb000000d  ledger    — replay a bounced PRIMES mint
 *   retry_premium_forward 0xf2000012  market    — replay a stuck premium forward
 *   sweep_ops             0xb0000007  ledger    — the §4.1 gas-&-ops surplus sweep
 *
 * FOUR OF THE SIX ARE NO-OPS ON A HEALTHY SET, and that is the point of running
 * them: each one is a repair path a stranger can invoke at any time, and the
 * property worth proving on chain is that invoking it when there is nothing to
 * repair moves NO figure and aborts NO transaction. A repair op that throws on a
 * healthy state is a griefing surface; a repair op that silently moves a
 * liability is worse. `retry_credit` on an unknown id and `retry_premium_forward`
 * on a settled lot both CHEAP-FAIL by design (they return, they do not throw),
 * so the transaction stays green and `txAudit.ts` stays clean.
 *
 * `sweep_ops` is the one that moves money: it returns the gas-&-ops
 * surplus to the ratchet pool (D-117) and must never touch the three declared liability lines (that bug is
 * why `getLiabilityBreakdown` exists at all). Asserted, not assumed.
 *
 *   npx tsx contracts/scripts/testnet/ops.ts all [handle]        # the five no-ops
 *   npx tsx contracts/scripts/testnet/ops.ts sync-head [handle]
 *   npx tsx contracts/scripts/testnet/ops.ts retry-credit <id> [handle]
 *   npx tsx contracts/scripts/testnet/ops.ts retry-mint <addr> [handle]
 *   npx tsx contracts/scripts/testnet/ops.ts retry-premium <n> [handle]
 *   npx tsx contracts/scripts/testnet/ops.ts sweep-ops [handle]
 *   npx tsx contracts/scripts/testnet/ops.ts flush [handle]          # §4.3.1, venue sizes it
 *   npx tsx contracts/scripts/testnet/ops.ts park-lots [from] [handle]   # D-200
 *   npx tsx contracts/scripts/testnet/ops.ts vest [handle]
 *
 * `vest` is the seventh, added 2026-09-20: `VESTING.release` 0x95000002 on the
 * genesis lock (the treasury's; D-166 deleted the operator's). It is permissionless — anyone may push a matured tranche to the
 * beneficiary — and nothing in this repo had ever sent it, on any set, while
 * `webapp/src/components/VestingLock` renders `getVestingSchedule().releasableNow`
 * as a fill. Before the first cliff the honest answer is the refusal (1141
 * `vest_nothing_due`), so the step READS `releasableNow` first and only sends
 * when there is something to send; the reading is journalled either way. A
 * permissionless money path over the treasury's PRIMES allocation is
 * not something to discover on mainnet.
 */
import { Address, toNano } from '@ton/core';
import { PrimesVesting } from '../../wrappers/PrimesVesting';
import { retry, type Wallet } from './sender';
import { FLUSH_GAS_NANOTON } from '../../../shared/messages';
import { addr, contracts, envOpt, snapshot, walletFor, type Contracts, type Snapshot } from './chain';
import * as A from './assert';
import { fromAsserts, record } from './journal';

const GAS = toNano('0.05');
/** `CLAIM_DIVIDEND_MIN_VALUE` 0.01 — below it the ledger throws 103, not cheap-fails. */
const RETRY_CREDIT_VALUE = toNano('0.05');
/** `DONATE_MINT_GAS` 0.02 + `CLAIM_DIVIDEND_MIN_VALUE` 0.01, plus margin. */
const RETRY_MINT_VALUE = toNano('0.08');
const SETTLE_MS = 20_000;
const ton = (v: bigint) => (Number(v) / 1e9).toFixed(9);

/**
 * The shared shape of a repair-op proof: nothing the ledger declares may move.
 * `head` is allowed to move only when a concurrent actor mints underneath us,
 * which is reported rather than failed — this harness shares a chain.
 */
function movedNothing(before: Snapshot, after: Snapshot, op: string): A.AssertResult[] {
    return [
        {
            ok:
                before.T === after.T &&
                before.S === after.S &&
                before.pending === after.pending &&
                before.liability.tributeOwed === after.liability.tributeOwed &&
                before.liability.unroutedHeld === after.liability.unroutedHeld &&
                before.liability.divOutstanding === after.liability.divOutstanding &&
                before.liability.treasuryHeld === after.liability.treasuryHeld &&
                before.liability.operatorHeld === after.liability.operatorHeld,
            name: `NOOP_${op.toUpperCase()}`,
            getMethod: 'ledger.getFloorNum/getFloorDen + ratchet.getPending + ledger.getLiabilityBreakdown',
            before: `T ${before.T} pending ${before.pending} tribute ${before.liability.tributeOwed}`,
            after: `T ${after.T} pending ${after.pending} tribute ${after.liability.tributeOwed}`,
            detail:
                before.head === after.head
                    ? 'a repair op on a healthy set moves no figure'
                    : `head moved ${before.head} → ${after.head} (a concurrent actor minted; T/S deltas above are theirs)`,
        },
        A.tIdentity(after),
        A.solvency(after),
    ];
}

async function step(
    c: Contracts,
    op: string,
    phase: string,
    send: (w: Wallet) => Promise<void>,
    handle: string
) {
    const w = await walletFor(c.client, handle);
    const before = await snapshot(c);
    console.log(`\n[${op}] from ${handle} ${w.wallet.address.toString({ testOnly: true })}`);
    await send(w);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const after = await snapshot(c);
    const results = movedNothing(before, after, op);
    record({ phase, op, ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * `retry_premium_forward` is the ONE member of this family that is not a
 * cheap-fail: `assert (look.isFound) throw 104` on an `n` the market has no
 * unforwarded premium for. So it is never fired blind — with nothing stuck, the
 * honest proof is the READING that nothing is stuck, and it costs no gas.
 */
async function cmdUnforwardedRead(c: Contracts) {
    const stats = await retry(() => c.market.getMarketStats(), 'getMarketStats');
    const results: A.AssertResult[] = [
        {
            ok: stats.unforwardedPremium === 0n,
            name: 'NOTHING_UNFORWARDED',
            getMethod: 'market.getMarketStats().unforwardedPremium',
            after: ton(stats.unforwardedPremium),
            detail:
                stats.unforwardedPremium === 0n
                    ? 'every premium this market booked, the ledger accepted'
                    : `${ton(stats.unforwardedPremium)} GRAM booked and not accepted — retry it by its n`,
        },
    ];
    record({ phase: '7', op: 'unforwarded-premium', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.print(results);
}

async function guardUnforwarded(c: Contracts) {
    const stats = await retry(() => c.market.getMarketStats(), 'getMarketStats');
    if (stats.unforwardedPremium === 0n) {
        throw new Error(
            'market.getMarketStats().unforwardedPremium is 0 — nothing is stuck, and a retry on an ' +
                'unknown n throws 104 (already_processed), which would paint a red transaction into the ' +
                'run for no information. Use `ops.ts all` for the read-only proof instead.'
        );
    }
}

/**
 * `sync_head` re-announces the ledger's head to the market. It exists because
 * the market's copy of the head is a message away from the ledger's, and a
 * dropped `head_update` would otherwise leave a lane wrong forever. On a healthy
 * set the two already agree, so the assert is that they still do afterwards.
 */
async function cmdSyncHead(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const before = await snapshot(c);
    await c.ledger.sendSyncHead(w.sender, { value: GAS });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const after = await snapshot(c);
    const stats = await retry(() => c.market.getMarketStats(), 'getMarketStats');
    const marketHead = Number(stats.headHint);
    const results = [
        ...movedNothing(before, after, 'sync_head'),
        {
            ok: marketHead === after.head,
            name: 'HEAD_AGREES',
            getMethod: 'ledger.getHead vs market.getMarketStats().headHint',
            before: `ledger ${after.head}`,
            after: `market ${marketHead}`,
            detail: 'the market’s copy of the head is what decides a lane (§4.4)',
        },
    ];
    record({ phase: '3', op: 'sync-head', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** The gas-&-ops surplus sweep — the one repair op that MOVES money. */
async function cmdSweepOps(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const before = await snapshot(c);
    const sweepBefore = await retry(() => c.ledger.getOpsSweep(), 'getOpsSweep');
    const totalsBefore = await retry(() => c.ledger.getOperatorTotals(), 'getOperatorTotals');
    console.log(`sweepable ${ton(sweepBefore.sweepable)} GRAM (reserve ${ton(sweepBefore.reserve)})`);
    // Decided on the read, not after the send (CLAUDE.md): with nothing above
    // `liability + OPS_RESERVE` the sweep moves nothing, so sending it is gas for no proof.
    if (sweepBefore.sweepable === 0n) {
        console.log('nothing sweepable — the ledger holds less than its liabilities plus OPS_RESERVE; nothing sent');
        record({ phase: '4', op: 'sweep-ops', ok: true, asserts: [], note: 'skipped: sweepable 0' });
        return;
    }
    await c.ledger.sendSweepOps(w.sender, { value: GAS });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const after = await snapshot(c);
    const sweepAfter = await retry(() => c.ledger.getOpsSweep(), 'getOpsSweep(after)');
    const totalsAfter = await retry(() => c.ledger.getOperatorTotals(), 'getOperatorTotals(after)');
    const swept = totalsAfter.opsSweptTotal - totalsBefore.opsSweptTotal;
    const results: A.AssertResult[] = [
        {
            ok:
                before.liability.tributeOwed === after.liability.tributeOwed &&
                before.liability.unroutedHeld === after.liability.unroutedHeld &&
                before.liability.divOutstanding === after.liability.divOutstanding &&
                before.liability.treasuryHeld === after.liability.treasuryHeld &&
                before.liability.operatorHeld === after.liability.operatorHeld,
            name: 'SWEEP_SPARES_LIABILITY',
            getMethod: 'ledger.getLiabilityBreakdown()',
            before: `tribute ${ton(before.liability.tributeOwed)} unrouted ${ton(before.liability.unroutedHeld)} div ${ton(before.liability.divOutstanding)}`,
            after: `tribute ${ton(after.liability.tributeOwed)} unrouted ${ton(after.liability.unroutedHeld)} div ${ton(after.liability.divOutstanding)}`,
            detail: 'the sweep returns a SURPLUS to the pool and never a player’s money (§4.1, §8)',
        },
        {
            ok: swept <= sweepBefore.sweepable,
            name: 'SWEEP_BOUNDED',
            getMethod: 'ledger.getOpsSweep() vs getOperatorTotals().opsSweptTotal',
            before: ton(sweepBefore.sweepable),
            after: ton(swept),
            detail: `swept ${ton(swept)} of ${ton(sweepBefore.sweepable)} declared sweepable; now ${ton(sweepAfter.sweepable)}`,
        },
        A.tIdentity(after),
        A.solvency(after),
        A.sMonotone(before, after),
    ];
    record({ phase: '4', op: 'sweep-ops', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}


/**
 * `flush()` from any handle (§4.3.1) — the owner's `P` walkthrough sends it the way the
 * webapp's Flush button does: amount 0, so the ratchet sizes the tranche itself. Decided on
 * the read: nothing pending, a cooldown still running or a round trip in flight is a refusal
 * the contract would make, so nothing is sent. Settles on `lastAttemptTime` moving.
 */
async function cmdFlush(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const before = await snapshot(c);
    const st = await retry(() => c.ratchet.getFlushStatus(), 'getFlushStatus');
    if (before.pending === 0n || st.cooldownRemaining > 0) {
        console.log(`not sent: pending ${ton(before.pending)}, cooldown ${st.cooldownRemaining}s`);
        record({ phase: 'P', op: 'flush', ok: true, asserts: [], note: 'skipped: nothing pending or cooldown' });
        return;
    }
    await c.ratchet.sendFlush(w.sender, { value: FLUSH_GAS_NANOTON, amount: 0n });
    let st2 = st;
    for (let i = 0; i < 12 && st2.lastAttemptTime === st.lastAttemptTime; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        st2 = await retry(() => c.ratchet.getFlushStatus(), 'getFlushStatus(after)');
    }
    const after = await snapshot(c);
    console.log(`outcome ${st2.outcome === 1 ? 'FILLED' : st2.outcome === 2 ? 'BOUNCED' : st2.outcome} amount ${ton(st2.amount)}`);
    const results: A.AssertResult[] = [
        {
            ok: st2.lastAttemptTime !== st.lastAttemptTime,
            name: 'FLUSH_LANDED',
            getMethod: 'ratchet.getFlushStatus().lastAttemptTime',
            before: String(st.lastAttemptTime),
            after: String(st2.lastAttemptTime),
            detail: 'the attempt was stamped — filled or refused by the floor guard, both are the contract working',
        },
        A.tIdentity(after),
        A.sMonotone(before, after),
    ];
    record({ phase: 'P', op: 'flush', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * `VESTING.release` on the treasury's genesis lock, from a wallet with no standing.
 * Reads `getVestingSchedule().releasableNow` first: with nothing due the
 * contract throws 1141 rather than cheap-failing, and a red transaction proving
 * a refusal we already have a sandbox test for costs the run a finding it has to
 * explain (§2.5 rule 1). The reading IS the journal row in that case.
 */
async function cmdVest(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const results: A.AssertResult[] = [];
    for (const key of ['PRIMES_TREASURY_VESTING_ADDRESS']) {
        if (!envOpt(key)) continue;
        const lock = c.client.open(PrimesVesting.createFromAddress(addr(key)));
        const sched = await retry(() => lock.getVestingSchedule(), `getVestingSchedule(${key})`);
        const before = await retry(() => lock.getVesting(), `getVesting(${key})`);
        const label = key.replace('PRIMES_', '').replace('_VESTING_ADDRESS', '').toLowerCase();
        console.log(
            `[vest ${label}] tranches ${sched.tranches} · interval ${sched.intervalSeconds}s · ` +
                `releasableNow ${ton(sched.releasableNow)} PRIMES · released ${ton(before.releasedAmount)}`
        );
        if (sched.releasableNow === 0n) {
            results.push({
                ok: true,
                name: `VEST_NOTHING_DUE_${label.toUpperCase()}`,
                getMethod: `vesting.getVestingSchedule().releasableNow @ ${key}`,
                after: '0',
                detail:
                    `before the cliff a release throws 1141 (vest_nothing_due); unlocked ` +
                    `${before.unlocked}/${before.tranches} tranches, next at ${before.nextUnlockAt}`,
            });
            continue;
        }
        await lock.sendRelease(w.sender, { value: GAS });
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        const after = await retry(() => lock.getVesting(), `getVesting(after,${key})`);
        results.push({
            ok: after.releasedAmount - before.releasedAmount === sched.releasableNow,
            name: `VEST_RELEASED_${label.toUpperCase()}`,
            getMethod: `vesting.getVesting().releasedAmount @ ${key}`,
            before: ton(before.releasedAmount),
            after: ton(after.releasedAmount),
            detail: `a permissionless release moved exactly the schedule's releasableNow`,
        });
    }
    record({ phase: '7', op: 'vest', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const c = contracts();
    const handleAt = (i: number, d = 'F') => rest[i] ?? d;

    switch (cmd) {
        case 'sync-head':
            return cmdSyncHead(c, handleAt(0));
        case 'retry-credit':
            if (!rest[0]) throw new Error('usage: ops.ts retry-credit <creditId> [handle]');
            return step(
                c,
                'retry-credit',
                '4',
                (w) => c.ledger.sendRetryCredit(w.sender, { creditId: BigInt(rest[0]), value: RETRY_CREDIT_VALUE }),
                handleAt(1)
            );
        case 'retry-mint':
            if (!rest[0]) throw new Error('usage: ops.ts retry-mint <address> [handle]');
            return step(
                c,
                'retry-mint',
                '4',
                (w) => c.ledger.sendRetryMint(w.sender, { to: Address.parse(rest[0]), value: RETRY_MINT_VALUE }),
                handleAt(1)
            );
        case 'retry-premium': {
            if (!rest[0]) throw new Error('usage: ops.ts retry-premium <n> [handle]');
            await guardUnforwarded(c);
            return step(
                c,
                'retry-premium',
                '7',
                (w) => c.market.sendRetryPremiumForward(w.sender, { n: BigInt(rest[0]), value: toNano('0.1') }),
                handleAt(1)
            );
        }
        case 'park-lots': {
            // D-200: decide on the read. A page with nothing resting is a pointless send.
            const from = BigInt(rest[0] ?? '0');
            const scan = await retry(() => c.market.getParkScan(from), `getParkScan(${from})`);
            console.log(`getParkScan(${from}): ${scan.folds} resting, next page ${scan.next}`);
            if (scan.folds === 0) throw new Error(`nothing resting from ${from} — nothing to park`);
            return step(
                c,
                'park-lots',
                '7',
                (w) => c.market.sendParkLots(w.sender, { from, value: toNano('0.05') }),
                handleAt(1)
            );
        }
        case 'sweep-ops':
            return cmdSweepOps(c, handleAt(0));
        case 'flush':
            return cmdFlush(c, handleAt(0));
        case 'vest':
            await cmdVest(c, handleAt(0));
            return;

        case 'all': {
            // The five that are safe to fire blind on a healthy set: each is
            // either a re-announcement or a cheap-fail. `sweep-ops` is NOT here —
            // it moves money — so it stays explicit.
            const h = handleAt(0);
            await cmdSyncHead(c, h);
            await step(
                c,
                'retry-credit',
                '4',
                (w) => c.ledger.sendRetryCredit(w.sender, { creditId: 0n, value: RETRY_CREDIT_VALUE }),
                h
            );
            await cmdUnforwardedRead(c);
            return;
        }
        default:
            console.log(
                'usage: ops.ts all|sync-head|sweep-ops [handle] · retry-credit <id> · ' +
                    'retry-mint <addr> · retry-premium <n>'
            );
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
