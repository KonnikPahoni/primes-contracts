/**
 * TON PRIMES — genesis deploy pipeline (IMPLEMENTATION_PLAN.md §3 build step 6,
 * CONCEPT.md §6).
 *
 * This module is the single source of truth for the genesis sequence. It is
 * deliberately environment-agnostic: it talks to an injected `GenesisEnv`
 * (open-a-contract + a Sender + a clock) rather than to @ton/sandbox or to a
 * live network directly, so the SAME code path runs in:
 *
 *   - the sandbox rehearsal (contracts/tests/GenesisRehearsal.spec.ts), and
 *   - a real testnet/mainnet deploy (contracts/scripts/deployGenesis.ts, driven
 *     by `blueprint run`, which supplies network + keys — Phase 5).
 *
 * Nothing in here hardcodes a network, a mnemonic, or a key file.
 *
 * D-100 ADDS THREE CONTRACTS AND ONE ORDERING CONSTRAINT. The LP SINK is
 * deployed before the GOVERNED TREASURY (the treasury's init data names it, and
 * there is deliberately no setter — a re-pointable sink address would be a path
 * that moves LP nobody voted for), and the treasury before the LEDGER (the
 * ledger's `ConfigA.feeDests` names the treasury CONTRACT for §4.1's 5% line
 * and the 58% forfeit share, and the operator WALLET for the 42% remainder, D-166). `primes_lp_position.tolk`
 * is compiled but never deployed here: its code cell is ADDRESS-DETERMINING for
 * the treasury, so recompiling the child moves the parent. The vest is ONE
 * instance of the unmodified `primes_vesting.tolk`, 1,000,000 PRIMES to the
 * treasury, whose beneficiary is a contract with no key (D-100 point 6; D-166
 * deleted the operator's instance).
 *
 * ORDER (CONCEPT §6, plus the venue-timelock queue step):
 *   1. deploy collection, jetton master, LP SINK, STAKE MASTER, TREASURY,
 *      venue timelock (D-194: its governance key is the treasury), ledger,
 *      ratchet, registrar, MARKET, bounty vault
 *      (the deploy order is forced by which address must be known to whom — see
 *      the circular-address deviations D7/D11/D12/D17/D21). P2.A7/D-3 merged
 *      three market contracts into one, and D-20/D-90 deleted the genesis
 *      auction and the reservation book outright. D-168: the stake master precedes
 *      the treasury because the treasury's init data names it (`distribute()`'s
 *      recipient); the master learns the treasury by its one-shot `set_wallet`.
 *      (D-212 deleted the burn sink that used to come last.)
 *   2. one-shot bootstrap wiring: SetLedger x2 (collection, jetton master) +
 *      SetRatchet (timelock), SetPeers, plus §3.4's SetLedger x2
 *      (ratchet, registrar), SetSinks (ledger) and SetCollection (registrar ->
 *      the collection a trophy re-engraving's fee goes through, D-212).
 *      `SetTrophyAuction` is DELETED with the book<->auction
 *      circular dependency it resolved.
 *   3. (D-20: no lot-seeding step. There is no genesis lot set — every prime
 *      opens the same permissionless Dutch buy-now lot once the head passes it.)
 *   4. the treasury's vested PRIMES allocation, genesis mint only (D-46, D-166)
 *   5. bounty vault genesis mint + SetWallet, then the D21-family SetWallet on
 *      the ratchet and the stake master. The stake master is NOT FUNDED here:
 *      it is custody and starts empty (its budget arrives by the treasury's
 *      `distribute()`).
 *   6. seal jetton authority          <- irreversible
 *   7. seed T, S and the head at OPENING_HEAD (GenesisSeed; D-20 deleted the auction set K). This does
 *      NOT open minting: `T = 0` here, and `ignite` refuses to launch until
 *      the floor is backed (D-93, error 218).
 *   8. queue the venue timelock with the DeDust vault/pool addresses
 *
 * WHAT RUNS AFTER THIS SCRIPT, AND IN THIS ORDER (D-93). The launch is
 * **seed -> donate -> ignite**, and the middle step is not this script's:
 *
 *   a. `scripts/donateFloor.ts` — D-204's **200 GRAM** `donate_floor`
 *      (D-92's 240 was re-set by the owner, not re-derived), which is what
 *      creates the floor at all. Permissionless, asserts no launch flag, and
 *      incremental, so a testnet rehearsal may send tranches or a smaller sum.
 *      DO NOT CONFUSE IT WITH `genesis.genesis_seed_ton` (200): that figure
 *      sizes `S₀` and never moves; see `GenesisParams.seedTon`.
 *   a'. the operator pairs the donation's 1,972,333 PRIMES against **~21.24 GRAM**
 *      on DeDust BY HAND, and sends the receipt to the LP SINK (D-154 closes
 *      D-100 point 4's choice for the genesis pair: opening depth is locked
 *      depth). D-140: the GRAM side is `PRIMES × p_f`, so the book opens AT the
 *      floor; quoting it at `L` is what opened it 286× above. D-166 took the
 *      operator's 250,000-PRIMES vest tranche out of the pair along with the
 *      operator's lock. No contract builds that deposit (D-100 R1-2 — no verified
 *      wire format). `pairingInstructions()` prints the runbook.
 *   b. `scripts/ignite.ts --skew-safe` — Unity, and the launch flag.
 *
 * The order is enforced on chain and not merely documented here, because the
 * rebate is `R = k*I*S/T` (math-note §2): against `T = 0` the mint after the
 * first one emits ~20% of the genesis supply for 1 GRAM, where the same mint
 * after the donation emits 0.28%. See `tests/UnbackedFloorLaunch.spec.ts`.
 *
 * D-46 SUPERSEDES D-19 AND THE FOUNDER-SEEDED-LP SHAPE OF THIS PIPELINE. There
 * is no deploy-time DeDust deposit and no LP burn here any more: no GRAM leaves
 * the genesis wallet as pool backing. (D-46 gave the operator a disclosed
 * genesis mint to pair by hand; D-77 vested it, D-100 point 6 halved it and
 * D-166 deleted the operator's half: the operator's pairing inventory is now the
 * PRIMES its own floor donation mints, and DeDust liquidity provision stays
 * open to anyone with no PRIMES-repo contract mediating it.) `T` is seeded at 0
 * (`seedT = 0`; the field survives on the ledger for a possible future founder
 * seed, see CONCEPT.md §5) and is opened by the donation above, after which it
 * grows on real mint injections. The
 * ratchet's `flush()` needs no new gating for "no pool yet": a swap against an
 * empty/nonexistent pool simply fails to fill and bounces through the SAME
 * path that already restores `pending` when the venue can't meet the floor
 * guard (primes_ratchet.tolk `onBouncedMessage`).
 */
import { minterCardCode } from '../../shared/minterCard';
import { lotBlockCode } from '../../shared/lotBlock';
import { Address, beginCell, Cell, Contract, Dictionary, OpenedContract, Sender, toNano } from '@ton/core';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection, snakeCell } from '../wrappers/PrimesCollection';
import { PrimesItem } from '../wrappers/PrimesItem';
import { PrimesJettonMaster, offchainContentCell, decodeOffchainContent } from '../wrappers/PrimesJettonMaster';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import {
    PrimesBountyVault,
    EraBounty,
    RebateScheduleEntry,
} from '../wrappers/PrimesBountyVault';
import {
    PROGRAM_TAG_PRIME_QUESTS,
    PROGRAM_TAG_QUESTS,
    PROGRAM_TAG_SECURITY,
} from '../../shared/opcodes';
import { VOUCHER_MAX_PER_WALLET } from '../../shared/voucher';
import { PrimesVoucher } from '../wrappers/PrimesVoucher';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { PrimesStake } from '../wrappers/PrimesStake';
import { PrimesVesting } from '../wrappers/PrimesVesting';
import { PrimesTreasury } from '../wrappers/PrimesTreasury';
import { PrimesLpSink } from '../wrappers/PrimesLpSink';

/**
 * P2.A7 — `npvTableToCell` came from `PrimesTrophyAuction`, which no longer
 * exists. The market takes the ladder as a `Dictionary` rather than a `Cell`
 * (its `MarketConfig` stores it inline as `map<uint64, coins>`), so the encoder
 * moves here rather than being deleted with its old home.
 *
 * GRAM `coins` is `VarUInteger 16` — a 4-bit byte-length prefix — which is what
 * `BigVarUint(4)` encodes. Getting this wrong does not fail loudly: the dict
 * builds, the deploy succeeds, and every lookup simply misses, so every prime
 * would quietly open at the ladder fallback instead of its NPV.
 */
function npvTableToDict(
    table: Record<string, string | number> | null | undefined
): Dictionary<bigint, bigint> | undefined {
    if (!table) return undefined;
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.BigVarUint(4));
    for (const [prime, ton] of Object.entries(table)) {
        // `.toFixed(9)` is not cosmetic. The sim emits `NPV(p)` as a full-precision
        // double — 869.0531779691883 — and `toNano` REFUSES more than nine decimals
        // with a bare "Invalid number", so the raw table from `shared/params.json`
        // cannot be passed through as-is. Nine decimals is exactly the nanoGRAM
        // resolution the value is about to be stored at, so the round is lossless
        // at the destination and the truncation is not a judgement call.
        dict.set(BigInt(prime), toNano(Number(ton).toFixed(9)));
    }
    return dict;
}

export const TIMELOCK_DELAY = 2592000; // 30 days, primes_venue_timelock.tolk

export type GenesisCode = {
    item: Cell;
    collection: Cell;
    jettonWallet: Cell;
    jettonMaster: Cell;
    ledger: Cell;
    ratchet: Cell;
    registrar: Cell;
    venueTimelock: Cell;
    /**
     * P2.A7 — ONE market where there were four contracts. `primes_market.tolk`
     * holds both lot modes (ascending ahead of the head, descending prime lots);
     * D-20 deleted the genesis auction and D-90 the reservation book and escrow.
     */
    market: Cell;
    bountyVault: Cell;
    /** G76 / §9.5 — `primes_voucher.tolk`, the signed-voucher program the vault's `quests` track pays through. */
    voucher: Cell;
    /** D-191 point 2 (V26.3) — `primes_claim_receipt.tolk`, the voucher's per-claimant
     *  child. ADDRESS-DETERMINING for every voucher instance (it is in their init data). */
    claimReceipt: Cell;
    /** D-191 point 1 (V26.4) — `primes_minter_card.tolk`, the ledger's per-wallet child.
     *  ADDRESS-DETERMINING for every card, and every client derives a card from
     *  `shared/minterCard.ts`'s copy of it, so the pipeline refuses a mismatch. */
    minterCard: Cell;
    /** D-196 — `primes_lot_block.tolk`, the ledger's per-block child for auction marks
     *  beyond its import frontier. ADDRESS-DETERMINING for every lot block; the wrappers
     *  derive it from `shared/lotBlock.ts`'s copy, so the pipeline refuses a mismatch. */
    lotBlock: Cell;
    /**
     * D-168 — the STAKE MASTER (`primes_stake.tolk`, §5.3): PRIMES locked for a
     * term, paid from the treasury's `distribute()` budget. Its address depends on
     * `stakePosition` below (the child code is in its init data), and the
     * treasury's depends on it (`distribute()`'s recipient is deploy data), so it
     * is deployed BEFORE the treasury.
     */
    stake: Cell;
    /**
     * D-168 — `primes_stake_position.tolk`, one child per staking wallet. NEVER
     * DEPLOYED HERE: the master deploys it lazily on a wallet's first stake. It is
     * ADDRESS-DETERMINING for the master.
     */
    stakePosition: Cell;
    /**
     * D-77 — the VESTING LOCK (`primes_vesting.tolk`). Since D-166 genesis deploys
     * ONE instance, beneficiary = the governed treasury contract, holding its
     * 1,000,000-PRIMES allocation over four tranches. The operator's instance
     * (D-100 point 6) is deleted. Beneficiary and total are init data, so the
     * bytecode is the same as ever.
     */
    vesting: Cell;
    /**
     * D-100 points 4/7 — the GOVERNED TREASURY (`primes_treasury.tolk`).
     *
     * Its address depends on `lpPosition` below (the child code is in its init
     * data) and on the LP sink's address, so the compile and deploy order is
     * forced: position code first, LP sink deployed second, treasury third.
     */
    treasury: Cell;
    /**
     * D-100 point 4 — `primes_lp_position.tolk`, one child per depositor wallet.
     * NEVER DEPLOYED HERE: it is deployed lazily by the treasury on a wallet's
     * first LP deposit. It is in this list because it is ADDRESS-DETERMINING for
     * the treasury — recompiling the child moves the parent.
     */
    lpPosition: Cell;
    /**
     * D-100 point 4 — `primes_lp_sink.tolk`. LP in, nothing out, no outbound
     * message type at all. Deployed BEFORE the treasury, because the treasury's
     * init data names it and there is no bootstrap message that could set it
     * afterwards.
     */
    lpSink: Cell;
};

export type GenesisParams = {
    /** genesis.era_bounty_schedule */
    eraSchedule: EraBounty[];
    /**
     * D-99 §1.5 — the vault's two-entry rebate schedule, from
     * `genesis.score_rebate.rates`. Kind 0 is PER POINT of D(n) and kind 1 is
     * flat; the vault multiplies.
     *
     * THIS USED TO SHIP EMPTY, and that was the bug. No deploy script has ever
     * passed the vault a rebate (or, before D-99, a tier) schedule, so the
     * ledger's rebate leg has always cheap-failed on an unrecognised key and the
     * program has been inert on every genesis this repo has produced — silently,
     * because cheap-failing is exactly what it is meant to do when a kind is
     * unfunded, and a mint that pays no rebate looks identical to a mint whose
     * number earned none. The vault is the authority on the GRAM value (D22), so
     * an unfunded vault is a program that does not exist.
     */
    rebateSchedule: RebateScheduleEntry[];
    /** genesis.bounty_vault_size_primes (nanoPRIMES) */
    bountyVaultPrimes: bigint;
    /**
     * G76 / CONCEPT §9.5 — the 32-byte Ed25519 PUBLIC key the QSTS voucher is deployed
     * with. Its secret half is `QUESTS_VOUCHER_SIGNER_SECRET_KEY`, which only the attribution
     * service holds. Address-determining and write-once: rotating it is a redeploy.
     */
    questsSignerPubkey: Buffer;
    /**
     * Audit 2026-11-19 R2-M2 (D-171 amended 2026-11-20) — the PQST voucher's own PUBLIC key.
     * Its secret half is `PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY`. One key per track, so one
     * leaked key reaches one track's `remaining`, never both.
     */
    primeQuestsSignerPubkey: Buffer;
    /**
     * G76 — the voucher program's allow-list cap, in nanoPRIMES: params.json
     * `genesis.era_bounty_schedule.remaining_vault_split.tracks.quests.primes`. The VAULT
     * enforces it; the voucher contract holds no budget of its own.
     */
    questsPrimes: bigint;
    /**
     * D-170 — the security prize's signing PUBLIC key. Its secret half is held offline by
     * the owner, never by a service. Must differ from both service keys.
     */
    securitySignerPubkey: Buffer;
    /** D-170 — `remaining_vault_split.tracks.security_bounty.primes`, in nanoPRIMES. */
    securityBountyPrimes: bigint;
    /**
     * G78 / D-171 — `remaining_vault_split.tracks.prime_quests.primes`, in nanoPRIMES: the cap on
     * the third voucher instance, which pays §9.4's contract-fact quests on its own key.
     */
    primeQuestsPrimes: bigint;
    /** genesis.genesis_lp_ratio_primes_per_ton — used only to size the
     * treasury's vested allocation and the bounty vault (D-46, D-166); no LP is
     * deposited. */
    lpPrimesPerTon: number;
    /**
     * D-46 (supersedes CONCEPT §6 point 3's old founder-seed reading): `T₀` is
     * now a NOMINAL supply-sizing input only, in nanoGRAM — it is never
     * deposited anywhere. `treasuryVestPrimes = T0 * lpPrimesPerTon / 2` is the
     * vested genesis mint (D-166: the treasury's D-100 point 6 half, the
     * operator's half deleted), and the vault stays `T0 * lpPrimesPerTon * 5`,
     * so `S₀ = 11,000,000` with no real GRAM behind it at deploy. `genesis.genesis_seed_ton` in
     * shared/params.json.
     *
     * D-100 point 2 SPLIT THIS FIELD'S OLD JOB IN TWO, and it is the one thing
     * to get right in this type. Until D-100 the nominal seed and the genesis
     * donation were the same number by construction (D-92 chose the donation to
     * reproduce `seed/S₀`), so a script could read either and be right. They are
     * now 200 and 132.50: `seedTon` sizes `S₀` and NO GRAM EVER MOVES FOR IT, while
     * `donationTon` below is the GRAM that actually lands in `T`, through the
     * separate permissionless `donate_floor` step. Nothing in this pipeline may
     * send `seedTon` anywhere.
     */
    seedTon: bigint;
    /**
     * D-154 — `genesis.genesis_donation_ton` (132.50), OWNER-SET, in GRAM.
     *
     * Not sent by `runGenesis`: the donation is `donateGenesisFloor`, its own
     * step, and on a live deploy its own script (D-93's seed → donate → ignite).
     * It is threaded here so the pairing instructions this pipeline prints quote
     * the figure the deployment is actually sized around rather than a number
     * somebody typed into a runbook.
     */
    donationTon: number;
    /**
     * D-140 — `genesis.genesis_floor_price_ton_per_primes` (3.5e-7), the floor
     * the genesis donation buys, in GRAM per PRIMES.
     *
     * Threaded for exactly one reason: the pairing instructions this pipeline
     * prints quote the GRAM side of the DeDust pair as `PRIMES × p_f`, and that
     * multiplier is a sim-derived figure (CLAUDE.md rule 3), not something a
     * script may re-derive from `seedTon` and the vault multiplier — which is
     * exactly the coincidence D-100 point 2 broke.
     */
    genesisFloorPriceTonPerPrimes: number;
    /**
     * `genesis.genesis_donation_primes` — what `donate_floor` mints to the donor
     * (`X·L`, D-156-tapered), which is the pair's whole PRIMES side. Sim-derived,
     * threaded for the same reason as the floor above.
     */
    donationPrimes: number;
    /**
     * D-20 — `NPV(p)` for every prime, keyed by prime, in GRAM.
     * `shared/params.json` `trophy_auction.npv_ladder.npv_ton_by_prime`, emitted
     * by the sim.
     *
     * OPTIONAL, and the default is honest rather than convenient: with no table
     * every prime opens at `max(ladder, PRIME_P0_MIN)`, which is D3's declared
     * ladder fallback, not a silent zero. It lands in the auction's
     * ADDRESS-DETERMINING init data and no message can change it — D3 ships a
     * table so the closed form can replace it later without a wire change, and
     * "later" means a fresh deploy, never a setter.
     */
    trophyNpv?: Record<string, string | number> | null;
    /**
     * `minAuctionDistance` is DELETED (D-45). `MarketConfig` no longer has a
     * liveness-gate field — see `PrimesMarket.ts`'s D-45 note and
     * `primes_market.tolk`'s file header.
     */
    /**
     * THE OPERATOR'S OWN WALLET, and after D-100 point 6 that is all it is.
     *
     * It was called `treasuryAddr` until D-100, when the name stopped being
     * true in two directions at once: the *treasury* became a contract this
     * pipeline deploys (so a caller cannot supply its address), and this wallet
     * became a fee destination in its own right. D-152 has since narrowed what
     * it is paid — the 42% remainder of every unsold-prime forfeit (D-166), and nothing
     * unconditional — because §4.1's 5% line went back to the governed pot. The
     * rename is still the point: an env var called `PRIMES_TREASURY_ADDR` would
     * now read as "the governed pot" and would silently point the operator's
     * income at a wallet somebody chose for a different reason.
     *
     * Three things read it: `ConfigA.operatorAddr` on the ledger, the treasury's
     * own recorded `operatorAddr` (which confers no authority — see
     * `primes_treasury.tolk`), and §3.1's TEP-66 secondary royalty destination,
     * which D-100 does not move and which therefore stays exactly where it was.
     */
    operatorAddr: Address;
    proposerAddr: Address;
    /**
     * `shared/params.json` `staking.distribution_rate_bps_per_day` (19), the
     * sim-selected rate of the treasury's `distribute()` (D-168). Threaded rather
     * than read from the file here for CLAUDE.md rule 3's reason: it lands in the
     * treasury's ADDRESS-DETERMINING init data and no message can change it, so
     * the call site that chose it has to be visible in the diff.
     */
    distributionRateBpsPerDay: number;
    /**
     * D-212 (§4.7.1) — the naming fees, nanoGRAM. `nameFee` is the first naming of a
     * number (owner: ~50 EUR at the genesis-day GRAM/EUR rate, so it is a genesis INPUT,
     * never a constant); `renameFee` every later one and every paid trophy re-engraving
     * (owner: 200 GRAM, `shared/params.json` `naming.rename_fee_ton`). Deploy data on the
     * collection (both) and the registrar (`renameFee`), no setter.
     */
    nameFee: bigint;
    renameFee: bigint;
    /**
     * D-139 — THE TEST CLOCK. One divisor over every wall-clock constant the set
     * enforces: the market's `AUCTION_WINDOW`/`BID_EXTENSION`/
     * `PRIME_DUTCH_SECONDS`, the ratchet's `FLUSH_COOLDOWN` and the treasury's
     * `NOTICE_DURATION` and `VOTE_DURATION`. **1 IS MAINNET AND THE IDENTITY** —
     * omit it and the set behaves exactly as it did before the field existed. 168
     * turns a 7-day auction into 1 hour, a 1-day flush cooldown into ~8.5 minutes
     * and a proposal's 1-day notice and 1-day vote into ~8.5 minutes each, which is what makes an unattended full-protocol
     * testnet run finish in an afternoon instead of nine days.
     *
     * It lands in ADDRESS-DETERMINING init data on all three contracts and no
     * message can change it, so — like `distributionRateBpsPerDay` above — the call
     * site that chose it is visible in the diff. Deploy scripts read it from
     * `PRIMES_AUCTION_SECONDS` (default 604800 = divisor 1).
     */
    clockDivisor?: number;
    /**
     * D-153 — the same deploy-time scaling on the VALUE axis, and it reaches
     * ONE contract (the ratchet) rather than five. `STAKE_MIN` is 50 GRAM and
     * the liquid reserve is 20% of the obligation, so §4.3.2's `stake` is
     * illegal until `pending` exceeds 62.5 GRAM — reachable on mainnet in the
     * ordinary course of the game and reachable on testnet only by burning
     * ~600 unrecoverable GRAM into `donate_floor`. 1 is mainnet and the
     * identity; deploy scripts read it from `PRIMES_STAKE_MIN_TON` (default
     * 500 = divisor 1) and `getStakeMin()` publishes the divided figure.
     */
    stakeDivisor?: number;
    /**
     * DeDust venue (real addresses on testnet/mainnet; stand-ins in
     * rehearsal). D-46: deterministic addresses baked into the ratchet's
     * deploy-time storage and queued on the venue timelock as before — this
     * works whether or not anyone has actually added liquidity to the pool
     * yet, since DeDust pool/vault addresses are computable ahead of deposit.
     */
    dedustNativeVault: Address;
    dedustPool: Address;
    primesJettonVault: Address;
    /**
     * §4.3.2 / D-151 — THE STAKED RESERVE'S VENUE, and the two tsTON jetton
     * wallets that go with it. Same D-46 shape as the DeDust block above: the
     * three venue addresses are baked into the ratchet's deploy-time storage AND
     * queued on the venue timelock, and the two wallets are one-shot bootstraps
     * in `completeGenesis`.
     *
     * ALL FIVE ARE INPUTS, and that is the one structural difference from every
     * other jetton wallet this pipeline wires: the tsTON master is TONSTAKERS',
     * not ours, so nothing here can answer `getWalletAddress(owner)` for it the
     * way `d.master` does for PRIMES. On testnet they all point at the mock pool
     * (`deployGenesis.ts`'s `resolveStakingVenue`), which collapses the pool, the
     * tsTON minter, both tsTON wallets and DeDust's tsTON/native vaults into one
     * account; on mainnet they are Tonstakers' and DeDust's real addresses.
     *
     * REQUIRED, deliberately — see `validateStakingVenue`, which is the rest of
     * that argument.
     */
    tonstakersPool: Address;
    dedustTstonVault: Address;
    dedustTstonPool: Address;
    /** The RATCHET's own tsTON wallet — `SetTstonWallet`, one-shot. */
    ratchetTstonWallet: Address;
    /** The TREASURY's own tsTON wallet — the third leg of `SetWallets`. */
    treasuryTstonWallet: Address;
    /**
     * TEP-64 / TEP-66 presentation (CONCEPT §3.1). REQUIRED — deliberately not optional.
     *
     * Every field here lands in a contract's INIT DATA, which is part of the address
     * preimage, and neither the collection nor the master accepts any message that could
     * change it afterwards (§8 forbids the admin lever that would make one possible). So
     * these are not cosmetic defaults to be filled in later: a genesis that omits them
     * ships a permanently nameless collection and a permanently unnamed jetton, and the
     * only repair is redeploying the entire set at fresh addresses — the same
     * unrecoverable class as the one-shot bootstrap links the preflight in
     * deployGenesis.ts already refuses to risk.
     *
     * They are typed as required because that is the actual fix. The wrapper-level
     * defaults (`?? beginCell().endCell()`) exist so the unit suites can construct a bare
     * collection or master, and an earlier version of this pipeline simply never passed
     * anything — every contract-side field, get-method and helper was in place, and the
     * deploy path quietly took the empty default for all of them. Optional-with-a-default
     * is what let that happen silently; the type is what stops it happening again.
     */
    presentation: GenesisPresentation;
};

export type GenesisPresentation = {
    /** TEP-64 doc for the collection itself; returned by `get_collection_data`. */
    collectionMetadataUri: string;
    /**
     * Base URI that `get_nft_content` completes with `<n>.json` (primes_collection.tolk).
     * MUST end in `/` — the contract concatenates without a separator, so a prefix of
     * `…/nft` yields `…/nft1234.json`.
     */
    nftContentPrefix: string;
    /** TEP-64 doc for the PRIMES jetton; returned by `get_jetton_data`. */
    jettonMetadataUri: string;
    /**
     * CONCEPT §3.1's 5% secondary royalty, from `params.fees.royalty_numerator` /
     * `royalty_denominator`. Threaded rather than defaulted for the reason in CLAUDE.md's
     * rule 3: a rate hardcoded in a wrapper is not traceable to the sim or the concept.
     */
    royaltyNum: number;
    royaltyDen: number;
};

/**
 * A single-cell TEP-64 URI is a 0x01 tag byte plus the string, and a cell holds 1023
 * bits — so 126 bytes of URI. `nftContentPrefix` is bounded the same way: the cell
 * `get_nft_content` builds is tag + prefix + a ref for the suffix.
 *
 * Enforced here rather than left to @ton/core, which throws a bare "Bit overflow" from
 * inside `storeBuffer` at deploy time — after the collection above it is already on chain.
 */
export const MAX_URI_BYTES = 126;

/**
 * Fail on a malformed presentation BEFORE anything is deployed. Everything checked here
 * is unfixable once written: see GenesisParams.presentation.
 */
export function validatePresentation(p: GenesisPresentation): void {
    const uris: [string, string][] = [
        ['collectionMetadataUri', p.collectionMetadataUri],
        ['nftContentPrefix', p.nftContentPrefix],
        ['jettonMetadataUri', p.jettonMetadataUri],
    ];
    for (const [name, uri] of uris) {
        if (!uri) {
            throw new Error(
                `genesis: presentation.${name} is empty. It is baked into immutable init data; ` +
                    'a blank one is a permanently nameless deploy, not a TODO.'
            );
        }
        // https only: wallets and marketplaces decline to fetch metadata over plaintext,
        // so an http:// URI is a deploy that renders as unnamed for a different reason.
        if (!uri.startsWith('https://')) {
            throw new Error(`genesis: presentation.${name} must be an https:// URI, got "${uri}"`);
        }
        const bytes = Buffer.byteLength(uri, 'utf8');
        if (bytes > MAX_URI_BYTES) {
            throw new Error(
                `genesis: presentation.${name} is ${bytes} bytes; the single-cell TEP-64 limit ` +
                    `is ${MAX_URI_BYTES}. Shorten the path or serve it from a shorter host.`
            );
        }
    }
    // The item prefix: the collection concatenates its key onto it with NO separator, so a
    // missing slash is a silent `…/nft1234.json` bug, unfixable after deploy.
    const prefixes: [string, string][] = [['nftContentPrefix', p.nftContentPrefix]];
    for (const [name, prefix] of prefixes) {
        if (!prefix.endsWith('/')) {
            throw new Error(
                `genesis: presentation.${name} must end in "/", got "${prefix}". ` +
                    `The collection concatenates the key directly, so this would mint ` +
                    `"${prefix}1234.json".`
            );
        }
    }
    if (!(p.royaltyDen > 0) || !(p.royaltyNum >= 0) || p.royaltyNum > p.royaltyDen) {
        throw new Error(
            `genesis: presentation royalty ${p.royaltyNum}/${p.royaltyDen} is not a fraction in [0,1] ` +
                '(CONCEPT §3.1 specifies 5%).'
        );
    }
}

/**
 * §4.3.2 / D-151 — REFUSE A SILENTLY INERT STAKED RESERVE.
 *
 * Every other bootstrap in this pipeline fails loudly when it is wrong: an
 * unset wallet leaves `walletsSet == 0` and the next message is refused, which
 * somebody notices the same afternoon. The tsTON pair does not have that
 * property, and both halves of it default to something that PARSES:
 *
 *   - `PrimesTreasury.sendSetWallets` writes the TREASURY'S OWN ADDRESS when
 *     `tstonJettonWallet` is omitted (the wrapper's harness default), so
 *     `SetWallets` succeeds, `walletsSet` flips to 1, the one-shot closes behind
 *     itself, and the tsTON arm is unreachable forever.
 *   - `PrimesRatchet`'s venue and `SetTstonWallet` default to the GENESIS SCRIPT
 *     ADDRESS — a throwaway deploy key — which is a well-formed address that
 *     nothing will ever send tsTON from or to.
 *
 * Neither failure is visible at genesis. It surfaces months later as a
 * `harvest()` that does nothing, or a `stake()` that deposits GRAM into a dead
 * account, and genesis is a ONE-SHOT: the venue addresses are init data and both
 * wallet messages close behind themselves, so the only repair is a fresh
 * deployment at fresh addresses. So this runs before anything is sent, and it
 * checks the two things a typo actually produces — a placeholder that survived,
 * and the receiving contract's own address — rather than merely "not undefined".
 *
 * It is NOT a check that the addresses are Tonstakers' real ones; nothing
 * offline can be. It is the check that they are not this pipeline's own
 * furniture.
 *
 * `ratchetAddr`/`treasuryAddr` are OPTIONAL because of when each half can run.
 * Everything else — present, basechain, non-zero, not the genesis placeholder —
 * needs nothing but `params`, so it runs beside `validatePresentation` BEFORE the
 * first `sendDeploy`, where a mistake costs an error message instead of seven GRAM
 * and a half-wired set. The two "not the receiving contract itself" exclusions
 * cannot: those addresses do not exist until their contracts are constructed. So
 * this is called twice, and the second call is still before any staking message.
 */
export function validateStakingVenue(
    params: GenesisParams,
    receivers: { genesisAddr: Address; ratchetAddr?: Address; treasuryAddr?: Address }
): void {
    const ZERO = Buffer.alloc(32);
    const fields: [string, Address, [string, Address][]][] = [
        ['tonstakersPool', params.tonstakersPool, []],
        ['dedustTstonVault', params.dedustTstonVault, []],
        ['dedustTstonPool', params.dedustTstonPool, []],
        // The receiving contract's own address: a jetton wallet is never its own
        // owner, so this pair of exclusions is exactly the wrapper defaults.
        [
            'ratchetTstonWallet',
            params.ratchetTstonWallet,
            receivers.ratchetAddr ? [['the ratchet itself', receivers.ratchetAddr]] : [],
        ],
        [
            'treasuryTstonWallet',
            params.treasuryTstonWallet,
            receivers.treasuryAddr ? [['the treasury itself', receivers.treasuryAddr]] : [],
        ],
    ];
    for (const [name, addr, extra] of fields) {
        if (!addr || !Address.isAddress(addr)) {
            throw new Error(
                `genesis: params.${name} is missing. §4.3.2's staked reserve is wired by init data and ` +
                    'two one-shot messages, none of which can be re-sent — an omitted address is a ' +
                    'permanently dead tsTON arm, not a TODO.'
            );
        }
        if (addr.workChain !== 0) {
            throw new Error(
                `genesis: params.${name} is on workchain ${addr.workChain}. Every contract in this ` +
                    'set lives on the basechain (CLAUDE.md "Measured provenance": masterchain rent is ' +
                    '4,200x), and a cross-workchain venue address is a typo, not a deployment.'
            );
        }
        if (addr.hash.equals(ZERO)) {
            throw new Error(`genesis: params.${name} is the zero address.`);
        }
        for (const [why, forbidden] of [...extra, ['the genesis script placeholder', receivers.genesisAddr] as const]) {
            if (addr.equals(forbidden as Address)) {
                throw new Error(
                    `genesis: params.${name} is ${why} (${addr.toString()}). That is the value the ` +
                        'wrapper writes when nobody supplies one, and it PARSES — the bootstrap would ' +
                        'succeed, close behind itself, and leave the tsTON arm unreachable forever. ' +
                        'Supply the real address (mainnet: Tonstakers/DeDust; testnet: the mock pool ' +
                        "`deployGenesis.ts`'s `resolveStakingVenue` deploys)."
                );
            }
        }
    }
}

export type GenesisEnv = {
    open<T extends Contract>(contract: T): OpenedContract<T>;
    /** the genesis-script credential: every one-shot bootstrap message comes from here */
    genesisSender: Sender;
    genesisAddress: Address;
    /** the venue-timelock proposer key (step 8). May be the same wallet. */
    proposerSender: Sender;
    now(): number;
    /** balance of the genesis script wallet, used to size the LP leg */
    genesisBalance(): Promise<bigint>;
    /**
     * D-100 point 4 — the DeDust **LP jetton wallet** of `owner`.
     *
     * Both new contracts need one: the treasury has to recognise LP arriving
     * (`set_wallets`) and the sink has to refuse LP that did not come from its
     * own wallet (`set_wallet`, error 1170). Neither address is derivable from
     * anything in this repo — the LP jetton's master is the DeDust pool, whose
     * `get_wallet_address` is the only authority on it — so it is an environment
     * capability rather than a `GenesisParams` field. A live runner implements it
     * with a get-call against `params.dedustPool`; the sandbox rehearsal supplies
     * a stand-in, exactly as it does for the pool address itself.
     *
     * ORDERING CONSEQUENCE FOR A REAL DEPLOY: the DeDust PRIMES/GRAM pool must
     * exist before genesis runs, because an undeployed pool answers no
     * get-method. That is a step in `docs/testnet-deployment.md`, not a fallback
     * this pipeline may invent — a wrong LP wallet is init data on the sink and
     * a one-shot bootstrap on the treasury.
     */
    lpWalletFor(owner: Address): Promise<Address>;
    /** hook so a live deploy can wait for confirmations between steps */
    settle?(step: string): Promise<void>;
    log?(message: string): void;
};

/**
 * TESTNET STAND-IN for `GenesisEnv.lpWalletFor` — opt-in via
 * `PRIMES_DEDUST_LP_STANDIN=1`, and the live deploy scripts refuse it on any
 * endpoint that is not testnet.
 *
 * WHY IT EXISTS. Every testnet genesis in `docs/testnet-deployment.md` has used
 * throwaway wallets for the three DeDust addresses — no real pool has ever
 * existed on testnet, and `flush()` bouncing against a stand-in vault is the
 * documented, expected outcome (D6). D-100 point 4 then made step 25b call
 * `get_wallet_address` on that pool, which a bare wallet cannot answer, so a
 * genesis run at HEAD aborted after ~24 contracts were already on chain. It is
 * also circular on ANY network: a real DeDust pool is keyed on the PRIMES
 * jetton master, and this pipeline is what deploys the master (GAUNTLET.md R17).
 *
 * WHAT IT RETURNS. A deterministic basechain address that is the hash of a tag
 * and the owner — an account nothing can ever send from, so with it baked into
 * the LP sink's `set_wallet` and the treasury's `set_wallets` every LP
 * notification is refused (1170 / 1151), which is exactly the truth on a
 * testnet with no LP jetton. It is NOT a wallet of the PRIMES master or of any
 * other jetton this repo deploys: the treasury branches on its PRIMES wallet
 * first, so aliasing the two would turn LP deposits into PRIMES credits.
 *
 * Both `completeGenesisQueue`'s read-back and `GenesisRehearsal.spec.ts` compare
 * the bootstrapped address to `lpWalletFor` again, and this derivation is pure,
 * so the comparison still holds.
 */
export function standInLpWalletFor(owner: Address): Address {
    const hash = beginCell()
        .storeUint(0x4c505354, 32) // "LPST"
        .storeAddress(owner)
        .endCell()
        .hash();
    return new Address(0, hash);
}

export type GenesisDeployment = {
    collection: OpenedContract<PrimesCollection>;
    master: OpenedContract<PrimesJettonMaster>;
    timelock: OpenedContract<PrimesVenueTimelock>;
    ledger: OpenedContract<PrimesLedger>;
    ratchet: OpenedContract<PrimesRatchet>;
    registrar: OpenedContract<PrimesRegistrar>;
    /**
     * P2.A7 — replaces `book`, `auction` and `trophyAuction`, which were three
     * views of one market that had to be deployed in a fixed order and then
     * wired to each other in a circle.
     */
    market: OpenedContract<PrimesMarket>;
    vault: OpenedContract<PrimesBountyVault>;
    /** G76 / §9.5 — the voucher program, the vault's second allow-listed payer. */
    voucher: OpenedContract<PrimesVoucher>;
    /** D-170 — the security prize, a second voucher instance with its own key and tag. */
    securityVoucher: OpenedContract<PrimesVoucher>;
    /** G78 / D-171 — the prime-quests voucher, tagged PQST, on its own key since R2-M2. */
    primeQuestsVoucher: OpenedContract<PrimesVoucher>;
    /** D-168 — the stake master (§5.3). */
    stake: OpenedContract<PrimesStake>;
    /**
     * D-100 point 6 / D-166 — the TREASURY's vesting lock, the only one genesis
     * deploys: 1,000,000 PRIMES, four tranches (one at genesis, then every 90
     * days), and a beneficiary that is a CONTRACT with no key (`treasury` below).
     * It funds PRIMES staking through the treasury's `distribute()` (D-168).
     */
    treasuryVesting: OpenedContract<PrimesVesting>;
    /** D-100 points 4/7 — the governed treasury and the vote-only LP custody (D-168). */
    treasury: OpenedContract<PrimesTreasury>;
    /** D-100 point 4 — locked depth. LP in, nothing out, ever. */
    lpSink: OpenedContract<PrimesLpSink>;
};

export type VestAllocationResult = {
    /** The whole vested allocation. `S₀` counts it (§3.3). */
    primesMinted: bigint;
    treasuryVestingAddr: Address;
};

/**
 * D-46's `T0_nominal·L` sizing, halved by D-100 point 6 and left with only the
 * treasury's half by D-166 — the operator's half is deleted, not reassigned. In
 * one place because two steps need it: `deployAndWire` bakes it into the lock's
 * ADDRESS-DETERMINING init data, and `completeGenesis` mints exactly it.
 * `S₀ = T0_nominal·L/2 + V`.
 */
export function treasuryVestPrimes(params: GenesisParams, tonNominal: bigint): bigint {
    return (tonNominal * BigInt(Math.round(params.lpPrimesPerTon * 1000))) / 1000n / 2n;
}

/**
 * One `MintGenesis` into the treasury's vesting lock. Nothing else: no GRAM
 * transfer out, no LP deposit, no burn.
 *
 * The `totalAmount` assertion is why `treasuryVestPrimes` is shared: the lock's
 * declared total is compiled into its init data at `deployAndWire`, so a
 * `tonNominal` that differs here would mint a quantity the lock's own schedule
 * does not describe — PRIMES `distribute()` could never pay out, or a promise the
 * schedule cannot keep. Neither is detectable later from any get-method, so it
 * is caught before the mint instead.
 */
export async function mintTreasuryVest(
    env: GenesisEnv,
    params: GenesisParams,
    d: GenesisDeployment,
    tonNominal: bigint
): Promise<VestAllocationResult> {
    const amount = treasuryVestPrimes(params, tonNominal);
    const declared = (await d.treasuryVesting.getVesting()).totalAmount;
    if (declared !== amount) {
        throw new Error(
            `genesis: the treasury vesting lock declares ${declared} nanoPRIMES but the allocation ` +
                `is ${amount} (tonNominal ${tonNominal} vs the value deployAndWire baked in) — ` +
                'redeploy, do not mint'
        );
    }
    await d.master.sendMintGenesis(env.genesisSender, {
        to: d.treasuryVesting.address,
        amount,
        value: toNano('0.3'),
    });
    await env.settle?.('vesting:mint');
    return { primesMinted: amount, treasuryVestingAddr: d.treasuryVesting.address };
}

/**
 * D-20: the head is defined over COMPOSITES AND UNITY ONLY. Unity (n = 1) mints
 * at ignite, so the first number anyone can build is 4 — 2 and 3 are prime and
 * are never on the sequential line at all.
 *
 * This is therefore not "the head starts at 4 because we skipped 2 and 3"; it is
 * the head starting at the first number it is defined on. The market reads it as
 * `n < headHint` to decide which primes are already openable, which makes 2 and
 * 3 open from the first block, exactly as D-20 point 1 describes.
 */
export const OPENING_HEAD = 4n;

/**
 * D-20 DELETES `maxLot`, `GENESIS_PRIMES` and `unsoldMaskOf`.
 *
 * All three served the fixed genesis set K = {2,3,5,7,11,13}: `unsoldMaskOf`
 * built the ledger's six-bit forfeit mask, and `maxLot` placed the opening head
 * above the set so the book's distance gate measured from the right place.
 * There is no set. Every prime, from 2 onward, uses the identical
 * `MODE_DUTCH_BUYNOW` mechanism, its tribute forfeits to the treasury while
 * unsold rather than to a mask the genesis script had to precompute, and the
 * opening head is `OPENING_HEAD` above rather than a function of the lots.
 */

/**
 * Read the trophy-auction NPV ladder out of `shared/params.json` and REFUSE to
 * deploy without it.
 *
 * CONCEPT.md §4.4 / DECISIONS.md D-3 (was TROPHY_AUCTION_PLAN.md D3) give the
 * auction a declared ladder fallback: with
 * no table every prime opens at `max(ladder, PRIME_P0_MIN)`. That fallback is a
 * legitimate design state, but it is not a legitimate *accident*. The table
 * lands in ADDRESS-DETERMINING init data and no message can change it, so a
 * deploy that silently picked the fallback because a key had been renamed would
 * be discovered only when someone opened a lot on 17 at 7 GRAM instead of the
 * ~311 GRAM its tribute claim is worth — and fixing it would mean a fresh
 * genesis, not a setter.
 *
 * So: an absent table throws here. To ship the fallback deliberately, pass
 * `trophyNpv: null` at the call site, where the intent is visible in the diff.
 */
export function requireTrophyNpv(params: unknown): Record<string, string | number> {
    const ladder = (params as any)?.trophy_auction?.npv_ladder;
    const table = ladder?.npv_ton_by_prime;
    if (!table || typeof table !== 'object' || Object.keys(table).length === 0) {
        throw new Error(
            'genesis: shared/params.json has no trophy_auction.npv_ladder.npv_ton_by_prime. ' +
                'Regenerate it with `python sim/scripts/run_phase1.py` (CONCEPT.md §4.4 / DECISIONS.md D-3). ' +
                'To deploy the ladder-only fallback on purpose, pass trophyNpv: null explicitly.'
        );
    }
    return table as Record<string, string | number>;
}

/**
 * The exact init-data shape `deployAndWire` gives `PrimesJettonMaster.createFromConfig`
 * for step 3 — pulled out so the dry-run below (R17) and the real deploy can never drift
 * apart. Every field here is known before a single message is sent: `genesisAddress` is
 * the deploy subwallet (a keypair-derived address, not a get-call result) and
 * `jettonMetadataUri` is a presentation string, so the master's address is a pure
 * function of inputs a rehearsal already has.
 */
export function jettonMasterConfig(genesisAddress: Address, jettonWalletCode: Cell, jettonMetadataUri: string) {
    return {
        ledgerAddr: genesisAddress,
        genesisScriptAddr: genesisAddress,
        walletCode: jettonWalletCode,
        content: offchainContentCell(jettonMetadataUri),
    };
}

/**
 * R17 — the mainnet ordering problem: a DeDust pool for the PRIMES/GRAM pair needs the
 * PRIMES jetton master's address before it can be created, and the master is not deployed
 * until step 3 of `runGenesis`/`deployAndWire`, which itself needs the pool's address at
 * step 25b (`lpSink.set_wallet`, `treasury.set_wallets`) — circular on a network where the
 * pool cannot be a stand-in.
 *
 * This walks ONLY the address derivation, sends nothing, and needs no live network: given
 * the subwallet that will run genesis (a keypair + walletId, resolved the same way
 * `deployGenesis.ts --skew-safe` resolves `genesisAddress` today) and the compiled jetton
 * codes, it returns the master's address exactly as `deployAndWire` will produce it. Run
 * this, create the DeDust pool against the printed address (`createDedustPool.ts`), THEN
 * run genesis for real.
 */
export function dryRunGenesisMasterAddress(
    genesisAddress: Address,
    jettonMasterCode: Cell,
    jettonWalletCode: Cell,
    jettonMetadataUri: string
): Address {
    return PrimesJettonMaster.createFromConfig(
        jettonMasterConfig(genesisAddress, jettonWalletCode, jettonMetadataUri),
        jettonMasterCode
    ).address;
}

/** Step 1 + 2: deploy everything and run the one-shot bootstrap wiring. */
export async function deployAndWire(
    env: GenesisEnv,
    code: GenesisCode,
    params: GenesisParams
): Promise<GenesisDeployment> {
    const log = env.log ?? (() => {});

    // Before anything is sent. Everything validatePresentation checks lands in init data
    // that no message can change, so a mistake caught here is an error message and the
    // same mistake caught two contracts later is an abandoned genesis.
    validatePresentation(params.presentation);
    // Audit 2026-11-19 R2-M2 (D-171 amended 2026-11-20): every voucher instance has its own
    // key, so one leaked key reaches one track's `remaining`. Address-determining init data,
    // so checked pairwise before the first message.
    const voucherKeys: [string, Buffer][] = [
        ['quests', params.questsSignerPubkey],
        ['prime-quests', params.primeQuestsSignerPubkey],
        ['security', params.securitySignerPubkey],
    ];
    for (let i = 0; i < voucherKeys.length; i++) {
        for (let j = i + 1; j < voucherKeys.length; j++) {
            if (voucherKeys[i][1].equals(voucherKeys[j][1])) {
                throw new Error(
                    `R2-M2: the ${voucherKeys[i][0]} and ${voucherKeys[j][0]} voucher keys must differ — one key per track`
                );
            }
        }
    }
    // §4.3.2 / D-151, the half that needs no deployed address — same argument, and
    // the same place in the run: before the first message. The other half is a few
    // contracts down, where the ratchet and the treasury exist.
    validateStakingVenue(params, { genesisAddr: env.genesisAddress });

    // Deploy order is forced by address dependencies; see D7/D11/D12/D17/D21.
    //
    // D-188 point 6: the registrar's address is a function of its code and the genesis
    // address alone, so it is COMPUTED here — deployed further down — and fixed into the
    // collection as the one sender of `relay_annotation` (a paid prime annotation, handed on
    // to the item). No bootstrap message: nothing about the registrar depends on this.
    // D-191 point 1: the webapp, the agent and the readers derive a wallet's minter card
    // from shared/minterCard.ts; a ledger deployed with any other card code would
    // refuse every mint they send (its derived card address would differ).
    if (!code.minterCard.hash().equals(minterCardCode().hash())) {
        throw new Error('PrimesMinterCard build differs from shared/minterCard.ts — run node tools/sync-minter-card-code.mjs');
    }
    // D-196: the same rule for the lot block — tests and wrappers derive it from shared/lotBlock.ts.
    if (!code.lotBlock.hash().equals(lotBlockCode().hash())) {
        throw new Error('PrimesLotBlock build differs from shared/lotBlock.ts — run node tools/sync-lot-block-code.mjs');
    }
    // D-212: both naming fees are deploy data with no setter; a zero fee would leave
    // the ledger's floor step refusing every naming (`amount > 0`, 103).
    if (params.nameFee <= 0n || params.renameFee <= 0n) {
        throw new Error('genesis: nameFee and renameFee must both be > 0 nanoGRAM (D-212)');
    }
    const registrarAddress = PrimesRegistrar.createFromConfig(
        { genesisScriptAddr: env.genesisAddress, renameFee: params.renameFee },
        code.registrar
    ).address;
    const collection = env.open(
        PrimesCollection.createFromConfig(
            {
                nextIndex: 2n,
                itemCode: code.item,
                ledgerAddr: env.genesisAddress, // placeholder until SetLedger
                genesisScriptAddr: env.genesisAddress,
                registrarAddr: registrarAddress,
                // D-212 (§4.7.1): the naming fees. Deploy data, no setter.
                nameFee: params.nameFee,
                renameFee: params.renameFee,
                // All five fixed at construction — see GenesisParams.presentation.
                //
                // The two content cells are encoded DIFFERENTLY on purpose, and the
                // difference is not visible from the field names. `collectionContent` is
                // returned verbatim by `get_collection_data`, so it carries its own TEP-64
                // 0x01 tag; `commonContentPrefix` is spliced in by `get_nft_content` AFTER
                // that method writes the tag itself, so it must be raw bytes. Tagging both
                // yields item URIs beginning with a stray 0x01.
                collectionContent: offchainContentCell(params.presentation.collectionMetadataUri),
                commonContentPrefix: snakeCell(params.presentation.nftContentPrefix),
                royaltyNum: params.presentation.royaltyNum,
                royaltyDen: params.presentation.royaltyDen,
                // CONCEPT §3.1's 5% secondary royalty. The wrapper's fallback is
                // `genesisScriptAddr` — the throwaway deploy wallet — so leaving this
                // unset points the collection's royalty, and the `owner_address` every
                // marketplace reads from `get_collection_data`, at a key nobody keeps.
                //
                // D-100 point 6 re-points §4.1's fee lines and says NOTHING about this
                // one, so it does not move: the destination is the same operator wallet
                // that has always been behind `PRIMES_TREASURY_ADDR`, now under its real
                // name. Pointing a TEP-66 royalty at the governed treasury instead is a
                // decision D-100 did not take, and taking it here would be inventing one.
                royaltyDest: params.operatorAddr,
            },
            code.collection
        )
    );
    await collection.sendDeploy(env.genesisSender, toNano('0.5'));
    await env.settle?.('deploy:collection');
    log(`collection  ${collection.address.toString()}`);

    const master = env.open(
        PrimesJettonMaster.createFromConfig(
            jettonMasterConfig(env.genesisAddress, code.jettonWallet, params.presentation.jettonMetadataUri),
            code.jettonMaster
        )
    );
    await master.sendDeploy(env.genesisSender, toNano('0.5'));
    await env.settle?.('deploy:jetton-master');
    log(`master      ${master.address.toString()}`);

    // D-100 point 4 — THE LP SINK, and it comes before the treasury because the
    // treasury's init data names it. There is no `SetSink` on the treasury and
    // there deliberately is not one: a governed pot whose sink address could be
    // re-pointed by a message would have a path that moves LP somewhere nobody
    // voted for, which is exactly what TR-2 forbids.
    //
    // Its OWN bootstrap (`set_wallet`, the DeDust LP jetton wallet) is in
    // `completeGenesis`, for the D21-family reason — a jetton wallet is
    // addressed by its owner, so it cannot be in its owner's init data.
    const lpSink = env.open(
        PrimesLpSink.createFromConfig({ genesisScriptAddr: env.genesisAddress }, code.lpSink)
    );
    await lpSink.sendDeploy(env.genesisSender, toNano('0.5'));
    await env.settle?.('deploy:lp-sink');
    log(`lpsink      ${lpSink.address.toString()}`);

    // D-100 points 4/5/7 — THE GOVERNED TREASURY.
    //
    // Everything in this config is ADDRESS-DETERMINING and none of it has a
    // setter, which is the whole shape of the contract: no owner, no admin
    // opcode, no upgrade, no pause (point 7). In particular
    //
    //   - `positionCode` is `primes_lp_position.tolk`'s compiled cell. The
    //     treasury derives a depositor's child address from it, so RECOMPILING
    //     THE CHILD MOVES THE PARENT. That is not a hazard to work around; it is
    //     the property that lets `positionAddress(owner)` authenticate a child
    //     message without a registry.
    //   - `distributionRateBpsPerDay` is deploy DATA, not a contract constant, for
    //     the same reason `primes_vesting.tolk`'s `totalAmount` is: the sim selects
    //     it (`staking.distribution_rate_bps_per_day`), and a sim-selected figure
    //     must never be guessed into a contract (CLAUDE.md rule 3).
    //   - `stakeAddr` (D-168) is the stake master deployed just above:
    //     `distribute()`'s one recipient, fixed at deploy.
    //
    // 0.6 GRAM like the vesting locks, not the usual 0.5: this contract has to
    // pay basechain storage for a dictionary of proposals, and nothing tops it up
    // — it takes no fee from anything.
    //
    // D-168 — THE STAKE MASTER, deployed first because the treasury's init data
    // names it. There is no circle: the master's own init data holds only the
    // jetton master, its child code and the clock divisor, and it learns the
    // TREASURY (with its own PRIMES wallet) through the one-shot `set_wallet` in
    // `completeGenesis`.
    const stake = env.open(
        PrimesStake.createFromConfig(
            {
                jettonMasterAddr: master.address,
                positionCode: code.stakePosition,
                clockDivisor: params.clockDivisor,
                genesisScriptAddr: env.genesisAddress,
            },
            code.stake
        )
    );
    await stake.sendDeploy(env.genesisSender, toNano('0.5'));
    await env.settle?.('deploy:stake');
    log(`stake       ${stake.address.toString()}`);

    const treasury = env.open(
        PrimesTreasury.createFromConfig(
            {
                operatorAddr: params.operatorAddr,
                sinkAddr: lpSink.address,
                stakeAddr: stake.address,
                distributionRateBpsPerDay: params.distributionRateBpsPerDay,
                clockDivisor: params.clockDivisor,
                positionCode: code.lpPosition,
                genesisScriptAddr: env.genesisAddress,
            },
            code.treasury
        )
    );
    await treasury.sendDeploy(env.genesisSender, toNano('0.6'));
    await env.settle?.('deploy:treasury');
    log(`treasury    ${treasury.address.toString()}`);

    // The timelock must exist before the RATCHET: the ratchet's init data embeds
    // venueTimelockAddr (immutable), while the timelock's own target address is
    // the one-shot D11 bootstrap. §3.4's decomposition retargets that bootstrap
    // from the ledger to the ratchet — the venue belongs with the leg that uses
    // it, and the ledger no longer accepts `update_venue` at all.
    // D-194: it comes AFTER the treasury, whose address is its governance key
    // (the only sender of `confirm_venue`). No circle: the treasury's init data
    // names nothing here.
    const timelock = env.open(
        PrimesVenueTimelock.createFromConfig(
            {
                proposerAddr: params.proposerAddr,
                governanceAddr: treasury.address,
                ratchetAddr: env.genesisAddress, // placeholder until SetRatchet (D11)
                genesisScriptAddr: env.genesisAddress,
                // D-139's fifth consumer: without it `execute` needs 30 real days
                // and no run has ever reached the admin surface's second half.
                clockDivisor: params.clockDivisor,
            },
            code.venueTimelock
        )
    );
    await timelock.sendDeploy(env.genesisSender, toNano('0.5'));
    await env.settle?.('deploy:venue-timelock');
    log(`timelock    ${timelock.address.toString()}`);

    const ledger = env.open(
        PrimesLedger.createFromConfig(
            {
                a: {
                    collectionAddr: collection.address,
                    jettonMasterAddr: master.address,
                    // D-100 point 6 / D-152. `ConfigA.feeDests` is two addresses
                    // with two different meanings and they are NOT
                    // interchangeable: §4.1's whole 5% line and the 80% share of
                    // every unsold-prime forfeit go to the governed TREASURY
                    // CONTRACT deployed above, while the forfeit's 42% remainder (D-166)
                    // goes to the operator's WALLET.
                    // Both are init data with no setter, so this pair of lines is
                    // the only place either is ever chosen.
                    treasuryAddr: treasury.address,
                    operatorAddr: params.operatorAddr,
                    itemCode: code.item,
                    cardCode: code.minterCard,
                    lotBlockCode: code.lotBlock, // D-196
                },
                b: {
                    genesisScriptAddr: env.genesisAddress,
                },
            },
            code.ledger
        )
    );
    await ledger.sendDeploy(env.genesisSender, toNano('1'));
    await env.settle?.('deploy:ledger');
    log(`ledger      ${ledger.address.toString()}`);

    // §3.4 B1. Both of these have a circular address dependency with the ledger
    // (their init data would have to embed its address and its config theirs),
    // so both are deployed WITHOUT it and linked one-shot below.
    const ratchet = env.open(
        PrimesRatchet.createFromConfig(
            {
                venueTimelockAddr: timelock.address,
                genesisScriptAddr: env.genesisAddress,
                dedustNativeVault: params.dedustNativeVault,
                dedustPool: params.dedustPool,
                primesJettonVault: params.primesJettonVault,
                // §4.3.2 / D-151 — the staked reserve's venue, in the same init
                // data and for the same D-46 reason as the DeDust three above.
                // `treasuryAddr` is `harvest()`'s ONLY destination and is the
                // contract deployed a few lines up, never a wallet: the yield is
                // LP-governed (D-100 point 7) and the operator gets nothing from
                // it.
                tonstakersPool: params.tonstakersPool,
                dedustTstonVault: params.dedustTstonVault,
                dedustTstonPool: params.dedustTstonPool,
                treasuryAddr: treasury.address,
                clockDivisor: params.clockDivisor,
                stakeDivisor: params.stakeDivisor,   // D-153
            },
            code.ratchet
        )
    );
    // After `createFromConfig` (which is pure) and before a single message: the
    // venue is init data, so the ratchet's ADDRESS depends on these five and a
    // placeholder that got this far is unrepairable. See `validateStakingVenue`.
    validateStakingVenue(params, {
        genesisAddr: env.genesisAddress,
        ratchetAddr: ratchet.address,
        treasuryAddr: treasury.address,
    });
    await ratchet.sendDeploy(env.genesisSender, toNano('1'));
    await env.settle?.('deploy:ratchet');
    log(`ratchet     ${ratchet.address.toString()}`);

    const registrar = env.open(
        PrimesRegistrar.createFromConfig({ genesisScriptAddr: env.genesisAddress, renameFee: params.renameFee }, code.registrar)
    );
    if (!registrar.address.equals(registrarAddress)) {
        throw new Error('registrar address drifted from the one fixed into the collection (D-188 point 6)');
    }
    await registrar.sendDeploy(env.genesisSender, toNano('0.5'));
    await env.settle?.('deploy:registrar');
    log(`registrar   ${registrar.address.toString()}`);

    // P2.A7 — ONE deploy where there were three, and the circular pair is gone
    // with them. The book had to be deployed before the trophy auction (whose
    // init data embedded the book's address) and then pointed back at it by a
    // one-shot `SetTrophyAuction`, purely because two contracts each needed the
    // other's address. One contract needs no such introduction, so the whole
    // ordering constraint and the setter that closed it both disappear.
    //
    // D-20 sets the opening head to 4, and that number is a statement about the
    // model rather than a tuning choice: the head is defined over COMPOSITES AND
    // UNITY ONLY, so after Unity (n = 1) mints, the next number anyone can build
    // is 4 — and primes 2 and 3 are already behind the head, which is exactly
    // what makes them immediately openable in the market.
    const market = env.open(
        PrimesMarket.createFromConfig(
            {
                headHint: OPENING_HEAD,
                ledgerAddr: ledger.address,
                ratchetAddr: ratchet.address,
                // D-90 DROPS `shardCode` and `treasuryAddr`: there are no escrow
                // shards, and the treasury address existed only for D-32's
                // release forfeit, which D-90.2 deletes.
                npvTable: npvTableToDict(params.trophyNpv),
                clockDivisor: params.clockDivisor,
            },
            code.market
        )
    );
    await market.sendDeploy(env.genesisSender, toNano('0.5'));
    await env.settle?.('deploy:market');
    log(`market      ${market.address.toString()}`);

    // G76 / §9.5 — THE VOUCHER, deployed BEFORE the vault because the vault's allow-list
    // (address-determining) names it. It cannot name the vault back in init data for the
    // same reason, so it carries the genesis address as a placeholder until `SetVault`
    // below closes the loop (D22).
    const voucher = env.open(
        PrimesVoucher.createFromConfig(
            {
                signerPubkey: params.questsSignerPubkey,
                programTag: PROGRAM_TAG_QUESTS,
                vaultAddr: env.genesisAddress,
                genesisScriptAddr: env.genesisAddress,
                receiptCode: code.claimReceipt,
                // R2-M2: one wallet's whole social board, params.json via shared/voucher.ts.
                maxPerWallet: VOUCHER_MAX_PER_WALLET[PROGRAM_TAG_QUESTS],
            },
            code.voucher
        )
    );
    await voucher.sendDeploy(env.genesisSender, toNano('0.1'));
    await env.settle?.('deploy:voucher');
    log(`voucher     ${voucher.address.toString()}`);

    // D-170 — the security prize: the same code on the owner's own key, tagged SECU. Its key
    // is checked distinct from both service keys at the top of this function (R2-M2).
    const securityVoucher = env.open(
        PrimesVoucher.createFromConfig(
            {
                signerPubkey: params.securitySignerPubkey,
                programTag: PROGRAM_TAG_SECURITY,
                vaultAddr: env.genesisAddress,
                genesisScriptAddr: env.genesisAddress,
                receiptCode: code.claimReceipt,
                // R2-M2: the whole track — D-170 pays one prize to one wallet.
                maxPerWallet: VOUCHER_MAX_PER_WALLET[PROGRAM_TAG_SECURITY],
            },
            code.voucher
        )
    );
    await securityVoucher.sendDeploy(env.genesisSender, toNano('0.1'));
    await env.settle?.('deploy:security-voucher');
    log(`security    ${securityVoucher.address.toString()}`);

    // G78 / D-171 — the prime-quests voucher, tagged PQST, on its own key since R2-M2. The tag
    // is in every signed hash too, so a quests voucher can never redeem here or the other way round.
    const primeQuestsVoucher = env.open(
        PrimesVoucher.createFromConfig(
            {
                signerPubkey: params.primeQuestsSignerPubkey,
                programTag: PROGRAM_TAG_PRIME_QUESTS,
                vaultAddr: env.genesisAddress,
                genesisScriptAddr: env.genesisAddress,
                receiptCode: code.claimReceipt,
                // R2-M2: one wallet's whole contract-fact board.
                maxPerWallet: VOUCHER_MAX_PER_WALLET[PROGRAM_TAG_PRIME_QUESTS],
            },
            code.voucher
        )
    );
    await primeQuestsVoucher.sendDeploy(env.genesisSender, toNano('0.1'));
    await env.settle?.('deploy:prime-quests-voucher');
    log(`primeQuests ${primeQuestsVoucher.address.toString()}`);

    const vault = env.open(
        PrimesBountyVault.createFromConfig(
            {
                schedule: params.eraSchedule,
                rebateSchedule: params.rebateSchedule,
                ledgerAddr: ledger.address,
                jettonMasterAddr: master.address,
                genesisScriptAddr: env.genesisAddress,
                // V26.7 — the same figure step 5 mints into its wallet.
                fundedPrimes: params.bountyVaultPrimes,
                allowlist: [
                    // G76 / §9.5 — the voucher program, capped at the `quests` track.
                    {
                        addressHash: BigInt('0x' + voucher.address.hash.toString('hex')),
                        programTag: PROGRAM_TAG_QUESTS,
                        remaining: params.questsPrimes,
                    },
                    // D-170 — the one security prize, reserved so no quest payout can eat it.
                    {
                        addressHash: BigInt('0x' + securityVoucher.address.hash.toString('hex')),
                        programTag: PROGRAM_TAG_SECURITY,
                        remaining: params.securityBountyPrimes,
                    },
                    // G78 / D-171 — §9.4's contract-fact quests, capped at `prime_quests`.
                    {
                        addressHash: BigInt('0x' + primeQuestsVoucher.address.hash.toString('hex')),
                        programTag: PROGRAM_TAG_PRIME_QUESTS,
                        remaining: params.primeQuestsPrimes,
                    },
                ],
            },
            code.bountyVault
        )
    );
    await vault.sendDeploy(env.genesisSender, toNano('0.5'));
    await env.settle?.('deploy:bounty-vault');
    log(`vault       ${vault.address.toString()}`);


    // D-77 — THE VESTING LOCK. Deployed here, before anything is minted,
    // because `mintTreasuryVest` needs its address as the mint destination.
    //
    // `totalAmount` is baked into ADDRESS-DETERMINING init data along with the
    // beneficiary, which is deliberate: neither can be changed by any message,
    // so the schedule's size and its only possible destination are both fixed
    // by the moment this address exists. `mintTreasuryVest` re-reads the
    // declared total and refuses to mint a different quantity.
    //
    // It is sized from `params.seedTon` rather than from `completeGenesis`'s
    // `tonNominal` argument, and the two are the same number on every real path:
    // `resolveSeedTon` applies the testnet override BEFORE the pipeline runs, so
    // `params.seedTon` is already the effective nominal here. A caller that
    // passes a different `tonNominal` later hits the assertion rather than a
    // silently mis-sized lock.
    //
    // 0.6 GRAM, not the 0.5 every other contract gets: this one has to pay
    // basechain storage until its last tranche, where the others are topped up
    // by the traffic they serve.
    //
    // ONE INSTANCE (D-166). D-100 point 6 deployed two, operator and treasury;
    // D-166 deleted the operator's. The beneficiary is a CONTRACT —
    // `primes_treasury.tolk`, which has no key at all (point 7) — so nothing the
    // operator can sign moves it, and the only way it leaves is a passed
    // proposal or `distribute()` to the stake master (D-168).
    const treasuryVesting = env.open(
        PrimesVesting.createFromConfig(
            {
                beneficiary: treasury.address,
                jettonMasterAddr: master.address,
                genesisScriptAddr: env.genesisAddress,
                totalAmount: treasuryVestPrimes(params, params.seedTon),
            },
            code.vesting
        )
    );
    await treasuryVesting.sendDeploy(env.genesisSender, toNano('0.6'));
    await env.settle?.('deploy:vesting-treasury');
    log(`vest.tr     ${treasuryVesting.address.toString()}`);

    // D-20 deleted the genesis auction: a prime's lot is opened permissionlessly
    // once the head passes it, and each lot's decay clock starts at its own open.

    // ---- one-shot bootstrap wiring (every one of these self-closes) ----
    await collection.sendSetLedger(env.genesisSender, { ledgerAddr: ledger.address, value: toNano('0.05') });
    await master.sendSetLedger(env.genesisSender, { ledgerAddr: ledger.address, value: toNano('0.05') });
    // §3.4: the timelock's one admin action is `update_venue`, and the venue
    // now lives on the ratchet. Its target is therefore the RATCHET, not the
    // ledger — the ledger has no venue to update and would reject the message.
    await timelock.sendSetRatchet(env.genesisSender, { ratchetAddr: ratchet.address, value: toNano('0.05') });
    // P2.A7: `SetPeers` carries TWO addresses where it carried four across an
    // extra ref cell. The three market peers the ledger used to distinguish
    // were merged into one contract (P2.A7), so
    // every edge that fanned out to three (`launch_open`, `head_update`) is one
    // send, and every edge that authenticated against three
    // (`clearing_cleared`) is one comparison.
    await ledger.sendSetPeers(env.genesisSender, {
        marketAddr: market.address,
        bountyVaultAddr: vault.address,
        value: toNano('0.05'),
    });
    // §3.4 B1: link the decomposition, both directions. Until SetSinks lands the
    // ledger throws 233 on every mint rather than stranding pool backing on a
    // contract with no way to forward it.
    await ratchet.sendSetLedger(env.genesisSender, { ledgerAddr: ledger.address, value: toNano('0.05') });
    await registrar.sendSetLedger(env.genesisSender, { ledgerAddr: ledger.address, value: toNano('0.05') });
    // D-212: a trophy re-engraving's fee reaches the floor through the collection.
    // One-shot; until it lands every paid re-engraving is refunded.
    await registrar.sendSetCollection(env.genesisSender, {
        collectionAddr: collection.address,
        value: toNano('0.05'),
    });
    // P2.A7 DELETES `SetTrophyAuction`. It existed so the book could
    // authenticate `trophy_reserve` from the trophy auction — an edge BETWEEN
    // two of the merged contracts. A contract does not need to authenticate
    // itself, so the message, the stored address and the 508 it guarded are all
    // gone rather than renamed.
    await ledger.sendSetSinks(env.genesisSender, {
        ratchetAddr: ratchet.address,
        registrarAddr: registrar.address,
        value: toNano('0.05'),
    });
    // G76 — the voucher learns the vault that names it. One-shot (D22).
    await voucher.sendSetVault(env.genesisSender, { vaultAddr: vault.address, value: toNano('0.05') });
    await securityVoucher.sendSetVault(env.genesisSender, { vaultAddr: vault.address, value: toNano('0.05') });
    await primeQuestsVoucher.sendSetVault(env.genesisSender, { vaultAddr: vault.address, value: toNano('0.05') });
    await env.settle?.('wire:bootstrap');
    // READ THE FLAGS BACK. Every send above is ONE-SHOT — a resend throws 104 —
    // and NOTHING later in this pipeline depends on any of them, so until this
    // block a wiring message that threw was invisible forever: the seal, the
    // seed, the vesting and the timelock queue all succeed with the whole block
    // missing, and the run still prints `genesis complete`. Each contract
    // publishes a `*Set` flag for exactly this purpose; they were simply never
    // read. (`settle()` is a sleep, and the only other confirmation in the stack
    // is the deploy wallet's seqno, which advances just the same when the
    // destination throws — 2026-09-19, where that trap cost a whole genesis.)
    const wiringChecks: [string, () => Promise<boolean>][] = [
        ['collection.ledgerAddr', async () => !!(await collection.getCollectionData()).ledgerAddr],
        ['ledger.peersSet', async () => (await ledger.getPeers()).peersSet === 1],
        ['registrar.collectionSet', async () => (await registrar.getPeers()).collectionSet === 1],
        ['ledger.sinksSet', async () => (await ledger.getSinks()).sinksSet === 1],
        // D-212: one rename fee, in two deploy datas — they must agree.
        [
            'naming.renameFee',
            async () => (await collection.getNaming()).renameFee === (await registrar.getTrophyRenameFee()),
        ],
        [
            'voucher.vaultSet',
            async () => {
                const v = await voucher.getVault();
                return v.vaultSet && v.vaultAddr.equals(vault.address);
            },
        ],
        [
            'securityVoucher.vaultSet',
            async () => {
                const v = await securityVoucher.getVault();
                return v.vaultSet && v.vaultAddr.equals(vault.address);
            },
        ],
        [
            'primeQuestsVoucher.vaultSet',
            async () => {
                const v = await primeQuestsVoucher.getVault();
                return v.vaultSet && v.vaultAddr.equals(vault.address);
            },
        ],
    ];
    const unwired: string[] = [];
    for (const [name, read] of wiringChecks) {
        let ok = false;
        try {
            ok = await read();
        } catch (e) {
            unwired.push(`${name} (get-method threw: ${(e as Error).message})`);
            continue;
        }
        if (!ok) unwired.push(name);
    }
    if (unwired.length) {
        throw new Error(
            `bootstrap wiring did not land: ${unwired.join(', ')}. These sends are one-shot, so the ` +
                `genesis cannot be repaired — abandon this set and deploy from a fresh subwallet.`
        );
    }
    log(`bootstrap wiring done and READ BACK (${wiringChecks.length} flags confirmed)`);

    await verifyPresentation(params, { collection, master }, log);

    return {
        collection,
        master,
        timelock,
        ledger,
        ratchet,
        registrar,
        market,
        vault,
        voucher,
        securityVoucher,
        primeQuestsVoucher,
        stake,
        treasuryVesting,
        treasury,
        lpSink,
    };
}

/**
 * Read the presentation back out of the deployed contracts, through the exact get-methods
 * a wallet, explorer or marketplace calls, and throw if it is not what was asked for.
 *
 * `validatePresentation` checks the INPUT; this checks the RESULT, and the two catch
 * different failures. Input validation cannot see a wrapper whose config-to-cell builder
 * silently drops a field, a field written in the wrong order, or a default that quietly
 * substitutes itself — which is exactly the bug this whole path exists to close: every
 * contract-side field, get-method and encoder was already correct and in place, and the
 * pipeline simply passed none of them, so every get-method returned its empty default and
 * nothing anywhere failed.
 *
 * This runs while the genesis is still recoverable in the only sense that matters: nothing
 * downstream has been sealed, the jetton authority is still open and the ledger has not
 * been seeded, so the operator can abandon a bad set having spent gas rather than
 * discovering a nameless collection after the line is live and immutable.
 */
export async function verifyPresentation(
    params: GenesisParams,
    d: Pick<GenesisDeployment, 'collection' | 'master'>,
    log: (m: string) => void = () => {}
): Promise<void> {
    const want = params.presentation;
    const fail = (what: string, expected: string, got: string) => {
        throw new Error(
            `genesis: ${what} did not land — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}. ` +
                'This is init data and no message can change it; abandon this set rather than continuing.'
        );
    };

    // --- jetton: get_jetton_data (TEP-74), the method every wallet and DEX calls ---
    const jetton = await d.master.getJettonDataStandard();
    const jettonUri = decodeOffchainContent(jetton.jettonContent);
    if (jettonUri !== want.jettonMetadataUri) fail('jetton content URI', want.jettonMetadataUri, jettonUri);

    // --- collection: get_collection_data (TEP-62) ---
    const cd = await d.collection.getStandardCollectionData();
    const collectionUri = decodeOffchainContent(cd.collectionContent);
    if (collectionUri !== want.collectionMetadataUri) {
        fail('collection content URI', want.collectionMetadataUri, collectionUri);
    }
    // `owner_address` is the royalty destination; it confers no authority (see the
    // get-method's own comment) but it is what marketplaces show as the collection owner.
    if (!cd.ownerAddress.equals(params.operatorAddr)) {
        fail('collection owner/royalty destination', params.operatorAddr.toString(), cd.ownerAddress.toString());
    }

    // --- collection: royalty_params (TEP-66), CONCEPT §3.1's 5% ---
    //
    // D-128: THE DESTINATION IS THE COLLECTION ITSELF, not the operator. TEP-66 carries
    // one destination and the royalty now splits two ways, so a marketplace has to be
    // pointed at the address where the split happens. `aux.royaltyDest` is still the
    // operator and is still deploy-fixed — it is the OPERATOR SHARE's destination now,
    // and `get_collection_data`'s `owner_address` above still publishes it, which is
    // why that check is unchanged.
    //
    // This is exactly the kind of init-data mistake this function exists to catch: a
    // collection deployed with the old destination would send 100% of every royalty to
    // the operator forever, silently and unfixably, and read as perfectly healthy.
    const royalty = await d.collection.getRoyaltyParams();
    if (royalty.numerator !== want.royaltyNum || royalty.denominator !== want.royaltyDen) {
        fail('royalty fraction', `${want.royaltyNum}/${want.royaltyDen}`, `${royalty.numerator}/${royalty.denominator}`);
    }
    if (!royalty.destination.equals(d.collection.address)) {
        fail('royalty destination (D-128: the collection splits it)', d.collection.address.toString(), royalty.destination.toString());
    }

    // --- items: get_nft_content composed from the prefix and the index ---
    // Probed at a real number rather than at the prefix, because the failure this catches
    // is a joint one: an untagged prefix, a missing separator and a dropped cell all read
    // identically from the config and differently from here.
    const probe = 1234n;
    const composed = await d.collection.getNftContent(probe, beginCell().endCell());
    const itemUri = decodeComposedNftContent(composed);
    const wantItemUri = `${want.nftContentPrefix}${probe}.json`;
    if (itemUri !== wantItemUri) fail(`item ${probe} content URI`, wantItemUri, itemUri);

    log(`presentation verified: collection ${collectionUri}, items ${want.nftContentPrefix}<n>.json, ` +
        `jetton ${jettonUri}, royalty ${want.royaltyNum}/${want.royaltyDen} to ${params.operatorAddr}`);
}

/**
 * Decode the cell `primes_collection.tolk`'s `get_nft_content` builds: a 0x01 tag, the
 * common prefix inline, then the `<n>.json` suffix in a ref. Distinct from
 * `decodeOffchainContent`, which reads a single-cell URI and rejects refs outright.
 */
export function decodeComposedNftContent(content: Cell): string {
    const s = content.beginParse();
    if (s.remainingBits < 8) throw new Error('nft content cell is empty — no TEP-64 tag');
    const tag = s.loadUint(8);
    if (tag !== 0x01) throw new Error(`expected the TEP-64 off-chain content tag 0x01, got 0x${tag.toString(16)}`);
    const prefix = s.loadBuffer(Math.floor(s.remainingBits / 8)).toString('utf8');
    if (s.remainingRefs !== 1) throw new Error(`expected exactly one suffix ref, got ${s.remainingRefs}`);
    const suffixSlice = s.loadRef().beginParse();
    const suffix = suffixSlice.loadBuffer(Math.floor(suffixSlice.remainingBits / 8)).toString('utf8');
    return prefix + suffix;
}

/**
 * Steps 4-8: mint the treasury's vested allocation, fund the vault, seal the jetton,
 * OPEN MINTING, queue the venue timelock.
 *
 * D-46: `tonNominal` (`params.seedTon`) sizes the vested allocation and the
 * bounty vault only — it is never deposited anywhere, so this function has no
 * dependency on any real DeDust liquidity existing. D-77 adds two steps to the
 * same sequence (5d, 5e): the allocation is minted into the vesting lock, the
 * lock's clock starts, and tranche 0 — the only one available before day 90 —
 * is released. D-166 leaves one lock, the treasury's: `S₀ = T0_nominal·L/2 + V`; `T` seeds at 0 (see `completeGenesis`
 * below) since there is no real backing at deploy any more.
 */
export async function completeGenesis(
    env: GenesisEnv,
    params: GenesisParams,
    d: GenesisDeployment,
    tonNominal: bigint = params.seedTon
) {
    const log = env.log ?? (() => {});

    // Again, not only in `deployAndWire`: this half is also run on its own by the
    // resume/repair scripts, and the two one-shot tsTON messages below are in
    // THIS half. Pure and cheap, so re-running it costs nothing and covers the
    // path where the wired half already succeeded.
    validateStakingVenue(params, {
        genesisAddr: env.genesisAddress,
        ratchetAddr: d.ratchet.address,
        treasuryAddr: d.treasury.address,
    });

    // 4. the treasury's vested PRIMES allocation, genesis mint only (D-46) —
    //    into the VESTING LOCK (D-77). D-166 deleted the operator's lock.
    const allocationResult = await mintTreasuryVest(env, params, d, tonNominal);
    log(
        `genesis vest: ${allocationResult.primesMinted} nanoPRIMES to the treasury's lock ` +
            `${allocationResult.treasuryVestingAddr.toString()} (beneficiary ${d.treasury.address.toString()}, ` +
            'a contract with no key). 4 tranches / 90 days. No LP deposit, no burn.'
    );

    // 5. bounty vault genesis mint + wallet wiring (pre-counted into S, CONCEPT §3.3)
    await d.master.sendMintGenesis(env.genesisSender, {
        to: d.vault.address,
        amount: params.bountyVaultPrimes,
        value: toNano('0.3'),
    });
    const vaultWalletAddr = await d.master.getWalletAddress(d.vault.address);
    await d.vault.sendSetWallet(env.genesisSender, { jettonWalletAddr: vaultWalletAddr, value: toNano('0.05') });
    await env.settle?.('vault:fund');
    log(`bounty vault funded with ${params.bountyVaultPrimes} nanoPRIMES`);

    // 5b. arm the ratchet's burn counter (CONCEPT §3.3 / §11.21). Same circular
    //     -address bootstrap as the vault's wallet above: the ratchet's PRIMES
    //     wallet is addressed by its owner, so it cannot be in the ratchet's own
    //     deploy data. Until this lands, the ratchet burns exactly as before but
    //     counts nothing, and `getBurnStats` reports `counting = 0` so the
    //     dashboard shows the number as unavailable instead of as a measured
    //     zero. It grants no authority and moves no GRAM.
    const ratchetWalletAddr = await d.master.getWalletAddress(d.ratchet.address);
    await d.ratchet.sendSetJettonWallet(env.genesisSender, {
        jettonWalletAddr: ratchetWalletAddr,
        value: toNano('0.05'),
    });
    await env.settle?.('ratchet:burn-counter');
    log(`ratchet burn counter armed on ${ratchetWalletAddr}`);

    // 5b-ii. §4.3.2 / D-151 — THE RATCHET'S tsTON WALLET. Grouped here with 5b
    //     because it is the same D21-family bootstrap for the same reason (a
    //     jetton wallet is addressed by its owner, so it cannot live in its
    //     owner's init data), with ONE difference that is the whole reason it
    //     needs a parameter: THE MASTER IS TONSTAKERS', NOT OURS. `d.master`
    //     answers `getWalletAddress` for PRIMES; nothing in this repo can answer
    //     it for tsTON, so the address is an input (`GenesisParams`) rather than
    //     a derivation.
    //
    //     One-shot, grants no authority, moves nothing. Until it lands
    //     `tstonWalletSet == 0` and stake/unstake/harvest all refuse with 231 —
    //     an idle reserve, which is what a half-wired genesis should look like.
    //     The read-back below is why that "until" cannot become "forever"
    //     unnoticed.
    await d.ratchet.sendSetTstonWallet(env.genesisSender, {
        tstonWalletAddr: params.ratchetTstonWallet,
        value: toNano('0.05'),
    });
    await env.settle?.('ratchet:tston-wallet');
    const tstonWallet = await d.ratchet.getTstonWallet();
    if (tstonWallet.walletSet !== 1 || !tstonWallet.tstonWalletAddr.equals(params.ratchetTstonWallet)) {
        throw new Error(
            `genesis: the ratchet never learned its tsTON wallet — getTstonWallet reads ` +
                `${tstonWallet.tstonWalletAddr.toString()} set=${tstonWallet.walletSet}, expected ` +
                `${params.ratchetTstonWallet.toString()} set=1. The arm is one-shot and the staked ` +
                'reserve is dead without it (231 on every stake/unstake/harvest). Fix and redeploy.'
        );
    }
    log(`ratchet tsTON wallet armed on ${params.ratchetTstonWallet.toString()} (read back, not assumed)`);

    // 5c. the stake master's own PRIMES wallet — the same D21-family bootstrap as
    //     the vault's and the ratchet's, for the same reason (a jetton wallet is
    //     addressed by its owner, so it cannot live in its owner's init data).
    //
    //     NOT FUNDED. The stake master is custody and starts empty. Its `set_wallet` also names
    //     the TREASURY (D-168) — the one sender whose `SBGT` budget it streams —
    //     and moves nothing.
    //
    //     Both are one-shot. Placed BEFORE the seal only for grouping — the
    //     wallet address is derived from the master's `getWalletAddress`, which
    //     is a get-method and is unaffected by sealing — but running them here
    //     keeps every "tell a contract its own wallet" message in one block.
    const stakeWalletAddr = await d.master.getWalletAddress(d.stake.address);
    await d.stake.sendSetWallet(env.genesisSender, {
        jettonWalletAddr: stakeWalletAddr,
        treasuryAddr: d.treasury.address,
        value: toNano('0.05'),
    });
    await env.settle?.('sinks:wallets');
    log(`stake master wallet ${stakeWalletAddr} (unfunded, by design)`);

    // 5c-ii. D-100 point 4 — THE LP SINK'S OWN DeDust LP JETTON WALLET, and the
    //     TREASURY'S TWO WALLETS. Same D21-family bootstrap, one difference that
    //     matters: these two are the only wallets in the whole genesis that are
    //     NOT ours. Their master is the DeDust pool, so they come from
    //     `env.lpWalletFor` rather than from `master.getWalletAddress`.
    //
    //     ORDER IS LOAD-BEARING ON THE SINK. Until `set_wallet` lands the sink
    //     refuses every notification with 1170, which is the right failure — a
    //     sink that accepted LP from an unknown wallet would report a `getLocked()`
    //     nobody could check against a balance. But it means LP that arrives
    //     first bounces, so the sink address must not be published (see the
    //     pairing instructions at the end of this function) until this has run.
    //
    //     The treasury takes ONE message for both of its wallets: its LP wallet
    //     (vote-only custody deposits, a sink-forward) and its PRIMES wallet (the vest
    //     half arriving, and every `claim` paying out). One-shot; until it lands
    //     `walletsSet == 0` and EVERY inbound notification is refused with 1150,
    //     so an unbootstrapped placeholder can never be impersonated into
    //     authority.
    const lpSinkWalletAddr = await env.lpWalletFor(d.lpSink.address);
    await d.lpSink.sendSetWallet(env.genesisSender, {
        lpJettonWalletAddr: lpSinkWalletAddr,
        value: toNano('0.05'),
    });
    const treasuryLpWalletAddr = await env.lpWalletFor(d.treasury.address);
    const treasuryPrimesWalletAddr = await d.master.getWalletAddress(d.treasury.address);
    await d.treasury.sendSetWallets(env.genesisSender, {
        lpJettonWallet: treasuryLpWalletAddr,
        primesJettonWallet: treasuryPrimesWalletAddr,
        // §4.3.2 / D-151 — the third wallet, `harvest()`'s landing pad. NEVER
        // omit it: the wrapper's harness default writes the treasury's own
        // address, `walletsSet` flips to 1 anyway, and the tsTON arm is
        // unreachable forever (`validateStakingVenue` refuses that address, and
        // the read-back below refuses a wrong one).
        tstonJettonWallet: params.treasuryTstonWallet,
        value: toNano('0.05'),
    });
    await env.settle?.('treasury:wallets');
    const lpSinkCfg = await d.lpSink.getLpSinkConfig();
    if (lpSinkCfg.walletSet !== 1) {
        throw new Error(
            'genesis: the LP sink never learned its own LP jetton wallet — every deposit would ' +
                'bounce with 1170. Do not publish the sink address; fix and redeploy.'
        );
    }
    const treasuryCfg = await d.treasury.getTreasuryConfig();
    if (treasuryCfg.walletsSet !== 1) {
        throw new Error(
            'genesis: the treasury never learned its own jetton wallets — every deposit, and the ' +
                'vest half itself, would be refused with 1150. Fix and redeploy.'
        );
    }
    // D-151. `walletsSet` above cannot catch a wrong tsTON wallet, because the
    // wrapper's default IS a well-formed address — so read the field itself.
    if (!treasuryCfg.tstonJettonWallet.equals(params.treasuryTstonWallet)) {
        throw new Error(
            `genesis: the treasury's tsTON wallet reads ${treasuryCfg.tstonJettonWallet.toString()}, ` +
                `expected ${params.treasuryTstonWallet.toString()}. SetWallets is one-shot, so every ` +
                'harvest would land on a wallet the treasury does not recognise and be refused (1150) ' +
                'forever. Fix and redeploy.'
        );
    }
    log(
        `lp sink wallet ${lpSinkWalletAddr} (locked=${await d.lpSink.getLocked()}); ` +
            `treasury LP wallet ${treasuryLpWalletAddr}, treasury PRIMES wallet ${treasuryPrimesWalletAddr}, ` +
            `treasury tsTON wallet ${treasuryCfg.tstonJettonWallet.toString()} (read back, not assumed)`
    );

    // 5d. D-77 — the vesting lock's own PRIMES wallet. Same D21-family
    //     bootstrap as every other one above, and unlike them it does one more
    //     thing: IT STARTS THE VEST CLOCK. `startTime` is stamped by this
    //     message rather than baked into deploy data, so the schedule dates from
    //     the moment the allocation is actually in custody (step 4, just above)
    //     rather than from a deploy timestamp that precedes it — and no
    //     timestamp has to survive testnet clock skew in init data.
    //
    //     UNLIKE THE SINKS, THIS ONE IS FUNDED, and that is not an exception to
    //     the "genesis does not pre-count PRIMES into a sink" rule — it is the
    //     same rule. `S` counts this allocation (§3.3); `T` never saw it, so
    //     the lock changes who can sell and when, never `p_f = T/S`.
    const vestingWalletAddr = await d.master.getWalletAddress(d.treasuryVesting.address);
    await d.treasuryVesting.sendSetWallet(env.genesisSender, {
        jettonWalletAddr: vestingWalletAddr,
        value: toNano('0.05'),
    });
    await env.settle?.('vesting:wallets');
    const started = await d.treasuryVesting.getVesting();
    if (started.startTime === 0) {
        throw new Error("genesis: the treasury vesting lock's clock did not start (set_wallet did not land)");
    }
    log(
        `treasury vesting lock wallet ${vestingWalletAddr}, clock started at ${started.startTime}, ` +
            `${started.totalAmount} nanoPRIMES held over ${started.tranches} tranches, ` +
            `beneficiary ${started.beneficiary.toString()}`
    );

    // 5e. D-77 — release TRANCHE 0, the one that matures at `startTime` itself.
    //     Genesis performs it so the deployment lands in a coherent state rather
    //     than with a matured-but-unclaimed tranche nobody has pushed; the call
    //     is PERMISSIONLESS, so doing it here grants the pipeline nothing anyone
    //     else could not have done in the next block.
    //
    //     The treasury's tranche funds `distribute()` to the stake master
    //     (D-168), so until this tranche lands stakers earn nothing.
    //     `primes_vesting.tolk` rides
    //     `NOTIFY_GAS` on the transfer (D-100 point 6), which is what makes the
    //     tranche COUNTED on the treasury's books and not merely held in its
    //     jetton wallet; the read-back below asserts that, not just the lock's
    //     own `releasedAmount`.
    await d.treasuryVesting.sendRelease(env.genesisSender, { value: toNano('0.15') });
    await env.settle?.('vesting:treasury-tranche-0');
    const trVestAfter = await d.treasuryVesting.getVesting();
    if (trVestAfter.releasedAmount === 0n) {
        throw new Error("genesis: the treasury vesting lock's tranche 0 did not release");
    }
    const trBal = await d.treasury.getTreasuryBalances();
    if (trBal.primesBalance !== trVestAfter.releasedAmount) {
        throw new Error(
            `genesis: the treasury lock released ${trVestAfter.releasedAmount} but the treasury ` +
                `books show ${trBal.primesBalance} — the transfer_notification did not land`
        );
    }
    log(
        `treasury vesting tranche 0 released: ${trVestAfter.releasedAmount} nanoPRIMES, ` +
            `counted on the treasury's books (primesBalance = ${trBal.primesBalance}).`
    );

    // 6. seal the jetton authority — irreversible; after this only the ledger can
    //    mint, and only as a mint rebate (CONCEPT §5).
    await d.master.sendSealAuthority(env.genesisSender, { value: toNano('0.05') });
    await env.settle?.('jetton:seal');
    const jettonData = await d.master.getJettonData();
    if (jettonData.genesisSealed !== 1) {
        throw new Error('genesis: jetton authority did not seal');
    }
    log('jetton authority sealed');

    // 7. open minting: seed T/S and set the head to OPENING_HEAD (D-20: no genesis auction set).
    //    D-46: T seeds at 0 — there is no real deposit backing it at deploy.
    //    S₀ = the treasury's vested allocation + bounty vault (D-166). The ledger asserts `T == 0 && S == 0` here, so a mis-ordered
    //    genesis fails loudly rather than erasing accrued backing.
    const seedT = 0n;
    // MEASURED, NOT RESTATED. `S` is the denominator of `p_f = T/S` forever, and
    // this used to be `allocationResult.primesMinted + params.bountyVaultPrimes`
    // — the quantities the script INTENDED to mint. Any mint above that silently
    // failed would seed an `S` larger than the PRIMES that exist, permanently
    // depressing the floor against backing nobody holds, and the seal at
    // `jetton:seal` has already closed minting so it could never be corrected.
    // Reading the master's own `totalSupply` makes a failed mint impossible to
    // miss instead of impossible to fix. `resumeGenesisTail.ts` has always done
    // it this way; the pipeline did not.
    const mintedSupply = (await d.master.getJettonData()).totalSupply;
    const intendedSupply = allocationResult.primesMinted + params.bountyVaultPrimes;
    if (mintedSupply !== intendedSupply) {
        throw new Error(
            `genesis minted ${mintedSupply} nanoPRIMES but the allocation and the bounty vault ` +
                `account for ${intendedSupply} — a mint failed silently. Seeding S from the intended ` +
                `figure would set the floor's denominator against PRIMES that do not exist, and the ` +
                `authority is already sealed, so it could never be corrected. Read the master's ` +
                `transactions before re-running anything.`
        );
    }
    const seedS = mintedSupply;
    // D-20: the head opens at the first number the head is DEFINED on, not past
    // a fixed auctioned set. `OPENING_HEAD` is 4 because Unity mints at 1 and
    // 2 and 3 are prime — there is no set K to move past any more.
    const seedHead = OPENING_HEAD;
    // D-20 DROPS `unsoldMask` from `GenesisSeed`, and now drops the caller-side
    // check with it. CONCEPT §6 point 2 still holds — every prime starts unsold,
    // and therefore forfeiting to the treasury — but it is no longer declared by
    // the caller at all: `sendGenesisSeed`'s walk from the current head to
    // `seedHead` marks every prime it crosses as unsold automatically. The old
    // `unsoldMaskOf` pre-flight validated lots against the fixed set K; with no
    // set K, there is nothing left for it to reject.
    await d.ledger.sendGenesisSeed(env.genesisSender, { seedT, seedS, seedHead, value: toNano('0.2') });
    await env.settle?.('ledger:genesis-seed');
    // READ IT BACK. `settle()` waits for the deploy wallet's seqno to advance,
    // and a seqno advances whether the destination accepted the message or threw
    // — so until this check, `minting open:` printed the values it had SENT and
    // the pipeline reported `genesis complete` on a genesis whose seed had
    // aborted (2026-09-19, `20260923`: compute exit 104, bounced, nothing
    // seeded, and nobody found out until a donation read `S = 0` an hour later).
    // The seed is the step that opens the game; a silent failure here leaves a
    // deployment that looks finished and cannot mint.
    const seededHead = await d.ledger.getHead();
    const seededS = await d.ledger.getFloorDen();
    if (BigInt(seededHead) !== BigInt(seedHead) || seededS < seedS) {
        throw new Error(
            `genesis seed did not land: ledger reads head ${seededHead} (expected ${seedHead}) and ` +
                `S ${seededS} (expected at least ${seedS}). The external was accepted and the seqno ` +
                `advanced, so this is a COMPUTE-phase failure at the ledger — read the transaction ` +
                `before re-running anything.`
        );
    }
    log(`minting open: T=${seedT} S=${seededS} head=${seededHead}  (read back, not assumed)`);

    // 8. queue the venue timelock with the DeDust vault/pool addresses. This is
    //    a QUEUE, not an execute: it matures 30 days later and anyone may
    //    execute it then (engineering-spec §6). The ratchet already carries these
    //    addresses from its own deploy data; queueing them makes the very first
    //    venue change go through the same public, permissionlessly-executable
    //    path every later one must, rather than leaving the timelock untested
    //    and unused until the first emergency.
    //    The eta is the DIVIDED delay (D-139): the contract enforces only
    //    `eta >= now + TIMELOCK_DELAY / clockDivisor`, so the undivided 30 days was
    //    accepted on a 1-hour-clock set and parked the change a month out, where
    //    `execute` could not reach it and `timelock.ts queue` refused to queue over it.
    const eta = env.now() + Math.floor(TIMELOCK_DELAY / (params.clockDivisor || 1)) + 60;
    await d.timelock.sendQueue(env.proposerSender, {
        dedustNativeVault: params.dedustNativeVault,
        dedustPool: params.dedustPool,
        primesJettonVault: params.primesJettonVault,
        eta,
        value: toNano('0.1'),
    });
    await env.settle?.('timelock:queue');
    const queued = await d.timelock.getQueued();
    if (queued.hasQueued !== 1) {
        throw new Error('genesis: venue timelock queue did not land');
    }
    log(`venue timelock queued, eta=${eta}`);

    return { allocationResult, seedT, seedS, seedHead, venueEta: eta };
}

/**
 * THE GENESIS DONATION — D-100 point 2 REVERSES D-92'S ARROW, D-154 RESIZES IT.
 *
 * D-92 declared the opening floor and solved for the donation:
 * `X = S₀ / (1/p_f − L)` = 12,000,000 / (60,000 − 10,000) = 240 GRAM. The method
 * was fine; the input is not available any more. D-100 point 2 recorded 4.20 GRAM
 * at genesis plus up to 150 GRAM incrementally afterwards (point 3); **D-154
 * front-loads that whole commitment** — the operator funds **132.50 GRAM at
 * genesis**, because D-140 pins the pair at the floor and so makes opening depth
 * quadratic in this figure (17.39 GRAM of book at 132.50 then; ~14.13 since D-166
 * took the operator's tranche out of the pair and S₀ to 11,000,000, counting the
 * donor's own mint in the floor's `S`). The donation is the OWNER-SET INPUT and
 * `genesis.genesis_floor_price_ton_per_primes` (1.0761e-5) is what the sim derives
 * from it — see `run_phase1.py`'s `_genesis_donation_source`.
 *
 * So this function no longer computes anything. It is kept, rather than deleted
 * in favour of a raw `params.genesis.genesis_donation_ton` at each call site,
 * for the reason it existed in the first place: `donateFloor.ts` and the sandbox
 * rehearsal must not be able to disagree about what genesis donates, and one
 * exported name is what stops them. Running D-92's formula against the current
 * file would yield 4.2148 GRAM — close enough to look right in a log line and
 * wrong enough to open the floor at a figure params.json does not state.
 *
 * `T > 0` (D-93) is what makes a donation this small legal at all, and D-100
 * point 1's `min(X·L, X·S/T)` is what keeps a LATE one from minting above the
 * floor.
 */
export function genesisDonationTon(g: { genesis_donation_ton: number }): number {
    if (!(g.genesis_donation_ton > 0)) {
        throw new Error(
            'genesis: shared/params.json has no positive genesis.genesis_donation_ton. It is D-100 ' +
                "point 2's owner-set figure, regenerated by `python sim/scripts/run_phase1.py` — it is " +
                'not derived here and must not be defaulted.'
        );
    }
    return g.genesis_donation_ton;
}

/** The `genesis` block of `shared/params.json`, as much of it as the pair needs. */
export type GenesisPairingParams = {
    genesis_donation_ton: number;
    genesis_lp_ratio_primes_per_ton: number;
    genesis_floor_price_ton_per_primes: number;
    genesis_donation_primes: number;
};

/**
 * The PRIMES side of the manual DeDust pair, computed rather than quoted.
 *
 * D-100 point 1: `donate_floor` mints `min(X·L, X·S/T)` to the donor. At genesis
 * `T = 0`, so the clamp is inactive and the flat `L` applies — and then D-156's
 * supply taper, `(S_MAX − S)/S_MAX`, which every `S +=` site applies. 132.50 GRAM
 * donated mints 1,312,854.17 PRIMES (NOT `X·L` = 1,325,000: the 2026-09-24
 * testnet genesis measured it), and THAT is the whole pairing inventory. D-140
 * added the operator's first vest tranche (250,000) to it; D-166 deleted the
 * operator's lock and the tranche with it, so the pair is the donation's PRIMES
 * alone, rounded down to whole PRIMES so it never exceeds what the donor holds.
 * The figure is the sim's `genesis.genesis_donation_primes`, not recomputed here.
 *
 * No contract in this repo builds the deposit, because there is no verified
 * DeDust deposit wire format (deviation D6, filed to GAUNTLET).
 */
export function genesisPairingPrimes(g: GenesisPairingParams): number {
    genesisDonationTon(g);
    if (!(g.genesis_donation_primes > 0)) {
        throw new Error(
            'genesis: shared/params.json has no positive genesis.genesis_donation_primes — ' +
                're-run `python sim/scripts/run_phase1.py`.'
        );
    }
    return Math.floor(g.genesis_donation_primes);
}

/**
 * The GRAM side of that same pair — D-140, and the whole of the decision in one
 * line of arithmetic.
 *
 * **On an empty pool the deposit ratio IS the price.** Posting `primes * p_f`
 * opens the market at `p_f = T/S` exactly, which is what makes §4.3.1's floor
 * guard — `flush()` refuses to buy above the floor — fillable from the first
 * mint instead of bouncing every attempt. Quoting the pair at `L` instead (D-39's
 * denomination knob, the rate `donate_floor` MINTS at, never a price) is what
 * opened the book 286× over the floor.
 *
 * Rounds DOWN, in nanoGRAM, because the chain's granularity has to land
 * somewhere and below the floor is the safe side: a book a nanoGRAM under `p_f`
 * is a book `flush()` fills, and a book a nanoGRAM over is one it refuses.
 */
export function genesisPairingTon(g: GenesisPairingParams): number {
    const nanotonPerPrimes = Math.floor(g.genesis_floor_price_ton_per_primes * 1e9);
    return (genesisPairingPrimes(g) * nanotonPerPrimes) / 1e9;
}

/**
 * The manual pairing runbook, as one block of text, printed at the end of a
 * genesis run and asserted on by `GenesisRehearsal.spec.ts`.
 *
 * It is a function rather than a `log()` call in place so the rehearsal can
 * check that the four addresses an auditor needs actually appear — the treasury,
 * the LP sink, the sink's own LP jetton wallet (what `getLocked()` is compared
 * against) and the ledger the donation goes to.
 */
export function pairingInstructions(
    g: GenesisPairingParams,
    d: Pick<GenesisDeployment, 'ledger' | 'treasury' | 'lpSink'>,
    lpSinkJettonWallet: Address
): string {
    const ton = genesisDonationTon(g);
    const primes = genesisPairingPrimes(g);
    const pairTon = genesisPairingTon(g);
    return [
        '',
        '=== D-100/D-140: MANUAL STEPS AFTER THIS SCRIPT ===',
        `  treasury (governed, no key) : ${d.treasury.address.toString()}`,
        `  LP sink (locked depth)      : ${d.lpSink.address.toString()}`,
        `  LP sink's LP jetton wallet  : ${lpSinkJettonWallet.toString()}`,
        '      ^ this is the balance getLocked() must equal. Compare them, do not trust one.',
        '',
        `  1. donate ${ton} GRAM to the ledger ${d.ledger.address.toString()}`,
        '     (scripts/donateFloor.ts — permissionless; it defaults to exactly this figure)',
        `     It mints you ${primes} PRIMES: X·L (T = 0, so D-100 point 1's clamp is inactive) less D-156's taper.`,
        '     THAT is the pairing inventory (D-166: there is no operator vest tranche to add).',
        `  2. pair those ${primes} PRIMES against ${pairTon} GRAM of your own on DeDust, BY HAND.`,
        '     D-140: the GRAM side is `PRIMES × p_f`, NOT `PRIMES ÷ L`. On an empty pool the deposit',
        '     ratio sets the price, and this one opens the market AT the floor, which is where',
        '     §4.3.1 lets flush() fill. Pairing at L opens it 286× above the floor instead.',
        '     No contract here builds that deposit: there is no verified DeDust deposit wire',
        '     format, so D-100 (R1-2) keeps the pair manual rather than guessing one.',
        '  3. send the LP receipt to the SINK above, forever — D-154 decides this for the',
        '     GENESIS pair: opening depth is locked depth, readable by getLocked() and',
        '     withdrawable by nobody. The treasury `deposit` payload (a custody position,',
        '     withdrawable at term, carrying the vote only — D-168) is the route for LATER positions.',
        '  4. ignite (scripts/ignite.ts). The ledger refuses until step 1 has landed (218).',
        '',
    ].join('\n');
}

/**
 * D-92/D-93 — THE FLOOR DONATION, between the seed and the launch.
 *
 * `completeGenesis` leaves `T = 0`, so `p_f = T/S` does not exist yet, and
 * `ignite` refuses to launch until it does (218 `ledger_floor_unbacked`). The
 * reason that is a chain assert and not a runbook line: the rebate is
 * `R = k·I·S/T` (math-note §2), unbounded as `T → 0`, so a mint against an
 * unbacked floor emits ~20% of the genesis supply for 1 GRAM against 0.28% once
 * the donation has landed (`tests/UnbackedFloorLaunch.spec.ts` measures both).
 *
 * `donate_floor` is permissionless and asserts no launch flag, so this step has
 * no privileged sender and no ordering constraint beyond "after the seed". It
 * is incremental too: call it once with the full amount, or in tranches — and
 * after D-100 point 3 the operator's own further outlay (up to 150 GRAM) comes
 * through this same message, so "incremental" is the normal case rather than a
 * testnet convenience. The genesis figure itself is D-154's 132.50 GRAM;
 * `genesisDonationTon` above is the one definition of it.
 *
 * A NOTE ON THE TWO NUMBERS THIS STEP IS BETWEEN, because they used to be one.
 * `genesis.genesis_seed_ton` (200) is a NOMINAL that sizes `S₀` and the pool
 * depth the sim models — no GRAM ever moves for it. `genesis.genesis_donation_ton`
 * (132.50) is the GRAM that actually lands in `T`, here. Before D-100 point 2 they
 * were made equal by construction (D-92 chose the donation to reproduce
 * `seed/S₀`), so a script could read either and be right; that coincidence is
 * gone and reading the seed here would donate 200 GRAM.
 */
export async function donateGenesisFloor(env: GenesisEnv, d: GenesisDeployment, amount: bigint) {
    const log = env.log ?? (() => {});
    // The ledger asserts `value >= amount + ratchet hop + jetton-mint gas`; the
    // margin is the standing testnet rule (never send exactly the nominal).
    await d.ledger.sendDonateFloor(env.genesisSender, { amount, value: amount + toNano('0.06') });
    await env.settle?.('ledger:donate_floor');

    const T = await d.ledger.getFloorNum();
    if (T === 0n) {
        throw new Error('genesis: donate_floor did not move T — the ledger would refuse to ignite (218)');
    }

    // D-52. `donate_floor` credits `S` and then sends the donor their PRIMES as
    // a separate message to the jetton master, so the two legs can disagree: if
    // that mint bounces (authority unsealed = 400, wired elsewhere = 401, or an
    // under-margined value), the ledger parks the emission in `unmintedMints`
    // and `S` carries PRIMES nobody holds. That is survivable — `retry_mint`
    // pays it out later — but it must not pass silently through genesis, where
    // it means a step of the bootstrap did not actually finish. The ledger
    // publishes the shortfall, so check it rather than deriving the donor's
    // jetton-wallet address to weigh it.
    const unminted = await d.ledger.getUnmintedHeld();
    if (unminted !== 0n) {
        throw new Error(
            `genesis: donate_floor credited S but the donor's PRIMES bounced — ${unminted} parked in unmintedMints. `
            + 'Fix the jetton master wiring, then replay with retry_mint before igniting.',
        );
    }

    log(`floor donated: T=${T} S=${await d.ledger.getFloorDen()}`);
    return T;
}

/**
 * CONCEPT §6 point 0 — THE LAUNCH, and the one step of genesis that is not part
 * of `completeGenesis`.
 *
 * It is deliberately separate. Everything `completeGenesis` does is plumbing:
 * fund the pool, arm the counters, seal the authority, seed T/S. None of it is a
 * decision, and all of it can be re-run in a fresh deploy if it goes wrong.
 * Ignition is the decision — it mints Unity to the founder and opens every path
 * that takes player money — so it gets its own transaction, its own moment, and
 * its own script (`scripts/ignite.ts`). `runGenesis` performs it only when a
 * caller explicitly names the owner; the real deploy script never does.
 *
 * The ledger refuses to ignite unless the sinks, the peers, the `S` seed AND a
 * backed floor (`T > 0`, from `donateGenesisFloor` above — D-93) are all in
 * place, so a successful call here is by itself the proof that the deployment
 * ahead of it completed.
 */
export async function igniteGame(env: GenesisEnv, d: GenesisDeployment, unityOwner: Address) {
    const log = env.log ?? (() => {});
    await d.ledger.sendIgnite(env.genesisSender, { owner: unityOwner, value: toNano('0.25') });
    await env.settle?.('ledger:ignite');

    // Read back BOTH flags rather than one. `ignite` flips the ledger's own bit
    // synchronously but opens the market by NoBounce fan-out, so "the ledger
    // says launched" is exactly the claim that does NOT establish the other. If
    // the market is still closed, `sendSyncLaunch` re-sends — which is why that
    // message is permissionless.
    //
    // P2.A7: this used to check three peers, because `launch_open` fanned out to
    // three market contracts and any one of them could land while the others
    // bounced. One peer means one send and one flag, so
    // the partial-launch state this loop existed to detect no longer has three
    // ways to happen — but it still has one, and the check is still load-bearing.
    const launch = await d.ledger.getLaunch();
    if (!launch.launched) {
        throw new Error('genesis: ignite did not set the ledger launch flag');
    }
    const peers = {
        market: await d.market.getLaunched(),
    };
    const closed = Object.entries(peers)
        .filter(([, open]) => !open)
        .map(([name]) => name);
    if (closed.length > 0) {
        throw new Error(
            `genesis: ignite left ${closed.join(', ')} closed — re-run the permissionless sync_launch`
        );
    }
    log(`IGNITED: Unity (#1) minted to ${unityOwner.toString()}, ${launch.itemsMinted} item(s) in the collection`);
    return { unityOwner, unityItem: await d.ledger.getItemAddress(1n), ...launch };
}

/** Convenience: the whole pipeline, with a hook to let bids happen. */
export async function runGenesis(
    env: GenesisEnv,
    code: GenesisCode,
    params: GenesisParams,
    hooks: {
        onAuctionOpen?(d: GenesisDeployment): Promise<void>;
        /**
         * CONCEPT §6 point 0. Supply an address to ignite in the same run —
         * Unity is minted to it and every player-facing path opens. Omit it, and
         * the deployment lands COMPLETE BUT CLOSED, which is what the real
         * deploy script does: `scripts/ignite.ts` is the founder's own separate
         * transaction, and the whole point of the flag is that the moment the
         * game starts is a moment somebody chose.
         *
         * Sandbox rehearsals pass it, because a rehearsal that stops short of
         * the launch has not rehearsed the launch.
         */
        unityOwner?: Address;
    }
) {
    const d = await deployAndWire(env, code, params);

    // D-46 (supersedes the CONCEPT §6 point 3 founder-seed reading). The ORDER
    // is still the fix: the treasury's vested allocation (D-166), the vault, the
    // sealed jetton and the open head all land here, BEFORE a single bid, so
    // minting and the market are ready from the first block — none of that depended
    // on a real deposit existing, only on this pipeline running in order.
    const result = await completeGenesis(env, params, d, params.seedTon);

    // CONCEPT §6 point 0: the last thing, or nothing at all. Ordered AFTER
    // `completeGenesis` and BEFORE any bid, because the market refuses every
    // open and bid until `launch_open` lands.
    const launch = hooks.unityOwner ? await igniteGame(env, d, hooks.unityOwner) : null;

    await hooks.onAuctionOpen?.(d);

    // D-100 — the last thing printed is what a human still has to do by hand.
    // `lpWalletFor` is a get-call, so re-reading it here costs nothing and keeps
    // the printed address the one the sink is actually bootstrapped with rather
    // than one this function recomputed a different way.
    const instructions = pairingInstructions(
        {
            genesis_donation_ton: params.donationTon,
            genesis_lp_ratio_primes_per_ton: params.lpPrimesPerTon,
            genesis_floor_price_ton_per_primes: params.genesisFloorPriceTonPerPrimes,
            genesis_donation_primes: params.donationPrimes,
        },
        d,
        await env.lpWalletFor(d.lpSink.address)
    );
    (env.log ?? (() => {}))(instructions);

    return { deployment: d, launch, instructions, ...result };
}

export { PrimesItem };
