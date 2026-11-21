// TON PRIMES — D3: integer overflow and underflow on every money path
// (GAUNTLET.md D3).
//
// THE TWO HALVES ARE NOT EQUALLY DANGEROUS, AND SAYING SO IS PART OF THE ANSWER
//
// **Overflow is a non-event here, and this file proves it rather than asserting
// it.** TVM integers are 257-bit signed (~5.8e76). Every money quantity in the
// protocol is bounded far below that — `coins` serializes as at most 120 bits
// (~1.3e36) — and the widest intermediate any money path computes is the
// rebate's `k · injection · S / T / K_SCALE`. The headroom is computed below
// from the sim's own final-state figures, so the claim is a number and not a
// reassurance.
//
// **Underflow is the real one**, and for a reason specific to TVM: integers are
// SIGNED, so `a - b` with `b > a` does not wrap. It produces a negative, which
// then either throws when serialized as `coins` or — worse — survives into a
// comparison and silently inverts a guard. So the question at each site is what
// bounds the subtrahend, and that is a property of the surrounding code rather
// than of the type.
//
// THREE MECHANISMS DO THE BOUNDING, and the distinction is the point:
//
//   local      an assert or ternary in the SAME function. Self-evident on
//              reading, and the only class an auditor can verify locally.
//   record     the amount comes from the record being deleted, and was added to
//              the aggregate when that record was created. Safe *iff* the
//              aggregate is maintained in step — which is what C8's escrow
//              reconciliation and FuzzInvariants' I10 exist to prove.
//   invariant  safe ONLY because a cross-contract invariant holds. The ledger's
//              `tributeOwed -= msg.amount` is the case: the amount arrives from
//              an authenticated item claiming its own `owed`, and NOTHING LOCAL
//              bounds it. `tributeOwed == Σ_p item.owed` is the guard and it
//              lives in another file.
//
// A site in the third class is not a bug. It is a site whose safety rests on a
// test rather than on a read, and an auditor is entitled to be told which ones
// those are instead of discovering it. That is why the table below records the
// mechanism and not merely "guarded: yes".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = join(__dirname, '..', '..');
const DOC = join(REPO, 'docs', 'audit', 'money-arithmetic.md');
const params = JSON.parse(readFileSync(join(REPO, 'shared', 'params.json'), 'utf8'));

type Row = { file: string; line: number; fn: string; expr: string };

function readTable(): Row[] {
    const md = readFileSync(DOC, 'utf8');
    const rows: Row[] = [];
    for (const line of md.split('\n')) {
        const m = line.match(/^\| `([^`]+)` \| (\d+) \| `([^`]+)` \| `(.*?)` \| /);
        if (m) rows.push({ file: m[1], line: Number(m[2]), fn: m[3], expr: m[4].replace(/\\\|/g, '|') });
    }
    return rows;
}

type Mechanism = 'local' | 'record' | 'invariant';

/**
 * Every money subtraction, and what bounds it. Keyed by `file:function:lhs` so
 * the entry survives the line moving — a table keyed by line number would need
 * re-blessing on every unrelated edit, and a table that gets re-blessed
 * routinely is a table nobody reads.
 */
const BOUNDED: Record<string, { how: Mechanism; why: string }> = {
    'primes_bounty_vault.tolk::entry.remaining': {
        how: 'local',
        why: 'assert (entry.remaining >= msg.amount) throw 701 immediately above',
    },
    'primes_jetton_wallet.tolk::storage.balance': {
        how: 'local',
        why: 'assert (storage.balance >= msg.amount) throw 103, on both Transfer and Burn',
    },
    'primes_ledger.tolk::meters.divOutstanding': {
        how: 'local',
        why: 'guarded by an early return: if (storage.divAcc <= entry) { return; }',
    },
    'primes_ratchet.tolk::storage.pending': {
        how: 'local',
        why: 'amount is clamped to pending before the subtraction (if amount > pending, amount = pending)',
    },
    // D-90 DELETES the market's `c.totalEscrow` / `c.totalPremium` sites and the
    // shard's two below: there is no escrow pool left to decrement.
    'primes_voucher.tolk::storage.paidTotal': { how: 'local', why: 'self-guarding ternary' },
    'primes_claim_receipt.tolk::storage.paid': { how: 'local', why: 'self-guarding ternary (D-191 point 2 restore)' },

    'primes_ledger.tolk::meters.unroutedHeld': {
        how: 'record',
        why: 'credit.amount comes from the unroutedCredits entry being deleted, which is what added it',
    },
    'primes_ratchet.tolk::storage.swapped': {
        how: 'record',
        why: 'inFlightFlush is exactly what the flush credited to swapped in the same step; the bounce reverses both',
    },
    'primes_bounty_vault.tolk::storage.paidTotal': {
        how: 'record',
        why:
            'D-53/B12.1, D-188, V26.1: original.amount is the amount of the vault\'s OWN bounced ' +
            'JettonTransfer (a rich bounce returns it whole), which every payout arm added to paidTotal ' +
            'in the same step that sent it; the bounce reverses exactly that',
    },

    'primes_ledger.tolk::meters.tributeOwed': {
        how: 'invariant',
        why:
            'msg.amount arrives from an authenticated item claiming its own owed. Nothing local bounds it; ' +
            'FuzzInvariants I10 (tributeOwed == Sum_p item.owed, exact, every step) is the guard. The bounce ' +
            'path reverses a credit this contract itself counted when it sent it.',
    },
    'primes_jetton_master.tolk::storage.totalSupply': {
        how: 'invariant',
        why:
            'amount arrives from an authenticated wallet burn, or from a bounced mint this contract sent. ' +
            'Bounded by Sum(wallet balances) == totalSupply, which JettonInterop covers.',
    },
    // D-168 — the stake master, its children, and the treasury's `distribute()`.
    'primes_stake.tolk::st.streamRemaining': {
        how: 'local',
        why: '`accrue` clamps `amt` to `streamRemaining` on the line above (`if (amt > st.streamRemaining) { amt = st.streamRemaining; }`)',
    },
    'primes_stake.tolk::st.unclaimedTotal': {
        how: 'invariant',
        why:
            'the excess leg is local (`full` is clamped to `unclaimedTotal` in `settlePosition`); the payout leg adds the child-reported `banked`, ' +
            'which is safe only because Σ(full + banked) over positions <= unclaimedTotal — ST-2, asserted by Staking.spec.ts and FuzzInvariants',
    },
    'primes_stake.tolk::st.lockedTotal': {
        how: 'record',
        why: 'the principal of the position being withdrawn, added to lockedTotal when that position was staked',
    },
    'primes_stake.tolk::t.claimedTotal': {
        how: 'record',
        why: 'a bounced payout reverses exactly the amount the settle that sent it added to claimedTotal',
    },
    'primes_stake_position.tolk::storage.stakedTotal': {
        how: 'record',
        why: 'pos.amount of the position being deleted, added to stakedTotal when it was credited or restored',
    },
    'primes_treasury.tolk::bal.primesBalance': {
        how: 'local',
        why:
            '`execute` asserts `prop.amount <= available` (= primesBalance) above; `distribute` sends `primesBalance * rate * interval / (10000 * 86400)`, ' +
            'a fraction of the same balance (19 bps/day over 30 days = 5.7%)',
    },
    'primes_treasury.tolk::bal.tstonBalance': {
        how: 'local',
        why: '`execute` asserts `prop.amount <= available` (= tstonBalance) above',
    },
    'primes_treasury.tolk::dist.distributedTotal': {
        how: 'record',
        why: 'a bounced budget reverses exactly the amount `distribute` added to distributedTotal',
    },
};

const keyOf = (r: Row) => {
    const lhs = r.expr.match(/^([A-Za-z_][A-Za-z0-9_.]*)/)?.[1] ?? '';
    return `${r.file}::${lhs}`;
};

describe('TON PRIMES — D3: money arithmetic cannot overflow, and cannot go negative', () => {
    const rows = readTable();

    it('the generated table is current — regenerating it changes nothing', () => {
        const before = readFileSync(DOC, 'utf8');
        execFileSync(process.execPath, [join(REPO, 'tools', 'money-arithmetic.mjs')], { cwd: REPO });
        expect(readFileSync(DOC, 'utf8')).toBe(before);
    }, 60_000);

    it('found a real set of sites, not an empty one', () => {
        // 19 before D-90 deleted the escrow pool's four subtraction sites.
        expect(rows.length).toBeGreaterThanOrEqual(14);
    });

    it('THE CLAIM: every money subtraction has a named bounding mechanism', () => {
        const unaccounted = rows
            .filter((r) => !(keyOf(r) in BOUNDED))
            .map((r) => `${r.file}:${r.line} ${r.expr}`);
        expect(unaccounted).toEqual([]);
    });

    it('and no entry is dead — each names a subtraction that still exists', () => {
        const live = new Set(rows.map(keyOf));
        expect(Object.keys(BOUNDED).filter((k) => !live.has(k))).toEqual([]);
    });

    it('the CROSS-CONTRACT class is small and named — those are the ones a read cannot verify', () => {
        // Stated as its own assertion because it is the finding, not a detail:
        // two of the fifteen bounded quantities are safe only because a test
        // elsewhere holds. If that set ever grows, it should grow deliberately.
        const byInvariant = Object.entries(BOUNDED)
            .filter(([, v]) => v.how === 'invariant')
            .map(([k]) => k)
            .sort();
        expect(byInvariant).toEqual([
            'primes_jetton_master.tolk::storage.totalSupply',
            'primes_ledger.tolk::meters.tributeOwed',
            // D-168: the stake master's payout trusts the child-reported `banked`.
            'primes_stake.tolk::st.unclaimedTotal',
        ]);
    });

    // ------------------------------------------------------------------ //
    // Overflow: a computed headroom, not a reassurance
    // ------------------------------------------------------------------ //

    describe('overflow headroom, computed from the sim\'s own figures', () => {
        /** TVM's signed 257-bit ceiling. */
        const INT257_MAX = 2n ** 256n - 1n;
        /** What `coins` can serialize: VarUInteger 16, so at most 120 bits. */
        const COINS_MAX = 2n ** 120n - 1n;
        const K_SCALE = 1_000_000_000n;
        const K_CEIL = 950_000_000n; // 0.95, the largest k can ever be
        const MINT_PRICE = 1_000_000_000n;

        /** S at the end of the simulated run, in nanoPRIMES. */
        const S_FINAL = BigInt(Math.ceil(params.final_state.final_S_primes * 1e9));

        it('S itself stays far inside what `coins` can hold', () => {
            expect(S_FINAL).toBeLessThan(COINS_MAX);
            // and by a wide margin — this is not a near miss
            expect(COINS_MAX / S_FINAL).toBeGreaterThan(10n ** 18n);
        });

        it('the rebate\'s widest intermediate has ~40 orders of headroom against int257', () => {
            // `rebate = k * poolInjectionFinal * S / T / K_SCALE`, multiplied
            // BEFORE dividing (deliberately — DecompositionSolvency proves the
            // naive order truncates to zero). So the intermediate to bound is the
            // triple product, at its maximum: k at K_CEIL, injection at the whole
            // mint price, S at the end of the run.
            const widest = K_CEIL * MINT_PRICE * S_FINAL;
            expect(widest).toBeLessThan(INT257_MAX);
            const headroom = INT257_MAX / widest;
            expect(headroom).toBeGreaterThan(10n ** 30n);
        });

        it('...and still would at a thousand times the simulated supply', () => {
            // The bound that matters is not "does it fit today" but "how far can
            // S grow first". S is cumulative and never decremented (§3.3, §5), so
            // this is the assertion with a future in it.
            const widest = K_CEIL * MINT_PRICE * (S_FINAL * 1000n);
            expect(widest).toBeLessThan(INT257_MAX);
        });

        it('the P0 ladder\'s shift-and-multiply stays inside int257 at the maximum score', () => {
            // `P0 = ((MINT_PRICE << (D/10)) * FRAC[D%10]) >> 16`, D capped at
            // SCORE_MAX = 120, FRAC at most 122295. The contract comments claim
            // "four orders inside int257"; this computes it.
            const widest = (MINT_PRICE << 12n) * 122295n;
            expect(widest).toBeLessThan(INT257_MAX);
            expect(INT257_MAX / widest).toBeGreaterThan(10n ** 50n);
        });

        it('the Dutch decay\'s (p0 - floor) * elapsed stays inside int257 for any plausible clock', () => {
            // `rec.p0 - (rec.p0 - floorPrice) * elapsed / span`. p0 is bounded by
            // the ladder above; `elapsed` is a unix timestamp difference. Even at
            // a century of elapsed seconds against the largest possible p0, this
            // is nowhere near the ceiling.
            const p0Max = ((MINT_PRICE << 12n) * 122295n) >> 16n;
            const century = 100n * 365n * 24n * 3600n;
            expect(p0Max * century).toBeLessThan(INT257_MAX);
        });
    });
});
