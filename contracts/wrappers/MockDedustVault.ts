import { Address, beginCell, Cell, Contract, ContractProvider, contractAddress, Sender, SendMode } from '@ton/core';
import { RATCHET } from '../../shared/opcodes';

/**
 * TEST-ONLY. GAUNTLET.md V2.1. A minimal counterparty that parses DeDust v2's
 * real published swap schema and simulates a fill or a slippage reject — see
 * `contracts/contracts/mock_dedust_vault.tolk`'s header for the full rationale.
 * Never deployed to testnet or mainnet.
 */
const MockDedustVaultOpcodes = {
    /** THE protocol value — DeDust's own swap op, read from the registry. */
    DedustSwap: RATCHET.dedust_swap,
    // `SetPrice` and `SetSilent` are the harness's own knobs on a contract that
    // exists only under `@ton/sandbox`: no deployed contract sends them, no TL-B
    // schema declares them, and nothing outside this file reads them. They stay
    // local BECAUSE `shared/opcodes.ts` is the registry of the protocol's wire
    // surface — putting a test double's controls in it would make that claim
    // false. (They sit on 0x92, the burn sink's high byte; harmless, since the
    // two families never share an account, but do not read the prefix as a
    // protocol allocation.)
    SetPrice: 0x92000010,
    SetSilent: 0x92000011,
};

export type MockDedustVaultConfig = {
    owner: Address;
    /** simulated output = amount * priceNum / priceDen */
    priceNum: bigint;
    priceDen: bigint;
    /** GAUNTLET V15: accept a well-formed swap and reply with NOTHING — no fill
     *  notification, no revert — so the caller's round trip hangs open. Defaults
     *  to off; the fill and reject tests never set it. */
    silent?: boolean;
};

function mockDedustVaultConfigToCell(config: MockDedustVaultConfig): Cell {
    return beginCell()
        .storeAddress(config.owner)
        .storeCoins(config.priceNum)
        .storeCoins(config.priceDen)
        .storeUint(config.silent ? 1 : 0, 1)
        .endCell();
}

export class MockDedustVault implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new MockDedustVault(address);
    }

    static createFromConfig(config: MockDedustVaultConfig, code: Cell, workchain = 0) {
        const data = mockDedustVaultConfigToCell(config);
        const init = { code, data };
        return new MockDedustVault(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendSetPrice(
        provider: ContractProvider,
        via: Sender,
        opts: { priceNum: bigint; priceDen: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockDedustVaultOpcodes.SetPrice, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.priceNum)
                .storeCoins(opts.priceDen)
                .endCell(),
        });
    }

    async sendSetSilent(
        provider: ContractProvider,
        via: Sender,
        opts: { silent: boolean; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockDedustVaultOpcodes.SetSilent, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.silent ? 1 : 0, 1)
                .endCell(),
        });
    }
}
