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
import { COLLECTION } from '../../shared/opcodes';
import { encodeNameNumberBody } from '../../shared/messages';

export type CollectionConfig = {
    nextIndex: bigint;
    itemCode: Cell;
    ledgerAddr: Address; // placeholder pre-SetLedger; see D7 in primes_collection.tolk
    genesisScriptAddr: Address;
    // CONCEPT §3.1 secondary royalty (TEP-66) + TEP-64 offchain content.
    // Defaults keep every existing test and script constructing a collection
    // without naming them; genesis passes the real values from params.json.
    royaltyNum?: number;
    royaltyDen?: number;
    // Genesis passes the OPERATOR wallet (D-100 point 6 left this line where it was);
    // unset, it falls back to `genesisScriptAddr` so a test can build a collection
    // without naming a destination.
    royaltyDest?: Address;
    collectionContent?: Cell;
    commonContentPrefix?: Cell;
    /**
     * D-212: the registrar, the one sender of `naming_paid` besides the items (a trophy's
     * paid re-engraving). Deploy-fixed — the registrar's address depends on nothing but its
     * code and deploy data, so compute it first.
     */
    registrarAddr?: Address;
    /** D-212 (§4.7.1): the first naming's fee and every later one's, nanoGRAM. Deploy data,
     *  no setter. Tests default to 1 GRAM / 200 GRAM. */
    nameFee?: bigint;
    renameFee?: bigint;
};

export const CollectionOpcodes = {
    MintItem: COLLECTION.mint_item,
    Populate: COLLECTION.populate,
    SetLedger: COLLECTION.set_ledger,
    // 0xc0000004 (SetAuction) was the D17 genesis-auction bootstrap. D-20 deleted
    // the genesis lot and the market's own direct `MintItem` send, leaving the
    // collection with a second minting authority nothing ever used — deleted,
    // gauntlet V12 2026-09-09. 0xc0000005 (Claim) and 0xc0000007 (Reclaim) were
    // patron mode's, and D-106 deleted them with it: no item is ever ownerless,
    // so there is nothing to claim and nothing to reclaim.
    NameNumber: COLLECTION.name_number, // D-212
    ItemName: COLLECTION.item_name,
    NamingPaid: COLLECTION.naming_paid,
    GetRoyaltyParams: COLLECTION.get_royalty_params, // TEP-66 request
    ReportRoyaltyParams: COLLECTION.report_royalty_params, // TEP-66 response
};

/** TEP-64 snake-encoded ASCII, as one cell. Prefixes here are short (a URL). */
export function snakeCell(text: string): Cell {
    return beginCell().storeBuffer(Buffer.from(text, 'utf8')).endCell();
}

function collectionConfigToCell(config: CollectionConfig): Cell {
    return beginCell()
        .storeUint(config.nextIndex, 256)
        .storeRef(config.itemCode)
        .storeAddress(config.ledgerAddr)
        .storeUint(0, 8) // ledgerSet
        // W7: `RoyaltyMeters`, zeroed. Its own ref rather than three root fields —
        // see the struct's comment in the contract for why.
        .storeRef(beginCell().storeCoins(0).storeCoins(0).storeUint(0, 32).endCell())
        .storeRef(
            beginCell()
                .storeAddress(config.genesisScriptAddr)
                .storeUint(config.royaltyNum ?? 500, 16) // 5%
                .storeUint(config.royaltyDen ?? 10000, 16)
                .storeAddress(config.royaltyDest ?? config.genesisScriptAddr)
                .storeRef(config.collectionContent ?? beginCell().endCell())
                .storeRef(config.commonContentPrefix ?? beginCell().endCell())
                .storeAddress(config.registrarAddr ?? config.genesisScriptAddr)
                .endCell()
        )
        // D-212: `NamingBook` — the two fees (deploy data), then named/renamed/toFloor, zeroed.
        .storeRef(
            beginCell()
                .storeCoins(config.nameFee ?? DEFAULT_NAME_FEE)
                .storeCoins(config.renameFee ?? DEFAULT_RENAME_FEE)
                .storeUint(0, 32)
                .storeUint(0, 32)
                .storeCoins(0)
                .endCell()
        )
        .endCell();
}

/** Test-harness defaults (D-212): a 1 GRAM first naming, the owner's 200 GRAM rename. Genesis
 *  passes the real figures; nothing else may rely on these. */
export const DEFAULT_NAME_FEE = 1_000_000_000n;
export const DEFAULT_RENAME_FEE = 200_000_000_000n;

export class PrimesCollection implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesCollection(address);
    }

    static createFromConfig(config: CollectionConfig, code: Cell, workchain = 0) {
        const data = collectionConfigToCell(config);
        const init = { code, data };
        return new PrimesCollection(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendSetLedger(provider: ContractProvider, via: Sender, opts: { ledgerAddr: Address; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CollectionOpcodes.SetLedger, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.ledgerAddr)
                .endCell(),
        });
    }

    /** D-212 (§4.7.1): name number `n` you own. `value` must cover the fee + NAME_RELAY_GAS;
     *  every refusal refunds. Surfaces build it with `buildNameNumberMessage`. */
    async sendNameNumber(provider: ContractProvider, via: Sender, opts: { n: bigint; text: Cell; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: encodeNameNumberBody({ n: opts.n, text: opts.text, queryId: BigInt(opts.queryID ?? 0) }),
        });
    }

    /** D-212 (§4.7.1, §9.1): (nameFee, renameFee, named, renamed, toFloor). */
    async getNaming(provider: ContractProvider) {
        const r = await provider.get('getNaming', []);
        return {
            nameFee: r.stack.readBigNumber(),
            renameFee: r.stack.readBigNumber(),
            named: r.stack.readNumber(),
            renamed: r.stack.readNumber(),
            toFloor: r.stack.readBigNumber(),
        };
    }

    async getCollectionData(provider: ContractProvider) {
        const result = await provider.get('getCollectionData', []);
        const nextIndex = result.stack.readBigNumber();
        const ledgerAddr = result.stack.readAddress();
        return { nextIndex, ledgerAddr };
    }

    async getItemAddress(provider: ContractProvider, n: bigint) {
        const result = await provider.get('getItemAddress', [{ type: 'int', value: n }]);
        return result.stack.readAddress();
    }

    // ---- TEP-62 / TEP-66 standard surface (CONCEPT §3.1) ----
    // Resolved by their exact standard names; that is the whole point of them
    // existing alongside the camelCase getters.

    async getRoyaltyParams(provider: ContractProvider) {
        const result = await provider.get('royalty_params', []);
        const numerator = result.stack.readNumber();
        const denominator = result.stack.readNumber();
        const destination = result.stack.readAddress();
        return { numerator, denominator, destination };
    }

    async getStandardCollectionData(provider: ContractProvider) {
        const result = await provider.get('get_collection_data', []);
        const nextItemIndex = result.stack.readBigNumber();
        const collectionContent = result.stack.readCell();
        const ownerAddress = result.stack.readAddress();
        return { nextItemIndex, collectionContent, ownerAddress };
    }

    async getNftAddressByIndex(provider: ContractProvider, index: bigint) {
        const result = await provider.get('get_nft_address_by_index', [
            { type: 'int', value: index },
        ]);
        return result.stack.readAddress();
    }

    async getNftContent(provider: ContractProvider, index: bigint, individualContent: Cell) {
        const result = await provider.get('get_nft_content', [
            { type: 'int', value: index },
            { type: 'cell', cell: individualContent },
        ]);
        return result.stack.readCell();
    }

    /**
     * W7 — the REALISED royalty split: `(toRatchet, toOperator, forwards)`, cumulative.
     * D-128 divides 50/50 of the NET, and the net is what is left after
     * `ROYALTY_FORWARD_GAS`, so the split a holder experiences is not the nominal one.
     * `forwards * ROYALTY_FORWARD_GAS` is the delivery cost so far.
     */
    async getRoyaltySplit(provider: ContractProvider) {
        const r = await provider.get('getRoyaltySplit', []);
        return {
            toRatchetNanoton: r.stack.readBigNumber(),
            toOperatorNanoton: r.stack.readBigNumber(),
            forwards: r.stack.readNumber(),
        };
    }

}
