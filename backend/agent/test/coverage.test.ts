/**
 * THE SURFACE GUARD.
 *
 * The SDK's claim is that a program can play the whole game and read the whole of what the
 * game publishes. Two things quietly falsify it, and neither one fails a test on its own:
 *
 *   1. a new **message builder** lands in `shared/messages.ts` with no `PrimesAgent` method,
 *      so an action exists that this package cannot take;
 *   2. a new **route** lands in one of the published OpenAPI specs with no `PrimesRead`
 *      method, so a figure exists that this package cannot name.
 *
 * Both are the drift `CLAUDE.md` rule 2 forbids between the code and CONCEPT.md, one layer
 * out. So this file reads the three source-of-truth lists — `shared/messages.ts` and the two
 * specs in `shared/openapi/` — and requires **every** entry to be either WIRED to a method
 * or NAMED as excluded with the reason it cannot be reached. A new builder or a new route
 * fails this suite until somebody decides which of the two it is.
 *
 * An exclusion is a claim, not an escape hatch: each one below states a fact about the
 * deployment or about the endpoint's kind, and several are checkable against the code.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PrimesAgent, PrimesRead } from "../src/index.ts";

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// ===========================================================================
// 1. Every message a program-player can send
// ===========================================================================

/** Wired: builder name -> the `PrimesAgent` method that sends it. */
const WIRED_ACTIONS: Record<string, keyof PrimesAgent> = {
  buildMintMessage: "mint",
  buildBidMessage: "bid",
  buildOpenLotMessage: "openLot",
  buildOpenHeadLotMessage: "openHeadLot",
  buildCloseLotMessage: "closeLot",
  buildFlushMessage: "flush",
  // The other two permissionless ratchet/ledger pokes (D-151, D-117): caller-paid, each
  // read-gated on the same figures its contract asserts.
  buildHarvestMessage: "harvest",
  buildSweepOpsMessage: "sweepOps",
  buildClaimTributeMessage: "claimTribute",
  // X3 / D-62's permissionless `top_up`: the one write anybody may make on ANY number.
  buildTopUpMessage: "topUp",
  buildAnnotateMessage: "annotate",
  // D-212: a number's own name, for GRAM, through the collection.
  buildNameNumberMessage: "name",
  buildTransferTrophyMessage: "transferTrophy",
  // The venue leg. Both directions are one method — the SDK picks the builder from `side`,
  // because the two are different shapes to different addresses and choosing between them
  // is exactly the part a caller should not have to get right.
  buildDedustSwapTonMessage: "swap",
  buildDedustSwapPrimesMessage: "swap",
};

/** Deliberately NOT wired, each with the reason it cannot be exercised by an agent. */
const EXCLUDED_ACTIONS: Record<string, string> = {
  buildInviteListCell: "a cell, not a message — it rides inside a mint, and `mint({ invites })` takes it",
  encodeInviteListCell: "the unchecked bytes behind the cell above",
  buildLpDepositPayload: "the payload inside buildLpDepositMessage below",
  buildClaimVoucherMessage:
    "needs an Ed25519 signature the attribution service's POST /voucher mints for the claimant " +
    "(§9.5, DESIGN.md G51); the SDK reads the chain and read-proxy only and has no voucher to redeem",
  // THE REASON HERE CHANGED, and the old one is worth recording because it was FALSE.
  // It said the LP jetton master "is not a configured role", so read-proxy reported the
  // depositor's LP wallet as null on every deployment. It never was: a DeDust v2 pool IS
  // the jetton master of its own LP token, `getVenue().dedustPool` names it, and
  // `/lp/wallet/{address}` now serves the derivation (`read.lpWallet()` above). What
  // actually keeps the position lifecycle off this surface is the line below.
  buildDedustDepositTonMessage:
    "half of a two-sided DeDust deposit. The pool mints LP only once BOTH legs land — GRAM at the " +
    "native vault and PRIMES at the jetton vault — and `wallet().send` signs one message at a time, " +
    "so an agent that sent this alone would park GRAM in a vault waiting for a partner it might never " +
    "send. Wiring it needs a multi-message send this SDK does not have.",
  buildDedustDepositPrimesMessage: "the other half of the same pair; see above",
  buildLpDepositMessage:
    "D-100's LP custody: parking LP is a TEP-74 transfer from the depositor's own DeDust LP jetton " +
    "wallet, which `read.lpWallet()` resolves. What is missing is the LP itself — an agent can only " +
    "park LP it already holds, and the only way to acquire any is the paired deposit excluded above. " +
    "So the whole position lifecycle is unreachable through this SDK, not unaddressable.",
  buildPositionWithdrawMessage: "a treasury position exists only after an LP deposit; see above",
  buildPositionRelockMessage: "same — D-147 restarts a term the SDK cannot open in the first place",
  buildPositionExpireMessage:
    "D-147's `expire` is PERMISSIONLESS, so unlike its neighbours an agent could send it — but " +
    "it needs a position child's address, and the only way to learn one is to hold a position or to " +
    "be told about somebody else's. `read.lpPositions(address)` answers the second for an address " +
    "the caller already has, so this is excluded as unreachable-in-practice rather than unaddressable, " +
    "and it is the one exclusion here that would become a real wiring job the day the SDK gains a way " +
    "to enumerate depositors.",
  buildPositionToSinkMessage: "same",
  buildPositionVoteMessage: "same — the electorate is LP depositors",
  buildPositionProposeMessage: "same",
  // D-168 — PRIMES staking. Read-side is wired (`stake`, `stakePositions`, `stakeLedger`).
  buildDistributeMessage: "D-168 staking verbs are out of the SDK until asked for (STAKING_PLAN.md §3.4); the keeper sends distribute and expire",
  buildStakePayload: "the payload inside buildStakeMessage below",
  buildStakeMessage: "D-168 staking verbs are out of the SDK until asked for (STAKING_PLAN.md §3.4); the keeper sends distribute and expire",
  buildStakeClaimMessage: "a stake position exists only after buildStakeMessage; see above",
  buildStakeWithdrawMessage: "same",
  buildStakeExpireMessage: "same — permissionless, but the keeper already pokes every matured position",
  buildStakeRelockMessage: "same",
  buildExecuteProposalMessage: "permissionless, but it can only execute a proposal the above can open",
  buildPruneProposalMessage:
    "D-188 point 7's permissionless housekeeping: it deletes a settled proposal and moves nothing, " +
    "and every propose already prunes the two oldest due rows, so no game action needs it",
};

describe("every program-player ACTION has an SDK method", () => {
  const builders = () =>
    [...source("../../../shared/messages.ts").matchAll(/^export function (build\w+|encodeInviteListCell)\(/gm)].map(
      (m) => m[1],
    );

  it("names every builder in shared/messages.ts as wired or excluded", () => {
    const found = builders();
    expect(found.length).toBeGreaterThan(10); // the regex still matches something

    const unaccounted = found.filter((b) => !(b in WIRED_ACTIONS) && !(b in EXCLUDED_ACTIONS));
    expect(unaccounted).toEqual([]);
  });

  it("classifies no builder that has since been deleted", () => {
    const found = new Set(builders());
    const stale = [...Object.keys(WIRED_ACTIONS), ...Object.keys(EXCLUDED_ACTIONS)].filter((b) => !found.has(b));
    expect(stale).toEqual([]);
  });

  it("every wired builder points at a method this SDK actually has", () => {
    const agent = new PrimesAgent();
    for (const [builder, method] of Object.entries(WIRED_ACTIONS)) {
      expect(typeof agent[method], `${builder} -> ${String(method)}`).toBe("function");
    }
  });

  it("gives every exclusion a reason a reader can weigh, not a shrug", () => {
    for (const [builder, reason] of Object.entries(EXCLUDED_ACTIONS)) {
      expect(reason.length, builder).toBeGreaterThan(3);
    }
  });
});

// ===========================================================================
// 2. Every published READ
// ===========================================================================

/** Wired: OpenAPI path -> the `PrimesRead` method that reads it. */
const WIRED_READS: Record<string, keyof PrimesRead> = {
  // --- read-proxy: the ledger and the ratchet -------------------------------
  "/bootstrap": "bootstrap",
  "/contracts": "contracts",
  "/ledger/head": "head",
  "/ledger/floor": "floor",
  "/ledger/counters": "counters",
  "/ledger/T": "counters",
  "/ledger/S": "counters",
  "/ledger/k": "k",
  "/ledger/kmax": "kMax",
  "/ledger/last-mint-time": "lastMintTime",
  "/ledger/seed-t": "seedT",
  "/ledger/invite-terms": "inviteTerms",
  "/ledger/era-leader": "eraLeader",
  "/ratchet/pending": "pending",
  "/ratchet/swapped": "swapped",
  "/ratchet/flush-status": "flushStatus",
  "/ratchet/floor-cache": "floorCache",
  "/ratchet/staking": "staking",
  "/ratchet/identity": "ratchetIdentity",
  "/ratchet/harvest-gates": "harvestGates",
  "/ledger/ops-sweep": "opsSweep",
  // --- read-proxy: one wallet ----------------------------------------------
  "/wallet/{address}/balance": "balance",
  "/wallet/{address}/seqno": "seqno",
  "/primes/wallet/{address}": "primesBalance",
  "/ranks/{address}": "ranks",
  "/earn/{address}": "earn",
  // --- read-proxy: numbers, lots and prices ---------------------------------
  "/number/{n}": "number",
  "/number/{n}/prime": "isKnownPrime",
  "/number/{n}/name": "name",
  "/number/{n}/trophy": "numberTrophy",
  "/number/{n}/runway": "runway",
  "/number/{n}/tribute": "tributeTotal",
  "/item/{n}/address": "itemAddress",
  "/numbers": "numbers",
  "/assets/{n}/yield": "yieldOf",
  "/trophy": "trophy",
  "/trophy/params": "trophyParams",
  "/trophy/lot/{n}": "lot",
  "/trophy/price/{n}": "lotPrice",
  "/trophy/score/{n}": "score",
  "/trophy/floor/{n}": "lotFloor",
  "/number/{n}/off-head": "isOffHead",
  "/lots/fee-split": "feeSplit",
  // --- read-proxy: collections ---------------------------------------------------
  "/collections": "collections",
  // --- read-proxy: the bounty vault -----------------------------------------
  "/vault": "vault",
  "/vault/era/{n}": "eraSchedule",
  "/vault/rebate/{kind}/{n}": "rebate",
  "/vault/program/{tag}": "vaultProgram",
  // --- read-proxy: the auditor's surfaces ------------------------------------
  "/supply": "supply",
  "/solvency": "solvency",
  "/venue": "venue",
  "/market": "market",
  "/vesting": "vesting",
  "/treasury": "treasury",
  "/treasury/proposals": "treasuryProposals",
  "/stake": "stake",
  "/stake/{address}": "stakePositions",
  "/lp/positions/{address}": "lpPositions",
  "/lp/locked": "lpLocked",
  "/lp/wallet/{address}": "lpWallet",
  // --- read-index ------------------------------------------------------------
  "/index/status": "indexStatus",
  "/lots/open": "openLots",
  "/lots/{n}": "lotHistory",
  "/market/cheapest": "cheapestLot",
  "/treasury/ledger": "treasuryLedger",
  "/stake/ledger": "stakeLedger",
  "/offers/unclaimed": "unclaimedOffers",
  "/boards/recruiters": "board",
  "/boards/prime-finders": "board",
  "/boards/era": "board",
  "/boards/mints": "board",
  "/boards/referrals": "board",
  "/feed/mints": "feed",
  "/feed/floor": "feed",
  "/wallets/{address}/numbers": "numbersOf",
  "/wallets/{address}/claims": "claimsOf",
  "/wallets/{address}/history": "historyOf",
  "/wallets/{address}/contest": "contestOf",
  "/portfolio/{address}": "portfolioOf",
};

/**
 * Deliberately NOT wired.
 *
 * Three kinds, and each is a statement about the ENDPOINT rather than about the effort:
 * an operational probe, a stream rather than a request, or a document served for a
 * different consumer entirely (a wallet's metadata fetcher, a browser's `<img>`).
 */
const EXCLUDED_READS: Record<string, string> = {
  "/health": "a liveness probe. It reports on the SERVICE, not on the game — nothing here is chain state",
  "/events":
    "Server-Sent Events: a long-lived push stream, not a request/response read. A client that wants it " +
    "opens an EventSource against the URL; wrapping it in a paced GET would misrepresent what it is",
  "/launch": "the landing page's countdown copy, which is deployment configuration rather than chain state",
  "/feed": "the event poller's own composite feed. The SDK reads the read-index's three typed `/feed/*` instead",
  "/attrition": "a retention narrative computed for the webapp's own charts; no get-method stands behind it",
  "/leaderboard/tribute":
    "the event poller's board. The read-index serves the same standings with per-row provenance " +
    "and a chain tip, and `board()` reads those",
  "/number/{n}/referrals": "one referral key's count; the read-index's `/boards/referrals` is the board, same reason",
  "/wallets/{address}/earn-facts": "the /earn page's own event-index read; not an agent-facing question",
  "/primes/{p}/ledger":
    "replayed credit arithmetic no get-method returns; an agent reads `getOwed(p)`, which is authoritative",
  "/lots/won": "the auction ClaimBook's won-lot list; ownership is `getNumberData()`, which `numbers()` reads",
  "/nft/{file}": "rendered artwork (PNG/SVG/TGS). Binary, for a browser, not a figure",
  "/sitemap-numbers.xml": "the crawler's sitemap index (SEO_PLAN 4.2). XML for a search engine, not a figure",
  "/sitemap-numbers-{page}.xml": "one sitemap page of minted numbers' URLs (SEO_PLAN 4.2); an agent reads `feed`",
  "/unfurl/{family}/{n}":
    "head tags for nginx to SSI-include into a number page (SEO_PLAN 4.1). HTML for a crawler, not a figure; an agent has `factorize`",
};

describe("every published READ has an SDK method", () => {
  /** The `paths:` keys of an OpenAPI document, without a YAML parser for one field. */
  const pathsOf = (rel: string) =>
    [...source(rel).matchAll(/^ {2}(\/[A-Za-z0-9_\-/{}.]*):\s*$/gm)].map((m) => m[1]);

  const proxyPaths = () => pathsOf("../../../shared/openapi/read-proxy.yaml");
  const indexPaths = () => pathsOf("../../../shared/openapi/read-index.yaml");

  it("finds the specs and both are non-trivial", () => {
    expect(proxyPaths().length).toBeGreaterThan(40);
    expect(indexPaths().length).toBeGreaterThan(10);
  });

  it("names every read-proxy path as wired or excluded", () => {
    const unaccounted = proxyPaths().filter((p) => !(p in WIRED_READS) && !(p in EXCLUDED_READS));
    expect(unaccounted).toEqual([]);
  });

  it("names every read-index path as wired or excluded", () => {
    const unaccounted = indexPaths().filter((p) => !(p in WIRED_READS) && !(p in EXCLUDED_READS));
    expect(unaccounted).toEqual([]);
  });

  it("classifies no path that has since been deleted from either spec", () => {
    const live = new Set([...proxyPaths(), ...indexPaths()]);
    const stale = [...Object.keys(WIRED_READS), ...Object.keys(EXCLUDED_READS)].filter((p) => !live.has(p));
    expect(stale).toEqual([]);
  });

  it("every wired path points at a method PrimesRead actually has", () => {
    const read = new PrimesRead();
    for (const [path, method] of Object.entries(WIRED_READS)) {
      expect(typeof read[method], `${path} -> ${String(method)}`).toBe("function");
    }
  });

  it("covers the published surface, and says by how much", () => {
    const all = new Set([...proxyPaths(), ...indexPaths()]);
    const wired = [...all].filter((p) => p in WIRED_READS);
    // Not a vanity figure: it is what stops an exclusion list from quietly becoming the
    // whole spec. If this ever falls, a route was excluded that should have been wired.
    // Measured over READS: the documents served to a browser or a crawler (artwork, head
    // tags, sitemaps — SEO_PLAN 4.1/4.2) are no agent's question, so they are not counted.
    const documents = ["/nft/{file}", "/unfurl/{family}/{n}", "/sitemap-numbers.xml", "/sitemap-numbers-{page}.xml"];
    expect(wired.length / (all.size - documents.filter((p) => all.has(p)).length)).toBeGreaterThan(0.85);
    // Exact, not an inequality: both sides dedupe a path that appears in BOTH specs
    // (`/health` is the only one today), so the two counts must agree to the entry.
    expect(all.size).toBe(Object.keys(WIRED_READS).length + Object.keys(EXCLUDED_READS).length);
  });

  it("gives every exclusion a reason a reader can weigh, not a shrug", () => {
    for (const [path, reason] of Object.entries(EXCLUDED_READS)) {
      expect(reason.length, path).toBeGreaterThan(20);
    }
  });
});

// ===========================================================================
// 3. The published TYPE surface
// ===========================================================================

describe("the README documents the surface it actually has", () => {
  /**
   * A published README IS the API reference for most readers, and the drift that matters is
   * silent in both directions: a method listed but deleted sends somebody to a name that no
   * longer resolves, and a method shipped but unlisted is a feature nobody finds. Both are
   * the same class of bug as an unwired route, so they fail the same suite.
   */
  const readme = () => source("../README.md");

  /** The names in the README's "### Reads" section, which is its inventory of `PrimesRead`. */
  const documented = () => {
    const section = readme().split("### Reads")[1]?.split("### Helpers")[0] ?? "";
    return new Set([...section.matchAll(/`(\w+)`/g)].map((m) => m[1]));
  };

  /** Everything on the class that is an endpoint rather than a generic escape hatch. */
  const actual = () => {
    const SKIP = new Set(["constructor", "get", "bounty", "proxy", "index", "events"]);
    return Object.getOwnPropertyNames(PrimesRead.prototype).filter((m) => !SKIP.has(m));
  };

  it("lists every read method the class has", () => {
    const docs = documented();
    expect(actual().filter((m) => !docs.has(m))).toEqual([]);
  });

  it("lists no read method the class does not have", () => {
    // The section also names the two classes and the three escape hatches in prose; those
    // are the only non-method backticked words allowed in it.
    const PROSE = new Set(["PrimesRead", "PrimesChain", "runMethod", "proxy", "index", "events", "T", "path"]);
    const have = new Set(actual());
    expect([...documented()].filter((n) => !have.has(n) && !PROSE.has(n))).toEqual([]);
  });

  it("names every action in the actions table", () => {
    const table = readme().split("### Actions")[1]?.split("### Reads")[0] ?? "";
    const missing = Object.values(WIRED_ACTIONS).filter((m) => !table.includes(`\`${String(m)}(`));
    expect(missing).toEqual([]);
  });
});

describe("the package's own entry point stays coherent", () => {
  it("exports every class, helper and constant the README tells a reader to import", async () => {
    const mod = await import("../src/index.ts");
    for (const name of [
      "PrimesAgent",
      "PrimesRead",
      "PrimesChain",
      "LocalWallet",
      "factorize",
      "isqrt",
      "isProbablePrime",
      "NAME_MAX_CHARS",
      "BID_FEE_MARGIN",
    ]) {
      expect(mod, name).toHaveProperty(name);
    }
  });

  it("gives PrimesRead a method for every service it talks to", () => {
    const read = new PrimesRead();
    // The three escape hatches, one per base URL, so an endpoint this file has not
    // classified yet is still reachable without forking the package.
    for (const m of ["proxy", "index", "events"] as const) {
      expect(typeof read[m], m).toBe("function");
    }
  });
});
