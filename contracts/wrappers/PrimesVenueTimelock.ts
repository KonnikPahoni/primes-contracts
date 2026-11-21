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
import { VENUE_TIMELOCK } from '../../shared/opcodes';
import { clockDivisorOf } from './PrimesMarket';

export type VenueTimelockConfig = {
    /** Key 1 of 2 (D-194): may `queue` and `cancel`. */
    proposerAddr: Address;
    /**
     * Key 2 of 2 (D-194): the governed treasury, the only sender of
     * `confirm_venue` — sent on a passed LP vote. `execute` refuses without it.
     */
    governanceAddr: Address;
    ratchetAddr: Address; // placeholder pre-SetRatchet; see D11 in primes_venue_timelock.tolk
    genesisScriptAddr: Address;
    /**
     * D-139's test clock, the same divisor the market/ratchet/treasury carry.
     * Divides `TIMELOCK_DELAY` (30 days) so a testnet run can reach `execute`
     * at all — at 168 the delay is ~4.3 h. Omitted/1 is mainnet: 30 days.
     * ADDRESS-DETERMINING, like every other field here.
     */
    clockDivisor?: number;
};


function emptyQueuedCell(filler: Address): Cell {
    return beginCell()
        .storeAddress(filler)
        .storeAddress(filler)
        .storeAddress(filler)
        .storeUint(0, 64) // eta
        .storeUint(0, 32) // seq (D-194)
        .storeUint(0, 40) // queuedAt
        .storeUint(0, 8) // hasQueued
        .storeUint(0, 8) // fired
        .storeUint(0, 8) // confirmed (D-194)
        .endCell();
}

function venueTimelockConfigToCell(config: VenueTimelockConfig): Cell {
    return beginCell()
        .storeAddress(config.proposerAddr)
        .storeAddress(config.governanceAddr)
        .storeUint(0, 32) // queueSeq (D-194)
        .storeRef(emptyQueuedCell(config.proposerAddr))
        .storeRef(
            beginCell()
                .storeAddress(config.ratchetAddr)
                .storeUint(0, 8) // ratchetSet
                .storeAddress(config.genesisScriptAddr)
                .endCell()
        )
        .storeUint(clockDivisorOf(config.clockDivisor), 16) // D-139
        .endCell();
}

export class PrimesVenueTimelock implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesVenueTimelock(address);
    }

    static createFromConfig(config: VenueTimelockConfig, code: Cell, workchain = 0) {
        const data = venueTimelockConfigToCell(config);
        const init = { code, data };
        return new PrimesVenueTimelock(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendQueue(
        provider: ContractProvider,
        via: Sender,
        opts: {
            dedustNativeVault: Address;
            dedustPool: Address;
            primesJettonVault: Address;
            eta: number | bigint;
            value: bigint;
            queryID?: number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(VENUE_TIMELOCK.queue, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.dedustNativeVault)
                .storeAddress(opts.dedustPool)
                .storeAddress(opts.primesJettonVault)
                .storeUint(opts.eta, 64)
                .endCell(),
        });
    }

    async sendCancel(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(VENUE_TIMELOCK.cancel, 32).storeUint(opts.queryID ?? 0, 64).endCell(),
        });
    }

    async sendExecute(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(VENUE_TIMELOCK.execute, 32).storeUint(opts.queryID ?? 0, 64).endCell(),
        });
    }

    /**
     * D-194 key 2. On chain only the treasury sends this (a passed venue-confirm
     * proposal's `execute`); exposed so a sandbox test can stand a wallet in for it.
     */
    async sendConfirmVenue(
        provider: ContractProvider,
        via: Sender,
        opts: { seq: number; voteOpens: number; voteCloses: number; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(VENUE_TIMELOCK.confirm_venue, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.seq, 32)
                .storeUint(opts.voteOpens, 40)
                .storeUint(opts.voteCloses, 40)
                .endCell(),
        });
    }

    async sendRetryUpdateVenue(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(VENUE_TIMELOCK.retry_update_venue, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .endCell(),
        });
    }

    async sendSetRatchet(provider: ContractProvider, via: Sender, opts: { ratchetAddr: Address; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(VENUE_TIMELOCK.set_ratchet, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.ratchetAddr)
                .endCell(),
        });
    }

    async getQueued(provider: ContractProvider) {
        const result = await provider.get('getQueued', []);
        const hasQueued = result.stack.readNumber();
        const fired = result.stack.readNumber();
        const dedustNativeVault = result.stack.readAddress();
        const dedustPool = result.stack.readAddress();
        const primesJettonVault = result.stack.readAddress();
        const eta = result.stack.readNumber();
        // D-194: the record's number (what a treasury venue-confirm proposal
        // names) and whether the LP vote has confirmed it.
        const seq = result.stack.readNumber();
        const confirmed = result.stack.readNumber();
        // The queue time; a confirming vote must open no earlier (807), and must
        // close no earlier than `eta` (808, audit H1).
        const queuedAt = result.stack.readNumber();
        return { hasQueued, fired, dedustNativeVault, dedustPool, primesJettonVault, eta, seq, confirmed, queuedAt };
    }

    /** D-194: the two keys — proposer (queue/cancel) and governance (confirm). */
    async getKeys(provider: ContractProvider) {
        const r = await provider.get('getKeys', []);
        return { proposerAddr: r.stack.readAddress(), governanceAddr: r.stack.readAddress() };
    }
}
