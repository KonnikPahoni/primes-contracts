/**
 * Primorial eras (CONCEPT.md §7) — the single canonical copy.
 *
 * The number line is partitioned into eras by the primorials p#. There are EIGHT
 * protocol-recognized boundaries — the list below — and this module is where they live.
 * `isPrimorial` in both `primes_ledger.tolk` and `primes_market.tolk` enumerate the same
 * eight, and `params.json`'s `genesis.era_bounty_schedule` funds the same eight ceremonies;
 * those are contract- and sim-side copies that cannot import TypeScript. Everything on the
 * TypeScript side reads this file.
 * (§7's prose used to say "only ever six"; the owner resolved that divergence in favour of
 * the contracts on 2026-08-17 — eight is the number everywhere now.)
 *
 * It used to live in `webapp/src/math/primorial.ts`, which was fine while the webapp was the
 * only consumer. It is not any more: `shared/art` themes a minted tile by its era and cannot
 * import from `webapp/`, so leaving it there would have meant a fourth copy of a list
 * CLAUDE.md already fights drift on. The webapp module now re-exports from here, so no call
 * site there changed.
 *
 * This module is deliberately dependency-free and synchronous: UPGRADE_PLAN_V5.md §6 D5
 * requires the era countdown to be "derivable from `head` with no backend at all". Every
 * number this module produces is recomputable by a reader from the head alone, which is
 * what CONCEPT.md principle 5 asks for — no growth number the reader can't check.
 */

/** The eight protocol-recognized era boundaries (CONCEPT.md §4.7, §7). */
export const PRIMORIALS: readonly bigint[] = [
  6n, 30n, 210n, 2310n, 30030n, 510510n, 9699690n, 223092870n,
];

/** Generating prime of each primorial above — 6 = 2·3, 30 = 2·3·5, … 223092870 = 23#. */
export const PRIMORIAL_GENERATORS: readonly bigint[] = [3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n];

/**
 * How many distinct era indices `eraPosition` can return: 1..8 for the eight boundaries,
 * plus 9 for "past the last one". Nine, not eight — the ground tone has to keep working
 * after 223092870, and a palette table sized to the boundary count would run out exactly
 * where the number line stops having boundaries.
 */
export const ERA_INDEX_MAX = PRIMORIALS.length + 1;

/**
 * The era hue, in degrees. ONE definition, three consumers.
 *
 * `webapp/src/styles/tokens.css` states the rule this implements: era gradients are
 * "derived from the era index, never hand-picked per screen — one definition, consumed
 * everywhere". The CSS holds the canonical arithmetic as a `calc()` because a stylesheet
 * cannot call a function; this is the same arithmetic for the two consumers that can —
 * `shared/art/story.ts`'s share card and `shared/art/scene.ts`'s minted tile.
 *
 * 47° per era, coprime-ish with 360, so no two of the nine land near each other and the
 * sequence would not repeat even if there were more of them.
 */
export const ERA_HUE_BASE = 208;
export const ERA_HUE_STEP = 47;

export function eraHue(eraIndex: number): number {
  return (ERA_HUE_BASE + eraIndex * ERA_HUE_STEP) % 360;
}

export interface EraPosition {
  /** The primorial that ends the current era, or null once the head is past the last. */
  boundary: bigint | null;
  /** Generating prime of `boundary` ("the 13-era ends at 30030"), or null past the last. */
  generator: bigint | null;
  /** Numbers (not mints) between the head and the ceremony — an upper bound on the mints
   *  left, since the head skips primes and auctioned numbers (§7, D-45). 0 means the head *is* the primorial. */
  numbersUntil: bigint | null;
  /** Start of the current era — the previous primorial, or 1n before the first. */
  eraStart: bigint;
  /** Progress through the current era in [0, 1], for a progress bar. Null past the last. */
  progress: number | null;
  /** True when the head is standing exactly on a primorial: the ceremony is live. */
  isCeremony: boolean;
  /** 1-based index of the era, 1..8; 9 once the head is past every boundary. */
  eraIndex: number;
}

/**
 * Where `head` sits relative to the primorial eras.
 *
 * `head` is the next number to be minted, so `numbersUntil = boundary − head`: when the
 * head has reached the primorial itself the count is 0 and the ceremony is the very next
 * mint. Past 223092870 there are no further boundaries and the countdown retires rather
 * than wrapping — eight exist, ever.
 */
export function eraPosition(head: bigint): EraPosition {
  for (let i = 0; i < PRIMORIALS.length; i++) {
    const boundary = PRIMORIALS[i];
    if (head <= boundary) {
      const eraStart = i === 0 ? 1n : PRIMORIALS[i - 1];
      const span = boundary - eraStart;
      const done = head - eraStart;
      return {
        boundary,
        generator: PRIMORIAL_GENERATORS[i],
        numbersUntil: boundary - head,
        eraStart,
        progress: span > 0n ? clamp01(Number(done) / Number(span)) : 1,
        isCeremony: head === boundary,
        eraIndex: i + 1,
      };
    }
  }

  return {
    boundary: null,
    generator: null,
    numbersUntil: null,
    eraStart: PRIMORIALS[PRIMORIALS.length - 1],
    progress: null,
    isCeremony: false,
    eraIndex: ERA_INDEX_MAX,
  };
}

/**
 * The era a *minted number* belongs to, as opposed to where the head is.
 *
 * `eraPosition` answers "how far is the head through its era", and its `head <= boundary`
 * test is the right one for a countdown: standing on 30030 is the ceremony for the era
 * that ends there. A number's own era is the same question asked of `n`, which is why this
 * is a one-line wrapper rather than a second traversal — an item minted at 30030 belongs
 * to the era 30030 closes, and its tile is themed accordingly.
 */
export function eraIndexOf(n: bigint): number {
  return eraPosition(n).eraIndex;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
