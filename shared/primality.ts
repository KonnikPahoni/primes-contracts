// Pure, DOM/worker-free number-theory helpers shared by the mint wizard's
// "pick a number" step and by src/math/worker.ts.
//
// isProbablePrime uses the SAME deterministic 13-base Miller-Rabin base list
// as the live contract (contracts/contracts/primes_ledger.tolk, mrBaseAt /
// isPrimeMR): 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41. This exact set
// is correct (fully deterministic, no false positives) for all n < 3.3e24 —
// see https://miller-rabin.appspot.com/ — and MUST match the contract's list
// verbatim so the browser and TVM never disagree (FRONTEND_PLAN.md §10).
export const MR_BASES: readonly bigint[] = [
  2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n,
];

export interface PrimeFactor {
  prime: bigint;
  exponent: number;
}

/** Modular exponentiation: base^exp mod m, all bigint, m >= 1. */
function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  if (m === 1n) return 0n;
  let result = 1n;
  let b = base % m;
  if (b < 0n) b += m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % m;
    }
    e >>= 1n;
    b = (b * b) % m;
  }
  return result;
}

function millerTest(a: bigint, d: bigint, r: bigint, n: bigint): boolean {
  let x = modPow(a, d, n);
  if (x === 1n || x === n - 1n) return true;
  let i = 0n;
  while (i < r - 1n) {
    x = (x * x) % n;
    if (x === n - 1n) return true;
    i += 1n;
  }
  return false;
}

/** One base tested, in order, by {@link millerRabinSteps} — G23's per-round progress. */
export interface MillerRabinStep {
  baseIndex: number;
  base: bigint;
  /** Whether n survived this base (false means n is definitely composite and testing stops). */
  survived: boolean;
}

/**
 * Deterministic 13-base Miller-Rabin, bit-for-bit mirroring
 * contracts/contracts/primes_ledger.tolk's isPrimeMR/mrBaseAt so the browser
 * and TVM never disagree on primality — run as a generator so a caller (the
 * worker, for G23) can observe each base as it resolves instead of only the
 * final verdict. `isProbablePrime` below just drains this to its return value,
 * so there is exactly one place the algorithm is written.
 */
export function* millerRabinSteps(n: bigint): Generator<MillerRabinStep, boolean, void> {
  if (n < 2n) return false;
  if (n === 2n || n === 3n) return true;
  if (n % 2n === 0n) return false;

  let d = n - 1n;
  let r = 0n;
  while (d % 2n === 0n) {
    d /= 2n;
    r += 1n;
  }

  for (let i = 0; i < MR_BASES.length; i++) {
    const a = MR_BASES[i];
    if (a < n) {
      const survived = millerTest(a, d, r, n);
      yield { baseIndex: i, base: a, survived };
      if (!survived) return false;
    }
  }
  return true;
}

export function isProbablePrime(n: bigint): boolean {
  const gen = millerRabinSteps(n);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

// Trial-division bound: covers all primes below this quickly via a simple
// sieve, then Pollard's rho handles whatever cofactor remains. 100,000 keeps
// the sieve small (a few ms) while stripping every small factor a realistic
// mint candidate could have.
const TRIAL_DIVISION_BOUND = 100_000;

function sievePrimesUpTo(limit: number): number[] {
  const isComposite = new Uint8Array(limit + 1);
  const primes: number[] = [];
  for (let i = 2; i <= limit; i++) {
    if (!isComposite[i]) {
      primes.push(i);
      for (let j = i * i; j <= limit; j += i) {
        isComposite[j] = 1;
      }
    }
  }
  return primes;
}

let smallPrimesCache: number[] | undefined;
function smallPrimes(): number[] {
  if (!smallPrimesCache) {
    smallPrimesCache = sievePrimesUpTo(TRIAL_DIVISION_BOUND);
  }
  return smallPrimesCache;
}

function bigintGcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("negative sqrt");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

/** True if n is a perfect square; short-circuits Pollard's rho for cofactors
 * like p^2 so the cycle-finding loop isn't relied on for that case. */
function isPerfectSquare(n: bigint): boolean {
  if (n < 0n) return false;
  const r = bigintSqrt(n);
  return r * r === n;
}

/**
 * Pollard's rho, Brent's cycle-detection variant with batched GCDs (the
 * standard optimization: accumulate a running product of |x-y| differences
 * mod n across a batch of steps and take one gcd per batch instead of one
 * per step, which is the difference between this finishing in milliseconds
 * vs. seconds on ~10^12-sized factors). Returns a nontrivial factor of the
 * composite n (n must not be prime and not 1).
 */
function pollardRhoBrent(n: bigint, c: bigint): bigint | undefined {
  const f = (v: bigint) => (v * v + c) % n;
  const BATCH = 128n;

  let y = 2n;
  let g = 1n;
  let q = 1n;
  let x = 2n;
  let ys = 2n;
  let steps = 1n;

  while (g === 1n) {
    x = y;
    for (let i = 0n; i < steps; i++) {
      y = f(y);
    }
    let k = 0n;
    while (k < steps && g === 1n) {
      ys = y;
      const batch = steps - k < BATCH ? steps - k : BATCH;
      for (let i = 0n; i < batch; i++) {
        y = f(y);
        const diff = x > y ? x - y : y - x;
        if (diff !== 0n) {
          q = (q * diff) % n;
        }
      }
      g = bigintGcd(q, n);
      k += batch;
    }
    steps *= 2n;
  }

  if (g === n) {
    // Batched gcd overshot: fall back to per-step gcd from the last
    // checkpoint, which always finds a genuine nontrivial factor.
    g = 1n;
    while (g === 1n) {
      ys = f(ys);
      const diff = x > ys ? x - ys : ys - x;
      g = diff === 0n ? n : bigintGcd(diff, n);
    }
  }

  if (g === n) return undefined;
  return g;
}

/**
 * Pollard's rho, Brent's cycle-detection variant with batched GCDs (the
 * standard optimization: accumulate a running product of |x-y| differences
 * mod n across a batch of steps and take one gcd per batch instead of one
 * per step, which is the difference between this finishing in milliseconds
 * vs. seconds on ~10^12-sized factors). Returns a nontrivial factor of the
 * composite n (n must not be prime and not 1).
 */
function pollardRho(n: bigint): bigint {
  if (n % 2n === 0n) return 2n;
  if (isPerfectSquare(n)) return bigintSqrt(n);

  // Deterministic pseudo-random-ish sequence of constants: no crypto
  // randomness needed, just enough spread across retries.
  let seed = 1n;
  for (let attempt = 0; attempt < 100; attempt++) {
    const c = (seed % (n - 1n)) + 1n;
    const factor = pollardRhoBrent(n, c);
    if (factor !== undefined && factor !== n && factor !== 1n) {
      return factor;
    }
    seed += 1n;
  }
  throw new Error(`Pollard's rho failed to factor ${n.toString()}`);
}

/**
 * Recursively factor n (n > 1, not prime) into prime factors, appending
 * (with multiplicity, unsorted/unmerged) into `out`.
 */
function factorRecursive(n: bigint, out: bigint[]): void {
  if (n === 1n) return;
  if (isProbablePrime(n)) {
    out.push(n);
    return;
  }
  const factor = pollardRho(n);
  factorRecursive(factor, out);
  factorRecursive(n / factor, out);
}

/**
 * The smallest prime >= n, and how many numbers away it is.
 *
 * Drives the landing page's next-prime countdown (UPGRADE_PLAN_V5.md §6 D1). Because
 * minting is strictly sequential the head must pass *through* every prime, so "the next
 * prime" is a real, dated event rather than a curiosity — a prime at its turn arrives
 * roughly one number in ln(n).
 *
 * Scanning is cheap: the expected gap to the next prime is ~ln(n), which is about 12 at
 * n = 10^5 and about 30 at n = 10^13, so this is a handful of Miller-Rabin runs. `gap` is
 * 0 when n is itself prime — i.e. the head is standing on one.
 */
export function nextPrimeAtOrAfter(n: bigint): { prime: bigint; gap: bigint } {
  let candidate = n < 2n ? 2n : n;
  while (!isProbablePrime(candidate)) {
    candidate += 1n;
  }
  return { prime: candidate, gap: candidate - (n < 2n ? 2n : n) };
}

/**
 * Full prime factorization of n (n >= 2), as (prime, exponent) pairs
 * sorted ascending by prime. Trial division strips small primes first
 * (fast path for the overwhelming majority of realistic mint candidates),
 * then Pollard's rho handles any remaining large cofactor.
 */
export function factorize(n: bigint): PrimeFactor[] {
  if (n < 2n) {
    throw new RangeError("factorize requires n >= 2");
  }

  const rawFactors: bigint[] = [];
  let remainder = n;

  for (const p of smallPrimes()) {
    if (remainder === 1n) break;
    const bp = BigInt(p);
    if (bp * bp > remainder) break;
    while (remainder % bp === 0n) {
      rawFactors.push(bp);
      remainder /= bp;
    }
  }

  if (remainder > 1n) {
    factorRecursive(remainder, rawFactors);
  }

  rawFactors.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const grouped: PrimeFactor[] = [];
  for (const p of rawFactors) {
    const last = grouped[grouped.length - 1];
    if (last && last.prime === p) {
      last.exponent += 1;
    } else {
      grouped.push({ prime: p, exponent: 1 });
    }
  }
  return grouped;
}

/**
 * Factorize under a magnitude bound. `null` means "did not finish", never "has no factors".
 *
 * THE ONE BUDGET every artwork surface factors under. The art grammar reads a composite's
 * motion, body count and symmetry off its factorisation and falls back to the seed without one
 * (`shared/art/traits.ts`), so the read-proxy that paints `/nft/<n>.png` and the webapp that
 * performs the same number live must agree on exactly which numbers are "too large to factor" —
 * or the tile and the marketplace image are two different pieces.
 */
export function factorizeWithinBudget(n: bigint): PrimeFactor[] | null {
  // Cheap upper bound on the work `factorize` will do: anything that fits in a machine
  // double's exact-integer range is trial-divisible fast, and beyond ~2^64 the recursive
  // Pollard step is where an adversarial semiprime would sit.
  if (n < 2n || n > 2n ** 64n) return null;
  try {
    return factorize(n);
  } catch {
    return null;
  }
}
