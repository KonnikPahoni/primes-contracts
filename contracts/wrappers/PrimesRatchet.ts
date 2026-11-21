import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractProvider,
    contractAddress,
    Sender,
    SendMode,
} from '@ton/core';
import { RATCHET } from '../../shared/opcodes';
import { clockDivisorOf } from './PrimesMarket';
import {
    FLUSH_CALLER_GAS_NANOTON,
    STAKE_CALLER_GAS_NANOTON,
    UNSTAKE_CALLER_GAS_NANOTON,
    HARVEST_CALLER_GAS_NANOTON,
    FEE_MARGIN_NANOTON,
    buildFlushMessage,
} from '../../shared/messages';

/**
 * D-146 — what a caller attaches to each permissionless leg: the contract's required
 * figure (venue gas + its own compute, `shared/messages.ts`) plus the standing fee margin.
 * Below the required figure the leg refuses 225; the change above it comes back.
 */
export const FLUSH_VALUE = FLUSH_CALLER_GAS_NANOTON + FEE_MARGIN_NANOTON;
export const STAKE_VALUE = STAKE_CALLER_GAS_NANOTON + FEE_MARGIN_NANOTON;
export const UNSTAKE_VALUE = UNSTAKE_CALLER_GAS_NANOTON + FEE_MARGIN_NANOTON;
export const HARVEST_VALUE = HARVEST_CALLER_GAS_NANOTON + FEE_MARGIN_NANOTON;

/**
 * TON PRIMES — Ratchet wrapper (UPGRADE_PLAN_V5.md §4 B1 / B3).
 *
 * `pending`, `flush()`, the DeDust leg and the burn, split out of the retired
 * primes_bank.tolk so that "there is no admin withdraw path" is verifiable by
 * reading ONE contract's outbound set.
 */

/** outcome ∈ {never, filled, bounced} — §9.1 / §12. */
export const FlushOutcome = {
    Never: 0,
    Filled: 1,
    Bounced: 2,
} as const;

export type RatchetConfig = {
    /** Bootstrapped post-deploy via SetLedger (circular address dependency). */
    ledgerAddr?: Address;
    venueTimelockAddr: Address;
    genesisScriptAddr: Address;
    dedustNativeVault: Address;
    dedustPool: Address;
    primesJettonVault: Address;
    /**
     * §4.3.2 / D-151 — the staked reserve's venue. All four default to
     * `genesisScriptAddr`, the same placeholder the PRIMES jetton wallet slot
     * uses before its own bootstrap: a ratchet deployed without them simply
     * cannot stake (`Stake` refuses on `tstonWalletSet == 0` first, 231), which
     * is what a half-wired genesis should look like.
     */
    tonstakersPool?: Address;
    /** DeDust's tsTON JETTON vault — leg 2's transfer destination. */
    dedustTstonVault?: Address;
    /** DeDust's tsTON/TON pool — leg 2's `SwapStep.pool_addr`. */
    dedustTstonPool?: Address;
    /** The LP-governed treasury — `harvest()`'s only destination. */
    treasuryAddr?: Address;
    /** The native vault of the factory `dedustTstonPool` is on — leg 2's payout
     *  sender. Defaults to `dedustNativeVault`: at deploy both pools are on one factory. */
    dedustTstonNativeVault?: Address;
    /**
     * D-139 — THE TEST CLOCK. Divides `FLUSH_COOLDOWN` (86400). 1 is mainnet and
     * the identity; 168 makes the cooldown ~8.5 minutes. Deploy-time only.
     * Genesis reads it from `PRIMES_AUCTION_SECONDS`, the same divisor the
     * market gets, so every clock in a set moves together.
     */
    clockDivisor?: number;
    /**
     * D-153 — the same idea on the other axis. `clockDivisor` scales what this
     * contract enforces in SECONDS; this scales the one thing it enforces in
     * TON, `STAKE_MIN` (500). 1 is mainnet and the identity.
     *
     * Its reason for existing is arithmetic: the liquid reserve is 20% of the
     * obligation, so `stake` is illegal until `pending` exceeds 625 TON, and on
     * testnet the only permissionless route into `pending` is a `donate_floor`
     * that §8 makes irreversible. Genesis reads it from `PRIMES_STAKE_MIN_TON`
     * — the MINIMUM an operator wants, not the divisor — exactly as the clock is
     * read from `PRIMES_AUCTION_SECONDS`.
     */
    stakeDivisor?: number;
};

/**
 * D-153. `STAKE_MIN` is 500 TON and a `uint16` holds the divisor, so the
 * reachable range is a minimum of 500 TON down to ~0.0076 TON. Refuses 0 for
 * the same reason `clockDivisorOf` does: the contract reads 0 as 1, so an
 * accidental 0 is a lie about the gate rather than a fast one.
 */
function stakeDivisorOf(divisor: number | undefined): number {
    const d = divisor ?? 1;
    if (!Number.isInteger(d) || d < 1 || d > 65535) {
        throw new Error(`stakeDivisor must be an integer in 1..65535 (got ${d})`);
    }
    return d;
}

function cfgCell(c: RatchetConfig): Cell {
    return beginCell()
        .storeAddress(c.ledgerAddr ?? c.genesisScriptAddr)
        .storeAddress(c.venueTimelockAddr)
        .storeAddress(c.genesisScriptAddr)
        .storeUint(clockDivisorOf(c.clockDivisor), 16)   // D-139
        .storeUint(stakeDivisorOf(c.stakeDivisor), 16)   // D-153
        .endCell();
}

/**
 * §4.3.2's three addresses plus the treasury, as the ref chain
 * `VenueStaking -> VenueTreasury`. Seven venue addresses is 1,869 bits and a
 * cell holds 1,023, so the split is arithmetic rather than taste. Deploy data
 * only: since D-194 no message rewrites it (`update_venue` copies it forward).
 */
function stakingVenueCell(c: {
    genesisScriptAddr: Address;
    tonstakersPool?: Address;
    dedustTstonVault?: Address;
    dedustTstonPool?: Address;
    treasuryAddr?: Address;
    dedustNativeVault: Address;
    dedustTstonNativeVault?: Address;
}): Cell {
    return beginCell()
        .storeAddress(c.tonstakersPool ?? c.genesisScriptAddr)
        .storeAddress(c.dedustTstonVault ?? c.genesisScriptAddr)
        .storeAddress(c.dedustTstonPool ?? c.genesisScriptAddr)
        .storeRef(
            beginCell()
                .storeAddress(c.treasuryAddr ?? c.genesisScriptAddr)
                .storeAddress(c.dedustTstonNativeVault ?? c.dedustNativeVault)
                .endCell()
        )
        .endCell();
}

function venueCell(c: RatchetConfig): Cell {
    return beginCell()
        .storeAddress(c.dedustNativeVault)
        .storeAddress(c.dedustPool)
        .storeAddress(c.primesJettonVault)
        .storeRef(stakingVenueCell(c))
        // `Venue.openTrip` (audit R2-M1): null at deploy — nothing is in flight.
        .storeMaybeRef(null)
        .endCell();
}

/**
 * §4.3.2 / D-151 — the staked reserve, deployed empty and idle. The rate pair is
 * seeded 1/1 rather than 0/0 so `harvest()`'s division is defined before any
 * deposit has taught it a real one; at 1/1 `costInTston == stakedCost == 0` and
 * the first harvest refuses on dust, which is the correct answer.
 */
function stakingCell(c: RatchetConfig): Cell {
    const meta = beginCell()
        .storeUint(1, 64) // lastRateNum
        .storeUint(1, 64) // lastRateDen
        .storeUint(0, 32) // lastHarvestTime
        .storeUint(0, 8) // exitLeg — EXIT_IDLE
        .storeUint(0, 32) // exitStartedAt — D-155; 0 while idle
        .storeUint(0, 32) // stakeStartedAt — 0 unless a stake is open
        .storeCoins(0) // writtenOff — written-off stake cost not yet restored by a late arrival (accumulates)
        .storeCoins(0) // stakeCredited — audit H2: the open stake's part matched by unauthenticated tsTON
        .storeCoins(0) // recoveredExit — audit H2 nit 3: a recovered exit's tranche, whose late reply is not new tsTON
        .storeAddress(c.genesisScriptAddr) // tstonWalletAddr placeholder
        .storeUint(0, 8) // tstonWalletSet
        .endCell();
    return beginCell()
        .storeCoins(0) // stakedCost
        .storeCoins(0) // exiting
        .storeCoins(0) // tstonHeld
        .storeCoins(0) // inFlightStake
        .storeCoins(0) // inFlightExit
        .storeCoins(0) // exitCostBasis
        .storeCoins(0) // realizedLoss
        .storeRef(meta)
        .endCell();
}

/**
 * The burn ledger (§3.3 / §11.21). Deployed empty and idle: the wallet address
 * is a placeholder until the genesis script sends SetJettonWallet, exactly like
 * the vault's own wallet bootstrap. `walletSet = 0` means "counting not armed",
 * which `getBurnStats` reports rather than hiding behind a zero total.
 */
function burnCell(c: RatchetConfig): Cell {
    return beginCell()
        .storeCoins(0) // burnedPrimes
        .storeUint(0, 32) // burnEvents
        .storeAddress(c.genesisScriptAddr) // jettonWalletAddr placeholder
        .storeUint(0, 8) // walletSet
        .endCell();
}

function ratchetConfigToCell(c: RatchetConfig): Cell {
    return beginCell()
        .storeCoins(0) // pending
        .storeCoins(0) // swapped
        .storeCoins(0) // inFlightFlush
        .storeCoins(0) // tCache
        .storeCoins(0) // sCache
        .storeUint(0, 64) // lastFlushTime
        .storeUint(0, 64) // lastAttemptTime
        .storeCoins(0) // lastAttemptAmount
        .storeUint(FlushOutcome.Never, 8) // lastOutcome
        .storeCoins(0) // lastMinOut
        .storeUint(c.ledgerAddr ? 1 : 0, 8) // linked
        .storeRef(cfgCell(c))
        .storeRef(venueCell(c))
        .storeRef(burnCell(c))
        .storeRef(stakingCell(c))
        .endCell();
}

export class PrimesRatchet implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesRatchet(address);
    }

    static createFromConfig(config: RatchetConfig, code: Cell, workchain = 0) {
        const data = ratchetConfigToCell(config);
        const init = { code, data };
        return new PrimesRatchet(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendSetLedger(
        provider: ContractProvider,
        via: Sender,
        opts: { ledgerAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RATCHET.set_ledger, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.ledgerAddr)
                .endCell(),
        });
    }

    /** One-shot, genesis script only. Arms the burn counter; grants no authority. */
    async sendSetJettonWallet(
        provider: ContractProvider,
        via: Sender,
        opts: { jettonWalletAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RATCHET.set_jetton_wallet, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.jettonWalletAddr)
                .endCell(),
        });
    }

    /** One-shot, genesis script only. §4.3.2's second wallet bootstrap. */
    async sendSetTstonWallet(
        provider: ContractProvider,
        via: Sender,
        opts: { tstonWalletAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RATCHET.set_tston_wallet, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.tstonWalletAddr)
                .endCell(),
        });
    }

    /**
     * §4.3.2's three permissionless triggers. NONE OF THEM CARRIES AN AMOUNT —
     * each leg's size is computed by the contract from `reserveTarget`, so a
     * caller can trigger the rule and cannot aim it (§11.14, D-151).
     */
    private async sendTrigger(provider: ContractProvider, via: Sender, op: number, value: bigint, queryID = 0) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(op, 32).storeUint(queryID, 64).endCell(),
        });
    }

    async sendStake(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await this.sendTrigger(provider, via, RATCHET.stake, opts.value, opts.queryID ?? 0);
    }

    async sendUnstake(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await this.sendTrigger(provider, via, RATCHET.unstake, opts.value, opts.queryID ?? 0);
    }

    async sendHarvest(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await this.sendTrigger(provider, via, RATCHET.harvest, opts.value, opts.queryID ?? 0);
    }

    /**
     * D-155 — the stranded-exit backstop. Permissionless and amountless like the
     * three above, and weaker still: it credits nothing, it only puts a tranche
     * no reply can reach any more back where `unstake` found it. Refuses 232
     * until `now − exitStartedAt ≥ getExitLeg().recoverAfter`.
     */
    async sendRecoverExit(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await this.sendTrigger(provider, via, RATCHET.recover_exit, opts.value, opts.queryID ?? 0);
    }

    /** Only the ledger may send this; exposed for negative tests. */
    async sendPoolInject(
        provider: ContractProvider,
        via: Sender,
        opts: { amount: bigint; tSnapshot: bigint; sSnapshot: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RATCHET.pool_inject, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.amount)
                .storeCoins(opts.tSnapshot)
                .storeCoins(opts.sSnapshot)
                .endCell(),
        });
    }

    /**
     * `amount` is VENUE-DEPTH SIZING: a ceiling the caller may LOWER, never raise. The
     * handler takes `min(amount, autoSize)` and reads 0 (the default) as "size it
     * yourself". See `shared/schemas/ratchet.tlb`'s `flush#b0000006` for why a
     * permissionless size is safe — `min_out` is linear in `amount`, so the guard is a
     * per-unit price and no choice here can buy above `p_f`.
     */
    async sendFlush(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; queryID?: number; amount?: bigint },
    ) {
        // G61: the shared builder's bytes; `value` stays the caller's, because the suite
        // sends under-funded flushes on purpose (D-146's 225 refusal).
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buildFlushMessage({ queryId: BigInt(opts.queryID ?? 0), amountNanoton: opts.amount ?? 0n }).body,
        });
    }

    async getPending(provider: ContractProvider) {
        return (await provider.get('getPending', [])).stack.readBigNumber();
    }
    async getSwapped(provider: ContractProvider) {
        return (await provider.get('getSwapped', [])).stack.readBigNumber();
    }
    async getInFlightFlush(provider: ContractProvider) {
        return (await provider.get('getInFlightFlush', [])).stack.readBigNumber();
    }

    /** Seconds after which an unanswered flush round trip expires (`flushIsStale`). */
    async getFlushStaleSec(provider: ContractProvider) {
        return Number((await provider.get('getFlushStaleSec', [])).stack.readBigNumber());
    }
    async getLastMinOut(provider: ContractProvider) {
        return (await provider.get('getLastMinOut', [])).stack.readBigNumber();
    }
    async getLastFlushTs(provider: ContractProvider) {
        return (await provider.get('getLastFlushTs', [])).stack.readBigNumber();
    }

    /**
     * §3.3 / §9.1 / §11.21 — the burn half of the circulating-supply report.
     *
     * `counting === 0` means the genesis script has not wired this contract's jetton
     * wallet yet, so `burnedPrimes` is a floor rather than a measurement. Callers must
     * distinguish the two; the dashboard renders the unarmed case as unavailable rather
     * than as "0 burned".
     */
    async getBurnStats(provider: ContractProvider) {
        const r = await provider.get('getBurnStats', []);
        return {
            burnedPrimes: r.stack.readBigNumber(),
            burnEvents: r.stack.readNumber(),
            counting: r.stack.readNumber(),
        };
    }

    /** The wallet whose notifications are counted — checkable against the master. */
    async getBurnWallet(provider: ContractProvider) {
        const r = await provider.get('getBurnWallet', []);
        return { jettonWalletAddr: r.stack.readAddress(), walletSet: r.stack.readNumber() };
    }

    /** §12 / §9.1: (last_attempt_time, outcome, amount, cooldown_remaining). */
    async getFlushStatus(provider: ContractProvider) {
        const r = await provider.get('getFlushStatus', []);
        return {
            lastAttemptTime: r.stack.readNumber(),
            outcome: r.stack.readNumber(),
            amount: r.stack.readBigNumber(),
            cooldownRemaining: r.stack.readNumber(),
        };
    }

    /** The pushed (T, S) mirror the floor guard prices against. */
    async getFloorCache(provider: ContractProvider) {
        const r = await provider.get('getFloorCache', []);
        return { t: r.stack.readBigNumber(), s: r.stack.readBigNumber() };
    }

    /**
     * The one-call oracle `docs/floor-as-collateral.md` names for external risk
     * engines: (tCache, sCache, pending, swapped, lastOutcome, lastAttemptTime).
     * No internal caller by design — see that doc §1 — this wrapper method exists
     * so the shape can be pinned in a test, not for production use.
     */
    async getFloorOracle(provider: ContractProvider) {
        const r = await provider.get('getFloorOracle', []);
        return {
            t: r.stack.readBigNumber(),
            s: r.stack.readBigNumber(),
            pending: r.stack.readBigNumber(),
            swapped: r.stack.readBigNumber(),
            lastOutcome: r.stack.readNumber(),
            lastAttemptTime: r.stack.readNumber(),
        };
    }

    /** §3.4's one-get-call solvency property: (balance, liability, delta). */
    async getSolvency(provider: ContractProvider) {
        const r = await provider.get('getSolvency', []);
        return {
            balance: r.stack.readBigNumber(),
            liability: r.stack.readBigNumber(),
            delta: r.stack.readBigNumber(),
        };
    }

    /**
     * §4.3.2 / §9.1 — the staked reserve in one call. `reserveTarget` is DERIVED
     * (RESERVE_BPS of `pending + stakedCost + exiting`), never stored, and
     * `realizedLoss` sits beside `stakedCost` rather than netted into it.
     */
    async getStaking(provider: ContractProvider) {
        const r = await provider.get('getStaking', []);
        return {
            stakedCost: r.stack.readBigNumber(),
            tstonHeld: r.stack.readBigNumber(),
            exiting: r.stack.readBigNumber(),
            lastRateNum: r.stack.readBigNumber(),
            lastRateDen: r.stack.readBigNumber(),
            reserveTarget: r.stack.readBigNumber(),
            lastHarvestTime: r.stack.readNumber(),
            realizedLoss: r.stack.readBigNumber(),
        };
    }

    /** D-153 — the stake minimum THIS DEPLOY enforces, after `stakeDivisor`.
     *  A `stake` is legal when `getPending() − getStaking().reserveTarget`
     *  exceeds it; both halves must come from the same set or the check is a
     *  constant against a chain figure. */
    async getStakeMin(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('getStakeMin', [])).stack.readBigNumber();
    }

    /** G68 — the arms' preconditions no other getter answers. */
    async getStakingGates(provider: ContractProvider) {
        const r = await provider.get('getStakingGates', []);
        return {
            inFlightStake: r.stack.readBigNumber(),
            harvestIntervalSec: r.stack.readNumber(),
            harvestDustTston: r.stack.readBigNumber(),
            // `recover_exit` writes a stake off once now − stakeStartedAt ≥ recoverAfter.
            stakeStartedAt: r.stack.readNumber(),
            // Written-off stake cost not yet restored. (The stake hold keys on stakeStartedAt:
            // `stake` refuses 230 while it is non-zero, until now − stakeStartedAt ≥ 2·recoverAfter.)
            writtenOff: r.stack.readBigNumber(),
            // Audit H2: the open stake's part already matched by unauthenticated tsTON at
            // the last learned rate; `recover_exit` writes off inFlightStake − stakeCredited.
            stakeCredited: r.stack.readBigNumber(),
        };
    }

    /** The staking venue, separate from `getVenue` so that 3-tuple never moves. */
    async getStakingVenue(provider: ContractProvider) {
        const r = await provider.get('getStakingVenue', []);
        return {
            tonstakersPool: r.stack.readAddress(),
            dedustTstonVault: r.stack.readAddress(),
            dedustTstonPool: r.stack.readAddress(),
        };
    }

    /** The vault leg 2's TON output is accepted from (deploy data). */
    async getTstonPayoutVault(provider: ContractProvider) {
        return (await provider.get('getTstonPayoutVault', [])).stack.readAddress();
    }

    async getTstonWallet(provider: ContractProvider) {
        const r = await provider.get('getTstonWallet', []);
        return { tstonWalletAddr: r.stack.readAddress(), walletSet: r.stack.readNumber() };
    }

    async getHarvestDest(provider: ContractProvider) {
        return (await provider.get('getHarvestDest', [])).stack.readAddress();
    }

    /** (leg, inFlightExit) — 0/0 is idle; non-zero blocks flush, stake and unstake.
     *  D-155 appends `exitStartedAt` (0 while idle) and `recoverAfter`, the
     *  recovery window this deploy enforces after `clockDivisor`:
     *  `sendRecoverExit` is legal once `now − exitStartedAt ≥ recoverAfter`. */
    async getExitLeg(provider: ContractProvider) {
        const r = await provider.get('getExitLeg', []);
        const leg = r.stack.readNumber();
        const inFlightExit = r.stack.readBigNumber();
        // The wave-5 testnet set predates D-155 and returns the two values only,
        // so these reads are GUARDED rather than assumed: a live harness read
        // against that bytecode would otherwise throw `EOF` off an exhausted
        // stack. 0/0 is exactly right for a set with no recovery arm — there is
        // no window to wait out because there is nothing to call.
        const exitStartedAt = r.stack.remaining > 0 ? r.stack.readNumber() : 0;
        const recoverAfter = r.stack.remaining > 0 ? r.stack.readNumber() : 0;
        return { leg, inFlightExit, exitStartedAt, recoverAfter };
    }

    /**
     * Audit R2-M1 — who settles the OPEN flush. `pinned` is true while a venue change
     * landed mid-flight and the trip is still answered by the venue it was sent to;
     * otherwise the pair is `getVenue`'s own.
     */
    async getFlushReplyVenue(provider: ContractProvider) {
        const r = await provider.get('getFlushReplyVenue', []);
        return {
            dedustNativeVault: r.stack.readAddress(),
            primesJettonVault: r.stack.readAddress(),
            pinned: r.stack.readNumber() === 1,
        };
    }

    async getVenue(provider: ContractProvider) {
        const r = await provider.get('getVenue', []);
        return {
            dedustNativeVault: r.stack.readAddress(),
            dedustPool: r.stack.readAddress(),
            primesJettonVault: r.stack.readAddress(),
        };
    }

}
