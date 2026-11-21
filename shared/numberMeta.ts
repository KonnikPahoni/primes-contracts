/**
 * The search/unfurl title and description of a number page, `/n/<n>` and `/lot/<n>`
 * (SEO_PLAN 4.1). "Is 97 prime" and "prime factorization of 1001" are real searches, and each
 * number page is a page about exactly that, so its title says it: `97 is prime · TON PRIMES`,
 * `1001 = 7 × 11 × 13 · TON PRIMES`.
 *
 * ONE formatter for every reader. The webapp's runtime head (`routes/Number`, `routes/Lot`,
 * fed the worker's factors), read-proxy's `/unfurl/:family/:n` fragment (fed its own bounded
 * factorization) and the build's generic template (`webapp/scripts/prerenderRoutes.ts`
 * `renderUnfurl`, fed nothing) all call this, so the raw HTML and the JS-rendered head cannot
 * disagree.
 *
 * Pure math only (CONCEPT.md §9.1): primality and factorization are facts about the integer
 * that any reader can check. Owner, price and minted status are chain state and never appear
 * here — a cached title would go stale on them.
 *
 * This module never factors anything: the caller passes what it already computed. Above
 * `AUCTIONABLE_MAX`, which no one can hold, it returns the generic copy whatever it is given,
 * so every caller is bounded the same way.
 */
import { MARKET_LIMITS } from "./opcodes";

export type NumberMetaFamily = "n" | "lot";

export interface NumberFacts {
  isPrime: boolean;
  /** Ascending `(prime, exponent)` pairs; `null`/absent when the factorization is not available. */
  factors?: readonly { prime: bigint; exponent: number }[] | null;
}

export interface NumberMeta {
  title: string;
  description: string;
}

const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/**
 * `[{2,1},{3,2},{13,1}]` → `"2 · 3² · 13"`. Plain text on purpose: the callers interpolate it
 * into i18n copy and into `<title>`, where markup cannot go, so an exponent of 1 is elided and
 * anything above it becomes a superscript glyph rather than `^2`. `sep` is `" × "` in a title,
 * where `·` already separates the site name.
 */
export function formatFactorization(
  factors: readonly { prime: bigint; exponent: number }[],
  sep = " · ",
): string {
  return factors
    .map(({ prime, exponent }) => {
      if (exponent <= 1) return `${prime}`;
      const sup = String(exponent)
        .split("")
        .map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d)
        .join("");
      return `${prime}${sup}`;
    })
    .join(sep);
}

/** What every number says before (or without) its math: the copy the raw template carries. */
function generic(family: NumberMetaFamily, n: string): NumberMeta {
  return family === "n"
    ? {
        title: `Number ${n} · TON PRIMES`,
        description: `Number ${n} on TON PRIMES. Own a number forever: its factorization, its owner and what it has earned, each read from the chain.`,
      }
    : {
        title: `Lot ${n} · TON PRIMES`,
        description: `The lot for ${n} on TON PRIMES. Opening it is the first bid, and winning it mints the number in the same transaction.`,
      };
}

/**
 * `n` is the URL's digits — a string, so the build can pass its `__PRIMES_N__` placeholder.
 * `facts` is `null` while the caller has no answer (still computing, failed, over budget).
 */
export function numberMeta(family: NumberMetaFamily, n: string, facts: NumberFacts | null): NumberMeta {
  const value = /^[1-9][0-9]*$/.test(n) ? BigInt(n) : null;
  if (value === null || value > MARKET_LIMITS.AUCTIONABLE_MAX) return generic(family, n);

  // Unity (CONCEPT.md §6 point 0): neither prime nor composite, so no facts are needed.
  if (value === 1n) {
    return family === "n"
      ? {
          title: "1 is Unity · TON PRIMES",
          description:
            "1 is Unity, neither prime nor composite: the first number on TON PRIMES, minted at ignition and owned forever as an NFT on TON.",
        }
      : generic(family, n);
  }
  if (!facts) return generic(family, n);

  let math: string;
  let said: string;
  if (facts.isPrime) {
    math = `${n} is prime`;
    said = `${n} is prime.`;
  } else if (facts.factors && facts.factors.length > 0) {
    const f = formatFactorization(facts.factors, " × ");
    math = `${n} = ${f}`;
    said = `${n} = ${f}.`;
  } else {
    return generic(family, n);
  }

  if (family === "lot") {
    return {
      title: `Lot ${math} · TON PRIMES`,
      description: `${said} Bid on its lot on TON PRIMES; the winning bid mints it in the same transaction.`,
    };
  }
  const omega = facts.isPrime ? 0 : facts.factors!.length;
  return {
    title: `${math} · TON PRIMES`,
    description: facts.isPrime
      ? `${said} On TON PRIMES it is an NFT, and every composite minted with ${n} as a factor pays its owner tribute.`
      : `${said} Minting it on TON PRIMES pays a tribute line to its ${omega} distinct prime factor${omega === 1 ? "" : "s"}.`,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The head tags a title and description occupy, as one HTML fragment. The same fragment for
 * every page the build prerenders and for read-proxy's number unfurl, so the tag set cannot
 * drift between the two.
 */
export function titleTags({ title, description }: NumberMeta): string {
  const t = esc(title);
  const d = esc(description);
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
  ].join("\n    ");
}
