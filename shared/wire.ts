/**
 * TON PRIMES — webapp <-> backend payload shapes, ONE definition each (GAUNTLET.md G62).
 *
 * These were declared twice, once in the service that serves them and once in the webapp that
 * reads them, linked by nothing but a "Mirrors ..." comment — and the collections pair had
 * already drifted (the backend typed `marketUnavailable` as `string`, the webapp as the
 * four-member union the backend actually emits). Both ends now import the shape from here, so
 * a field rename fails `typecheck` on whichever side did not follow, instead of arriving as a
 * runtime `undefined`.
 *
 * TYPE-ONLY. Nothing here is emitted; the file must never grow a runtime import.
 *
 * The envelopes take their provenance type as a parameter so one envelope can carry either a
 * chain `Provenance` or a read-proxy exception type (`ConfigProvenance`,
 * `MarketplaceProvenance`); `Provenance` itself is declared once, below (G65).
 */

/**
 * CONCEPT.md §9.1's honesty field: which get-method, on which contract, produced a number.
 * The read-proxy serves it; the proof drawer renders it (G65 — it was declared twice, and the
 * webapp's copy lacked `"stale"` while carrying a `"fixture"` nothing emits any more).
 */
export interface Provenance {
  getMethod: string;
  contractAddress: string;
  /** "live" = read from the chain this request; "cached" = served from Redis within its TTL;
   *  "stale" = the revalidating read failed and this is the last good value, served past its
   *  TTL. `fetchedAt` always states the true age, which is what makes "stale" honest. */
  source: "live" | "cached" | "stale";
  /** ISO timestamp of the underlying chain read (not of this response). */
  fetchedAt: string;
}

/** `{ data, provenance }` — `WithProvenance<T>` in the webapp, `ProvenanceEnvelope<T>` in the
 *  read-proxy. */
export interface ProvenancedWire<T, P> {
  data: T;
  provenance: P;
}

/** `GET /bootstrap` (read-proxy `server.ts`). Every field is nullable for the same reason on
 *  both ends: one throttled get-method must not take the other four down with it. */
export interface BootstrapWire<P> {
  head: ProvenancedWire<{ head: string }, P> | null;
  lastMintTime: ProvenancedWire<{ lastMintTime: string }, P> | null;
  k: ProvenancedWire<{ k: string }, P> | null;
  kMax: ProvenancedWire<{ kMax: string }, P> | null;
  floor: ProvenancedWire<{ floorNumNanoton: string; floorDenPrimes: string }, P> | null;
  /** The exact `(n, t)` `k` was read at, so the client can seed the key it will ask for. */
  kArgs: { n: string; t: string } | null;
  /** Named reasons for every null above. Empty when everything resolved. */
  unavailable: { field: string; reason: string }[];
}

/** Secondary-market figures for one collection (read-proxy `lakeMarket.ts`). */
export interface CollectionMarketWire {
  /** All-time realised, TON-denominated, SECONDARY only. */
  volumeNanoton: string;
  /** Sales behind `volumeNanoton`. */
  trades: number;
  /** Lowest FIXED-PRICE ask listed right now. Null means NOTHING IS LISTED — an answer. */
  floorNanoton: string | null;
  /** Items on sale right now, fixed-price and auction together. */
  onSale: number;
  /** Epoch ms of the most recent sale, or null if there has never been one. */
  lastSaleAt: number | null;
}

/** Why a card's `market` is null. `not-indexed`: the marketplace index does not cover this
 *  network (the TON data lake is mainnet-only). */
export type MarketAbsence = "not-configured" | "not-computed-yet" | "unavailable" | "not-indexed";

/** One key since D-202 deleted the generators and constellations collections. */
export type CollectionKey = "numbers";

/** One card of `GET /collections` (read-proxy `routes/collections.ts`). */
export interface CollectionCardWire<P, MP> {
  key: CollectionKey;
  /** The collection contract; null when the role is unconfigured on this deployment. */
  address: string | null;
  /** GetGems short-link slug — mainnet only. */
  handle: string;
  /** Items in existence, as a decimal string. Null is UNKNOWN, never a zero. */
  issued: string | null;
  issuedProvenance: P | null;
  /** Why `issued` is null, when it is. */
  issuedUnavailable: string | null;
  market: CollectionMarketWire | null;
  marketProvenance: MP | null;
  marketUnavailable: MarketAbsence | null;
}

/** read-index's D-24 "visible degraded mode": how far the index is behind, and why. */
export interface IndexStatus {
  degraded: boolean;
  /** One human-readable string per condition that tripped. Empty iff not degraded. */
  reasons: string[];
  chainTip: { seqno: number; observedAt: string; ageSeconds: number } | null;
  sweep: {
    /** Bumped on process start; `catchUpComplete` is false until generation N has visited
     *  every queued target once. */
    generation: number;
    catchUpComplete: boolean;
    lastCycleAt: string | null;
    consecutiveFailures: number;
    queueDepth: number;
    /** Targets not yet visited in this generation. 0 once catch-up completes. */
    pending: number;
  };
  /** Age of the oldest reading contributing to THIS response, in seconds. */
  oldestReadingAgeSeconds: number | null;
  /** The ceiling of the staleness shape. Served, never invented client-side. */
  staleAfterSeconds: number;
}

export interface IndexEnvelope<T> {
  index: IndexStatus;
  /** Dotted paths within `data` whose provenance carries `liveOnly: true` — D-24 criterion 3:
   *  re-read each from its named get-method before signing anything against it. */
  liveOnly: string[];
  data: T;
}

// ---------------------------------------------------------------------------
// POST /earn (attribution `earn.ts`) — GAUNTLET.md G64. No provenance parameter: every figure
// is a `Counted<T>` that carries its own evidence class and source.
// ---------------------------------------------------------------------------

/** How a figure is known. Ordered weakest to strongest, deliberately. */
export type Evidence = "counted" | "indexed" | "proved";

/** A number welded to its evidence class and to what a reader checks it against (§9.1). */
export interface Counted<T = number> {
  value: T;
  evidence: Evidence;
  /** Get-method name (proved) or the mechanism that produced the tally. */
  source: string;
}

/** Where a completed quest is paid from: verified in the claim tx, or by a §9.5 voucher. */
export type Settlement = "contract" | "voucher";

/** §9.4's tracks. */
export type QuestTrack = "referral" | "recruit" | "prime" | "game" | "story" | "social";

/** One quest on the board. The field docs live on the backend's `QuestState` alias. */
export interface QuestStateWire {
  id: string;
  track: QuestTrack;
  title: string;
  description: string;
  rewardTon: number;
  /** Which of `rewardTon` / `rewardPrimesQuote` is the fixed one (D-42). Always PRIMES since
   *  D-118's 2026-11-20 amendment folded the last TON-denominated quest (the story quest) into
   *  the social board; the field stays so a client reads the unit rather than assuming it. */
  rewardDenomination: "primes";
  rewardPrimesQuote: number;
  quotedAtPrimesPerTon: number;
  progress: number;
  target: number;
  complete: boolean;
  settlement: Settlement;
  source: string;
  evidence: Evidence;
  lockedBy?: string;
  awaitingAttributedMint?: boolean;
  actionUrl?: string;
}

/** Per-source breakdown, so a sharer can tell which of their labels worked. */
export interface SourceBreakdown {
  source: string;
  clicks: number;
  starts: number;
  connects: number;
}

export interface FunnelWire {
  referralKey: number;
  lineLive: Counted<boolean>;
  clicks: Counted;
  starts: Counted;
  connects: Counted;
  firstMints: Counted;
  attributedMints: Counted;
  frozenWallets: Counted;
  bySource: SourceBreakdown[];
  /** ISO timestamp of when this snapshot was assembled. */
  computedAt: string;
  staleAfterMs: number;
}

export interface EarnWire {
  wallet: string | null;
  link: {
    key: number;
    payloads: Record<string, string>;
    lineLive: Counted<boolean>;
  };
  funnel: FunnelWire;
  quests: QuestStateWire[];
  claims: {
    voucherEarnedPrimes: Counted<number>;
    quotedAtPrimesPerTon: Counted<number>;
    voucherPaidNanoPrimes: Counted<string>;
    programClosed: Counted<boolean>;
    /** DESIGN.md G51 — the PQST voucher instance (D-171): the contract-fact quests. */
    primeQuestsEarnedPrimes: Counted<number>;
    primeQuestsPaidNanoPrimes: Counted<string>;
    primeQuestsClosed: Counted<boolean>;
  };
  invite: {
    rank: { recruits: number; tier: number; uplift: string; nextTierAt: number };
    newcomerWindow: { left: number; total: number; uplift: string };
    /** D-106's three sentences, shipped in the payload so a redesign cannot drop them. */
    defence: string[];
  };
  computedAt: string;
  staleAfterMs: number;
}
