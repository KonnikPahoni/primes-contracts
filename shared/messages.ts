/**
 * On-chain message cell-builders for every contract a PLAYER sends to — ledger, market,
 * registrar, item, ratchet, bounty vault, treasury. ONE definition (`AGENTS_PLAN.md` A1,
 * D-131.3): the webapp's `chain/messages.ts` re-exports this file, `contracts/wrappers/*`
 * call it for their `send*` bodies, and a headless client imports it directly, so the
 * bytes a sandbox test proves are the bytes a player signs.
 * `contracts/tests/MessageCrossCheck.spec.ts` fails if a wrapper grows a second copy.
 *
 * On-chain message cell-builders for the ledger / market / NFT item contracts.
 *
 * Wire formats here are ground truth, taken directly from the deployed Tolk contracts
 * (contracts/contracts/primes_ledger.tolk, primes_market.tolk) and their TS test
 * wrappers (contracts/wrappers/PrimesLedger.ts) rather than from shared/schemas/*.tlb: the
 * contract is what actually serializes the bytes, so it wins any disagreement with a schema
 * file. Opcodes are imported from shared/opcodes.ts so
 * this module never hardcodes a hex literal that could drift from the single source of
 * truth there.
 *
 * ---------------------------------------------------------------------------
 * DECISIONS.md D-3 / D-16 / D-18 / D-20 / D-22 — THE MARKET.
 *
 * `primes_auction.tolk`, `primes_trophy_auction.tolk`, `primes_reservation_book.tolk`
 * and `primes_reservation_shard.tolk` are gone, replaced by `primes_market.tolk` +
 * `primes_market_shard.tolk`. The `RESERVATION_BOOK`, `AUCTION` and `TROPHY_AUCTION`
 * opcode blocks were deleted with them; `MARKET` (0xF2 for the lot lanes, 0xE0 retained
 * verbatim for the reservation lanes) is the only namespace left.
 *
 * **`n` IS `uint64` IN EVERY MARKET MESSAGE (D-18), and that is not cosmetic.** The
 * market's own structs declare `n: uint64`; writing 256 bits where the parser reads 64
 * does not merely waste space, it shifts every subsequent field and the parse dies on
 * cell underflow. The ledger, the collection and the item keep `uint256` — the head is
 * not capped, only the market is (`AUCTIONABLE_MAX` ≈ 4.29 × 10¹³) — so `buildMintMessage`
 * below is deliberately still 256 bits and must stay that way.
 *
 * **D-30/D-31/D-90 — THE ONE ROUTE AHEAD OF THE HEAD.** `reserve#e0000001` and
 * `cancel#e0000002` were deleted by D-30/D-32; `release#e0000004` and `settle#e0000003` are
 * deleted by D-90, and all four opcodes are left UNASSIGNED. A number ahead of the head is
 * bought by winning an ascending lot and by nothing else, and winning one MINTS IT in the
 * close transaction — so there is no builder here for a claim, for settling one later, or
 * for handing one back.
 *
 * **`AUCTION.take` and `AUCTION.finalize` have no successor.** D-20 deleted that lane
 * outright: a prime is bought on `MODE_DUTCH_BUYNOW`, where `bid` IS the purchase and it
 * settles in the same transaction. There is no clock to come back and finalize, and no
 * builder here for one.
 */
import { Address, beginCell, Cell, storeStateInit, type Builder, type StateInit } from "@ton/core";
import { minterCardAddress, minterCardInit } from "./minterCard";
import {
  DEDUST,
  LEDGER,
  MARKET,
  ITEM,
  RATCHET,
  REGISTRAR,
  TREASURY,
  TEP74,
  COLLECTION,
  STAKE,
  STAKE_ACTION_LOCK,
  STAKE_MIN_FORWARD_NANOTON,
  STAKE_POSITION_MIN_FORWARD_NANOTON,
  STAKE_EXPIRE_MIN_FORWARD_NANOTON,
  TREASURY_DISTRIBUTE_MIN_FORWARD_NANOTON,
  VOUCHER,
} from "./opcodes";
import { inviteListCell, INVITE_MAX_COUNT, isInvitable } from "./invites";

// ---------------------------------------------------------------------------
// Value constants (nanoton), exact per ground truth.
// ---------------------------------------------------------------------------
// GAUNTLET.md S9a: moved to chain/values.ts (no @ton/core dependency) — kept as a
// re-export so existing importers of these two from here don't need to change, but an
// eager (non-lazy) call site should import chain/values.ts directly.
export { MINT_VALUE_NANOTON, FEE_MARGIN_NANOTON, ITEM_DEPLOY_VALUE_NANOTON } from "./values";
import { MINT_VALUE_NANOTON, FEE_MARGIN_NANOTON, ITEM_DEPLOY_VALUE_NANOTON } from "./values";

// D-30: THERE IS NO RESERVATION FEE. `RES_FEE`, `RES_PRIORITY_BASE` and
// `RES_PREMIUM = D(n)·PREMIUM_UNIT` are all deleted, and so is the flat-fee entry point
// that charged them. `RES_GAS` survives — never waivable, never payable in PRIMES — but it
// is CARVED FROM THE WINNING BID rather than added to a fee, so no builder here needs to
// know its value: `p0` from `getLotPrice(n)` already contains it on the ascending lane, and
// `getLot(n).minPayment` already contains it on the Dutch one.
//
// `RELEASE_GAS_NANOTON` is DELETED with the release it funded (D-90.2).
export const CLAIM_GAS_NANOTON = 50000000n;

// `primes_market.tolk`'s BidLot handler compares `in.valueCoins` (post-forward-fee, same
// convention as the ledger's mint check above) directly against `minPaymentOn(...)`, AND
// stores that same `in.valueCoins` as the new `highBid` — so unlike mint/reserve there is
// no fixed contract-side price to pad; the caller's intended bid amount must survive the
// forward-fee deduction intact or the bid is silently recorded as less than the sender
// thinks they bid. Same small fixed margin convention as FEE_MARGIN_NANOTON, added on top
// of the caller's bid. `open_lot` books its value the same way.
export const BID_FEE_MARGIN_NANOTON = 10000000n; // 0.01 TON

/** Gas for the permissionless `close` of an ASCENDING lot. The contract funds both
 *  close-time landings from its own balance (the reservation hop and the premium hop are
 *  NOT netted out of the winning bid, or the escrow leg would be short of the 1 TON the
 *  §4.1 split is closed at), so the caller only covers this message's own execution. */
export const CLOSE_LOT_GAS_NANOTON = 50000000n; // 0.05 TON

/** Gas for `open_head_lot`. D-4/D-20: unpriced and unbid — it only starts the descending
 *  clock for a prime the head has already passed, so there is no opening bid to place and
 *  requiring one would put the opener in front of the clock they just started. It is the
 *  market's own floor (`OPEN_HEAD_VALUE`): the open's compute is paid from it and the rest
 *  rides on to the ledger, so the market's float pays nothing (§4.4, D-196). */
export const OPEN_HEAD_LOT_GAS_NANOTON = 100000000n; // 0.1 TON

// ---------------------------------------------------------------------------
// §3.2's factor dictionary — 8-bit uint keys in insertion order, values
// storeUint(prime, 256).storeUint(exponent, 8).storeUint(s, 128) — is NOT
// defined here. It is the proof a player submits to mint a composite for 1 TON,
// and `contracts/wrappers/PrimesLedger.ts` builds the same dictionary for every
// sandbox test. A private copy on either side would mean the tests prove the
// wrapper's bytes while the player spends through these, so it lives once in
// `shared/factors.ts` and both sides import it.
// `contracts/tests/FactorCrossCheck.spec.ts` fails if a copy reappears.
// ---------------------------------------------------------------------------
export { isqrt, encodeFactors, type FactorEntry } from "./factors";
import { encodeFactors, type FactorEntry } from "./factors";

/** Stores a beneficiary address in the addr slot: the actual address if set, or
 *  addr_none (a 2-bit 0) if not — the exact same pattern used by mint and
 *  reserve on the wire. */
function storeBeneficiary(b: Builder, beneficiary: Address | null): Builder {
  if (beneficiary) {
    b.storeAddress(beneficiary);
  } else {
    b.storeUint(0, 2);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Message builders. Each returns { body, value } — value is the exact nanoton
// amount the wallet must attach, per the ground-truth spec.
// ---------------------------------------------------------------------------

/**
 * §4.1's INVITE LINE (D-202): up to `INVITE_MAX_COUNT` recipients THE MINTER names. Each
 * funded slot gets one plain 0.1 TON NoBounce transfer from the ledger carrying a text
 * comment (`shared/invites.ts` `inviteCommentText`; operator-set words, ledger-written link,
 * D-211). There is no signature: D-202
 * deleted it with the generators, because nothing in the transfer is minter-written but
 * the destination.
 */
export interface MintInvites {
  /** The minter's DECLARED count, 0..3. Unspent slots fall to β (D-101/D-202). */
  count: number;
  /** Keyed BY SLOT, 1..3, never 0 — `InviteList.addresses` is a `map<uint3, address>`. Holes allowed. */
  addresses: { slot: number; address: string }[];
}

/** The same line as the sandbox tests and `contracts/scripts` hold it: a `Map` keyed by
 *  slot. Either shape builds the identical cell. */
export type InviteInput = MintInvites | { count: number; addresses: Map<number, Address> };

/** The `InviteList` ref, checked. Exported for tests; the mint builder is the only caller
 *  in the app. */
export function buildInviteListCell(invites: InviteInput): Cell {
  if (!Number.isInteger(invites.count) || invites.count < 1 || invites.count > INVITE_MAX_COUNT) {
    throw new Error(`invite count must be an integer 1..${INVITE_MAX_COUNT}, got ${invites.count}`);
  }
  for (const { slot, address } of inviteEntries(invites)) {
    // The ledger walks slots 1..count. A slot outside that is one the walk never reads,
    // so its address would silently get nothing.
    if (!Number.isInteger(slot) || slot < 1 || slot > invites.count) {
      throw new Error(`invite slot must be an integer 1..${invites.count}, got ${slot}`);
    }
    // Audit R2-L1: the ledger refuses the whole mint (236) for a slot off workchain 0.
    if (!isInvitable(typeof address === "string" ? Address.parse(address) : address)) {
      throw new Error(`invite slot ${slot} must be a workchain-0 address`);
    }
  }
  return encodeInviteListCell(invites);
}

function inviteEntries(invites: InviteInput): { slot: number; address: string | Address }[] {
  return invites.addresses instanceof Map
    ? [...invites.addresses].map(([slot, address]) => ({ slot, address }))
    : invites.addresses;
}

/**
 * The `InviteList` BYTES, unchecked. `contracts/tests/InviteTransfers.spec.ts` proves the
 * ledger refuses a count of 4 on the wire (`invite_count_over_max`, 221), which it cannot
 * do if the builder refuses first.
 */
export function encodeInviteListCell(invites: InviteInput): Cell {
  const addresses = new Map<number, Address>();
  for (const { slot, address } of inviteEntries(invites)) {
    addresses.set(slot, typeof address === "string" ? Address.parse(address) : address);
  }
  return inviteListCell(addresses);
}

/**
 * THE mint. One message, one signature (primes_ledger.tolk D8). If `n` is no longer
 * the head when this lands, the ledger refunds the attached value in full minus gas.
 *
 * D-191 point 1: it is sent to the BENEFICIARY'S MINTER CARD (`to`), not to the ledger —
 * the payer's own card for an ordinary mint, the recipient's for a §4.5 gift — with the
 * card's StateInit (`init`) attached, so the first mint a wallet is part of deploys its
 * card. The card forwards it to the ledger beside the wallet's rebate standing.
 */
export function buildMintMessage(opts: {
  /** The ledger the card belongs to (its address is part of the card's). */
  ledger: Address | string;
  /** The wallet signing the send — the beneficiary when `beneficiary` is null. */
  payer: Address | string;
  n: bigint;
  kind: 0 | 1;
  factors: FactorEntry[];
  referralKey: number;
  beneficiary: Address | null;
  /** §4.1's invite line. Omitted / null = an uninvited mint: `inviteCount = 0` and a
   *  null ref, which pays nothing. */
  invites?: InviteInput | null;
  queryId?: bigint;
}): { to: Address; init: StateInit; stateInitBoc: string; body: Cell; value: bigint } {
  if (opts.invites) buildInviteListCell(opts.invites);
  const parse = (a: Address | string) => (typeof a === "string" ? Address.parse(a) : a);
  const ledger = parse(opts.ledger);
  const owner = opts.beneficiary ?? parse(opts.payer);
  const init = minterCardInit(ledger, owner);
  return {
    to: minterCardAddress(ledger, owner),
    init,
    // TON Connect's `stateInit` field: the StateInit cell as base64 BOC.
    stateInitBoc: beginCell().store(storeStateInit(init)).endCell().toBoc().toString("base64"),
    body: encodeMintBody(opts),
    value: MINT_VALUE_NANOTON + FEE_MARGIN_NANOTON,
  };
}

/** The mint BYTES, unchecked: a sandbox suite must be able to send a count the CONTRACT refuses (221). */
export function encodeMintBody(opts: {
  n: bigint;
  kind: number;
  factors: FactorEntry[];
  referralKey: number;
  invites?: InviteInput | null;
  queryId?: bigint;
}): Cell {
  const dict = encodeFactors(opts.factors);
  const b = beginCell()
    .storeUint(LEDGER.mint, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.n, 256)
    .storeUint(opts.kind, 1)
    .storeDict(opts.factors.length > 0 ? dict : undefined)
    .storeUint(opts.referralKey, 32);
  // D-191 point 1: no `beneficiary` field — the card the body is sent to IS the beneficiary's.
  // `Mint`'s TAIL, `primes_ledger.tolk:2049`: `inviteCount: uint3` then
  // `invites: Cell<InviteList>?`. This used to be a bare `storeMaybeRef(null)` for
  // `patron: Cell<PatronMintArgs>?` — D-106 DELETED patron mode and D-101 put these two
  // fields in its place, so that one bit was being read as the first bit of `inviteCount`
  // and every mint died on cell underflow behind it. The count is on the wire even when it
  // is zero: Tolk reads three bits unconditionally.
  b.storeUint(opts.invites?.count ?? 0, 3);
  b.storeMaybeRef(opts.invites ? encodeInviteListCell(opts.invites) : null);
  // UNCHANGED by the invite line: the transfers it funds are paid out of the 1 TON split's
  // residual β (§4.1), not attached on top of it.
  return b.endCell();
}

/*
 * `buildReleaseMessage` is DELETED (D-90.2).
 *
 * It built `release(n)` — D-32's discretionary exit from a won claim: 90% of the escrowed
 * 1 TON back to the reserver, 10% forfeit to the treasury, and the window ending at the
 * mint. There is no claim. A won lot MINTS IN ITS OWN CLOSE, so from the moment `close`
 * lands the caller holds an NFT, and the way out of an NFT you no longer want is the
 * secondary market rather than a protocol buy-back.
 */

// ---------------------------------------------------------------------------
// THE LOT LANES (primes_market.tolk, opcodes 0xF2 — DECISIONS.md D-3/D-16/D-20/D-22).
//
// Two modes, and which one a number is on is not a preference — it is fixed by what the
// number IS and where the head is:
//
//   MODE_ASCENDING    (0)  EVERY NUMBER AHEAD OF THE HEAD, prime or composite (D-88
//                          point 3). `open_lot` places the opener's own bid at P0(n);
//                          each raise refunds the previous high bidder in the same
//                          transaction; `close` is permissionless once the clock has
//                          run, and winning MINTS the number (D-90).
//   MODE_DUTCH_BUYNOW (2)  A PRIME AT OR PAST ITS TURN. Opened by `open_head_lot` only
//                          once `n < headHint`; the clock starts at open and runs the
//                          price down to max(MINT_PRICE, P0/3, NPV/2) over
//                          PRIME_DUTCH_SECONDS, parking there until bought. `bid` IS
//                          the purchase and settles in the SAME transaction.
//
// The head decides which lane: a UI that offers the other one is offering a wallet
// prompt for a transaction the contract will reject.
//
// THE FEE-MARGIN RULE IS SHARPER HERE THAN ANYWHERE ELSE IN THIS FILE. `open_lot` and
// `bid` both compare `in.valueCoins` — the value AFTER TON has deducted the message's own
// forward fee — against a threshold (`>= P0(n)` for open, `>= minPayment` for bid), and
// then STORE that same `in.valueCoins` as the new high bid. So sending the exact nominal
// both (a) risks a throw 1003 / 1004 after the wallet has signed, and (b) would, if it
// landed, book a bid slightly under what the bidder intended. The margin rides into the
// bidder's own bid rather than becoming untracked balance on the contract.
// ---------------------------------------------------------------------------

/**
 * A negative bid is always a caller bug: it would shrink the attached value below the fee
 * margin. ZERO is allowed on purpose — `contracts/wrappers/PrimesMarket.ts` takes only the
 * body and attaches its own value, and passes `0n`. The webapp's `parseAmountToRaw` and the
 * agent's `>= P0 / minNextBid` check refuse a zero bid before they reach here.
 */
function assertBidNotNegative(bid: bigint): void {
  if (bid < 0n) throw new Error(`a bid must not be negative, got ${bid}`);
}

/**
 * `open_lot(n, …)` — permissionless, ASCENDING lane, **every number** (D-88 point 3).
 *
 * It places the opener's own bid: *you cannot open a lot you are unwilling to buy*, so
 * `bidNanoton` must be at least `P0(n)` as read from `getLotPrice(n)`.
 *
 * It carries kind, factors (each with §3.2's `⌊√p⌋`), beneficiary and referral key, and the
 * contract verifies the factorization at OPEN time against exactly these bytes (throw 201).
 * D-90 deleted the escrowed claim the payload used to become: winning MINTS the number in
 * the transaction that closes the lot, so these bytes are the mint's own proof.
 * `addr_none` in the beneficiary slot means "the opener is the beneficiary", identical to
 * `reserve`.
 *
 * D-30: **the score gate and the distance gate are both deleted.** Any composite
 * `n <= AUCTIONABLE_MAX` that is not a primorial may be opened, at any distance from the
 * head. This is the only route to a composite ahead of the head, so a gate would have been
 * a refusal to sell rather than a redirect.
 */
export function buildOpenLotMessage(opts: {
  n: bigint;
  /**
   * WHICH PROOF THIS OPEN CARRIES, and nothing else.
   *
   * This comment used to read "the contract refuses `kind = 1`, so callers must not reach
   * this builder with a prime" — D-22's rule, which **D-88 point 3 deleted**. The assert is
   * gone from `primes_market.tolk` (its own line says so by name), `CLAUDE.md`'s invariant
   * is "a paid ascending auction, for every number — prime or composite", and `Lot.tsx`'s
   * `handleOpen` has been sending `kind: isPrime ? 1 : 0` all along. So the code was right
   * and this sentence was three decisions stale, telling the next reader of the one path
   * that picks `kind` never to do the thing it does. Found by `e2e/lotWrites.spec.ts`
   * (GAUNTLET.md F40), which drives both kinds.
   *
   * `0` = composite: the factorization below rides along and the contract verifies it at
   * OPEN time (throw 201). `1` = prime: no factors, and the contract proves it itself with
   * Miller-Rabin.
   */
  kind: 0 | 1;
  factors: FactorEntry[];
  referralKey: number;
  beneficiary: Address | null;
  bidNanoton: bigint;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  assertBidNotNegative(opts.bidNanoton);
  const dict = encodeFactors(opts.factors);
  const b = beginCell()
    .storeUint(MARKET.open_lot, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.n, 64)
    .storeUint(opts.kind, 1)
    .storeDict(opts.factors.length > 0 ? dict : undefined);
  storeBeneficiary(b, opts.beneficiary);
  b.storeUint(opts.referralKey, 32);
  return { body: b.endCell(), value: opts.bidNanoton + BID_FEE_MARGIN_NANOTON };
}

/**
 * `open_head_lot(n)` — permissionless, gas-only, opens a PRIME's descending lot.
 *
 * Only once the head has passed the prime (D-88 point 3 reinstated the `n < headHint`
 * gate); before its turn a prime is bought on the ascending lane via `open_lot`. The
 * clock starts at open.
 *
 * No bid, no payload and no value beyond gas: the BUYER supplies the beneficiary and
 * referral key with their purchase, and requiring an opening bid would put the opener in
 * front of the clock they just started.
 */
export function buildOpenHeadLotMessage(opts: { n: bigint; queryId?: bigint }): {
  body: Cell;
  value: bigint;
} {
  const body = beginCell()
    .storeUint(MARKET.open_head_lot, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.n, 64)
    .endCell();
  return { body, value: OPEN_HEAD_LOT_GAS_NANOTON };
}

/**
 * D-88 DELETES three message builders, with the mechanics they addressed:
 *
 *   `buildOpenHeadLotCompositeMessage` (`open_head_lot_composite#f2000006`)
 *   `buildBuySpecialCompositeMessage`  (`buy_special_composite#f2000007`)
 *     SS3's 1-day descending lane for a curated composite the head had already passed.
 *     Point 2: specialness is PRICE, not mechanism. A decorated composite is bought ahead
 *     of the head on the ordinary ascending lane at its own `P0(n)` (`buildOpenLotMessage`),
 *     and mints at the head for 1 TON once its turn comes. D-99 goes one step further and
 *     deletes the tiers that "special" named: `P0(n)` is one additive score's ladder rung,
 *     the same rule for every number.
 *
 *   `buildStartPrimeDecayMessage`      (`start_prime_decay#f2000005`)
 *     It un-parked the clock on a prime lot opened before its turn. Point 3 deletes that
 *     state: ahead of the head a prime is an ASCENDING lot, and a descending one can only
 *     be opened after the turn, so its clock always runs from open.
 *
 * All three opcodes are retired and left unassigned.
 */

/**
 * `bid(n, beneficiary, referralKey)` — permissionless. ONE message, two meanings, resolved
 * by the lot's own mode:
 *
 *   - **MODE_ASCENDING** — a raise. `bidNanoton` must be at least `getLot(n).minPayment`,
 *     which is `high + max(1 TON, 5% · high)`. The previous high bidder is refunded in the
 *     same transaction; there is never a claimable balance to forget. `beneficiary` and
 *     `referralKey` are IGNORED on this lane — the lot uses the payload it was opened with.
 *   - **MODE_DUTCH_BUYNOW** — **the purchase**, and it settles in the same transaction.
 *     `bidNanoton` must be at least `getLot(n).minPayment` (the standing descending price
 *     plus RES_GAS). No clock opens; there is nothing to come back and finalize.
 */
export function buildBidMessage(opts: {
  n: bigint;
  bidNanoton: bigint;
  /** Used only on MODE_DUTCH_BUYNOW. `null` = addr_none = the bidder is the beneficiary. */
  beneficiary?: Address | null;
  /** Used only on MODE_DUTCH_BUYNOW. 0 = no referral, which falls to the pool (§4.1). */
  referralKey?: number;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  assertBidNotNegative(opts.bidNanoton);
  const b = beginCell()
    .storeUint(MARKET.bid, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.n, 64);
  storeBeneficiary(b, opts.beneficiary ?? null);
  b.storeUint(opts.referralKey ?? 0, 32);
  return { body: b.endCell(), value: opts.bidNanoton + BID_FEE_MARGIN_NANOTON };
}

/**
 * `close(n)` — permissionless, and **ASCENDING ONLY**. Legal once `now >= closesAt`, and
 * also once the head has reached `n` (the early close; the head is never parked waiting
 * for a lot). Gas-only: the standing high bidder wins at their own bid whoever sends this.
 *
 * A MODE_DUTCH_BUYNOW lot has no permissionless termination at all — it rests on its
 * descending curve until a purchase settles it, and every close attempt throws 1005.
 */
export function buildCloseLotMessage(opts: { n: bigint; queryId?: bigint }): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(MARKET.close, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.n, 64)
    .endCell();
  return { body, value: CLOSE_LOT_GAS_NANOTON };
}


export function buildClaimTributeMessage(opts?: { queryId?: bigint }): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(ITEM.claim_tribute, 32)
    .storeUint(opts?.queryId ?? 0n, 64)
    .endCell();
  return { body, value: CLAIM_GAS_NANOTON };
}

/**
 * GAUNTLET X3 / D-62 — `top_up#c1000006` on a number's item. PERMISSIONLESS: anyone may
 * keep any number alive, which is the whole point of the opcode having a name at all.
 *
 * The body is almost content-free and deliberately so — TVM credits an incoming message's
 * value to the account before any code runs, which is what actually extends the runway, and
 * the item's own header says an empty unrecognised message already does it by accident. What
 * the named opcode buys is DISCOVERABILITY, and this builder is the surface half of that.
 *
 * `multiples` is how many endowments to send. One `ITEM_DEPLOY_VALUE` is what the mint gave
 * the item once and is the whole of a composite's rent, so one multiple buys another of
 * whatever the first bought — see that constant's own comment for why this is the honest
 * unit and a round TON figure is not.
 *
 * The forward fee comes off the value in flight, so the margin rides on top exactly as it
 * does on a mint: without it the balance credited is a little short of the endowment and the
 * runway bought is a little short of the one quoted.
 */
export function buildTopUpMessage(opts?: { multiples?: number; queryId?: bigint }): {
  body: Cell;
  value: bigint;
} {
  const m = opts?.multiples ?? 1;
  // A count of endowments: a typo must refuse, never clamp to 1 or reach BigInt as NaN.
  if (!Number.isSafeInteger(m) || m < 1) throw new Error(`top-up multiples must be a positive integer, got ${m}`);
  const multiples = BigInt(m);
  const body = beginCell()
    .storeUint(ITEM.top_up, 32)
    .storeUint(opts?.queryId ?? 0n, 64)
    .endCell();
  return { body, value: ITEM_DEPLOY_VALUE_NANOTON * multiples + FEE_MARGIN_NANOTON };
}

/**
 * D-146 (signed 2026-09-22) — THE CALLER PAYS, on all four permissionless ratchet legs.
 * Each handler asserts `in.valueCoins >= <its venue gas> + CALLER_COMPUTE_GAS` and throws
 * 225 (`ratchet_flush_gas`) below it, then hands the change back as a TEP-74 `excesses`,
 * so attaching more costs nothing and attaching less is a named refusal. These mirror
 * `primes_ratchet.tolk` exactly (`MessageCrossCheck.spec.ts` pins them to the source):
 *
 *   flush   = DEDUST_SWAP_GAS 0.25                                  + 0.01 = 0.26
 *   stake   = TONSTAKERS_DEPOSIT_FEE 1 + STAKE_GAS 0.3              + 0.01 = 1.31
 *   unstake = TSTON_EXIT_GAS 0.8 + EXIT_LATER_LEGS_GAS 1.15         + 0.01 = 1.96
 *   harvest = HARVEST_GAS 0.15 (0.05 forward to the treasury, M1)   + 0.01 = 0.16
 *
 * `unstake` prepays legs 2 and 3 of the exit because a REPLY sends them, not a caller;
 * what the chain does not spend stays in the ratchet's gas buffer. Literals rather than
 * sums of the constants below: this block is evaluated before them.
 */
export const RATCHET_CALLER_COMPUTE_NANOTON = 10000000n; // 0.01 TON
export const FLUSH_CALLER_GAS_NANOTON = 260000000n; // 0.26 TON
export const STAKE_CALLER_GAS_NANOTON = 1310000000n; // 1.31 TON
export const UNSTAKE_CALLER_GAS_NANOTON = 1960000000n; // 1.96 TON
export const HARVEST_CALLER_GAS_NANOTON = 160000000n; // 0.16 TON
/** What a flush attaches: the required figure plus the standing fee margin. */
export const FLUSH_GAS_NANOTON = FLUSH_CALLER_GAS_NANOTON + FEE_MARGIN_NANOTON; // 0.27 TON

/**
 * `amount` is VENUE-DEPTH SIZING (2026-09-19) and is a CEILING THE CALLER MAY LOWER,
 * never one they may raise: `handleFlush` takes `min(amount, autoSize)` and reads 0 as
 * "size it yourself", which is what every caller that does not read the pool should send.
 *
 * A caller that DOES read the pool computes it with `shared/dedustQuote.ts`'s
 * `maxInAtFloorWithHaircut`, from `get_reserves` on the venue and `getFloorCache` on the
 * ratchet. Without it a tranche sized off `pending` alone bounces off a guard priced off
 * the pool whenever the venue is thinner than the tranche — which is the whole of the
 * defect this argument closes, and the reason §4.3.1's "a market below the floor gets
 * bought" was not true before it.
 *
 * Passing an amount ABOVE the auto size is not an error and not a way to flush harder: the
 * contract silently clamps it. Nothing here can raise the ceiling.
 */
export function buildFlushMessage(opts?: { queryId?: bigint; amountNanoton?: bigint }): {
  body: Cell;
  value: bigint;
} {
  const amount = opts?.amountNanoton ?? 0n;
  if (amount < 0n) throw new Error("buildFlushMessage: amountNanoton must not be negative");
  const body = beginCell()
    .storeUint(RATCHET.flush, 32)
    .storeUint(opts?.queryId ?? 0n, 64)
    .storeCoins(amount)
    .endCell();
  return { body, value: FLUSH_GAS_NANOTON };
}

// The built number line's builders (`open_build`, `prove_input`, `close_build`,
// `expire_build`, the generator transfer and `claim_discovery`) are DELETED with
// constellations and generators (DECISIONS.md D-202). Their opcodes are not recycled.

/** Gas for a registrar trophy message (`annotate`, `transfer_trophy`): its compute and one
 *  storage write. On a FREE first engraving what is left stays as the registrar's rent. */
export const REG_BASE_GAS_NANOTON = 30000000n; // 0.03 TON

/** D-212: what a PAID re-engraving carries on top of `renameFee` — the fee's trip to the
 *  ratchet and the registrar's own compute (`primes_registrar.tolk` REG_RENAME_GAS). */
export const REG_RENAME_GAS_NANOTON = 50000000n; // 0.05 TON

/** D-212: what a `name_number` carries on top of the fee — the collection's door
 *  (`primes_collection.tolk` NAME_RELAY_GAS), which covers the item and the fee's trip to
 *  the ratchet. The change comes home. */
export const NAME_RELAY_GAS_NANOTON = 60000000n; // 0.06 TON

/**
 * §4.7.1's text cap: the name is ONE cell with no refs (D-188 point 2), and 48 characters
 * of `storeStringTail` is inside it. `getAnnotation()` (an item) and `getTrophyAnnotation(n)`
 * (a trophy) read back exactly what this writes.
 */
export const NAME_MAX_CHARS = 48;

function nameText(text: string): Cell {
  const t = text.trim();
  if (t.length === 0 || t.length > NAME_MAX_CHARS) {
    throw new Error(`a name must be 1..${NAME_MAX_CHARS} characters`);
  }
  return beginCell().storeStringTail(t).endCell();
}

/**
 * An ERA TROPHY's engraving (§4.7.1), sent to the REGISTRAR by the trophy's holder. The
 * FIRST is free — gas only (D-179). Every later one costs `renameFee` in TON (D-212,
 * `getTrophyRenameFee()`), which the registrar sends to the floor; pass it as `renameFee`
 * when the trophy's `getTrophyAnnotation(n)` count is above 0. A refusal refunds.
 */
export function buildAnnotateMessage(opts: { n: bigint; text: string; renameFee?: bigint; queryId?: bigint }): {
  body: Cell;
  value: bigint;
} {
  const body = encodeAnnotateBody({ n: opts.n, text: nameText(opts.text), queryId: opts.queryId });
  const value = opts.renameFee && opts.renameFee > 0n
    ? opts.renameFee + REG_RENAME_GAS_NANOTON + FEE_MARGIN_NANOTON
    : REG_BASE_GAS_NANOTON + FEE_MARGIN_NANOTON;
  return { body, value };
}

/** The RAW `annotate` body, no text validation — `PrimesRegistrar.ts` sends it so the
 *  contract suite can put any cell on the wire (GAUNTLET.md G61). */
export function encodeAnnotateBody(opts: { n: bigint; text: Cell; queryId?: bigint }): Cell {
  return beginCell()
    .storeUint(REGISTRAR.annotate, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.n, 256)
    .storeRef(opts.text)
    .endCell();
}

/**
 * D-212 (§4.7.1): NAME A NUMBER YOU OWN. Sent to the MAIN COLLECTION, which relays it to
 * item(n); the item checks the sender is its current owner. `fee` is the collection's
 * `getNaming()` `nameFee` when item(n)'s `getAnnotation()` count is 0, else `renameFee` —
 * read from chain, never from a constant. Every refusal (not the owner, never minted,
 * underpaid) refunds the whole value; on success the change above the fee comes home.
 */
export function buildNameNumberMessage(opts: { n: bigint; text: string; fee: bigint; queryId?: bigint }): {
  body: Cell;
  value: bigint;
} {
  if (opts.fee <= 0n) throw new Error("the naming fee must be read from the collection's getNaming()");
  const body = encodeNameNumberBody({ n: opts.n, text: nameText(opts.text), queryId: opts.queryId });
  return { body, value: opts.fee + NAME_RELAY_GAS_NANOTON + FEE_MARGIN_NANOTON };
}

/** The RAW `name_number` body, no text validation — for the contract suite (G61 idiom). */
export function encodeNameNumberBody(opts: { n: bigint; text: Cell; queryId?: bigint }): Cell {
  return beginCell()
    .storeUint(COLLECTION.name_number, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.n, 256)
    .storeRef(opts.text)
    .endCell();
}

/**
 * D-14 (§4.7): move an era trophy — the naming-right pen over one of §7's eight
 * primorials. Sent by the CURRENT HOLDER and by nobody else; the registrar asserts
 * `names[primorial] == sender` and refuses anything that is not one of the eight
 * (`reg_not_primorial`, 914). `DESIGN.md` G45 — the call was complete on the wrapper
 * side (`PrimesRegistrar.ts:sendTransferTrophy`) before this had a caller in the app.
 *
 * `value` is gas only, same shape as `buildAnnotateMessage` above: no TON moves, the
 * registrar holds none (§3.4), and whatever the trophy sold for was settled off this
 * contract entirely.
 */
export function buildTransferTrophyMessage(opts: {
  primorial: bigint;
  newHolder: string;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(REGISTRAR.transfer_trophy, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.primorial, 256)
    .storeAddress(Address.parse(opts.newHolder))
    .endCell();
  return { body, value: REG_BASE_GAS_NANOTON + FEE_MARGIN_NANOTON };
}

/** What a `claim_voucher` carries: at least the voucher's `CLAIM_MIN_VALUE` (0.15, throw 103
 *  below it), carried on to the vault to pay its jetton hop. The figure `PrimesVoucher.spec.ts` and `GenesisRehearsal`
 *  prove a claim pays out with. */
export const VOUCHER_CLAIM_GAS_NANOTON = 200000000n; // 0.2 TON

/**
 * `VOUCHER.claim_voucher` — redeem a §9.5 signed voucher (DESIGN.md G51).
 *
 * Goes to the voucher INSTANCE that signed tag belongs to (QSTS or PQST, D-171) and MUST be
 * sent by the wallet the signature names: the contract hashes `in.senderAddress` into the
 * check, so a voucher only ever pays whoever it was signed for. Pays the delta over what
 * the contract already paid this wallet; a replay settles quietly having paid nothing.
 */
export function buildClaimVoucherMessage(opts: {
  cumulativeTotal: bigint;
  validUntil: number;
  signature: Buffer;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  if (opts.signature.length !== 64) {
    throw new Error(`a voucher signature must be 64 bytes, got ${opts.signature.length}`);
  }
  const body = beginCell()
    .storeUint(VOUCHER.claim_voucher, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.cumulativeTotal)
    .storeUint(opts.validUntil, 32)
    .storeBuffer(opts.signature, 64)
    .endCell();
  return { body, value: VOUCHER_CLAIM_GAS_NANOTON + FEE_MARGIN_NANOTON };
}

// ---------------------------------------------------------------------------
// THE GOVERNED TREASURY, LP CUSTODY AND THE LP SINK
// `DECISIONS.md` D-100, CONCEPT.md §5.5, `shared/schemas/treasury.tlb`.
//
// Ground truth is `contracts/contracts/primes_treasury.tolk` and
// `primes_lp_position.tolk` plus `contracts/wrappers/PrimesTreasury.ts`, read the same way
// every builder above was: the contract serializes the bytes, so it wins any disagreement
// with the schema file. Opcodes come from `shared/opcodes.ts`; the two gas figures below
// mirror `TREASURY_MIN_FORWARD` (0.15) and `POSITION_MIN_FORWARD` (0.20) and are the only
// numbers here that are not imported, because `POSITION_MIN_FORWARD` is a constant on the
// child contract that `shared/opcodes.ts` does not publish yet (hand-off note in the U7
// report).
//
// **WHERE EACH MESSAGE GOES, because it is not the same address three times.**
//   * a DEPOSIT is a TEP-74 transfer sent to the depositor's OWN DeDust LP jetton wallet,
//     addressed onward to the treasury, carrying the `TDEP` tag and the tier in its
//     `forward_payload`. The treasury never sees the depositor's wallet; it authenticates
//     on its own LP wallet being the notifier.
//   * WITHDRAW / SINK-FORWARD / RELOCK / VOTE / PROPOSE all go to the OWNER'S OWN CHILD
//     (`getPositionAddress(owner)`), which validates ownership and the term clock and
//     forwards to the treasury. (D-168: custody earns nothing, so there is no claim.) Sending one of these straight to the treasury
//     fails its sender check, by design — the child's address IS the authentication.
//   * EXECUTE goes to the treasury and is permissionless: the destination and the amount
//     were fixed when the proposal opened, so who pushes it cannot matter.
// ---------------------------------------------------------------------------

/** `TREASURY_MIN_FORWARD` — what must REACH the treasury, after fees. */
export const TREASURY_MIN_FORWARD_NANOTON = 150000000n; // 0.15 TON
/** `POSITION_MIN_FORWARD` — the child's own hop (0.05) plus the treasury's (0.15). */
export const POSITION_MIN_FORWARD_NANOTON = 200000000n; // 0.20 TON
/** A TEP-74 wallet's own handling, on top of what it forwards. Same figure the child
 *  budgets for its own hop, and the reason a deposit's message value is not just the
 *  forward amount. */
export const JETTON_WALLET_GAS_NANOTON = 50000000n; // 0.05 TON

/** The `forward_payload` tag a custody deposit carries (`getTreasuryActions()`) — the only
 *  LP tag the treasury accepts since D-167 deleted the donate tag. */
const TREASURY_ACTION_DEPOSIT = 0x54444550; // "TDEP"

/**
 * The `forward_payload` a custody deposit carries: the tag, then `tier:uint3` (0..3, the
 * four lock terms since D-168).
 *
 * Exported because it is the one field that decides what a deposit BOUGHT — a payload the
 * treasury does not recognise, or a tier above 3, is refunded in full rather than kept, so
 * getting this wrong costs a round trip and not the LP.
 */
export function buildLpDepositPayload(tier: number): Cell {
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new Error(`tier must be an integer 0..3, got ${tier}`);
  }
  return beginCell().storeUint(TREASURY_ACTION_DEPOSIT, 32).storeUint(tier, 3).endCell();
}

/**
 * Deposit LP into custody — a standard TEP-74 `transfer`, sent to the depositor's own LP
 * jetton wallet, addressed to the treasury.
 *
 * `forward_payload` is written as an EITHER-REF (`1` + a ref) rather than inline, because
 * the treasury reads it as `forward_payload:^Cell`: the tag must survive as its own cell
 * through the wallet's re-serialization into `transfer_notification`.
 *
 * The value is nominal PLUS a margin on both legs, never the exact figure — the treasury
 * asserts `in.valueCoins >= TREASURY_MIN_FORWARD` on what actually ARRIVES, after TON has
 * taken the message's forward fee (the same live failure `MINT_VALUE_NANOTON` documents).
 */
export function buildLpDepositMessage(opts: {
  amountRaw: bigint;
  tier: number;
  treasuryAddress: string;
  /** `response_addr` — where the wallet returns the unspent value. The depositor. */
  ownerAddress: string;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  const forwardTon = TREASURY_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON;
  const body = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.amountRaw)
    .storeAddress(Address.parse(opts.treasuryAddress))
    .storeAddress(Address.parse(opts.ownerAddress))
    .storeMaybeRef(null) // custom_payload
    .storeCoins(forwardTon)
    .storeBit(1) // forward_payload as a ref, not inline
    .storeRef(buildLpDepositPayload(opts.tier))
    .endCell();
  return { body, value: forwardTon + JETTON_WALLET_GAS_NANOTON + FEE_MARGIN_NANOTON };
}

/** One `position_id`-only message to the owner's child — the shape three of them share. */
function buildPositionMessage(
  op: number,
  positionId: number,
  queryId?: bigint,
): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(op, 32)
    .storeUint(queryId ?? 0n, 64)
    .storeUint(positionId, 32)
    .endCell();
  return { body, value: POSITION_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON };
}

/** Take the LP back. D-147: ONE message, accepted from the instant `matures_at` passes —
 *  there is no request to send first and nothing to wait out afterwards. */
export function buildPositionWithdrawMessage(positionId: number, queryId?: bigint) {
  return buildPositionMessage(TREASURY.withdraw, positionId, queryId);
}

/** D-147, and THE ONE MESSAGE HERE ANYONE MAY SEND — the child takes no sender on it.
 *  Marks a matured position's vote weight gone, on the child and in the treasury's
 *  `eligible_weight`. It moves no asset and changes no rule (a matured term cannot vote
 *  whether or not this has run); it stops the 1% proposal threshold being measured
 *  against terms that have ended. Idempotent: a second send returns rather than throwing. */
export function buildPositionExpireMessage(positionId: number, queryId?: bigint) {
  return buildPositionMessage(TREASURY.expire, positionId, queryId);
}

/** D-147. Restart one position's term at `now` under `tier` (0..3); the vote weight moves
 *  with it. Refused as a DOWNGRADE while the current term still runs
 *  (`position_relock_downgrade`, 1167) — after maturity any tier is allowed.
 *  NOT range-checked here, unlike `buildLpDepositPayload`: `contracts/tests/LpCustody.spec.ts`
 *  sends tier 4 through the wrapper to prove the CONTRACT throws 102. The app's tiers come
 *  from `TierLadder` over the chain's own four terms, so it never builds one above 3. */
export function buildPositionRelockMessage(opts: {
  positionId: number;
  tier: number;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(TREASURY.relock, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.positionId, 32)
    .storeUint(opts.tier, 8)
    .endCell();
  return { body, value: POSITION_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON };
}

/** Forward one position's LP to the LP sink — locked depth, forever, no maturity gate.
 *  IRREVERSIBLE: the sink declares no outbound message type at all. */
export function buildPositionToSinkMessage(positionId: number, queryId?: bigint) {
  return buildPositionMessage(TREASURY.to_sink, positionId, queryId);
}

/** Cast ONE named position's vote weight on one proposal (D-147 — a term belongs to a
 *  position, so a wallet holding three live terms sends three of these). The CHILD
 *  computes the weight and refuses a matured term. */
export function buildPositionVoteMessage(opts: {
  seq: number;
  support: boolean;
  positionId: number;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(TREASURY.position_vote, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.seq, 32)
    .storeUint(opts.support ? 1 : 0, 8)
    .storeUint(opts.positionId, 32)
    .endCell();
  return { body, value: POSITION_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON };
}

/** Open a proposal: transfer {TON | PRIMES | tsTON} to an address. Refused unless the
 *  proposer holds `propose_min_bps` of the eligible weight and has no other open one. */
export function buildPositionProposeMessage(opts: {
  asset: number;
  amountRaw: bigint;
  dest: string;
  positionId: number;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(TREASURY.position_propose, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.asset, 8)
    .storeCoins(opts.amountRaw)
    .storeAddress(Address.parse(opts.dest))
    .storeUint(opts.positionId, 32)
    .endCell();
  return { body, value: POSITION_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON };
}

/** Execute a passed proposal, to the TREASURY, permissionless after `closes`. */
export function buildExecuteProposalMessage(
  seq: number,
  queryId?: bigint,
): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(TREASURY.execute, 32)
    .storeUint(queryId ?? 0n, 64)
    .storeUint(seq, 32)
    .endCell();
  return { body, value: TREASURY_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON };
}

/** D-188 point 7. Delete a proposal nothing can happen to any more — to the TREASURY,
 *  permissionless. Refused (`treasury_not_prunable`, 1205) while its vote runs or while
 *  a passed one is still executable; read `getPrunable(seq)` first. Housekeeping only:
 *  every `propose` already prunes the two oldest due rows. The value is gas; what is
 *  left stays with the treasury, as an execute's does. */
export function buildPruneProposalMessage(
  seq: number,
  queryId?: bigint,
): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(TREASURY.prune, 32)
    .storeUint(queryId ?? 0n, 64)
    .storeUint(seq, 32)
    .endCell();
  return { body, value: 50000000n }; // 0.05 TON: one dictionary delete
}

/** D-168 / §5.5.3. Send one epoch's PRIMES budget from the treasury to the stake master —
 *  to the TREASURY, permissionless. Refused before the interval
 *  (`treasury_distribute_early`, 1200) and on an empty treasury
 *  (`treasury_distribute_dust`, 1201); read `getDistribution()` first. The caller funds
 *  the hop and gets the unspent change back. */
export function buildDistributeMessage(queryId?: bigint): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(TREASURY.distribute, 32)
    .storeUint(queryId ?? 0n, 64)
    .endCell();
  return { body, value: TREASURY_DISTRIBUTE_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON };
}

// ---------------------------------------------------------------------------
// PRIMES STAKING — `DECISIONS.md` D-168, CONCEPT.md §5.3, `shared/schemas/stake.tlb`.
//
// Ground truth is `contracts/contracts/primes_stake.tolk` (the master) and
// `primes_stake_position.tolk` (one child per wallet).
//   * a STAKE is a TEP-74 transfer to the staker's OWN PRIMES wallet, addressed to the
//     stake master, carrying `STKL` + `tier:uint8` in its `forward_payload`. Anything
//     else is refunded.
//   * CLAIM / RELOCK / WITHDRAW go to the staker's OWN CHILD
//     (`getStakePositionAddress(owner)`); EXPIRE goes to anyone's child and is anyone's.
// ---------------------------------------------------------------------------

/** The `forward_payload` a stake carries: `STKL`, then `tier:uint8` (0..3). */
export function buildStakePayload(tier: number): Cell {
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) {
    throw new Error(`tier must be an integer 0..3, got ${tier}`);
  }
  return beginCell().storeUint(STAKE_ACTION_LOCK, 32).storeUint(tier, 8).endCell();
}

/** Stake PRIMES for a term — a standard TEP-74 `transfer`, sent to the staker's own PRIMES
 *  jetton wallet, addressed to the stake master. Nominal plus a margin on both legs: the
 *  master asserts `getStakeMinForward()` on what ARRIVES. */
export function buildStakeMessage(opts: {
  amountRaw: bigint;
  tier: number;
  stakeAddress: string;
  /** `response_addr` — where the wallet returns the unspent value. The staker. */
  ownerAddress: string;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  const forwardTon = STAKE_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON;
  const body = beginCell()
    .storeUint(TEP74.transfer, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.amountRaw)
    .storeAddress(Address.parse(opts.stakeAddress))
    .storeAddress(Address.parse(opts.ownerAddress))
    .storeMaybeRef(null) // custom_payload
    .storeCoins(forwardTon)
    .storeBit(1) // forward_payload as a ref
    .storeRef(buildStakePayload(opts.tier))
    .endCell();
  return { body, value: forwardTon + JETTON_WALLET_GAS_NANOTON + FEE_MARGIN_NANOTON };
}

function buildStakePositionMessage(op: number, positionId: number, value: bigint, queryId?: bigint) {
  const body = beginCell()
    .storeUint(op, 32)
    .storeUint(queryId ?? 0n, 64)
    .storeUint(positionId, 32)
    .endCell();
  return { body, value: value + FEE_MARGIN_NANOTON };
}

/** Pay one stake position's accrued PRIMES (plus anything banked) to its owner. */
export function buildStakeClaimMessage(positionId: number, queryId?: bigint) {
  return buildStakePositionMessage(STAKE.claim, positionId, STAKE_POSITION_MIN_FORWARD_NANOTON, queryId);
}

/** At or after `matures_at` only: principal + final reward, one transfer (ST-3). */
export function buildStakeWithdrawMessage(positionId: number, queryId?: bigint) {
  return buildStakePositionMessage(STAKE.withdraw, positionId, STAKE_POSITION_MIN_FORWARD_NANOTON, queryId);
}

/** PERMISSIONLESS, at or after `matures_at`: bank the prorated tail and retire the
 *  weight. Idempotent. No transfer behind it, so it is the cheapest message here. */
export function buildStakeExpireMessage(positionId: number, queryId?: bigint) {
  return buildStakePositionMessage(STAKE.expire, positionId, STAKE_EXPIRE_MIN_FORWARD_NANOTON, queryId);
}

/** Restart one stake position's term under `tier`, paying out on the way. Refused as a
 *  DOWNGRADE while the term runs (`stake_relock_downgrade`, 1107). */
export function buildStakeRelockMessage(opts: {
  positionId: number;
  tier: number;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  const body = beginCell()
    .storeUint(STAKE.relock, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeUint(opts.positionId, 32)
    .storeUint(opts.tier, 8)
    .endCell();
  return { body, value: STAKE_POSITION_MIN_FORWARD_NANOTON + FEE_MARGIN_NANOTON };
}

// ---------------------------------------------------------------------------
// THE DEDUST VENUE — the two legs a PLAYER's swap sends.
//
// `primes_ratchet.tolk` already builds the native leg on chain for `flush()`, and
// `contracts/scripts/dedust.ts` builds the deposit legs for the seeding scripts. This is
// the third and last sender: the swap form in the app (`components/SwapCard`), which
// trades BOTH ways and therefore needs the jetton leg nothing else in this repo sends.
//
// TWO VAULTS, TWO SHAPES, AND THEY ARE NOT INTERCHANGEABLE. Buying PRIMES sends TON to the
// NATIVE vault with the whole swap inline (`swap#ea06185d`), because the TON is the message
// value. Selling PRIMES sends a TEP-74 `transfer` to the seller's OWN jetton wallet,
// addressed to the JETTON vault, with `swap#e3a0d482` as the forward payload and no amount
// field — the transfer that carries it IS the amount. Sending either shape to the other
// vault loses the trade to a refusal.
//
// A DEDUST REFUSAL IS NOT A BOUNCE (`MISTAKES.md` 2026-09-05, `RATCHET.dedust_payout`): the
// pool checks `limit` one hop past the vault, commits its refund and then throws, so the
// swapper gets `payout#474f86cf` back rather than a bounce. That is why `limit` is a real
// number here and never zero — a refused swap costs gas and returns the input, where a
// zero limit accepts any fill at any price, which on a 16-TON pool is a standing invitation.
// ---------------------------------------------------------------------------

/** What DeDust's native vault needs on top of the swap input, for its own hop into the
 *  pool and the pool's payout hop back. Mirrors `primes_ratchet.tolk`'s `DEDUST_SWAP_GAS`
 *  (0.25 TON), which is the same message to the same vault. */
export const DEDUST_SWAP_GAS_NANOTON = 250000000n;


/** The window a swap stays valid for, in seconds. Same figure and same reason as
 *  `primes_ratchet.tolk`'s `DEDUST_SWAP_DEADLINE_WINDOW`: long enough for a wallet
 *  round trip, short enough that a stalled signature expires instead of executing
 *  against a price nobody looked at. */
export const DEDUST_SWAP_DEADLINE_WINDOW = 600;

/** `SwapParams` — the ref cell both legs carry, byte for byte what the ratchet builds. */
function dedustSwapParams(recipient: Address, deadline: number): Cell {
  return beginCell()
    .storeUint(deadline, 32)
    .storeAddress(recipient)
    .storeUint(0, 2) // referral_addr = addr_none
    .storeUint(0, 1) // fulfill_payload = none
    .storeUint(0, 1) // reject_payload = none
    .endCell();
}

/** `SwapStep` — pool, `given_in$0`, the limit, and no next hop. This repo trades one pair. */
function dedustSwapStep(b: Builder, pool: Address, limit: bigint): Builder {
  return b
    .storeAddress(pool)
    .storeUint(0, 1) // SwapStepParams: kind = given_in$0
    .storeCoins(limit) // SwapStepParams: limit — the minimum out this swap will accept
    .storeUint(0, 1); // SwapStepParams: next = none (single hop)
}

/**
 * BUY PRIMES — `swap#ea06185d query_id:uint64 amount:Coins _:SwapStep swap_params:^SwapParams`,
 * sent to the DeDust NATIVE vault (`getVenue().dedustNativeVault`).
 *
 * `value` is the input PLUS the vault's gas, never the input alone: the vault compares what
 * ARRIVES against the declared `amount`, and the forward fee comes out of the value in
 * between. Attaching exactly `amount` is the defect that bounced every flush this project
 * ever sent (`ratchet_flush_gas`, measured 2026-09-17) — the same mistake, one contract over.
 */
export function buildDedustSwapTonMessage(opts: {
  /** The TON going in, in nanotons. */
  amountNanoton: bigint;
  /** `getVenue().dedustPool`. Never typed in — one deployment, one venue. */
  poolAddress: string;
  /** `limit` — the least PRIMES this swap will accept, in nano-PRIMES. Quoted from the
   *  pool's own reserves and fee, minus the swapper's slippage tolerance. */
  minOutPrimes: bigint;
  /** Where the PRIMES go. The swapper. */
  recipientAddress: string;
  /** Unix seconds. `Date.now()/1000 + DEDUST_SWAP_DEADLINE_WINDOW` at the call site, so
   *  the clock the deadline is read off is the caller's and not this module's. */
  deadline: number;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  if (opts.amountNanoton <= 0n) throw new Error("a swap must send something");
  if (opts.minOutPrimes <= 0n) throw new Error("min out must be a real limit, never zero");
  const b = beginCell()
    .storeUint(RATCHET.dedust_swap, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.amountNanoton);
  dedustSwapStep(b, Address.parse(opts.poolAddress), opts.minOutPrimes);
  b.storeRef(dedustSwapParams(Address.parse(opts.recipientAddress), opts.deadline));
  return {
    body: b.endCell(),
    value: opts.amountNanoton + DEDUST_SWAP_GAS_NANOTON + FEE_MARGIN_NANOTON,
  };
}

/**
 * SELL PRIMES — a TEP-74 `transfer` to the seller's OWN PRIMES jetton wallet, addressed to
 * the DeDust JETTON vault (`getVenue().primesJettonVault`), carrying
 * `swap#e3a0d482 _:SwapStep swap_params:^SwapParams` as its `forward_payload`.
 *
 * `forward_payload` is an EITHER-REF (`1` + a ref) for the reason `buildLpDepositMessage`
 * gives: the vault reads it as its own cell out of
 * `transfer_notification`, and an inline payload does not survive that re-serialization.
 *
 * The vault does nothing until the notification arrives, so `forward_ton_amount` must cover
 * the vault's hop AND the pool's payout hop — it is the same 0.25 TON the native leg attaches
 * as message value, moved to where a jetton transfer carries it.
 */
export function buildDedustSwapPrimesMessage(opts: {
  /** The PRIMES going in, in nano-PRIMES. */
  amountPrimes: bigint;
  /** `getVenue().dedustPool`. */
  poolAddress: string;
  /** `getVenue().primesJettonVault` — the transfer's DESTINATION, not its sender. */
  jettonVaultAddress: string;
  /** The seller's own PRIMES jetton wallet (`/primes/wallet/:address`) — where this
   *  message is SENT. A transfer leaves from the owner's wallet, never from the master. */
  ownerAddress: string;
  /** `limit` — the least TON this swap will accept, in nanotons. */
  minOutNanoton: bigint;
  deadline: number;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  if (opts.amountPrimes <= 0n) throw new Error("a swap must send something");
  if (opts.minOutNanoton <= 0n) throw new Error("min out must be a real limit, never zero");
  const payload = beginCell().storeUint(DEDUST.swap_jetton, 32);
  dedustSwapStep(payload, Address.parse(opts.poolAddress), opts.minOutNanoton);
  payload.storeRef(dedustSwapParams(Address.parse(opts.ownerAddress), opts.deadline));

  const forwardTon = DEDUST_SWAP_GAS_NANOTON;
  const body = beginCell()
    .storeUint(TEP74.transfer, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.amountPrimes)
    .storeAddress(Address.parse(opts.jettonVaultAddress))
    .storeAddress(Address.parse(opts.ownerAddress)) // response_addr — the change comes back
    .storeMaybeRef(null) // custom_payload
    .storeCoins(forwardTon)
    .storeBit(1) // forward_payload as a ref, not inline
    .storeRef(payload.endCell())
    .endCell();
  return { body, value: forwardTon + JETTON_WALLET_GAS_NANOTON + FEE_MARGIN_NANOTON };
}

// ---------------------------------------------------------------------------
// THE DEDUST VENUE, PART TWO — the two legs a PLAYER's LIQUIDITY DEPOSIT sends.
//
// Same vault pair as the swap above, different opcodes and a different failure mode. A
// deposit is TWO messages, one per side, and DeDust pairs them inside the pool: the native
// vault takes TON with `deposit_liquidity#d55e4686` inline, and the jetton vault takes
// PRIMES as a TEP-74 `transfer` carrying `deposit_liquidity#40e108d6` in its
// `forward_payload`. Both legs must name the SAME asset pair in the SAME order and the
// SAME `target_balances`, or the pool treats them as two different deposits.
//
// THEY ARE SENT IN ONE SIGNATURE. TonConnect takes up to four messages per request, so the
// app sends both legs together (`useChainSend` takes an array) — a player who signed one
// half and not the other would have TON parked in a vault waiting for a partner that never
// comes. The pool refunds an unmatched leg on its own, but the refund is a round trip the
// player never asked for.
//
// THE LP RECEIPT HAS NO RECIPIENT FIELD anywhere in either schema, so the LP jetton can
// only ever go to the account that SENT these. That is the whole reason the lock flow is
// two transactions and not one: mint the LP to yourself, then transfer it to the treasury.
//
// PROVENANCE. Both layouts are `@dedust/sdk`'s own builders, cross-checked against mainnet
// traces on 2026-09-16 — the docs' TL-B page disagrees with the SDK about whether the
// native leg's three coin fields are inline or in a ref, and the SDK is what mainnet
// accepts. `contracts/scripts/dedust.ts` builds the same two bodies for the seeding
// scripts and is deliberately left alone — it is the module that earned those traces, and
// rewriting a genesis script to import this one would risk the deployment to save a
// duplicate. `shared/dedustDeposit.test.ts` asserts the two produce byte-identical cells
// instead, which is the guard the duplication actually needs.
// ---------------------------------------------------------------------------

/** `volatile$0` — the only DeDust pool type this repo uses. */
export const DEDUST_POOL_TYPE_VOLATILE = 0;

/**
 * `native$0000 = Asset; jetton$0001 workchain_id:int8 address:uint256 = Asset;`
 *
 * A variable-width union — 4 bits for native, 44 for a jetton — which is why it is written
 * by hand. Note what a jetton `Asset` IS: a tag plus the master's hash, an IDENTIFIER and
 * not a pointer. The factory never dereferences it.
 */
export type DedustAsset = { kind: "native" } | { kind: "jetton"; workchainId: number; address: bigint };

export function dedustJettonAsset(master: string | Address): DedustAsset {
  const addr = typeof master === "string" ? Address.parse(master) : master;
  return { kind: "jetton", workchainId: addr.workChain, address: BigInt("0x" + addr.hash.toString("hex")) };
}

export function storeDedustAsset(b: Builder, asset: DedustAsset): Builder {
  if (asset.kind === "native") return b.storeUint(0, 4); // native$0000
  return b.storeUint(1, 4).storeInt(asset.workchainId, 8).storeUint(asset.address, 256); // jetton$0001
}

/** DeDust's own figure for the native vault's hop into the pool plus the pool's reply. */
export const DEDUST_DEPOSIT_NATIVE_GAS_NANOTON = 300000000n; // 0.3 TON
/** What the jetton leg must FORWARD to the vault, on top of the wallet's own handling. */
export const DEDUST_DEPOSIT_JETTON_FORWARD_NANOTON = 400000000n; // 0.4 TON

/**
 * The asset pair, in the order both legs must name it.
 *
 * DeDust normalises pair order when it derives the pool address, so a caller cannot get
 * the *pool* wrong — but `target_balances` is positional, so a caller can absolutely pair
 * the TON figure with the PRIMES asset. One helper returns both together so they cannot be
 * assembled apart.
 */
function dedustPairFor(primesJettonMaster: string): {
  assets: [DedustAsset, DedustAsset];
  order: (tonRaw: bigint, primesRaw: bigint) => [bigint, bigint];
} {
  return {
    assets: [{ kind: "native" }, dedustJettonAsset(primesJettonMaster)],
    order: (tonRaw, primesRaw) => [tonRaw, primesRaw],
  };
}

/**
 * THE TON LEG — `deposit_liquidity#d55e4686`, sent to the NATIVE vault.
 *
 * `value` is the deposited TON PLUS the vault's gas, never the TON alone: the vault
 * compares what ARRIVES against the declared `amount`, and the forward fee comes out in
 * between — the same failure the swap leg's header documents, one opcode over.
 *
 * `targetBalances` is what the depositor is willing to have taken from each side. The pool
 * takes the ratio it needs and refunds the rest, so passing the two typed amounts is
 * correct and passing the pool's reserves is not.
 */
export function buildDedustDepositTonMessage(opts: {
  /** The TON going in, in nanotons. Also this leg's `target_balance`. */
  amountNanoton: bigint;
  /** The PRIMES the OTHER leg sends, in nano-PRIMES. Its `target_balance`. */
  pairedPrimes: bigint;
  /** `/contracts`' `jettonMaster` — the PRIMES side of the pair's `Asset`. */
  primesJettonMaster: string;
  /** The least LP this deposit will accept, in raw LP units. Zero accepts any mint, which
   *  is the DeDust default and is safe here: a deposit cannot be front-run for value the
   *  way a swap can — the pool mints against its reserves at execution and refunds the
   *  unused side. A caller with a quote may still pass one. */
  minLpRaw?: bigint;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  if (opts.amountNanoton <= 0n) throw new Error("a deposit must send something");
  const { assets, order } = dedustPairFor(opts.primesJettonMaster);
  const targets = order(opts.amountNanoton, opts.pairedPrimes);
  const b = beginCell()
    .storeUint(DEDUST.deposit_native, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.amountNanoton)
    .storeUint(DEDUST_POOL_TYPE_VOLATILE, 1);
  storeDedustAsset(b, assets[0]);
  storeDedustAsset(b, assets[1]);
  // The three coin fields go in a REF on this leg and INLINE on the other. That asymmetry
  // is DeDust's, not a mistake here.
  b.storeRef(
    beginCell()
      .storeCoins(opts.minLpRaw ?? 0n)
      .storeCoins(targets[0])
      .storeCoins(targets[1])
      .endCell(),
  );
  b.storeUint(0, 1); // fulfill_payload = none
  b.storeUint(0, 1); // reject_payload = none
  return {
    body: b.endCell(),
    value: opts.amountNanoton + DEDUST_DEPOSIT_NATIVE_GAS_NANOTON + FEE_MARGIN_NANOTON,
  };
}

/**
 * THE PRIMES LEG — a TEP-74 `transfer` to the depositor's OWN PRIMES jetton wallet,
 * addressed to the JETTON vault, carrying `deposit_liquidity#40e108d6` as its
 * `forward_payload`.
 *
 * `forward_payload` is an EITHER-REF (`1` + a ref) for the reason every other builder here
 * gives: the vault reads it as its own cell out of `transfer_notification`, and an inline
 * payload does not survive that re-serialization.
 */
export function buildDedustDepositPrimesMessage(opts: {
  /** The PRIMES going in, in nano-PRIMES. Also this leg's `target_balance`. */
  amountPrimes: bigint;
  /** The TON the OTHER leg sends, in nanotons. Its `target_balance`. */
  pairedTon: bigint;
  /** `/contracts`' `jettonMaster`. */
  primesJettonMaster: string;
  /** `getVenue().primesJettonVault` — the transfer's DESTINATION, not its sender. */
  jettonVaultAddress: string;
  /** The depositor's own PRIMES jetton wallet (`/primes/wallet/:address`) — where this
   *  message is SENT. A transfer leaves from the owner's wallet, never from the master. */
  ownerAddress: string;
  minLpRaw?: bigint;
  queryId?: bigint;
}): { body: Cell; value: bigint } {
  if (opts.amountPrimes <= 0n) throw new Error("a deposit must send something");
  const { assets, order } = dedustPairFor(opts.primesJettonMaster);
  const targets = order(opts.pairedTon, opts.amountPrimes);
  const payload = beginCell().storeUint(DEDUST.deposit_jetton, 32).storeUint(DEDUST_POOL_TYPE_VOLATILE, 1);
  storeDedustAsset(payload, assets[0]);
  storeDedustAsset(payload, assets[1]);
  payload
    .storeCoins(opts.minLpRaw ?? 0n)
    .storeCoins(targets[0])
    .storeCoins(targets[1])
    .storeUint(0, 1) // fulfill_payload = none
    .storeUint(0, 1); // reject_payload = none

  const forwardTon = DEDUST_DEPOSIT_JETTON_FORWARD_NANOTON;
  const body = beginCell()
    .storeUint(TEP74.transfer, 32)
    .storeUint(opts.queryId ?? 0n, 64)
    .storeCoins(opts.amountPrimes)
    .storeAddress(Address.parse(opts.jettonVaultAddress))
    .storeAddress(Address.parse(opts.ownerAddress)) // response_addr — the change comes back
    .storeMaybeRef(null) // custom_payload
    .storeCoins(forwardTon)
    .storeBit(1) // forward_payload as a ref, not inline
    .storeRef(payload.endCell())
    .endCell();
  return { body, value: forwardTon + JETTON_WALLET_GAS_NANOTON + FEE_MARGIN_NANOTON };
}

/**
 * HOW MUCH LP A TWO-SIDED DEPOSIT MINTS — the constant-product rule, which is the same on
 * every Uniswap-v2-shaped pool and is what DeDust's volatile pool implements.
 *
 * `min(tonIn × supply / reserveTon, primesIn × supply / reservePrimes)` — the smaller side
 * decides, and the excess of the larger one is refunded. It is an ESTIMATE and every
 * surface that renders it must say so: the reserves move with any trade that lands between
 * the quote and the deposit. Exported from here rather than computed in a component so the
 * rule sits beside the messages it describes, and so a test can pin it.
 *
 * Returns `null` when the pool has no supply to divide by — an empty pool's first deposit
 * sets the price rather than joining one, and quoting a mint for it would be arithmetic
 * over a zero.
 */
export function quoteDedustLpMinted(opts: {
  amountNanoton: bigint;
  amountPrimes: bigint;
  reserveTonNanoton: bigint;
  reservePrimesNano: bigint;
  lpTotalSupplyRaw: bigint;
}): bigint | null {
  const { amountNanoton, amountPrimes, reserveTonNanoton, reservePrimesNano, lpTotalSupplyRaw } = opts;
  if (lpTotalSupplyRaw <= 0n || reserveTonNanoton <= 0n || reservePrimesNano <= 0n) return null;
  if (amountNanoton <= 0n || amountPrimes <= 0n) return null;
  const fromTon = (amountNanoton * lpTotalSupplyRaw) / reserveTonNanoton;
  const fromPrimes = (amountPrimes * lpTotalSupplyRaw) / reservePrimesNano;
  return fromTon < fromPrimes ? fromTon : fromPrimes;
}

/**
 * THE PARTNER AMOUNT — how much PRIMES pairs with `amountNanoton` at the pool's current
 * ratio, and the other way round.
 *
 * A deposit off the ratio is not refused, it is partially refunded, so a form that lets a
 * player type both sides freely is a form that quietly hands half the deposit back. Both
 * fields are therefore one field: type either side, the other follows.
 */
export function dedustPartnerAmount(opts: {
  amountRaw: bigint;
  /** Which side `amountRaw` is. */
  side: "ton" | "primes";
  reserveTonNanoton: bigint;
  reservePrimesNano: bigint;
}): bigint | null {
  const { amountRaw, side, reserveTonNanoton, reservePrimesNano } = opts;
  if (reserveTonNanoton <= 0n || reservePrimesNano <= 0n || amountRaw <= 0n) return null;
  return side === "ton"
    ? (amountRaw * reservePrimesNano) / reserveTonNanoton
    : (amountRaw * reserveTonNanoton) / reservePrimesNano;
}
