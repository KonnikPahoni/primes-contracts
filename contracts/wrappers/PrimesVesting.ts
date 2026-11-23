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
import { VESTING } from '../../shared/opcodes';

/**
 * TON PRIMES — the VESTING LOCK, the treasury's since D-166 (CONCEPT §2 point 4 / §3.3 / §6 point 3;
 * DECISIONS D-77, which amends D-46 points 1 and 3).
 *
 * ONE instance (D-166 deleted the operator's): genesis mints the treasury's
 * 1,000,000 PRIMES here, released in FOUR equal tranches (D-91) — one at
 * genesis, then one every 90 days, the last at day 270 — to the governed
 * treasury contract, which spends them through `distribute()` (D-168).
 *
 * No owner field, no cancel, no pause, no beneficiary change. `release` is
 * permissionless and can only ever pay the deploy-fixed beneficiary, so who
 * calls it does not matter.
 *
 * It moves no GRAM and touches neither `T` nor `S`, so `p_f` is identical with
 * and without it.
 */
/**
 * Read from the shared registry rather than redeclared here. This wrapper was
 * the first to do it and for a while the only one; every wrapper in this
 * directory now does, and the four literals left (two per DeDust mock) are
 * sandbox-only controls and one external DeDust opcode, each labelled where it
 * stands. Two literals for one wire value is exactly what `shared/opcodes.ts`'s
 * opening paragraph forbids.
 */
export const VestingOpcodes = {
    /** one-shot, genesis script only: this contract's own PRIMES jetton wallet. Also starts the clock. */
    SetWallet: VESTING.set_wallet,
    /** PERMISSIONLESS: pushes every matured-but-unreleased tranche to the fixed beneficiary */
    Release: VESTING.release,
    /** outbound to this contract's own jetton wallet, on `release` only (TEP-74) */
    JettonTransfer: VESTING.jetton_transfer,
};

/** D-91's schedule, mirrored from `primes_vesting.tolk`. Four 25% unlocks, 90 days apart. */
export const VEST_TRANCHES = 4;
export const VEST_INTERVAL = 7776000; // 90 days

export type VestingConfig = {
    /** The ONLY address any outbound message here can ever name. Fixed at deploy. */
    beneficiary: Address;
    jettonMasterAddr: Address;
    /** The one-shot `set_wallet` authority — which is also what stamps `startTime`. */
    genesisScriptAddr: Address;
    /** The full allocation, declared at deploy: `T0_nominal · L`. */
    totalAmount: bigint;
};

function vestingConfigToCell(config: VestingConfig): Cell {
    return beginCell()
        .storeCoins(config.totalAmount)
        .storeCoins(0) // releasedAmount
        .storeUint(0, 64) // startTime — stamped by set_wallet, not at deploy
        .storeRef(
            beginCell()
                .storeAddress(config.beneficiary)
                .storeAddress(config.jettonMasterAddr)
                .storeAddress(config.genesisScriptAddr)
                .storeRef(
                    beginCell()
                        .storeAddress(config.genesisScriptAddr) // jettonWalletAddr placeholder
                        .storeUint(0, 8) // walletSet
                        .endCell()
                )
                .endCell()
        )
        .endCell();
}

export class PrimesVesting implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesVesting(address);
    }

    static createFromConfig(config: VestingConfig, code: Cell, workchain = 0) {
        const data = vestingConfigToCell(config);
        const init = { code, data };
        return new PrimesVesting(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /**
     * D21-family bootstrap: the lock's own PRIMES wallet. One-shot, genesis
     * script only — and the message that STARTS THE VEST CLOCK, so the schedule
     * is dated from custody rather than from a deploy-data timestamp.
     */
    async sendSetWallet(
        provider: ContractProvider,
        via: Sender,
        opts: { jettonWalletAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(VestingOpcodes.SetWallet, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.jettonWalletAddr)
                .endCell(),
        });
    }

    /**
     * PERMISSIONLESS. Transfers every matured-but-unreleased tranche to the
     * deploy-fixed beneficiary in one message — a caller who has ignored the
     * contract for a year catches up in a single call. Throws 1141
     * (`vest_nothing_due`) when no new tranche has matured, and 103 when the
     * caller underfunds the 0.1 GRAM transfer hop.
     */
    async sendRelease(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(VestingOpcodes.Release, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .endCell(),
        });
    }

    /**
     * (beneficiary, startTime, totalAmount, releasedAmount, unlocked, tranches,
     * nextUnlockAt).
     *
     * `unlocked`/`tranches` is the bounded pair a UI draws as four segments (D-91);
     * `nextUnlockAt` drives the countdown on the next unlit one and reads 0 both
     * before the clock starts and after the schedule completes (separate them by
     * `startTime`). `releasedAmount` is what has been PUSHED OUT, not what has
     * matured — the gap between them is a tranche nobody has claimed yet.
     */
    async getVesting(provider: ContractProvider) {
        const r = await provider.get('getVesting', []);
        return {
            beneficiary: r.stack.readAddress(),
            startTime: r.stack.readNumber(),
            totalAmount: r.stack.readBigNumber(),
            releasedAmount: r.stack.readBigNumber(),
            unlocked: r.stack.readNumber(),
            tranches: r.stack.readNumber(),
            nextUnlockAt: r.stack.readNumber(),
        };
    }

    /**
     * (tranches, intervalSeconds, releasableNow) — the declared schedule plus
     * exactly what a `release` would transfer right now, so a UI never has to
     * recompute the schedule client-side (§9.1).
     */
    async getVestingSchedule(provider: ContractProvider) {
        const r = await provider.get('getVestingSchedule', []);
        return {
            tranches: r.stack.readNumber(),
            intervalSeconds: r.stack.readNumber(),
            releasableNow: r.stack.readBigNumber(),
        };
    }

    async getVestingConfig(provider: ContractProvider) {
        const r = await provider.get('getVestingConfig', []);
        return {
            beneficiary: r.stack.readAddress(),
            jettonMasterAddr: r.stack.readAddress(),
            jettonWalletAddr: r.stack.readAddress(),
            walletSet: r.stack.readNumber(),
        };
    }
}
