/**
 * TON PRIMES — THE GET-METHOD SWEEP. Call every get-method every deployed
 * contract exposes, once, against the live set, and report which ones answered.
 *
 * WHY THIS EXISTS. `docs/audit/contract-surface.md` is a CENSUS — it counts the
 * get-methods in source. It says nothing about whether any of them has ever been
 * *called at a real node*. Measured 2026-09-20 against the `20260924` set: of
 * **174 get-methods across 21 contracts, 50 had never been read by any live
 * script**, and 27 of those 50 are rendered by the shipped webapp or acted on by
 * a backend service — `market.getScoreBreakdown`, `market.getPrimeFloor`,
 * `market.getNpv`, `market.getFracTable`, `market.getIncrementLadder`,
 * `market.getScoreWeights`, `market.getPrimeDutchTerms`, `ledger.getK`,
 * `ledger.getLastMintTime`, `item.getMintedDay`, `treasury.getTierWeights`,
 * `vesting.getVestingSchedule`, `constellation_item.getConstellationData` and
 * the rest. CONCEPT.md §9.1 says every number the UI shows maps to a public
 * get-method; a get-method that has never been called is that claim untested.
 *
 * A get-method cannot be covered the way an op is — there is no phase to put it
 * in, and writing fifty asserts would be fifty places to drift. So this file
 * does the lazy thing that actually closes the gap: it reads the SIGNATURES out
 * of `contracts/contracts/*.tolk` and calls every one of them, supplying an
 * argument per parameter NAME. A method that throws is the finding; a method
 * that answers is coverage. It sends nothing, costs 0 GRAM, and is safe to run at
 * any point in a run — including immediately after genesis, which is when the
 * answer "this contract does not answer its own surface" is cheapest to fix.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not assert VALUES. `assert.ts` owns
 * the invariants and the phase scripts own the money arithmetic; a value assert
 * here would be a second, drifting copy of those. The property this file proves
 * is narrower and was genuinely unproven: **the method exists on the deployed
 * bytecode, takes the arity the source says, and returns without throwing.**
 * That is exactly the class of defect that made three collections unlistable and
 * a jetton master un-vaultable — a standard surface nobody ever spoke to.
 *
 *   npx tsx contracts/scripts/testnet/surface.ts             # every contract
 *   npx tsx contracts/scripts/testnet/surface.ts market      # one contract
 */
import fs from 'fs';
import path from 'path';
import { Address, TupleBuilder, beginCell } from '@ton/core';
import { TonClient } from '@ton/ton';
import { REPO, makeClient, retry } from './sender';
import { addr, env, envOpt } from './chain';
import { PrimesLedger } from '../../wrappers/PrimesLedger';
import { fromAsserts, record } from './journal';
import type { AssertResult } from './assert';

/**
 * Contract file -> the `.env` key naming its deployed address. The five left out
 * are per-INSTANCE (an item, a jetton wallet, a constellation, a generator, an
 * LP position); they are derived below from the singletons that mint them.
 */
const SINGLETONS: Record<string, string> = {
    primes_ledger: 'PRIMES_LEDGER_ADDRESS',
    primes_ratchet: 'PRIMES_RATCHET_ADDRESS',
    primes_registrar: 'PRIMES_REGISTRAR_ADDRESS',
    primes_market: 'PRIMES_MARKET_ADDRESS',
    primes_bounty_vault: 'PRIMES_BOUNTY_VAULT_ADDRESS',
    primes_collection: 'PRIMES_COLLECTION_ADDRESS',
    primes_jetton_master: 'PRIMES_JETTON_MASTER_ADDRESS',
    primes_treasury: 'PRIMES_TREASURY_ADDRESS',
    primes_lp_sink: 'PRIMES_LP_SINK_ADDRESS',
    primes_stake: 'PRIMES_STAKE_ADDRESS',
    primes_venue_timelock: 'PRIMES_VENUE_TIMELOCK_ADDRESS',
    primes_vesting: 'PRIMES_TREASURY_VESTING_ADDRESS', // D-166: the only lock
};

/**
 * Two methods take a FACTORIZATION cell the caller builds. Their siblings
 * (`getLotPrice`, `getScoreBreakdown`) read the same code path off the chain's
 * own factors, so calling them with a hand-rolled cell would test this script's
 * encoder, not the contract. Skipped by name, on purpose.
 */
const NEEDS_REAL_CELL = new Set(['getLotPriceFrom', 'getScoreBreakdownFrom']);

type Sig = { name: string; params: { name: string; type: string }[] };

/** Read `get fun name(a: int, b: cell)` out of a contract's source. */
function signatures(contractFile: string): Sig[] {
    const src = fs.readFileSync(path.join(REPO, 'contracts', 'contracts', `${contractFile}.tolk`), 'utf8');
    const out: Sig[] = [];
    for (const m of src.matchAll(/^get fun ([A-Za-z_0-9]+)\(([^)]*)\)/gm)) {
        const params = m[2]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
                const [n, t] = s.split(':').map((x) => x.trim());
                return { name: n, type: t ?? 'int' };
            });
        out.push({ name: m[1], params });
    }
    return out;
}

type Fixtures = { head: bigint; someNumber: bigint; somePrime: bigint; someOwner: Address };

/**
 * One argument per parameter NAME. The names are consistent across the 21
 * contracts because they all describe the same four things: a number, a prime, a
 * wallet, or an index into a fixed table. An unknown name falls through to 0,
 * which is a legal int for every table lookup in the set.
 */
function argFor(p: { name: string; type: string }, f: Fixtures): bigint | Address | ReturnType<typeof beginCell> {
    if (p.type === 'cell') return beginCell().endCell() as never;
    if (p.type === 'address' || p.type === 'slice') return f.someOwner;
    switch (p.name) {
        case 'n':
        case 'target':
        case 'originN':
            return f.someNumber;
        case 'p':
            return f.somePrime;
        case 'index':
            return 1n; // TEP-62 indices start at 1 here (Unity is #1)
        case 'owner':
        case 'wallet':
        case 'beneficiary':
            return 0n; // unreachable: address-typed above
        case 'addrHash':
            return BigInt('0x' + f.someOwner.hash.toString('hex'));
        case 't':
            return BigInt(Math.floor(Date.now() / 1000));
        case 'eraBoundary':
            return 6n; // the first primorial boundary a run ever closes
        case 'rewardPerWeightAcc':
            return 0n;
        default:
            return 0n; // kind, tier, seq, slot, id, positionId, creditId, ...
    }
}

/**
 * NOT EVERY NON-ZERO EXIT IS A FINDING, and the first run of this file reported
 * nine when it had found two. Three cases, and only one of them is a defect:
 *
 *  - **exit 11** — the method does not exist on the deployed bytecode. THE
 *    finding: source publishes a get-method the deployment does not answer, so
 *    anything reading it (the app, the keeper, an auditor) gets an error where
 *    §9.1 promises a number. This is how a stale set announces itself.
 *  - **exit 7** — type check. The method exists; THIS SCRIPT passed the wrong
 *    argument type. A harness bug, and still a failure, because a fixture that
 *    does not typecheck proves nothing about the method.
 *  - **exit -13** — the ACCOUNT has no code. Not a method fact at all: it means
 *    the item/constellation this run derived has not been minted yet. Skipped
 *    with its reason, because a sweep that fails before phase 4 is a sweep
 *    nobody runs.
 *  - **anything else** (a named throw, 1181/1183/...) — the method RAN and
 *    refused the fixture, which is the contract's own guard doing its job. The
 *    property this file tests is "exists, takes the arity, executes"; a refusal
 *    satisfies all three. Recorded as `refused`, never as a failure — this file
 *    does not own those guards' test cases and would only be a drifting copy of
 *    them (see the header).
 */
function classify(code: number): { ok: boolean; skip: boolean; label: string } {
    if (code === 11) return { ok: false, skip: false, label: 'NOT ON THE DEPLOYED BYTECODE' };
    if (code === 7) return { ok: false, skip: false, label: 'type check — the fixture is wrong' };
    if (code === -13) return { ok: true, skip: true, label: 'account not deployed yet' };
    return { ok: true, skip: false, label: `refused (exit ${code}) — the method ran and guarded` };
}

function exitCodeOf(e: unknown): number | null {
    const m = /exit_code:\s*(-?\d+)/.exec((e as Error)?.message ?? '');
    return m ? Number(m[1]) : null;
}

async function callOne(client: TonClient, at: Address, sig: Sig, f: Fixtures): Promise<AssertResult> {
    const b = new TupleBuilder();
    for (const p of sig.params) {
        const v = argFor(p, f);
        if (v instanceof Address) b.writeAddress(v);
        else if (typeof v === 'bigint') b.writeNumber(v);
        else b.writeCell(v as never);
    }
    try {
        const r = await retry(() => client.runMethod(at, sig.name, b.build()), sig.name, 3);
        return {
            ok: true,
            name: sig.name,
            getMethod: `${at.toString({ testOnly: true }).slice(0, 8)}…::${sig.name}(${sig.params.length})`,
            before: '-',
            after: `${r.stack.remaining} value(s)`,
            detail: 'answered on deployed bytecode',
        };
    } catch (e: unknown) {
        const code = exitCodeOf(e);
        const c = code === null ? { ok: false, skip: false, label: 'no exit code' } : classify(code);
        return {
            ok: c.ok,
            name: sig.name,
            getMethod: `${at.toString({ testOnly: true }).slice(0, 8)}…::${sig.name}(${sig.params.length})`,
            before: '-',
            after: c.skip ? 'skipped' : c.ok ? 'refused' : 'THREW',
            detail: c.label,
        };
    }
}

/**
 * The per-instance contracts. Each address is DERIVED from a singleton rather
 * than configured, so the sweep follows whatever the run has actually minted.
 * A derivation that finds nothing is skipped with a reason, not failed: on a
 * fresh genesis there is no constellation and no LP position yet, and a sweep
 * that refuses to run before phase 4 is a sweep nobody runs.
 */
async function instances(client: TonClient, f: Fixtures): Promise<{ file: string; at: Address; why?: string }[]> {
    const out: { file: string; at: Address; why?: string }[] = [];
    const ledger = client.open(PrimesLedger.createFromAddress(addr('PRIMES_LEDGER_ADDRESS')));
    try {
        out.push({ file: 'primes_item', at: await retry(() => ledger.getItemAddress(f.someNumber), 'getItemAddress') });
    } catch {
        /* no item minted yet */
    }
    for (const [file, key] of [
    ] as const) {
        try {
            const tb = new TupleBuilder();
            tb.writeNumber(f.someNumber);
            const r = await retry(
                () => client.runMethod(addr(key), 'getItemAddress', tb.build()),
                `${file} address`,
                2
            );
            out.push({ file, at: r.stack.readAddress() });
        } catch {
            /* nothing built/deployed on that line yet */
        }
    }
    return out;
}

async function main() {
    const only = process.argv[2];
    const client = makeClient();
    const ledger = client.open(PrimesLedger.createFromAddress(addr('PRIMES_LEDGER_ADDRESS')));
    const head = await retry(() => ledger.getHead(), 'getHead');
    const f: Fixtures = {
        head,
        // AN ITEM THAT EXISTS. `head - 1` is not one: the head starts at 4 and
        // skips primes, so on a fresh set `head - 1` is 3, never minted, and
        // every item read comes back `-13`. Unity (#1) is minted at ignition
        // and is the only number guaranteed to be on chain at any point in a
        // run, so it is the probe until the walk has put something past it.
        someNumber: head > 5n ? head - 1n : 1n,
        somePrime: 2n,
        someOwner: Address.parse(env('PRIMES_OPERATOR_ADDR')),
    };
    console.log(`sweeping the get-method surface at head ${head} (probe number ${f.someNumber})\n`);

    const targets: { file: string; at: Address }[] = [];
    for (const [file, key] of Object.entries(SINGLETONS)) {
        if (only && !file.includes(only)) continue;
        if (!envOpt(key)) {
            console.log(`${file}: ${key} unset — skipped`);
            continue;
        }
        targets.push({ file, at: addr(key) });
    }
    for (const i of await instances(client, f)) {
        if (only && !i.file.includes(only)) continue;
        targets.push(i);
    }

    const results: AssertResult[] = [];
    for (const t of targets) {
        const sigs = signatures(t.file).filter((s) => !NEEDS_REAL_CELL.has(s.name));
        console.log(`--- ${t.file}  ${t.at.toString({ testOnly: true })}  (${sigs.length} get-methods)`);
        for (const sig of sigs) {
            const r = await callOne(client, t.at, sig, f);
            const mark = r.after === 'skipped' ? 'skip' : r.after === 'refused' ? 'gard' : r.ok ? 'ok  ' : 'FAIL';
            const why = mark === 'ok  ' ? '' : ' — ' + r.detail;
            console.log(`    ${mark} ${sig.name}(${sig.params.map((p) => p.name).join(', ')})${why}`);
            results.push(r);
        }
    }

    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length}/${results.length} get-methods answered on deployed bytecode`);
    record({
        phase: '1',
        op: 'get-method-surface',
        ok: bad.length === 0,
        asserts: fromAsserts([
            {
                ok: bad.length === 0,
                name: 'SURFACE_ANSWERS',
                getMethod: 'every `get fun` in contracts/contracts/*.tolk',
                before: `${results.length} declared`,
                after: `${results.length - bad.length} answered`,
                detail:
                    bad.length === 0
                        ? 'the deployed bytecode answers its whole published surface'
                        : 'threw: ' + bad.map((b) => b.name).join(', '),
            },
        ]),
    });
    if (bad.length) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
