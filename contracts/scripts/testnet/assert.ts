/**
 * TON PRIMES — the invariant predicates (`TESTNET_MASTER_PLAN.md` §2 `assert.ts`).
 *
 * Until this file, NOT ONE of the seven was checked on a live chain. The
 * fragments that existed printed a boolean and exited 0 (`lot.ts` printed the
 * ratchet theorem as `false` on a run that passed), or were inlined against one
 * mint inside one script (`proveCompositeSplitLive.ts`), or did not exist at all
 * (`S_MONOTONE`, `T_IDENTITY`, `SOLVENCY`, `INDEX_ECHO` — the four that carry
 * CONCEPT §5's central claim).
 *
 * Each predicate returns `{ok, name, getMethod, before, after, detail}` rather
 * than throwing, so a phase can journal a failure with both readings and the
 * get-method a reader re-checks it with. `requireAll()` is what turns them into
 * a stop.
 *
 * Run standalone for a one-shot reading of the set:
 *   npx tsx contracts/scripts/testnet/assert.ts            # chain only
 *   npx tsx contracts/scripts/testnet/assert.ts --index    # + INDEX_ECHO
 */
import { Address } from '@ton/core';
import { makeClient, retry } from './sender';
import { api, contracts, snapshot, EVENTS_BASE, type Snapshot } from './chain';

export type AssertResult = {
    ok: boolean;
    name: string;
    getMethod: string;
    before?: string;
    after?: string;
    detail: string;
};

const ton = (v: bigint) => (Number(v) / 1e9).toFixed(9) + ' TON';

/** §5: `S` is cumulative emission plus the genesis bounty vault, NEVER decremented. */
export function sMonotone(before: Snapshot, after: Snapshot): AssertResult {
    const ok = after.S >= before.S;
    return {
        ok,
        name: 'S_MONOTONE',
        getMethod: 'ledger.getFloorDen',
        before: before.S.toString(),
        after: after.S.toString(),
        detail: ok ? `S +${after.S - before.S}` : `S DECREASED by ${before.S - after.S}`,
    };
}

/**
 * §4.3/§5 and D-26: `T = seeded + swapped + pending`. The `seeded` term is the
 * founder capital genesis credits straight into `T`; a two-term reading of this
 * identity reports a permanent false solvency gap.
 *
 * **D-151 MADE IT SIX TERMS, and this predicate did not follow until 2026-09-21.**
 * §4.3.2's staked reserve moves TON out of `pending` into `stakedCost`, and an
 * exit moves it through `exiting` on the way back, so a three-term reading of a
 * set that has ever staked is short by exactly the staked position — which would
 * have stopped the run on the first `stake` with a false §5 failure, on the same
 * shape of defect `MISTAKES.md` 2026-09-20 records (a harness measuring a term
 * instead of the conserved quantity).
 *
 * `realizedLoss` is the sixth term and the one that is not a pot of TON. When a
 * leg of the exit machine redeems BELOW cost — a slashing at the counterparty,
 * §5's one external risk — the shortfall leaves `T` overstated by exactly that
 * much and the contract records it rather than netting it away
 * (`primes_ratchet.tolk`'s `creditExitArrival`). Adding it back is what keeps
 * this an identity; leaving it out would read a published loss as a broken
 * invariant.
 */
export function tIdentity(s: Snapshot): AssertResult {
    const k = s.staking;
    const staked = k ? k.stakedCost + k.exiting + k.realizedLoss : 0n;
    const sum = s.seedT + s.swapped + s.pending + staked;
    const ok = sum === s.T;
    const terms = k
        ? `${ton(s.seedT)} + ${ton(s.swapped)} + ${ton(s.pending)} + ${ton(k.stakedCost)} + ` +
          `${ton(k.exiting)} + ${ton(k.realizedLoss)} == T`
        : `${ton(s.seedT)} + ${ton(s.swapped)} + ${ton(s.pending)} == T`;
    return {
        ok,
        name: 'T_IDENTITY',
        getMethod: k
            ? 'ledger.getSeedT + ratchet.getSwapped + ratchet.getPending + ' +
              'getStaking.{stakedCost,exiting,realizedLoss} == ledger.getFloorNum'
            : 'ledger.getSeedT + ratchet.getSwapped + ratchet.getPending == ledger.getFloorNum',
        after: s.T.toString(),
        detail: ok
            ? terms
            : `sum ${sum} != T ${s.T} (off by ${sum - s.T}); inFlightFlush ${s.inFlightFlush}`,
    };
}

/**
 * §4.3.2 (D-151): a `stake`, an exit leg and a `harvest` are all REARRANGEMENTS.
 * None of them is allowed to move `T` at all — staking moves TON between two
 * terms of it, and `harvest()` touches no term of it ("realize, never mark").
 *
 * Asserted as its own predicate rather than left to `T_IDENTITY` because the two
 * catch different failures: the identity would still hold if a bug moved a whole
 * tranche into `swapped`, and this one would not. The obligation
 * `pending + stakedCost + exiting + realizedLoss` is the ratchet's own conserved
 * quantity, which is what the contract's `reserveTargetOf` measures the reserve
 * against.
 */
export function stakeNeutral(before: Snapshot, after: Snapshot): AssertResult {
    const obl = (s: Snapshot) =>
        s.pending + (s.staking ? s.staking.stakedCost + s.staking.exiting + s.staking.realizedLoss : 0n);
    const ok = after.T === before.T && obl(after) === obl(before);
    return {
        ok,
        name: 'STAKE_NEUTRAL',
        getMethod: 'ledger.getFloorNum + ratchet.getPending + getStaking.{stakedCost,exiting,realizedLoss}',
        before: `T ${before.T} obligation ${obl(before)}`,
        after: `T ${after.T} obligation ${obl(after)}`,
        detail: ok
            ? `T and the obligation both unmoved — the tranche only changed which term holds it`
            : `ΔT ${after.T - before.T}, Δobligation ${obl(after) - obl(before)} — a staking step ` +
              `moved value into or out of the ratchet, which no arm of §4.3.2 may do`,
    };
}

/**
 * THE RATCHET THEOREM (§5), as a cross-multiplication so no float rounds it:
 * `p_f = T/S` is strictly increasing, i.e. `T1·S0 > T0·S1`. A step that moves
 * neither (a constellation build, D-102) is asserted with `strict: false`.
 */
export function floorUp(before: Snapshot, after: Snapshot, strict = true): AssertResult {
    const lhs = after.T * before.S;
    const rhs = before.T * after.S;
    const ok = strict ? lhs > rhs : lhs >= rhs;
    return {
        ok,
        name: strict ? 'FLOOR_UP' : 'FLOOR_NOT_DOWN',
        getMethod: 'ledger.getFloorNum / ledger.getFloorDen',
        before: `T ${before.T} S ${before.S}`,
        after: `T ${after.T} S ${after.S}`,
        detail:
            `p_f ${(Number(before.T) / Number(before.S)).toExponential(6)} → ` +
            `${(Number(after.T) / Number(after.S)).toExponential(6)}` +
            (ok ? '' : `  (T1·S0 ${lhs} vs T0·S1 ${rhs})`),
    };
}

/** §3.4: every pool that declares a liability holds at least it, in one get-call. */
export function solvency(s: Snapshot): AssertResult {
    const rows: [string, Snapshot['ledgerSolvency']][] = [
        ['ledger', s.ledgerSolvency],
        ['ratchet', s.ratchetSolvency],
        ['registrar', s.registrarSolvency],
    ];
    const bad = rows.filter(([, r]) => r.delta < 0n);
    return {
        ok: bad.length === 0,
        name: 'SOLVENCY',
        getMethod: 'ledger/ratchet/registrar getSolvency',
        after: rows.map(([n, r]) => `${n} Δ${ton(r.delta)}`).join(' · '),
        detail:
            bad.length === 0
                ? `liability breakdown: tribute ${ton(s.liability.tributeOwed)}, unrouted ` +
                  `${ton(s.liability.unroutedHeld)}, dividends ${ton(s.liability.divOutstanding)}`
                : bad.map(([n, r]) => `${n} INSOLVENT by ${ton(-r.delta)}`).join('; '),
    };
}

/**
 * The indexer echoes the chain. Three separate failures have hidden behind a
 * green chain read: a poller dead on a migration, an index left pointing at a
 * superseded ledger, and a wipe run BEFORE the deploy (MISTAKES.md 2026-09-18).
 */
async function indexEcho(chainHead: number): Promise<AssertResult> {
    let health: any;
    let bootstrap: any;
    try {
        health = await api<any>('/health', EVENTS_BASE);
        bootstrap = await api<any>('/bootstrap');
    } catch (e: any) {
        return {
            ok: false,
            name: 'INDEX_ECHO',
            getMethod: `${EVENTS_BASE}/health + /bootstrap`,
            detail: `indexer unreachable: ${e?.message ?? e}`,
        };
    }
    const indexHead = Number(bootstrap?.head ?? bootstrap?.ledger?.head ?? NaN);
    const degraded = health?.degraded === true;
    const stale = health?.staleIndexLedgers ?? health?.stale_index_ledgers ?? [];
    const staleCount = Array.isArray(stale) ? stale.length : 0;
    const ok = !degraded && staleCount === 0 && (Number.isNaN(indexHead) || indexHead === chainHead);
    return {
        ok,
        name: 'INDEX_ECHO',
        getMethod: `${EVENTS_BASE}/health + /bootstrap`,
        before: `chain head ${chainHead}`,
        after: `index head ${Number.isNaN(indexHead) ? '(absent)' : indexHead}`,
        detail: `degraded ${degraded === true}, staleIndexLedgers ${staleCount}`,
    };
}

/** An address's TON balance, for the balance-delta asserts a split needs. */
export async function balance(a: Address): Promise<bigint> {
    return retry(() => makeClient().getBalance(a), 'getBalance');
}

export function print(rs: AssertResult[]): void {
    for (const r of rs) {
        console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(16)} ${r.detail}`);
        if (!r.ok) console.log(`       re-check with ${r.getMethod}`);
    }
}

/** A failed assert STOPS the run — it does not "continue and note". */
export function requireAll(rs: AssertResult[]): void {
    print(rs);
    const bad = rs.filter((r) => !r.ok);
    if (bad.length) {
        throw new Error(
            `${bad.length} invariant(s) broken: ` + bad.map((b) => `${b.name} (${b.getMethod})`).join(', ')
        );
    }
}

async function main() {
    const c = contracts();
    const s = await snapshot(c);
    console.log(`head ${s.head} · T ${s.T} · S ${s.S} · pending ${s.pending} · swapped ${s.swapped}`);
    const rs = [tIdentity(s), solvency(s)];
    if (process.argv.includes('--index')) rs.push(await indexEcho(s.head));
    print(rs);
    if (rs.some((r) => !r.ok)) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
