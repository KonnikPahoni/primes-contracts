// TON PRIMES — D-99's score, end to end.
//
// `DECISIONS.md` D-99 / `PRICING_MODEL_PLAN.md` §1 replaced four pricing axes
// that never added (`max()` over a desirability score, an NPV table, a flat
// rarity-tier lift and `PRIME_P0_MIN`) with ONE additive score:
//
//     D(n) = clamp( LEN + max(DIGIT) + LIFE + Σ FORM + CULTURE + POSITION, 0, 87 )
//
// and one price, `MINT_PRICE · 2^(D/10)`. The three tiers — `discount`, `free`,
// `bonus` — and `specialNumberTier` with them are DELETED, so nothing in this
// file tests a tier: there is no tier to test. What there is instead is a sum
// that a reader must be able to recompute (`CLAUDE.md` §9.1) and a bitmask the
// orb draws its satellites from, and every block below is one of the plan's own
// acceptance checks (§8) turned into an assertion.
//
// The blocks, in the plan's order:
//
//   A. The two copies agree — the contract's `scoreOf` against `shared/score.ts`,
//      over a 500-point sweep. §2 keeps the score in byte-identical copies in
//      `primes_market.tolk` and `primes_ledger.tolk` (both `#include`
//      `score_block.tolk.inc`); the ledger publishes no get-method for it, so
//      the checkable statement is that the market's copy equals the independent
//      TypeScript mirror. Two implementations of one rule is how a transcription
//      slip inside 500 lines of Tolk gets caught.
//   B. Acceptance check 1 — the birthday, and the date that never happened.
//   C. Acceptance check 2 — the clamp IS the 420 GRAM ceiling.
//   D. §9.1 — the weight table is published, and the sum recomputes from it.
//   E. §5.1 — D-96's rebate family is NARROWED, not deleted: no points, no bit.
//   F. Acceptance check 6 — the vault's two-entry rebate schedule.
//   G. §3.1/§3.2 — the culture lists and the landmark table.
//   H. §4 — the factor categories, and the lower bound they make of `getLotPrice`.
//   I. EVERY CATEGORY, ONE BY ONE. 54 rows, one per bit, each with a witness the
//      chain must set it on and a near-miss it must not. A sweep proves the two
//      implementations agree; it does NOT prove either is right, because two
//      copies of the same transcription slip agree perfectly. This block is the
//      other half: every category checked against a number whose membership is
//      decided outside this repo (OEIS, Korselt, a date, a record), so a
//      predicate that is wrong in BOTH copies still fails here.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { FactorEntry, isqrt } from '../wrappers/PrimesLedger';
import { PrimesBountyVault, RebateScheduleEntry } from '../wrappers/PrimesBountyVault';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { testMarketConfig } from './helpers/market';
import { SCORE_BITS, SCORE_TERMS, REBATE_KIND } from '../../shared/opcodes';
import {
    BIT,
    LANDMARK_PRIMES,
    POINTS,
    PRIMORIALS,
    SCORE_MAX,
    bitsOf,
    isPrimeMR,
    isRebateFamilyPrime,
    scoreOf,
    scoreOfFrom,
} from '../../shared/score';

// ---------------------------------------------------------------------------
// The ladder, in TypeScript. Deliberately NOT imported from anywhere: the whole
// value of an expectation is that it was derived a second way. `fracAt` is the
// same 10-entry table `primes_market.tolk` publishes with `getFracTable()`, and
// FRAC[j] = round(2^(j/10) · 2^16) is the definition it was generated from.
// ---------------------------------------------------------------------------
const MINT_PRICE = toNano('1');
/** `RES_GAS`, re-derived by D-113 (was W8.1's 0.06) — `LOT_FLOOR` is the identity below. */
const RES_GAS = toNano('0.07');
const LOT_FLOOR = MINT_PRICE + RES_GAS;
const SCORE_HALVING = 10n;
const FRAC = [65536n, 70240n, 75281n, 80684n, 86475n, 92682n, 99334n, 106464n, 114105n, 122295n];
const ladder = (score: number) => {
    const d = BigInt(score);
    return ((MINT_PRICE << (d / SCORE_HALVING)) * FRAC[Number(d % SCORE_HALVING)]) >> 16n;
};
/** What `openingPriceOf` charges for a number the finite NPV table misses. */
const expectedP0 = (score: number) => (ladder(score) < LOT_FLOOR ? LOT_FLOOR : ladder(score));

/** D-11's cap. Above it every entry point refuses `n`, get-methods included. */
const AUCTIONABLE_MAX = 42_949_672_959_999n;
/** `mkt_n_above_cap`. */
const EXIT_N_ABOVE_CAP = 1020;
/** `mkt_primorial_not_auctionable` — §7's era boundaries mint at the head only. */
const EXIT_PRIMORIAL = 1008;

/**
 * §9.1's recompute, and the only definition of "the reader can check the price"
 * this repo has: sum the published weight of every set bit, add the continuous
 * LEN term, clamp once. Bit 5 (trailing zeros) is the one bit whose contribution
 * is not simply `points` — it pays PER zero, capped at `TZ_CAP` of them.
 */
function recomputeFromFlags(n: bigint, flags: bigint): number {
    const s = n.toString();
    const d = s.length;
    let tz = 0;
    while (tz < d && s[d - 1 - tz] === '0') tz++;
    let sum = d < SCORE_TERMS.LEN_REF ? SCORE_TERMS.LEN_W * (SCORE_TERMS.LEN_REF - d) : 0;
    for (const b of bitsOf(flags)) {
        sum += b === BIT.TRAILING_ZEROS ? POINTS[b] * Math.min(tz, SCORE_TERMS.TZ_CAP) : POINTS[b];
    }
    return sum;
}

/** The set bits of a `flags` word as their published keys — readable failures. */
const flagKeys = (flags: bigint) => SCORE_BITS.filter((b) => (flags >> BigInt(b.bit)) & 1n).map((b) => b.key);

// ---------------------------------------------------------------------------
// THE SWEEP.
//
// 300 dense + ~200 sampled ≈ 500 get-calls, which the sandbox runs in well under
// the suite's 60 s hook budget (the sweep test raises its own timeout anyway).
// The dense head is where every small witness lives — every Fermat prime below
// 300, both single-digit perfect numbers, the first three primorials, the
// factorials, 42 and 69 and 101 and 108 — and the sampled tail is what stops the
// suite from testing only three-digit arithmetic: LIFE's 8-digit forms, the
// 8-digit perfect number, the deep landmark primes and the emirp/Fibonacci
// branches only exist out there.
// ---------------------------------------------------------------------------

/** Hand-picked witnesses, one or more per group of §1.3's weight table. */
const WITNESSES: bigint[] = [
    // FORM: primes, Fermat primes, Mersenne primes.
    2n, 3n, 5n, 17n, 257n, 65537n, 8191n, 131071n,
    // FORM: the perfect numbers below AUCTIONABLE_MAX, and two factorials.
    6n, 28n, 496n, 8128n, 33550336n, 720n, 40320n,
    // DIGIT: repdigit, power of ten, ascending/descending runs, abab/aabb.
    1111n, 10000n, 1234n, 9876n, 1212n, 1122n,
    // CULTURE + POSITION.
    1729n, 42n, 420n, 777n, 1337n,
    // LIFE: §8 check 1's birthday, two more valid YYYYMMDD, a DDMMYYYY, a leap
    // day that happened, a leap day that did not, YYMMDD, MMDD/DDMM, a bare year.
    19720909n, 20201207n, 12072020n, 20240229n, 20240230n, 1207n, 2512n, 1912n,
    // POSITION/rebate-family/plain: the family witness, a landmark, two plain ones.
    100193n, 999983n, 123456n, 999999n,
    // N6's nine (bits 39..47): the smallest witness of each, so the mirror
    // agreement in block A actually exercises them. `carmichael` is factor-
    // derived and belongs to block H's sweep, not this one — 561 is here so
    // that both halves reach it.
    561n, 1234567890n, 9474n, 9376n, 1225n, 2728n, 5040n, 197n, 429n,
    // D-162's two from-`n` bits (52 lucas, 53 pronic). The four factor-side ones
    // (48..51) are reached by block H's factored sweep.
    843n, 5778n, 1332n, 999000n,
];

/** Deterministic sample across 10³..10¹³ — a fixed LCG, so a failure reproduces. */
function sampledSpread(): bigint[] {
    let state = 0x2f6e2b1n; // any fixed seed; the point is only that it never moves
    const next = () => {
        state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return state >> 16n;
    };
    const out: bigint[] = [];
    for (let e = 3; e <= 13; e++) {
        const lo = 10n ** BigInt(e);
        const hi = lo * 10n - 1n;
        for (let i = 0; i < 15; i++) {
            const n = lo + (next() % (hi - lo + 1n));
            if (n <= AUCTIONABLE_MAX) out.push(n);
        }
    }
    return out;
}

const SWEEP: bigint[] = (() => {
    const seen = new Set<string>();
    const out: bigint[] = [];
    const push = (n: bigint) => {
        if (n > AUCTIONABLE_MAX || seen.has(n.toString())) return;
        seen.add(n.toString());
        out.push(n);
    };
    for (let n = 1n; n <= 300n; n++) push(n);
    WITNESSES.forEach(push);
    sampledSpread().forEach(push);
    return out;
})();

describe('D-99 — the score (PRICING_MODEL_PLAN.md §1, DECISIONS.md D-99)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let market: SandboxContract<PrimesMarket>;
    let marketCode: Cell;

    beforeAll(async () => {
        marketCode = await compile('PrimesMarket');
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        const ledgerStandIn = await blockchain.treasury('ledger');
        const ratchetStandIn = await blockchain.treasury('ratchet');
        // `scoreOf`, `getScoreBreakdown`, `getScoreWeights` and the ladder half of
        // `getLotPrice` are all pure functions of `n` and file constants: they
        // read no peer and no counter, so one market with stand-in peers and an
        // EMPTY NPV table is the whole fixture. The empty table is deliberate —
        // it isolates the ladder, which is the term D-99 changed. `1.5 · NPV`
        // still binds on the 930 primes below 7,297 in a real deployment
        // (`PrimesMarket.spec.ts` owns that branch); an empty table here means a
        // prime's quoted `p0` is exactly `max(LOT_FLOOR, ladder(D))`, which is
        // what these assertions are about.
        market = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({ ledgerAddr: ledgerStandIn.address, ratchetAddr: ratchetStandIn.address }),
                marketCode
            )
        );
        await market.sendDeploy(deployer.getSender(), toNano('5'));
    });

    // =======================================================================
    // A. THE TWO COPIES AGREE
    // =======================================================================
    describe('A. the contract and `shared/score.ts` return the same (score, flags)', () => {
        it(`agrees with the TypeScript mirror on all ${SWEEP.length} sweep points`, async () => {
            // A per-`n` `expect` inside the loop would stop at the first
            // disagreement and hide the shape of a systematic drift (one bit
            // wrong on every 8-digit number reads very differently from one
            // wrong witness). Collect, then assert the empty list.
            const disagreements: string[] = [];
            for (const n of SWEEP) {
                const chain = await market.getScoreBreakdown(n);
                const mirror = scoreOf(n);
                if (chain.score !== mirror.score || chain.flags !== mirror.flags) {
                    disagreements.push(
                        `n=${n}: chain (${chain.score}, [${flagKeys(chain.flags)}]) ` +
                            `vs mirror (${mirror.score}, [${flagKeys(mirror.flags)}])`
                    );
                }
            }
            expect(disagreements).toEqual([]);
        }, 300_000);

        it('`getScoreBreakdown` answers for a primorial; `getLotPrice` refuses one', async () => {
            // The two get-methods differ ON PURPOSE and the difference is easy to
            // read as a bug, so it is pinned here. §7's era boundaries are never
            // sold on either lane (`mkt_primorial_not_auctionable`), so quoting a
            // price for one would be §9.1 dishonesty — a number no lane will
            // ever fill. But a primorial still HAS a score and still wears its
            // satellites on the orb, so the breakdown must answer.
            for (const p of PRIMORIALS) {
                if (p > AUCTIONABLE_MAX) continue;
                const chain = await market.getScoreBreakdown(p);
                expect(chain).toEqual(scoreOf(p));
                expect(flagKeys(chain.flags)).toContain('primorial');
                await expect(market.getLotPrice(p)).rejects.toThrow(String(EXIT_PRIMORIAL));
            }
        });

        it('refuses `n` above the D-11 cap rather than overflowing Miller-Rabin', async () => {
            // GAUNTLET P2.C1: the guard runs BEFORE Miller-Rabin, or a 78-digit
            // argument overflows int257 inside `modpow` and surfaces as exit 4.
            await expect(market.getScoreBreakdown(AUCTIONABLE_MAX + 1n)).rejects.toThrow(String(EXIT_N_ABOVE_CAP));
        });

        it('`getLotPrice` returns the same (score, flags) as `getScoreBreakdown`', async () => {
            // §1.6: `getScoreBreakdown` exists so a reader can audit the price,
            // which only works if it is literally the same function the price
            // was computed from rather than a second opinion.
            for (const n of [42n, 1111n, 8191n, 19720909n, 999983n]) {
                const price = await market.getLotPrice(n);
                const breakdown = await market.getScoreBreakdown(n);
                expect({ score: price.score, flags: price.flags }).toEqual(breakdown);
                expect(price.p0).toBe(expectedP0(breakdown.score));
            }
        });
    });

    // =======================================================================
    // B. ACCEPTANCE CHECK 1 — the birthday, and the date that never happened
    // =======================================================================
    describe('B. §8 check 1 — a gift-grade birthday prices as one; an impossible date does not', () => {
        it('19720909 prices as a birthday, with exactly the YYYYMMDD bit among LIFE bits', async () => {
            const { p0, score, flags } = await market.getLotPrice(19_720_909n);
            // The score, derived here rather than copied from the plan's table:
            // 8 digits, so LEN pays 2 · (9 − 8) = 2; LIFE.YYYYMMDD pays 30; and
            // FORM.digitsum_prime pays 2, because 1+9+7+2+0+9+0+9 = 37 is prime.
            // 34 in total.
            //
            // §8's acceptance check 1 quotes "≈ 9.2 GRAM", which is ladder(32) —
            // it is the plan's own §1.4 row, and that row is one of the ones
            // §1.4's closing note warns about: "The FORM columns for the larger
            // primes were filled by hand and may miss a sub-family bit;
            // `SpecialNumbers.spec.ts` REGENERATES this table from the contract
            // and the checked-in table is corrected to match, never the reverse."
            // The hand-filled row missed the digit-sum bit. So the assertion is
            // the derived number, 34 → 10.55 GRAM, and the plan's table is what
            // owes an edit. The gift-grade band answer 11 asked for (6–10 GRAM for
            // a plain birthday) is unchanged in substance.
            const expectedScore =
                SCORE_TERMS.LEN_W * (SCORE_TERMS.LEN_REF - 8) + POINTS[BIT.YYYYMMDD] + POINTS[BIT.DIGITSUM_PRIME];
            expect(expectedScore).toBe(34);
            expect(score).toBe(expectedScore);
            expect(flagKeys(flags).sort()).toEqual(['digitsum_prime', 'yyyymmdd']);
            // ladder(34) = (1 GRAM << 3) · FRAC[4] >> 16 = 10.55… GRAM. Computed
            // from the published FRAC table, never a copied round figure (10.556…,
            // not a rounded 10.55 — the integer ladder is exact and the test
            // must not launder it through a decimal).
            expect(p0).toBe(expectedP0(expectedScore));
            expect(Number(p0) / 1e9).toBeCloseTo(10.556, 3);
            // "exactly the LIFE yyyymmdd bit among LIFE bits": one 8-digit form
            // can match at most one way (§1.3's life-date rules), so a second
            // LIFE bit here would mean the DDMMYYYY branch double-counted.
            const life = SCORE_BITS.filter((b) => b.group === 'LIFE' && (flags >> BigInt(b.bit)) & 1n);
            expect(life.map((b) => b.key)).toEqual(['yyyymmdd']);
        });

        it('a birthday that carries the LIFE bit and nothing else lands on §8 check 1\'s 9.2 GRAM', async () => {
            // 20201207 is the plan's second birthday witness and the one whose
            // hand-filled §1.4 row is exactly right: digit sum 14 is composite,
            // so LIFE.YYYYMMDD is the only bit, D = 2 + 30 = 32, and
            // ladder(32) = 9.189… GRAM. This is where acceptance check 1's
            // headline figure actually holds, unmodified.
            const { p0, score, flags } = await market.getLotPrice(20_201_207n);
            expect(score).toBe(32);
            expect(flagKeys(flags)).toEqual(['yyyymmdd']);
            expect(p0).toBe(expectedP0(32));
            expect(Number(p0) / 1e9).toBeCloseTo(9.19, 2);
        });

        it('20240229 is a real leap day and scores as one; 20240230 never happened', async () => {
            // Gregorian 4/100/400 is the whole point of doing calendar validity
            // properly rather than "month ≤ 12, day ≤ 31": 2024 is a leap year,
            // so 29 February exists and 30 February does not, in any year.
            const leap = await market.getScoreBreakdown(20_240_229n);
            expect(flagKeys(leap.flags)).toContain('yyyymmdd');

            const impossible = await market.getScoreBreakdown(20_240_230n);
            const lifeBits: number[] = SCORE_BITS.filter((b) => b.group === 'LIFE').map((b) => b.bit);
            expect(bitsOf(impossible.flags).filter((b) => lifeBits.includes(b))).toEqual([]);
            // What is left over is only what the DIGITS happen to be worth: one
            // trailing zero (8) and a prime digit sum (2 + 0 + 2 + 4 + 0 + 2 + 3
            // + 0 = 13, prime, 2), plus LEN's 2. Twelve points, 2.30 GRAM — a
            // quarter of what the same date-shaped number earns when the date is
            // real, which is the whole content of "a birthday that did not
            // happen is not a gift". The comparison against 20240229, the leap
            // day that DID happen, is the assertion that matters.
            expect(impossible.score).toBe(
                SCORE_TERMS.LEN_W * (SCORE_TERMS.LEN_REF - 8) + POINTS[BIT.TRAILING_ZEROS] + POINTS[BIT.DIGITSUM_PRIME]
            );
            expect(impossible.score).toBeLessThan(leap.score);
            expect((await market.getLotPrice(20_240_230n)).p0).toBeLessThan(
                (await market.getLotPrice(20_240_229n)).p0
            );
        });
    });

    // =======================================================================
    // C. ACCEPTANCE CHECK 2 — the clamp IS the ceiling
    // =======================================================================
    describe('C. §8 check 2 — one clamp on the sum, and it is the 420 GRAM ceiling', () => {
        /** Owner answer 9: composites open at no more than 420 GRAM. */
        const CEILING = toNano('420.5');

        it('the clamp and the ladder agree: ladder(SCORE_MAX) sits under 420.5 GRAM', () => {
            // 2^(87/10) = 415.87 — `SCORE_MAX = 87` was CHOSEN so that the single
            // clamp on the summed score is the price ceiling, the same
            // one-clamp-over-a-sum discipline §5 gives `K_CEIL`. There is no
            // second ceiling anywhere, and this assertion is what keeps it that
            // way: raise SCORE_MAX and this fails before the price does.
            expect(SCORE_TERMS.SCORE_MAX).toBe(SCORE_MAX);
            expect(ladder(SCORE_MAX)).toBeLessThan(CEILING);
            expect(ladder(SCORE_MAX + 1)).toBeGreaterThan(CEILING);
        });

        it('no composite in the sweep opens above 420.5 GRAM', async () => {
            for (const n of SWEEP) {
                if (isPrimeMR(n)) continue;
                if (PRIMORIALS.includes(n)) continue; // refused outright, see block A
                const { p0 } = await market.getLotPrice(n);
                expect(p0).toBeLessThanOrEqual(CEILING);
                expect(p0).toBeGreaterThanOrEqual(LOT_FLOOR);
            }
        }, 300_000);

        it('2, 3 and 5 earn more than 87 points and are handed back exactly 87', async () => {
            // The natural witnesses: each is prime, twin, Sophie Germain and/or
            // safe and/or Fermat and/or Mersenne, each is a single digit so LEN
            // pays its maximum 16, and 2 is on the iconic list as well. Their
            // RAW sums run past the cap, which is exactly the case the clamp
            // exists for — and the case where a missing clamp would be invisible
            // in every other test, because nothing else gets near it.
            for (const n of [2n, 3n, 5n]) {
                const chain = await market.getScoreBreakdown(n);
                expect(recomputeFromFlags(n, chain.flags)).toBeGreaterThan(SCORE_MAX);
                expect(chain.score).toBe(SCORE_MAX);
            }
        });
    });

    // =======================================================================
    // D. §9.1 — the weight table is published, and the sum recomputes from it
    // =======================================================================
    describe('D. §9.1 — every number the UI shows maps to a get-method', () => {
        it('`getScoreWeights()` equals `shared/opcodes.ts`, position by position', async () => {
            // Position IS the bit number (§8.2 hangs the orb's fixed satellite
            // angles off the same numbering), so an off-by-one here silently
            // repoints every satellite as well as every weight. Compared
            // element-wise rather than with one `toEqual` so a failure names the
            // category that moved.
            const published = await market.getScoreWeights();
            expect(published.points).toHaveLength(SCORE_BITS.length);
            for (const entry of SCORE_BITS) {
                expect(`${entry.key}=${published.points[entry.bit]}`).toBe(`${entry.key}=${entry.points}`);
            }
            expect(published.LEN_REF).toBe(SCORE_TERMS.LEN_REF);
            expect(published.LEN_W).toBe(SCORE_TERMS.LEN_W);
            expect(published.TZ_CAP).toBe(SCORE_TERMS.TZ_CAP);
            expect(published.SCORE_MAX).toBe(SCORE_TERMS.SCORE_MAX);
        });

        it('the score recomputes from `flags` + the published weights, for every sweep point', async () => {
            // THIS is the honesty rule in executable form: a reader who has only
            // `getScoreBreakdown(n)` and `getScoreWeights()` must be able to
            // land on the same number the contract charged for. If this passes
            // and A passes, the price is fully auditable from chain state alone.
            const mismatches: string[] = [];
            for (const n of SWEEP) {
                const { score, flags } = await market.getScoreBreakdown(n);
                const recomputed = Math.min(recomputeFromFlags(n, flags), SCORE_TERMS.SCORE_MAX);
                if (recomputed !== score) {
                    mismatches.push(`n=${n}: contract ${score}, recomputed ${recomputed} from [${flagKeys(flags)}]`);
                }
            }
            expect(mismatches).toEqual([]);
        }, 300_000);

        it('trailing zeros are PER zero and capped at three — bit 5 is the one non-flat weight', async () => {
            // 10, 100, 1000, 10000 all set bit 1 (power of ten, 40 pts) which
            // beats trailing zeros on the DIGIT max, so the per-zero weight is
            // only visible on a number that is NOT a power of ten. 2000 has
            // three zeros, 20000 has four and must pay for three.
            const three = await market.getScoreBreakdown(2000n);
            const four = await market.getScoreBreakdown(20_000n);
            expect(flagKeys(three.flags)).toContain('trailing_zeros');
            expect(flagKeys(four.flags)).toContain('trailing_zeros');
            const tzPart = (n: bigint, s: number) =>
                s - (n.toString().length < SCORE_TERMS.LEN_REF
                    ? SCORE_TERMS.LEN_W * (SCORE_TERMS.LEN_REF - n.toString().length)
                    : 0);
            // 2000 is also a year (LIFE, 25) — subtract nothing by hand, just
            // check the cap directly against the recompute, which knows the rule.
            expect(recomputeFromFlags(2000n, three.flags)).toBe(three.score);
            expect(recomputeFromFlags(20_000n, four.flags)).toBe(four.score);
            expect(tzPart(20_000n, four.score)).toBeLessThanOrEqual(
                POINTS[BIT.TRAILING_ZEROS] * SCORE_TERMS.TZ_CAP + POINTS[BIT.HARSHAD] + POINTS[BIT.HAPPY]
            );
        });
    });

    // =======================================================================
    // E. D-96 NARROWED, NOT DELETED
    // =======================================================================
    describe('E. §1.5 / §5.1 — the rebate family scores nothing and wears no bit', () => {
        it('no bit in the published table is the rebate family', () => {
            // D-96 signed `dirichlet_primes` as a RARITY on 2026-09-03; D-99
            // (answer 15, §5 point 1) rules that "free" was a rebate family
            // wearing a rarity badge and strips the rarity meaning. The family
            // survives — it is what §1.5's flat prime rebate pays on — but it is
            // not a category: no bit, no points, no price lift, no satellite.
            // 33 bits at D-99; phase 3 (§4) appended 33..38, N6 39..47 and
            // D-162 48..53. The count is asserted because a bit sneaking in is
            // exactly how the rebate family would come back as a rarity.
            expect(SCORE_BITS).toHaveLength(54);
            expect(SCORE_BITS.map((b) => b.key)).not.toContain('dirichlet');
            expect(SCORE_BITS.map((b) => b.key)).not.toContain('rebate_family');
        });

        it('100193 is in the family and scores exactly like a non-family prime of the same shape', async () => {
            expect(isRebateFamilyPrime(100_193n)).toBe(true); // > 100,000 and ≡ 1 (mod 101)

            const family = await market.getScoreBreakdown(100_193n);
            // The control: the nearest prime that is NOT in the family but whose
            // categories are identical. Found rather than hand-picked, so this
            // stays a same-shape comparison if the weight table ever changes.
            let control = 0n;
            for (let q = 100_003n; q < 200_000n; q++) {
                if (q % 101n === 1n) continue; // in the family — not a control
                if (!isPrimeMR(q)) continue;
                if (scoreOf(q).flags === family.flags) {
                    control = q;
                    break;
                }
            }
            expect(control).not.toBe(0n);
            const controlChain = await market.getScoreBreakdown(control);
            expect(controlChain.flags).toBe(family.flags);
            expect(controlChain.score).toBe(family.score);
            // And the price follows the score, so family membership buys nothing.
            expect((await market.getLotPrice(100_193n)).p0).toBe((await market.getLotPrice(control)).p0);
        });

        it('the family is still real — it is a rebate KIND, not a score bit', () => {
            // Where the family DID survive: `REBATE_KIND.PRIME_FAMILY` selects
            // the vault's flat prime rebate (block F pays it). Membership is
            // D-96's predicate untouched — 1 in 100 primes at every depth, so it
            // never exhausts and the rebate keeps paying along the whole line.
            expect(isRebateFamilyPrime(100_193n)).toBe(true);
            expect(isRebateFamilyPrime(100_003n)).toBe(false); // prime, wrong residue
            expect(isRebateFamilyPrime(50_501n)).toBe(false); // right residue, below 100,000
            expect(REBATE_KIND.PRIME_FAMILY).toBe(1);
        });
    });

    // =======================================================================
    // G. THE LISTS (block F is the vault suite below — it needs its own fixture)
    // =======================================================================
    describe('G. §3.1/§3.2 — the culture lists and the landmark table', () => {
        // Transcribed from PRICING_MODEL_PLAN.md §3.1 BY HAND, not imported from
        // `shared/score.ts`, for the same reason block A does not import the
        // score: a list checked against itself checks nothing. These are the
        // owner-signed lists (answer 17) and the test is the second copy.
        const ICONIC = [2n, 42n, 69n, 420n, 666n, 777n, 1337n, 1729n, 8008n];
        const LISTED = [
            7n, 13n, 23n, 47n, 88n, 99n, 101n, 108n, 404n, 418n, 451n, 495n, 911n, 1234n,
            1984n, 2001n, 2049n, 4096n, 6174n, 8086n, 9000n, 9001n, 24_601n, 31_337n,
            65_536n, 80_085n, 90_210n, 142_857n, 5_318_008n, 8_675_309n,
        ];

        it('every iconic number sets the iconic bit, and only it, in the CULTURE group', async () => {
            for (const n of ICONIC) {
                const { flags } = await market.getScoreBreakdown(n);
                const culture = SCORE_BITS.filter((b) => b.group === 'CULTURE' && (flags >> BigInt(b.bit)) & 1n);
                expect(`${n}: ${culture.map((b) => b.key)}`).toBe(`${n}: iconic`);
            }
        });

        it('every listed number sets the listed bit, and only it, in the CULTURE group', async () => {
            for (const n of LISTED) {
                const { flags } = await market.getScoreBreakdown(n);
                const culture = SCORE_BITS.filter((b) => b.group === 'CULTURE' && (flags >> BigInt(b.bit)) & 1n);
                expect(`${n}: ${culture.map((b) => b.key)}`).toBe(`${n}: listed`);
            }
        });

        it('a number adjacent to a listed one is not on either list', async () => {
            // The lists are exact, not ranges: "a reader who is not a
            // mathematician recognises it WITHOUT explanation" (§3.1's rule for
            // future additions) is a membership test, so 1338 must earn nothing.
            for (const n of [41n, 43n, 1338n, 8087n]) {
                const { flags } = await market.getScoreBreakdown(n);
                expect(SCORE_BITS.filter((b) => b.group === 'CULTURE' && (flags >> BigInt(b.bit)) & 1n)).toEqual([]);
            }
        });

        it('§3.2 — the landmark table is SIEVED and live; every entry sets bit 31', async () => {
            // NOTE FOR WHOEVER READS THIS NEXT: `isLandmarkPrime` was a Phase 2
            // stub returning `false` when D-99's phase 1 landed, and this block
            // was written to assert the bit was always clear. The sieve
            // (`sim/scripts/landmark_primes.py`, §3.2's provenance) has since
            // landed and the table is populated in BOTH copies — the contract's
            // generated function body and `shared/score.ts`'s mirror — so the
            // assertion is now the real one. Do not hand-edit either table;
            // re-run the script and both follow.
            expect(LANDMARK_PRIMES.size).toBeGreaterThan(0);
            const inRange = [...LANDMARK_PRIMES].filter((p) => p <= AUCTIONABLE_MAX);
            expect(inRange.length).toBeGreaterThan(0);
            for (const p of inRange) {
                const { flags } = await market.getScoreBreakdown(p);
                expect(`${p}: ${flagKeys(flags).includes('landmark')}`).toBe(`${p}: true`);
            }
        }, 120_000);

        it('a landmark entry above the D-11 cap is refused, not scored', async () => {
            // The sieve runs to 10^14 because §3.2 defines the table by decades,
            // but D-11 caps what the game will ever sell at 4.29·10¹³. The
            // entries past the cap are dead weight in the table and must stay
            // unreachable rather than becoming a quotable price.
            const aboveCap = [...LANDMARK_PRIMES].filter((p) => p > AUCTIONABLE_MAX);
            for (const p of aboveCap) {
                await expect(market.getScoreBreakdown(p)).rejects.toThrow(String(EXIT_N_ABOVE_CAP));
            }
        });

        it('a prime that is not a landmark does not wear the bit', async () => {
            for (const p of [8191n, 100_193n, 999_979n]) {
                const { flags } = await market.getScoreBreakdown(p);
                expect(`${p}: ${flagKeys(flags).includes('landmark')}`).toBe(`${p}: false`);
            }
        });
    });

    // =======================================================================
    // H. PHASE 3 — the factor categories (§4)
    //
    // Five categories `n` alone cannot decide, computed from the factorization
    // a composite ALREADY submits at `open_lot` and at head mint. They are the
    // reason `getLotPrice(n)` is a LOWER BOUND rather than the price, so what
    // this block pins is exactly that relationship: the two methods answer
    // about the same number, they differ only in bits 33..38, the factored one
    // is never smaller, and both still recompute from the published weights.
    // =======================================================================
    describe('H. §4 — the factor categories, and the lower bound they make of `getLotPrice`', () => {
        /** `FactorEntry` with the ⌊√p⌋ the contract wants; the score ignores `s`. */
        const fe = (prime: bigint, exponent: number): FactorEntry => ({ prime, exponent, s: isqrt(prime) });
        /** Trial-divide a witness so no test here hand-writes a factorization. */
        const factorize = (n: bigint): FactorEntry[] => {
            const out: FactorEntry[] = [];
            let m = n;
            for (let p = 2n; p * p <= m; p++) {
                let e = 0;
                while (m % p === 0n) {
                    m /= p;
                    e++;
                }
                if (e > 0) out.push(fe(p, e));
            }
            if (m > 1n) out.push(fe(m, 1));
            return out;
        };
        const mirrorOf = (n: bigint) =>
            scoreOfFrom(
                n,
                factorize(n).map((f) => ({ p: f.prime, e: f.exponent }))
            );

        it('an empty list returns exactly what the from-`n` methods return', async () => {
            // The whole "lower bound, not a different answer" claim rests on
            // this: a caller with no factorization loses nothing by asking the
            // factored method, and the two cannot drift apart silently.
            for (const n of [1n, 2n, 42n, 1111n, 8191n, 19720909n, 999983n]) {
                expect(await market.getScoreBreakdownFrom(n, [])).toEqual(await market.getScoreBreakdown(n));
                expect(await market.getLotPriceFrom(n, [])).toEqual(await market.getLotPrice(n));
            }
        }, 120_000);

        it('agrees with the TypeScript mirror over the composites of the sweep', async () => {
            const disagreements: string[] = [];
            // Trial division is O(√n), so the 8-digit tail of the sweep is left
            // to the named witnesses below rather than factored here.
            for (const n of SWEEP.filter((x) => x > 1n && x <= 100_000n)) {
                const factors = factorize(n);
                if (factors.length === 1 && factors[0].exponent === 1) continue; // prime: nothing to add
                const chain = await market.getScoreBreakdownFrom(n, factors);
                const mirror = mirrorOf(n);
                if (chain.score !== mirror.score || chain.flags !== mirror.flags) {
                    disagreements.push(
                        `n=${n}: chain (${chain.score}, [${flagKeys(chain.flags)}]) ` +
                            `vs mirror (${mirror.score}, [${flagKeys(mirror.flags)}])`
                    );
                }
            }
            expect(disagreements).toEqual([]);
        }, 600_000);

        it('each of the five categories fires on its own witness, and only where it should', async () => {
            const bits = async (n: bigint) => flagKeys((await market.getScoreBreakdownFrom(n, factorize(n))).flags);
            // 15 = 3·5: Ω = 2, square-free, 7-smooth, deficient.
            expect(await bits(15n)).toEqual(
                expect.arrayContaining(['semiprime', 'squarefree', 'smooth', 'deficient'])
            );
            expect(await bits(15n)).not.toContain('prime_power');
            // 27 = 3³: one distinct factor, so a prime power — and NOT square-free.
            expect(await bits(27n)).toEqual(expect.arrayContaining(['prime_power', 'smooth', 'deficient']));
            expect(await bits(27n)).not.toContain('squarefree');
            // 49 = 7²: Ω = 2 AND one distinct factor, so BOTH bits. The model is
            // additive and its categories were never a partition — 64 already
            // carries SQUARE and CUBE together for the same reason.
            expect(await bits(49n)).toEqual(expect.arrayContaining(['semiprime', 'prime_power']));
            // 30 = 2·3·5: square-free, smooth, and the first abundant witness.
            expect(await bits(30n)).toEqual(expect.arrayContaining(['squarefree', 'smooth', 'abundant']));
            expect(await bits(30n)).not.toContain('semiprime');
            // 143 = 11·13: a semiprime that is NOT 7-smooth.
            expect(await bits(143n)).toContain('semiprime');
            expect(await bits(143n)).not.toContain('smooth');
            // 6 is perfect: σ(6) = 12 = 2·6, so it earns NEITHER of the pair and
            // keeps only the 40 points BIT_PERFECT already pays it.
            const six = await bits(6n);
            expect(six).toContain('perfect');
            expect(six).not.toContain('abundant');
            expect(six).not.toContain('deficient');
        }, 120_000);

        it('N6 bit 39 — Korselt decides `carmichael`, and only from the factor list', async () => {
            const bits = async (n: bigint) => flagKeys((await market.getScoreBreakdownFrom(n, factorize(n))).flags);
            // The three smallest Carmichael numbers (OEIS A002997). 1729 is the
            // taxicab AND a Carmichael number — 1728 is divisible by 6, 12 and
            // 18 — which is a coincidence worth having in the fixture, because
            // it is the one witness a reader is likely to think they know.
            const missed: string[] = [];
            for (const n of [561n, 1105n, 1729n, 2465n, 2821n, 6601n]) {
                if (!(await bits(n)).includes('carmichael')) missed.push(n.toString());
            }
            expect(missed).toEqual([]);
            // Korselt has three clauses and each one alone must refuse:
            // 15 = 3·5 is squarefree and divides, but has only two factors.
            expect(await bits(15n)).not.toContain('carmichael');
            // 1730 = 2·5·173 has three factors and is squarefree, but 4 ∤ 1729.
            expect(await bits(1730n)).not.toContain('carmichael');
            // 1728 = 2⁶·3³ has three factors' worth of multiplicity and is NOT
            // squarefree. Its neighbour 1729 is, which is the whole difference.
            expect(await bits(1728n)).not.toContain('carmichael');
            // And it is genuinely FACTOR-derived: the from-`n` method, which the
            // MINT path uses, never sets it. That is not a defect — it is the
            // same lower-bound contract bits 33..38 have.
            expect(flagKeys((await market.getScoreBreakdown(561n)).flags)).not.toContain('carmichael');
        }, 120_000);

        it('the factored score is never below the from-`n` score, and moves no other bit', async () => {
            // §4's whole claim about `getLotPrice(n)`. A regression here means a
            // quote the UI shows is no longer a bound on what `open_lot` charges.
            const regressions: string[] = [];
            for (const n of SWEEP.filter((x) => x > 1n && x <= 20_000n)) {
                const lower = await market.getScoreBreakdown(n);
                const full = await market.getScoreBreakdownFrom(n, factorize(n));
                if (full.score < lower.score) regressions.push(`n=${n}: ${full.score} < ${lower.score}`);
                // Mask off the FACTOR-ONLY bits — 33..38, N6's 39 and D-162's
                // 48..51 — and what is left must be byte-identical to the from-`n`
                // answer. This used to mask everything above 32, which was the
                // same set until N6 put eight more from-`n` categories at 40..47;
                // keeping that mask would have hidden a drift in exactly the bits
                // it exists to protect. D-162's 52/53 are from `n` and stay in.
                const FACTOR_ONLY = (((1n << 7n) - 1n) << 33n) | (((1n << 4n) - 1n) << 48n);
                if ((full.flags & ~FACTOR_ONLY) !== lower.flags) {
                    regressions.push(`n=${n}: a from-\`n\` bit moved when the factors were supplied`);
                }
            }
            expect(regressions).toEqual([]);
        }, 300_000);

        it('D-162 — smith, sphenic, powerful and achilles fire only from the factor list', async () => {
            const bits = async (n: bigint) => flagKeys((await market.getScoreBreakdownFrom(n, factorize(n))).flags);
            // SMITH (A006753): the first ten, and none of the composites between.
            const smith = [4n, 22n, 27n, 58n, 85n, 94n, 121n, 166n, 202n, 265n];
            const found: bigint[] = [];
            for (let n = 4n; n <= 265n; n++) {
                if (isPrimeMR(n)) continue;
                if ((await bits(n)).includes('smith')) found.push(n);
            }
            expect(found).toEqual(smith);
            // SPHENIC: three distinct primes each once. 60 = 2²·3·5 has three
            // distinct factors but Ω = 4, which is the clause that must refuse.
            expect(await bits(105n)).toContain('sphenic');
            expect(await bits(60n)).not.toContain('sphenic');
            // POWERFUL and ACHILLES. 72 = 2³·3² is both; 36 = 2²·3² is powerful
            // and a perfect square (exponent gcd 2), so NOT Achilles; 64 = 2⁶ is
            // a prime power, powerful, never Achilles; 12 = 2²·3 is neither.
            expect(await bits(72n)).toEqual(expect.arrayContaining(['powerful', 'achilles']));
            expect(await bits(36n)).toContain('powerful');
            expect(await bits(36n)).not.toContain('achilles');
            expect(await bits(64n)).toContain('powerful');
            expect(await bits(64n)).not.toContain('achilles');
            expect(await bits(12n)).not.toContain('powerful');
            // ACHILLES (A052486) to 1000, exactly.
            const achilles: bigint[] = [];
            for (let n = 2n; n <= 1000n; n++) {
                if ((await bits(n)).includes('achilles')) achilles.push(n);
            }
            expect(achilles).toEqual([72n, 108n, 200n, 288n, 392n, 432n, 500n, 648n, 675n, 800n, 864n, 968n, 972n]);
            // And the from-`n` method, which the MINT path calls, never sets any of them.
            for (const n of [22n, 105n, 72n]) {
                const keys = flagKeys((await market.getScoreBreakdown(n)).flags);
                for (const k of ['smith', 'sphenic', 'powerful', 'achilles']) expect(keys).not.toContain(k);
            }
        }, 300_000);

        it('the weight table publishes the factor bits, and the factored sum recomputes from it', async () => {
            // §9.1: a price the reader cannot recompute is a price they have to
            // take on trust. The published table grew with the bits, so this is
            // block D's check run over the wider sum.
            const weights = await market.getScoreWeights();
            expect(weights.points).toHaveLength(SCORE_BITS.length);
            for (const b of SCORE_BITS) expect(weights.points[b.bit]).toBe(b.points);

            for (const n of [15n, 27n, 30n, 49n, 72n, 85n, 105n, 143n, 720n, 5040n, 65536n]) {
                const { score, flags } = await market.getScoreBreakdownFrom(n, factorize(n));
                expect(Math.min(recomputeFromFlags(n, flags), weights.SCORE_MAX)).toBe(score);
            }
        }, 120_000);

        it('the clamp is applied ONCE over the whole sum, factor points included', async () => {
            // The bug this exists to catch: clamping inside the from-`n` walk and
            // again after the factor points, which silently drops a factor
            // category for any number already at the ceiling.
            const at = await market.getScoreBreakdownFrom(2n, []);
            expect(at.score).toBe(SCORE_MAX);
            // 720720 = 2⁴·3²·5·7·11·13 — highly composite, and every factor bit
            // it earns has to survive the same single clamp.
            const big = await market.getScoreBreakdownFrom(720720n, factorize(720720n));
            expect(big.score).toBeLessThanOrEqual(SCORE_MAX);
            expect(big).toEqual(mirrorOf(720720n));
        }, 120_000);

        it('`getLotPriceFrom` quotes the ladder at the FACTORED score, never below `getLotPrice`', async () => {
            // NOT 30 or 210: both are primorials, which no lane sells and
            // `getLotPriceFrom` refuses for the same reason `getLotPrice` does.
            for (const n of [15n, 105n, 143n, 5040n, 65536n]) {
                const full = await market.getLotPriceFrom(n, factorize(n));
                const lower = await market.getLotPrice(n);
                expect(full.p0).toBe(expectedP0(full.score));
                expect(full.p0).toBeGreaterThanOrEqual(lower.p0);
                expect({ score: full.score, flags: full.flags }).toEqual(
                    await market.getScoreBreakdownFrom(n, factorize(n))
                );
            }
        }, 120_000);

        it('refuses the same two numbers the from-`n` methods refuse', async () => {
            // The guards are why this is a second method rather than a branch
            // inside the first: a primorial is still unsellable, and the D-11
            // cap still comes before Miller-Rabin.
            await expect(market.getLotPriceFrom(210n, factorize(210n))).rejects.toThrow(String(EXIT_PRIMORIAL));
            await expect(market.getScoreBreakdownFrom(AUCTIONABLE_MAX + 1n, [])).rejects.toThrow(
                String(EXIT_N_ABOVE_CAP)
            );
        });
    });

    // =======================================================================
    // I. EVERY CATEGORY, ONE BY ONE
    // =======================================================================
    //
    // Block A proves the Tolk and the TypeScript agree. It does NOT prove either
    // is right: two copies of one transcription slip agree perfectly, and the
    // score is now 54 categories deep in three byte-identical contracts. So this
    // block pins each category to a witness whose membership was decided OUTSIDE
    // this repo — an OEIS sequence, Korselt's criterion, a calendar, a record —
    // together with a NEAR MISS chosen to be one step away, because a predicate
    // that fires on everything passes a witness test and fails this one.
    //
    // Every row is asserted against the CHAIN, not the mirror. The DIGIT rows
    // carry one extra constraint: bits 0..5 are a max-of-six, so a witness there
    // must be a number whose own bit WINS — 10000 is a power of ten and has
    // three trailing zeros, and only the first of those is ever drawn.
    describe('I. all 54 categories fire on a witness and refuse a near miss', () => {
        const fe = (prime: bigint, exponent: number): FactorEntry => ({ prime, exponent, s: isqrt(prime) });
        const factorize = (n: bigint): FactorEntry[] => {
            const out: FactorEntry[] = [];
            let m = n;
            for (let p = 2n; p * p <= m; p++) {
                let e = 0;
                while (m % p === 0n) {
                    m /= p;
                    e++;
                }
                if (e > 0) out.push(fe(p, e));
            }
            if (m > 1n) out.push(fe(m, 1));
            return out;
        };
        const keysOf = async (n: bigint, factored: boolean) =>
            flagKeys(
                (factored
                    ? await market.getScoreBreakdownFrom(n, factorize(n))
                    : await market.getScoreBreakdown(n)
                ).flags
            );

        /**
         * `[key, a number that IS one, a number one step away that is NOT,
         *   whether the category needs the factorization]`.
         *
         * The eleven `true` rows are the ones `scoreOf(n)` cannot decide and
         * `scoreOfFrom(n, factors)` can — bits 33..38, N6's 39 and D-162's
         * 48..51. Every
         * other row is decided from `n` alone, which is also the statement that
         * it runs on the MINT path.
         */
        const ROWS: readonly (readonly [string, bigint, bigint, boolean])[] = [
            // ---- DIGIT (0..5). A max-of-six: each witness's own bit must WIN.
            ['repdigit', 1111n, 1112n, false],
            ['pow10', 10000n, 10001n, false], // beats its own three trailing zeros
            ['palindrome', 12321n, 12331n, false],
            ['run', 1234n, 1235n, false],
            ['abab', 1212n, 1213n, false],
            ['trailing_zeros', 1200n, 1201n, false],
            // ---- LIFE (6..10). The near misses are impossible dates, not other numbers.
            ['yyyymmdd', 19720909n, 19721332n, false], // month 13, day 32
            ['ddmmyyyy', 12072020n, 32072020n, false], // there is no 32nd
            ['year', 1972n, 1899n, false], // YEAR_LO is 1900
            ['yymmdd', 991231n, 991232n, false],
            ['mmdd', 1207n, 1299n, false],
            // ---- FORM, from `n` (11..28).
            ['mersenne', 8191n, 8189n, false],
            ['fermat', 257n, 259n, false],
            ['perfect', 496n, 497n, false],
            ['primorial', 2310n, 2311n, false],
            ['factorial', 720n, 721n, false],
            ['prime', 101n, 102n, false],
            ['pow2', 1024n, 1023n, false],
            ['fibonacci', 233n, 234n, false],
            ['cube', 1728n, 1727n, false],
            ['twin', 107n, 113n, false], // 113 is prime and neither 111 nor 115 is
            ['sophie_germain', 89n, 97n, false],
            ['safe_prime', 107n, 109n, false],
            ['emirp', 107n, 131n, false], // 131 is a PALINDROMIC prime, so not an emirp
            ['square', 1369n, 1370n, false],
            ['triangular', 1275n, 1276n, false],
            ['harshad', 1200n, 1201n, false],
            ['happy', 1339n, 1338n, false],
            ['digitsum_prime', 12n, 13n, false],
            // ---- CULTURE and POSITION (29..32).
            ['iconic', 420n, 421n, false],
            ['listed', 404n, 405n, false],
            ['landmark', 7919n, 7907n, false], // both prime; only one is the 1000th
            ['constant', 3141n, 3142n, false],
            // ---- FORM, from the factorization (33..38) — §4's phase 3.
            ['semiprime', 15n, 30n, true],
            ['prime_power', 27n, 15n, true],
            ['squarefree', 15n, 27n, true],
            ['smooth', 30n, 143n, true], // 143 = 11·13, past the bound of 7
            ['abundant', 30n, 15n, true],
            ['deficient', 15n, 30n, true],
            // ---- N6 (39..47). Each witness is a member of its OEIS sequence and
            // each near miss is its successor — the tightest refusal available.
            ['carmichael', 561n, 1730n, true], //        A002997
            ['pandigital', 1234567890n, 1123456789n, false], // the 1 twice, the 0 never
            ['narcissistic', 9474n, 9475n, false], //    A005188: 9⁴+4⁴+7⁴+4⁴
            ['automorphic', 9376n, 9377n, false], //     A003226: 9376² ends 9376
            ['square_triangular', 1225n, 1226n, false], // A001110: 35² and T₄₉ at once
            ['kaprekar', 2728n, 2729n, false], //        A006886: 2728² = 7441984, 744+1984
            ['highly_composite', 5040n, 5041n, false], // A002182: 5041 = 71², d(n) = 3
            ['keith', 197n, 198n, false], //             A007629: 1,9,7,17,33,57,107,197
            ['catalan', 429n, 430n, false], //           A000108: C₇
            // ---- D-162 (48..53).
            ['smith', 85n, 86n, true], //                A006753: 8+5 = 5+1+7; 86 = 2·43
            ['sphenic', 105n, 106n, true], //            3·5·7; 106 = 2·53
            ['powerful', 200n, 201n, true], //           A001694: 2³·5²; 201 = 3·67
            ['achilles', 72n, 36n, true], //             A052486: 2³·3²; 36 = 6² is a perfect power
            ['lucas', 843n, 844n, false], //             A000032: L₁₄
            ['pronic', 1332n, 1333n, false], //          A002378: 36·37
        ];

        it('covers every bit the weight table publishes, exactly once', () => {
            // The row list is hand-written, which is the point — but it must
            // still be COMPLETE, or a new category could ship with no witness
            // and this block would go on passing.
            expect([...ROWS].map((r) => r[0]).sort()).toEqual([...SCORE_BITS].map((b) => b.key).sort());
        });

        it.each(ROWS)(
            '%s: %s sets the bit, %s does not',
            async (key, witness, nearMiss, factored) => {
                expect(await keysOf(witness, factored)).toContain(key);
                expect(await keysOf(nearMiss, factored)).not.toContain(key);
            },
            120_000
        );

        it('every category recomputes from the published weights, on both sides of its row', async () => {
            // §9.1 per category rather than over a sweep. Both the witness and the
            // near miss are recomputed, so each of the 54 rows is checked twice
            // and a weight that drifted between the table and the contract fails
            // with the category's name rather than as a sweep diff.
            const drifted: string[] = [];
            for (const [key, witness, nearMiss, factored] of ROWS) {
                for (const n of [witness, nearMiss]) {
                    const q = factored
                        ? await market.getScoreBreakdownFrom(n, factorize(n))
                        : await market.getScoreBreakdown(n);
                    const recomputed = Math.min(recomputeFromFlags(n, q.flags), SCORE_MAX);
                    if (recomputed !== q.score) {
                        drifted.push(`${key} @ ${n}: chain says ${q.score}, the weight table sums to ${recomputed}`);
                    }
                }
            }
            expect(drifted).toEqual([]);
        }, 300_000);

        it('where a row moves exactly one bit, the score moves exactly that bit\'s points', async () => {
            // The sharper version of the check above, which most rows cannot
            // support: 1200 vs 1201 moves `harshad` and `trailing_zeros`
            // together, and asserting a hand-figure there would be a test
            // asserting its own arithmetic. So the rows that DO isolate a single
            // bit are the ones that get to make the strong claim, and the count
            // is asserted so this cannot quietly degrade into checking nothing.
            const drifted: string[] = [];
            let isolated = 0;
            for (const [key, witness, nearMiss, factored] of ROWS) {
                const q = async (n: bigint) =>
                    factored ? await market.getScoreBreakdownFrom(n, factorize(n)) : await market.getScoreBreakdown(n);
                const a = await q(witness);
                const b = await q(nearMiss);
                const bit = SCORE_BITS.find((x) => x.key === key)!.bit;
                if ((a.flags ^ b.flags) !== 1n << BigInt(bit)) continue;
                if (a.score >= SCORE_MAX || b.score >= SCORE_MAX) continue; // the clamp ate the difference
                isolated++;
                const expected = recomputeFromFlags(witness, a.flags) - recomputeFromFlags(nearMiss, b.flags);
                if (a.score - b.score !== expected) {
                    drifted.push(`${key}: the chain moved ${a.score - b.score}, the weight table says ${expected}`);
                }
            }
            expect(drifted).toEqual([]);
            expect(isolated).toBeGreaterThan(0);
        }, 300_000);

        it('N6 put eight of its nine on the MINT path, and that is the whole gas question', async () => {
            // A category decided from `n` alone is computed on EVERY mint route
            // (`scoreOfUnclamped`); a factor-derived one only where a verified
            // factorization is in hand. Since C15 (signed 2026-09-24) the head
            // mint's rebate leg is one of those — it calls `scoreOfFrom(n,
            // factors)` — so both halves are on the head-mint path now. N6's
            // brief assumed two of the nine were factor-side; it is one. This is
            // that classification pinned.
            expect(await keysOf(5040n, false)).toContain('highly_composite'); // a table on `n`
            const n6 = SCORE_BITS.filter((b) => b.bit >= 39 && b.bit <= 47).map((b) => b.key);
            expect(n6).toHaveLength(9);
            const n6Keys = new Set<string>(n6);
            expect(ROWS.filter((r) => r[3] && n6Keys.has(r[0])).map((r) => r[0])).toEqual(['carmichael']);
        }, 120_000);

        it('D-162 put two of its six on the MINT path, and both reuse a root the walk already took', () => {
            const d157 = new Set<string>(SCORE_BITS.filter((b) => b.bit >= 48).map((b) => b.key));
            expect(d157.size).toBe(6);
            expect(ROWS.filter((r) => !r[3] && d157.has(r[0])).map((r) => r[0])).toEqual(['lucas', 'pronic']);
        });
    });
});

// ===========================================================================
// F. THE VAULT'S TWO-ENTRY REBATE SCHEDULE (§8 acceptance check 6)
// ===========================================================================
//
// §1.5's rebate is NOT the ratchet's rebate. The ratchet emits `k(t)` times the
// injected residual on every head mint and nothing in D-99 touches it. This is
// the other one: the one-time bonus the bounty vault's `puzzles` track pays the
// first owner of a special number, and D-99 collapses the vault's three-entry
// tier schedule (`discount` / `free` / `bonus`) to exactly two KINDS:
//
//   kind 0  REBATE_COMPOSITE_PER_POINT — a HEAD-MINTED composite, per point of
//           D(n). An auction win pays none; the premium is the price of
//           impatience. A number with no category earns nothing at all.
//   kind 1  REBATE_PRIME_FAMILY — a prime of D-96's family, FLAT, any route.
//
// The trust shape is unchanged from `pay_era_bounty` (D22) and is what most of
// these assertions are about: only the ledger may ask, a lying `(t, s)` cannot
// drain past the genesis-fixed cap, and a retry cannot double-pay.

const T_AT_GENESIS = toNano('200');
const S_AT_GENESIS = 4_000_000n * 1_000_000_000n;
const GENESIS_PRIMES_PER_TON = S_AT_GENESIS / T_AT_GENESIS;

/** What the vault pays: `min(bountyTon · S/T, maxPrimes)`, both terms × points on kind 0. */
const payout = (bountyTon: bigint, cap: bigint, mult: bigint, t = T_AT_GENESIS, s = S_AT_GENESIS) => {
    if (t <= 0n) return cap * mult;
    const raw = (bountyTon * mult * s) / t;
    return raw > cap * mult ? cap * mult : raw;
};

// ---------------------------------------------------------------------------
// PHASE 4'S SIM RUN OWNS THE REAL VALUES. `shared/params.json` carries no D-99
// rebate block yet — `sim/scripts/run_phase1.py`'s `special_numbers_report()`
// is re-pointed in phase 4 (§6) and will size both rates against the new score
// distribution so the projection lands at 50% of the `puzzles` track. These are
// the plan's SIGNED TARGETS, used here as test constants and labelled as such:
// they set the shape of the arithmetic this file asserts, not the deployed
// figures. When the params block lands, import it and delete these.
// ---------------------------------------------------------------------------
/** Owner answer 16: 0.005 GRAM of PRIMES per point of D(n). */
const REBATE_PER_POINT_TON = toNano('0.005');
/** §1.5: the flat family figure, today's `free` tier value pending the re-size. */
const REBATE_PRIME_FAMILY_TON = toNano('0.132');

const rebateEntry = (kind: number, bountyTon: bigint): RebateScheduleEntry => ({
    tier: kind, // the dictionary key is still called `tier`; the VALUE is a kind
    bountyTon,
    maxPrimes: bountyTon * GENESIS_PRIMES_PER_TON,
});

const REBATE_SCHEDULE: RebateScheduleEntry[] = [
    rebateEntry(REBATE_KIND.COMPOSITE_PER_POINT, REBATE_PER_POINT_TON),
    rebateEntry(REBATE_KIND.PRIME_FAMILY, REBATE_PRIME_FAMILY_TON),
];

describe('F. §8 check 6 — the bounty vault pays two rebate kinds and no tiers', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let ledgerStandIn: SandboxContract<TreasuryContract>;
    let winner: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;

    let walletCode: Cell;
    let masterCode: Cell;
    let vaultCode: Cell;

    let master: SandboxContract<PrimesJettonMaster>;
    let vault: SandboxContract<PrimesBountyVault>;

    /** The winner's PRIMES balance — the only thing that proves a payout landed. */
    const winnerBalance = async () => {
        const addr = await master.getWalletAddress(winner.address);
        return (await blockchain.openContract(PrimesJettonWallet.createFromAddress(addr)).getWalletData()).balance;
    };

    beforeAll(async () => {
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        vaultCode = await compile('PrimesBountyVault');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        ledgerStandIn = await blockchain.treasury('ledger');
        winner = await blockchain.treasury('winner');
        attacker = await blockchain.treasury('attacker');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        vault = blockchain.openContract(
            PrimesBountyVault.createFromConfig(
                {
                    schedule: [],
                    ledgerAddr: ledgerStandIn.address,
                    jettonMasterAddr: master.address,
                    genesisScriptAddr: genesisScript.address,
                    fundedPrimes: 1_327_374_997_252_625n, // V26.7 — the genesis mint below
                    allowlist: [],
                    rebateSchedule: REBATE_SCHEDULE,
                },
                vaultCode
            )
        );
        await vault.sendDeploy(deployer.getSender(), toNano('2'));

        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vault.address,
            amount: 1_327_374_997_252_625n,
            value: toNano('0.2'),
        });
        const vaultWalletAddr = await master.getWalletAddress(vault.address);
        await vault.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: vaultWalletAddr,
            value: toNano('0.05'),
        });
    });

    const payRebate = (opts: { n: bigint; kind: number; points: number; t?: bigint; s?: bigint; from?: 'ledger' | 'attacker' }) =>
        vault.sendPaySpecialNumberRebate((opts.from === 'attacker' ? attacker : ledgerStandIn).getSender(), {
            n: opts.n,
            kind: opts.kind,
            points: opts.points,
            beneficiary: opts.from === 'attacker' ? attacker.address : winner.address,
            t: opts.t ?? T_AT_GENESIS,
            s: opts.s ?? S_AT_GENESIS,
            value: toNano('0.1'),
        });

    it('publishes the two-entry schedule per §9.1, and nothing else is scheduled', async () => {
        const perPoint = await vault.getRebateSchedule(REBATE_KIND.COMPOSITE_PER_POINT, 1729n);
        expect(perPoint.scheduled).toBe(1);
        expect(perPoint.bountyTon).toBe(REBATE_PER_POINT_TON);
        expect(perPoint.maxPrimes).toBe(REBATE_SCHEDULE[0].maxPrimes);
        expect(perPoint.paid).toBe(0);

        const family = await vault.getRebateSchedule(REBATE_KIND.PRIME_FAMILY, 100_193n);
        expect(family.scheduled).toBe(1);
        expect(family.bountyTon).toBe(REBATE_PRIME_FAMILY_TON);

        // EXACTLY TWO. The three tier keys are gone with the tiers; a third
        // scheduled kind would mean the deleted model grew back.
        for (const kind of [2, 3, 9, 255]) {
            expect((await vault.getRebateSchedule(kind, 1729n)).scheduled).toBe(0);
        }
    });

    it('kind 0 pays PER POINT — the payout scales linearly with D(n)', async () => {
        // The claim §1.5 makes in money: 3% back on a plain composite, 25% on a
        // 50-point number, one rate. Three different numbers because the vault
        // is idempotent per `n`, not per points.
        const unit = payout(REBATE_PER_POINT_TON, REBATE_SCHEDULE[0].maxPrimes, 1n);
        let running = 0n;
        for (const [n, points] of [[1111n, 50], [123_456n, 6], [42n, 46]] as const) {
            const before = running;
            await payRebate({ n, kind: REBATE_KIND.COMPOSITE_PER_POINT, points });
            running = await winnerBalance();
            expect(running - before).toBe(unit * BigInt(points));
        }
        // Linear, not merely increasing: 50 points is exactly 50 units.
        expect(running).toBe(unit * BigInt(50 + 6 + 46));
    });

    it('kind 0 with zero points pays NOTHING and does not mark `n` paid', async () => {
        // "A number with no category earns no rebate" — the rebate is a function
        // of what the number IS. Not marking `n` paid matters: a number that
        // scored zero at mint time must not be permanently burned out of the
        // schedule by a payout that never happened.
        const result = await payRebate({ n: 1729n, kind: REBATE_KIND.COMPOSITE_PER_POINT, points: 0 });
        const cfg = await vault.getVaultConfig();
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: true });
        expect(result.transactions).not.toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr });
        const payouts = await vault.getVaultPayouts();
        expect(payouts.payoutCount).toBe(0);
        expect(payouts.paidTotalPrimes).toBe(0n);
        expect((await vault.getRebateSchedule(REBATE_KIND.COMPOSITE_PER_POINT, 1729n)).paid).toBe(0);
    });

    // H12 / DECISIONS.md D-129. The special-number half of the balance guard.
    // Below `TRANSFER_GAS + STORAGE_FLOOR` the jetton hop's ACTION phase fails
    // with result 37 and reverts everything, while the mint that triggered it
    // survives (the ledger's leg is `BounceMode.NoBounce`) — so a one-shot
    // rebate was silently and permanently forfeit. It is now journalled without
    // being sent. This arm has one extra thing to get right that the era arm
    // does not: `paidSpecials` lives in a nested cell re-packed on BOTH paths,
    // and only the affordable one may set the flag.
    it('H12: a rebate the vault cannot afford defers with its flag CLEAR, and a retry pays it', async () => {
        const vaultAcct = await blockchain.getContract(vault.address);
        vaultAcct.balance = toNano('0.05');

        const cfg = await vault.getVaultConfig();
        const short = await vault.sendPaySpecialNumberRebate(ledgerStandIn.getSender(), {
            n: 100_193n,
            kind: REBATE_KIND.PRIME_FAMILY,
            points: 0,
            beneficiary: winner.address,
            t: T_AT_GENESIS,
            s: S_AT_GENESIS,
            value: toNano('0.015'),      // primes_ledger.tolk's own leg
        });
        expect(short.transactions).toHaveTransaction({ to: vault.address, success: true });
        expect(short.transactions).not.toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr });
        expect((await vault.getRebateSchedule(REBATE_KIND.PRIME_FAMILY, 100_193n)).paid).toBe(0);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(0);
        // The winner's jetton wallet was never even deployed — `winnerBalance()`
        // cannot be asked, which is itself the proof nothing left.
        const deferred = await vault.getDeferredPayouts();
        expect(deferred.deferredCount).toBe(1);
        expect(deferred.journalKey).toBe(1);

        vaultAcct.balance = toNano('2');
        await vault.sendRetryBountyPayout(attacker.getSender(), { queryID: 0, value: toNano('0.15') });
        expect(await winnerBalance()).toBe(payout(REBATE_PRIME_FAMILY_TON, REBATE_SCHEDULE[1].maxPrimes, 1n));
        expect((await vault.getRebateSchedule(REBATE_KIND.PRIME_FAMILY, 100_193n)).paid).toBe(1);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(1);
        expect((await vault.getDeferredPayouts()).deferredCount).toBe(0);
    });

    it('kind 1 is FLAT — `points` is ignored entirely', async () => {
        // A prime of the family is paid for BEING in the family, whatever it
        // scores and whichever route minted it, so the ledger's `points` field
        // must not reach the arithmetic on this kind.
        await payRebate({ n: 100_193n, kind: REBATE_KIND.PRIME_FAMILY, points: 0 });
        const afterZeroPoints = await winnerBalance();
        const flat = payout(REBATE_PRIME_FAMILY_TON, REBATE_SCHEDULE[1].maxPrimes, 1n);
        expect(afterZeroPoints).toBe(flat);

        await payRebate({ n: 100_501n, kind: REBATE_KIND.PRIME_FAMILY, points: 65_535 });
        expect((await winnerBalance()) - afterZeroPoints).toBe(flat);
    });

    it('is idempotent per `n`, across both kinds', async () => {
        // The retry path (D-53/B12.1) replays a genuinely-bounced payout, so a
        // repeat of the ORIGINAL message must be a no-op — and `paidSpecials` is
        // keyed by `n` alone, so a second kind cannot be used to pay twice for
        // the same number either.
        await payRebate({ n: 1729n, kind: REBATE_KIND.COMPOSITE_PER_POINT, points: 60 });
        const afterFirst = await winnerBalance();
        expect(afterFirst).toBeGreaterThan(0n);

        await payRebate({ n: 1729n, kind: REBATE_KIND.COMPOSITE_PER_POINT, points: 60 });
        expect(await winnerBalance()).toBe(afterFirst);

        await payRebate({ n: 1729n, kind: REBATE_KIND.PRIME_FAMILY, points: 0 });
        expect(await winnerBalance()).toBe(afterFirst);
        expect((await vault.getVaultPayouts()).payoutCount).toBe(1);
    });

    it('CANNOT be drained by a lying (T, S): the cap is `points × maxPrimes`', async () => {
        // D22's property, now with a multiplier on it — which is the new risk
        // surface: `points` is a uint16, so a compromised ledger could ask for
        // 65,535 points, and the cap must scale with the same multiplier the
        // bounty does rather than being a fixed ceiling the multiplier escapes.
        await payRebate({
            n: 1729n,
            kind: REBATE_KIND.COMPOSITE_PER_POINT,
            points: 40,
            t: 1n,
            s: S_AT_GENESIS * 1_000_000n,
        });
        expect(await winnerBalance()).toBe(REBATE_SCHEDULE[0].maxPrimes * 40n);
    });

    it('rejects a rebate from anyone but the ledger', async () => {
        const result = await payRebate({ n: 1729n, kind: REBATE_KIND.COMPOSITE_PER_POINT, points: 40, from: 'attacker' });
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: 100 });
    });

    it('ignores an unrecognised kind without unwinding the caller', async () => {
        // Cheap-fail, not throw: an unexpected value must never unwind a MINT.
        // The old third tier (2 = `bonus`) is exactly such a value now, which is
        // why it is the one tested — a stale ledger sending the retired tier
        // must be a no-op, not a reverted mint.
        const result = await payRebate({ n: 1729n, kind: 2, points: 40 });
        const cfg = await vault.getVaultConfig();
        expect(result.transactions).toHaveTransaction({ to: vault.address, success: true });
        expect(result.transactions).not.toHaveTransaction({ from: vault.address, to: cfg.jettonWalletAddr });
        expect((await vault.getVaultPayouts()).payoutCount).toBe(0);
    });

    it('§3.3/§11.21: rebate payouts count toward the same paidTotal/payoutCount as era bounties', async () => {
        // One emission counter, never netted and never split by reason — §3.3's
        // `S` is cumulative emission plus the genesis vault and is never
        // decremented, so a payout route that kept its own private total would
        // put the supply block's arithmetic out by exactly that amount.
        await payRebate({ n: 1729n, kind: REBATE_KIND.COMPOSITE_PER_POINT, points: 60 });
        await payRebate({ n: 100_193n, kind: REBATE_KIND.PRIME_FAMILY, points: 0 });
        const payouts = await vault.getVaultPayouts();
        expect(payouts.payoutCount).toBe(2);
        expect(payouts.paidTotalPrimes).toBe(
            payout(REBATE_PER_POINT_TON, REBATE_SCHEDULE[0].maxPrimes, 60n) +
                payout(REBATE_PRIME_FAMILY_TON, REBATE_SCHEDULE[1].maxPrimes, 1n)
        );
        expect(payouts.paidTotalPrimes).toBe(await winnerBalance());
    });
});
