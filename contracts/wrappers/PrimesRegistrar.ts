import { Address, beginCell, Cell, Contract, ContractProvider, contractAddress, Sender, SendMode } from '@ton/core';
import { REGISTRAR } from '../../shared/opcodes';
import { encodeAnnotateBody, buildTransferTrophyMessage } from '../../shared/messages';
import { DEFAULT_RENAME_FEE } from './PrimesCollection';

/**
 * TON PRIMES — Registrar wrapper (CONCEPT §3.4, §4.7).
 *
 * Era trophies and their engravings (a number's name lives on its item since D-188
 * point 6, written through the collection's `name_number`, D-212). Holds no protocol
 * TON, which is why its declared liability is structurally zero.
 */
export const RegistrarOpcodes = {
    SetLedger: REGISTRAR.set_ledger,
    SetCollection: REGISTRAR.set_collection,
    AwardEraTrophy: REGISTRAR.award_era_trophy,
    /** from the trophy holder: an engraving — the first free, every later one `renameFee` (§4.7.1, D-212) */
    Annotate: REGISTRAR.annotate,
    /**
     * from the trophy's CURRENT HOLDER only: move an era trophy (D-14, §4.7).
     * TROPHIES ONLY - `primorial` must be one of §7's eight primorials or it
     * throws 914. Ordinary prime naming rights are permanent (§4.7.1, §5.1).
     */
    TransferTrophy: REGISTRAR.transfer_trophy,
    /** D-212: outbound to the main collection — a paid re-engraving's fee, for the floor. */
    NamingPaid: REGISTRAR.naming_paid,
};

export type RegistrarConfig = {
    /** Bootstrapped post-deploy via SetLedger (circular address dependency). */
    ledgerAddr?: Address;
    genesisScriptAddr: Address;
    /** Bootstrapped post-deploy via SetCollection, for the same reason. */
    collectionAddr?: Address;
    /**
     * D-212: a trophy re-engraving's fee, in nanoTON — deploy data, no setter, and the same
     * value as the collection's `renameFee` (genesis asserts they match). Tests default to
     * `DEFAULT_RENAME_FEE`.
     */
    renameFee?: bigint;
};


function cfgCell(c: RegistrarConfig): Cell {
    return beginCell()
        .storeAddress(c.ledgerAddr ?? c.genesisScriptAddr)
        .storeAddress(c.genesisScriptAddr)
        .storeAddress(c.collectionAddr ?? c.genesisScriptAddr)
        .storeCoins(c.renameFee ?? DEFAULT_RENAME_FEE)
        .endCell();
}

function registrarConfigToCell(c: RegistrarConfig): Cell {
    return beginCell()
        .storeDict(undefined) // trophies — at most eight, one per §7 primorial (D-188 point 6)
        .storeRef(cfgCell(c))
        .storeUint(c.ledgerAddr ? 1 : 0, 8) // linked
        .storeUint(c.collectionAddr ? 1 : 0, 8) // collectionSet
        .endCell();
}

export class PrimesRegistrar implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesRegistrar(address);
    }

    static createFromConfig(config: RegistrarConfig, code: Cell, workchain = 0) {
        const data = registrarConfigToCell(config);
        const init = { code, data };
        return new PrimesRegistrar(contractAddress(workchain, init), init);
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
                .storeUint(RegistrarOpcodes.SetLedger, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.ledgerAddr)
                .endCell(),
        });
    }

    /** One-shot, genesis only: the main collection a re-engraving's fee is sent through (D-212). */
    async sendSetCollection(
        provider: ContractProvider,
        via: Sender,
        opts: { collectionAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(RegistrarOpcodes.SetCollection, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.collectionAddr)
                .endCell(),
        });
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

    async getPeers(provider: ContractProvider) {
        const r = await provider.get('getPeers', []);
        return { collectionAddr: r.stack.readAddressOpt(), collectionSet: r.stack.readNumber() };
    }

    /**
     * §4.7.1: an era trophy's engraving, from its holder. The first is free; every later
     * one must carry `renameFee` + REG_RENAME_GAS (D-212). Any refusal refunds.
     */
    async sendAnnotate(
        provider: ContractProvider,
        via: Sender,
        opts: { n: bigint; text: Cell; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeAnnotateBody({ n: opts.n, text: opts.text, queryId: BigInt(opts.queryID ?? 0) }),
        });
    }

    /**
     * D-14 (§4.7): move an era trophy. Sent by the CURRENT HOLDER and by nobody
     * else — there is no admin path.
     *
     * `primorial` must be one of §7's eight primorials; anything else throws
     * `reg_not_primorial` (914). This is not a general naming-rights transfer:
     * a prime's naming right is permanent (§5.1, §4.7.1) and is refused here.
     *
     * `value` is gas only. Nothing is escrowed and no fee is taken.
     */
    async sendTransferTrophy(
        provider: ContractProvider,
        via: Sender,
        opts: { primorial: bigint; newHolder: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buildTransferTrophyMessage({
                primorial: opts.primorial,
                newHolder: opts.newHolder.toString(),
                queryId: BigInt(opts.queryID ?? 0),
            }).body,
        });
    }

    /**
     * D-14 (§4.7). `(holder, transferable)`.
     *
     * `holder` is null when `n` carries no trophy — either the era has not closed
     * or `n` is not a primorial. `transferable` is 1 iff `n` is one of §7's eight
     * primorials (i.e. iff `sendTransferTrophy` would accept it) and 0 for every
     * other number, a NAMED PRIME included.
     */
    async getTrophy(provider: ContractProvider, n: bigint) {
        const r = await provider.get('getTrophy', [{ type: 'int', value: n }]);
        return { holder: r.stack.readAddressOpt(), transferable: r.stack.readNumber() };
    }

    /**
     * An ERA TROPHY's engraving: (count, text). count 0 means nothing is engraved, or `n` is
     * not a primorial. A prime's annotation is `PrimesItem.getAnnotation()` (D-188 point 6).
     */
    async getTrophyAnnotation(provider: ContractProvider, n: bigint) {
        const r = await provider.get('getTrophyAnnotation', [{ type: 'int', value: n }]);
        return { count: r.stack.readNumber(), text: r.stack.readCell() };
    }

    /** D-212: a trophy's paid re-engraving fee (deploy data). */
    async getTrophyRenameFee(provider: ContractProvider) {
        return (await provider.get('getTrophyRenameFee', [])).stack.readBigNumber();
    }
}
