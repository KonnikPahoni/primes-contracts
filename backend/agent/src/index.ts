/**
 * `@ton-primes/agent` — play TON PRIMES from a program.
 *
 * `CONCEPT.md` §9.10, `DECISIONS.md` D-131, `AGENTS_PLAN.md` A2. This package adds no
 * chain surface and no privilege: it is the read projections, the shared message builders
 * and a locally-signing wallet, packaged so a headless client does not have to re-derive
 * cells that `shared/messages.ts` already owns.
 *
 * Three rules it enforces so a caller cannot get them wrong:
 *
 * 1. **A number about to be spent against is re-read from the chain** (§9.1). `act.mint`
 *    checks the live head, `act.bid` checks the live `getLot(n)`. The HTTP index is for
 *    finding candidates.
 * 2. **The proof is computed, not trusted.** A composite's factorization and each `⌊√p⌋`
 *    come from `shared/primality.ts` + `shared/factors.ts`, the same modules the contract
 *    tests use, so a mint cannot be built with a factorization the ledger will reject.
 * 3. **Nominal price plus a fee margin, never the exact price.** The builders already do
 *    this; it is restated here because it is the one mistake that costs a real 1 TON.
 *
 * What it does NOT do: hold a key anywhere but this process, promise a return, or read a
 * money-critical figure from an indexer.
 */
import { Address, TonClient } from "@ton/ton";
import {
  buildMintMessage,
  buildBidMessage,
  buildOpenLotMessage,
  buildOpenHeadLotMessage,
  buildCloseLotMessage,
  buildFlushMessage,
  buildClaimTributeMessage,
  buildTopUpMessage,
  buildAnnotateMessage,
  buildNameNumberMessage,
  buildTransferTrophyMessage,
  buildDedustSwapTonMessage,
  buildDedustSwapPrimesMessage,
  DEDUST_SWAP_DEADLINE_WINDOW,
  NAME_MAX_CHARS as SHARED_NAME_MAX_CHARS,
  BID_FEE_MARGIN_NANOTON,
} from "@ton-primes/shared/messages";
import { factorize as sharedFactorize, isProbablePrime as sharedIsProbablePrime } from "@ton-primes/shared/primality";
import {
  DEFAULT_SLIPPAGE_BPS,
  maxInAtFloorWithHaircut,
  quoteSwap,
  type SwapSide,
} from "@ton-primes/shared/dedustQuote";
import { isqrt as sharedIsqrt } from "@ton-primes/shared/factors";
import {
  PrimesRead,
  type BoardKind,
  type BountyStatus,
  type FeedKind,
  type FloorCache,
  type FlushStatus,
  type LedgerCounters,
  type LotPrice,
  type LotReading,
  type NumberRow,
  type PrimesBalance,
  type Provenance,
  type Ranks,
  type Read,
  type ReadOptions,
  type RatchetIdentity,
  type Staking,
} from "./read.ts";
import {
  LocalWallet,
  PrimesChain,
  type ContractAddresses,
  type LotState,
} from "./chain.ts";

export { PrimesRead, PrimesChain, LocalWallet };
export type {
  BoardKind,
  BountyStatus,
  ContractAddresses,
  FeedKind,
  FloorCache,
  FlushStatus,
  LedgerCounters,
  LotPrice,
  LotReading,
  LotState,
  NumberRow,
  PrimesBalance,
  Provenance,
  Ranks,
  Read,
  ReadOptions,
  RatchetIdentity,
  Staking,
};

/** The longest annotation §4.7.1 takes — a UI bound, not a protocol one. Restated rather
 *  than re-exported, for the reason the block below gives. */
export const NAME_MAX_CHARS: number = SHARED_NAME_MAX_CHARS;

/**
 * §4.1's invite line (D-202), as `GET /api/invitees?count=` on the keeper serves it: the
 * ADDRESSES the mint sends a plain 0.1 TON transfer to, one per slot. Nothing is signed —
 * the minter chooses the recipients, and may replace the keeper's default list with any
 * addresses at all, its own included.
 *
 * Restated here rather than imported into the signature of `mint`, for the same reason the
 * proof helpers below are: a type this package's `.d.ts` NAMES must resolve for whoever
 * installs it, and `@ton-primes/shared` is bundled into `dist/` rather than published.
 */
export interface MintInvites {
  /** The minter's DECLARED count, 0..3 (`params.invites.max_count`). A slot with no address
   *  sends nothing, and its 0.1 TON falls to β, not to the team. */
  count: number;
  /** Keyed BY SLOT, 1..3, never 0. */
  addresses: { slot: number; address: string }[];
}
/**
 * The proof helpers, re-exported so an agent never writes a second factorizer.
 *
 * Each signature is RESTATED here rather than forwarded with `export { ... } from`.
 * `@ton-primes/shared` is a workspace package that is bundled into this one and never
 * published, so a `.d.ts` naming it would not resolve for anyone who installs this from
 * npm. The bodies delegate, so there is still exactly one implementation; `agent.test.ts`
 * pins each restated type to the shared original, and a restatement that drifts from it
 * fails to compile.
 */
export type FactorEntry = { prime: bigint; exponent: number; s?: bigint };

/** Integer floor square root — the reference for the `s` the ledger checks per factor. */
export function isqrt(v: bigint): bigint {
  return sharedIsqrt(v);
}

/** Deterministic Miller-Rabin over the 13 bases the contract uses (CONCEPT.md §3.1). */
export function isProbablePrime(n: bigint): boolean {
  return sharedIsProbablePrime(n);
}

/** The prime factorization a composite mint must carry, ascending and grouped. */
export function factorize(n: bigint): { prime: bigint; exponent: number }[] {
  return sharedFactorize(n);
}

export interface AgentOptions extends ReadOptions {
  /** 24 words. Omit for a read-only agent: every `act.*` call then refuses. */
  mnemonic?: string;
  /** Defaults to the public Toncenter endpoint for `network`. */
  tonEndpoint?: string;
  tonApiKey?: string;
  network?: "mainnet" | "testnet";
  /** Omit to fetch them from read-proxy's `/contracts` at first use. */
  addresses?: ContractAddresses;
  /**
   * §4.1's referral line: a number YOU own. Its owner is paid 10% of every mint this
   * agent makes, so an operator running under their own number is paying themselves.
   * `0` routes that line to the pool — never to the team.
   */
  referralKey?: number;
}

/**
 * GAUNTLET X4 — the default RPC base, overridable by `TON_RPC_ENDPOINT`.
 *
 * The SDK ships to third parties, so it does NOT import the backend's `shared/contracts`
 * helper — a published package that reads this repo's internal module would be a
 * dependency its consumers cannot satisfy. What it does share is the CONTRACT: the same
 * env var name, so a program run beside this stack switches provider with it, and one run
 * anywhere else can point at whatever it likes without editing code.
 *
 * Must speak Toncenter's v2 JSON-RPC dialect, which is what `@ton/ton`'s `TonClient` talks.
 * `docs/rpc-failover.md` names a proven, keyless alternative that does.
 */
const ENDPOINTS = {
  mainnet: "https://toncenter.com/api/v2/jsonRPC",
  testnet: "https://testnet.toncenter.com/api/v2/jsonRPC",
};

function rpcEndpointFor(network: "mainnet" | "testnet"): string {
  const override = typeof process !== "undefined" ? process.env?.TON_RPC_ENDPOINT : undefined;
  return override && override.trim() ? override.trim() : ENDPOINTS[network];
}

/** One number's mint route, as the head decides it (§4.4). */
export type MintRoute =
  | { route: "head"; n: bigint; kind: "composite" }
  | { route: "lot"; n: bigint; kind: "composite" | "prime"; lot: LotState }
  | { route: "past"; n: bigint }
  /** Ahead of the head, but a lot has already claimed it (D-45, D-196): won, or refunded —
   *  either way no second lot opens. */
  | { route: "claimed"; n: bigint };

export class PrimesAgent {
  readonly read: PrimesRead;
  private readonly client: TonClient;
  private readonly opts: AgentOptions;
  private chainCache?: PrimesChain;
  private walletCache?: LocalWallet;

  constructor(opts: AgentOptions = {}) {
    this.opts = opts;
    this.read = new PrimesRead(opts);
    const network = opts.network ?? "testnet";
    this.client = new TonClient({
      endpoint: opts.tonEndpoint ?? rpcEndpointFor(network),
      apiKey: opts.tonApiKey,
    });
  }

  /** The live get-method reader. Addresses come from `/contracts` unless supplied. */
  async chain(): Promise<PrimesChain> {
    if (this.chainCache) return this.chainCache;
    let addresses = this.opts.addresses;
    if (!addresses) {
      const { data } = await this.read.proxy<Record<string, string>>("/contracts");
      const pick = (k: string) => {
        const v = data[k] ?? data[`${k}Address`];
        if (!v) throw new Error(`read-proxy /contracts has no "${k}" address; pass addresses explicitly`);
        return v;
      };
      addresses = {
        ledger: pick("ledger"),
        market: pick("market"),
        ratchet: pick("ratchet"),
        registrar: pick("registrar"),
        collection: data.collection,
      };
    }
    this.chainCache = new PrimesChain(this.client, addresses);
    return this.chainCache;
  }

  /**
   * Refuse a spend before anything is read or sent.
   *
   * Called first by every `act` method, not left to `wallet()`: a read-only agent that
   * discovers it cannot sign only after a chain round trip reports the wrong failure, and
   * on a rate-limited endpoint it also spends a request to say so.
   */
  private assertSignable(): void {
    if (!this.opts.mnemonic) {
      throw new Error("this agent is read-only: construct it with { mnemonic } to sign transactions");
    }
  }

  /** The signing wallet. Throws if the agent was built without a mnemonic. */
  async wallet(): Promise<LocalWallet> {
    if (this.walletCache) return this.walletCache;
    this.assertSignable();
    this.walletCache = await LocalWallet.fromMnemonic(this.client, this.opts.mnemonic!);
    return this.walletCache;
  }

  async address(): Promise<Address> {
    return (await this.wallet()).address;
  }

  /**
   * Which route `n` is on right now, read live.
   *
   * §4.4 and D-45: at its turn a composite mints for 1 TON; ahead of the head every number
   * is a paid lot, prime or composite; behind the head it is already someone's. An
   * auctioned number is marked off its sequential line permanently, so "wait for the head
   * to reach it" is never the answer for one.
   */
  async routeFor(n: bigint): Promise<MintRoute> {
    const chain = await this.chain();
    const head = await chain.head();
    if (n < head) return { route: "past", n };
    const prime = await chain.isKnownPrime(n).catch(() => isProbablePrime(n));
    if (n === head && !prime) return { route: "head", n, kind: "composite" };
    const lot = await chain.lot(n);
    // D-196: a lot that closed ahead of the market's head leaves no `getLot` record; the
    // ledger's claim (or its lot block's) is what says the number is taken.
    if (!lot.found && (await chain.isOffHead(n))) return { route: "claimed", n };
    return { route: "lot", n, kind: prime ? "prime" : "composite", lot };
  }

  /**
   * §4.1's core loop: mint the number at the head for a flat 1 TON.
   *
   * The head is re-read from the ledger first (§9.1) and the call refuses if `n` has moved
   * on — the ledger would refund minus gas, but a refund is not a result. The factorization
   * is computed here, so the proof and the number cannot disagree.
   */
  async mint(opts: { n?: bigint; beneficiary?: string | null; referralKey?: number; invites?: MintInvites | null } = {}) {
    this.assertSignable();
    const chain = await this.chain();
    const head = await chain.head();
    const n = opts.n ?? head;
    if (n !== head) throw new Error(`n=${n} is not the head (${head}); ahead of the head is a lot, behind it is minted`);
    const factors: FactorEntry[] = factorize(n).map((f) => ({ ...f, s: isqrt(f.prime) }));
    const wallet = await this.wallet();
    // D-191 point 1: to the BENEFICIARY's minter card (deployed by this send if absent),
    // which forwards the mint to the ledger with that wallet's rebate standing.
    const { to, init, body, value } = buildMintMessage({
      ledger: Address.parse(chain.addresses.ledger),
      payer: wallet.address,
      n,
      kind: 0,
      factors,
      referralKey: opts.referralKey ?? this.opts.referralKey ?? 0,
      beneficiary: opts.beneficiary ? Address.parse(opts.beneficiary) : null,
      invites: opts.invites ?? null,
    });
    return wallet.send(to.toString(), body, value, undefined, init);
  }

  /**
   * Bid on a lot — a raise on the ascending lane, THE PURCHASE on a prime's descending one.
   *
   * `minPayment` is read live and used as the floor; a caller's `bidNanoton` under it is
   * refused here rather than after the signature. The fee margin rides on top, because the
   * contract compares the value that ARRIVES and stores it as the bid.
   */
  async bid(opts: { n: bigint; bidNanoton?: bigint; beneficiary?: string | null; referralKey?: number }) {
    this.assertSignable();
    const chain = await this.chain();
    const lot = await chain.lot(opts.n);
    if (!lot.found) throw new Error(`no lot on ${opts.n} — open one first (act.openLot / act.openHeadLot)`);
    if (lot.closed) throw new Error(`the lot on ${opts.n} is closed; it sold`);
    const bidNanoton = opts.bidNanoton ?? lot.minNextBidNanoton;
    if (bidNanoton < lot.minNextBidNanoton) {
      throw new Error(`bid ${bidNanoton} is under the live minPayment ${lot.minNextBidNanoton}`);
    }
    const { body, value } = buildBidMessage({
      n: opts.n,
      bidNanoton,
      beneficiary: opts.beneficiary ? Address.parse(opts.beneficiary) : null,
      referralKey: opts.referralKey ?? this.opts.referralKey ?? 0,
    });
    return (await this.wallet()).send(chain.addresses.market, body, value);
  }

  /**
   * Open an ascending lot on any number ahead of the head — prime or composite (D-88 point 3)
   * — which IS the first bid, at `P0(n)` or above (D-30: no distance gate and no score gate).
   * `kind` selects only the proof: a composite carries its factorization, a prime carries
   * nothing and the contract runs Miller–Rabin itself (the webapp's `handleOpen` is the same).
   */
  async openLot(opts: { n: bigint; bidNanoton?: bigint; beneficiary?: string | null; referralKey?: number }) {
    this.assertSignable();
    const chain = await this.chain();
    // D-196: the ledger refuses (and refunds) an open on a claimed n; decide before signing.
    if (await chain.isOffHead(opts.n)) throw new Error(`a lot has already claimed ${opts.n}; no second lot opens on it`);
    const p0 = await chain.lotPrice(opts.n);
    const bidNanoton = opts.bidNanoton ?? p0;
    if (bidNanoton < p0) throw new Error(`opening bid ${bidNanoton} is under the live P0 ${p0}`);
    const prime = isProbablePrime(opts.n);
    const factors: FactorEntry[] = prime ? [] : factorize(opts.n).map((f) => ({ ...f, s: isqrt(f.prime) }));
    const { body, value } = buildOpenLotMessage({
      n: opts.n,
      kind: prime ? 1 : 0,
      factors,
      referralKey: opts.referralKey ?? this.opts.referralKey ?? 0,
      beneficiary: opts.beneficiary ? Address.parse(opts.beneficiary) : null,
      bidNanoton,
    });
    return (await this.wallet()).send(chain.addresses.market, body, value);
  }

  /** Open a prime's descending lot. Gas-only: the buyer supplies the payload, not the opener. */
  async openHeadLot(n: bigint) {
    this.assertSignable();
    const chain = await this.chain();
    const { body, value } = buildOpenHeadLotMessage({ n });
    return (await this.wallet()).send(chain.addresses.market, body, value);
  }

  /** Close an ascending lot whose clock has run. Permissionless, gas-only. */
  async closeLot(n: bigint) {
    this.assertSignable();
    const chain = await this.chain();
    const { body, value } = buildCloseLotMessage({ n });
    return (await this.wallet()).send(chain.addresses.market, body, value);
  }

  /**
   * `flush()` on the ratchet — permissionless, and CALLER-PAID (D-146): the message carries
   * DeDust's 0.25 TON swap gas plus the ratchet's compute (`buildFlushMessage`'s value,
   * 0.27 TON with the fee margin); below 0.26 the contract refuses 225, and the change
   * above what the call costs comes back as `excesses`.
   *
   * §4.3: TON has no scheduler, so a contract cannot wake itself and this call is how
   * pending TON becomes a bid at or below `p_f`. Anyone may send it.
   *
   * THE TRANCHE IS SIZED TO THE VENUE, not to `pending`. The contract's own rule
   * (`min(pending, max(pending·FLUSH_PCT, FLUSH_MIN))`) knows nothing about the pool, while
   * `min_out = amount·S/T` is priced ON the pool — so a tranche larger than the venue can
   * absorb bounces off a guard doing its job, with the SPOT price well below the floor and
   * the swap's AVERAGE execution price above it. `maxInAtFloorWithHaircut` solves the guard
   * for the amount and the result rides on `flush#b0000006` as a ceiling the contract may
   * lower but never raise. `opts.amount` overrides it for a caller who wants a smaller
   * tranche still; nothing here can ask for a bigger one than the contract would send.
   */
  async flush(opts?: { amount?: bigint }) {
    this.assertSignable();
    const chain = await this.chain();
    const [pending, status] = await Promise.all([chain.pending(), chain.flushStatus()]);
    // The two asserts `handleFlush` makes, made here first. Both are cheap to read and
    // expensive to hit: 208 on an empty `pending`, and 207 inside the 24-hour cooldown,
    // which on a quiet venue is the state this call is in almost all of the time.
    if (pending === 0n) throw new Error("the ratchet has nothing pending; flush() would throw 208");
    if (status && status.cooldownRemainingSeconds > 0n) {
      throw new Error(
        `flush() is in its 24h cooldown for another ${status.cooldownRemainingSeconds}s ` +
          `(last attempt ${status.outcome}); it would throw 207`,
      );
    }

    let amountNanoton = opts?.amount ?? 0n;
    if (opts?.amount === undefined) {
      const sized = await this.venueTranche(chain);
      // `null` — the reads SUCCEEDED and say the market is at or above the floor, so no
      // tranche of any size clears the guard. Refusing is the honest answer and costs the
      // caller nothing; sending anyway buys one `payout#474f86cf` refusal on the caller's own
      // 0.25 TON of swap gas (D-146). `undefined` — the venue could not be read at all, which
      // is not the same claim: fall through to 0 and let the contract size it.
      if (sized === null) {
        throw new Error(
          "the venue is at or above the floor: no tranche of any size clears the guard, so " +
            "flush() would be refused by the pool and pending restored unchanged",
        );
      }
      if (sized !== undefined) amountNanoton = sized;
    }

    const { body, value } = buildFlushMessage({ amountNanoton });
    return (await this.wallet()).send(chain.addresses.ratchet, body, value);
  }

  /**
   * The venue-clamped tranche, or `null` when the venue is readable and nothing fills, or
   * `undefined` when it could not be read.
   *
   * The three-way answer is the point. A ratchet without `getFloorCache`, an unlisted pool
   * or a proxy that refused are all "we do not know", and the contract's own sizing is the
   * right fallback for all of them — the pre-D-143 behaviour, which was never wrong, only
   * blind. "The market is above the floor" is a different statement and gets its own value
   * so `flush()` can say it instead of paying to find out.
   */
  private async venueTranche(chain: { floorCache(): Promise<{ tCacheNanoton: bigint; sCacheNanoPrimes: bigint } | null> }) {
    try {
      const [cache, market] = await Promise.all([chain.floorCache(), this.read.market()]);
      if (cache === null) return undefined;
      return maxInAtFloorWithHaircut(
        {
          reserveTonNanoton: BigInt((market.reserveTonNanoton as string) ?? "0"),
          reservePrimesNano: BigInt((market.reservePrimesNano as string) ?? "0"),
          feeNum: market.tradeFeeNum == null ? null : BigInt(market.tradeFeeNum as string),
          feeDen: market.tradeFeeDen == null ? null : BigInt(market.tradeFeeDen as string),
        },
        cache.tCacheNanoton,
        cache.sCacheNanoPrimes,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Drain one number's `owed` - §4.1's divisor share, standing to whoever owns the item.
   *
   * **The message goes to the NUMBER'S OWN ITEM**, not to the ledger, and the item checks
   * that the sender is its owner (300). Both that and a zero balance are read first: the
   * item cheap-fails a zero claim by returning without a message, which spends the gas and
   * produces nothing, and this is a call an agent will otherwise put on a timer.
   */
  async claimTribute(n: bigint) {
    this.assertSignable();
    const chain = await this.chain();
    const item = await chain.itemAddress(n);
    const [data, owed, me] = await Promise.all([chain.numberData(item), chain.owed(item), this.address()]);
    if (Address.parse(data.owner).toString() !== me.toString()) {
      throw new Error(`this wallet does not own ${n} (owner is ${data.owner}); only the owner may claim its tribute`);
    }
    if (owed === 0n) throw new Error(`${n} is owed nothing right now - the item would cheap-fail this claim`);
    const { body, value } = buildClaimTributeMessage();
    return (await this.wallet()).send(item, body, value);
  }

  /**
   * Keep a number alive — `top_up#c1000006` on its item (D-62, `GAUNTLET.md` X3).
   *
   * PERMISSIONLESS, and that is the interesting part for a program: this is the one write in
   * the whole system that anybody may make on ANY number, including one they do not own. A
   * composite item is endowed once at deploy and never topped up again — only primes are
   * cited as tribute factors, so no `credit_tribute` reaches a composite — and when the
   * endowment runs out TON freezes the account. A frozen item answers nothing: no
   * `Transfer`, no `get_nft_data`, no claim, while §3.1 says "permanent".
   *
   * `multiples` sends that many `ITEM_DEPLOY_VALUE` endowments. One is what the mint gave
   * the item once, so one multiple buys another of whatever the first bought, at whatever
   * config-18 charges that day — which is why this takes a count of endowments and not a
   * figure in TON. `runway(n)` is the read that says whether it is worth making.
   */
  async topUp(n: bigint, multiples = 1) {
    this.assertSignable();
    const chain = await this.chain();
    const item = await chain.itemAddress(n);
    const { body, value } = buildTopUpMessage({ multiples });
    return (await this.wallet()).send(item, body, value);
  }

  /**
   * Trade PRIMES against the venue pool — the one action here that is not a protocol call.
   *
   * WHY IT IS ON THIS SURFACE. Everything else an agent can do here moves the game's own
   * state. This moves a price, and it is the action the rest of the read surface exists to
   * inform: `market()` publishes the pool's reserves and fee as a rational, `floor()`
   * publishes `p_f` as another, and an agent that can compare the two and not act on them is
   * an observer. The venue is not a third party — `getVenue()` names it and `flush()` trades
   * through it — so a swap is no more exotic here than a mint.
   *
   * `side: "buy"` sends TON to DeDust's native vault; `"sell"` sends a TEP-74 transfer from
   * this wallet's OWN PRIMES jetton wallet, addressed to the jetton vault. Both addresses are
   * read from `getVenue()` and `/primes/wallet/:address`; neither is ever guessed.
   *
   * `limit` is computed here, from the same `quoteSwap` the app's form uses (one formula, so
   * one answer to "what did the wallet sign"), and is NEVER zero — DeDust refuses a fill
   * under it by paying the input back (`payout#474f86cf`, a refusal and not a bounce), which
   * is the only protection a swapper has against the pool having moved since the quote.
   */
  async swap(opts: { side: SwapSide; amount: bigint; slippageBps?: number }) {
    this.assertSignable();
    const [venue, market, me] = await Promise.all([this.read.venue(), this.read.market(), this.address()]);
    const pool = venue.dedustPool as string;
    const quote = quoteSwap(
      {
        reserveTonNanoton: BigInt((market.reserveTonNanoton as string) ?? "0"),
        reservePrimesNano: BigInt((market.reservePrimesNano as string) ?? "0"),
        feeNum: market.tradeFeeNum == null ? null : BigInt(market.tradeFeeNum as string),
        feeDen: market.tradeFeeDen == null ? null : BigInt(market.tradeFeeDen as string),
      },
      opts.side,
      opts.amount,
      opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    );
    // No quote, no swap. An unpriceable pool, an unpublished fee or an amount that pays out
    // nothing are all cases where the only honest `limit` is one nobody can compute — and a
    // swap with no limit is the one shape this SDK will not sign.
    if (quote === null) {
      throw new Error(
        `the venue cannot quote this swap (status ${String(market.status)}, fee ${String(market.tradeFeeNum)}/` +
          `${String(market.tradeFeeDen)}); it would have to be sent with no price limit`
      );
    }
    const deadline = Math.floor(Date.now() / 1000) + DEDUST_SWAP_DEADLINE_WINDOW;

    if (opts.side === "buy") {
      const { body, value } = buildDedustSwapTonMessage({
        amountNanoton: opts.amount,
        poolAddress: pool,
        minOutPrimes: quote.minOutRaw,
        recipientAddress: me.toString(),
        deadline,
      });
      return (await this.wallet()).send(venue.dedustNativeVault as string, body, value);
    }

    // A sell leaves from this wallet's own jetton wallet, which is a derivation the master
    // publishes — reading it is also how a balance short of the amount is caught before the
    // gas is spent.
    const position = await this.read.primesBalance(me.toString());
    if (position.balancePrimes === null || position.balancePrimes < opts.amount) {
      throw new Error(
        `this wallet holds ${position.balancePrimes ?? 0n} nano-PRIMES, short of the ${opts.amount} it would sell`
      );
    }
    const { body, value } = buildDedustSwapPrimesMessage({
      amountPrimes: opts.amount,
      poolAddress: pool,
      jettonVaultAddress: venue.primesJettonVault as string,
      ownerAddress: me.toString(),
      minOutNanoton: quote.minOutRaw,
      deadline,
    });
    return (await this.wallet()).send(position.walletAddress, body, value);
  }

  /**
   * D-212 (§4.7.1): NAME A NUMBER THIS WALLET OWNS, for TON, through the collection. The
   * first naming costs the collection's `nameFee`, every later one `renameFee`; the fee goes
   * to the ratchet floor. Owner, count and fees are read live — the contract refunds a
   * refusal whole, but a refusal still costs the forward fees.
   */
  async name(opts: { n: bigint; text: string }) {
    this.assertSignable();
    const chain = await this.chain();
    if (!chain.addresses.collection) throw new Error("no collection address: naming goes through the collection (D-212)");
    const [namer, count, fees, me] = await Promise.all([
      chain.namer(opts.n),
      chain.annotationCount(opts.n),
      chain.namingFees(),
      this.address(),
    ]);
    if (!namer) throw new Error(`${opts.n} is not minted: only a minted number's owner can name it`);
    if (Address.parse(namer).toString() !== me.toString()) {
      throw new Error(`${opts.n} belongs to ${namer}, not this wallet: only its owner can name it`);
    }
    const fee = count === 0 ? fees.nameFee : fees.renameFee;
    const { body, value } = buildNameNumberMessage({ n: opts.n, text: opts.text, fee });
    return (await this.wallet()).send(chain.addresses.collection, body, value);
  }

  /**
   * An era trophy's engraving (§4.7.1): the trophy's holder engraves one of §7's eight
   * primorials. The FIRST is free (gas only); every later one costs the registrar's
   * `getTrophyRenameFee()` in TON (D-212). This is the trophy, not the number — the number's
   * own name is `name()`. Every condition is read live.
   */
  async annotate(opts: { n: bigint; text: string }) {
    this.assertSignable();
    const chain = await this.chain();
    const [trophy, me] = await Promise.all([chain.trophy(opts.n), this.address()]);
    if (!trophy.transferable) {
      throw new Error(`${opts.n} is not one of §7's eight primorials: name the number itself with name() (D-212)`);
    }
    if (!trophy.holder) throw new Error(`nobody holds the era trophy on ${opts.n} yet`);
    if (Address.parse(trophy.holder).toString() !== me.toString()) {
      throw new Error(`the era trophy on ${opts.n} belongs to ${trophy.holder}, not this wallet`);
    }
    const count = await chain.trophyAnnotationCount(opts.n);
    const renameFee = count > 0 ? await chain.trophyRenameFee() : undefined;
    const { body, value } = buildAnnotateMessage({ n: opts.n, text: opts.text, renameFee });
    return (await this.wallet()).send(chain.addresses.registrar, body, value);
  }

  /**
   * D-14 (§4.7): move an era trophy — the naming-right pen over one of §7's eight
   * primorials. Sent by the CURRENT HOLDER and by nobody else; `getTrophy(n)` is read
   * live so a wallet that no longer holds the pen spends gas on a message rather than
   * getting told locally, but never one this wallet plainly cannot send. `DESIGN.md` G45.
   */
  async transferTrophy(opts: { primorial: bigint; newHolder: string }) {
    this.assertSignable();
    const chain = await this.chain();
    const [trophy, me] = await Promise.all([chain.trophy(opts.primorial), this.address()]);
    if (!trophy.transferable) throw new Error(`${opts.primorial} is not one of §7's eight primorials`);
    if (!trophy.holder || Address.parse(trophy.holder).toString() !== me.toString()) {
      throw new Error(`the era trophy on ${opts.primorial} belongs to ${trophy.holder ?? "nobody yet"}, not this wallet`);
    }
    const { body, value } = buildTransferTrophyMessage({
      primorial: opts.primorial,
      newHolder: opts.newHolder,
    });
    return (await this.wallet()).send(chain.addresses.registrar, body, value);
  }
}

/** The margin a bid carries above its nominal: the contract compares what ARRIVES. */
export const BID_FEE_MARGIN: bigint = BID_FEE_MARGIN_NANOTON;
