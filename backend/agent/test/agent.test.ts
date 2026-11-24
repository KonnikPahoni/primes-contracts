/**
 * THE SPENDING RULES.
 *
 * Three things here can cost a caller real GRAM, so three things are asserted throughout:
 * that a LIVE read gates every spend (§9.1), that the bodies are the shared builders' own
 * bytes and not a fourth transcription of the wire format, and that the rate-limit
 * contract is honoured rather than retried in a loop (`MISTAKES.md`'s genesis 429).
 *
 * The shape repeats on purpose. Every `act` method makes, before it opens a wallet, the
 * refusal the CONTRACT would make on arrival — so getting it wrong costs a thrown `Error`
 * rather than gas. Each block below asserts both halves: that the refusal happens, and
 * that nothing was sent.
 *
 * Its two companions: `read.test.ts` (one case per endpoint, envelope by envelope) and
 * `coverage.test.ts` (the guard that every published action and route has a method).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { beginCell } from "@ton/core";
import { buildMintMessage } from "@ton-primes/shared/messages";
import type { FactorEntry as SharedFactorEntry } from "@ton-primes/shared/factors";
import { NAME_MAX_CHARS as SHARED_NAME_MAX_CHARS, type MintInvites as SharedMintInvites } from "@ton-primes/shared/messages";
import type { PrimeFactor } from "@ton-primes/shared/primality";
import { Address } from "@ton/core";
import {
  buildAnnotateMessage,
  buildNameNumberMessage,
  buildClaimTributeMessage,
  buildFlushMessage,
  buildHarvestMessage,
  buildSweepOpsMessage,
  buildOpenLotMessage,
  buildTransferTrophyMessage,
} from "@ton-primes/shared/messages";
import {
  PrimesAgent,
  PrimesRead,
  factorize,
  isqrt,
  NAME_MAX_CHARS,
  type FactorEntry,
  type MintInvites,
} from "../src/index.ts";

const ADDR = "EQD__________________________________________0vo";
const ADDRESSES = { ledger: ADDR, market: ADDR, ratchet: ADDR, registrar: ADDR, collection: ADDR };

/** This wallet, as the fake signs it. Normalised, because every ownership check compares
 *  `Address.parse(x).toString()` on both sides rather than raw strings. */
const ME = Address.parse(ADDR).toString();
/** Somebody else: an all-0x01 account id. A valid address that is nobody's wallet. */
const OTHER = Address.parse("EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j").toString();

/** A `PrimesAgent` whose chain reads and wallet sends are captured instead of performed. */
function fakeAgent(chain: Partial<Record<string, unknown>>, addresses: Record<string, string> = ADDRESSES) {
  const sent: { to: string; bodyHash: string; value: bigint }[] = [];
  const agent = new PrimesAgent({ mnemonic: "x ".repeat(24).trim(), addresses: addresses as never });
  // The two seams: what the chain says, and where a signed body would go.
  agent.chain = async () => ({ addresses, ...chain }) as never;
  agent.wallet = async () =>
    ({
      address: Address.parse(ADDR),
      send: async (to: string, body: { hash(): Buffer }, value: bigint) => {
        sent.push({ to, bodyHash: body.hash().toString("hex"), value });
        return { seqno: 1 };
      },
    }) as never;
  return { agent, sent };
}

describe("PrimesAgent — a live read gates every spend (CONCEPT.md §9.1)", () => {
  it("mints the head, and sends the shared builder's bytes", async () => {
    const { agent, sent } = fakeAgent({ head: async () => 12n });
    await agent.mint();
    const expected = buildMintMessage({
      ledger: Address.parse(ADDRESSES.ledger),
      payer: Address.parse(ADDR),
      n: 12n,
      kind: 0,
      factors: factorize(12n).map((f) => ({ ...f, s: isqrt(f.prime) })),
      referralKey: 0,
      beneficiary: null,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].bodyHash).toBe(expected.body.hash().toString("hex"));
    // D-191 point 1: to the payer's own minter card, not to the ledger.
    expect(sent[0].to).toBe(expected.to.toString());
    // 1 GRAM plus the fee margin, never the exact nominal — the contract compares the
    // value that ARRIVES, after GRAM takes the forward fee.
    expect(sent[0].value).toBe(expected.value);
    expect(sent[0].value).toBeGreaterThan(1_000_000_000n);
  });

  it("carries an UNSIGNED invite list into the shared builder's bytes (D-202)", async () => {
    const { agent, sent } = fakeAgent({ head: async () => 12n });
    const invites: MintInvites = { count: 3, addresses: [{ slot: 1, address: OTHER }, { slot: 2, address: ME }] };
    await agent.mint({ invites });
    const base = {
      ledger: Address.parse(ADDRESSES.ledger),
      payer: Address.parse(ADDR),
      n: 12n,
      kind: 0 as const,
      factors: factorize(12n).map((f) => ({ ...f, s: isqrt(f.prime) })),
      referralKey: 0,
      beneficiary: null,
    };
    const hash = (m: { body: { hash(): Buffer } }) => m.body.hash().toString("hex");
    expect(sent[0].bodyHash).toBe(hash(buildMintMessage({ ...base, invites })));
    expect(sent[0].bodyHash).not.toBe(hash(buildMintMessage(base))); // the list is really in the body
  });

  it("refuses a mint for a number that is not the head, without opening a wallet", async () => {
    const { agent, sent } = fakeAgent({ head: async () => 12n });
    await expect(agent.mint({ n: 99n })).rejects.toThrow(/not the head/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a bid under the LIVE minPayment, and defaults to it when none is given", async () => {
    const lot = { found: true, closed: false, mode: 0, p0Nanoton: 1n, standingPriceNanoton: 1n, minNextBidNanoton: 5_000_000_000n };
    const { agent, sent } = fakeAgent({ lot: async () => lot });
    await expect(agent.bid({ n: 7n, bidNanoton: 4_000_000_000n })).rejects.toThrow(/under the live minPayment/);
    expect(sent).toHaveLength(0);
    await agent.bid({ n: 7n });
    expect(sent[0].value).toBeGreaterThan(lot.minNextBidNanoton);
  });

  it("refuses a bid on a lot that does not exist or already sold", async () => {
    const closed = { found: true, closed: true, mode: 2, p0Nanoton: 0n, standingPriceNanoton: 0n, minNextBidNanoton: 0n };
    await expect(fakeAgent({ lot: async () => closed }).agent.bid({ n: 7n })).rejects.toThrow(/closed/);
    const none = { found: false, closed: false, mode: 0, p0Nanoton: 0n, standingPriceNanoton: 0n, minNextBidNanoton: 0n };
    await expect(fakeAgent({ lot: async () => none }).agent.bid({ n: 7n })).rejects.toThrow(/no lot/);
  });

  /** F68 / D-88 point 3: ahead of the head a prime opens on the ascending lane too, with
   *  `kind: 1` and no factors — the same body the webapp's `handleOpen` builds. */
  it("opens a prime with kind 1 and no factors, and a composite with kind 0 and its factorization", async () => {
    const { agent, sent } = fakeAgent({ lotPrice: async () => 2_000_000_000n, isOffHead: async () => false });
    await agent.openLot({ n: 13n });
    await agent.openLot({ n: 12n });
    const body = (kind: 0 | 1, n: bigint, factors: SharedFactorEntry[]) =>
      buildOpenLotMessage({ n, kind, factors, referralKey: 0, beneficiary: null, bidNanoton: 2_000_000_000n }).body.hash().toString("hex");
    expect(sent.map((s) => s.bodyHash)).toEqual([
      body(1, 13n, []),
      body(0, 12n, [{ prime: 2n, exponent: 2, s: 1n }, { prime: 3n, exponent: 1, s: 1n }]),
    ]);
  });

  it("routeFor reads the head and the lot, and never says 'wait' for a number behind it", async () => {
    const { agent } = fakeAgent({
      head: async () => 20n,
      isKnownPrime: async () => false,
      isOffHead: async () => false,
      lot: async () => ({ found: false, closed: false, mode: 0, p0Nanoton: 0n, standingPriceNanoton: 0n, minNextBidNanoton: 0n }),
    });
    expect((await agent.routeFor(5n)).route).toBe("past");
    expect((await agent.routeFor(20n)).route).toBe("head");
    expect((await agent.routeFor(50n)).route).toBe("lot");
  });

  it("D-196: a number a lot already claimed reads `claimed`, and openLot refuses it before signing", async () => {
    const { agent, sent } = fakeAgent({
      head: async () => 20n,
      isKnownPrime: async () => false,
      isOffHead: async () => true,
      lotPrice: async () => 2_000_000_000n,
      lot: async () => ({ found: false, closed: false, mode: 0, p0Nanoton: 0n, standingPriceNanoton: 0n, minNextBidNanoton: 0n }),
    });
    expect((await agent.routeFor(5000n)).route).toBe("claimed");
    await expect(agent.openLot({ n: 5000n })).rejects.toThrow(/already claimed/);
    expect(sent).toHaveLength(0);
  });

  it("a read-only agent refuses to sign rather than failing at send time", async () => {
    await expect(new PrimesAgent({ addresses: ADDRESSES }).mint()).rejects.toThrow(/read-only/);
  });
});

describe("PrimesRead — the rate-limit contract", () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as Response;
  const tooMany = () =>
    ({ ok: false, status: 429, json: async () => ({}), text: async () => "", headers: new Headers({ "retry-after": "0" }) }) as Response;

  it("retries a 429 once, honouring Retry-After, then gives up loudly", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(ok({ data: { head: "42" } }));
    const read = new PrimesRead({ fetchImpl, rps: 1000 });
    expect(await read.head()).toBe(42n);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const always = vi.fn<typeof fetch>().mockResolvedValue(tooMany());
    await expect(new PrimesRead({ fetchImpl: always, rps: 1000 }).head()).rejects.toThrow(/429 twice/);
    expect(always).toHaveBeenCalledTimes(2); // not a loop
  });

  it("reads the floor as a RATIO, never pre-divided", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      ok({ data: { floorNumNanoton: "7", floorDenPrimes: "3" } }),
    );
    expect(await new PrimesRead({ fetchImpl, rps: 1000 }).floor()).toEqual({ numNanoton: 7n, denPrimes: 3n });
  });
});

/**
 * The SDK restates the proof helpers' signatures instead of forwarding them, because a
 * published `.d.ts` may not name `@ton-primes/shared` (a workspace package, bundled into
 * `dist/` and never published). These assignments are the pin: if either side's shape
 * moves, the restatement stops compiling and `typecheck` fails.
 */
const _pinFactorEntry: SharedFactorEntry = {} as FactorEntry;
const _pinFactorEntryBack: FactorEntry = {} as SharedFactorEntry;
const _pinFactorize: (n: bigint) => PrimeFactor[] = factorize;
const _pinInvites: SharedMintInvites = {} as MintInvites;
const _pinInvitesBack: MintInvites = {} as SharedMintInvites;
void _pinFactorEntry;
void _pinFactorEntryBack;
void _pinFactorize;
void _pinInvites;
void _pinInvitesBack;

describe("the proof helpers are the contract's own", () => {
  it("factorize + isqrt produce the ⌊√p⌋ the ledger checks with two multiplies", () => {
    for (const f of factorize(360n).map((f) => ({ ...f, s: isqrt(f.prime) }))) {
      expect(f.s * f.s).toBeLessThanOrEqual(f.prime);
      expect(f.prime).toBeLessThan((f.s + 1n) * (f.s + 1n));
    }
    void beginCell;
  });
});

describe("the published surface never names an unpublished package (AGENTS_PLAN.md A5)", () => {
  /**
   * `@ton-primes/shared` and `@ton-primes/common` are bundled into `dist/` and never
   * published, so any way their NAME reaches the emitted `.d.ts` breaks `tsc` for whoever
   * installs this from npm. There are THREE ways, and this covers all three — the first
   * version of this guard only covered the first, and `NAME_MAX_CHARS` slipped through it.
   *
   * 1. `export { X } from "@ton-primes/..."` — a direct re-export.
   * 2. `import { X } from "@ton-primes/..."` followed by a bare `export { X }`, which the
   *    bundler collapses back into form 1.
   * 3. a shared TYPE named in a public signature, which lands as an `import type`.
   *
   * The fix for all three is the same and is what the file does: import under an alias,
   * restate the name locally, delegate the body, and pin the restatement to the original
   * with a type assertion above so a drift fails `typecheck` rather than a consumer.
   */
  const src = () => readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("re-exports nothing straight out of @ton-primes/*", () => {
    const leaks = src()
      .split(/\r?\n/)
      .filter((l) => /^\s*export[^;]*from\s+["']@ton-primes\//.test(l));
    expect(leaks).toEqual([]);
  });

  it("never exports a name it imported from @ton-primes/* under that same name", () => {
    const text = src();
    const imported = new Set<string>();
    for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@ton-primes\/[^"']*["']/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "");
        // `X as Y` is the aliased form — the LOCAL name is Y, and Y is what a bare
        // `export { Y }` would collapse back into a re-export of X.
        const local = name.includes(" as ") ? name.split(" as ")[1].trim() : name;
        if (local) imported.add(local);
      }
    }
    expect(imported.size).toBeGreaterThan(5); // the matcher still matches something

    const reexported: string[] = [];
    for (const m of text.matchAll(/^\s*export\s*\{([^}]*)\}\s*;/gm)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(" as ")[0].trim();
        if (imported.has(name)) reexported.push(name);
      }
    }
    expect(reexported).toEqual([]);
  });

  it("pins the restated constant to the shared original", () => {
    expect(NAME_MAX_CHARS).toBe(SHARED_NAME_MAX_CHARS);
  });
});

/**
 * THE v2 SURFACE (`AGENTS_PLAN.md` A6): every permissionless action a program-player can
 * take, and the live read that gates each one.
 *
 * The pattern is the same throughout and is the reason these tests exist at all: a refusal
 * the CONTRACT would make is made here first, before a wallet is opened, so the cost of
 * getting it wrong is a thrown Error rather than gas. Each block below asserts both halves
 * — that the refusal happens and that nothing was sent.
 */
describe("claimTribute — the §4.1 divisor share, claimed off the number's own item", () => {
  const item = { itemAddress: async () => OTHER };

  it("goes to the ITEM, not the ledger, and carries the shared builder's bytes", async () => {
    const { agent, sent } = fakeAgent({
      ...item,
      numberData: async () => ({ n: 7n, owner: ME, isPrime: true }),
      owed: async () => 5_000_000_000n,
    });
    await agent.claimTribute(7n);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(OTHER); // the item address getItemAddress(7) returned
    expect(sent[0].bodyHash).toBe(buildClaimTributeMessage().body.hash().toString("hex"));
  });

  it("refuses for a number this wallet does not own — the item throws 300", async () => {
    const { agent, sent } = fakeAgent({
      ...item,
      numberData: async () => ({ n: 7n, owner: OTHER, isPrime: true }),
      owed: async () => 5_000_000_000n,
    });
    await expect(agent.claimTribute(7n)).rejects.toThrow(/does not own/);
    expect(sent).toHaveLength(0);
  });

  it("refuses a zero claim rather than paying gas for the item's cheap-fail", async () => {
    const { agent, sent } = fakeAgent({
      ...item,
      numberData: async () => ({ n: 7n, owner: ME, isPrime: true }),
      owed: async () => 0n,
    });
    await expect(agent.claimTribute(7n)).rejects.toThrow(/owed nothing/);
    expect(sent).toHaveLength(0);
  });
});

const TROPHY = async () => ({ holder: ME, transferable: true });

describe("annotate — an era trophy's engraving: the first free, later ones at the rename fee (D-212)", () => {
  const RENAME = 200_000_000_000n;
  type Trophy = () => Promise<{ holder: string | null; transferable: boolean }>;
  const trophyChain = (count: number, trophy: Trophy = TROPHY) => ({
    trophy,
    trophyAnnotationCount: async () => count,
    trophyRenameFee: async () => RENAME,
  });

  it("sends the registrar the shared builder's free bytes on the first engraving", async () => {
    const { agent, sent } = fakeAgent(trophyChain(0));
    await agent.annotate({ n: 30n, text: "the third primorial" });
    const want = buildAnnotateMessage({ n: 30n, text: "the third primorial" });
    expect(sent[0].to).toBe(ADDR);
    expect(sent[0].bodyHash).toBe(want.body.hash().toString("hex"));
    expect(sent[0].value).toBe(want.value);
  });

  it("carries the LIVE rename fee on every later engraving", async () => {
    const { agent, sent } = fakeAgent(trophyChain(1));
    await agent.annotate({ n: 30n, text: "again" });
    expect(sent[0].value).toBe(buildAnnotateMessage({ n: 30n, text: "again", renameFee: RENAME }).value);
    expect(sent[0].value).toBeGreaterThan(RENAME);
  });

  it("refuses a non-primorial, an unawarded trophy and somebody else's, sending nothing", async () => {
    const prime = fakeAgent(trophyChain(0, async () => ({ holder: null, transferable: false })));
    await expect(prime.agent.annotate({ n: 7n, text: "x" })).rejects.toThrow(/not one of §7's eight primorials/);
    const unawarded = fakeAgent(trophyChain(0, async () => ({ holder: null, transferable: true })));
    await expect(unawarded.agent.annotate({ n: 30n, text: "x" })).rejects.toThrow(/nobody holds the era trophy/);
    const theirs = fakeAgent(trophyChain(0, async () => ({ holder: OTHER, transferable: true })));
    await expect(theirs.agent.annotate({ n: 30n, text: "x" })).rejects.toThrow(/belongs to/);
    for (const f of [prime, unawarded, theirs]) expect(f.sent).toHaveLength(0);
  });

  it("leaves the length rule to the shared builder rather than restating it", async () => {
    const { agent } = fakeAgent(trophyChain(0));
    await expect(agent.annotate({ n: 30n, text: "" })).rejects.toThrow(/1\.\.48 characters/);
    await expect(agent.annotate({ n: 30n, text: "z".repeat(49) })).rejects.toThrow(/1\.\.48 characters/);
  });
});

describe("name — the owner names any number for GRAM through the collection (D-212)", () => {
  const FEES = async () => ({ nameFee: 2_000_000_000n, renameFee: 200_000_000_000n });

  it("sends the collection the shared builder's bytes at nameFee, then at renameFee once named", async () => {
    const first = fakeAgent({ namer: async () => ME, annotationCount: async () => 0, namingFees: FEES });
    await first.agent.name({ n: 9n, text: "nine" });
    const want = buildNameNumberMessage({ n: 9n, text: "nine", fee: 2_000_000_000n });
    expect(first.sent[0].to).toBe(ADDR);
    expect(first.sent[0].bodyHash).toBe(want.body.hash().toString("hex"));
    expect(first.sent[0].value).toBe(want.value);

    const again = fakeAgent({ namer: async () => ME, annotationCount: async () => 1, namingFees: FEES });
    await again.agent.name({ n: 9n, text: "nine" });
    expect(again.sent[0].value).toBe(buildNameNumberMessage({ n: 9n, text: "nine", fee: 200_000_000_000n }).value);
  });

  it("refuses an unminted number and one this wallet does not own, sending nothing", async () => {
    const unminted = fakeAgent({ namer: async () => null, annotationCount: async () => 0, namingFees: FEES });
    await expect(unminted.agent.name({ n: 9n, text: "x" })).rejects.toThrow(/not minted/);
    const theirs = fakeAgent({ namer: async () => OTHER, annotationCount: async () => 0, namingFees: FEES });
    await expect(theirs.agent.name({ n: 9n, text: "x" })).rejects.toThrow(/belongs to/);
    for (const f of [unminted, theirs]) expect(f.sent).toHaveLength(0);
  });

  it("refuses without a collection address rather than guessing one", async () => {
    const { ledger, market, ratchet, registrar } = ADDRESSES;
    const { agent, sent } = fakeAgent(
      { namer: async () => ME, annotationCount: async () => 0, namingFees: FEES },
      { ledger, market, ratchet, registrar },
    );
    await expect(agent.name({ n: 9n, text: "x" })).rejects.toThrow(/no collection address/);
    expect(sent).toHaveLength(0);
  });
});

describe("transferTrophy — D-14's pen, moved by its CURRENT HOLDER alone (DESIGN.md G45)", () => {
  it("sends the registrar the shared builder's bytes when the pen is this wallet's", async () => {
    const { agent, sent } = fakeAgent({ trophy: async () => ({ holder: ME, transferable: true }) });
    await agent.transferTrophy({ primorial: 30n, newHolder: OTHER });
    expect(sent[0].to).toBe(ADDR);
    expect(sent[0].bodyHash).toBe(
      buildTransferTrophyMessage({ primorial: 30n, newHolder: OTHER }).body.hash().toString("hex"),
    );
  });

  it("refuses a number that is not one of the eight, and a pen that is somebody else's or unawarded", async () => {
    const notPrimorial = fakeAgent({ trophy: async () => ({ holder: ME, transferable: false }) });
    await expect(notPrimorial.agent.transferTrophy({ primorial: 7n, newHolder: OTHER })).rejects.toThrow(
      /not one of §7's eight primorials/,
    );

    const theirs = fakeAgent({ trophy: async () => ({ holder: OTHER, transferable: true }) });
    await expect(theirs.agent.transferTrophy({ primorial: 30n, newHolder: ME })).rejects.toThrow(/belongs to/);

    const unawarded = fakeAgent({ trophy: async () => ({ holder: null, transferable: true }) });
    await expect(unawarded.agent.transferTrophy({ primorial: 30n, newHolder: ME })).rejects.toThrow(
      /belongs to nobody yet/,
    );

    for (const f of [notPrimorial, theirs, unawarded]) expect(f.sent).toHaveLength(0);
  });
});

describe("flush — permissionless, but the ratchet has two asserts worth reading first", () => {
  const ready = { pending: async () => 50_000_000_000n, flushStatus: async () => null };

  it("sends the shared builder's bytes to the RATCHET when there is something to flush", async () => {
    const { agent, sent } = fakeAgent(ready);
    await agent.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(ADDR);
    expect(sent[0].bodyHash).toBe(buildFlushMessage().body.hash().toString("hex"));
  });

  it("refuses an empty `pending` rather than paying gas for the ratchet's 208", async () => {
    const { agent, sent } = fakeAgent({ ...ready, pending: async () => 0n });
    await expect(agent.flush()).rejects.toThrow(/nothing pending/);
    expect(sent).toHaveLength(0);
  });

  it("refuses inside the 24h cooldown, and names the outcome of the last attempt (207)", async () => {
    const { agent, sent } = fakeAgent({
      ...ready,
      flushStatus: async () => ({
        lastAttemptTime: 1n,
        outcome: "bounced" as const,
        amountNanoton: 1n,
        cooldownRemainingSeconds: 3600n,
      }),
    });
    await expect(agent.flush()).rejects.toThrow(/cooldown for another 3600s \(last attempt bounced\)/);
    expect(sent).toHaveLength(0);
  });

  it("sends when the cooldown has run out", async () => {
    const { agent, sent } = fakeAgent({
      ...ready,
      flushStatus: async () => ({
        lastAttemptTime: 1n,
        outcome: "filled" as const,
        amountNanoton: 1n,
        cooldownRemainingSeconds: 0n,
      }),
    });
    await agent.flush();
    expect(sent).toHaveLength(1);
  });

  it("sends when the STATUS itself is absent — a missing reading is not a cooldown", async () => {
    // `getFlushStatus` predates neither the cooldown nor `pending`, but a deployment
    // without it must not be read as "flush is blocked": the contract is the authority
    // and it will answer 207 for itself if it disagrees.
    const { agent, sent } = fakeAgent(ready);
    await agent.flush();
    expect(sent).toHaveLength(1);
  });

  /**
   * VENUE-DEPTH SIZING (D-143). The contract's own rule sizes off `pending` and the guard
   * is priced off the pool, so on a venue thinner than the tranche a flush bounces with
   * the market far BELOW the floor. The agent reads `getFloorCache` and `/market` and
   * sends the fillable size instead.
   *
   * The pool here is the live testnet reading of 2026-09-19 — 1.2826 GRAM against 479,142
   * PRIMES at a floor of 5.6875 GRAM/1M — where the auto-sized tranche demanded 7.2× the
   * pool's entire PRIMES side.
   */
  const LIVE_POOL = {
    reserveTonNanoton: "1282642606",
    reservePrimesNano: "479141971387321",
    tradeFeeNum: "40",
    tradeFeeDen: "10000",
  };
  const LIVE_CACHE = { tCacheNanoton: 5_687_500_000_000n, sCacheNanoPrimes: 10n ** 18n };

  /** `read` is `readonly` on the agent, so the market stub goes in through one cast — here,
   *  rather than four times below. It is the third seam `fakeAgent` does not cover. */
  const withMarket = <T>(agent: T, market: unknown): T => {
    (agent as unknown as { read: unknown }).read = { market: async () => market };
    return agent;
  };

  it("sizes the tranche to the venue when the pool and the floor cache are both readable", async () => {
    const { agent, sent } = fakeAgent({ ...ready, floorCache: async () => LIVE_CACHE });
    withMarket(agent, LIVE_POOL);
    await agent.flush();
    expect(sent).toHaveLength(1);
    // ~1.41 GRAM after the 2% haircut, and NOT the contract's own 0 ("size it yourself").
    expect(sent[0].bodyHash).not.toBe(buildFlushMessage().body.hash().toString("hex"));
    expect(sent[0].bodyHash).toBe(
      buildFlushMessage({ amountNanoton: 1_408_579_656n }).body.hash().toString("hex"),
    );
  });

  it("refuses rather than paying for a refusal when NO size clears the guard", async () => {
    // Same floor, a pool ten times as deep in GRAM: the market is above the floor and the
    // closed form has no positive root. Sending would buy one `payout#474f86cf` on the
    // caller's own 0.25 GRAM of swap gas (D-146) to learn what the reserves already said.
    const { agent, sent } = fakeAgent({ ...ready, floorCache: async () => LIVE_CACHE });
    withMarket(agent, { ...LIVE_POOL, reserveTonNanoton: "12826426060" });
    await expect(agent.flush()).rejects.toThrow(/at or above the floor/);
    expect(sent).toHaveLength(0);
  });

  it("falls back to the contract's own sizing when the venue cannot be read at all", async () => {
    // "We do not know" and "the market is above the floor" are different statements, and
    // only the second one refuses. A ratchet with no `getFloorCache`, an unlisted pool or
    // a proxy that threw all take the pre-D-143 path: send 0 and let the contract size it.
    const { agent, sent } = fakeAgent({ ...ready, floorCache: async () => null });
    withMarket(agent, LIVE_POOL);
    await agent.flush();
    expect(sent[0].bodyHash).toBe(buildFlushMessage().body.hash().toString("hex"));

    const thrown = fakeAgent({
      ...ready,
      floorCache: async () => {
        throw new Error("exit code 11");
      },
    });
    withMarket(thrown.agent, LIVE_POOL);
    await thrown.agent.flush();
    expect(thrown.sent[0].bodyHash).toBe(buildFlushMessage().body.hash().toString("hex"));
  });

  it("honours an explicit amount without reading the venue", async () => {
    const { agent, sent } = fakeAgent(ready);
    await agent.flush({ amount: 3_000_000_000n });
    expect(sent[0].bodyHash).toBe(
      buildFlushMessage({ amountNanoton: 3_000_000_000n }).body.hash().toString("hex"),
    );
  });
});

describe("harvest and sweepOps — permissionless pokes, refused off chain where the contract would refuse", () => {
  const withRead = <T>(agent: T, read: Record<string, unknown>): T => {
    (agent as unknown as { read: unknown }).read = read;
    return agent;
  };
  const now = BigInt(Math.floor(Date.now() / 1000));
  // 1:1 rate, 100 GRAM at cost, 101 tsTON held: 1 tsTON of accrued yield.
  const staking = (over: Record<string, bigint> = {}) => async () => ({
    stakedCostNanoton: 100_000_000_000n,
    tstonHeldNano: 101_000_000_000n,
    lastRateNum: 1n,
    lastRateDen: 1n,
    lastHarvestTime: now - 40n * 86400n,
    ...over,
  });
  const gates = (over: Record<string, unknown> = {}) => async () => ({
    harvestIntervalSec: 30 * 86400,
    harvestDustTston: 15_950_681n,
    exitLeg: 0,
    ...over,
  });

  it("sends the shared harvest bytes to the RATCHET when every gate is open", async () => {
    const { agent, sent } = fakeAgent({});
    withRead(agent, { staking: staking(), harvestGates: gates() });
    await agent.harvest();
    expect(sent).toHaveLength(1);
    expect(sent[0].bodyHash).toBe(buildHarvestMessage().body.hash().toString("hex"));
    expect(sent[0].value).toBe(buildHarvestMessage().value);
  });

  it("refuses an open exit (230), the interval (228) and dust (229) before paying for them", async () => {
    for (const [read, msg] of [
      [{ staking: staking(), harvestGates: gates({ exitLeg: 3 }) }, /would throw 230/],
      [{ staking: staking({ lastHarvestTime: now - 86400n }), harvestGates: gates() }, /would throw 228/],
      [{ staking: staking({ tstonHeldNano: 100_000_000_001n }), harvestGates: gates() }, /would throw 229/],
    ] as const) {
      const { agent, sent } = fakeAgent({});
      withRead(agent, read);
      await expect(agent.harvest()).rejects.toThrow(msg);
      expect(sent).toHaveLength(0);
    }
  });

  it("a never-harvested reserve is not inside an interval", async () => {
    const { agent, sent } = fakeAgent({});
    withRead(agent, { staking: staking({ lastHarvestTime: 0n }), harvestGates: gates() });
    await agent.harvest();
    expect(sent).toHaveLength(1);
  });

  it("sweepOps sends to the LEDGER, and refuses a sweep with nothing sweepable", async () => {
    const live = fakeAgent({});
    withRead(live.agent, { opsSweep: async () => ({ sweepableNanoton: 5n, opsReserveNanoton: 1n }) });
    await live.agent.sweepOps();
    expect(live.sent[0].bodyHash).toBe(buildSweepOpsMessage().body.hash().toString("hex"));

    const empty = fakeAgent({});
    withRead(empty.agent, { opsSweep: async () => ({ sweepableNanoton: 0n, opsReserveNanoton: 1n }) });
    await expect(empty.agent.sweepOps()).rejects.toThrow(/no-op/);
    expect(empty.sent).toHaveLength(0);
  });
});

describe("PrimesRead v2 — the endpoints whose envelopes are not all the same shape", () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as Response;

  it("reads /number/:n, whose two get-methods are enveloped SEPARATELY", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      ok({ number: { data: { owner: ME, isPrime: true } }, owed: { data: { owedNanoton: "12" } } }),
    );
    expect(await new PrimesRead({ fetchImpl, rps: 1000 }).number(7n)).toEqual({
      owner: ME,
      isPrime: true,
      owedNanoton: 12n,
    });
  });

  it("reads /item/:n/address, which is served bare because it is immutable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok({ address: OTHER }));
    expect(await new PrimesRead({ fetchImpl, rps: 1000 }).itemAddress(7n)).toBe(OTHER);
  });

});

/**
 * F65: `open_lot` prices a composite on `scoreOfFrom(n, factors)`. `lotPrice` is the figure
 * `openLot` and `primes_open_lot` gate the opening bid on, so it must be the FACTORED quote
 * over the list `openLot` sends — the from-`n` `getLotPrice` under-quotes and is refused 1003.
 */
describe("PrimesChain.lotPrice", () => {
  it("quotes a composite over its factorization and a prime over none", async () => {
    const { PrimesChain } = await import("../src/chain.ts");
    const { Dictionary, TupleReader } = await import("@ton/core");
    const { FactorValue } = await import("@ton-primes/shared/factors");
    const calls: { method: string; args: any[] }[] = [];
    const client = {
      runMethod: async (_a: unknown, method: string, args: any[]) => {
        calls.push({ method, args });
        return { stack: new TupleReader([{ type: "int", value: 7n }]) };
      },
    };
    const market = new Address(0, Buffer.alloc(32, 7)).toString();
    const chain = new PrimesChain(client as any, { market } as any);

    expect(await chain.lotPrice(360n)).toBe(7n);
    expect(calls[0].method).toBe("getLotPriceFrom");
    const dict = Dictionary.loadDirect(Dictionary.Keys.Uint(8), FactorValue, calls[0].args[1].cell);
    expect(dict.values().map((f) => [f.prime, f.exponent])).toEqual([[2n, 3], [3n, 2], [5n, 1]]);

    await chain.lotPrice(19n);
    expect(calls[1]).toEqual({ method: "getLotPrice", args: [{ type: "int", value: 19n }] });
  });
});
