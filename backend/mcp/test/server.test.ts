/**
 * The one property worth a test here: a write tool does not spend without `confirm: true`,
 * and its dry run is a real rehearsal — it runs the same live reads the send does, so a
 * refusal (not the head, under the live minPayment) shows up before anything is signed.
 *
 * Everything else in this server is one SDK call, and the SDK's own suite covers it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const chain = {
  head: vi.fn(async () => 12n),
  lot: vi.fn(async () => ({ found: true, closed: false, mode: 0, p0Nanoton: 1n, standingPriceNanoton: 1n, minNextBidNanoton: 5n })),
  lotPrice: vi.fn(async () => 3n),
  itemAddress: vi.fn(async () => "I"),
  owed: vi.fn(async () => 500n),
  namer: vi.fn(async () => "W"),
  annotationCount: vi.fn(async () => 0),
  trophy: vi.fn(async (): Promise<{ holder: string | null; transferable: boolean }> => ({ holder: "W", transferable: true })),
  namingFees: vi.fn(async () => ({ nameFee: 2_000_000_000n, renameFee: 200_000_000_000n })),
  trophyAnnotationCount: vi.fn(async () => 0),
  trophyRenameFee: vi.fn(async () => 200_000_000_000n),
  addresses: { ledger: "L", market: "M", ratchet: "R", registrar: "G", collection: "C" },
};
const mint = vi.fn(async () => ({ seqno: 1 }));
const bid = vi.fn(async () => ({ seqno: 2 }));
const claimTribute = vi.fn(async () => ({ seqno: 4 }));
const annotate = vi.fn(async () => ({ seqno: 5 }));
const name = vi.fn(async () => ({ seqno: 6 }));

vi.mock("@ton-primes/agent", () => ({
  PrimesAgent: class {
    read = { head: async () => 12n, floor: async () => ({ numNanoton: 1n, denPrimes: 2n }), openLots: async () => [], numbersOf: async () => [] };
    chain = async () => chain;
    routeFor = async () => ({ route: "head" });
    mint = mint;
    bid = bid;
    openLot = vi.fn();
    openHeadLot = vi.fn();
    flush = vi.fn();
    address = async () => "W";
    closeLot = vi.fn();
    claimTribute = claimTribute;
    annotate = annotate;
    name = name;
  },
}));

process.env.NODE_ENV = "test";
const { server } = await import("../src/index.ts");

/** Reach the registered handlers the way a client would, without a transport. */
const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await tools[name].handler(args, {});
  return { text: res.content[0].text, isError: res.isError === true };
};

beforeEach(() => {
  for (const f of [mint, bid, claimTribute, annotate, name]) f.mockClear();
});

describe("a write tool quotes before it spends", () => {
  it("primes_mint without confirm sends nothing and says what it would cost", async () => {
    const { text } = await call("primes_mint", {});
    expect(mint).not.toHaveBeenCalled();
    expect(text).toMatch(/"confirmed": false/);
    expect(text).toMatch(/mint 12 for 1 TON/);
    expect(text).toMatch(/to this wallet, referral key none/);
  });

  it("the primes_mint quote names a gift's beneficiary and the referral key it will sign", async () => {
    const { text } = await call("primes_mint", { beneficiary: "EQgift", referralKey: 7 });
    expect(text).toMatch(/GIFTED to EQgift, not this wallet, referral key 7/);
    expect(mint).not.toHaveBeenCalled();
  });

  it("primes_mint with confirm sends", async () => {
    await call("primes_mint", { confirm: true });
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("the dry run runs the live reads — a stale head is refused before signing", async () => {
    const { text, isError } = await call("primes_mint", { n: "99", confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/not the head/);
    expect(mint).not.toHaveBeenCalled();
  });

  it("a bid under the live minPayment is refused, confirmed or not", async () => {
    const { isError, text } = await call("primes_bid", { n: "7", bidNanoton: "1", confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/under the live minPayment/);
    expect(bid).not.toHaveBeenCalled();
  });
});

describe("read tools need no key and no confirmation", () => {
  it("primes_head answers the head", async () => {
    expect((await call("primes_head")).text).toMatch(/"head": "12"/);
  });

  it("primes_floor answers the ratio, never pre-divided", async () => {
    const { text } = await call("primes_floor");
    expect(text).toMatch(/numNanoton/);
    expect(text).toMatch(/denPrimes/);
  });
});

/**
 * The v2 write tools (`AGENTS_PLAN.md` A6). Same property as above and it matters more
 * here: an annotation is once-only, so the dry run has to say what is
 * about to be destroyed, and the refusals have to happen in the quote rather than on chain.
 */
describe("the v2 writes quote the irreversible part before they spend", () => {
  it("primes_claim_tribute quotes the live amount and the item it comes off", async () => {
    const { text } = await call("primes_claim_tribute", { n: "7" });
    expect(claimTribute).not.toHaveBeenCalled();
    expect(text).toMatch(/claim 500 nanoton of tribute standing to 7/);
  });

  it("primes_annotate quotes the free first engraving as gas only", async () => {
    const { text } = await call("primes_annotate", { n: "30", text: "the third primorial" });
    expect(annotate).not.toHaveBeenCalled();
    expect(text).toMatch(/gas only, the free first engraving/);
  });

  it("primes_annotate quotes a re-engraving at the registrar's live rename fee (D-212)", async () => {
    chain.trophyAnnotationCount.mockResolvedValueOnce(1);
    const { text } = await call("primes_annotate", { n: "30", text: "x" });
    expect(text).toMatch(/200000000000 nanoton plus gas/);
    expect(annotate).not.toHaveBeenCalled();
  });

  it("primes_annotate refuses a number that is not an era trophy", async () => {
    chain.trophy.mockResolvedValueOnce({ holder: null, transferable: false });
    const { isError, text } = await call("primes_annotate", { n: "7", text: "x", confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/not an era trophy/);
    expect(annotate).not.toHaveBeenCalled();
  });

  it("primes_name_number quotes nameFee first and renameFee once named (D-212)", async () => {
    const first = await call("primes_name_number", { n: "9", text: "nine" });
    expect(first.text).toMatch(/for 2000000000 nanoton \(first naming\)/);
    chain.annotationCount.mockResolvedValueOnce(1);
    const again = await call("primes_name_number", { n: "9", text: "nine" });
    expect(again.text).toMatch(/for 200000000000 nanoton \(a rename\)/);
    expect(name).not.toHaveBeenCalled();
  });

  it("primes_name_number refuses an unminted number, and sends on confirm", async () => {
    chain.namer.mockResolvedValueOnce(null as never);
    const { isError, text } = await call("primes_name_number", { n: "9", text: "x", confirm: true });
    expect(isError).toBe(true);
    expect(text).toMatch(/not minted/);
    expect(name).not.toHaveBeenCalled();
    await call("primes_name_number", { n: "9", text: "x", confirm: true });
    expect(name).toHaveBeenCalledTimes(1);
  });
});
