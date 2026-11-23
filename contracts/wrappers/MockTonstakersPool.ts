import { Address, beginCell, Cell, Contract, ContractProvider, contractAddress, Sender, SendMode } from '@ton/core';
import { RATCHET } from '../../shared/opcodes';

/**
 * TEST-ONLY. D-151 / CONCEPT §4.3.2. A minimal counterparty that parses the real
 * Tonstakers liquid-staking wire format and simulates a deposit and the three
 * withdrawal outcomes — see `contracts/test-mocks/mock_tonstakers_pool.tolk`'s
 * header for the full rationale. It stands in for the pool, the pool-jetton
 * minter, the ratchet's own tsTON wallet and DeDust's tsTON/native vaults at
 * once.
 *
 * TESTNET ONLY, NEVER MAINNET (P4): a testnet genesis deploys it and points all
 * five of §4.3.2's addresses at it, because there is no Tonstakers pool on
 * testnet and cannot be a useful one (D-151 P0 point 1). The network decides,
 * not a config value — see `deployGenesis.ts`'s `resolveStakingVenue`.
 */
const MockTonstakersPoolOpcodes = {
    /** THE protocol values — Tonstakers' own ops, read from the registry. */
    TonstakersDeposit: RATCHET.tonstakers_deposit,
    TstonBurn: RATCHET.tston_burn,
    TonstakersWithdrawal: RATCHET.tonstakers_withdrawal,
    // `SetRate`, `SetBuffer` and `SettleBill` are the harness's own knobs on a
    // contract that exists only under `@ton/sandbox`: no deployed contract sends
    // them, no TL-B schema declares them, and nothing outside this file reads
    // them. They stay local BECAUSE `shared/opcodes.ts` is the registry of the
    // protocol's wire surface — putting a test double's controls in it would
    // make that claim false. (They sit on 0x92, the burn sink's high byte;
    // harmless, since the two families never share an account, but do not read
    // the prefix as a protocol allocation.)
    SetRate: 0x92000030,
    SetBuffer: 0x92000031,
    SettleBill: 0x92000032,
    SetDedustTon: 0x92000033,
    // Audit H2: the pool's `optimistic_deposit` switch, and the round end that
    // pays a non-optimistic deposit's bill.
    SetOptimistic: 0x92000034,
    SettleDepositBill: 0x92000035,
};

export type MockTonstakersPoolConfig = {
    /**
     * tsTON per GRAM as a fraction: `rateNum` GRAM buys `rateDen` tsTON. "1 tsTON
     * = 1.05 GRAM" is `{ rateNum: toNano('1.05'), rateDen: toNano('1') }`.
     * Default 0n/1n so the mock cannot mint by accident — a deposit before a
     * `sendSetRate` fails hard rather than crediting zero tsTON.
     */
    rateNum?: bigint;
    rateDen?: bigint;
    /** the immediate-withdrawal buffer; a burn fills out of this or not at all */
    freeTon?: bigint;
    /** tsTON minted and not yet burned; normally left at 0 and grown by deposits */
    tstonSupplyOwed?: bigint;
    /**
     * Leg 2's DEX depth, separate from `freeTon` on purpose: the case the exit
     * machine exists for is "the pool cannot fill now but the DEX can", and one
     * shared buffer cannot express it.
     */
    dedustTon?: bigint;
    /**
     * `pool.func:291` `optimistic_deposit`. Default ON — the live pool's setting
     * and what every spec before audit H2 assumed. Off, a deposit becomes a bill
     * paid at `sendSettleDepositBill` from `sendSetOptimistic`'s collection.
     */
    optimistic?: boolean;
};

function mockTonstakersPoolConfigToCell(config: MockTonstakersPoolConfig): Cell {
    return beginCell()
        .storeCoins(config.rateNum ?? 0n)
        .storeCoins(config.rateDen ?? 1n)
        .storeCoins(config.freeTon ?? 0n)
        .storeCoins(config.tstonSupplyOwed ?? 0n)
        .storeCoins(0n) // pendingBill
        .storeUint(0, 2) // billOwner — addr_none
        .storeCoins(config.dedustTon ?? 0n)
        .storeBit(config.optimistic ?? true)
        .storeCoins(0n) // depositBill
        .storeUint(0, 2) // depositBillOwner — addr_none
        .storeUint(0, 2) // billCollection — none until sendSetOptimistic
        .endCell();
}

export class MockTonstakersPool implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new MockTonstakersPool(address);
    }

    static createFromConfig(config: MockTonstakersPoolConfig, code: Cell, workchain = 0) {
        const data = mockTonstakersPoolConfigToCell(config);
        const init = { code, data };
        return new MockTonstakersPool(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendSetRate(
        provider: ContractProvider,
        via: Sender,
        opts: { rateNum: bigint; rateDen: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockTonstakersPoolOpcodes.SetRate, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.rateNum)
                .storeCoins(opts.rateDen)
                .endCell(),
        });
    }

    async sendSetBuffer(
        provider: ContractProvider,
        via: Sender,
        opts: { freeTon: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockTonstakersPoolOpcodes.SetBuffer, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.freeTon)
                .endCell(),
        });
    }

    /** Leg 2's DeDust depth — how much GRAM the tsTON/GRAM book can pay out. */
    async sendSetDedustTon(
        provider: ContractProvider,
        via: Sender,
        opts: { dedustTon: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockTonstakersPoolOpcodes.SetDedustTon, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.dedustTon)
                .endCell(),
        });
    }

    /** Drives the ~36 h round-end payout on an outstanding bill without waiting. */
    async sendSettleBill(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockTonstakersPoolOpcodes.SettleBill, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .endCell(),
        });
    }

    /**
     * Audit H2 — `governor::set_deposit_settings`. `collection` is the payout
     * collection whose wallet pays a non-optimistic bill: the `from` the ratchet
     * sees. It must not be the mock's own address (the mock is also DeDust's
     * tsTON vault, whose `from` marks leg 2's refusal).
     */
    async sendSetOptimistic(
        provider: ContractProvider,
        via: Sender,
        opts: { optimistic: boolean; collection: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockTonstakersPoolOpcodes.SetOptimistic, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeBit(opts.optimistic)
                .storeAddress(opts.collection)
                .endCell(),
        });
    }

    /** Round end for a non-optimistic deposit: mints at the CURRENT rate and pays
     *  the bill as a 0.01 GRAM transfer from the collection. */
    async sendSettleDepositBill(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockTonstakersPoolOpcodes.SettleDepositBill, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .endCell(),
        });
    }

    async getMockPoolConfig(provider: ContractProvider) {
        const r = await provider.get('getMockPoolConfig', []);
        return {
            rateNum: r.stack.readBigNumber(),
            rateDen: r.stack.readBigNumber(),
            freeTon: r.stack.readBigNumber(),
            tstonSupplyOwed: r.stack.readBigNumber(),
            pendingBill: r.stack.readBigNumber(),
            dedustTon: r.stack.readBigNumber(),
        };
    }
}
