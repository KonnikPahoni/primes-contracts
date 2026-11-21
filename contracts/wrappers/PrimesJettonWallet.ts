import { Address, beginCell, Cell, Contract, ContractProvider, Sender, SendMode } from '@ton/core';
import { TEP74 } from '../../shared/opcodes';

export class PrimesJettonWallet implements Contract {
    constructor(readonly address: Address) {}

    static createFromAddress(address: Address) {
        return new PrimesJettonWallet(address);
    }

    /**
     * TEP-74 `transfer#0f8a7ea5`. GAUNTLET V4: `customPayload` and
     * `forwardPayload` now write the standard's actual `(Maybe ^Cell)` /
     * `(Either Cell ^Cell)` shapes — previously this always wrote an
     * unconditional ref for both, matching the contract's own pre-fix (and
     * equally non-compliant) parse. `responseAddr` is `Address | null` so a
     * caller can ask for no excess-value return, per TEP-74's own
     * `response_destination:MsgAddress` (which `addr_none` is a legal value
     * of) — `@ton/core`'s `storeAddress` already writes `addr_none` for `null`.
     */
    async sendTransfer(
        provider: ContractProvider,
        via: Sender,
        opts: {
            destination: Address;
            responseAddr: Address | null;
            amount: bigint;
            value: bigint;
            forwardTonAmount?: bigint;
            forwardPayload?: Cell | null;
            customPayload?: Cell | null;
            queryID?: number;
        }
    ) {
        const b = beginCell()
            .storeUint(TEP74.transfer, 32)
            .storeUint(opts.queryID ?? 0, 64)
            .storeCoins(opts.amount)
            .storeAddress(opts.destination)
            .storeAddress(opts.responseAddr);
        if (opts.customPayload) {
            b.storeMaybeRef(opts.customPayload);
        } else {
            b.storeBit(false);
        }
        b.storeCoins(opts.forwardTonAmount ?? 0n);
        // Either Cell ^Cell — this wrapper always chooses the ref variant
        // (bit 1), which is a legal choice of Either and keeps the body small
        // regardless of payload size; the CONTRACT accepts both (that is the
        // fix this wrapper exists to exercise from the other side).
        b.storeBit(true).storeRef(opts.forwardPayload ?? beginCell().endCell());
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: b.endCell(),
        });
    }

    async sendBurn(
        provider: ContractProvider,
        via: Sender,
        // `responseAddr` is TEP-74's `response_destination:MsgAddress`, and `addr_none` is a
        // legal value there meaning "keep the change" — not a missing argument. The burner
        // that names nobody is the case GAUNTLET.md B28's master arm must not send to.
        opts: { amount: bigint; responseAddr: Address | null; value: bigint; queryID?: number; customPayload?: Cell | null }
    ) {
        const b = beginCell()
            .storeUint(TEP74.burn, 32)
            .storeUint(opts.queryID ?? 0, 64)
            .storeCoins(opts.amount)
            .storeAddress(opts.responseAddr);
        // TEP-74's `custom_payload:(Maybe ^Cell)`. The bit is written either way —
        // omitting it is the D-151 P2 defect this wrapper's contract side fixed.
        b.storeMaybeRef(opts.customPayload ?? null);
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: b.endCell(),
        });
    }

    async getWalletData(provider: ContractProvider) {
        const result = await provider.get('getWalletData', []);
        const balance = result.stack.readBigNumber();
        const owner = result.stack.readAddress();
        const jettonMaster = result.stack.readAddress();
        const code = result.stack.readCell();
        return { balance, owner, jettonMaster, code };
    }

    /** TEP-74's `get_wallet_data`, called by its exact standard name — the one every wallet
     *  UI and DEX resolves. See the note in PrimesJettonMaster.getJettonDataStandard. */
    async getWalletDataStandard(provider: ContractProvider) {
        const result = await provider.get('get_wallet_data', []);
        const balance = result.stack.readBigNumber();
        const owner = result.stack.readAddress();
        const jettonMaster = result.stack.readAddress();
        const code = result.stack.readCell();
        return { balance, owner, jettonMaster, code };
    }
}
