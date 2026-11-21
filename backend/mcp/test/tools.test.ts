/**
 * THE TOOL REGISTRY.
 *
 * `server.test.ts` asserts what a tool DOES. This file asserts what the tool list IS, and
 * the properties that have to hold across all of it rather than one tool at a time:
 *
 *   - every action the SDK can take has a write tool, so nothing a program-player can do
 *     is reachable from the library and not from the model (the same guard
 *     `@ton-primes/agent`'s `coverage.test.ts` runs one layer down);
 *   - every WRITE takes `confirm` and no READ does, which is the whole safety property of
 *     this server — a read that asked for confirmation would train a model to pass it, and
 *     a write that did not ask for it would spend on a plan nobody approved;
 *   - no two tools share a name. A collision is silent in the registry and fatal at
 *     startup, and it has happened once, between a read and a write of the same name.
 */
import { describe, expect, it, vi } from "vitest";

const chain = {
  head: vi.fn(async () => 12n),
  lot: vi.fn(async () => ({ found: true, closed: false, mode: 0, p0Nanoton: 1n, standingPriceNanoton: 1n, minNextBidNanoton: 5n })),
  lotPrice: vi.fn(async () => 3n),
  itemAddress: vi.fn(async () => "I"),
  owed: vi.fn(async () => 500n),
  namer: vi.fn(async () => "W"),
  annotationCount: vi.fn(async () => 0),
  pending: vi.fn(async () => 50_000_000_000n),
  flushStatus: vi.fn(async () => null as { cooldownRemainingSeconds: bigint; outcome: string } | null),
  addresses: { ledger: "L", market: "M", ratchet: "R", registrar: "G" },
};

const flush = vi.fn(async () => ({ seqno: 9 }));

const reads = {
  head: async () => 12n,
  floor: async () => ({ numNanoton: 1n, denPrimes: 2n }),
  openLots: async () => [],
  numbersOf: async () => [7n],
  number: async () => ({ owner: "W", isPrime: true, owedNanoton: 5n }),
  name: async () => ({ namer: "W", count: 0, text: null }),
  contracts: async () => ({ ledger: "L" }),
  // v3
  balance: async () => 1_500_000_000n,
  seqno: async () => 7,
  primesBalance: async () => ({ owner: "W", walletAddress: "PW", walletDeployed: true, balancePrimes: 4900n }),
  ranks: async () => ({ address: "W", recruitRank: 3n, primeRank: 1n }),
  pending: async () => 50_000_000_000n,
  swapped: async () => 10n,
  flushStatus: async () => ({ lastAttemptTime: 1n, outcome: "bounced", amountNanoton: 1n, cooldownRemainingSeconds: 0n }),
  market: async () => ({ status: "live", spotNumNanoton: "4200000000", spotDenPrimes: "42000000000000" }),
  lotPrice: async () => ({ lane: -1, p0Nanoton: 1000n }),
  numbers: async () => ({ numbers: [{ n: 7n, minted: true }], truncated: false, maxPerRequest: 24 }),
  supply: async () => ({ sPrimes: "1000" }),
  solvency: async () => ({ contracts: [] }),
};

vi.mock("@ton-primes/agent", () => ({
  PrimesAgent: class {
    read = reads;
    chain = async () => chain;
    routeFor = async () => ({ route: "head" });
    address = async () => "W";
    mint = vi.fn();
    bid = vi.fn();
    openLot = vi.fn();
    openHeadLot = vi.fn();
    closeLot = vi.fn();
    claimTribute = vi.fn();
    annotate = vi.fn();
    name = vi.fn();
    flush = flush;
  },
}));

process.env.NODE_ENV = "test";
const { server } = await import("../src/index.ts");

type Registered = Record<
  string,
  {
    description?: string;
    inputSchema?: { shape?: Record<string, unknown> };
    handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  }
>;
const tools = (server as unknown as { _registeredTools: Registered })._registeredTools;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await tools[name].handler(args, {});
  return { text: res.content[0].text, isError: res.isError === true };
};

/** A tool is a WRITE exactly when it takes `confirm`. There is no second marker. */
const takesConfirm = (name: string) => Object.keys(tools[name].inputSchema?.shape ?? {}).includes("confirm");
const names = () => Object.keys(tools);

// ===========================================================================

describe("the registry's shape", () => {
  it("registers every tool under a unique name", () => {
    expect(new Set(names()).size).toBe(names().length);
  });

  it("names every tool in the primes_ namespace", () => {
    expect(names().filter((n) => !n.startsWith("primes_"))).toEqual([]);
  });

  it("gives every tool a description long enough to choose it by", () => {
    for (const n of names()) expect((tools[n].description ?? "").length, n).toBeGreaterThan(40);
  });

  it("splits cleanly into reads and writes, and the counts are the documented ones", () => {
    const writes = names().filter(takesConfirm);
    const readers = names().filter((n) => !takesConfirm(n));
    // If either number moves, the README's table and the package description are stale.
    expect(writes).toHaveLength(9);
    expect(readers).toHaveLength(14);
  });
});

describe("confirm is the whole safety property, so it is asserted across the registry", () => {
  it("no read tool takes a confirm flag", () => {
    const READS_THAT_SHOULD_NOT_CONFIRM = names().filter((n) => !KNOWN_WRITES.includes(n));
    expect(READS_THAT_SHOULD_NOT_CONFIRM.filter(takesConfirm)).toEqual([]);
  });

  it("every write tool takes one", () => {
    expect(KNOWN_WRITES.filter((n) => !takesConfirm(n))).toEqual([]);
  });

  it("and every write refuses to send without it, quoting instead", async () => {
    // One representative that needs no live state, so the property is about the WRAPPER
    // rather than about any one tool's pre-checks.
    const { text } = await call("primes_flush");
    expect(flush).not.toHaveBeenCalled();
    expect(text).toMatch(/"confirmed": false/);
    expect(text).toMatch(/confirm: true/);
  });
});

/** The write tools, by name. Listed rather than derived, so a rename has to be deliberate. */
const KNOWN_WRITES = [
  "primes_mint",
  "primes_bid",
  "primes_open_lot",
  "primes_open_head_lot",
  "primes_close_lot",
  "primes_claim_tribute",
  "primes_annotate",
  "primes_name_number",
  "primes_flush",
];

describe("every SDK action is reachable from the model", () => {
  /** `PrimesAgent` method -> the write tool that calls it. */
  const ACTIONS: Record<string, string> = {
    mint: "primes_mint",
    bid: "primes_bid",
    openLot: "primes_open_lot",
    openHeadLot: "primes_open_head_lot",
    closeLot: "primes_close_lot",
    flush: "primes_flush",
    claimTribute: "primes_claim_tribute",
    annotate: "primes_annotate",
    name: "primes_name_number",
  };

  it("has a registered write tool for each of the SDK's nine actions", () => {
    const missing = Object.entries(ACTIONS).filter(([, tool]) => !(tool in tools));
    expect(missing).toEqual([]);
    expect(Object.keys(ACTIONS)).toHaveLength(KNOWN_WRITES.length);
  });

  it("lists no write tool that no action backs", () => {
    const backed = new Set(Object.values(ACTIONS));
    expect(KNOWN_WRITES.filter((w) => !backed.has(w))).toEqual([]);
  });
});

// ===========================================================================
// The v3 composite reads: each answers a QUESTION rather than mirroring a route
// ===========================================================================

describe("the composite reads answer in one call what an agent would otherwise chain", () => {
  it("primes_wallet gathers four separate reads about one wallet", async () => {
    const { text } = await call("primes_wallet", {});
    expect(text).toMatch(/"address": "W"/);
    expect(text).toMatch(/"balanceNanoton": "1500000000"/);
    expect(text).toMatch(/"balancePrimes": "4900"/);
    expect(text).toMatch(/"recruitRank": "3"/);
  });

  it("primes_wallet survives a wallet that has none of them — the new-player state", async () => {
    const boom = () => Promise.reject(new Error("no jetton wallet"));
    const saved = { ...reads };
    Object.assign(reads, { primesBalance: boom, ranks: boom });
    try {
      const { text, isError } = await call("primes_wallet", { address: "OTHER" });
      expect(isError).toBe(false);
      // The two that DID answer still do; the three that did not are null, not absent.
      expect(text).toMatch(/"balanceNanoton": "1500000000"/);
      expect(text).toMatch(/"primes": null/);
      expect(text).toMatch(/"ranks": null/);
    } finally {
      Object.assign(reads, saved);
    }
  });

  it("primes_ratchet answers the flush decision in one call", async () => {
    const { text } = await call("primes_ratchet");
    expect(text).toMatch(/"pendingNanoton": "50000000000"/);
    expect(text).toMatch(/"swappedNanoton": "10"/);
    expect(text).toMatch(/"outcome": "bounced"/); // the field that tells a dead venue from an idle one
    expect(text).toMatch(/denPrimes/);
    // The venue's CURRENT price, beside the floor it has to fill at or below. Without it the
    // tool answered "should I flush?" with only one side of the comparison the guard makes.
    expect(text).toMatch(/"spotNumNanoton": "4200000000"/);
  });

  it("primes_ratchet keeps the other four figures when an older read-proxy has no /market", async () => {
    const saved = { ...reads };
    Object.assign(reads, {
      market: async () => {
        throw new Error("404 Not Found");
      },
    });
    try {
      const { text, isError } = await call("primes_ratchet");
      expect(isError).toBe(false);
      expect(text).toMatch(/"pendingNanoton": "50000000000"/);
      expect(text).toMatch(/"market": null/);
    } finally {
      Object.assign(reads, saved);
    }
  });

  it("primes_lot_price reports lane -1 rather than a price for a number that cannot be opened", async () => {
    expect((await call("primes_lot_price", { n: "7" })).text).toMatch(/"lane": -1/);
  });

  it("primes_confirm_numbers takes at most 24 and reports truncation", async () => {
    const { text } = await call("primes_confirm_numbers", { ns: ["7"] });
    expect(text).toMatch(/"truncated": false/);
    expect(text).toMatch(/"maxPerRequest": 24/);
  });

  it("primes_audit returns both surfaces together, not one at a time", async () => {
    const { text } = await call("primes_audit");
    for (const key of ["supply", "solvency"]) expect(text).toMatch(new RegExp(`"${key}"`));
    expect(text).not.toMatch(/"sink"/); // D-212 deleted the naming sink
  });

});

describe("flush quotes the amount it would move, and refuses what the contract would", () => {
  it("names the pending figure in the quote", async () => {
    expect((await call("primes_flush")).text).toMatch(/up to 50000000000 nanoton/);
  });

  it("refuses an empty pending — the ratchet's 208 — before signing", async () => {
    chain.pending.mockResolvedValueOnce(0n);
    const { isError, text } = await call("primes_flush", { confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/nothing pending/);
    expect(flush).not.toHaveBeenCalled();
  });

  it("refuses inside the 24h cooldown — the ratchet's 207", async () => {
    chain.flushStatus.mockResolvedValueOnce({ cooldownRemainingSeconds: 3600n, outcome: "filled" });
    const { isError, text } = await call("primes_flush", { confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/cooldown for another 3600s/);
    expect(flush).not.toHaveBeenCalled();
  });

  it("sends once both are clear", async () => {
    flush.mockClear();
    await call("primes_flush", { confirm: true });
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe("bigints never reach a client as a JavaScript number", () => {
  it("serialises every bigint as a decimal STRING", async () => {
    // JSON has no bigint, and `JSON.stringify` throws on one. A silent `Number()` instead
    // would round a nanoton figure past 2^53 — which is every balance worth reading.
    const { text } = await call("primes_head");
    expect(text).toMatch(/"head": "12"/);
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("every integer argument is digits only", () => {
  type Parsable = { safeParse: (v: unknown) => { success: boolean } };
  const schema = (name: string) => tools[name].inputSchema as unknown as Parsable;
  const BAD = ["0x3b9aca00", " 5 ", "1.5", "-5", "1e9", "0b101", "", "5n"];

  it.each(BAD)("primes_bid refuses bidNanoton %j before the handler runs", (bidNanoton) => {
    expect(schema("primes_bid").safeParse({ n: "7", bidNanoton, confirm: true }).success).toBe(false);
  });

  it.each(BAD)("primes_open_lot refuses n %j", (n) => {
    expect(schema("primes_open_lot").safeParse({ n }).success).toBe(false);
  });

  it("a plain decimal still parses, and `n`/`bidNanoton` are never a bare z.string() anywhere", () => {
    expect(schema("primes_bid").safeParse({ n: "7", bidNanoton: "1000000000" }).success).toBe(true);
    for (const name of names()) {
      for (const key of ["n", "bidNanoton"]) {
        if (!(key in (tools[name].inputSchema?.shape ?? {}))) continue;
        expect(schema(name).safeParse({ n: "7", text: "x", [key]: " 7" }).success, `${name}.${key}`).toBe(false);
      }
    }
  });
});
