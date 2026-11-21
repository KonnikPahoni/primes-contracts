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
import { LP_SINK } from '../../shared/opcodes';

/**
 * TON PRIMES — the LP SINK (CONCEPT §3.4 / §5 / §6 point 3 / §8,
 * DECISIONS D-100 points 4 and 9, invariant TR-6).
 *
 * DeDust PRIMES/TON LP receipts go in and nothing comes out, ever. The contract
 * declares **no outbound message type at all** — a stronger statement than "no
 * withdraw path", because there is no send to audit. `LpSink.spec.ts` asserts it
 * against the compiled code cell.
 *
 * `getLocked()` is monotone non-decreasing and equals the sink's LP jetton
 * wallet balance; that pair of numbers is the whole audit of the contract.
 *
 * **Locked depth is never summed into `T`** (D-100 point 4, and this is a copy
 * constraint). A pool's TON/PRIMES composition moves with every trade, so an
 * LP-derived term is non-monotonic and would void §5's ratchet theorem. The
 * floor (`p_f = T/S`) and liquidity (locked / committed / withdrawable) are two
 * separate guarantees on two separate panels. Nothing built on this wrapper may
 * present locked depth as backing.
 */
export const LpSinkOpcodes = {
    /** one-shot, genesis script only: this contract's own DeDust LP jetton wallet */
    SetWallet: LP_SINK.set_wallet,
    /** inbound from that wallet ONLY — LP arriving, forever (TEP-74) */
    TransferNotification: LP_SINK.transfer_notification,
    /** There is no outbound opcode, and its absence is the point. */
} as const;

export type LpSinkConfig = {
    /**
     * The only address a `set_wallet` is accepted from, fixed at deploy. Not an
     * owner: it names the wallet once and has no privilege afterwards, because
     * there is no message that does anything else.
     */
    genesisScriptAddr: Address;
};

function lpSinkConfigToCell(config: LpSinkConfig): Cell {
    return beginCell()
        .storeCoins(0) // locked
        .storeUint(0, 32) // events
        .storeAddress(config.genesisScriptAddr) // lpJettonWalletAddr placeholder
        .storeUint(0, 8) // walletSet
        .storeAddress(config.genesisScriptAddr)
        .endCell();
}

export class PrimesLpSink implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesLpSink(address);
    }

    static createFromConfig(config: LpSinkConfig, code: Cell, workchain = 0) {
        const data = lpSinkConfigToCell(config);
        const init = { code, data };
        return new PrimesLpSink(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /**
     * D21-family bootstrap: the sink's own DeDust LP jetton wallet. One-shot,
     * genesis script only. Until it fires, a notification is refused (1170) —
     * the sender check is what makes `getLocked()` equal the wallet balance.
     */
    async sendSetWallet(
        provider: ContractProvider,
        via: Sender,
        opts: { lpJettonWalletAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(LpSinkOpcodes.SetWallet, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.lpJettonWalletAddr)
                .endCell(),
        });
    }

    /**
     * A lock, as the LP jetton wallet delivers it. Test harnesses call this
     * impersonating that wallet; in production the depositor sends a TEP-74
     * `transfer` of LP to this contract and DeDust's wallet produces this.
     *
     * `forwardPayload` is accepted in either TEP-74 encoding and is never read —
     * the sink has exactly one thing it can do with a deposit, so there is
     * nothing for a payload to select. It defaults to nothing at all, which is
     * the inline encoding, which is the case a `cell`-typed field would have
     * broken on.
     */
    async sendTransferNotification(
        provider: ContractProvider,
        via: Sender,
        opts: {
            amount: bigint;
            from: Address;
            value: bigint;
            queryID?: number;
            forwardPayload?: Cell;
        }
    ) {
        const body = beginCell()
            .storeUint(LpSinkOpcodes.TransferNotification, 32)
            .storeUint(opts.queryID ?? 0, 64)
            .storeCoins(opts.amount)
            .storeAddress(opts.from);
        // TEP-74's Either discriminator (R20): 1 + a ref, or a bare 0 for
        // an empty inline payload.
        if (opts.forwardPayload) body.storeBit(true).storeRef(opts.forwardPayload);
        else body.storeBit(false);
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: body.endCell(),
        });
    }

    /**
     * TR-6: monotone non-decreasing, and equal to the sink's LP jetton wallet
     * balance. Not part of `T`, not backing, not collateral.
     */
    async getLocked(provider: ContractProvider) {
        const r = await provider.get('getLocked', []);
        return r.stack.readBigNumber();
    }

    /** How many separate locks make up `getLocked()`. */
    async getEvents(provider: ContractProvider) {
        const r = await provider.get('getEvents', []);
        return r.stack.readNumber();
    }

    /** (lpJettonWalletAddr, walletSet, genesisScriptAddr) — the bootstrap. */
    async getLpSinkConfig(provider: ContractProvider) {
        const r = await provider.get('getLpSinkConfig', []);
        return {
            lpJettonWalletAddr: r.stack.readAddress(),
            walletSet: r.stack.readNumber(),
            genesisScriptAddr: r.stack.readAddress(),
        };
    }
}
