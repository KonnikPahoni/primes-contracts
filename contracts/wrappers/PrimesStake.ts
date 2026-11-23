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
import {
    STAKE,
    STAKE_ACTION_BUDGET,
    STAKE_ACTION_LOCK,
    STAKE_ACC_SCALE,
    STAKE_TIERS,
} from '../../shared/opcodes';
import { buildStakePayload } from '../../shared/messages';
import { clockDivisorOf } from './PrimesMarket';

/**
 * TON PRIMES — the STAKE MASTER (CONCEPT §5.3, DECISIONS D-168).
 *
 * A wallet locks PRIMES for a term and earns PRIMES while it runs, streamed from the
 * treasury's monthly `distribute()` budget pro rata to `amount × tierWeight`. Global
 * state here (the stream, the accumulator, the totals); each wallet's positions on a
 * `PrimesStakePosition` child whose address is the authentication. No admin, no owner,
 * no GRAM liability. See `primes_stake.tolk`'s header.
 */

export { STAKE_ACTION_LOCK, STAKE_ACTION_BUDGET, STAKE_ACC_SCALE, STAKE_TIERS };

/** The `forwardPayload` a stake carries: `STKL` + `tier:uint8`. */
export function stakePayload(tier: number): Cell {
    return buildStakePayload(tier);
}

/** The `forwardPayload` `distribute()` writes: `SBGT`. */
export function budgetPayload(): Cell {
    return beginCell().storeUint(STAKE_ACTION_BUDGET, 32).endCell();
}

export type StakeConfig = {
    jettonMasterAddr: Address;
    /** `primes_stake_position.tolk`'s compiled code — the child address derivation. */
    positionCode: Cell;
    /** D-139 test clock. 1 is mainnet. Part of every child's address. */
    clockDivisor?: number;
    /** The one-shot `set_wallet` authority. */
    genesisScriptAddr: Address;
};

function stakeConfigToCell(config: StakeConfig): Cell {
    const stream = beginCell()
        .storeUint(0, 128) // totalWeight
        .storeUint(0, 128) // rewardPerWeightAcc
        .storeUint(0, 40) // lastAccrualTime
        .storeCoins(0) // streamRemaining
        .storeUint(0, 128) // streamRate
        .storeUint(0, 40) // streamEnd
        .storeCoins(0) // lockedTotal
        .storeCoins(0) // unclaimedTotal
        .endCell();
    const totals = beginCell()
        .storeCoins(0) // budgetsIn
        .storeCoins(0) // claimedTotal
        .storeUint(0, 32) // livePositions
        .storeUint(0, 32) // stakeEvents
        .storeUint(0, 32) // budgetEvents
        .endCell();
    const wallets = beginCell()
        // Placeholders until the one-shot `set_wallet`; `walletSet = 0` is checked first.
        .storeAddress(config.genesisScriptAddr) // jettonWalletAddr
        .storeAddress(config.genesisScriptAddr) // treasuryAddr
        .storeUint(0, 8) // walletSet
        .storeAddress(config.genesisScriptAddr)
        .endCell();
    const cfg = beginCell()
        .storeAddress(config.jettonMasterAddr)
        .storeUint(clockDivisorOf(config.clockDivisor), 16)
        .storeRef(config.positionCode)
        .storeRef(wallets)
        .endCell();
    return beginCell().storeRef(stream).storeRef(totals).storeRef(cfg).endCell();
}

export class PrimesStake implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesStake(address);
    }

    static createFromConfig(config: StakeConfig, code: Cell, workchain = 0) {
        const data = stakeConfigToCell(config);
        const init = { code, data };
        return new PrimesStake(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /** D21-family bootstrap, one-shot: the master's own PRIMES wallet AND the treasury. */
    async sendSetWallet(
        provider: ContractProvider,
        via: Sender,
        opts: { jettonWalletAddr: Address; treasuryAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(STAKE.set_wallet, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.jettonWalletAddr)
                .storeAddress(opts.treasuryAddr)
                .endCell(),
        });
    }

    /**
     * A notification as the master's own jetton wallet delivers it. Test harnesses call
     * this impersonating that wallet; in production the staker sends a TEP-74 `transfer`.
     * Defaults to a `STKL` tier-0 payload; pass `forwardPayload` for anything else.
     */
    async sendTransferNotification(
        provider: ContractProvider,
        via: Sender,
        opts: { amount: bigint; from: Address; value: bigint; queryID?: number; forwardPayload?: Cell }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(STAKE.transfer_notification, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.amount)
                .storeAddress(opts.from)
                .storeBit(true)
                .storeRef(opts.forwardPayload ?? stakePayload(0))
                .endCell(),
        });
    }

    /** ST-1: (lockedTotal, streamRemaining, unclaimedTotal) vs the wallet's balance. */
    async getStakeSolvency(provider: ContractProvider) {
        const r = await provider.get('getStakeSolvency', []);
        return {
            lockedTotal: r.stack.readBigNumber(),
            streamRemaining: r.stack.readBigNumber(),
            unclaimedTotal: r.stack.readBigNumber(),
        };
    }

    async getStakeStream(provider: ContractProvider) {
        const r = await provider.get('getStakeStream', []);
        return {
            streamRate: r.stack.readBigNumber(),
            streamRemaining: r.stack.readBigNumber(),
            streamEnd: r.stack.readNumber(),
            lastAccrualTime: r.stack.readNumber(),
            rewardPerWeightAcc: r.stack.readBigNumber(),
            totalWeight: r.stack.readBigNumber(),
            accScale: r.stack.readBigNumber(),
        };
    }

    /** The accumulator as the next message would see it — feed to `getClaimable`. */
    async getAccNow(provider: ContractProvider) {
        const r = await provider.get('getAccNow', []);
        return r.stack.readBigNumber();
    }

    /** ST-2: budgetsIn == claimedTotal + unclaimedTotal + streamRemaining. */
    async getStakeTotals(provider: ContractProvider) {
        const r = await provider.get('getStakeTotals', []);
        return {
            budgetsIn: r.stack.readBigNumber(),
            claimedTotal: r.stack.readBigNumber(),
            lockedTotal: r.stack.readBigNumber(),
            livePositions: r.stack.readNumber(),
            stakeEvents: r.stack.readNumber(),
            budgetEvents: r.stack.readNumber(),
        };
    }

    /** The four lock terms, divided by the clock divisor. */
    async getTierTerms(provider: ContractProvider): Promise<number[]> {
        const r = await provider.get('getTierTerms', []);
        return Array.from({ length: 4 }, () => r.stack.readNumber());
    }

    async getTierWeights(provider: ContractProvider): Promise<number[]> {
        const r = await provider.get('getTierWeights', []);
        return Array.from({ length: 4 }, () => r.stack.readNumber());
    }

    async getStakePositionAddress(provider: ContractProvider, owner: Address) {
        const r = await provider.get('getStakePositionAddress', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return r.stack.readAddress();
    }

    async getStakeMinForward(provider: ContractProvider) {
        const r = await provider.get('getStakeMinForward', []);
        return r.stack.readBigNumber();
    }

    async getStakeConfig(provider: ContractProvider) {
        const r = await provider.get('getStakeConfig', []);
        return {
            jettonMasterAddr: r.stack.readAddress(),
            jettonWalletAddr: r.stack.readAddress(),
            treasuryAddr: r.stack.readAddress(),
            walletSet: r.stack.readNumber(),
            clockDivisor: r.stack.readNumber(),
            interval: r.stack.readNumber(),
        };
    }
}
