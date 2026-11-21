/**
 * D-99 — the score, in TypeScript.
 *
 * Spec: PRICING_MODEL_PLAN.md §1.1/§1.3, CONCEPT.md §9.6, DECISIONS.md D-99.
 *
 * THIS IS A MIRROR, NOT AN AUTHORITY. `contracts/contracts/score_block.tolk.inc`
 * is the authority — it is what actually prices a lot and what actually sizes
 * the vault rebate. This file exists for two jobs and no others:
 *
 *   1. `SpecialNumbers.spec.ts` asserts the deployed contract agrees with it
 *      over a dense sweep of `n`. That is the point: two independent
 *      implementations of the same rule, one of which a human can read at a
 *      glance, is how a transcription slip in 400 lines of Tolk gets caught.
 *   2. The webapp's date finder and its "chain says / local says" check
 *      (§8.1) preview a score before a chain read lands.
 *
 * An orb NEVER draws a satellite from this file's answer — it draws from
 * `getLotPrice(n).flags`, and CLAUDE.md's honesty rule is why. A local mirror
 * that has drifted must show as a disagreement, never as a picture.
 */

export const SCORE_MAX = 87;
export const LEN_REF = 9;
export const LEN_W = 2;
export const TZ_CAP = 3;
export const YEAR_LO = 1900;
export const YEAR_HI = 2100;

/** Bit numbers are permanent identifiers — see `SCORE_BITS` in `opcodes.ts`. */
export const BIT = {
  REPDIGIT: 0,
  POW10: 1,
  PALINDROME: 2,
  RUN: 3,
  ABAB: 4,
  TRAILING_ZEROS: 5,
  YYYYMMDD: 6,
  DMY8: 7,
  YEAR: 8,
  YYMMDD: 9,
  MMDD: 10,
  MERSENNE: 11,
  FERMAT: 12,
  PERFECT: 13,
  PRIMORIAL: 14,
  FACTORIAL: 15,
  PRIME: 16,
  POW2: 17,
  FIBONACCI: 18,
  CUBE: 19,
  TWIN: 20,
  SOPHIE_GERMAIN: 21,
  SAFE_PRIME: 22,
  EMIRP: 23,
  SQUARE: 24,
  TRIANGULAR: 25,
  HARSHAD: 26,
  HAPPY: 27,
  DIGITSUM_PRIME: 28,
  ICONIC: 29,
  LISTED: 30,
  LANDMARK: 31,
  CONSTANT: 32,
  // Phase 3 (PRICING_MODEL_PLAN.md §4) — set only by `scoreOfFrom`.
  SEMIPRIME: 33,
  PRIME_POWER: 34,
  SQUAREFREE: 35,
  SMOOTH: 36,
  ABUNDANT: 37,
  DEFICIENT: 38,
  // N6 — the last nine. Only CARMICHAEL is set by `scoreOfFrom`; the other
  // eight are decided from `n` alone.
  CARMICHAEL: 39,
  PANDIGITAL: 40,
  NARCISSISTIC: 41,
  AUTOMORPHIC: 42,
  SQUARE_TRIANGULAR: 43,
  KAPREKAR: 44,
  HIGHLY_COMPOSITE: 45,
  KEITH: 46,
  CATALAN: 47,
  // D-162. 48..51 are set by `scoreOfFrom` only; 52/53 from `n`.
  SMITH: 48,
  SPHENIC: 49,
  POWERFUL: 50,
  ACHILLES: 51,
  LUCAS: 52,
  PRONIC: 53,
} as const;

/** Weights, in bit order. Position `i` is bit `i`. */
export const POINTS: readonly number[] = [
  40, 40, 25, 25, 12, 8, // DIGIT (bit 5 is PER trailing zero)
  30, 25, 25, 12, 5, // LIFE
  40, 40, 40, 30, 25, 15, 15, 15, 8, 6, 6, 6, 5, 4, 2, 2, 2, 2, // FORM
  30, 20, // CULTURE
  30, 20, // POSITION
  3, 5, 2, 3, 1, 1, // FACTOR (bits 33..38) — §4, from a submitted factorization
  30, // 39 carmichael — the one N6 bit that needs the factorization
  40, 30, 25, 25, 20, 20, 20, 15, // 40..47 — N6, decided from `n` alone
  3, 2, 4, 6, // 48..51 — D-162 smith, sphenic, powerful, achilles (factorization)
  15, 3, // 52, 53 — D-162 lucas, pronic (from `n`)
];

/** §4's smoothness bound: every prime factor ≤ 7. */
export const SMOOTH_BOUND = 7n;

// ---------------------------------------------------------------------------
// Integer helpers. Everything is `bigint` because `n` runs to AUCTIONABLE_MAX
// (4.29·10¹³) and the Fibonacci test squares it.
// ---------------------------------------------------------------------------

function isqrt(x: bigint): bigint {
  if (x < 2n) return x < 0n ? -1n : x;
  let r = x;
  let g = 1n;
  for (let t = x; t > 0n; t >>= 2n) g <<= 1n;
  r = g;
  for (;;) {
    const nr = (r + x / r) >> 1n;
    if (nr >= r) return r;
    r = nr;
  }
}

const isSquare = (x: bigint) => x >= 0n && isqrt(x) ** 2n === x;

// ---------------------------------------------------------------------------
// N6's predicates. Mirrors of `score_block.tolk.inc`'s, same early exits.
// ---------------------------------------------------------------------------

/** Σ dᵈ === n. Bails the moment the running sum passes `n`. */
function isNarcissistic(n: bigint, d: number): boolean {
  if (d < 2) return false;
  let s = 0n;
  for (let t = n; t > 0n; t /= 10n) {
    s += (t % 10n) ** BigInt(d);
    if (s > n) return false;
  }
  return s === n;
}

/**
 * Keith: the `d`-term recurrence seeded by the digits of `n`, reaching `n`
 * exactly. Terms ascend, so overshooting is a proof of failure; the 200-step
 * cap is the contract's and is never reached below AUCTIONABLE_MAX.
 */
function isKeith(n: bigint, d: number, digitSum: number): boolean {
  if (d < 2) return false;
  const w: bigint[] = [];
  for (let t = n; t > 0n; t /= 10n) w.push(t % 10n);
  let pos = d - 1; // the oldest term: the leading digit
  let sum = BigInt(digitSum);
  for (let steps = 0; steps < 200; steps++) {
    if (sum === n) return true;
    if (sum > n) return false;
    const next = sum;
    sum = sum - w[pos] + next;
    w[pos] = next;
    pos = pos === 0 ? d - 1 : pos - 1;
  }
  return false;
}

/** The Catalan numbers to AUCTIONABLE_MAX (4.29·10¹³). */
const CATALAN = new Set<bigint>([
  2n, 5n, 14n, 42n, 132n, 429n, 1430n, 4862n, 16796n, 58786n, 208012n, 742900n, 2674440n,
  9694845n, 35357670n, 129644790n, 477638700n, 1767263190n, 6564120420n, 24466267020n,
  91482563640n, 343059613650n, 1289904147324n, 4861946401452n, 18367353072152n,
]);

/**
 * The highly composite numbers to AUCTIONABLE_MAX: `d(n)` strictly beats every
 * smaller `n`. A record is only testable as a table; this is the complete one
 * (Ramanujan's sequence, OEIS A002182, truncated at the cap).
 */
const HIGHLY_COMPOSITE = new Set<bigint>([
  2n, 4n, 6n, 12n, 24n, 36n, 48n, 60n, 120n, 180n, 240n, 360n, 720n, 840n, 1260n, 1680n,
  2520n, 5040n, 7560n, 10080n, 15120n, 20160n, 25200n, 27720n, 45360n, 50400n, 55440n, 83160n,
  110880n, 166320n, 221760n, 277200n, 332640n, 498960n, 554400n, 665280n, 720720n, 1081080n,
  1441440n, 2162160n, 2882880n, 3603600n, 4324320n, 6486480n, 7207200n, 8648640n, 10810800n,
  14414400n, 17297280n, 21621600n, 32432400n, 36756720n, 43243200n, 61261200n, 73513440n,
  110270160n, 122522400n, 147026880n, 183783600n, 245044800n, 294053760n, 367567200n,
  551350800n, 698377680n, 735134400n, 1102701600n, 1396755360n, 2095133040n, 2205403200n,
  2327925600n, 2793510720n, 3491888400n, 4655851200n, 5587021440n, 6983776800n, 10475665200n,
  13967553600n, 20951330400n, 27935107200n, 41902660800n, 48886437600n, 64250746560n,
  73329656400n, 80313433200n, 97772875200n, 128501493120n, 146659312800n, 160626866400n,
  240940299600n, 293318625600n, 321253732800n, 481880599200n, 642507465600n, 963761198400n,
  1124388064800n, 1606268664000n, 1686582097200n, 1927522396800n, 2248776129600n,
  3212537328000n, 3373164194400n, 4497552259200n, 6746328388800n, 8995104518400n,
  9316358251200n, 13492656777600n, 18632716502400n, 26985313555200n, 27949074753600n,
  32607253879200n,
]);

function isCube(x: bigint): boolean {
  if (x < 1n) return false;
  if (x < 8n) return x === 1n;
  let r = 1n;
  for (let t = x; t > 0n; t >>= 3n) r <<= 1n;
  for (;;) {
    const nr = (2n * r + x / (r * r)) / 3n;
    if (nr >= r) break;
    r = nr;
  }
  for (let c = r - 1n; c <= r + 1n; c++) if (c > 0n && c * c * c === x) return true;
  return false;
}

/**
 * The same 13 deterministic bases the contract uses (CONCEPT.md §3.1), exact
 * for n < 3.317·10²⁴ — three orders past anything this game can sell.
 */
export function isPrimeMR(n: bigint): boolean {
  if (n < 2n) return false;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n]) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let r = 0n;
  while (d % 2n === 0n) {
    d /= 2n;
    r++;
  }
  const modpow = (b: bigint, e: bigint, m: bigint) => {
    let acc = 1n;
    let base = b % m;
    for (let ex = e; ex > 0n; ex >>= 1n) {
      if (ex & 1n) acc = (acc * base) % m;
      base = (base * base) % m;
    }
    return acc;
  };
  for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n]) {
    if (a >= n) return true;
    let x = modpow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let witness = true;
    for (let i = 0n; i < r - 1n; i++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        witness = false;
        break;
      }
    }
    if (witness) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Calendar. Real Gregorian validity, 4/100/400 — a birthday that never
// happened must not be priced as one (owner answer 11).
// ---------------------------------------------------------------------------

function daysInMonth(y: number, m: number): number {
  if ([1, 3, 5, 7, 8, 10, 12].includes(m)) return 31;
  if ([4, 6, 9, 11].includes(m)) return 30;
  if (m !== 2) return 0;
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
}

const isValidDate = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);

// ---------------------------------------------------------------------------
// Tables. Every one of these is complete for `n <= AUCTIONABLE_MAX`, not
// truncated — see the contract's comments for why each list ends where it does.
// ---------------------------------------------------------------------------

const FERMAT_PRIMES = new Set([3n, 5n, 17n, 257n, 65537n]);
const PERFECT = new Set([6n, 28n, 496n, 8128n, 33550336n, 8589869056n, 137438691328n]);
export const PRIMORIALS = [6n, 30n, 210n, 2310n, 30030n, 510510n, 9699690n, 223092870n];
const FACTORIALS = new Set([
  1n, 2n, 6n, 24n, 120n, 720n, 5040n, 40320n, 362880n, 3628800n, 39916800n, 479001600n,
  6227020800n, 87178291200n, 1307674368000n, 20922789888000n,
]);
/** §3.1, owner-signed. Recognised without explanation, or it is not culture. */
const ICONIC = new Set([2n, 42n, 69n, 420n, 666n, 777n, 1337n, 1729n, 8008n]);
const LISTED = new Set([
  7n, 13n, 23n, 47n, 88n, 99n, 101n, 108n, 404n, 418n, 451n, 495n, 911n, 1234n, 1984n,
  2001n, 2049n, 4096n, 6174n, 8086n, 9000n, 9001n, 24601n, 31337n, 65536n, 80085n,
  90210n, 142857n, 5318008n, 8675309n,
]);
const CONSTANTS = new Set([
  3141n, 31415n, 314159n, 2718n, 27182n, 271828n, 1618n, 16180n, 161803n,
  1414n, 14142n, 141421n, 1729n,
]);

/**
 * §3.2 — the primes whose interest is their POSITION on the line rather than
 * their shape: the guard of a power of ten, the millionth prime, the last
 * prime before an era boundary. GENERATED by `sim/scripts/landmark_primes.py`,
 * which is the provenance of every entry and records per entry whether it was
 * established by sieve or by scan (`shared/landmark_primes.json`). Do not
 * hand-edit — re-run the script.
 */
// LANDMARK TABLE BEGIN
export const LANDMARK_PRIMES: ReadonlySet<bigint> = new Set<bigint>([
  5n, 7n, 11n, 29n, 97n, 101n,
  199n, 541n, 997n, 1009n, 2309n, 7919n,
  9973n, 10007n, 30029n, 99991n, 100003n, 104729n,
  510481n, 999983n, 1000003n, 1299709n, 9699667n, 9999991n,
  10000019n, 15485863n, 99999989n, 100000007n, 179424673n, 223092827n,
  999999937n, 1000000007n, 2038074743n, 9999999967n, 10000000019n, 99999999977n,
  100000000003n, 999999999989n, 1000000000039n, 9999999999971n, 10000000000037n, 99999999999973n,
  100000000000031n,
]);
// LANDMARK TABLE END

function isHappy(n: bigint): boolean {
  let x = n;
  for (let i = 0; i < 100; i++) {
    if (x === 1n) return true;
    if (x === 4n) return false;
    let s = 0n;
    for (let t = x; t > 0n; t /= 10n) {
      const d = t % 10n;
      s += d * d;
    }
    x = s;
  }
  return false;
}

export interface Score {
  /** The clamped sum. This is what prices the lot. */
  score: number;
  /** The category bitmask. NOT clamped — see the contract's closing comment. */
  flags: bigint;
}

/** The set bit numbers of a flags word, ascending. */
export function bitsOf(flags: bigint): number[] {
  const out: number[] = [];
  for (let b = 0; b < POINTS.length; b++) if ((flags >> BigInt(b)) & 1n) out.push(b);
  return out;
}

/**
 * D(n) and its categories. Byte-for-byte the same rule as
 * `score_block.tolk.inc`'s `scoreOf` — if these two ever disagree,
 * `SpecialNumbers.spec.ts` fails, and the Tolk is right.
 */
function unclampedScoreOf(n: bigint): Score {
  if (n <= 0n) return { score: 0, flags: 0n };

  const ds: number[] = []; // most-significant first
  for (let t = n; t > 0n; t /= 10n) ds.unshift(Number(t % 10n));
  const d = ds.length;
  let tz = 0;
  while (tz < d && ds[d - 1 - tz] === 0) tz++;
  const digitSum = ds.reduce((a, b) => a + b, 0);
  const rev = BigInt([...ds].reverse().join(''));

  let flags = 0n;
  let score = 0;
  const set = (bit: number, pts: number) => {
    flags |= 1n << BigInt(bit);
    score += pts;
  };

  // LEN — continuous, so no bit and no satellite: a scale is not a category.
  if (d < LEN_REF) score += LEN_W * (LEN_REF - d);

  // DIGIT — MAX of six, never a sum. 1111 is a repdigit AND a palindrome AND an
  // abab; summing them compounds one visual property and makes the clamp do all
  // the work. Exactly one bit is set: the best reason, once. Ties go low.
  const allSame = d >= 2 && ds.every((x) => x === ds[0]);
  const pali = d >= 2 && ds.join('') === [...ds].reverse().join('');
  const ascending = d >= 3 && ds.every((x, i) => i === 0 || x === ds[i - 1] + 1);
  const descending = d >= 3 && ds.every((x, i) => i === 0 || x === ds[i - 1] - 1);
  const abab = d >= 4 && d % 2 === 0 && ds.every((x, i) => i < 2 || x === ds[i - 2]);
  const aabb = d === 4 && ds[0] === ds[1] && ds[2] === ds[3] && ds[0] !== ds[2];
  const tzCapped = Math.min(tz, TZ_CAP);

  const candidates: [number, number][] = [];
  if (allSame) candidates.push([BIT.REPDIGIT, POINTS[BIT.REPDIGIT]]);
  if (d >= 2 && ds[0] === 1 && tz === d - 1) candidates.push([BIT.POW10, POINTS[BIT.POW10]]);
  if (pali) candidates.push([BIT.PALINDROME, POINTS[BIT.PALINDROME]]);
  if (ascending || descending) candidates.push([BIT.RUN, POINTS[BIT.RUN]]);
  if (abab || aabb) candidates.push([BIT.ABAB, POINTS[BIT.ABAB]]);
  if (tzCapped > 0) candidates.push([BIT.TRAILING_ZEROS, POINTS[BIT.TRAILING_ZEROS] * tzCapped]);
  if (candidates.length) {
    let best = candidates[0];
    for (const c of candidates) if (c[1] > best[1]) best = c;
    set(best[0], best[1]);
  }

  // LIFE. At most one 8-digit form matches: a YYYYMMDD in 1900..2100 read as
  // DDMMYYYY has a month of 19/20/21 and fails, and the converse fails the same
  // way. An integer carries no leading zero, so having 8 digits already
  // guarantees the leading field is >= 10 — the date finder is what tells a
  // buyer which of their date's forms are unrepresentable.
  const num = Number(n);
  if (d === 8) {
    const y8 = Math.floor(num / 10000);
    const md = num % 10000;
    if (y8 >= YEAR_LO && y8 <= YEAR_HI && isValidDate(y8, Math.floor(md / 100), md % 100)) {
      set(BIT.YYYYMMDD, POINTS[BIT.YYYYMMDD]);
    } else {
      const yTail = num % 10000;
      const f1 = Math.floor(num / 1000000);
      const f2 = Math.floor(num / 10000) % 100;
      if (yTail >= YEAR_LO && yTail <= YEAR_HI && (isValidDate(yTail, f2, f1) || isValidDate(yTail, f1, f2))) {
        set(BIT.DMY8, POINTS[BIT.DMY8]);
      }
    }
  }
  // YYMMDD carries no century, so the leap day is accepted — the form cannot
  // say which century it means. Validated against 2000 for exactly that reason.
  if (d === 6 && isValidDate(2000, Math.floor(num / 100) % 100, num % 100)) {
    set(BIT.YYMMDD, POINTS[BIT.YYMMDD]);
  }
  if (d === 4) {
    if (num >= YEAR_LO && num <= YEAR_HI) set(BIT.YEAR, POINTS[BIT.YEAR]);
    const p1 = Math.floor(num / 100);
    const p2 = num % 100;
    if (isValidDate(2000, p1, p2) || isValidDate(2000, p2, p1)) set(BIT.MMDD, POINTS[BIT.MMDD]);
  }

  // FORM — sums. One Miller-Rabin pass for a composite; five more only inside
  // the prime branch.
  const prime = isPrimeMR(n);
  if (prime) {
    set(BIT.PRIME, POINTS[BIT.PRIME]);
    if (n >= 3n && ((n + 1n) & n) === 0n) set(BIT.MERSENNE, POINTS[BIT.MERSENNE]);
    if (FERMAT_PRIMES.has(n)) set(BIT.FERMAT, POINTS[BIT.FERMAT]);
    if (isPrimeMR(n - 2n) || isPrimeMR(n + 2n)) set(BIT.TWIN, POINTS[BIT.TWIN]);
    if (isPrimeMR(2n * n + 1n)) set(BIT.SOPHIE_GERMAIN, POINTS[BIT.SOPHIE_GERMAIN]);
    if (n > 2n && (n - 1n) % 2n === 0n && isPrimeMR((n - 1n) / 2n)) set(BIT.SAFE_PRIME, POINTS[BIT.SAFE_PRIME]);
    // "a DIFFERENT prime" — a palindromic prime already wears BIT.PALINDROME.
    if (rev !== n && isPrimeMR(rev)) set(BIT.EMIRP, POINTS[BIT.EMIRP]);
  }
  if (PERFECT.has(n)) set(BIT.PERFECT, POINTS[BIT.PERFECT]);
  if (PRIMORIALS.includes(n)) set(BIT.PRIMORIAL, POINTS[BIT.PRIMORIAL]);
  if (FACTORIALS.has(n)) set(BIT.FACTORIAL, POINTS[BIT.FACTORIAL]);
  if (n >= 2n && (n & (n - 1n)) === 0n) set(BIT.POW2, POINTS[BIT.POW2]);
  // The four-root definitions, not the contract's one-root window: two
  // implementations of one rule is what makes the sweep in SpecialNumbers.spec.ts
  // worth running.
  if (isSquare(5n * n * n + 4n) || isSquare(5n * n * n - 4n)) set(BIT.FIBONACCI, POINTS[BIT.FIBONACCI]);
  if (isSquare(5n * n * n + 20n) || isSquare(5n * n * n - 20n)) set(BIT.LUCAS, POINTS[BIT.LUCAS]);
  if (isCube(n)) set(BIT.CUBE, POINTS[BIT.CUBE]);
  if (isSquare(n)) set(BIT.SQUARE, POINTS[BIT.SQUARE]);
  const rn = isqrt(n);
  if (rn * (rn + 1n) === n) set(BIT.PRONIC, POINTS[BIT.PRONIC]);
  if (isSquare(8n * n + 1n)) set(BIT.TRIANGULAR, POINTS[BIT.TRIANGULAR]);
  if (digitSum > 0 && n % BigInt(digitSum) === 0n) set(BIT.HARSHAD, POINTS[BIT.HARSHAD]);
  if (isHappy(n)) set(BIT.HAPPY, POINTS[BIT.HAPPY]);
  if (isPrimeMR(BigInt(digitSum))) set(BIT.DIGITSUM_PRIME, POINTS[BIT.DIGITSUM_PRIME]);

  // N6's eight from-`n` categories. SUMMED, not folded into DIGIT's
  // max-of-six above: none of these is implied by a repdigit or a palindrome.
  if (d === 10 && new Set(ds).size === 10) set(BIT.PANDIGITAL, POINTS[BIT.PANDIGITAL]);
  if (isNarcissistic(n, d)) set(BIT.NARCISSISTIC, POINTS[BIT.NARCISSISTIC]);
  const nsq = n * n;
  const p10 = 10n ** BigInt(d);
  const kLow = nsq % p10;
  if (kLow === n) set(BIT.AUTOMORPHIC, POINTS[BIT.AUTOMORPHIC]);
  if (kLow > 0n && kLow + nsq / p10 === n) set(BIT.KAPREKAR, POINTS[BIT.KAPREKAR]);
  if (isSquare(n) && isSquare(8n * n + 1n)) set(BIT.SQUARE_TRIANGULAR, POINTS[BIT.SQUARE_TRIANGULAR]);
  if (HIGHLY_COMPOSITE.has(n)) set(BIT.HIGHLY_COMPOSITE, POINTS[BIT.HIGHLY_COMPOSITE]);
  if (isKeith(n, d, digitSum)) set(BIT.KEITH, POINTS[BIT.KEITH]);
  if (CATALAN.has(n)) set(BIT.CATALAN, POINTS[BIT.CATALAN]);

  if (ICONIC.has(n)) set(BIT.ICONIC, POINTS[BIT.ICONIC]);
  if (LISTED.has(n)) set(BIT.LISTED, POINTS[BIT.LISTED]);
  if (prime && LANDMARK_PRIMES.has(n)) set(BIT.LANDMARK, POINTS[BIT.LANDMARK]);
  if (CONSTANTS.has(n)) set(BIT.CONSTANT, POINTS[BIT.CONSTANT]);

  // THE ONE CLAMP, and it is on the score alone. A number that earned nine
  // categories wears nine satellites even when the ninth bought it no points:
  // the orb draws what is TRUE of the number, the price draws what the game
  // will charge for it, and those are different questions.
  // NO CLAMP HERE — `scoreOf` and `scoreOfFrom` each apply it ONCE over their
  // own whole sum, so a factor category is never dropped by a clamp that ran
  // before it was added. Mirrors `scoreOfUnclamped` in `score_block.tolk.inc`.
  return { score, flags };
}

/** The from-`n` score: bits 33..39 and 48..51 clear, and a LOWER BOUND on the full one. */
export function scoreOf(n: bigint): Score {
  const { score, flags } = unclampedScoreOf(n);
  return { score: Math.min(score, SCORE_MAX), flags };
}

/**
 * One prime-power factor of a factorization, in the shape the contracts'
 * `FactorEntry` carries it. `s` (⌊√p⌋) is not needed here — the score does not
 * use it and this mirror does not verify the list.
 */
export interface Factor {
  p: bigint;
  e: number;
}

/**
 * D(n) WITH the five factor categories of §4 — the score `open_lot` and the head
 * mint charge, and what `getLotPriceFrom` / `getScoreBreakdownFrom` return.
 *
 * `scoreOf(n)` is the same sum with bits 33..38 clear, so it is a LOWER BOUND
 * and never a different answer. An empty list here reproduces it exactly.
 *
 * VERIFIES NOTHING, exactly as the Tolk does not: the caller passes a list the
 * contract has already checked against `n`.
 */
export function scoreOfFrom(n: bigint, factors: readonly Factor[]): Score {
  if (n <= 0n) return { score: 0, flags: 0n };
  const base = unclampedScoreOf(n);
  if (factors.length === 0) return { score: Math.min(base.score, SCORE_MAX), flags: base.flags };

  let omega = 0;
  let maxExponent = 0;
  let maxPrime = 0n;
  let sigma = 1n;
  for (const f of factors) {
    omega += f.e;
    if (f.e > maxExponent) maxExponent = f.e;
    if (f.p > maxPrime) maxPrime = f.p;
    let term = 1n;
    let power = 1n;
    for (let i = 0; i < f.e; i++) {
      power *= f.p;
      term += power;
    }
    sigma *= term;
  }

  let score = base.score;
  let flags = base.flags;
  const set = (bit: number) => {
    flags |= 1n << BigInt(bit);
    score += POINTS[bit];
  };

  if (omega === 2) set(BIT.SEMIPRIME);
  if (factors.length === 1 && omega >= 2) set(BIT.PRIME_POWER);
  if (maxExponent === 1) set(BIT.SQUAREFREE);
  if (maxPrime <= SMOOTH_BOUND) set(BIT.SMOOTH);
  const twiceN = 2n * n;
  if (sigma > twiceN) set(BIT.ABUNDANT);
  if (sigma < twiceN) set(BIT.DEFICIENT);

  // CARMICHAEL, by Korselt's criterion: squarefree, three or more prime
  // factors, and (p-1) | (n-1) for every one of them. The first clause is
  // `maxExponent`, already computed above.
  const korselt =
    factors.length >= 3 &&
    maxExponent === 1 &&
    factors.every((f) => f.p >= 2n && (n - 1n) % (f.p - 1n) === 0n);
  if (korselt) set(BIT.CARMICHAEL);

  // D-162. Sphenic: three distinct primes, each once. Powerful: every exponent
  // >= 2. Achilles: powerful and not a perfect power (exponent gcd 1). Smith: a
  // composite whose digit sum equals its prime factors' digit sums, with
  // multiplicity.
  if (omega === 3 && factors.length === 3) set(BIT.SPHENIC);
  if (factors.every((f) => f.e >= 2)) {
    set(BIT.POWERFUL);
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    if (factors.reduce((g, f) => gcd(g, f.e), 0) === 1) set(BIT.ACHILLES);
  }
  const digitSumOf = (x: bigint) => [...x.toString()].reduce((a, c) => a + Number(c), 0);
  if (omega >= 2 && digitSumOf(n) === factors.reduce((a, f) => a + digitSumOf(f.p) * f.e, 0)) {
    set(BIT.SMITH);
  }

  return { score: Math.min(score, SCORE_MAX), flags };
}

/** D-96's family, narrowed by D-99 to a rebate population with no score. */
export const DIRICHLET_MIN_N = 100000n;
export const DIRICHLET_MOD = 101n;
export const isRebateFamilyPrime = (n: bigint) => n > DIRICHLET_MIN_N && n % DIRICHLET_MOD === 1n && isPrimeMR(n);
