/**
 * TON PRIMES — the `/earn` funnel. EARN_PLAN E3.1, CONCEPT.md §9.1 / §9.2.
 *
 * ---- The one rule this file exists to enforce ----
 *
 * §9.1: every number the UI shows must map to a public get-method or a counted
 * event, AND be labelled as to which. `/earn` is the page most likely to blur
 * that line, because a partner dashboard's natural voice is to print five numbers
 * in a row as though they were the same kind of fact. They are not:
 *
 *   clicks          COUNTED  — an off-chain event this service tallied. Nobody
 *                              else can reproduce it. Trust in the operator.
 *   bot starts      COUNTED  — same. Telegram told us; we wrote it down.
 *   wallet connects INDEXED  — a real event, observed off-chain, in principle
 *                              re-derivable from chain data by an indexer, but
 *                              what you are reading is OUR index of it.
 *   first mint      PROVED   — on-chain. A get-method or a transaction says so,
 *                              and a reader can check it without us.
 *   attributed mints PROVED  — on-chain, and specifically: the ledger paid the
 *                              10% referral line to this key, which is the only
 *                              definition of "attributed" that means anything.
 *
 * So every figure this module returns is a `Counted<T>` — a value welded to its
 * evidence class. There is no path through this file that produces a bare number,
 * which is the point: the UI cannot render an off-chain tally as a proof by
 * accident, because it never receives one.
 *
 * ---- Why "attributed mints" is proved and "clicks" is not, concretely ----
 *
 * The referral line is resolved ON-CHAIN from the `rN` field literally present in
 * the mint transaction (§9.2, and `types.ts` says it twice). This service is
 * advisory for PRE-FILLING that field and authoritative for nothing. So the
 * honest funnel has a hard seam in the middle of it: everything upstream of the
 * mint is our word, everything at or downstream of the mint is the chain's. The
 * seam is where a referral dashboard normally lies, and labelling it is cheaper
 * than being trusted.
 */

// `Evidence` and `Counted<T>` are the wire shapes the webapp also reads (`@ton-primes/shared/wire`,
// GAUNTLET.md G64): a figure welded to its evidence class and to what a reader checks it against.
import type { Counted, Evidence, FunnelWire, SourceBreakdown } from "@ton-primes/shared/wire";
export type { Counted, Evidence, SourceBreakdown };

export const counted = <T>(value: T, source: string): Counted<T> => ({ value, evidence: "counted", source });
export const indexed = <T>(value: T, source: string): Counted<T> => ({ value, evidence: "indexed", source });
export const proved = <T>(value: T, source: string): Counted<T> => ({ value, evidence: "proved", source });

/** The five funnel stages, in order. */
export const FUNNEL_STAGES = ["clicks", "starts", "connects", "firstMints", "attributedMints"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/**
 * One off-chain funnel event. `clicks` and `starts` are recorded by whatever
 * served the link (web or bot); `connects` by the Mini App on a successful
 * TonConnect handshake.
 *
 * `referralKey` is the SHARER's key — the number whose owner gets credit — not
 * the visitor's. A visitor has no key until they own a number, which is exactly
 * decision 0.2.3's cold-start problem: they get a link immediately and its
 * on-chain line switches on later.
 */
export interface FunnelEvent {
  stage: Extract<FunnelStage, "clicks" | "starts" | "connects">;
  referralKey: number;
  /** §9.2's source label — the `{source}` in `{key}_{source}_{clickid}`. */
  source: string;
  clickId?: string;
  /** Present for `starts` and `connects`; absent for an anonymous click. */
  telegramUserId?: string;
  /** Present for `connects` only. */
  walletAddress?: string;
  ts: Date;
}

/** One sharer's funnel — the shape `/earn` serves (`@ton-primes/shared/wire`, G64). `computedAt`
 *  is an ISO string, which is what the JSON always carried. */
export type Funnel = FunnelWire;

/** One `GROUP BY stage, source` row (GAUNTLET.md E25). */
export interface FunnelStageCount {
  stage: FunnelEvent["stage"];
  source: string;
  count: number;
}

export interface FunnelStore {
  recordFunnelEvent(event: FunnelEvent): Promise<void>;
  funnelEventsForKey(referralKey: number): Promise<FunnelEvent[]>;
  /**
   * GAUNTLET.md E25 — counts by (stage, source), which is all any consumer wanted.
   *
   * `funnelEventsForKey` selected a key's ENTIRE history and filtered by stage in JS, on
   * a route polled every 30s per open tab, so a popular sharer's read grew without bound
   * while the answer stayed four numbers wide. `buildFunnel` needs per-stage totals and
   * the source breakdown; `countedStartsForUser` needs one stage's total. Neither has
   * ever needed a row.
   */
  funnelCountsForKey(referralKey: number): Promise<FunnelStageCount[]>;
  /** D-213 — events of `stages` tagged `source` across `keys`, in ONE aggregate: `/earn` asks
   *  this for every owned number on a 30s poll, so a per-key loop is E25's shape again. */
  funnelCountOnKeys(keys: number[], source: string, stages: readonly FunnelEvent["stage"][]): Promise<number>;
}

/**
 * The funnel's PROVED half — the two counts this service does NOT produce.
 *
 * GAUNTLET.md J8: these used to be derived from an `attributed_mints` table this service
 * owned, whose only writer was a route nothing ever called, so both tiles read 0 on every
 * deployment under a `proved` badge. They now arrive from the event index, which watched
 * the chain for them and can rebuild them from it (`eventIndex.ts` has the full argument).
 *
 * The two are different questions and are counted differently on purpose:
 *
 *   - `firstMints` is per DISTINCT wallet. Counting mints would let one enthusiastic recruit
 *     look like a hundred conversions, which is the commonest way a funnel flatters itself.
 *   - `attributedMints` counts PAID citations. A key can be cited in a mint and still not
 *     pay — unset, self-referential, an unsold prime, a reserved number (§4.1) — and a
 *     citation that paid nobody is not an attribution.
 */
export interface ProvedFunnelCounts {
  firstMints: number;
  attributedMints: number;
  /** Payers whose FIRST mint cited the key — CONCEPT.md §9.2's freeze, derived from chain
   *  (GAUNTLET.md J10). It was a count of a `frozen_attributions` table nothing wrote. */
  frozenWallets: number;
  /**
   * Replaces the `source` all three tiles cite. §9.1: a tile links to the thing that answered
   * it, so a zero standing in for "nothing answered" must not borrow the citation of a
   * reading that was actually taken.
   */
  source?: string;
}

/**
 * How long a cached funnel may be displayed before the UI must say it is stale.
 * `/earn` is a polling page by nature (EARN_PLAN E3.5) and the read-proxy has
 * 500'd under webapp polling before, so the answer to "how fresh is this" is a
 * declared number rather than an implicit "as fresh as the last request".
 */
export const FUNNEL_STALE_AFTER_MS = 30_000;

/**
 * Assemble one sharer's funnel.
 *
 * `lineLive` is passed in rather than computed here because it is a CHAIN fact —
 * does the sharer own item `rN` — and this service does not read chain state.
 * Passing it keeps the seam visible in the type: everything this function knows
 * on its own is counted or indexed, and the one proved-by-ownership field has to
 * arrive from outside.
 */
export function buildFunnel(args: {
  referralKey: number;
  /**
   * GAUNTLET.md E25 — COUNTS, not rows. This took the key's entire event history and
   * filtered it by stage in JS, on a route polled every 30s per open tab, to produce four
   * numbers and a source breakdown. Nothing else was ever read off a row.
   */
  events: FunnelStageCount[];
  /** The three counts the event index answers — see `ProvedFunnelCounts`. */
  proved: ProvedFunnelCounts;
  /** Chain fact: does the sharer own number `rN`? From `get_nft_data`. */
  lineLive: boolean;
  now?: Date;
}): Funnel {
  const { referralKey, events, proved: chainCounts, lineLive } = args;
  const now = args.now ?? new Date();

  const byStage = (stage: FunnelStage) =>
    events.reduce((n, e) => (e.stage === stage ? n + e.count : n), 0);

  const sources = new Map<string, SourceBreakdown>();
  for (const e of events) {
    const key = e.source || "unlabelled";
    const row = sources.get(key) ?? { source: key, clicks: 0, starts: 0, connects: 0 };
    row[e.stage] += e.count;
    sources.set(key, row);
  }

  return {
    referralKey,
    lineLive: proved(lineLive, "get_nft_data(rN).owner"),
    clicks: counted(byStage("clicks"), "link server hit, deduped by clickid"),
    starts: counted(byStage("starts"), "Telegram /start with a §9.2 payload"),
    connects: indexed(byStage("connects"), "TonConnect handshake observed by the Mini App"),
    firstMints: proved(
      chainCounts.firstMints,
      chainCounts.source ?? "ledger mint events, distinct wallets"
    ),
    attributedMints: proved(
      chainCounts.attributedMints,
      chainCounts.source ?? "ledger mint events where the rN line paid"
    ),
    frozenWallets: proved(
      chainCounts.frozenWallets,
      chainCounts.source ?? "ledger mint events, payers whose first mint cited this key (§9.2)"
    ),
    bySource: [...sources.values()].sort((a, b) => b.clicks - a.clicks),
    computedAt: now.toISOString(),
    staleAfterMs: FUNNEL_STALE_AFTER_MS,
  };
}

/**
 * The keyless visitor's funnel — decision 0.2.3. Everybody gets a link
 * immediately, so everybody gets a funnel; a visitor who owns nothing gets one
 * whose on-chain line is honestly `false` and whose proved rows are zero, not one
 * that is hidden until they qualify.
 *
 * `wouldBeKey` is the current mint head: "your key would be #n". It is a chain
 * fact and is labelled as one.
 */
export function keylessFunnel(wouldBeKey: number, now?: Date): Funnel {
  return {
    ...buildFunnel({
      referralKey: wouldBeKey,
      events: [],
      proved: { firstMints: 0, attributedMints: 0, frozenWallets: 0 },
      lineLive: false,
      now,
    }),
    lineLive: proved(false, "get_head() — you do not own a number yet"),
  };
}
