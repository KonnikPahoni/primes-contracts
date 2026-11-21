/**
 * The read half: the published HTTP projections, typed, throttled and honest about which
 * of them may be spent against.
 *
 * CONCEPT.md §9.1 draws the line this module is built around. Every read-proxy response
 * carries a `provenance` object naming the get-method and contract address behind the
 * figure, so anything it returns is recomputable; the read-INDEX answers the questions no
 * single get-method does (which lots are open, who leads a board) and its rows are
 * CANDIDATES. **The index is for browsing; a number you are about to spend against comes
 * from the chain** — `chain.ts` is that path, and `act.*` uses it rather than these.
 *
 * Throttling is at the client, which is `MISTAKES.md`'s rule from the genesis 429: a
 * retry at the call site looks like coverage and is not. read-proxy allows 600 requests a
 * minute per IP and read-index 120, both answering `429` with `Retry-After`, so the
 * default here is a conservative 2/s and one bounded backoff.
 */
import { createPacer, type Pacer } from "@ton-primes/common/pace";
import { DEFAULT_FETCH_TIMEOUT_MS } from "@ton-primes/common/fetchJson";

export const DEFAULT_READ_PROXY_URL = "https://primes.live/api";
export const DEFAULT_READ_INDEX_URL = "https://primes.live/idx";
/**
 * The event poller. A THIRD service because it answers a third kind of question: not a
 * get-method projection (read-proxy) and not a chain-derived table (read-index) but
 * indexed HISTORY — what a wallet was ever credited, the candidates behind a portfolio.
 * Nothing the chain can answer, because the collection publishes no owner index.
 */
export const DEFAULT_EVENTS_URL = "https://primes.live/events";

export interface Provenance {
  source?: string;
  fetchedAt?: string;
  getMethod?: string;
  address?: string;
}

export interface ReadOptions {
  readProxyUrl?: string;
  readIndexUrl?: string;
  eventsUrl?: string;
  /** Requests per second, across both services. Default 2 — well inside both budgets. */
  rps?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. `fetch` has none in Node, so a hung service hung the caller. */
  timeoutMs?: number;
}

/**
 * What a read-proxy endpoint returns: the figure, plus where it came from.
 *
 * `provenance` is an OBJECT on a route backed by one get-method and an ARRAY on a route
 * that assembles several — `/solvency`, `/supply`, `/number/:n/name`, `/treasury`, `/vesting`,
 * `/stake`, `/stake/:address`, `/assets/:n/yield` and `/primes/wallet/:address` are the
 * array ones today. Typed as the union rather than as the
 * common case, because narrowing it to an object is a lie a consumer finds only at runtime.
 */
export interface Read<T> {
  data: T;
  provenance?: Provenance | Provenance[];
}

/** `getLedgerCounters` — T and S, plus §3.2's two dividend counters and D-156's `S_MAX`. */
export interface LedgerCounters {
  /** T, the ratchet's numerator, in nanoTON. */
  tNanoton: bigint;
  /** S, the denominator, in the smallest PRIMES unit. */
  sPrimes: bigint;
  /** §3.2's flat prime-dividend accumulator. */
  divAccNanoton: bigint;
  /** The number of primes minted so far. */
  primeCount: bigint;
  /** D-156's `S_MAX`, the ceiling `S` approaches and never reaches. */
  maxSupplyPrimes: bigint;
}

/** `getFlushStatus` — §4.3.1's floor guard, and why the last attempt did nothing. */
export interface FlushStatus {
  lastAttemptTime: bigint;
  /**
   * `never` and `bounced` look identical from outside without this field, and §12 says a
   * dead venue must not hide behind months of legitimate-looking non-execution.
   */
  outcome: "never" | "filled" | "bounced";
  amountNanoton: bigint;
  cooldownRemainingSeconds: bigint;
}

/**
 * `getFloorCache` — the `(T, S)` pair the FLOOR GUARD actually prices against.
 *
 * NOT the same numbers as `floor()`. The ledger's pair is authoritative and moves on every
 * mint; the ratchet's is a MIRROR pushed with each `PoolInject`, and `computeMinOut` reads
 * the mirror. An agent previewing a flush or sizing a tranche must read this one — previewing
 * against the ledger's pair is previewing a guard the chain will not apply.
 */
export interface FloorCache {
  tCacheNanoton: bigint;
  sCachePrimes: bigint;
}

/**
 * `getStaking` — CONCEPT.md §4.3.2's staked reserve (`DECISIONS.md` D-151).
 *
 * The ratchet's `pending` above a liquid reserve sits in the Tonstakers pool as tsTON and is
 * counted in `T` **at cost**, so the identity is six terms:
 * `T = seeded + swapped + pending + stakedCost + exiting + realizedLoss`. An agent checking
 * that identity reads this alongside `pending()`, `swapped()` and `seedT()`.
 */
/** `ratchetIdentity()` — every term of §5's identity from one ordered snapshot. */
export interface RatchetIdentity {
  tNanoton: bigint;
  seedTNanoton: bigint;
  tCacheNanoton: bigint;
  sCachePrimes: bigint;
  pendingNanoton: bigint;
  swappedNanoton: bigint;
  staking: Staking;
}

export interface Staking {
  /** TON in the pool, at what it cost. A term of `T`. */
  stakedCostNanoton: bigint;
  /** nano-tsTON owned, EXCLUDING a tranche inside the exit machine (`exiting` counts that). */
  tstonHeldNano: bigint;
  /** A tranche on its way back out, at the cost basis it carried when it left. A term of `T`. */
  exitingNanoton: bigint;
  /** The rate as the PAIR it was learned as, off a `stake()` mint notification. */
  lastRateNum: bigint;
  lastRateDen: bigint;
  /** Derived on chain from `pending + stakedCost + exiting`, never stored. */
  reserveTargetNanoton: bigint;
  /** Unix seconds; `0` before the first harvest. */
  lastHarvestTime: bigint;
  /** Cumulative TON that left `T` and did not come back. Non-zero ⇒ `p_f` overstates the
   *  backing by exactly `realizedLoss / S`. Never netted into `stakedCostNanoton`. */
  realizedLossNanoton: bigint;
}

/** `getLot(n)` over HTTP — the same reading `PrimesChain.lot` takes off the chain. */
export interface LotReading {
  found: boolean;
  closed: boolean;
  /** 0 = ascending (composites), 2 = descending buy-now (primes). */
  mode: number;
  p0Nanoton: bigint;
  standingPriceNanoton: bigint;
  minNextBidNanoton: bigint;
  highBidNanoton: bigint;
  highBidder: string;
  openedAt: bigint;
  closesAt: bigint;
}

/** `getLotPrice(n)` — what opening a lot on `n` would cost, and which lane it lands in. */
export interface LotPrice {
  p0Nanoton: bigint;
  resGasNanoton: bigint;
  minIncrementNanoton: bigint;
  score: bigint;
  flags: bigint;
  /** 0 = ascending/composite, 2 = prime Dutch, **-1 = not openable**. */
  lane: number;
  npvNanoton: bigint | null;
  primeFloorNanoton: bigint | null;
}

/** One row of the `/numbers` batch: the item's OWN word on who holds `n`. */
export interface NumberRow {
  n: bigint;
  minted: boolean;
  owner: string | null;
  isPrime: boolean | null;
  owedNanoton: bigint | null;
  itemAddress: string;
}

/** §4.7's two ladders for one wallet, as scaled integers. */
export interface Ranks {
  address: string;
  recruitRank: bigint;
  primeRank: bigint;
}

/** One wallet's PRIMES jetton position. `walletDeployed: false` is a real zero. */
export interface PrimesBalance {
  owner: string;
  walletAddress: string;
  walletDeployed: boolean;
  balancePrimes: bigint | null;
}

/** A bounty the genesis schedule either funded for this subject, or did not (D-99/D-107). */
export interface BountyStatus {
  /** `false` = the schedule never funded this one. NOT the same as one already spent. */
  scheduled: boolean;
  bountyTonNanoton: bigint;
  maxPrimesNanoton: bigint;
  paid: boolean;
}

/** The read-index boards (`/boards/*`). */
export type BoardKind = "recruiters" | "prime-finders" | "era" | "mints" | "referrals";
/** The read-index feeds (`/feed/*`). */
export type FeedKind = "mints" | "floor";

export class PrimesRead {
  private readonly proxyUrl: string;
  private readonly indexUrl: string;
  private readonly eventsUrl: string;
  private readonly pace: Pacer;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ReadOptions = {}) {
    this.proxyUrl = (opts.readProxyUrl ?? DEFAULT_READ_PROXY_URL).replace(/\/$/, "");
    this.indexUrl = (opts.readIndexUrl ?? DEFAULT_READ_INDEX_URL).replace(/\/$/, "");
    this.eventsUrl = (opts.eventsUrl ?? DEFAULT_EVENTS_URL).replace(/\/$/, "");
    this.pace = createPacer({ rps: opts.rps ?? 2 });
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  /**
   * One GET, paced, with a single retry on `429` that honours `Retry-After`.
   *
   * One retry, not a loop: a second 429 means the budget is genuinely spent and the caller
   * should slow down rather than have the SDK queue on their behalf.
   */
  private async get<T>(base: string, path: string): Promise<T> {
    const url = `${base}${path}`;
    const once = async () => {
      const res = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429) return res;
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text().catch(() => "")}`.trim());
      return res;
    };
    let res = await this.pace(once);
    if (res.status === 429) {
      // Delta-seconds only. `Number("")` is 0 and "-5" negative — both an instant retry into the
      // same spent window — and an HTTP-date is NaN. Absent, blank or not >= 0 waits 1s.
      const raw = res.headers.get("retry-after")?.trim();
      const wait = raw ? Number(raw) : NaN;
      await new Promise((r) => setTimeout(r, Math.min(wait >= 0 ? wait : 1, 30) * 1000));
      res = await this.pace(once);
      if (res.status === 429) throw new Error(`GET ${url} -> 429 twice; slow down (read-proxy allows 600/min per IP)`);
    }
    return (await res.json()) as T;
  }

  /** Any read-proxy path, for the endpoints this class does not name. */
  proxy<T>(path: string): Promise<Read<T>> {
    return this.get<Read<T>>(this.proxyUrl, path);
  }

  /** Any read-index path. Rows are candidates — settle them on chain before acting. */
  index<T>(path: string): Promise<T> {
    return this.get<T>(this.indexUrl, path);
  }

  /** Any event-poller path. Indexed HISTORY, and an owner column is MINT-TIME: a number sold
   *  on since is still listed under its minter. The item's own get-method says who holds it now. */
  events<T>(path: string): Promise<T> {
    return this.get<T>(this.eventsUrl, path);
  }

  /**
   * `/contracts` — the deployment manifest, by §3.4 role.
   *
   * An unset role is OMITTED rather than sent as null, deliberately: "this deployment has
   * no bounty vault" and "the vault is at null" are different claims. Read a role you need
   * and fail loudly if it is missing; never fall through to another address.
   */
  async contracts(): Promise<Record<string, string>> {
    const { data } = await this.proxy<Record<string, string>>("/contracts");
    return data;
  }

  /** `getHead` — the next integer to be minted. Browsing only; `act.mint` re-reads it. */
  async head(): Promise<bigint> {
    const { data } = await this.proxy<{ head: string }>("/ledger/head");
    return BigInt(data.head);
  }

  /** `getFloorNum` / `getFloorDen` — `p_f = T / S`, as the ratio, never pre-divided. */
  async floor(): Promise<{ numNanoton: bigint; denPrimes: bigint }> {
    const { data } = await this.proxy<{ floorNumNanoton: string; floorDenPrimes: string }>("/ledger/floor");
    return { numNanoton: BigInt(data.floorNumNanoton), denPrimes: BigInt(data.floorDenPrimes) };
  }

  /** `isKnownPrime` — the ledger's own bitmap, not a local primality test. */
  async isKnownPrime(n: bigint): Promise<boolean> {
    const { data } = await this.proxy<{ isPrime: boolean }>(`/number/${n}/prime`);
    return data.isPrime;
  }

  /** Open lots, newest first. Candidates: `act.bid` reads `getLot(n)` before it sends. */
  async openLots(limit = 50): Promise<unknown[]> {
    const res = await this.index<{ data?: { rows?: unknown[] } }>(`/lots/open?limit=${limit}`);
    return res.data?.rows ?? [];
  }

  /** `getNumberData()` + `getOwed()` on `n`'s own item: who holds it and what it is owed. */
  async number(n: bigint): Promise<{ owner: string; isPrime: boolean; owedNanoton: bigint }> {
    // Two get-methods on one item, so the route envelopes each SEPARATELY rather than
    // wrapping the pair in one `data` — no figure is attributed to a call it did not
    // come from. `proxy()` would look for an outer `data` that is not there.
    const res = await this.get<{
      number: { data: { owner: string; isPrime: boolean } };
      owed: { data: { owedNanoton: string } };
    }>(this.proxyUrl, `/number/${n}`);
    return {
      owner: res.number.data.owner,
      isPrime: res.number.data.isPrime,
      owedNanoton: BigInt(res.owed.data.owedNanoton),
    };
  }

  /** `getItemAddress(n)` — where `n`'s NFT item lives, which is where a tribute claim goes. */
  async itemAddress(n: bigint): Promise<string> {
    // Bare `{ address }`, no provenance envelope: an item's address is a function of the
    // collection code and `n`, so the route serves it `immutable` rather than as a reading.
    const res = await this.get<{ address: string }>(this.proxyUrl, `/item/${n}/address`);
    return res.address;
  }

  /**
   * `/number/:n/name` — D-212 (§4.7.1): who may name `n` (its CURRENT OWNER, item(n)'s
   * `getNamer`), the name standing on it (`getAnnotation`), and the TON the next naming costs
   * (collection `getNaming`: `nameFee` first, `renameFee` after; `null` while unminted). A
   * primorial also carries `trophy`, the registrar's separate era-trophy engraving.
   * nanoTON. Index-grade: `act.name` re-reads the fee from the chain before it spends.
   */
  async name(n: bigint): Promise<{
    namer: string | null;
    count: number;
    text: string | null;
    nameFee: bigint;
    renameFee: bigint;
    nextFee: bigint | null;
    trophy?: { holder: string | null; count: number; text: string | null; renameFee: bigint };
  }> {
    type Ann = { count: number; text: string | null };
    const { namer, annotation, fees, trophy } = await this.get<{
      namer: { data: { namer: string | null } };
      annotation: { data: Ann };
      fees: { data: { nameFee: string; renameFee: string; nextFee: string | null } };
      trophy?: { data: { holder: string | null; annotation: Ann; renameFee: string } };
    }>(this.proxyUrl, `/number/${n}/name`);
    return {
      namer: namer.data.namer,
      count: annotation.data.count,
      text: annotation.data.text,
      nameFee: BigInt(fees.data.nameFee),
      renameFee: BigInt(fees.data.renameFee),
      nextFee: fees.data.nextFee === null ? null : BigInt(fees.data.nextFee),
      ...(trophy && {
        trophy: {
          holder: trophy.data.holder,
          count: trophy.data.annotation.count,
          text: trophy.data.annotation.text,
          renameFee: BigInt(trophy.data.renameFee),
        },
      }),
    };
  }

  /**
   * The numbers one wallet holds, ascending.
   *
   * `/wallets/:address/numbers` serves `data.numbers`, NOT `data.rows` — the boards and
   * the lot lists use `rows`, the per-wallet routes do not, and reading the wrong key here
   * returned an empty portfolio for every wallet in the world without ever failing. Each
   * entry is a `{ value, provenance }` reading, so the integer is `.value`.
   *
   * This is the read-INDEX's word, replayed from observed transfers. `/numbers` (below)
   * confirms a subset against each item's own `getNumberData()`, which is what must happen
   * before the word "owned" or a claim button appears.
   */
  async numbersOf(address: string, limit = 200): Promise<bigint[]> {
    const res = await this.index<{ data?: { numbers?: { value: string }[] } }>(
      `/wallets/${address}/numbers?limit=${limit}`,
    );
    return (res.data?.numbers ?? []).map((r) => BigInt(r.value));
  }

  // =========================================================================
  // The ratchet and the ledger's counters (CONCEPT.md §5)
  // =========================================================================

  /** T, S and §3.2's two counters in ONE request — they change together, on a mint. */
  async counters(): Promise<LedgerCounters> {
    const { data } = await this.proxy<{
      floorNumNanoton: string;
      floorDenPrimes: string;
      divAccNanoton: string;
      primeCount: string;
      maxSupplyPrimes: string;
    }>("/ledger/counters");
    return {
      tNanoton: BigInt(data.floorNumNanoton),
      sPrimes: BigInt(data.floorDenPrimes),
      divAccNanoton: BigInt(data.divAccNanoton),
      primeCount: BigInt(data.primeCount),
      maxSupplyPrimes: BigInt(data.maxSupplyPrimes),
    };
  }

  /** `getPending` — TON waiting in the ratchet for the next `flush()`. */
  async pending(): Promise<bigint> {
    const { data } = await this.proxy<{ pendingNanoton: string }>("/ratchet/pending");
    return BigInt(data.pendingNanoton);
  }

  /** `getSwapped` — cumulative TON the ratchet has actually spent at the venue. */
  async swapped(): Promise<bigint> {
    const { data } = await this.proxy<{ swappedNanoton: string }>("/ratchet/swapped");
    return BigInt(data.swappedNanoton);
  }

  /**
   * §4.3.1's floor guard: when `flush()` last ran, what it did, and the cooldown left.
   *
   * `outcome` is the field worth reading. `never` and `bounced` are indistinguishable from
   * the outside without it, and a venue that has been refusing for months looks exactly
   * like one nobody has called.
   */
  async flushStatus(): Promise<FlushStatus> {
    const { data } = await this.proxy<{
      lastAttemptTime: string;
      outcome: FlushStatus["outcome"];
      amountNanoton: string;
      cooldownRemainingSeconds: string;
    }>("/ratchet/flush-status");
    return {
      lastAttemptTime: BigInt(data.lastAttemptTime),
      outcome: data.outcome,
      amountNanoton: BigInt(data.amountNanoton),
      cooldownRemainingSeconds: BigInt(data.cooldownRemainingSeconds),
    };
  }

  /**
   * The `(T, S)` the floor guard prices against — the RATCHET's mirror, not the ledger's pair.
   *
   * Read this before sizing a flush. `floor()` returns the authoritative pair, which moves on
   * every mint; this one moves on every `PoolInject`, and it is the one `computeMinOut`
   * compares a swap against — never substitute `floor()` for it.
   */
  async floorCache(): Promise<FloorCache> {
    const { data } = await this.proxy<{ tCacheNanoton: string; sCacheNanoPrimes: string }>(
      "/ratchet/floor-cache"
    );
    return { tCacheNanoton: BigInt(data.tCacheNanoton), sCachePrimes: BigInt(data.sCacheNanoPrimes) };
  }

  /**
   * `getStaking` — §4.3.2's staked reserve, all eight figures in one read.
   */
  async staking(): Promise<Staking> {
    const { data } = await this.proxy<{
      stakedCostNanoton: string;
      tstonHeldNano: string;
      exitingNanoton: string;
      lastRateNum: string;
      lastRateDen: string;
      reserveTargetNanoton: string;
      lastHarvestTime: string;
      realizedLossNanoton: string;
    }>("/ratchet/staking");
    return {
      stakedCostNanoton: BigInt(data.stakedCostNanoton),
      tstonHeldNano: BigInt(data.tstonHeldNano),
      exitingNanoton: BigInt(data.exitingNanoton),
      lastRateNum: BigInt(data.lastRateNum),
      lastRateDen: BigInt(data.lastRateDen),
      reserveTargetNanoton: BigInt(data.reserveTargetNanoton),
      lastHarvestTime: BigInt(data.lastHarvestTime),
      realizedLossNanoton: BigInt(data.realizedLossNanoton),
    };
  }

  /**
   * §5's identity as ONE ordered snapshot: the ratchet's `getFloorOracle` + `getStaking`, then
   * the ledger's `getFloorNum`. Two exact claims come out of it: `tCacheNanoton` equals
   * seeded + swapped + pending + the three staking terms, and `tNanoton − tCacheNanoton` is
   * TON a `PoolInject` is still carrying to the ratchet. Check the identity from this, not
   * from `floor()` plus `pending()` read at two moments: those disagree for one hop after
   * every mint with nothing wrong.
   */
  async ratchetIdentity(): Promise<RatchetIdentity> {
    const { data } = await this.proxy<{
      tNanoton: string;
      seedTNanoton: string;
      tCacheNanoton: string;
      sCacheNanoPrimes: string;
      pendingNanoton: string;
      swappedNanoton: string;
      staking: Record<keyof Staking, string>;
    }>("/ratchet/identity");
    const staking = Object.fromEntries(
      Object.entries(data.staking).map(([k, v]) => [k, BigInt(v)])
    ) as unknown as Staking;
    return {
      tNanoton: BigInt(data.tNanoton),
      seedTNanoton: BigInt(data.seedTNanoton),
      tCacheNanoton: BigInt(data.tCacheNanoton),
      sCachePrimes: BigInt(data.sCacheNanoPrimes),
      pendingNanoton: BigInt(data.pendingNanoton),
      swappedNanoton: BigInt(data.swappedNanoton),
      staking,
    };
  }

  /** `getK(n, t)` — the live rebate coefficient, scaled. `k < 1` always (§5). */
  async k(n: bigint, t: bigint): Promise<bigint> {
    const { data } = await this.proxy<{ k: string }>(`/ledger/k?n=${n}&t=${t}`);
    return BigInt(data.k);
  }

  /** `getKMax(n)` — `2.7 / log10(n)`, the ceiling `k` decays from (§5). */
  async kMax(n: bigint): Promise<bigint> {
    const { data } = await this.proxy<{ kMax: string }>(`/ledger/kmax?n=${n}`);
    return BigInt(data.kMax);
  }

  /** `getLastMintTime` — the `t` the rebate clock runs from. `0` = nothing minted yet. */
  async lastMintTime(): Promise<bigint> {
    const { data } = await this.proxy<{ lastMintTime: string }>("/ledger/last-mint-time");
    return BigInt(data.lastMintTime);
  }

  /**
   * `getSeedT` — the founder capital genesis credited STRAIGHT into `T` (D-26).
   *
   * `T = seeded + swapped + pending + stakedCost + exiting + realizedLoss` (D-26, D-151,
   * §4.3.2), and a reading that drops a term reports a permanent false solvency gap exactly
   * the size of the term it dropped. The last three terms come from `staking()` on this
   * same client.
   */
  async seedT(): Promise<bigint> {
    const { data } = await this.proxy<{ seedTNanoton: string }>("/ledger/seed-t");
    return BigInt(data.seedTNanoton);
  }

  /**
   * The head, the rebate clock and the floor in ONE round trip.
   *
   * `k` is `getK(n, t)`, so a client that asks for it separately pays two sequential trips
   * to learn `n` and `t` first. Each field carries its OWN envelope or is `null` with a
   * reason in `unavailable` — a partial answer rather than a failed one.
   */
  async bootstrap(): Promise<Record<string, unknown>> {
    return await this.get<Record<string, unknown>>(this.proxyUrl, "/bootstrap");
  }

  // =========================================================================
  // One wallet
  // =========================================================================

  /** The wallet's TON balance. `null` = the account read failed, NOT a zero balance. */
  async balance(address: string): Promise<bigint | null> {
    const { data } = await this.proxy<{ balanceNanoton: string | null }>(`/wallet/${address}/balance`);
    return data.balanceNanoton === null ? null : BigInt(data.balanceNanoton);
  }

  /** The wallet's seqno. `null` = not deployed yet (an unfunded wallet has no state). */
  async seqno(address: string): Promise<number | null> {
    const { data } = await this.proxy<{ seqno: number | null }>(`/wallet/${address}/seqno`);
    return data.seqno;
  }

  /** One wallet's PRIMES position, through the jetton master's own `get_wallet_address`. */
  async primesBalance(address: string): Promise<PrimesBalance> {
    const { data } = await this.proxy<{
      owner: string;
      walletAddress: string;
      walletDeployed: boolean;
      balancePrimes: string | null;
    }>(`/primes/wallet/${address}`);
    return {
      owner: data.owner,
      walletAddress: data.walletAddress,
      walletDeployed: data.walletDeployed,
      balancePrimes: data.balancePrimes === null ? null : BigInt(data.balancePrimes),
    };
  }

  /** §4.7's recruit and prime ladders for one wallet. */
  async ranks(address: string): Promise<Ranks> {
    const { data } = await this.proxy<{ address: string; recruitRank: string; primeRank: string }>(
      `/ranks/${address}`,
    );
    return { address: data.address, recruitRank: BigInt(data.recruitRank), primeRank: BigInt(data.primeRank) };
  }

  /**
   * Every §5 uplift this wallet carries, and the `K_CEIL` clamp over their SUM.
   *
   * The `clamped` flag is the one that matters: past the ceiling a further uplift buys
   * nothing, and an agent optimising for `k` needs to know it is already there.
   */
  async earn(address: string, head?: bigint): Promise<Record<string, unknown>> {
    const q = head === undefined ? "" : `?head=${head}`;
    const { data } = await this.proxy<Record<string, unknown>>(`/earn/${address}${q}`);
    return data;
  }

  // =========================================================================
  // Numbers, lots and prices
  // =========================================================================

  /**
   * Ownership for up to 24 numbers in one request, each read off its OWN item.
   *
   * This is the CONFIRMATION step behind a portfolio: `numbersOf` gives the candidate set
   * from indexed transfers, and this settles it against `getNumberData()`, which is what
   * drops a number the wallet has since sold. `truncated` is reported, never silent.
   */
  async numbers(ns: bigint[]): Promise<{ numbers: NumberRow[]; truncated: boolean; maxPerRequest: number }> {
    const res = await this.get<{
      numbers: {
        n: string;
        minted: boolean;
        owner: string | null;
        isPrime: boolean | null;
        owedNanoton: string | null;
        itemAddress: string;
      }[];
      truncated: boolean;
      maxPerRequest: number;
    }>(this.proxyUrl, `/numbers?ns=${ns.join(",")}`);
    return {
      numbers: res.numbers.map((r) => ({
        n: BigInt(r.n),
        minted: r.minted,
        owner: r.owner,
        isPrime: r.isPrime,
        owedNanoton: r.owedNanoton === null ? null : BigInt(r.owedNanoton),
        itemAddress: r.itemAddress,
      })),
      truncated: res.truncated,
      maxPerRequest: res.maxPerRequest,
    };
  }

  /** `getLot(n)` over HTTP. Cached — `PrimesChain.lot` is what a bid is checked against. */
  async lot(n: bigint): Promise<LotReading> {
    const { data } = await this.proxy<{
      found: boolean;
      closed: boolean;
      mode: number;
      p0Nanoton: string;
      standingPriceNanoton: string;
      minNextBidNanoton: string;
      highBidNanoton: string;
      highBidder: string;
      openedAt: string;
      closesAt: string;
    }>(`/trophy/lot/${n}`);
    return {
      found: data.found,
      closed: data.closed,
      mode: data.mode,
      p0Nanoton: BigInt(data.p0Nanoton),
      standingPriceNanoton: BigInt(data.standingPriceNanoton),
      minNextBidNanoton: BigInt(data.minNextBidNanoton),
      highBidNanoton: BigInt(data.highBidNanoton),
      highBidder: data.highBidder,
      openedAt: BigInt(data.openedAt),
      closesAt: BigInt(data.closesAt),
    };
  }

  /**
   * What opening a lot on `n` would cost, and WHICH LANE it lands in (D-88/D-90).
   *
   * `lane: -1` is "not openable" — the honest answer for a number behind the head. A `409`
   * is thrown rather than returned: `n` is above the market's cap, which is a fact about
   * the request, not a price.
   */
  async lotPrice(n: bigint): Promise<LotPrice> {
    const { data } = await this.proxy<{
      p0Nanoton: string;
      resGasNanoton: string;
      minIncrementNanoton: string;
      score: string;
      flags: string;
      lane: number;
      npvNanoton: string | null;
      primeFloorNanoton: string | null;
    }>(`/trophy/price/${n}`);
    return {
      p0Nanoton: BigInt(data.p0Nanoton),
      resGasNanoton: BigInt(data.resGasNanoton),
      minIncrementNanoton: BigInt(data.minIncrementNanoton),
      score: BigInt(data.score),
      flags: BigInt(data.flags),
      lane: data.lane,
      npvNanoton: data.npvNanoton === null ? null : BigInt(data.npvNanoton),
      primeFloorNanoton: data.primeFloorNanoton === null ? null : BigInt(data.primeFloorNanoton),
    };
  }

  /** `getLotFloor(n)` — the resting price a descending lot parks at and never leaves.
   *  `null` = no lot on `n` has recorded one (`found: false`). */
  async lotFloor(n: bigint): Promise<bigint | null> {
    const { data } = await this.proxy<{ found: boolean; floorNanoton: string }>(`/trophy/floor/${n}`);
    return data.found ? BigInt(data.floorNanoton) : null;
  }

  /** `getScore(n)` with the bit-by-bit breakdown — §9.6's desirability, itemised. */
  async score(n: bigint): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>(`/trophy/score/${n}`);
    return data;
  }

  /** The market's compile-time constants: the score table, the ladder, the Dutch decay. */
  async trophyParams(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/trophy/params");
    return data;
  }

  /** Market-wide totals: open and closed lots, and the premium injected at close. */
  async trophy(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/trophy");
    return data;
  }

  /** Who holds `n`'s trophy, and whether it can move. */
  async numberTrophy(n: bigint): Promise<{ holder: string | null; transferable: boolean }> {
    const { data } = await this.proxy<{ holder: string | null; transferable: boolean }>(`/number/${n}/trophy`);
    return data;
  }

  /**
   * `getStorageRunway()` on `n`'s item — how long its rent lasts at the current balance.
   *
   * THREE values, not one scale: seconds remaining, `-1` for no finite runway, and `0` for
   * already out. Read the get-method before treating the answer as a duration.
   */
  async runway(n: bigint): Promise<bigint> {
    const { data } = await this.proxy<{ runwaySeconds: string }>(`/number/${n}/runway`);
    return BigInt(data.runwaySeconds);
  }

  /** `getTributeTotal()` on n's item — every divisor tribute ever credited, nanoton. */
  async tributeTotal(n: bigint): Promise<bigint> {
    const { data } = await this.proxy<{ tributeTotalNanoton: string }>(`/number/${n}/tribute`);
    return BigInt(data.tributeTotalNanoton);
  }

  /** `isNumberOffHead(n)` — a lot has claimed n off the sequential line; the head skips it
   *  forever. Resolved by the proxy: beyond the ledger's import frontier (D-196) the mark is
   *  read from the block's lot block, so this is always a plain boolean. */
  async isOffHead(n: bigint): Promise<boolean> {
    const { data } = await this.proxy<{ isOffHead: boolean }>(`/number/${n}/off-head`);
    return data.isOffHead;
  }

  /** `RES_GAS` and the slice of it that rides to the ledger with a settlement (§4.4). */
  async feeSplit(): Promise<{ resGasNanoton: bigint; settleGasNanoton: bigint }> {
    const { data } = await this.proxy<{ resGasNanoton: string; settleGasNanoton: string }>(
      "/lots/fee-split",
    );
    return { resGasNanoton: BigInt(data.resGasNanoton), settleGasNanoton: BigInt(data.settleGasNanoton) };
  }

  /** One number's realised cash-flow rate, DERIVED from two readings — not a get-method. */
  async yieldOf(n: bigint): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>(`/assets/${n}/yield`);
    return data;
  }

  /** The candidate set behind a portfolio: mint-time attribution, plus a holder index. */
  async portfolioOf(address: string): Promise<Record<string, unknown>> {
    return await this.events<Record<string, unknown>>(`/portfolio/${address}`);
  }

  // =========================================================================
  // The bounty vault (D-99 / D-107)
  // =========================================================================

  /** The era ceremony's prize for `n`. There are EIGHT boundaries, ever (§7). */
  async eraSchedule(n: bigint): Promise<BountyStatus> {
    return this.bounty(`/vault/era/${n}`);
  }

  /** One rebate's schedule and whether it is spent (D-99). */
  async rebate(kind: number, n: bigint): Promise<BountyStatus> {
    return this.bounty(`/vault/rebate/${kind}/${n}`);
  }

  /**
   * One allow-list entry by program tag (D-170 point 4): which contract may spend it and
   * the nanoPRIMES left. `PROGRAM_TAG_SECURITY`'s `remainingNanoprimes` is the bug-bounty prize.
   */
  async vaultProgram(tag: number): Promise<{ found: boolean; addrHash: string; remainingNanoprimes: bigint }> {
    const { data } = await this.proxy<{ found: boolean; addrHash: string; remainingNanoprimes: string }>(
      `/vault/program/${tag}`
    );
    return { ...data, remainingNanoprimes: BigInt(data.remainingNanoprimes) };
  }

  /** The vault's own wiring: which ledger and jetton it pays from. */
  async vault(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/vault");
    return data;
  }

  private async bounty(path: string): Promise<BountyStatus> {
    const { data } = await this.proxy<{
      scheduled: boolean;
      bountyTonNanoton: string;
      maxPrimesNanoton: string;
      paid: boolean;
    }>(path);
    return {
      scheduled: data.scheduled,
      bountyTonNanoton: BigInt(data.bountyTonNanoton),
      maxPrimesNanoton: BigInt(data.maxPrimesNanoton),
      paid: data.paid,
    };
  }

  // =========================================================================
  // The auditor's surfaces (§9.1) — passthrough, because the ROUTE is the schema
  // =========================================================================
  //
  // Each of these assembles many get-methods into one document whose shape is owned by
  // read-proxy's OpenAPI spec, not by this package. They are returned as read, with the
  // response's `provenance` array intact on the envelope: restating forty field names here
  // would create a second schema to keep in sync, and a stale one is worse than none.

  /** `S`, what has been burned out of it, and what the vault has not yet paid (§3.3). */
  async supply(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/supply");
    return data;
  }

  /** §3.4's decomposition: each contract's balance against its DECLARED liability. */
  async solvency(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/solvency");
    return data;
  }

  /** The three DeDust addresses `flush()` trades through. */
  async venue(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/venue");
    return data;
  }

  /**
   * The PRIMES market price, read off the venue pool's own `get_reserves`.
   *
   * A get-method reading like everything else here, deliberately — the price used to come
   * from a DEX aggregator's API, which made the figure an agent most wants to compare
   * against `p_f` the one figure it could not verify, and made it unreadable on any
   * deployment the aggregator does not index. `spotNumNanoton / spotDenPrimes` is the pool's
   * MID price (before the venue's fee and slippage), in the same `num/den` shape
   * `floor()` publishes `p_f`, so an agent divides two rationals rather than comparing two
   * roundings. `tradeFeeNum / tradeFeeDen` is the pool's own `get_trade_fee` — what a real
   * fill costs on top of that mid price, read rather than assumed, and `null` for a venue
   * that publishes none. `series` is the proxy's own log of the readings it has taken; no
   * get-method anywhere answers "what WAS the price".
   */
  async market(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/market");
    return data;
  }

  /** The treasury's genesis PRIMES lock — the only vesting lock since D-166 deleted the
   *  operator's. */
  async vesting(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/vesting");
    return data;
  }

  /** The governed treasury's balances, ladder and solvency (D-100). */
  async treasury(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/treasury");
    return data;
  }

  /** Open governance proposals. `voter` adds `hasVoted` per row. */
  async treasuryProposals(voter?: string): Promise<Record<string, unknown>> {
    const q = voter ? `?voter=${voter}` : "";
    const { data } = await this.proxy<Record<string, unknown>>(`/treasury/proposals${q}`);
    return data;
  }

  /**
   * `/treasury/ledger` (read-index) — every message observed on the governed treasury,
   * newest first. The HISTORY behind `treasury()`'s standing balances, which no
   * get-method returns because the contract stores none.
   *
   * Rows are not labelled with an asset and cannot be here: a jetton inflow is PRIMES, LP
   * or tsTON (D-151's harvested staking yield) according to which of the treasury's three
   * jetton wallets forwarded it (`jettonWallet`, against `getTreasuryConfig()` —
   * `treasury()` publishes all three), and an `execute` names
   * only a proposal `seq` whose asset lives in the contract's dictionary
   * (`treasuryProposals()`). Both keys travel on the row; the labelling is the caller's.
   */
  async treasuryLedger(limit = 50): Promise<unknown[]> {
    const res = await this.index<{ data?: { rows?: unknown[] } }>(`/treasury/ledger?limit=${limit}`);
    return res.data?.rows ?? [];
  }

  /** PRIMES staking (D-168): the treasury's `distribute()` pot, the stream, ST-1/ST-2. */
  async stake(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/stake");
    return data;
  }

  /** One wallet's stake positions with live claimables. `found: false` = never staked. */
  async stakePositions(address: string): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>(`/stake/${address}`);
    return data;
  }

  /** Every message observed on the stake master, newest first (read-index). */
  async stakeLedger(limit = 50): Promise<unknown[]> {
    const res = await this.index<{ data?: { rows?: unknown[] } }>(`/stake/ledger?limit=${limit}`);
    return res.data?.rows ?? [];
  }

  /** One wallet's LP custody positions (term + vote; D-168 deleted the miner).
   *  `found: false` = this wallet has no position child. */
  async lpPositions(address: string): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>(`/lp/positions/${address}`);
    return data;
  }

  /** The LP the genesis script locked, against what the wallet actually holds, and the
   *  pool's LP supply — the denominator that turns a raw LP count into a share of the
   *  venue. The LP jetton publishes no decimals, so the share is the readable figure. */
  async lpLocked(): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>("/lp/locked");
    return data;
  }

  /**
   * One owner's DeDust LP jetton wallet, its balance, and the pool's LP supply.
   *
   * The LP jetton MASTER is the venue pool itself — a DeDust v2 pool is the jetton master
   * of its own LP token — so this address is a pure derivation off `getVenue().dedustPool`
   * and is correct before the wallet is deployed. `walletDeployed: false` with a
   * `balanceUnavailable` reason means this owner has never held LP; it is never a zero.
   */
  async lpWallet(address: string): Promise<Record<string, unknown>> {
    const { data } = await this.proxy<Record<string, unknown>>(`/lp/wallet/${address}`);
    return data;
  }

  /** The three collections, with issued counts and marketplace figures where they exist. */
  async collections(): Promise<Record<string, unknown>> {
    const res = await this.get<{ data: Record<string, unknown> }>(this.proxyUrl, "/collections");
    return res.data;
  }

  /** The era leader and their recruit count (§7). */
  async eraLeader(): Promise<{ leader: string | null; recruits: bigint }> {
    const { data } = await this.proxy<{ leader: string | null; recruits: string }>("/ledger/era-leader");
    return { leader: data.leader, recruits: BigInt(data.recruits) };
  }

  // =========================================================================
  // The read-index's own tables — CANDIDATES, never a figure to spend against
  // =========================================================================

  /** How far behind the chain the index is. Read it before trusting any row below. */
  async indexStatus(): Promise<Record<string, unknown>> {
    return await this.index<Record<string, unknown>>("/index/status");
  }

  /**
   * One leaderboard. Rows are indexed history, so they lag the chain by the tip above.
   * `around` (an address) serves D-124's band instead of the top-N: the rows centred on that
   * wallet, the leader pinned first, each row carrying its true `rank` (G74).
   */
  async board(kind: BoardKind, limit = 25, around?: string): Promise<unknown[]> {
    const q = around ? `&around=${encodeURIComponent(around)}` : "";
    const res = await this.index<{ data?: { rows?: unknown[]; standings?: unknown[] } }>(
      `/boards/${kind}?limit=${limit}${q}`
    );
    // `/boards/era` answers `standings` (beside its `leader`), every other board `rows`.
    return res.data?.rows ?? res.data?.standings ?? [];
  }

  /** One activity feed. */
  async feed(kind: FeedKind, limit = 25): Promise<unknown[]> {
    const res = await this.index<{ data?: { rows?: unknown[] } }>(`/feed/${kind}?limit=${limit}`);
    return res.data?.rows ?? [];
  }

  /** One lot's bid history and its live reading. */
  async lotHistory(n: bigint): Promise<unknown> {
    const res = await this.index<{ data?: { lot?: unknown } }>(`/lots/${n}`);
    return res.data?.lot ?? null;
  }

  /** The lowest standing price among every open lot the sweeper holds a reading for. */
  async cheapestLot(): Promise<Record<string, unknown>> {
    const res = await this.index<{ data?: Record<string, unknown> }>("/market/cheapest");
    return res.data ?? {};
  }

  /** Per-prime divisor-line tribute credited and not yet claimed (`unclaimedTributeNanoton`),
   *  largest first. Replayed from the event log; `item.get_owed(p)` is authoritative. */
  async unclaimedOffers(limit = 25): Promise<unknown[]> {
    const res = await this.index<{ data?: { rows?: unknown[] } }>(`/offers/unclaimed?limit=${limit}`);
    return res.data?.rows ?? [];
  }

  /** Numbers this wallet WON on the ascending lane. The claim never expires (§4.4). */
  async claimsOf(address: string, limit = 100): Promise<unknown[]> {
    const res = await this.index<{ data?: { rows?: unknown[] } }>(`/wallets/${address}/claims?limit=${limit}`);
    return res.data?.rows ?? [];
  }

  /** One wallet's ledger tape: every move it signed — mints, gifts sent, lots won, bids,
   *  claims, LP custody, stakes, cranks, votes, swaps — newest first. */
  async historyOf(address: string, limit = 100): Promise<unknown[]> {
    const res = await this.index<{ data?: { rows?: unknown[] } }>(`/wallets/${address}/history?limit=${limit}`);
    return res.data?.rows ?? [];
  }

  /** How contested this wallet's open lots are — who else is bidding, and how hard. */
  async contestOf(address: string): Promise<Record<string, unknown>> {
    const res = await this.index<{ data?: Record<string, unknown> }>(`/wallets/${address}/contest`);
    return res.data ?? {};
  }
}
