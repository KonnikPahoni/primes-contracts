/**
 * TON PRIMES — the venue timelock, the protocol's ONLY admin surface, end to end.
 *
 * `queue` has been sent live on every genesis this project ever deployed (it is
 * a step in the genesis runbook). `cancel`, `execute` and `retry_update_venue`
 * have been sent on NONE of them, on any set, ever — because `TIMELOCK_DELAY` is
 * 30 days and D-139's test clock did not reach this contract until the redeploy
 * that carries this script. At divisor 168 the delay is ~4.3 hours: queue in the
 * run's first phase, execute in its last.
 *
 * WHAT IS QUEUED, AND WHY IT IS THE CURRENT VENUE. `execute` re-points the
 * ratchet's DeDust venue, which is the one address the flush swaps against. A
 * run that queues a DIFFERENT venue proves the mechanism by breaking the pool
 * every later phase needs. So this queues the venue the ratchet ALREADY has,
 * read off `getVenue()`: the transition is real, permissionless and observable,
 * and its effect is the identity.
 *
 * THE VENUE IS THREE ADDRESSES (D-194). §4.3.2's staking block is ratchet deploy
 * data that `update_venue` no longer carries, so no queue can move it.
 *
 * TWO KEYS (D-194). `execute` also needs the record CONFIRMED by a passed LP vote:
 * a treasury venue-confirm proposal (asset 3, amount = the record's `seq`, dest =
 * this timelock), opened, voted and executed with `lpGovernance.ts`. The vote may
 * open no earlier than `eta − voteDuration` (audit H1: it must close at or after the
 * eta, 808), so it runs at the END of the notice — and since audit R2-H1 the treasury
 * opens it `noticeDuration` after the propose, so the proposal is PROPOSED no earlier
 * than `eta − noticeDuration − voteDuration`. `execute` here reads `confirmed`
 * first and prints those steps instead of sending.
 *
 * THIS SCRIPT QUEUES THE IDENTITY AND NOTHING ELSE, and there is deliberately no
 * flag to make it queue anything else. A real venue change is a governance act
 * with a named destination; it belongs in a script written for that change,
 * where the addresses are arguments a reader can check — not a default this
 * harness reaches by omission (the 2026-09-21 failure, MISTAKES.md).
 *
 *   npx tsx contracts/scripts/testnet/timelock.ts status
 *   npx tsx contracts/scripts/testnet/timelock.ts queue            # from the proposer (K)
 *   npx tsx contracts/scripts/testnet/timelock.ts execute [handle] # permissionless
 *   npx tsx contracts/scripts/testnet/timelock.ts retry   [handle] # permissionless
 *   npx tsx contracts/scripts/testnet/timelock.ts cancel            # from the proposer (K)
 */
import { toNano } from '@ton/core';
import { PrimesVenueTimelock } from '../../wrappers/PrimesVenueTimelock';
import { PrimesRatchet } from '../../wrappers/PrimesRatchet';
import { retry } from './sender';
import { addr, contracts, testnetConfig, walletFor, type Contracts } from './chain';
import { clockDivisorOf } from '../envFile';
import * as A from './assert';
import { fromAsserts, record } from './journal';

/** `TIMELOCK_DELAY` in `primes_venue_timelock.tolk`, before D-139's divisor. */
const TIMELOCK_DELAY = 2_592_000;
const GAS = toNano('0.2');

function timelockOf(c: Contracts) {
    return c.client.open(PrimesVenueTimelock.createFromAddress(addr('PRIMES_VENUE_TIMELOCK_ADDRESS')));
}
function ratchetOf(c: Contracts) {
    return c.client.open(PrimesRatchet.createFromAddress(addr('PRIMES_RATCHET_ADDRESS')));
}

/** The divisor this set was deployed with, from `testnet.yaml` — the same source genesis read. */
function clockDivisor(): number {
    return clockDivisorOf(testnetConfig());
}

async function cmdStatus(c: Contracts) {
    const q = await retry(() => timelockOf(c).getQueued(), 'getQueued');
    const v = await retry(() => ratchetOf(c).getVenue(), 'getVenue');
    const now = Math.floor(Date.now() / 1000);
    console.log(
        `hasQueued ${q.hasQueued}  fired ${q.fired}  seq ${q.seq}  confirmed ${q.confirmed}  eta ${q.eta}` +
            (q.eta ? ` (${q.eta - now}s away)` : '')
    );
    console.log(`queued  pool ${q.dedustPool.toString({ testOnly: true })}`);
    console.log(`ratchet pool ${v.dedustPool.toString({ testOnly: true })}`);
    // WHAT THIS SET ENFORCES IS NOT WHAT `testnet.yaml` SAYS, unless the set was deployed
    // from bytecode carrying D-139's fifth consumer. The divisor is address- and
    // deploy-determining, so on an older set the delay is still the full 30 days
    // however `test_overrides.auction_seconds` reads here. `q.eta` is the authority: a
    // record queued ~30 days out is a pre-divisor timelock.
    const delay = Math.floor(TIMELOCK_DELAY / clockDivisor());
    console.log(
        `delay if this set carries D-139's divisor (${clockDivisor()}): ${delay}s ` +
            `(${(delay / 3600).toFixed(2)}h) — otherwise ${TIMELOCK_DELAY}s`
    );
    return { q, v };
}

async function cmdQueue(c: Contracts) {
    const w = await walletFor(c.client, 'K'); // the proposer is the deploy subwallet
    const tl = timelockOf(c);
    // GAUNTLET.md B30. `queue` now refuses to overwrite a PENDING change (803), so this
    // arm has to know the row before it sends — the same send-before-read rule the
    // `execute` arm below was violating. A fired record is re-queueable, which is how the
    // next change is proposed; an unfired one must be withdrawn with `cancel` first, and
    // saying so here is the difference between a helpful refusal and a red transaction.
    const queued = await retry(() => tl.getQueued(), 'getQueued');
    const v0 = await retry(() => ratchetOf(c).getVenue(), 'getVenue');
    // A FRESH GENESIS ARRIVES HERE WITH ITS OWN RECORD: `genesisPipeline.ts` step 8 queues
    // the identity venue at the DIVIDED delay, so it is exactly what this arm would queue,
    // and it matures on the run's clock. A satisfied precondition sends nothing — the
    // record is the run's, and D-194's confirm vote (phase 5) names its seq.
    if (
        queued.hasQueued === 1 &&
        queued.fired !== 1 &&
        queued.dedustNativeVault.equals(v0.dedustNativeVault) &&
        queued.dedustPool.equals(v0.dedustPool) &&
        queued.primesJettonVault.equals(v0.primesJettonVault)
    ) {
        const results: A.AssertResult[] = [
            {
                ok: true,
                name: 'VENUE_QUEUED',
                getMethod: 'venueTimelock.getQueued() vs ratchet.getVenue()',
                after: `hasQueued 1 fired 0 seq ${queued.seq} confirmed ${queued.confirmed} eta ${queued.eta}`,
                detail: 'the identity venue is already queued (the genesis record) — nothing sent',
            },
        ];
        record({ phase: '0', op: 'timelock-queue', ok: true, asserts: fromAsserts(results) });
        A.requireAll(results);
        return;
    }
    if (queued.hasQueued === 1 && queued.fired !== 1) {
        throw new Error(
            `a change is already queued and not yet executed (eta ${queued.eta}, ` +
                `${Math.max(0, queued.eta - Math.floor(Date.now() / 1000))}s away). Queueing over it ` +
                'throws 803 — the advertised delay is the point, so a pending change is withdrawn ' +
                'with `timelock.ts cancel`, visibly, rather than silently replaced.'
        );
    }
    const v = v0;
    const delay = Math.floor(TIMELOCK_DELAY / clockDivisor());
    // Reached only with no pending record (none, or a fired one): the genesis
    // record is taken as-is above, and B30 forbids overwriting an unfired one.
    //
    // +120s of margin over the contract's own floor: `eta` is compared against
    // the CHAIN's clock, and this host's has been an hour out before.
    const eta = Math.floor(Date.now() / 1000) + delay + 120;
    console.log(`queueing the CURRENT venue, eta ${eta} (${delay + 120}s out)`);
    await tl.sendQueue(w.sender, {
        dedustNativeVault: v.dedustNativeVault,
        dedustPool: v.dedustPool,
        primesJettonVault: v.primesJettonVault,
        eta,
        value: GAS,
    });
    await new Promise((r) => setTimeout(r, 20_000));
    const q = await retry(() => tl.getQueued(), 'getQueued(after)');
    const results: A.AssertResult[] = [
        {
            ok: q.hasQueued === 1 && q.fired === 0 && q.eta === eta,
            name: 'VENUE_QUEUED',
            getMethod: 'venueTimelock.getQueued()',
            after: `hasQueued ${q.hasQueued} fired ${q.fired} eta ${q.eta}`,
            detail: `a venue change is public the moment it is queued, and matures at ${eta}; confirm seq ${q.seq}`,
        },
        {
            ok:
                q.dedustNativeVault.equals(v.dedustNativeVault) &&
                q.dedustPool.equals(v.dedustPool) &&
                q.primesJettonVault.equals(v.primesJettonVault),
            name: 'QUEUED_IS_CURRENT_DEDUST_VENUE',
            getMethod: 'venueTimelock.getQueued() vs ratchet.getVenue()',
            before: v.dedustPool.toString({ testOnly: true }),
            after: q.dedustPool.toString({ testOnly: true }),
            detail: 'this run queues the identity so `execute` cannot break the pool it needs',
        },
    ];
    record({ phase: '0', op: 'timelock-queue', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function cmdExecute(c: Contracts, handle: string) {
    const tl = timelockOf(c);
    const q = await retry(() => tl.getQueued(), 'getQueued');
    const now = Math.floor(Date.now() / 1000);
    if (q.hasQueued !== 1) throw new Error('nothing queued — run `timelock.ts queue` first (802)');
    // GAUNTLET.md B30 / CLAUDE.md's send-before-read rule. This arm READ `q.fired` into
    // the VENUE_EXECUTED assert's `before` field and sent anyway, then asserted
    // `q2.fired === 1` — which is trivially true when it was already 1, so a pointless
    // re-fire reported GREEN. The contract now refuses it with 802, but "the contract
    // will refuse it" is not a plan: the send still costs gas and still paints a red
    // transaction in the explorer the auditor is reading. Decide here, on the row.
    if (q.fired === 1) {
        throw new Error(
            'already executed — `fired` is 1, so there is no unfired change to execute (802). ' +
                'To redeliver a bounced update_venue use `timelock.ts retry`; to propose a new ' +
                'venue use `timelock.ts queue`, which starts a fresh 30-day wait.'
        );
    }
    if (now < q.eta) {
        throw new Error(
            `not matured: eta ${q.eta} is ${q.eta - now}s away (${((q.eta - now) / 3600).toFixed(2)}h). ` +
                `Executing early throws 801 and paints a red transaction for no information.`
        );
    }
    // D-194: the second key. `execute` throws 804 on an unconfirmed record, so the
    // read decides and the missing governance steps are printed instead.
    if (q.confirmed !== 1) {
        const tl = addr('PRIMES_VENUE_TIMELOCK_ADDRESS').toString({ testOnly: true });
        throw new Error(
            `record seq ${q.seq} is not confirmed by an LP vote (execute would throw 804). Run:\n` +
                `  lpGovernance.ts propose <handle> 3 ${q.seq} ${tl}   # no earlier than eta − noticeDuration − voteDuration (808)\n` +
                '  lpGovernance.ts vote <handle> <proposal>\n' +
                '  lpGovernance.ts execute <handle> <proposal>   # after the vote window closes'
        );
    }
    const w = await walletFor(c.client, handle);
    const before = await retry(() => ratchetOf(c).getVenue(), 'getVenue');
    const stakingBefore = await retry(() => ratchetOf(c).getStakingVenue(), 'getStakingVenue');
    console.log(`executing from ${handle} — permissionless, the proposer cannot withhold it`);
    await tl.sendExecute(w.sender, { value: GAS });
    await new Promise((r) => setTimeout(r, 30_000));
    const q2 = await retry(() => tl.getQueued(), 'getQueued(after)');
    const after = await retry(() => ratchetOf(c).getVenue(), 'getVenue(after)');
    const stakingAfter = await retry(() => ratchetOf(c).getStakingVenue(), 'getStakingVenue(after)');
    const results: A.AssertResult[] = [
        {
            ok: q2.fired === 1,
            name: 'VENUE_EXECUTED',
            getMethod: 'venueTimelock.getQueued().fired',
            before: String(q.fired),
            after: String(q2.fired),
            detail: `executed by ${handle}, a wallet with no authority over this contract`,
        },
        {
            ok: after.dedustPool.equals(q.dedustPool) && after.dedustNativeVault.equals(q.dedustNativeVault),
            name: 'VENUE_APPLIED',
            getMethod: 'ratchet.getVenue()',
            before: before.dedustPool.toString({ testOnly: true }),
            after: after.dedustPool.toString({ testOnly: true }),
            detail: 'the ratchet now swaps against exactly what was queued 4.3 hours ago',
        },
        // D-194: `update_venue` carries no staking addresses, so any execute
        // leaves §4.3.2's staked reserve where deploy put it.
        {
            ok: stakingAfter.tonstakersPool.equals(stakingBefore.tonstakersPool),
            name: 'STAKING_VENUE_UNCHANGED',
            getMethod: 'ratchet.getStakingVenue()',
            before: stakingBefore.tonstakersPool.toString({ testOnly: true }),
            after: stakingAfter.tonstakersPool.toString({ testOnly: true }),
            detail: 'D-194: a venue change cannot move the staked reserve',
        },
    ];
    record({ phase: '7', op: 'timelock-execute', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** D10: redelivery only. Valid exactly while a record is queued AND fired. */
async function cmdRetry(c: Contracts, handle: string) {
    const tl = timelockOf(c);
    const q = await retry(() => tl.getQueued(), 'getQueued');
    if (q.hasQueued !== 1 || q.fired !== 1) {
        throw new Error(
            `retry_update_venue needs a queued AND fired record (has ${q.hasQueued}/${q.fired}); ` +
                'it throws 802 otherwise. Run "timelock.ts execute" first.'
        );
    }
    const w = await walletFor(c.client, handle);
    const before = await retry(() => ratchetOf(c).getVenue(), 'getVenue');
    await tl.sendRetryUpdateVenue(w.sender, { value: GAS });
    await new Promise((r) => setTimeout(r, 25_000));
    const after = await retry(() => ratchetOf(c).getVenue(), 'getVenue(after)');
    const results: A.AssertResult[] = [
        {
            ok: after.dedustPool.equals(before.dedustPool),
            name: 'RETRY_IS_IDEMPOTENT',
            getMethod: 'ratchet.getVenue()',
            before: before.dedustPool.toString({ testOnly: true }),
            after: after.dedustPool.toString({ testOnly: true }),
            detail: 'a redelivery re-sends the same decision; it never re-queues and never changes it',
        },
    ];
    record({ phase: '7', op: 'timelock-retry', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function cmdCancel(c: Contracts) {
    const tl = timelockOf(c);
    const q = await retry(() => tl.getQueued(), 'getQueued');
    if (q.hasQueued !== 1) throw new Error('nothing queued to cancel (802)');
    const w = await walletFor(c.client, 'K');
    await tl.sendCancel(w.sender, { value: GAS });
    await new Promise((r) => setTimeout(r, 20_000));
    const q2 = await retry(() => tl.getQueued(), 'getQueued(after)');
    const results: A.AssertResult[] = [
        {
            ok: q2.hasQueued === 0,
            name: 'VENUE_CANCELLED',
            getMethod: 'venueTimelock.getQueued().hasQueued',
            before: String(q.hasQueued),
            after: String(q2.hasQueued),
            detail: 'the proposer may withdraw a queued change; nobody else may (800)',
        },
    ];
    record({ phase: '7', op: 'timelock-cancel', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const c = contracts();
    if (!cmd || cmd === 'status') {
        await cmdStatus(c);
        return;
    }
    if (cmd === 'queue') return cmdQueue(c);
    if (cmd === 'execute') return cmdExecute(c, rest[0] ?? 'F');
    if (cmd === 'retry') return cmdRetry(c, rest[0] ?? 'F');
    if (cmd === 'cancel') return cmdCancel(c);
    console.log('usage: timelock.ts status | queue | execute [handle] | retry [handle] | cancel');
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
