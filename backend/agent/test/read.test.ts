/**
 * The read layer, endpoint by endpoint.
 *
 * Two classes of bug live here and neither one throws:
 *
 *   1. **The wrong key.** `/wallets/:address/numbers` serves `data.numbers`; the boards
 *      serve `data.rows`. Reading `rows` off the first returned an empty portfolio for
 *      every wallet in the world, forever, without ever failing — which is how it shipped
 *      in 0.2.0. Every method below is asserted against the envelope its route ACTUALLY
 *      sends, and the shapes here were read off the route handlers, not guessed.
 *   2. **`Number()` on a nanoton figure.** A GRAM balance past 2^53 silently loses
 *      precision. Every decoded numeric is a `bigint` and the table asserts the value, not
 *      just the shape.
 *
 * The third property is the URL: three services answer on three base URLs, and a read sent
 * to the wrong one is a 404 in production and a passing test everywhere else. Each case
 * declares which base its request must land on.
 */
import { describe, expect, it, vi } from "vitest";
import { PrimesRead } from "../src/index.ts";

const PROXY = "https://proxy.test";
const INDEX = "https://index.test";
const EVENTS = "https://events.test";
const ADDR = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as Response;

/** read-proxy's single-get-method envelope. */
const enveloped = (data: unknown) => ok({ data, provenance: { getMethod: "getX", source: "live" } });
/** The SAME envelope on a route that assembles several get-methods: provenance is an ARRAY. */
const envelopedMulti = (data: unknown) => ok({ data, provenance: [{ getMethod: "a" }, { getMethod: "b" }] });
/** read-index's envelope: the index's own tip and degradation, wrapped around `data`. */
const indexed = (data: unknown) => ok({ index: { degraded: false, reasons: [] }, liveOnly: [], data });

function reader(response: Response | (() => Response)) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
    typeof response === "function" ? response() : response,
  );
  const read = new PrimesRead({
    fetchImpl,
    rps: 1000,
    readProxyUrl: PROXY,
    readIndexUrl: INDEX,
    eventsUrl: EVENTS,
  });
  return { read, fetchImpl, urlOf: () => String(fetchImpl.mock.calls[0]?.[0] ?? "") };
}

// ===========================================================================
// One case per endpoint: the body its route sends, and the value it decodes to
// ===========================================================================

interface Case {
  /** The method, as a reader would write it. */
  name: string;
  /** The service response, shaped as the route actually sends it. */
  body: Response;
  /** The URL the request must land on, in full. */
  url: string;
  call: (r: PrimesRead) => Promise<unknown>;
  /** The decoded result. Omitted where the method is a documented passthrough. */
  want?: unknown;
}

const CASES: Case[] = [
  // ---------------------------------------------------- the ledger and the ratchet
  {
    name: "head()",
    body: enveloped({ head: "42" }),
    url: `${PROXY}/ledger/head`,
    call: (r) => r.head(),
    want: 42n,
  },
  {
    name: "floor() — a RATIO, never pre-divided",
    body: enveloped({ floorNumNanoton: "7", floorDenPrimes: "3" }),
    url: `${PROXY}/ledger/floor`,
    call: (r) => r.floor(),
    want: { numNanoton: 7n, denPrimes: 3n },
  },
  {
    name: "counters() — T, S, div_acc, π(n) and S_MAX in one trip",
    body: enveloped({
      floorNumNanoton: "9007199254740993", // past 2^53: a Number() here would lose the 3
      floorDenPrimes: "500",
      divAccNanoton: "7",
      primeCount: "3",
      maxSupplyPrimes: "1200000000000000000",
    }),
    url: `${PROXY}/ledger/counters`,
    call: (r) => r.counters(),
    want: {
      tNanoton: 9007199254740993n,
      sPrimes: 500n,
      divAccNanoton: 7n,
      primeCount: 3n,
      maxSupplyPrimes: 1_200_000_000_000_000_000n,
    },
  },
  {
    name: "pending()",
    body: enveloped({ pendingNanoton: "50000000000" }),
    url: `${PROXY}/ratchet/pending`,
    call: (r) => r.pending(),
    want: 50_000_000_000n,
  },
  {
    name: "opsSweep() — what sweep_ops would pay the pool now",
    body: enveloped({ sweepableNanoton: "7", opsReserveNanoton: "3" }),
    url: `${PROXY}/ledger/ops-sweep`,
    call: (r) => r.opsSweep(),
    want: { sweepableNanoton: 7n, opsReserveNanoton: 3n },
  },
  {
    name: "harvestGates() — the three gates staking() does not carry",
    body: enveloped({ harvestIntervalSec: 2592000, harvestDustTston: "15950681", exitLeg: 0 }),
    url: `${PROXY}/ratchet/harvest-gates`,
    call: (r) => r.harvestGates(),
    want: { harvestIntervalSec: 2592000, harvestDustTston: 15_950_681n, exitLeg: 0 },
  },
  {
    name: "swapped()",
    body: enveloped({ swappedNanoton: "12" }),
    url: `${PROXY}/ratchet/swapped`,
    call: (r) => r.swapped(),
    want: 12n,
  },
  {
    name: "flushStatus() — `bounced` is the field that tells a dead venue from an idle one",
    body: enveloped({
      lastAttemptTime: "1700000000",
      outcome: "bounced",
      amountNanoton: "50000000000",
      cooldownRemainingSeconds: "3600",
    }),
    url: `${PROXY}/ratchet/flush-status`,
    call: (r) => r.flushStatus(),
    want: {
      lastAttemptTime: 1_700_000_000n,
      outcome: "bounced",
      amountNanoton: 50_000_000_000n,
      cooldownRemainingSeconds: 3600n,
    },
  },
  {
    // The MIRROR, not the ledger's pair. `floor()` is authoritative and moves on every mint;
    // this moves on every `PoolInject` and is what `computeMinOut` compares a swap against,
    // so an agent that previews a flush against `floor()` previews a guard the chain will not
    // apply. The case exists to pin that the SDK reads the ratchet's route, not the ledger's.
    name: "floorCache() — the (T, S) the floor guard prices against, off the RATCHET",
    body: enveloped({ tCacheNanoton: "98665000000", sCacheNanoPrimes: "250000000000000" }),
    url: `${PROXY}/ratchet/floor-cache`,
    call: (r) => r.floorCache(),
    want: { tCacheNanoton: 98_665_000_000n, sCachePrimes: 250_000_000_000_000n },
  },
  {
    // §4.3.2's staked reserve (D-151). All eight terms in one read, because they are drawn
    // as one split: `pending + stakedCost + exiting` is the ratchet's whole obligation and
    // `reserveTarget` is derived from that sum on chain. `realizedLoss` sits BESIDE
    // `stakedCost` and is never netted into it — a non-zero value means `p_f` overstates the
    // backing by exactly `realizedLoss / S`.
    name: "staking() — the staked reserve, at cost, with the loss published beside it",
    body: enveloped({
      stakedCostNanoton: "800000000000",
      tstonHeldNano: "776000000000",
      exitingNanoton: "0",
      lastRateNum: "1030000000",
      lastRateDen: "1000000000",
      reserveTargetNanoton: "200000000000",
      lastHarvestTime: "1769000000",
      realizedLossNanoton: "0",
    }),
    url: `${PROXY}/ratchet/staking`,
    call: (r) => r.staking(),
    want: {
      stakedCostNanoton: 800_000_000_000n,
      tstonHeldNano: 776_000_000_000n,
      exitingNanoton: 0n,
      lastRateNum: 1_030_000_000n,
      lastRateDen: 1_000_000_000n,
      reserveTargetNanoton: 200_000_000_000n,
      lastHarvestTime: 1_769_000_000n,
      realizedLossNanoton: 0n,
    },
  },
  {
    // §5's identity as ONE ordered snapshot. `tCache` equals the six terms (the ratchet-local
    // claim), and `T − tCache` is GRAM a `PoolInject` is still carrying: 0.65 here.
    name: "ratchetIdentity() — every identity term from one snapshot, the mirror beside T",
    body: enveloped({
      ledgerAddress: "EQledger",
      ratchetAddress: "EQratchet",
      tNanoton: "300650000000",
      seedTNanoton: "200000000000",
      tCacheNanoton: "300000000000",
      sCacheNanoPrimes: "250000000000000",
      pendingNanoton: "5000000000",
      swappedNanoton: "77000000000",
      staking: {
        stakedCostNanoton: "18000000000",
        tstonHeldNano: "17000000000",
        exitingNanoton: "0",
        lastRateNum: "1030000000",
        lastRateDen: "1000000000",
        reserveTargetNanoton: "4600000000",
        lastHarvestTime: "0",
        realizedLossNanoton: "0",
      },
    }),
    url: `${PROXY}/ratchet/identity`,
    call: (r) => r.ratchetIdentity(),
    want: {
      tNanoton: 300_650_000_000n,
      seedTNanoton: 200_000_000_000n,
      tCacheNanoton: 300_000_000_000n,
      sCachePrimes: 250_000_000_000_000n,
      pendingNanoton: 5_000_000_000n,
      swappedNanoton: 77_000_000_000n,
      staking: {
        stakedCostNanoton: 18_000_000_000n,
        tstonHeldNano: 17_000_000_000n,
        exitingNanoton: 0n,
        lastRateNum: 1_030_000_000n,
        lastRateDen: 1_000_000_000n,
        reserveTargetNanoton: 4_600_000_000n,
        lastHarvestTime: 0n,
        realizedLossNanoton: 0n,
      },
    },
  },
  {
    name: "k(n, t) — both arguments ride in the query string",
    body: enveloped({ k: "123456" }),
    url: `${PROXY}/ledger/k?n=1000&t=1700000000`,
    call: (r) => r.k(1000n, 1_700_000_000n),
    want: 123456n,
  },
  {
    name: "kMax(n)",
    body: enveloped({ kMax: "900000" }),
    url: `${PROXY}/ledger/kmax?n=1000`,
    call: (r) => r.kMax(1000n),
    want: 900000n,
  },
  {
    name: "lastMintTime()",
    body: enveloped({ lastMintTime: "1700000000" }),
    url: `${PROXY}/ledger/last-mint-time`,
    call: (r) => r.lastMintTime(),
    want: 1_700_000_000n,
  },
  {
    name: "seedT() — D-26's third term, without which solvency reads as a permanent gap",
    body: enveloped({ seedTNanoton: "200000000000" }),
    url: `${PROXY}/ledger/seed-t`,
    call: (r) => r.seedT(),
    want: 200_000_000_000n,
  },
  {
    name: "inviteTerms() — D-215's live count and value, then the three fixed bounds",
    body: enveloped({ count: 2, valueNanoton: "150000000", sendFeeNanoton: "1000000", lineCapNanoton: "310000000", countCeiling: 100 }),
    url: `${PROXY}/ledger/invite-terms`,
    call: (r) => r.inviteTerms(),
    want: { count: 2, valueNanoton: 150_000_000n, sendFeeNanoton: 1_000_000n, lineCapNanoton: 310_000_000n, countCeiling: 100 },
  },
  {
    name: "eraLeader()",
    body: enveloped({ leader: ADDR, recruits: "17" }),
    url: `${PROXY}/ledger/era-leader`,
    call: (r) => r.eraLeader(),
    want: { leader: ADDR, recruits: 17n },
  },
  {
    name: "bootstrap() — bare, and each field carries its OWN envelope",
    body: ok({ head: { data: { head: "12" } }, floor: null, unavailable: [{ field: "floor", reason: "x" }] }),
    url: `${PROXY}/bootstrap`,
    call: (r) => r.bootstrap(),
    want: { head: { data: { head: "12" } }, floor: null, unavailable: [{ field: "floor", reason: "x" }] },
  },

  // ---------------------------------------------------------------- one wallet
  {
    name: "balance()",
    body: enveloped({ balanceNanoton: "1500000000" }),
    url: `${PROXY}/wallet/${ADDR}/balance`,
    call: (r) => r.balance(ADDR),
    want: 1_500_000_000n,
  },
  {
    name: "seqno()",
    body: enveloped({ seqno: 7 }),
    url: `${PROXY}/wallet/${ADDR}/seqno`,
    call: (r) => r.seqno(ADDR),
    want: 7,
  },
  {
    name: "primesBalance() — provenance is an ARRAY on this route",
    body: envelopedMulti({ owner: ADDR, walletAddress: ADDR, walletDeployed: true, balancePrimes: "4900" }),
    url: `${PROXY}/primes/wallet/${ADDR}`,
    call: (r) => r.primesBalance(ADDR),
    want: { owner: ADDR, walletAddress: ADDR, walletDeployed: true, balancePrimes: 4900n },
  },
  {
    name: "ranks()",
    body: enveloped({ address: ADDR, recruitRank: "3", primeRank: "1" }),
    url: `${PROXY}/ranks/${ADDR}`,
    call: (r) => r.ranks(ADDR),
    want: { address: ADDR, recruitRank: 3n, primeRank: 1n },
  },
  {
    name: "earn() — passthrough; `head` is optional and omitted when absent",
    body: enveloped({ address: ADDR, uplift: { clamped: true } }),
    url: `${PROXY}/earn/${ADDR}`,
    call: (r) => r.earn(ADDR),
    want: { address: ADDR, uplift: { clamped: true } },
  },
  {
    name: "earn(address, head) — and appended when it is given",
    body: enveloped({ address: ADDR }),
    url: `${PROXY}/earn/${ADDR}?head=99`,
    call: (r) => r.earn(ADDR, 99n),
  },

  // ------------------------------------------------- numbers, lots and prices
  {
    name: "number() — TWO get-methods, enveloped SEPARATELY at the top level",
    body: ok({ number: { data: { owner: ADDR, isPrime: true } }, owed: { data: { owedNanoton: "12" } } }),
    url: `${PROXY}/number/7`,
    call: (r) => r.number(7n),
    want: { owner: ADDR, isPrime: true, owedNanoton: 12n },
  },
  {
    name: "isKnownPrime() — the ledger's bitmap, not a local primality test",
    body: enveloped({ isPrime: false }),
    url: `${PROXY}/number/9/prime`,
    call: (r) => r.isKnownPrime(9n),
    want: false,
  },
  {
    name: "itemAddress() — served BARE, because it is immutable",
    body: ok({ address: ADDR }),
    url: `${PROXY}/item/7/address`,
    call: (r) => r.itemAddress(7n),
    want: ADDR,
  },
  {
    name: "name() — D-212: the owner, the standing name, and the next fee in GRAM",
    body: ok({
      namer: { data: { namer: ADDR } },
      annotation: { data: { count: 1, text: "the first odd prime" } },
      fees: { data: { nameFee: "2000000000", renameFee: "200000000000", named: 1, renamed: 0, toFloor: "2000000000", nextFee: "200000000000" } },
    }),
    url: `${PROXY}/number/3/name`,
    call: (r) => r.name(3n),
    want: {
      namer: ADDR,
      count: 1,
      text: "the first odd prime",
      nameFee: 2_000_000_000n,
      renameFee: 200_000_000_000n,
      nextFee: 200_000_000_000n,
    },
  },
  {
    name: "name() — a primorial also carries its era-trophy engraving",
    body: ok({
      namer: { data: { namer: null } },
      annotation: { data: { count: 0, text: null } },
      fees: { data: { nameFee: "2000000000", renameFee: "200000000000", named: 0, renamed: 0, toFloor: "0", nextFee: null } },
      trophy: { data: { holder: ADDR, annotation: { count: 1, text: "thirty" }, renameFee: "200000000000" } },
    }),
    url: `${PROXY}/number/30/name`,
    call: (r) => r.name(30n),
    want: {
      namer: null,
      count: 0,
      text: null,
      nameFee: 2_000_000_000n,
      renameFee: 200_000_000_000n,
      nextFee: null,
      trophy: { holder: ADDR, count: 1, text: "thirty", renameFee: 200_000_000_000n },
    },
  },
  {
    name: "numberTrophy()",
    body: enveloped({ holder: ADDR, transferable: false }),
    url: `${PROXY}/number/30/trophy`,
    call: (r) => r.numberTrophy(30n),
    want: { holder: ADDR, transferable: false },
  },
  {
    name: "runway() — seconds, or -1 for no finite runway, or 0 for already out",
    body: enveloped({ runwaySeconds: "-1" }),
    url: `${PROXY}/number/7/runway`,
    call: (r) => r.runway(7n),
    want: -1n,
  },
  {
    name: "tributeTotal() — cumulative, never decremented",
    body: enveloped({ tributeTotalNanoton: "12" }),
    url: `${PROXY}/number/7/tribute`,
    call: (r) => r.tributeTotal(7n),
    want: 12n,
  },
  {
    name: "numbers() — the batch that CONFIRMS a portfolio against each item",
    body: ok({
      numbers: [
        { n: "7", minted: true, owner: ADDR, isPrime: true, owedNanoton: "5", itemAddress: ADDR },
        { n: "8", minted: false, owner: null, isPrime: null, owedNanoton: null, itemAddress: ADDR },
      ],
      requested: 2,
      returned: 2,
      truncated: false,
      maxPerRequest: 24,
    }),
    url: `${PROXY}/numbers?ns=7,8`,
    call: (r) => r.numbers([7n, 8n]),
    want: {
      numbers: [
        { n: 7n, minted: true, owner: ADDR, isPrime: true, owedNanoton: 5n, itemAddress: ADDR },
        { n: 8n, minted: false, owner: null, isPrime: null, owedNanoton: null, itemAddress: ADDR },
      ],
      truncated: false,
      maxPerRequest: 24,
    },
  },
  {
    name: "lot() — the HTTP mirror of getLot(n)",
    body: enveloped({
      found: true,
      closed: false,
      mode: 2,
      p0Nanoton: "10",
      standingPriceNanoton: "9",
      minNextBidNanoton: "11",
      highBidNanoton: "0",
      highBidder: ADDR,
      openedAt: "100",
      closesAt: "200",
    }),
    url: `${PROXY}/trophy/lot/9973`,
    call: (r) => r.lot(9973n),
    want: {
      found: true,
      closed: false,
      mode: 2,
      p0Nanoton: 10n,
      standingPriceNanoton: 9n,
      minNextBidNanoton: 11n,
      highBidNanoton: 0n,
      highBidder: ADDR,
      openedAt: 100n,
      closesAt: 200n,
    },
  },
  {
    name: "lotPrice() — `lane: -1` is the honest 'not openable'",
    body: enveloped({
      p0Nanoton: "1000",
      resGasNanoton: "40",
      minIncrementNanoton: "50",
      score: "3",
      flags: "5",
      lane: -1,
      npvNanoton: null,
      primeFloorNanoton: null,
    }),
    url: `${PROXY}/trophy/price/5040`,
    call: (r) => r.lotPrice(5040n),
    want: {
      p0Nanoton: 1000n,
      resGasNanoton: 40n,
      minIncrementNanoton: 50n,
      score: 3n,
      flags: 5n,
      lane: -1,
      npvNanoton: null,
      primeFloorNanoton: null,
    },
  },
  {
    name: "lotFloor() — null when there is no lot, never a zero floor",
    body: enveloped({ found: false, floorNanoton: "0" }),
    url: `${PROXY}/trophy/floor/5040`,
    call: (r) => r.lotFloor(5040n),
    want: null,
  },
  {
    name: "score()",
    body: enveloped({ score: "12", flags: "3", breakdown: [] }),
    url: `${PROXY}/trophy/score/5040`,
    call: (r) => r.score(5040n),
    want: { score: "12", flags: "3", breakdown: [] },
  },
  {
    name: "trophy()",
    body: enveloped({ openLots: "2" }),
    url: `${PROXY}/trophy`,
    call: (r) => r.trophy(),
    want: { openLots: "2" },
  },
  {
    name: "trophyParams()",
    body: enveloped({ scoreHalving: "4" }),
    url: `${PROXY}/trophy/params`,
    call: (r) => r.trophyParams(),
    want: { scoreHalving: "4" },
  },
  {
    name: "isOffHead()",
    body: enveloped({ isOffHead: true }),
    url: `${PROXY}/number/5040/off-head`,
    call: (r) => r.isOffHead(5040n),
    want: true,
  },
  {
    name: "feeSplit()",
    body: enveloped({ resGasNanoton: "40000000", settleGasNanoton: "10000000" }),
    url: `${PROXY}/lots/fee-split`,
    call: (r) => r.feeSplit(),
    want: { resGasNanoton: 40_000_000n, settleGasNanoton: 10_000_000n },
  },
  {
    name: "yieldOf() — DERIVED, so the derivation rides with it (§9.1)",
    body: envelopedMulti({ n: "7", derived: true, rate: null, unavailableReason: "one reading only" }),
    url: `${PROXY}/assets/7/yield`,
    call: (r) => r.yieldOf(7n),
    want: { n: "7", derived: true, rate: null, unavailableReason: "one reading only" },
  },

  // -------------------------------------------------------- the bounty vault
  {
    name: "eraSchedule() — `scheduled: false` is NOT the same as already paid",
    body: enveloped({ scheduled: false, bountyTonNanoton: "0", maxPrimesNanoton: "0", paid: false }),
    url: `${PROXY}/vault/era/30`,
    call: (r) => r.eraSchedule(30n),
    want: { scheduled: false, bountyTonNanoton: 0n, maxPrimesNanoton: 0n, paid: false },
  },
  {
    name: "rebate()",
    body: enveloped({ scheduled: true, bountyTonNanoton: "213000", maxPrimesNanoton: "0", paid: true }),
    url: `${PROXY}/vault/rebate/1/7`,
    call: (r) => r.rebate(1, 7n),
    want: { scheduled: true, bountyTonNanoton: 213000n, maxPrimesNanoton: 0n, paid: true },
  },
  {
    name: "vaultProgram() — D-170's prize is SECU's remaining, decoded to bigint",
    body: enveloped({ found: true, addrHash: "abc", remainingNanoprimes: "1000000000000000" }),
    url: `${PROXY}/vault/program/1397048149`,
    call: (r) => r.vaultProgram(1397048149),
    want: { found: true, addrHash: "abc", remainingNanoprimes: 1000000000000000n },
  },
  {
    name: "vault()",
    body: enveloped({ ledger: ADDR, walletSet: true }),
    url: `${PROXY}/vault`,
    call: (r) => r.vault(),
    want: { ledger: ADDR, walletSet: true },
  },

  // --------------------------------------------- the auditor's passthroughs
  {
    name: "supply()",
    body: envelopedMulti({ sPrimes: "1000", unavailable: [] }),
    url: `${PROXY}/supply`,
    call: (r) => r.supply(),
    want: { sPrimes: "1000", unavailable: [] },
  },
  {
    name: "solvency()",
    body: envelopedMulti({ contracts: [] }),
    url: `${PROXY}/solvency`,
    call: (r) => r.solvency(),
    want: { contracts: [] },
  },
  {
    name: "venue()",
    body: enveloped({ dedustPool: ADDR }),
    url: `${PROXY}/venue`,
    call: (r) => r.venue(),
    want: { dedustPool: ADDR },
  },
  {
    // The price as a RATIONAL, not a rounded decimal: an agent comparing the market against
    // `p_f` divides `spotNum/spotDen` by `floorNum/floorDen`, and both pairs arrive here
    // exactly as their get-methods returned them.
    name: "market() — the pool's reserves, in the same num/den shape as the floor",
    body: enveloped({ status: "live", spotNumNanoton: "4200000000", spotDenPrimes: "42000000000000" }),
    url: `${PROXY}/market`,
    call: (r) => r.market(),
    want: { status: "live", spotNumNanoton: "4200000000", spotDenPrimes: "42000000000000" },
  },
  {
    name: "vesting() — the treasury's lock (the only one since D-166)",
    body: envelopedMulti({ tranches: 4 }),
    url: `${PROXY}/vesting`,
    call: (r) => r.vesting(),
    want: { tranches: 4 },
  },
  {
    name: "treasury()",
    body: envelopedMulti({ solvent: true }),
    url: `${PROXY}/treasury`,
    call: (r) => r.treasury(),
    want: { solvent: true },
  },
  {
    name: "treasuryProposals() — bare",
    body: envelopedMulti({ proposals: [] }),
    url: `${PROXY}/treasury/proposals`,
    call: (r) => r.treasuryProposals(),
    want: { proposals: [] },
  },
  {
    name: "treasuryProposals(voter) — adds hasVoted per row",
    body: envelopedMulti({ proposals: [] }),
    url: `${PROXY}/treasury/proposals?voter=${ADDR}`,
    call: (r) => r.treasuryProposals(ADDR),
  },
  {
    name: "stake()",
    body: envelopedMulti({ totalWeight: "0" }),
    url: `${PROXY}/stake`,
    call: (r) => r.stake(),
    want: { totalWeight: "0" },
  },
  {
    name: "stakePositions() — `found: false` is a wallet that never staked",
    body: envelopedMulti({ found: false }),
    url: `${PROXY}/stake/${ADDR}`,
    call: (r) => r.stakePositions(ADDR),
    want: { found: false },
  },
  {
    name: "lpPositions() — `found: false` is a wallet with no position child",
    body: envelopedMulti({ found: false }),
    url: `${PROXY}/lp/positions/${ADDR}`,
    call: (r) => r.lpPositions(ADDR),
    want: { found: false },
  },
  {
    name: "lpLocked()",
    body: envelopedMulti({ lockedRaw: "0", walletSet: false }),
    url: `${PROXY}/lp/locked`,
    call: (r) => r.lpLocked(),
    want: { lockedRaw: "0", walletSet: false },
  },
  {
    // The LP jetton MASTER is the venue pool, so the address is a pure derivation and is
    // right before the wallet exists. An owner who has never held LP gets a NAMED absence.
    name: "lpWallet() — a named absence, not a zero, for an owner who has never held LP",
    body: envelopedMulti({ walletDeployed: false, balanceRaw: null, lpTotalSupplyRaw: "600000000000" }),
    url: `${PROXY}/lp/wallet/${ADDR}`,
    call: (r) => r.lpWallet(ADDR),
    want: { walletDeployed: false, balanceRaw: null, lpTotalSupplyRaw: "600000000000" },
  },
  {
    name: "collections() — has `data` but NO top-level provenance",
    body: ok({ data: { collections: [] } }),
    url: `${PROXY}/collections`,
    call: (r) => r.collections(),
    want: { collections: [] },
  },
  {
    name: "contracts()",
    body: enveloped({ ledger: ADDR, market: ADDR }),
    url: `${PROXY}/contracts`,
    call: (r) => r.contracts(),
    want: { ledger: ADDR, market: ADDR },
  },

  // ------------------------------------------------------ the read-INDEX
  {
    name: "indexStatus() — read it before trusting any row below",
    body: ok({ index: { degraded: true, reasons: ["behind"] } }),
    url: `${INDEX}/index/status`,
    call: (r) => r.indexStatus(),
    want: { index: { degraded: true, reasons: ["behind"] } },
  },
  {
    // The rows are NOT labelled with an asset and cannot be: a jetton inflow is PRIMES or
    // LP by which of the treasury's two jetton wallets forwarded it (`treasury()` names
    // them), and an execute names only a seq whose asset is on the proposal
    // (`treasuryProposals()`). The SDK hands both keys through and resolves neither.
    name: "treasuryLedger() — `data.rows`, with the joins left to the caller",
    body: indexed({ rows: [{ opName: { value: "treasury_ton_inflow" } }] }),
    url: `${INDEX}/treasury/ledger?limit=50`,
    call: (r) => r.treasuryLedger(),
    want: [{ opName: { value: "treasury_ton_inflow" } }],
  },
  {
    name: "stakeLedger() — `data.rows` off the stake master",
    body: indexed({ rows: [{ opName: { value: "stake_settle" } }] }),
    url: `${INDEX}/stake/ledger?limit=50`,
    call: (r) => r.stakeLedger(),
    want: [{ opName: { value: "stake_settle" } }],
  },
  {
    name: "openLots() — `data.rows`",
    body: indexed({ rows: [{ number: "5040" }] }),
    url: `${INDEX}/lots/open?limit=50`,
    call: (r) => r.openLots(),
    want: [{ number: "5040" }],
  },
  {
    name: "lotHistory() — `data.lot`, singular",
    body: indexed({ lot: { number: "5040", bids: [] } }),
    url: `${INDEX}/lots/5040`,
    call: (r) => r.lotHistory(5040n),
    want: { number: "5040", bids: [] },
  },
  {
    name: "cheapestLot()",
    body: indexed({ number: "5040", standingPriceNanoton: "1" }),
    url: `${INDEX}/market/cheapest`,
    call: (r) => r.cheapestLot(),
    want: { number: "5040", standingPriceNanoton: "1" },
  },
  {
    name: "unclaimedOffers()",
    body: indexed({ rows: [{ number: "7" }] }),
    url: `${INDEX}/offers/unclaimed?limit=25`,
    call: (r) => r.unclaimedOffers(),
    want: [{ number: "7" }],
  },
  {
    name: "board('prime-finders')",
    body: indexed({ rows: [{ owner: ADDR }] }),
    url: `${INDEX}/boards/prime-finders?limit=25`,
    call: (r) => r.board("prime-finders"),
    want: [{ owner: ADDR }],
  },
  {
    // G74: the band around one wallet, and `/boards/era` answers `standings`, not `rows`.
    name: "board('era', 10, around) — the band, off `standings`",
    body: indexed({ leader: {}, standings: [{ rank: { value: 47 } }] }),
    url: `${INDEX}/boards/era?limit=10&around=${encodeURIComponent(ADDR)}`,
    call: (r) => r.board("era", 10, ADDR),
    want: [{ rank: { value: 47 } }],
  },
  {
    name: "feed('mints')",
    body: indexed({ rows: [{ n: "12" }] }),
    url: `${INDEX}/feed/mints?limit=5`,
    call: (r) => r.feed("mints", 5),
    want: [{ n: "12" }],
  },
  {
    name: "claimsOf()",
    body: indexed({ rows: [{ number: { value: "7" } }] }),
    url: `${INDEX}/wallets/${ADDR}/claims?limit=100`,
    call: (r) => r.claimsOf(ADDR),
    want: [{ number: { value: "7" } }],
  },
  {
    name: "historyOf()",
    body: indexed({ rows: [] }),
    url: `${INDEX}/wallets/${ADDR}/history?limit=100`,
    call: (r) => r.historyOf(ADDR),
    want: [],
  },
  {
    name: "contestOf()",
    body: indexed({ contested: 2 }),
    url: `${INDEX}/wallets/${ADDR}/contest`,
    call: (r) => r.contestOf(ADDR),
    want: { contested: 2 },
  },

  // ------------------------------------------------------- the EVENT poller
  {
    name: "portfolioOf() — CANDIDATES; `numbers()` is what confirms them",
    body: ok({ address: ADDR, numbers: [], attribution: "mint-time" }),
    url: `${EVENTS}/portfolio/${ADDR}`,
    call: (r) => r.portfolioOf(ADDR),
    want: { address: ADDR, numbers: [], attribution: "mint-time" },
  },
];

describe("every read hits the right URL and decodes the envelope its route sends", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { read, urlOf } = reader(c.body);
      const got = await c.call(read);
      expect(urlOf()).toBe(c.url);
      if ("want" in c) expect(got).toEqual(c.want);
    });
  }

  it("covers every public read method on the class", () => {
    // The table above is the endpoint list, and a method added without a case is a method
    // nobody has checked the envelope of. `proxy`/`index`/`events` are the
    // three generic escape hatches and are exercised by the methods built on them.
    const SKIP = new Set([
      "constructor",
      // The three generic escape hatches, one per base URL. Every typed method above is
      // built on them, so the table exercises them throughout.
      "proxy",
      "index",
      "events",
      // Private: the paced GET and the shared bounty decoder.
      "get",
      "bounty",
      // Covered by its own block below, because the property worth asserting about it is
      // the KEY it reads, not the URL — that is the bug that shipped in 0.2.0.
      "numbersOf",
    ]);
    const methods = Object.getOwnPropertyNames(PrimesRead.prototype).filter((m) => !SKIP.has(m));
    const covered = new Set(CASES.map((c) => c.name.replace(/\(.*$/, "")));
    expect(methods.filter((m) => !covered.has(m))).toEqual([]);
  });
});

// ===========================================================================
// The properties the table cannot state case by case
// ===========================================================================

describe("the regression that shipped: the wrong key on a per-wallet route", () => {
  it("numbersOf reads `data.numbers`, which is what the route serves", async () => {
    const { read, urlOf } = reader(
      indexed({
        address: { value: ADDR },
        numbers: [
          { value: "7", provenance: {} },
          { value: "11", provenance: {} },
        ],
      }),
    );
    expect(await read.numbersOf(ADDR)).toEqual([7n, 11n]);
    expect(urlOf()).toBe(`${INDEX}/wallets/${ADDR}/numbers?limit=200`);
  });

  it("and NOT `data.rows`, which is the boards' key and is absent here", async () => {
    // The 0.2.0 shape: had this been the reading, every wallet held nothing.
    const { read } = reader(indexed({ address: { value: ADDR }, rows: [{ value: "7" }] }));
    expect(await read.numbersOf(ADDR)).toEqual([]);
  });
});

describe("no figure is read through Number()", () => {
  it("a balance past 2^53 survives the round trip exactly", async () => {
    const huge = "9007199254740993"; // 2^53 + 1
    const { read } = reader(enveloped({ balanceNanoton: huge }));
    expect(await read.balance(ADDR)).toBe(BigInt(huge));
    expect(Number(huge).toString()).not.toBe(huge); // the failure this rules out
  });

  it("every decoded amount is a bigint, never a string and never a number", async () => {
    const { read } = reader(enveloped({ pendingNanoton: "1" }));
    expect(typeof (await read.pending())).toBe("bigint");
  });
});

describe("the base URLs are configurable and trailing slashes do not double up", () => {
  it("strips one trailing slash from each base", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(enveloped({ head: "1" }));
    const read = new PrimesRead({ fetchImpl, rps: 1000, readProxyUrl: `${PROXY}/` });
    await read.head();
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${PROXY}/ledger/head`);
  });

  it("defaults to the published hosts when none are given", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(enveloped({ head: "1" }));
    await new PrimesRead({ fetchImpl, rps: 1000 }).head();
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://primes.live/api/ledger/head");
  });
});
