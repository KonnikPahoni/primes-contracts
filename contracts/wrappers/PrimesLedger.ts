import {
    Address,
    beginCell,
    Builder,
    Cell,
    Contract,
    ContractProvider,
    contractAddress,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
    toNano,
} from '@ton/core';
import { LEDGER, MARKET } from '../../shared/opcodes';
import { PrimesItem } from './PrimesItem';
import { PrimesLotBlock } from './PrimesLotBlock';
import { PrimesMinterCard } from './PrimesMinterCard';
import { minterCardCode, minterCardInit, minterCardAddress } from '../../shared/minterCard';
import { lotBlockCode } from '../../shared/lotBlock';

/**
 * TON PRIMES - Splitter + Ledger wrapper (UPGRADE_PLAN_V5.md 4 B1).
 *
 * Successor of the retired PrimesBank wrapper (the deprecated re-export shim
 * was deleted with the rest of the pre-v5 dead code).
 */

export const LedgerOpcodes = {
    // 0xb0000001 and 0xb0000003 are RETIRED and deliberately left unassigned —
    // do not reuse (primes_ledger.tolk D8).
    Mint: LEDGER.mint,
    ClaimTribute: LEDGER.claim_tribute,
    RetryCredit: LEDGER.retry_credit,
    RetryMint: LEDGER.retry_mint,
    RetryItem: LEDGER.retry_item, // D-117: permissionless re-send of a bounced mint_item
    ClaimDividend: LEDGER.claim_dividend, // §3.2: permissionless, credits p's item with div_acc − entry[p]
    SweepOps: LEDGER.sweep_ops, // CONCEPT §4.1 / §8, permissionless
    ClearingCleared: LEDGER.clearing_cleared, // CONCEPT §6 points 2-3 / D-20, from the market only
    DonateFloor: LEDGER.donate_floor, // D-91 point 4 / D-100 point 1 — permissionless: GRAM in, T and S up, PRIMES to the sender
    SettlePrimeClearing: MARKET.settle_prime_clearing, // D-20 — a prime sale, from the market only
    Ignite: LEDGER.ignite, // CONCEPT §6 point 0: mints Unity and starts the game
    SyncLaunch: LEDGER.sync_launch, // permissionless re-send of ignite's launch_open fan-out
    GenesisSeed: LEDGER.genesis_seed,
    SetPeers: LEDGER.set_peers,
    SetSinks: LEDGER.set_sinks,
    SetInviteTerms: LEDGER.set_invite_terms, // D-211, D-215
    MarkOffHead: MARKET.mark_off_head,
    // 0xb0000022 (MarkUnreserved) is DELETED with D-45 — the reserved mark is
    // permanent, so the ledger has no handler for it. Do not reuse.
    SyncHead: LEDGER.sync_head,
    AdvanceHead: LEDGER.advance_head,
    MintWonLot: LEDGER.mint_won_lot,
    // outbound
    PoolInject: LEDGER.pool_inject,
};

export type LedgerConfigA = {
    collectionAddr: Address;
    jettonMasterAddr: Address;
    /**
     * D-100 point 6: the GOVERNED TREASURY CONTRACT (`primes_treasury.tolk`),
     * not a bare owner wallet. It receives `forfeit_split_bps` of every §6
     * point 2 unsold-prime forfeit and — since D-152 — §4.1's whole 5% line.
     */
    treasuryAddr: Address;
    /**
     * D-100 point 6: the operator's wallet. Since D-152 its only claim on a
     * mint is the 42% remainder of a forfeit (D-166). Optional so the many fixtures that pre-date
     * D-100 keep constructing a ledger unchanged; it then defaults to
     * `treasuryAddr`, which reproduces the pre-D-100 behaviour exactly (both
     * lines into one address). A test that means to tell the two fee lines
     * apart must name it.
     */
    operatorAddr?: Address;
    itemCode: Cell;
    /**
     * D-191 point 1: the minter card's code. Defaults to `shared/minterCard.ts`'s
     * compiled cell — the same one every client derives a card address from.
     */
    cardCode?: Cell;
    /**
     * D-196: the lot block's code. Defaults to `shared/lotBlock.ts`'s compiled cell.
     */
    lotBlockCode?: Cell;
};

// The venue moved to the ratchet (3.4), so ConfigB is now the genesis
// authority plus the two decomposition sink addresses. Like the market /
// bounty vault, the sinks cannot be fixed at deploy (their own init data
// embeds the ledger's address), so they are bootstrapped by the one-shot
// SetSinks message and start as a placeholder.
export type LedgerConfigB = {
    genesisScriptAddr: Address;
    ratchetAddr?: Address;
    registrarAddr?: Address;
};

// D12: market + bounty vault addresses are bootstrapped post-deploy via the
// one-shot SetPeers message, so they start as an unset placeholder.
//
// P2.A7: TWO fields, not four. `auctionAddr` and `trophyAuctionAddr` are gone —
// the three market contracts merged into one, so it is the single `launch_open` and `head_update` destination and the single
// sender `ClearingCleared` is accepted from.
export type LedgerConfigD = {
    marketAddr: Address;
    bountyVaultAddr: Address;
};

export type LedgerConfig = {
    a: LedgerConfigA;
    b: LedgerConfigB;
    d?: LedgerConfigD;
    /** D-211: §4.1's invite words at deploy. Defaults to `shared/invites.ts` `INVITE_TEXT_GENESIS`. */
    inviteText?: string;
    /** D-215: §4.1's invite count / value at deploy. Default `INVITE_GENESIS_COUNT` / `_VALUE_NANOTON`. */
    inviteCount?: number;
    inviteValue?: bigint;
    /**
     * TEST HARNESSES ONLY. Genesis always deploys at head 2 with an empty
     * bitmap; nothing on-chain can set either.
     *
     * §3.2.2's constellation multiplier does not apply below
     * CONSTELLATION_ACTIVE_FROM_N = 10002, so measuring the boosted mint path —
     * which is the whole of the §12 gas question — would otherwise mean minting
     * ten thousand numbers in a sandbox. Seeding the head and marking the primes
     * the test needs gets to the same state in one deploy.
     */
    seedHead?: bigint;
    /** Primes to pre-mark in the bitmap; only meaningful alongside `seedHead`. */
    seedPrimes?: bigint[];
    /** D-196, test-only: blocks already imported past the initial window. Defaults to
     *  `seedHead >> 8`, which puts the frontier one window past the seeded head. */
    seedLotBlocksImported?: bigint;
    /** D-198, test-only: the unsold-flush cursor. Defaults to `seedHead >> 8`, so a seeded
     *  head is not stalled by blocks its seed never walked. */
    seedUnsoldFlushed?: bigint;
    /** D-198, test-only: unsold rows (`unsoldPrimes`, plus a `forfeited` row when > 0), so a
     *  full 26-block window can be measured without walking it mint by mint. */
    seedUnsold?: { p: bigint; entry: bigint; forfeited: bigint }[];
    /**
     * TEST HARNESSES ONLY. Seeds `unroutedCredits` — the retry structure a real
     * `credit_tribute` bounce populates (engineering-spec.md §3.3). No message
     * on chain can set this directly; it exists so `retry_credit` (P0.3/P2.C4)
     * can be tested without first forcing a genuine item-side bounce.
     * `unroutedHeld` is derived as the sum of `amount` across entries, kept in
     * lockstep so `getSolvency`'s declared liability matches what's seeded.
     */
    seedUnroutedCredits?: { creditId: bigint; p: bigint; amount: bigint }[];
};

/** The ledger's (and registrar's) dictionary key for an address. */
export function addrKey(a: Address): bigint {
    return BigInt('0x' + beginCell().storeAddress(a).endCell().hash().toString('hex'));
}

// D-100 point 6: the two fee-line destinations live one cell down, because
// ConfigA is already three addresses (801 bits at the worst-case 267-bit
// MsgAddress) and a fourth overflows 1023 — and `Config` was at its four-ref
// ceiling, so a new top-level config cell (the ConfigD/ConfigE answer) is not
// available. See the `FeeDests` block comment in primes_ledger.tolk.
function feeDestsCell(a: LedgerConfigA): Cell {
    return beginCell()
        .storeAddress(a.treasuryAddr)
        .storeAddress(a.operatorAddr ?? a.treasuryAddr)
        .endCell();
}

function configACell(a: LedgerConfigA): Cell {
    return beginCell()
        .storeAddress(a.collectionAddr)
        .storeAddress(a.jettonMasterAddr)
        .storeRef(feeDestsCell(a))
        .storeRef(a.itemCode)
        .storeRef(a.cardCode ?? minterCardCode()) // D-191 point 1
        .storeRef(a.lotBlockCode ?? lotBlockCode()) // D-196
        .endCell();
}

function configBCell(cfg: LedgerConfig): Cell {
    const b = cfg.b;
    return beginCell()
        .storeAddress(b.genesisScriptAddr)
        .storeAddress(b.ratchetAddr ?? cfg.a.collectionAddr)
        .storeAddress(b.registrarAddr ?? cfg.a.collectionAddr)
        .storeUint(b.ratchetAddr && b.registrarAddr ? 1 : 0, 8) // sinksSet
        .endCell();
}

function configDCell(cfg: LedgerConfig): Cell {
    const placeholder = cfg.d?.marketAddr ?? cfg.a.collectionAddr;
    const placeholder2 = cfg.d?.bountyVaultAddr ?? cfg.a.collectionAddr;
    return beginCell()
        .storeAddress(placeholder)
        .storeAddress(placeholder2)
        .storeUint(0, 8)
        // D-117: ConfigD's `opsAddr` is deleted — `sweep_ops` pays the ratchet pool.
        .endCell();
}

// P2.A7: `configECell` is DELETED with ConfigE. It held two market addresses that
// merged into the one `ConfigD.marketAddr` — so ConfigD is
// back under the address pressure that forced the fourth cell in the first place.
function configCell(cfg: LedgerConfig): Cell {
    return beginCell()
        .storeRef(configACell(cfg.a))
        .storeRef(configBCell(cfg))
        .storeRef(configDCell(cfg))
        .storeUint(cfg.inviteCount ?? INVITE_GENESIS_COUNT, 7) // D-215 inviteCount
        .storeCoins(cfg.inviteValue ?? INVITE_GENESIS_VALUE_NANOTON) // D-215 inviteValue
        .storeRef(inviteTextCell(cfg.inviteText ?? INVITE_TEXT_GENESIS)) // D-211
        .endCell();
}

// `swapped` / `inFlightFlush` moved to the ratchet; what replaces them is the
// ledger's own declared liability (see getSolvency).
//
// FIELD ORDER IS LOAD-BEARING and must match `struct Meters` in
// primes_ledger.tolk exactly — this function writes the deploy-time storage
// cell the contract then deserializes. A field added to one side and not the
// other does not fail to compile; it shifts every subsequent field and the
// contract boots with garbage (B-1 added `tributeOwed` here and caught it as
// `ignite` refusing to launch, because `launched`/`genesisSeeded` had been read
// out of the middle of a `coins`).
function metersCell(
    unroutedHeld = 0n,
    divOutstanding = 0n,
    nextCreditId = 0n,
    genesisSeeded = 0,
    // CONCEPT §6 point 0: the launch flag. 0 at deploy on every path — the game
    // starts when `ignite` says so, and a wrapper that could deploy it as 1 would
    // be a second way to start the game that no transaction records.
    launched = 0,
    // B-1: §3.2 tribute credited to items as `owed` and custodied on the
    // ledger. Always 0 at deploy — a genesis that could pre-declare an
    // obligation to an item that does not exist is not a state any message can
    // produce, so the wrapper does not offer it either.
    tributeOwed = 0n,
    seedUnsold: { p: bigint; entry: bigint; forfeited: bigint }[] = []
): Cell {
    const unsoldPrimes = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4));
    const forfeited = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigVarUint(4));
    for (const r of seedUnsold) {
        unsoldPrimes.set(r.p, r.entry);
        if (r.forfeited > 0n) forfeited.set(r.p, r.forfeited);
    }
    return beginCell()
        .storeCoins(tributeOwed) // B-1: accrued-but-unclaimed §3.2 tribute
        .storeCoins(unroutedHeld)
        // D-52: PRIMES emission counted in `S` whose `JettonMint` bounced and
        // has not been replayed by `retry_mint`. Always 0 at deploy — a genesis
        // that could pre-declare a failed mint is not a state any message can
        // produce, same reasoning as `tributeOwed` above.
        .storeCoins(0) // unmintedHeld
        .storeCoins(divOutstanding) // §3.2: accrued-but-unclaimed flat dividend
        .storeUint(nextCreditId, 64)
        .storeUint(genesisSeeded, 8)
        .storeUint(launched, 8)
        // D-20: `unsoldPrimes` (keyed by the prime itself, presence = unsold)
        // replaces the fixed six-bit `unsoldMask` — both start empty; nothing
        // forfeits before `GenesisSeed`'s walk marks the primes it crosses.
        .storeDict(unsoldPrimes) // unsoldPrimes
        // D-20: `forfeited` is now keyed by the prime itself (uint256), not by
        // a fixed index 0-5 into a six-member genesis set. Starts empty.
        .storeDict(forfeited) // forfeited
        // D-20: `head` no longer increments by exactly 1 per mint (it skips
        // every prime), so `getLaunch()`'s item count needs these two honest
        // counters instead of a `head`-derived formula.
        .storeUint(0, 32) // compositesMinted
        .storeUint(0, 32) // primesSoldCount
        // D-36 (§4.7, §7): the era trophy's tally, in its own ref'd cell
        // (`EraSeason`) because Meters is within 50 bits of the 1023 ceiling.
        // All three start empty on every path — an era's recruit season begins
        // at zero by definition, and no message can seed one.
        .storeRef(eraSeasonCell())
        // P2.D1: operator funding counters, own ref'd cell for the same
        // ceiling reason as `eraSeason`. Always 0 at deploy — no message can
        // pre-declare a treasury payment or a sweep that never happened.
        .storeRef(operatorMetersCell())
        .endCell();
}

/** D-36 / D-191 point 1: `EraSeason { leader: any_address, leaderCount: uint32, eraSeq: uint8 }`. */
function eraSeasonCell(): Cell {
    return beginCell()
        .storeAddress(null) // leader — addr_none until the era's first activation
        .storeUint(0, 32) // leaderCount
        .storeUint(0, 8) // eraSeq — ceremonies passed
        .endCell();
}

/**
 * P2.D1 / D-100 point 6: `OperatorMeters { operatorPaidTotal, treasuryPaidTotal,
 * opsSweptTotal, premiumTreasuryPaidTotal }`. Counters kept apart because each
 * pays a distinct revenue event and folding any two into one would invite the
 * misreading §9.1 exists to prevent. D-114 adds `premiumTreasuryPaidTotal`.
 */
function operatorMetersCell(): Cell {
    return beginCell()
        .storeCoins(0) // operatorPaidTotal
        .storeCoins(0) // treasuryPaidTotal
        .storeCoins(0) // opsSweptTotal
        .storeCoins(0) // premiumTreasuryPaidTotal — D-114
        .storeUint(0, 64) // inviteSlotsFunded — §4.1's invite line, D-101
        .storeUint(0, 64) // inviteTransfersSent (D-202)
        .storeUint(0, 64) // inviteValuePaid (D-215)
        .storeCoins(0) // treasuryHeld — G81
        .storeCoins(0) // operatorHeld — G81
        .storeCoins(0) // forfeitedBeyondWindow — D-196
        .endCell();
}

// UnroutedCredit { p: uint256, amount: coins } — engineering-spec.md §3.3.
const UnroutedCreditValue: DictionaryValue<{ p: bigint; amount: bigint }> = {
    serialize(src, builder: Builder) {
        builder.storeUint(src.p, 256).storeCoins(src.amount);
    },
    parse(src) {
        return { p: src.loadUintBig(256), amount: src.loadCoins() };
    },
};

function unroutedCreditsDict(
    seed: { creditId: bigint; p: bigint; amount: bigint }[] | undefined
): Dictionary<bigint, { p: bigint; amount: bigint }> | undefined {
    if (!seed || seed.length === 0) return undefined;
    const d = Dictionary.empty(Dictionary.Keys.BigUint(64), UnroutedCreditValue);
    for (const c of seed) d.set(c.creditId, { p: c.p, amount: c.amount });
    return d;
}

// WS2: aux hit TVM's four-ref ceiling; divEntry moved into a nested aux2 cell
// alongside the new per-wallet dictionaries (mirrors Aux/Aux2 in the contract).
function aux2Cell(): Cell {
    return beginCell()
        .storeDict(undefined) // soldAheadEntry — D-188 point 4
        // D-191 point 1 deleted `minterState` (the standing is on each wallet's
        // minter card); V32 added `deployingPrimes`, so aux2 is THREE dicts.
        .storeDict(undefined) // unroutedItems — D-117: bounced `mint_item` bodies awaiting `retry_item`
        .storeDict(undefined) // deployingPrimes — V32: prime `mint_item`s not yet confirmed or bounced
        .endCell();
}

function auxCell(cfg: LedgerConfig): Cell {
    const seededUnroutedHeld = (cfg.seedUnroutedCredits ?? []).reduce((sum, c) => sum + c.amount, 0n);
    return beginCell()
        .storeRef(metersCell(seededUnroutedHeld, 0n, 0n, 0, 0, 0n, cfg.seedUnsold))
        .storeRef(configCell(cfg))
        .storeDict(undefined) // D12: offHeadBitmap
        .storeRef(aux2Cell())
        // D-196: the frontier starts one window past the (test-only) seeded head, as
        // it would stand had the keeper imported every block on the way there.
        .storeUint(cfg.seedLotBlocksImported ?? (cfg.seedHead ?? 2n) >> 8n, 64) // lotBlocksImported — D-196
        .storeUint(0, 64) // importingBlock — D-196
        .storeCoins(0) // forfeitHeld — D-196
        // D-198: the flush cursor starts where the frontier's seed does, so a test that
        // seeds a far head is not stalled by blocks it never walked.
        .storeUint(cfg.seedUnsoldFlushed ?? (cfg.seedHead ?? 2n) >> 8n, 64) // unsoldFlushed — D-198
        .endCell();
}

/** D-198's `PrimeWords` leaf: D1's marks word, then the unsold word. */
const PrimeWordsValue: DictionaryValue<{ marks: bigint; unsold: bigint }> = {
    serialize(src, builder: Builder) {
        builder.storeUint(src.marks, 256).storeUint(src.unsold, 256);
    },
    parse(src) {
        return { marks: src.loadUintBig(256), unsold: src.loadUintBig(256) };
    },
};

/** D1's chunked bitmap: 256 bits per chunk, index = n - 2. Mirrors bitmapChunkAndBit().
 *  Seeded primes are marked and NOT unsold (owned), as the seed has no unsold rows. */
/** `unsold`: the seeded primes that also carry their unsold bit (a seeded unsold row's prime). */
function primeBitmapDict(primes: bigint[] | undefined, unsold: Set<bigint> = new Set()): Dictionary<number, { marks: bigint; unsold: bigint }> | undefined {
    if (!primes || primes.length === 0) return undefined;
    const d = Dictionary.empty(Dictionary.Keys.Uint(64), PrimeWordsValue);
    for (const p of primes) {
        const idx = p - 2n;
        const chunk = Number(idx / 256n);
        const bit = idx % 256n;
        const w = d.get(chunk) ?? { marks: 0n, unsold: 0n };
        d.set(chunk, { marks: w.marks | (1n << bit), unsold: unsold.has(p) ? w.unsold | (1n << bit) : w.unsold });
    }
    return d;
}

function ledgerConfigToCell(cfg: LedgerConfig): Cell {
    return beginCell()
        .storeUint(cfg.seedHead ?? 2n, 256) // head starts at 2 (seedHead is test-only)
        .storeDict(primeBitmapDict(cfg.seedPrimes, new Set(cfg.seedUnsold?.map((r) => r.p)))) // primeBitmap
        .storeUint(0, 1) // anyOffHead — D-45 gas fix, always 0 at deploy
        .storeUint(0, 1) // walkPending — D-189, 0 until a mint's walk stops early
        .storeCoins(0) // T
        // D-26: `seedT`, the `seeded` term of `T = seeded + swapped + pending`.
        // Always 0 at deploy — only `genesis_seed` writes it, and it is the same
        // number that message puts into T.
        .storeCoins(0) // seedT
        .storeCoins(0) // S
        .storeCoins(0) // divAcc
        .storeUint(cfg.seedPrimes?.length ?? 0, 32) // primesCount — §3.2: π(n)
        .storeUint(0, 64) // lastMintTime
        .storeDict(unroutedCreditsDict(cfg.seedUnroutedCredits)) // unroutedCredits
        // D-52: `unmintedMints`, addrKey(to) -> parked emission. Empty on every
        // deploy path; only a bounced `JettonMint` writes it.
        .storeDict(undefined) // unmintedMints
        .storeRef(auxCell(cfg))
        .endCell();
}

// §3.2: the factor dictionary — `FactorEntry`, `isqrt`, its `DictionaryValue`
// and `encodeFactors` — is NOT defined here, for exactly the invite reason
// below. It lives in `shared/factors.ts`: the WEBAPP builds the same dictionary
// for every real 1 GRAM composite mint, so a private copy in this wrapper would
// mean every `pnpm test:contracts` proof about a submitted factorization ran
// against bytes no player ever sends. Re-exported, not re-written, so the
// sandbox exercises the webapp's exact code path — and so the specs and helpers
// that import these from `'../wrappers/PrimesLedger'` keep working unchanged.
// `FactorCrossCheck.spec.ts` fails if a second transcription reappears.
export { isqrt, FactorValue, encodeFactors, type FactorEntry } from '../../shared/factors';
// ...and imported as well, because `sendMint` below builds the same dict.
import { type FactorEntry } from '../../shared/factors';
import { encodeMintBody } from '../../shared/messages';

// §4.1's invite line (D-202): the invite list's dict encoding and the comment the ledger
// sends live in `shared/invites.ts` and are re-exported, not re-written, so the sandbox
// exercises the exact bytes the webapp and keeper build. `InviteCrossCheck.spec.ts` pins them.
export { inviteAddressDict, inviteListCell, inviteCommentText, inviteCommentCell, inviteTextCell, setInviteTermsBody } from '../../shared/invites';
import { inviteTextCell, setInviteTermsBody, INVITE_TEXT_GENESIS, INVITE_GENESIS_COUNT, INVITE_GENESIS_VALUE_NANOTON } from '../../shared/invites';

export class PrimesLedger implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesLedger(address);
    }

    static createFromConfig(config: LedgerConfig, code: Cell, workchain = 0) {
        const data = ledgerConfigToCell(config);
        const init = { code, data };
        return new PrimesLedger(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    /**
     * CONCEPT §6 point 0 — THE LAUNCH. Mints Unity (number 1) to `owner` and
     * opens the game: the ledger's own `mint` path plus, by one `launch_open`,
     * the market.
     *
     * One-shot, and only from the address the ledger holds as
     * `genesisScriptAddr`. It refuses to fire on a half-wired genesis (sinks
     * unset, peers unset, or T/S unseeded), so a successful ignition is by
     * itself the evidence that the deployment is complete.
     *
     * `value` must cover the ledger's floor — the item deploy (0.025) plus three
     * launch-hop allowances (0.01 each; since P2.A7 only one `launch_open` is
     * sent) — plus this transaction's own gas. The default
     * carries a margin over that, per the repo rule that an on-chain message
     * never arrives with exactly its nominal cost.
     */
    async sendIgnite(
        provider: ContractProvider,
        via: Sender,
        opts: { owner: Address; value?: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value ?? toNano('0.2'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.Ignite, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.owner)
                .endCell(),
        });
    }

    /**
     * PERMISSIONLESS. Re-sends the one `launch_open` message `ignite` sent,
     * for the case where it was lost (it is NoBounce and this system has no
     * admin key). Idempotent: the market's handler is one-shot.
     */
    async sendSyncLaunch(
        provider: ContractProvider,
        via: Sender,
        opts: { value?: bigint; queryID?: number } = {}
    ) {
        await provider.internal(via, {
            value: opts.value ?? toNano('0.1'),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.SyncLaunch, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .endCell(),
        });
    }

    /**
     * D-20 DROPS `unsoldMask`. The head opens at `seedHead` — under D-20's
     * semantics the head is defined over composites (and Unity) only, so a
     * real genesis passes the first COMPOSITE (n = 4) here — and the walk from
     * 2 to `seedHead` marks every prime it crosses as unsold automatically:
     * "was walked and found prime" and "starts life forfeiting" are now the
     * same fact, so there is nothing left for a separate mask to declare.
     */
    async sendGenesisSeed(
        provider: ContractProvider,
        via: Sender,
        opts: { seedT: bigint; seedS: bigint; seedHead?: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.GenesisSeed, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.seedT)
                .storeCoins(opts.seedS)
                .storeUint(opts.seedHead ?? 2n, 256) // D14
                .endCell(),
        });
    }

    /**
     * THE mint. One message, one signature, MINT_PRICE + margin attached
     * (primes_ledger.tolk D8). `value` must exceed 1 GRAM — the ledger asserts
     * against what survives the forward fee, so exactly 1 GRAM reverts with 103.
     *
     * `beneficiary` is §4.5's gift: the NFT and the rebate go there instead of
     * to the payer. D-106 also made it the RECRUIT EDGE — a beneficiary the
     * ledger has never seen credits the payer +1 recruit rank and opens the
     * beneficiary's newcomer window. There is no separate flag for that.
     */
    async sendMint(
        provider: ContractProvider,
        via: Sender,
        opts: {
            n: bigint;
            kind: number;
            factors: FactorEntry[];
            referralKey: number;
            beneficiary: Address | null;
            /**
             * §4.1's invite line (D-202). `count` is what the minter DECLARES
             * (0..3); `addresses` is keyed by SLOT (1..count) and a slot with
             * no entry funds nothing — its 0.1 GRAM stays in the residual β.
             */
            invites?: { count: number; addresses: Map<number, Address> } | null;
            value: bigint;
            queryID?: number;
        }
    ) {
        // ONE builder (shared/messages.ts, A1): the bytes this proves are the bytes a
        // player signs. The RAW encoder, because this suite must be able to send a count
        // or a slot the CONTRACT refuses (invite_count_over_max, 221).
        const body = encodeMintBody({
            n: opts.n,
            kind: opts.kind,
            factors: opts.factors,
            referralKey: opts.referralKey,
            invites: opts.invites,
            queryId: BigInt(opts.queryID ?? 0),
        });
        // D-191 point 1: to the BENEFICIARY's minter card, deploying it if absent.
        const owner = opts.beneficiary ?? via.address!;
        const init = minterCardInit(this.address, owner);
        await via.send({
            to: minterCardAddress(this.address, owner),
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body,
            init,
        });
    }

    /** D-191 point 1: the card `owner`'s standing lives on (same as `getMinterCardAddress`). */
    card(provider: ContractProvider, owner: Address) {
        return provider.open(PrimesMinterCard.createFromAddress(minterCardAddress(this.address, owner)));
    }

    async sendSetPeers(
        provider: ContractProvider,
        via: Sender,
        opts: {
            marketAddr: Address;
            bountyVaultAddr: Address;
            value: bigint;
            queryID?: number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.SetPeers, 32)
                .storeUint(opts.queryID ?? 0, 64)
                // P2.A7: two addresses inline, 630 bits. The `SetPeersExtra` ref
                // is gone with the fourth address that pushed the body to 1164.
                .storeAddress(opts.marketAddr)
                .storeAddress(opts.bountyVaultAddr)
                .endCell(),
        });
    }

    /** 3.4 B1: one-shot bootstrap of the ratchet + registrar addresses. */
    async sendSetSinks(
        provider: ContractProvider,
        via: Sender,
        opts: { ratchetAddr: Address; registrarAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.SetSinks, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.ratchetAddr)
                .storeAddress(opts.registrarAddr)
                .endCell(),
        });
    }

    async sendSyncHead(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(LedgerOpcodes.SyncHead, 32).storeUint(opts.queryID ?? 0, 64).endCell(),
        });
    }

    /** D-189, permissionless: continue a head-advance walk a mint stopped early. */
    async sendAdvanceHead(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(LedgerOpcodes.AdvanceHead, 32).storeUint(opts.queryID ?? 0, 64).endCell(),
        });
    }

    /** 1 / 0 below the import frontier; -1 when `n`'s block is beyond it (D-196) — see
     *  `isNumberOffHeadResolved`, which follows that to the block's lot block. */
    async isNumberOffHead(provider: ContractProvider, n: bigint) {
        return (await provider.get('isNumberOffHead', [{ type: 'int', value: n }])).stack.readNumber();
    }

    /** D-196: whether a lot has ever claimed `n`, wherever the mark lives. An undeployed
     *  lot block means no lot has touched the block. */
    async isNumberOffHeadResolved(provider: ContractProvider, n: bigint): Promise<boolean> {
        const local = await this.isNumberOffHead(provider, n);
        if (local !== -1) return local === 1;
        // The ledger's own bitmap indexing: block (n - 2) >> 8, bit (n - 2) & 255.
        const block = provider.open(PrimesLotBlock.createFromAddress(await this.getLotBlockAddress(provider, (n - 2n) >> 8n)));
        const words = await block.getWordsOrZero();
        return ((words.claimed >> ((n - 2n) & 255n)) & 1n) === 1n;
    }

    /** D-196, permissionless: pull the frontier block's marks in from its lot block. */
    async sendImportLotBlock(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(LEDGER.import_lot_block, 32).storeUint(opts.queryID ?? 0, 64).endCell(),
        });
    }

    /** D-198: move the oldest passed block's unsold rows to its lot block. Permissionless. */
    async sendFlushUnsold(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(LEDGER.flush_unsold, 32).storeUint(opts.queryID ?? 0, 64).endCell(),
        });
    }

    /** D-198: (unsoldFlushed, dueNow). */
    async getUnsoldFlush(provider: ContractProvider) {
        const r = await provider.get('getUnsoldFlush', []);
        return { unsoldFlushed: r.stack.readBigNumber(), dueNow: r.stack.readNumber() === 1 };
    }

    /** D-196: the import window and where the frontier stands. */
    async getLotBlockState(provider: ContractProvider) {
        const r = await provider.get('getLotBlockState', []);
        return {
            windowBlocks: r.stack.readNumber(),
            frontierBlock: r.stack.readBigNumber(),
            importingBlock: r.stack.readBigNumber(),
            dueNow: r.stack.readNumber() === 1,
        };
    }

    /** D-196: where block `block`'s marks live while it is beyond the frontier. */
    async getLotBlockAddress(provider: ContractProvider, block: bigint) {
        return (await provider.get('getLotBlockAddress', [{ type: 'int', value: block }])).stack.readAddress();
    }

    /** D-196: §6 point 2's forfeit cited against primes beyond the frontier, summed. */
    async getForfeitedBeyondWindow(provider: ContractProvider) {
        return (await provider.get('getForfeitedBeyondWindow', [])).stack.readBigNumber();
    }

    async getPeers(provider: ContractProvider) {
        const result = await provider.get('getPeers', []);
        const marketAddr = result.stack.readAddress();
        const bountyVaultAddr = result.stack.readAddress();
        const peersSet = result.stack.readNumber();
        return { marketAddr, bountyVaultAddr, peersSet };
    }

    async getFloorNum(provider: ContractProvider) {
        return (await provider.get('getFloorNum', [])).stack.readBigNumber();
    }
    async getFloorDen(provider: ContractProvider) {
        return (await provider.get('getFloorDen', [])).stack.readBigNumber();
    }
    /**
     * D-156 / §9.1: `S_MAX`, the ceiling cumulative emission approaches and never
     * reaches. A constant on the contract, published as a get-method so the
     * dashboard's max-supply row is a read rather than a number compiled into the
     * webapp — §9.1's rule, and CLAUDE.md rule 3's.
     */
    async getMaxSupply(provider: ContractProvider) {
        return (await provider.get('getMaxSupply', [])).stack.readBigNumber();
    }
    /**
     * D-26 (§5): the `seeded` term of `T = seeded + swapped + pending`.
     *
     * Founder capital credited straight into `T` at genesis; it backs `S` from
     * the DeDust LP and never passes through the ratchet's `pending`. Constant
     * after `genesis_seed`. A reader that omits it sees a permanent false
     * solvency gap of exactly this size.
     */
    async getSeedT(provider: ContractProvider) {
        return (await provider.get('getSeedT', [])).stack.readBigNumber();
    }
    /** PHASE B2: the flat prime-dividend accumulator. 0 until B2 lands. */
    async getDivAcc(provider: ContractProvider) {
        return (await provider.get('getDivAcc', [])).stack.readBigNumber();
    }
    /**
     * `entry[p]`, the flat dividend's per-prime stamp, WHEREVER IT LIVES (D-188
     * point 4): the ledger's own row while `p` is unsold or sold-ahead-and-unclaimed,
     * else `item(p).getDivEntry()`. 0 for a number with neither (not an eligible
     * prime, or an item not deployed). `getDivEntryRaw` is the ledger's own answer.
     */
    async getDivEntry(provider: ContractProvider, p: bigint) {
        const raw = await this.getDivEntryRaw(provider, p);
        if (raw >= 0n) return raw;
        // D-198: -2 = unsold, its block flushed — the bookmark is on the lot block.
        if (raw === -2n) return (await this.flushedBookmark(provider, p)) ?? 0n;
        return (await this.itemGet(provider, p, (item) => item.getDivEntry())) ?? 0n;
    }
    /** D-198: a flushed unsold prime's bookmark, off its lot block's `getBookmark(p)`. */
    private async flushedBookmark(provider: ContractProvider, p: bigint): Promise<bigint | null> {
        const lb = await this.getLotBlockAddress(provider, (p - 2n) >> 8n);
        try {
            const r = await provider.open(PrimesLotBlock.createFromAddress(lb)).getBookmark(p);
            return r.found ? r.entry : null;
        } catch {
            return null;
        }
    }
    /** The ledger's `getDivEntry(p)`: its held bookmark, or -1 when it holds none. */
    async getDivEntryRaw(provider: ContractProvider, p: bigint) {
        return (await provider.get('getDivEntry', [{ type: 'int', value: p }])).stack.readBigNumber();
    }
    /** Runs `read` on item(p), or returns null when that item is not deployed. */
    private async itemGet<T>(provider: ContractProvider, p: bigint, read: (item: { getDivEntry(): Promise<bigint>; getClaimableDividend(divAcc: bigint): Promise<bigint>; getForfeited(): Promise<bigint> }) => Promise<T>): Promise<T | null> {
        const addr = await this.getItemAddress(provider, p);
        const item = provider.open(PrimesItem.createFromAddress(addr));
        try {
            return await read(item);
        } catch {
            return null;
        }
    }
    /**
     * `claimable(p) = div_acc - entry[p]`, in one call (CONCEPT.md 3.2 / 9.1).
     *
     * The pair above is what makes the flat dividend *readable* — closing what was
     * LATE_GAME_PLAN.md §1.3's (now CONCEPT.md §3.2 + §9.1)
     * one genuine code gap: every asset in the design exposes a stock, `div_acc` is global,
     * and without the stamp a prime's own claimable share is not derivable by anyone.
     * Clamped at 0 and gated on `isKnownPrime`, so an unminted number reads 0 rather than
     * the whole accumulator.
     */
    async getClaimableDividend(provider: ContractProvider, p: bigint) {
        const raw = await this.getClaimableDividendRaw(provider, p);
        if (raw >= 0n) return raw;
        const divAcc = await this.getDivAcc(provider);
        // D-198: -2 = unsold and flushed; the same subtraction on the lot block's stamp.
        if (raw === -2n) {
            const entry = await this.flushedBookmark(provider, p);
            return entry === null || divAcc <= entry ? 0n : divAcc - entry;
        }
        // D-188 point 4: -1 = the item holds the bookmark; the same subtraction there.
        return (await this.itemGet(provider, p, (item) => item.getClaimableDividend(divAcc))) ?? 0n;
    }
    /** The ledger's own `getClaimableDividend(p)`: -1 when the bookmark is on item(p). */
    async getClaimableDividendRaw(provider: ContractProvider, p: bigint) {
        return (await provider.get('getClaimableDividend', [{ type: 'int', value: p }])).stack.readBigNumber();
    }
    /** 3.4's one-get-call solvency property: (balance, liability, delta). */
    async getSolvency(provider: ContractProvider) {
        const r = await provider.get('getSolvency', []);
        return {
            balance: r.stack.readBigNumber(),
            liability: r.stack.readBigNumber(),
            delta: r.stack.readBigNumber(),
        };
    }

    /**
     * B-1 / §9.1: `getSolvency`'s liability term, itemized into the three
     * obligations that make it up. `tributeOwed` is §3.2's accrued tribute —
     * credited to items as `owed` but custodied on the ledger, and the line
     * whose absence from the declared liability let `sweep_ops` pay player
     * money to the operator. The three always sum to `getSolvency().liability`.
     */
    async getLiabilityBreakdown(provider: ContractProvider) {
        const r = await provider.get('getLiabilityBreakdown', []);
        return {
            tributeOwed: r.stack.readBigNumber(),
            unroutedHeld: r.stack.readBigNumber(),
            divOutstanding: r.stack.readBigNumber(),
            // G81: fee legs held below RATCHET_HOP_GAS, owed to each recipient.
            treasuryHeld: r.stack.readBigNumber(),
            operatorHeld: r.stack.readBigNumber(),
        };
    }

    /** V24: the value `retry_item(n)` must carry — sized by the parked body — or -1n. */
    async getRetryItemMinValue(provider: ContractProvider, n: bigint): Promise<bigint> {
        const r = await provider.get('getRetryItemMinValue', [{ type: 'int', value: n }]);
        return r.stack.readBigNumber();
    }

    /** G68b / D-117: the smallest `n >= from` parked for `retry_item`, or -1n. */
    async getNextUnroutedItem(provider: ContractProvider, from: bigint): Promise<bigint> {
        const r = await provider.get('getNextUnroutedItem', [{ type: 'int', value: from }]);
        return r.stack.readBigNumber();
    }

    /** LOW-3: the smallest prime `p >= from` whose dividend stamp is parked for its item, or -1n. */
    async getNextSoldAhead(provider: ContractProvider, from: bigint): Promise<bigint> {
        const r = await provider.get('getNextSoldAhead', [{ type: 'int', value: from }]);
        return r.stack.readBigNumber();
    }

    /** CONCEPT §4.1 / §8: the gas-&-ops surplus sweep. Permissionless — `via` is
     *  whoever pays the gas, not an authority. */
    async sendSweepOps(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.SweepOps, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .endCell(),
        });
    }

    /**
     * CONCEPT §6 points 2-3 / D-20: a market clearing. Only the market address
     * recorded by SetPeers may send it; `value` must cover `amount` plus the
     * ratchet hop, or the ledger throws 103 rather than crediting a floor step
     * it did not receive the backing for.
     *
     * D-20 DROPS `lane`. Under the old K-lot design a bit here told the ledger
     * "this is a genesis clearing, also clear the forfeit-mask bit"; under
     * D-20 a prime sale (and its forfeit-entry clear) is reported by the
     * separate `sendSettlePrimeClearing` below, so this message carries only
     * the premium above MINT_PRICE, on every lane alike, uniformly.
     */
    /**
     * D-91 point 4 — the permissionless floor donation. `amount` GRAM in; `T`
     * rises by it, `S` rises by the emission, and that many nano-PRIMES are
     * minted TO THE SENDER, who pairs and burns on DeDust themselves. This is
     * where the pool's PRIMES side comes from.
     *
     * D-100 point 1 — THE RATE IS `min(amount * L, amount * S / T)`, with
     * `L = 10_000` (D-29, `params.json genesis.genesis_lp_ratio_primes_per_ton`)
     * used while `T = 0`. Below `p_f = 1/L` that is the flat `L`; above it, the
     * donation buys at the floor and emits LESS. It no longer throws 217 —
     * that error is retired — because at the floor rate a donation cannot
     * dilute anyone by construction.
     *
     * `seedT` is NOT touched: the donation lands in the ratchet's `pending`, so
     * `T = seedT + swapped + pending` closes with the donation counted once.
     *
     * Anyone may call it, any number of times. `value` must cover `amount`
     * plus 0.025 GRAM of hop gas (0.005 ratchet + 0.02 jetton mint) plus the
     * usual compute margin — send `amount + 0.05n`, never exactly `amount`.
     */
    async sendDonateFloor(
        provider: ContractProvider,
        via: Sender,
        opts: { amount: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.DonateFloor, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.amount)
                .endCell(),
        });
    }

    async sendClearingCleared(
        provider: ContractProvider,
        via: Sender,
        opts: {
            prime: bigint;
            amount: bigint;
            value: bigint;
            queryID?: number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.ClearingCleared, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.prime, 256)
                .storeCoins(opts.amount)
                .endCell(),
        });
    }

    /**
     * D-20 — inbound, from the market only, on a MODE_DUTCH_BUYNOW close.
     * Reports a prime sale directly: primes never occupy the head. Runs the ordinary §4.1
     * five-way split on the nominal MINT_PRICE and clears `n`'s `unsoldPrimes`
     * entry in the same transaction. The ledger deploys the item here, as it
     * does for every other mint.
     */
    async sendSettlePrimeClearing(
        provider: ContractProvider,
        via: Sender,
        opts: { n: bigint; beneficiary: Address; referralKey: number; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.SettlePrimeClearing, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.n, 256)
                .storeAddress(opts.beneficiary)
                .storeUint(opts.referralKey, 32)
                .endCell(),
        });
    }

    /**
     * CONCEPT §6 point 2: nanoGRAM of p's tribute line forfeited while p had no
     * owner, LIFETIME: the ledger's row (while p has no owner) plus the counter
     * the sale handed to item(p) (D-188 point 4). Monotonic; 0 for any p that has
     * never forfeited. `getForfeitedRaw` is the ledger's half alone. D-198: plus the
     * counter frozen on p's lot block when its block was flushed unsold (later forfeits
     * on it are in the unattributed `getForfeitedBeyondWindow()`, not here).
     */
    async getForfeited(provider: ContractProvider, p: bigint) {
        const onLedger = await this.getForfeitedRaw(provider, p);
        const onItem = (await this.itemGet(provider, p, (item) => item.getForfeited())) ?? 0n;
        const lb = await this.getLotBlockAddress(provider, (p - 2n) >> 8n);
        let onLotBlock = 0n;
        try {
            const b = await provider.open(PrimesLotBlock.createFromAddress(lb)).getBookmark(p);
            if (b.found) onLotBlock = b.forfeited;
        } catch {
            // undeployed: never flushed
        }
        return onLedger + onItem + onLotBlock;
    }
    async getForfeitedRaw(provider: ContractProvider, p: bigint) {
        return (await provider.get('getForfeited', [{ type: 'int', value: p }])).stack.readBigNumber();
    }

    /**
     * D-20 — replaces `getUnsoldMask`. Is `p` STILL an open, unsold Dutch lot
     * right now? A fixed six-bit mask no longer fits once every prime (not
     * just a pre-deployed set) can be open at once, so this is a per-prime
     * query instead.
     */
    async isPrimeUnsold(provider: ContractProvider, p: bigint) {
        return (await provider.get('isPrimeUnsold', [{ type: 'int', value: p }])).stack.readNumber() === 1;
    }

    async getOpsSweep(provider: ContractProvider) {
        const r = await provider.get('getOpsSweep', []);
        return {
            sweepable: r.stack.readBigNumber(),
            reserve: r.stack.readBigNumber(),
        };
    }
    /**
     * P2.D1: cumulative, lifetime — distinct from `getOpsSweep`'s
     * current-sweepable figure.
     *
     * D-100 point 6 splits the old single `treasuryPaidTotal` in two, and
     * D-152 moved §4.1's 5% line between the halves. `treasuryPaidTotal` is
     * that 5% line plus the governed treasury contract's `forfeit_split_bps`
     * share of every §6 point 2 forfeit; `operatorPaidTotal` is the operator's
     * remainder of those forfeits and nothing else, so it stays at zero on any
     * mint whose cited factors all have owners. Their sum is the figure the one
     * counter used to report.
     *
     * D-114 adds `premiumTreasuryPaidTotal`: the treasury contract's
     * `premium_treasury_bps` share of every auction clearing's premium, a
     * distinct revenue event from a forfeit and so its own counter rather
     * than folded into `treasuryPaidTotal`.
     */
    async getOperatorTotals(provider: ContractProvider) {
        const r = await provider.get('getOperatorTotals', []);
        return {
            operatorPaidTotal: r.stack.readBigNumber(),
            treasuryPaidTotal: r.stack.readBigNumber(),
            opsSweptTotal: r.stack.readBigNumber(),
            premiumTreasuryPaidTotal: r.stack.readBigNumber(),
        };
    }

    /**
     * D-100 point 6 / §9.1: where the fee lines go, and how a forfeit divides.
     * Both addresses are deploy-fixed; no message on this contract can change
     * either. `forfeitTreasuryBps` is the treasury's share of a forfeit — the
     * operator takes `10_000 - forfeitTreasuryBps`.
     */
    async getFeeDests(provider: ContractProvider) {
        const r = await provider.get('getFeeDests', []);
        return {
            treasuryAddr: r.stack.readAddress(),
            operatorAddr: r.stack.readAddress(),
            forfeitTreasuryBps: r.stack.readNumber(),
        };
    }
    async getSinks(provider: ContractProvider) {
        const r = await provider.get('getSinks', []);
        return {
            ratchetAddr: r.stack.readAddress(),
            registrarAddr: r.stack.readAddress(),
            sinksSet: r.stack.readNumber(),
        };
    }
    async getHead(provider: ContractProvider) {
        return (await provider.get('getHead', [])).stack.readBigNumber();
    }

    /** D-189: true while `head` is parked mid-walk and `advance_head` must run. */
    async getWalkPending(provider: ContractProvider) {
        return (await provider.get('getWalkPending', [])).stack.readNumber() === 1;
    }

    /**
     * CONCEPT §6 point 0 / §9.1: `launched` is whether `ignite` has run.
     * `itemsMinted` can no longer be derived from `head` alone (D-20: `head`
     * now skips every prime, so the gap between two composites is not always
     * 1) — it is instead `compositesMinted + primesSoldCount + launched`.
     * Both come from the contract so the UI never has to reconstruct that
     * arithmetic itself.
     */
    async getLaunch(provider: ContractProvider) {
        const stack = (await provider.get('getLaunch', [])).stack;
        return {
            launched: stack.readNumber() === 1,
            itemsMinted: stack.readBigNumber(),
        };
    }

    /**
     * §4.1's invite line / §9.1 (D-202): the invite line, lifetime. CUMULATIVE.
     * `slotsToPool` is `slotsFunded - transfersSent` — the slots that fell to β,
     * so "unspent slots go to the pool" is checked from outside rather than
     * asserted. `valueDelivered` is what invitees received (D-215: summed at each
     * mint's live value); `linePaid` is that plus `transfersSent × INVITE_SEND_FEE` exactly.
     */
    async getInviteSpend(provider: ContractProvider) {
        const r = await provider.get('getInviteSpend', []);
        return {
            slotsFunded: r.stack.readBigNumber(),
            transfersSent: r.stack.readBigNumber(),
            slotsToPool: r.stack.readBigNumber(),
            valueDelivered: r.stack.readBigNumber(),
            linePaid: r.stack.readBigNumber(),
        };
    }

    /** §4.1's invite line (D-215): the live operator-set terms and the three fixed bounds. */
    async getInviteTerms(provider: ContractProvider) {
        const r = await provider.get('getInviteTerms', []);
        return {
            count: r.stack.readNumber(),
            value: r.stack.readBigNumber(),
            sendFee: r.stack.readBigNumber(),
            lineCap: r.stack.readBigNumber(),
            countCeiling: r.stack.readNumber(),
        };
    }

    /** D-202: the exact body every invite transfer carries (D-215: the words alone). */
    async getInviteComment(provider: ContractProvider) {
        return (await provider.get('getInviteComment', [])).stack.readCell();
    }

    /** D-211: the live invite words, as UTF-8 text. */
    async getInviteText(provider: ContractProvider) {
        return (await provider.get('getInviteText', [])).stack.readCell().beginParse().loadStringTail();
    }

    /** D-211 + D-215: rewrite §4.1's invite count, value and words. Refused 100 unless `via`
     *  is `FeeDests.operatorAddr`; 238 outside the bounds; 237 for bad words. `value` is the
     *  GRAM attached for gas, `inviteValue` the per-transfer value being set. */
    async sendSetInviteTerms(
        provider: ContractProvider,
        via: Sender,
        opts: { count: number; inviteValue: bigint; words: string; value: bigint; queryID?: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: setInviteTermsBody(opts.count, opts.inviteValue, opts.words, opts.queryID ?? 0n),
        });
    }
    /** §3.2 / §9.1: π(n), the count of minted primes (the flat dividend's divisor). */
    async getPrimesCount(provider: ContractProvider) {
        return (await provider.get('getPrimesCount', [])).stack.readNumber();
    }
    /** §3.2: permissionless — converts p's accrued flat dividend into its item's `owed`. */
    async sendClaimDividend(provider: ContractProvider, via: Sender, opts: { p: bigint; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.ClaimDividend, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.p, 256)
                .endCell(),
        });
    }
    /** Permissionless retry of a bounced credit_tribute (P0.3/P2.C4, engineering-spec.md §3.3). */
    async sendRetryCredit(provider: ContractProvider, via: Sender, opts: { creditId: bigint; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.RetryCredit, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.creditId, 64)
                .endCell(),
        });
    }
    /**
     * D-52: permissionless retry of a bounced jetton MINT, for `to`.
     *
     * A bounced `JettonMint` parks its emission in `unminted_mints` rather than
     * decrementing `S` (§3.3/§5 forbid that, and phantom `S` errs on the
     * conservative side of `p_f`). This pays it out. Anyone may call it for
     * anyone — the PRIMES go only to `to`, which is the key the bounce wrote.
     * Unknown or already-retried recipient is a no-op, not a throw.
     */
    async sendRetryMint(provider: ContractProvider, via: Sender, opts: { to: Address; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.RetryMint, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.to)
                .endCell(),
        });
    }

    /**
     * D-117: a bounced `mint_item` parks its original body (held split included) under
     * `n`. This re-sends it to the same owner with the same held split; the caller pays
     * the deploy (`value` >= 0.035 GRAM). Unknown `n` is a no-op, not a throw.
     */
    async sendRetryItem(provider: ContractProvider, via: Sender, opts: { n: bigint; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LedgerOpcodes.RetryItem, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.n, 256)
                .endCell(),
        });
    }
    /**
     * D-52 / §9.1: emission `S` counts that no wallet received, because its
     * `JettonMint` bounced and has not been retried. Reads 0 in a healthy
     * deployment; a non-zero value is recoverable via `sendRetryMint`.
     *
     * The reconciliation it exists for:
     * `S - unmintedHeld == master.totalSupply + cumulative sink burns`.
     */
    async getUnmintedHeld(provider: ContractProvider) {
        return (await provider.get('getUnmintedHeld', [])).stack.readBigNumber();
    }
    /** Unix seconds of the last settled mint; 0 when nothing has been minted yet. */
    async getLastMintTime(provider: ContractProvider) {
        return (await provider.get('getLastMintTime', [])).stack.readBigNumber();
    }
    async getK(provider: ContractProvider, n: bigint, t: bigint) {
        return (
            await provider.get('getK', [
                { type: 'int', value: n },
                { type: 'int', value: t },
            ])
        ).stack.readBigNumber();
    }
    async getKMax(provider: ContractProvider, n: bigint) {
        return (await provider.get('getKMax', [{ type: 'int', value: n }])).stack.readBigNumber();
    }
    async getMinterCardAddress(provider: ContractProvider, wallet: Address) {
        return (
            await provider.get('getMinterCardAddress', [{ type: 'slice', cell: beginCell().storeAddress(wallet).endCell() }])
        ).stack.readAddress();
    }

    /** §5: (kMaxEffective, clamped) for an uplift SUM — the card's `getUpliftLine().summed`. */
    async getKMaxForSum(provider: ContractProvider, n: bigint, upliftSum: bigint) {
        const r = await provider.get('getKMaxFor', [
            { type: 'int', value: n },
            { type: 'int', value: upliftSum },
        ]);
        return { kmax: r.stack.readBigNumber(), clamped: r.stack.readNumber() === 1 };
    }

    /**
     * D-36 (§4.7, §7): the era trophy's live standing, plus `eraSeq` (ceremonies passed,
     * D-191 point 1). `leader` is null (addr_none) while the era has seen no recruit.
     */
    async getEraLeader(provider: ContractProvider) {
        const r = await provider.get('getEraLeader', []);
        return {
            leader: r.stack.readAddressOpt(),
            recruits: r.stack.readNumber(),
            eraSeq: r.stack.readNumber(),
        };
    }

    // ---- D-191 point 1: the per-wallet readers moved to the wallet's minter card.
    //      These keep their old names and shapes and read the card (an undeployed
    //      card is zero standing), so a suite reads a wallet exactly as before.

    async getMinterState(provider: ContractProvider, owner: Address) {
        return this.card(provider, owner).getMinterState();
    }
    async getRecruitRank(provider: ContractProvider, owner: Address) {
        return this.card(provider, owner).getRecruitRank();
    }
    async getNewcomerWindow(provider: ContractProvider, owner: Address) {
        return this.card(provider, owner).getNewcomerWindow();
    }
    /** This era's count: the card's tally if it was taken under the ledger's `eraSeq`, else 0. */
    async getEraRecruits(provider: ContractProvider, owner: Address) {
        const [{ eraSeq }, tally] = await Promise.all([
            this.getEraLeader(provider),
            this.card(provider, owner).getEraRecruits(),
        ]);
        return tally.eraSeq === eraSeq ? tally.eraRecruits : 0;
    }
    async getUpliftLine(provider: ContractProvider, n: bigint, owner: Address) {
        const line = await this.card(provider, owner).getUpliftLine();
        const { clamped } = await this.getKMaxForSum(provider, n, line.summed);
        return { ...line, clamped };
    }
    async getKMaxFor(provider: ContractProvider, n: bigint, owner: Address) {
        const line = await this.card(provider, owner).getUpliftLine();
        return (await this.getKMaxForSum(provider, n, line.summed)).kmax;
    }

    async isKnownPrime(provider: ContractProvider, n: bigint) {
        return (await provider.get('isKnownPrime', [{ type: 'int', value: n }])).stack.readNumber();
    }
    async getItemAddress(provider: ContractProvider, n: bigint) {
        return (await provider.get('getItemAddress', [{ type: 'int', value: n }])).stack.readAddress();
    }
}
