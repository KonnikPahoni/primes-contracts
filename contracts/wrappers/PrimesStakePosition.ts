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
    buildStakeClaimMessage,
    buildStakeExpireMessage,
    buildStakeRelockMessage,
    buildStakeWithdrawMessage,
} from '../../shared/messages';
import { clockDivisorOf } from './PrimesMarket';

/**
 * TON PRIMES — the STAKE POSITION CHILD, one per staking wallet (CONCEPT §5.3,
 * DECISIONS D-168).
 *
 * Holds one wallet's stake positions — a RECORD; the PRIMES sit in the master's
 * wallet. Its address is a hash of (this code, owner, master, clockDivisor), and that
 * derivation is the authentication both ways. `stakePositionConfigToCell` must stay
 * byte-identical to `primes_stake.tolk`'s `PositionInit`; `Staking.spec.ts` asserts it.
 */

export type StakePositionConfig = {
    owner: Address;
    stakeAddr: Address;
    /** D-139, inherited from the master. Part of the address. */
    clockDivisor?: number;
};

function stakePositionConfigToCell(config: StakePositionConfig): Cell {
    // THE FIELD ORDER IS PART OF THE ADDRESS. Mirrored by `primes_stake.tolk`'s
    // `PositionInit`; change one, change both.
    return beginCell()
        .storeAddress(config.owner)
        .storeAddress(config.stakeAddr)
        .storeDict(undefined) // positions
        .storeUint(0, 32) // nextId
        .storeUint(0, 32) // positionCount
        .storeCoins(0) // stakedTotal
        .storeUint(clockDivisorOf(config.clockDivisor), 16)
        .endCell();
}

export class PrimesStakePosition implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesStakePosition(address);
    }

    static createFromConfig(config: StakePositionConfig, code: Cell, workchain = 0) {
        const data = stakePositionConfigToCell(config);
        const init = { code, data };
        return new PrimesStakePosition(contractAddress(workchain, init), init);
    }

    private async sendBody(provider: ContractProvider, via: Sender, value: bigint, body: Cell) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    async sendClaim(provider: ContractProvider, via: Sender, opts: { positionId: number; value?: bigint; queryID?: number }) {
        const m = buildStakeClaimMessage(opts.positionId, BigInt(opts.queryID ?? 0));
        await this.sendBody(provider, via, opts.value ?? m.value, m.body);
    }

    async sendRelock(
        provider: ContractProvider,
        via: Sender,
        opts: { positionId: number; tier: number; value?: bigint; queryID?: number }
    ) {
        const m = buildStakeRelockMessage({ positionId: opts.positionId, tier: opts.tier, queryId: BigInt(opts.queryID ?? 0) });
        await this.sendBody(provider, via, opts.value ?? m.value, m.body);
    }

    async sendWithdraw(provider: ContractProvider, via: Sender, opts: { positionId: number; value?: bigint; queryID?: number }) {
        const m = buildStakeWithdrawMessage(opts.positionId, BigInt(opts.queryID ?? 0));
        await this.sendBody(provider, via, opts.value ?? m.value, m.body);
    }

    /** PERMISSIONLESS — any sender. */
    async sendExpire(provider: ContractProvider, via: Sender, opts: { positionId: number; value?: bigint; queryID?: number }) {
        const m = buildStakeExpireMessage(opts.positionId, BigInt(opts.queryID ?? 0));
        await this.sendBody(provider, via, opts.value ?? m.value, m.body);
    }

    /** (positionCount, nextId, stakedTotal). Enumerate `getPosition(0..nextId-1)`. */
    async getPositions(provider: ContractProvider) {
        const r = await provider.get('getPositions', []);
        return {
            positionCount: r.stack.readNumber(),
            nextId: r.stack.readNumber(),
            stakedTotal: r.stack.readBigNumber(),
        };
    }

    /** A missing id returns all zeros (`maturesAt === 0`). */
    async getPosition(provider: ContractProvider, positionId: number) {
        const r = await provider.get('getPosition', [{ type: 'int', value: BigInt(positionId) }]);
        return {
            amount: r.stack.readBigNumber(),
            tier: r.stack.readNumber(),
            lockedAt: r.stack.readNumber(),
            maturesAt: r.stack.readNumber(),
            rewardDebt: r.stack.readBigNumber(),
            lastSettleTime: r.stack.readNumber(),
            expired: r.stack.readNumber(),
            banked: r.stack.readBigNumber(),
            inFlight: r.stack.readNumber(),
        };
    }

    /** PRIMES a claim would pay now, given the master's `getAccNow()`. */
    async getClaimable(provider: ContractProvider, positionId: number, acc: bigint) {
        const r = await provider.get('getClaimable', [
            { type: 'int', value: BigInt(positionId) },
            { type: 'int', value: acc },
        ]);
        return r.stack.readBigNumber();
    }

    async getPositionOwner(provider: ContractProvider) {
        const r = await provider.get('getPositionOwner', []);
        return { owner: r.stack.readAddress(), stakeAddr: r.stack.readAddress() };
    }

    async getTierTerms(provider: ContractProvider): Promise<number[]> {
        const r = await provider.get('getTierTerms', []);
        return Array.from({ length: 4 }, () => r.stack.readNumber());
    }

    async getPositionMinForward(provider: ContractProvider) {
        const r = await provider.get('getPositionMinForward', []);
        return { ownerMinForward: r.stack.readBigNumber(), expireMinForward: r.stack.readBigNumber() };
    }
}
