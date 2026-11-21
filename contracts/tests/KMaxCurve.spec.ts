// TON PRIMES — k_max(n) curve regression (CONCEPT.md §5, math-note.md §3).
//
// WHY THIS FILE EXISTS, SEPARATELY FROM SimCrossCheck.spec.ts
//
// The §5.4 rotation cross-check in SimCrossCheck.spec.ts samples k_max at exactly
// four points: n = 10^3, 10^4, 10^5, 10^6. Every one of those has leading digit 1,
// and at an exact power of ten the mantissa is 1.000, so `within` is 0 and the
// interpolation term drops out entirely — the only table entry that is read is
// table[0]. That test therefore pins the *anchor* of the curve and nothing about
// its interior.
//
// That is precisely the blind spot the two log10Fp defects lived in:
//
//   1. an off-by-one that read table[lowIdx] as the LOW end of the interpolation
//      where the table is indexed by mantissa-1, adding log10(m+1) for log10(m);
//   2. table.get(10) — out of bounds, a TVM range exception — for ANY n with
//      leading digit 9, including prime 9973, CONCEPT.md's own worked example.
//
// Defect 2 cannot be caught at a power of ten at all, and defect 1 is only
// visible there because it shifts the anchor. Both sit in the *emission* path
// (kOfT -> kMaxOf), not in a display-only get-method, so an unpinned regression
// here silently changes what every mint pays out.
//
// This file pins the whole curve: every leading digit 1..9, the digit-9 band that
// used to throw, the published decade values, monotonicity, both clamps, and the
// accuracy of the fixed-point approximation against real log10.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger } from '../wrappers/PrimesLedger';

const K_SCALE = 1e9;
const K_MIN = 0.2;
const K_MAX_CAP = 0.9;
const N0_ANCHOR = 1000;
/** §5.1's two levers — primes_ledger.tolk, params.json rebate.{PRIME_UPLIFT,PRIME_WINDOW}. */
const PRIME_UPLIFT = 0.05;
const PRIME_WINDOW = 6;
/** The quantity §5.1's invariant compares against k_max(n): 0.30. */
const UPLIFT_X_WINDOW = PRIME_UPLIFT * PRIME_WINDOW;

/**
 * §5's `2.7`, DERIVED rather than transcribed (GAUNTLET.md B32). It is
 * `k_max_cap * log10(n0_anchor)` = 0.9 * 3 — the numerator that makes the decay branch
 * pass through exactly `K_MAX_CAP` at the anchor, which is where the flat branch hands
 * over to it.
 *
 * B32 was filed against the contract's copy of this literal. The reference model in this
 * file had the SAME transcription, which is worse: a hardcoded 2.7 on the checking side
 * would have gone on agreeing with a desynced contract for the one change that matters
 * (both consts updated, the numerator forgotten). `SimCrossCheck.spec.ts` already
 * computes it this way from `params.rebate`.
 */
const K_MAX_NUMERATOR = K_MAX_CAP * Math.log10(N0_ANCHOR);

/** CONCEPT.md §5's curve, in floating point: the thing the contract approximates. */
function kMaxExact(n: number): number {
    if (n <= N0_ANCHOR) return K_MAX_CAP;
    return Math.min(K_MAX_CAP, Math.max(K_MIN, K_MAX_NUMERATOR / Math.log10(n)));
}

describe('k_max(n) — the decay curve the ledger actually emits against', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let ledger: SandboxContract<PrimesLedger>;
    let ledgerCode: Cell;
    let itemCode: Cell;
    let walletCode: Cell;

    beforeAll(async () => {
        ledgerCode = await compile('PrimesLedger');
        itemCode = await compile('PrimesItem');
        walletCode = await compile('PrimesJettonWallet');

        // k_max is a pure function of n — it reads no storage beyond the code itself,
        // so this deploys the ledger unwired. Nothing here mints; the peers are
        // deliberately left as plain treasury addresses.
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        const treasuryWallet = await blockchain.treasury('treasury');
        const genesisScript = await blockchain.treasury('genesisScript');

        ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: deployer.address,
                        jettonMasterAddr: deployer.address,
                        treasuryAddr: treasuryWallet.address,
                        itemCode,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                ledgerCode,
            ),
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));
    });

    const kMax = async (n: number) => Number(await ledger.getKMax(BigInt(n))) / K_SCALE;

    // ---- defect 2: the digit-9 band -------------------------------------------
    // Every one of these threw a TVM range exception before the fix, because
    // table.get(10) is one past the end of a 10-entry table. ~11% of the number
    // line — every n whose leading digit is 9 — was unmintable.

    it('does not throw for leading digit 9 — the band that was out of bounds', async () => {
        const digitNine = [9, 90, 900, 9000, 9500, 9973, 90_000, 99_999, 900_000, 987_654];
        for (const n of digitNine) {
            const k = await kMax(n);
            expect(Number.isFinite(k)).toBe(true);
            expect(k).toBeGreaterThan(0);
        }
    });

    it('returns the right k_max for prime 9973, CONCEPT.md §5.1\'s worked example', async () => {
        // The specific number the document walks through by hand. It is a leading-digit-9
        // prime, so it sat squarely in the out-of-bounds band: the worked example in the
        // spec was, on the deployed contract, an exception rather than a number.
        expect(await kMax(9973)).toBeCloseTo(kMaxExact(9973), 2);
    });

    // ---- defect 1: the off-by-one, visible across the mantissa ------------------

    it('tracks 2.7/log10(n) across every leading digit 1..9', async () => {
        // The off-by-one added log10(m+1) in place of log10(m). Its error is largest
        // where the gap between adjacent table entries is largest — at the LOW digits,
        // log10(2)-log10(1) = 0.301 — so sweeping the mantissa is what exposes it.
        for (let digit = 1; digit <= 9; digit++) {
            for (const scale of [1e3, 1e4, 1e5, 1e6]) {
                const n = digit * scale;
                expect(await kMax(n)).toBeCloseTo(kMaxExact(n), 2);
            }
        }
    });

    it('agrees with §5.4\'s published decade values exactly', async () => {
        // These four are the rotation table's own k_max column. Pinned here as well as
        // in SimCrossCheck so that a change to the curve fails in the place that
        // explains it, not only in the place that consumes it.
        const published: Array<[number, number]> = [
            [1_000, 0.9],
            [10_000, 0.675],
            [100_000, 0.54],
            [1_000_000, 0.45],
        ];
        for (const [n, expected] of published) {
            expect(await kMax(n)).toBeCloseTo(expected, 3);
        }
    });

    // ---- the shape of the curve ------------------------------------------------

    it('is monotonically non-increasing in n', async () => {
        // The ratchet's whole argument is that the rebate decays. A curve that ticks
        // upward anywhere — which is exactly what an interpolation bug at a decade
        // boundary produces — breaks that claim locally.
        const ns = [
            1_000, 1_500, 2_000, 3_000, 5_000, 7_000, 9_000, 9_999, 10_000, 12_000,
            25_000, 50_000, 90_000, 99_999, 100_000, 250_000, 500_000, 900_000, 1_000_000,
        ];
        let prev = Infinity;
        for (const n of ns) {
            const k = await kMax(n);
            expect(k).toBeLessThanOrEqual(prev + 1e-9);
            prev = k;
        }
    });

    it('holds the 0.9 cap at and below the n0 = 1000 anchor', async () => {
        for (const n of [1, 2, 3, 7, 10, 100, 999, 1_000]) {
            expect(await kMax(n)).toBeCloseTo(K_MAX_CAP, 6);
        }
    });

    /**
     * GAUNTLET.md B32 — the test that makes `K_MAX_NUMERATOR` a derivation.
     *
     * `kMaxOf` has two branches and they meet at `n = N0_ANCHOR`: below it returns
     * `K_MAX_CAP` flat, above it evaluates `K_MAX_NUMERATOR / log10(n)`. They agree only
     * because the numerator IS `K_MAX_CAP * log10(N0_ANCHOR)` — which was written into the
     * contract as the bare literal `2700000000`, in the one file where every other constant
     * is a named `const` read from `shared/params.json`.
     *
     * The test above covers the flat branch. This one covers the HANDOVER, which is the
     * only place the relation between the two parameters is observable. Move `k_max_cap`
     * or `n0_anchor` in the sim without moving the numerator and the curve develops a
     * cliff at 1000 that nothing else looks for: at `k_max_cap = 0.95` the step is ~5%, at
     * `n0_anchor = 10000` it is ~25%.
     *
     * (One direction is masked and that is fine: LOWERING `k_max_cap` is caught by the
     * `kmax > K_MAX_CAP` clamp, which is the safe direction — it can only shrink k, so
     * §5's `k < 1` strengthens.)
     */
    it('B32: the two branches of k_max meet at the n0 anchor — no cliff at the handover', async () => {
        const atAnchor = await kMax(1_000);      // the flat branch, K_MAX_CAP
        const justAbove = await kMax(1_001);     // the formula branch, first step
        expect(atAnchor).toBeCloseTo(K_MAX_CAP, 6);
        // Continuous: the formula picks up within 0.1% of where the flat branch left off.
        // A desynced numerator shows up here as a percentage step, not a rounding one.
        expect(justAbove).toBeGreaterThan(K_MAX_CAP * 0.999);
        // And it is already decaying, so this is the curve and not the clamp: strictly
        // below the cap, which is what distinguishes a real handover from `min(cap, ...)`
        // hiding a mismatch.
        expect(justAbove).toBeLessThan(atAnchor);
    });

    it('clamps at k_min = 0.2 far up the line, and never below it', async () => {
        // 2.7/log10(n) reaches 0.2 at n = 10^13.5. Past that the clamp is the only
        // thing holding the floor, and k_max must never be reported under it.
        for (const n of [1e13, 1e14, 1e15]) {
            const k = await kMax(n);
            expect(k).toBeGreaterThanOrEqual(K_MIN - 1e-9);
        }
        expect(await kMax(1e15)).toBeCloseTo(K_MIN, 6);
    });

    it('keeps the fixed-point approximation within 1% of real log10 everywhere', async () => {
        // Linear interpolation between log10 table points is the documented source of
        // divergence between this and the Python sim. Bounding it here is what lets
        // SimCrossCheck use a tolerance instead of an exact match, honestly.
        for (const n of [1_234, 2_718, 3_141, 4_096, 5_000, 6_180, 7_919, 8_675, 9_973, 31_415, 65_536, 999_983]) {
            const got = await kMax(n);
            const want = kMaxExact(n);
            expect(Math.abs(got - want) / want).toBeLessThan(0.01);
        }
    });

    it('never exceeds the K_CEIL-bearing cap, for any n on the line', async () => {
        // k_max feeds kOfT, whose sum with the uplifts is what K_CEIL = 0.95 clamps.
        // If k_max itself could exceed 0.9 the ratchet theorem's k < 1 margin would be
        // eaten before the uplifts are even added.
        for (const n of [1, 999, 1_000, 1_001, 9_973, 10_000, 1e6, 1e9, 1e15]) {
            expect(await kMax(n)).toBeLessThanOrEqual(K_MAX_CAP + 1e-9);
        }
    });

    // -----------------------------------------------------------------------
    // GAUNTLET C5 — `PRIME_UPLIFT · PRIME_WINDOW < k_max(n)` across the FULL
    // range of n, not at spot values.
    //
    // CLAUDE.md carries this as an invariant that must never be broken by a
    // change. CONCEPT.md §5.1 states it, gives 0.30 against 0.45 at n = 10⁶, and
    // adds a parenthetical about where it stops holding:
    //
    //     "(The constraint only fails past n ≈ 10¹³, where the existing
    //      `k_max ≥ k_min` clamp already binds; it is unreachable.)"
    //
    // Sampled at spot values that all sit below 10⁷ — which is what
    // `params.json`'s invariant rows do —
    // the invariant holds and the parenthetical is never tested. Swept across the
    // whole line it does not hold past 10⁹, and the reason given is not the
    // reason.
    //
    // These tests pin the TRUE boundary. They are written to fail if the boundary
    // moves in either direction — if a parameter change makes the invariant hold
    // further up the line, that is just as much a change worth noticing as one
    // that makes it fail sooner.
    //
    // See DECISIONS.md D-56 for the escalation. Nothing here asserts that the
    // documented figure is correct, and nothing here changes the parameters: which
    // side is wrong is the owner's call, not this test's.
    // -----------------------------------------------------------------------

    describe('§5.1: PRIME_UPLIFT · PRIME_WINDOW < k_max(n), swept across the line', () => {
        it('holds strictly across every decade the head can realistically reach', async () => {
            // The head advances by one per composite mint at 1 TON, so this range
            // covers every n the sequential lane reaches short of a billion mints.
            // Dense enough to catch a boundary that moves by a decade, and it
            // walks the leading digits so the interpolated interior is included
            // rather than only the powers of ten.
            for (const e of [3, 4, 5, 6, 7, 8]) {
                for (const m of [1, 2, 3, 5, 7, 9]) {
                    const n = m * 10 ** e;
                    const k = await kMax(n);
                    expect({ n, holds: k > UPLIFT_X_WINDOW }).toEqual({ n, holds: true });
                }
            }
        });

        it('reaches EQUALITY at exactly n = 10⁹ — the invariant is strict, so this is where it stops holding', async () => {
            // k_max(10⁹) = 2.7/9 = 0.300000000, and PRIME_UPLIFT · PRIME_WINDOW is
            // 0.30. The contract's fixed-point arithmetic lands on it exactly, so
            // there is no rounding to argue about: at 10⁹ the credit is worth
            // precisely the rebate it replaces, and the strict `<` fails.
            expect(await kMax(1e9)).toBeCloseTo(UPLIFT_X_WINDOW, 9);
            expect(await kMax(1e9) > UPLIFT_X_WINDOW).toBe(false);
        });

        it('fails properly above 10⁹, in a region where NEITHER clamp is binding', async () => {
            // This is the part the documented parenthetical gets wrong. It
            // attributes the failure to the region where `k_max >= k_min` already
            // binds — which would make it benign, because a clamped k_max is not a
            // live emission rate. But k_min = 0.2 does not bind until n = 10^13.5,
            // so 10⁹ .. 10^13.5 is a four-decade window in which k_max is a live,
            // unclamped value BELOW 0.30 and the invariant is simply false.
            for (const e of [10, 11, 12, 13]) {
                const n = 10 ** e;
                const k = await kMax(n);
                expect({ n, holds: k > UPLIFT_X_WINDOW }).toEqual({ n, holds: false });
                // and the k_min clamp is demonstrably NOT what is happening here
                expect({ n, clamped: k <= K_MIN + 1e-9 }).toEqual({ n, clamped: false });
            }
        });

        it('locates the crossing by binary search, so the boundary is a measured number and not a comment', async () => {
            // Search the exponent range for the largest power of ten at which the
            // strict inequality still holds. Pinning it by search rather than by
            // assertion means a parameter change moves this test's REPORTED value
            // instead of quietly satisfying a hardcoded one.
            let lo = 3; // holds
            let hi = 15; // does not hold
            while (hi - lo > 1) {
                const mid = Math.floor((lo + hi) / 2);
                if ((await kMax(10 ** mid)) > UPLIFT_X_WINDOW) lo = mid;
                else hi = mid;
            }
            expect({ lastDecadeThatHolds: lo, firstDecadeThatFails: hi }).toEqual({
                lastDecadeThatHolds: 8,
                firstDecadeThatFails: 9,
            });
        });

        it('k < 1 is NOT what breaks here — K_CEIL is a separate and still-intact guard', async () => {
            // Worth stating explicitly so a failure above is not misread as a
            // ratchet-theorem failure. §5's `k < 1` is protected by the single
            // K_CEIL clamp on the SUMMED uplifts, which is independent of this
            // invariant: even at the extreme where k_max is at its 0.9 cap and
            // every uplift is live, the sum is clamped to 0.95 and the theorem
            // holds. What fails past 10⁹ is §5.1's economic claim — that a prime
            // credit is worth strictly less than the rebate the prime forwent —
            // not the ratchet.
            for (const n of [1e9, 1e12, 1e15]) {
                expect(await kMax(n)).toBeLessThanOrEqual(K_MAX_CAP + 1e-9);
            }
        });
    });
});
