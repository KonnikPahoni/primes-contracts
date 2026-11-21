import { Address, beginCell, Cell, Contract, ContractProvider, contractAddress, Sender, SendMode } from '@ton/core';
import { storeAsset, type DedustAsset } from '../scripts/dedust';
import { DEDUST } from '../../shared/opcodes';

/**
 * TEST-ONLY. GAUNTLET.md R13. A minimal counterparty that parses DeDust v2's
 * real published deposit_liquidity (native-vault) schema and simulates a fill
 * or a graceful under-fill refund — see
 * `contracts/test-mocks/mock_dedust_deposit_vault.tolk`'s header for the full
 * rationale, including the finding that the schema has no recipient field at
 * all (the reply always targets the message's own sender). Never deployed to
 * testnet or mainnet.
 */
const MockDedustDepositVaultOpcodes = {
    // `deposit_liquidity#d55e4686` USED TO BE LOCAL, on the premise that nothing
    // in this repo ever sends one — the PRIMES/TON pool being seeded by the
    // operator rather than by the protocol. That premise expired when the WEBAPP
    // grew a provide-liquidity form: `shared/messages.ts` now builds this body
    // for a player to sign, so the value is in the registry as `DEDUST.deposit_native`
    // and is read from there, which is what keeps this mock parsing the same
    // opcode the app sends.
    //
    // `SetLpRate` stays local: it is the harness's own knob on a sandbox-only
    // contract; see `MockDedustVault.ts` for why a test double's controls are
    // not protocol.
    DedustDeposit: DEDUST.deposit_native,
    SetLpRate: 0x92000020,
};

export type MockDedustDepositVaultConfig = {
    owner: Address;
    /** simulated minted LP = amount * lpNum / lpDen */
    lpNum: bigint;
    lpDen: bigint;
};

function mockDedustDepositVaultConfigToCell(config: MockDedustDepositVaultConfig): Cell {
    return beginCell()
        .storeAddress(config.owner)
        .storeCoins(config.lpNum)
        .storeCoins(config.lpDen)
        .endCell();
}

// One encoder, in scripts/dedust.ts — the module that also builds the real
// deposit and swap bodies the seeding script sends. A test double and a live
// script disagreeing about how an `Asset` is written is exactly the class of
// drift this file exists to catch, so they share the function rather than each
// keeping a copy.
export type { DedustAsset } from '../scripts/dedust';

export class MockDedustDepositVault implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new MockDedustDepositVault(address);
    }

    static createFromConfig(config: MockDedustDepositVaultConfig, code: Cell, workchain = 0) {
        const data = mockDedustDepositVaultConfigToCell(config);
        const init = { code, data };
        return new MockDedustDepositVault(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendSetLpRate(
        provider: ContractProvider,
        via: Sender,
        opts: { lpNum: bigint; lpDen: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(MockDedustDepositVaultOpcodes.SetLpRate, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.lpNum)
                .storeCoins(opts.lpDen)
                .endCell(),
        });
    }

    /** Builds and sends a real deposit_liquidity#d55e4686 body, field-for-field
     *  against DeDust v2's own published schema — see the mock's header. */
    async sendDedustDeposit(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            queryID?: number;
            amount: bigint;
            poolType: 0 | 1;
            asset0: DedustAsset;
            asset1: DedustAsset;
            minLpAmount: bigint;
            asset0TargetBalance: bigint;
            asset1TargetBalance: bigint;
            fulfillPayload?: Cell;
            rejectPayload?: Cell;
        }
    ) {
        const b = beginCell()
            .storeUint(MockDedustDepositVaultOpcodes.DedustDeposit, 32)
            .storeUint(opts.queryID ?? 0, 64)
            .storeCoins(opts.amount)
            .storeUint(opts.poolType, 1);
        storeAsset(b, opts.asset0);
        storeAsset(b, opts.asset1);
        // A REF, not inline. `@dedust/sdk`'s `VaultNative.sendDepositLiquidity`
        // writes these three with `.storeRef(...)`; the docs' TL-B page prints
        // them inline. The SDK is what mainnet accepts, so the SDK wins.
        b.storeRef(
            beginCell()
                .storeCoins(opts.minLpAmount)
                .storeCoins(opts.asset0TargetBalance)
                .storeCoins(opts.asset1TargetBalance)
                .endCell()
        );
        b.storeUint(opts.fulfillPayload ? 1 : 0, 1);
        if (opts.fulfillPayload) b.storeRef(opts.fulfillPayload);
        b.storeUint(opts.rejectPayload ? 1 : 0, 1);
        if (opts.rejectPayload) b.storeRef(opts.rejectPayload);

        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: b.endCell(),
        });
    }
}
