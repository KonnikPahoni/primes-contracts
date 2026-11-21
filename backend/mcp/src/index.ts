#!/usr/bin/env node
/**
 * The TON PRIMES MCP server — `AGENTS_PLAN.md` A3, `DECISIONS.md` D-131.2.
 *
 * Deliberately thin: every tool is one `@ton-primes/agent` call, so the rules live in the
 * SDK (live reads before a spend, computed proofs, nominal + fee margin, client-side
 * throttling) and cannot be half-applied here.
 *
 * **stdio, not a hosted server.** Signing is local (D-131.2) — the key comes from this
 * process's own environment and no service of this project ever holds one. A hosted remote
 * MCP would mean custody, which is why there is not one.
 *
 * **A write tool refuses without `confirm: true`**, and says what it will spend first.
 * That is not a protocol requirement; it is the one guard worth having between a model's
 * plan and a real 1 TON, and it makes the dry run the default.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PrimesAgent } from "@ton-primes/agent";

/** `PRIMES_REFERRAL_KEY`: the key a mint cites when the call names none. */
const configuredReferralKey = process.env.PRIMES_REFERRAL_KEY ? Number(process.env.PRIMES_REFERRAL_KEY) : undefined;

const agent = new PrimesAgent({
  mnemonic: process.env.PRIMES_MNEMONIC,
  network: process.env.PRIMES_NETWORK === "mainnet" ? "mainnet" : "testnet",
  tonApiKey: process.env.TONCENTER_API_KEY,
  readProxyUrl: process.env.PRIMES_READ_PROXY_URL,
  readIndexUrl: process.env.PRIMES_READ_INDEX_URL,
  eventsUrl: process.env.PRIMES_EVENTS_URL,
  referralKey: configuredReferralKey,
});

export const server = new McpServer({ name: "ton-primes", version: "0.4.0" });

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }],
});
const failed = (e: unknown) => ({
  content: [{ type: "text" as const, text: `error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

/**
 * The arguments one tool receives, inferred from its own zod shape.
 *
 * Generic rather than `Record<string, unknown>`, so a handler writes `a.n` and the
 * compiler checks it against the schema declared three lines above. The casts that stood
 * here instead asserted a shape TypeScript had never compared to that schema, so a renamed
 * field compiled cleanly and failed at runtime as `BigInt(undefined)`. Inferred, the
 * schema and the handler cannot drift.
 */
type Args<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

/**
 * A number or a nanoton amount, as the SDK's `BigInt()` will read it. `BigInt` alone also
 * takes "0x3b9aca00", " 5 " and "0b101" — a model's hex or padded string became a real spend
 * the dry run never echoed in the form the model wrote it. Digits only.
 */
const decimal = () => z.string().regex(/^\d+$/, "a non-negative decimal integer, digits only");

/** A read tool: no key, no spend, no confirmation. */
function read<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (a: Args<S>) => Promise<unknown>,
) {
  // The one cast left in this file, and it is at the SDK boundary rather than in each
  // handler: `server.tool`'s overloads resolve against a concrete shape, not a generic
  // one. Thirty-five casts inside the handlers became this.
  server.tool(name, description, shape as z.ZodRawShape, async (args: Record<string, unknown>) => {
    try {
      return json(await run(args as Args<S>));
    } catch (e) {
      return failed(e);
    }
  });
}

/**
 * A write tool: it quotes what it is about to spend, and sends only on `confirm: true`.
 *
 * `quote` runs the SAME live reads the send does, so the dry run is a real rehearsal of
 * the refusals (not the head, under the live `minPayment`, prime on the ascending lane)
 * rather than a description of them.
 */
function write<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  quote: (a: Args<S>) => Promise<string>,
  send: (a: Args<S>) => Promise<unknown>,
) {
  const withConfirm = {
    ...shape,
    confirm: z.boolean().default(false).describe("Send it. Without this the tool only quotes what the transaction would cost."),
  } as z.ZodRawShape;
  server.tool(name, description, withConfirm, async (args: Record<string, unknown>) => {
    const a = args as Args<S>;
    try {
      const quoted = await quote(a);
      if (!(args as { confirm?: boolean }).confirm) {
        return json({ wouldSend: quoted, confirmed: false, note: "call again with confirm: true to sign and send" });
      }
      return json({ sent: quoted, result: await send(a) });
    } catch (e) {
      return failed(e);
    }
  });
}

// ---------------------------------------------------------------- reads

read("primes_head", "The next integer to be minted (the head). Backed by the ledger's getHead.", {},
  async () => ({ head: await agent.read.head() }));

read("primes_floor", "The internal floor price p_f = T / S, as its raw numerator and denominator. It is strictly increasing on every mint (CONCEPT.md §5).", {},
  async () => await agent.read.floor());

read("primes_route", "How a given number can be acquired right now, read live off the chain: at the head for 1 TON, as a lot ahead of the head, already claimed by a lot, or already minted.",
  { n: decimal().describe("The integer, as a decimal string.") },
  async (a) => await agent.routeFor(BigInt(a.n)));

read("primes_lot", "One number's live lot state from the market's getLot: mode, standing price and the minimum next bid.",
  { n: decimal() },
  async (a) => (await agent.chain()).lot(BigInt(a.n)));

read("primes_open_lots", "Lots currently open, newest first. Candidates from the index — each is settled on chain before anything is signed.",
  { limit: z.number().int().min(1).max(200).default(50) },
  async (a) => await agent.read.openLots(a.limit));

read("primes_portfolio", "The numbers one wallet holds, from the index's replay of observed transfers. These are CANDIDATES: run primes_confirm_numbers over them before offering a claim, because a number sold since is still listed here.",
  { address: z.string() },
  async (a) => await agent.read.numbersOf(a.address));

read("primes_number", "Who owns one number and what tribute stands to it, read off that number's own NFT item (getNumberData + getOwed).",
  { n: decimal() },
  async (a) => await agent.read.number(BigInt(a.n)));

read("primes_name", "Who may name one number — its CURRENT OWNER (CONCEPT.md §4.7.1, D-212) — what name stands on it, and the TON the next naming costs (nameFee first, renameFee after). A primorial also carries its era-trophy engraving.",
  { n: decimal() },
  async (a) => await agent.read.name(BigInt(a.n)));

read("primes_contracts", "The deployment manifest: which address holds which CONCEPT.md §3.4 role. An unset role is omitted rather than sent as null.", {},
  async () => await agent.read.contracts());

/*
 * The v3 reads are COMPOSITE on purpose (`AGENTS_PLAN.md` A7).
 *
 * A tool per route would mirror the HTTP API and hand a model forty names to choose
 * between; the SDK already exposes every route for a program that wants one. What earns a
 * tool here is a QUESTION an agent actually asks before it acts — "what do I hold", "is
 * flushing worth it", "what would opening this cost", "do I really own these" — and each
 * of the five below answers one in a single call.
 */

read("primes_wallet", "Everything one wallet holds and has earned: its TON balance, its PRIMES balance and both CONCEPT.md §4.7 rank ladders. Defaults to this server's own wallet when no address is given.",
  { address: z.string().optional().describe("Defaults to the configured signing wallet.") },
  async (a) => {
    const who = a.address ?? (await agent.address()).toString();
    // Settled individually: a wallet with no PRIMES jetton wallet and no rank row is the
    // NORMAL state for a new player, and one absent figure must not blank the others.
    const [balance, seqno, primes, ranks] = await Promise.all([
      agent.read.balance(who).catch(() => null),
      agent.read.seqno(who).catch(() => null),
      agent.read.primesBalance(who).catch(() => null),
      agent.read.ranks(who).catch(() => null),
    ]);
    return { address: who, balanceNanoton: balance, seqno, primes, ranks };
  });

read("primes_ratchet", "Whether flush() is worth calling right now: the TON pending, the TON already swapped, the floor it must fill at or below, the venue pool's CURRENT price, and when the last attempt ran and what it did. `outcome: bounced` is a venue refusing, which looks identical to an idle one without this field.", {},
  async () => {
    // `market` is the term this tool was missing. The floor guard (§4.3.1) fills only at or
    // below `p_f`, so "is flush worth calling" is a comparison between the pool price and the
    // floor — and until `/market` existed the pool price was an aggregator's API that no
    // agent could reach and that answered for no testnet deployment at all. Tolerated as
    // null, like the wallet tool's optional lines: one failed venue read must not blank
    // the four that answered.
    const [pending, swapped, floor, status, market] = await Promise.all([
      agent.read.pending(),
      agent.read.swapped(),
      agent.read.floor(),
      agent.read.flushStatus(),
      agent.read.market().catch(() => null),
    ]);
    return { pendingNanoton: pending, swappedNanoton: swapped, floor, flushStatus: status, market };
  });

read("primes_lot_price", "What opening a lot on one number would cost, and WHICH LANE it lands in: 0 ascending (composite), 2 prime Dutch, -1 not openable at all. Read this before primes_open_lot.",
  { n: decimal() },
  async (a) => await agent.read.lotPrice(BigInt(a.n)));

read("primes_confirm_numbers", "Confirm ownership of up to 24 numbers against each one's OWN NFT item. The portfolio list is replayed from indexed transfers and goes stale the moment a number is sold; this is the read that settles it, and the one to run before offering any claim.",
  { ns: z.array(decimal()).min(1).max(24) },
  async (a) => await agent.read.numbers(a.ns.map(BigInt)));

read("primes_audit", "The two auditor surfaces in one call: supply (S, and what has been burned out of it) and solvency (each contract's balance against its DECLARED liability, §3.4). Every figure carries the get-method behind it.", {},
  async () => {
    const [supply, solvency] = await Promise.all([agent.read.supply(), agent.read.solvency()]);
    return { supply, solvency };
  });

// ---------------------------------------------------------------- writes

write("primes_mint", "Mint the number at the head for a flat 1 TON. The factorization proof is computed for you; the head is re-read from the chain first and the call refuses if it has moved.",
  { n: decimal().optional().describe("Defaults to the current head."), beneficiary: z.string().optional().describe("Gift the number to this address (CONCEPT.md §4.5)."), referralKey: z.number().int().optional() },
  async (a) => {
    const { n } = a;
    const head = await (await agent.chain()).head();
    const target = n ? BigInt(n) : head;
    if (target !== head) throw new Error(`n=${target} is not the head (${head})`);
    // Every argument the send signs is in the quote (security audit 2026-11-20, lead 11): a
    // human approving the dry run must see that the number is gifted away and which key is
    // credited — the two fields injected third-party text would most want to set.
    const key = a.referralKey ?? configuredReferralKey ?? 0;
    const owner = a.beneficiary ? `GIFTED to ${a.beneficiary}, not this wallet` : "to this wallet";
    return `mint ${target} for 1 TON plus a fee margin, ${owner}, referral key ${key === 0 ? "none" : key}`;
  },
  async (a) => {
    const { n, beneficiary, referralKey } = a;
    return await agent.mint({ n: n ? BigInt(n) : undefined, beneficiary, referralKey });
  });

write("primes_bid", "Bid on a lot. On an ascending lot this is a raise; on a prime's descending lot the bid IS the purchase and it settles in the same transaction.",
  { n: decimal(), bidNanoton: decimal().optional().describe("Defaults to the live minimum next bid.") },
  async (a) => {
    const { n, bidNanoton } = a;
    const lot = await (await agent.chain()).lot(BigInt(n));
    if (!lot.found) throw new Error(`no lot on ${n}`);
    if (lot.closed) throw new Error(`the lot on ${n} is closed; it sold`);
    const bid = bidNanoton ? BigInt(bidNanoton) : lot.minNextBidNanoton;
    if (bid < lot.minNextBidNanoton) throw new Error(`bid ${bid} is under the live minPayment ${lot.minNextBidNanoton}`);
    return `bid ${bid} nanoton on ${n} (live minPayment ${lot.minNextBidNanoton}, mode ${lot.mode})`;
  },
  async (a) => {
    const { n, bidNanoton } = a;
    return await agent.bid({ n: BigInt(n), bidNanoton: bidNanoton ? BigInt(bidNanoton) : undefined });
  });

write("primes_open_lot", "Open an ascending lot on any number ahead of the head, prime or composite (D-88). Opening IS the first bid, at P0(n) or above; a composite carries its factorization, a prime is checked by the contract.",
  { n: decimal(), bidNanoton: decimal().optional().describe("Defaults to the live P0(n).") },
  async (a) => {
    const { n, bidNanoton } = a;
    const p0 = await (await agent.chain()).lotPrice(BigInt(n));
    const bid = bidNanoton ? BigInt(bidNanoton) : p0;
    if (bid < p0) throw new Error(`opening bid ${bid} is under the live P0 ${p0}`);
    return `open ${n} at ${bid} nanoton (live P0 ${p0})`;
  },
  async (a) => {
    const { n, bidNanoton } = a;
    return await agent.openLot({ n: BigInt(n), bidNanoton: bidNanoton ? BigInt(bidNanoton) : undefined });
  });

write("primes_open_head_lot", "Open a prime's descending lot. Gas only: the buyer supplies the payload, not the opener.",
  { n: decimal() },
  async (a) => `open a descending lot on ${a.n} (gas only)`,
  async (a) => await agent.openHeadLot(BigInt(a.n)));

write("primes_flush", "Call flush() on the ratchet. Permissionless and gas-only: TON has no scheduler, so pending TON becomes a bid at or below the floor only when somebody sends this. Refused when nothing is pending, and inside the 24h cooldown.",
  {},
  async () => {
    const chain = await agent.chain();
    const [pending, status] = await Promise.all([chain.pending(), chain.flushStatus()]);
    if (pending === 0n) throw new Error("the ratchet has nothing pending; flush() would throw 208");
    if (status && status.cooldownRemainingSeconds > 0n) {
      throw new Error(`flush() is in its 24h cooldown for another ${status.cooldownRemainingSeconds}s`);
    }
    return `flush() on the ratchet, moving up to ${pending} nanoton toward the floor (gas only)`;
  },
  async () => await agent.flush());

write("primes_close_lot", "Close an ascending lot whose clock has run. Permissionless and gas-only — the winner is already decided, this is the message that settles it.",
  { n: decimal() },
  async (a) => {
    const { n } = a;
    const lot = await (await agent.chain()).lot(BigInt(n));
    if (!lot.found) throw new Error(`no lot on ${n}`);
    if (lot.closed) throw new Error(`the lot on ${n} is already closed`);
    return `close the lot on ${n} (gas only)`;
  },
  async (a) => await agent.closeLot(BigInt(a.n)));

write("primes_claim_tribute", "Claim the tribute owed to one number you own — §4.1's divisor share. The message goes to that number's own item, and only its owner may send it.",
  { n: decimal() },
  async (a) => {
    const { n } = a;
    const chain = await agent.chain();
    const item = await chain.itemAddress(BigInt(n));
    const owed = await chain.owed(item);
    if (owed === 0n) throw new Error(`${n} is owed nothing right now`);
    return `claim ${owed} nanoton of tribute standing to ${n}, from its item at ${item}`;
  },
  async (a) => await agent.claimTribute(BigInt(a.n)));

write("primes_name_number", "Name a number this wallet OWNS, for TON (CONCEPT.md §4.7.1, D-212). The first naming costs the collection's nameFee, every later one renameFee; the fee goes to the ratchet floor. Owner and fee are read live; a refusal is refunded whole.",
  { n: decimal(), text: z.string().max(48) },
  async (a) => {
    const { n, text } = a;
    const chain = await agent.chain();
    const [namer, count, fees] = await Promise.all([
      chain.namer(BigInt(n)),
      chain.annotationCount(BigInt(n)),
      chain.namingFees(),
    ]);
    if (!namer) throw new Error(`${n} is not minted; only its owner can name it`);
    const fee = count === 0 ? fees.nameFee : fees.renameFee;
    // The send refuses unless this wallet is `namer`; the quote names the owner so a human sees it.
    return `name ${n} "${text}" for ${fee} nanoton (${count === 0 ? "first naming" : "a rename"}) plus gas, to the floor; owner ${namer}`;
  },
  async (a) => {
    const { n, text } = a;
    return await agent.name({ n: BigInt(n), text });
  });

write("primes_annotate", "Engrave an era trophy — one of §7's eight primorials (CONCEPT.md §4.7.1, D-212), by the trophy's holder. The first engraving is free (gas only); every later one costs the registrar's trophy rename fee in TON. The number's own name is primes_name_number.",
  { n: decimal(), text: z.string().max(48) },
  async (a) => {
    const { n, text } = a;
    const chain = await agent.chain();
    const trophy = await chain.trophy(BigInt(n));
    if (!trophy.transferable) throw new Error(`${n} is not an era trophy; name the number with primes_name_number`);
    if (!trophy.holder) throw new Error(`nobody holds the era trophy on ${n} yet`);
    const count = await chain.trophyAnnotationCount(BigInt(n));
    const cost = count === 0 ? "gas only, the free first engraving" : `${await chain.trophyRenameFee()} nanoton plus gas`;
    return `engrave ${n} "${text}" (${cost})`;
  },
  async (a) => {
    const { n, text } = a;
    return await agent.annotate({ n: BigInt(n), text });
  });

if (process.env.NODE_ENV !== "test") {
  await server.connect(new StdioServerTransport());
}
