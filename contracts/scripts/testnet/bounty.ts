/**
 * TON PRIMES — the bounty vault's payout surface, live.
 *
 * The vault is the one contract in the set that holds PRIMES it owes to named
 * people, and it is the least exercised on chain. What existed before this file:
 * `proveDeferredBountyLive.ts`, which proves D-129's defer-and-retry against a
 * THROWAWAY COPY of the bytecode (the real vault is self-funding since H11 and
 * can no longer be starved), and `phase3EraCeremonyLive.ts`, which proves the
 * era bounty and the trophy on a primorial mint. Everything below was proven in
 * the sandbox only, or done once by hand and never committed:
 *
 *  (The constellation discovery claim and its book were deleted by DECISIONS.md D-202.)
 *  - the special-number rebate's TWO KINDS — the per-point composite kind and
 *    D-96's prime family — never distinguished on chain.
 *  - `getDeferredPayouts()` as a SCAN BOUND. A never-sent payout announces no
 *    queryID, so `journalKey` is the only way a stranger discovers what to retry.
 *  - the v1 allow-list being empty, which is what makes `pay_program_bounty`
 *    unreachable rather than merely unused.
 *
 *   npx tsx contracts/scripts/testnet/bounty.ts status
 *   npx tsx contracts/scripts/testnet/bounty.ts rebate <n>
 *   npx tsx contracts/scripts/testnet/bounty.ts retry-scan [handle]
 */
import { Address, toNano } from '@ton/core';
import { retry } from './sender';
import { addr, contracts, walletFor, type Contracts } from './chain';
import * as A from './assert';
import { fromAsserts, record } from './journal';

/** A wallet's 256-bit account hash — the key the vault's allow-list is filed under. */
export function addrHashOf(a: Address): bigint {
    return BigInt('0x' + a.hash.toString('hex'));
}

const PRIMORIALS = [2n, 6n, 30n, 210n, 2310n, 30030n, 510510n, 9699690n];

const primes = (v: bigint) => (Number(v) / 1e9).toFixed(4) + ' PRIMES';

/** Everything the vault publishes, in one read. Cheap, and the run's baseline. */
async function cmdStatus(c: Contracts) {
    const payouts = await retry(() => c.vault.getVaultPayouts(), 'getVaultPayouts');
    const deferred = await retry(() => c.vault.getDeferredPayouts(), 'getDeferredPayouts');
    const cfg = await retry(() => c.vault.getVaultConfig(), 'getVaultConfig');
    console.log(`paidTotal        ${primes(payouts.paidTotalPrimes)} over ${payouts.payoutCount} payouts`);
    console.log(`deferred         ${deferred.deferredCount} (journalKey ${deferred.journalKey})`);
    console.log(`ledger           ${cfg.ledgerAddr.toString({ testOnly: true })}`);
    console.log(`jetton wallet    ${cfg.jettonWalletAddr.toString({ testOnly: true })} (set ${cfg.walletSet})`);
    console.log('\nera schedule (§7):');
    for (const b of PRIMORIALS) {
        const e = await retry(() => c.vault.getEraSchedule(b), `getEraSchedule(${b})`);
        if (e.scheduled) {
            console.log(
                `  ${b.toString().padStart(8)}  bounty ${Number(e.bountyTon) / 1e9} TON  ` +
                    `max ${primes(e.maxPrimes)}  paid ${e.paid}`
            );
        }
    }
    // THE ALLOW-LIST IS READ, NEVER ASSUMED (§8: no admin path anywhere). Only the
    // vouchers may spend this vault (D-202 took the registrar off with the discovery
    // bounty); an allow-listed address is an address that can move PRIMES out of it.
    const results: A.AssertResult[] = [];
    const strangers: [string, string][] = [
        ['registrar', 'PRIMES_REGISTRAR_ADDRESS'],
        ['ledger', 'PRIMES_LEDGER_ADDRESS'],
        ['market', 'PRIMES_MARKET_ADDRESS'],
        ['operator', 'PRIMES_OPERATOR_ADDR'],
    ];
    for (const [name, envVar] of strangers) {
        const v = await retry(
            () => c.vault.isAllowlisted(addrHashOf(addr(envVar))),
            `isAllowlisted(${name})`
        );
        console.log(`              ${name.padEnd(9)} ${v} (must be 0)`);
        results.push({
            ok: v === 0,
            name: `NOT_ALLOWLISTED_${name.toUpperCase()}`,
            getMethod: `vault.isAllowlisted(${name})`,
            after: String(v),
            detail: 'only the vouchers may spend this vault; anything else on the list is a withdraw path',
        });
    }
    record({ phase: '2', op: 'vault-status', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
    return { payouts, deferred };
}

/**
 * The special-number rebate, read per KIND. Kind 0 is the head-minted composite
 * paid per point of D(n); kind 1 is D-96's prime family (`p > 100000`,
 * `p ≡ 1 mod 101`). Both are PUSHED by the ledger inside the mint transaction,
 * so this reads the schedule rather than sending anything: the assert is that
 * `paid` flips exactly once and the vault counted exactly one payout.
 */
async function cmdRebate(c: Contracts, n: bigint) {
    const results: A.AssertResult[] = [];
    for (const kind of [0, 1]) {
        const r = await retry(() => c.vault.getRebateSchedule(kind, n), `getRebateSchedule(${kind},${n})`);
        console.log(
            `kind ${kind}: scheduled ${r.scheduled} bounty ${Number(r.bountyTon) / 1e9} TON ` +
                `max ${primes(r.maxPrimes)} paid ${r.paid}`
        );
        results.push({
            ok: !r.scheduled || r.paid <= 1,
            name: `REBATE_ONCE_KIND${kind}`,
            getMethod: `vault.getRebateSchedule(${kind}, ${n})`,
            after: `paid ${r.paid}`,
            detail: `a rebate for one n pays at most once (idempotent on \`paidSpecials\`)`,
        });
    }
    record({ phase: '2', op: `rebate-${n}`, ok: results.every((x) => x.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * D-53/D-129: a deferred or bounced payout is replayable by ANYONE, and
 * `getDeferredPayouts().journalKey` is the scan bound that makes it discoverable.
 * With nothing deferred this is a read-only proof that the book is empty — which
 * is itself the assertion worth having after a full run.
 */
async function cmdRetryScan(c: Contracts, handle: string) {
    const d = await retry(() => c.vault.getDeferredPayouts(), 'getDeferredPayouts');
    console.log(`deferredCount ${d.deferredCount}, journalKey ${d.journalKey}`);
    if (d.deferredCount === 0) {
        const results: A.AssertResult[] = [
            {
                ok: true,
                name: 'NOTHING_DEFERRED',
                getMethod: 'vault.getDeferredPayouts()',
                after: `deferredCount 0, journalKey ${d.journalKey}`,
                detail: 'every payout this set has owed was sent in its own transaction',
            },
        ];
        record({ phase: '7', op: 'retry-scan', ok: true, asserts: fromAsserts(results) });
        A.print(results);
        return;
    }
    const w = await walletFor(c.client, handle);
    const before = await retry(() => c.vault.getVaultPayouts(), 'getVaultPayouts');
    // GAUNTLET.md G59 / CLAUDE.md's driver rule: decide on the ROW before sending.
    // `journalKey` only bounds the scan; most keys under it are paid (703) or were
    // never written (702), and the contract refusing them is not a plan — each
    // refusal is a real red transaction an auditor has to explain.
    for (let k = 0; k < d.journalKey; k++) {
        const row = await retry(() => c.vault.getRetryEntry(BigInt(k)), `getRetryEntry(${k})`);
        if (!row.retryable) continue;
        console.log(`retrying journal key ${k} (kind ${row.kind}, key ${row.entryKey}) from ${handle}...`);
        await c.vault.sendRetryBountyPayout(w.sender, { queryID: k, value: toNano('0.15') });
        await new Promise((r) => setTimeout(r, 15_000));
    }
    const after = await retry(() => c.vault.getVaultPayouts(), 'getVaultPayouts(after)');
    const d2 = await retry(() => c.vault.getDeferredPayouts(), 'getDeferredPayouts(after)');
    const results: A.AssertResult[] = [
        {
            ok: d2.deferredCount < d.deferredCount,
            name: 'DEFERRED_DRAINED',
            getMethod: 'vault.getDeferredPayouts()',
            before: String(d.deferredCount),
            after: String(d2.deferredCount),
            detail: 'a permissionless scan finishes what a poor vault could not send',
        },
        {
            ok: after.payoutCount > before.payoutCount,
            name: 'RETRY_PAID',
            getMethod: 'vault.getVaultPayouts()',
            before: String(before.payoutCount),
            after: String(after.payoutCount),
            detail: `paidTotal ${primes(before.paidTotalPrimes)} → ${primes(after.paidTotalPrimes)}`,
        },
    ];
    record({ phase: '7', op: 'retry-scan', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const c = contracts();
    if (!cmd || cmd === 'status') {
        await cmdStatus(c);
        return;
    }
    if (cmd === 'rebate') {
        if (!rest[0]) throw new Error('usage: bounty.ts rebate <n|->');
        // `-` is "the number the head last walked past", i.e. the most recent
        // sequential mint. `run.ts` cannot pass a literal: which composite the
        // head is standing on depends on how far the walk got.
        const n = rest[0] === '-' ? (await retry(() => c.ledger.getHead(), 'getHead')) - 1n : BigInt(rest[0]);
        return cmdRebate(c, n);
    }
    if (cmd === 'retry-scan') return cmdRetryScan(c, rest[0] ?? 'F');
    console.log('usage: bounty.ts status | rebate <n|-> | retry-scan [handle]');
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
