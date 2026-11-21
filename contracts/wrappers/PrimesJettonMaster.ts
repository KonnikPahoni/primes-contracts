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
import { JETTON_MASTER } from '../../shared/opcodes';

export type JettonMasterConfig = {
    ledgerAddr: Address; // placeholder pre-SetLedger; see D7 in primes_jetton_master.tolk
    genesisScriptAddr: Address;
    walletCode: Cell;
    /**
     * TEP-64 metadata, returned verbatim by `get_jetton_data`. Optional so every existing
     * test and rehearsal keeps constructing a master without naming it — the same default
     * pattern as CollectionConfig.collectionContent.
     *
     * A real deploy MUST pass this. An empty cell is a well-formed jetton that wallets and
     * explorers render as an unnamed token with no symbol and no decimals, which for the
     * DeDust side of the ratchet (§4.3) is the difference between a listable asset and one
     * nobody can identify. Build it with `offchainContentCell(uri)`.
     */
    content?: Cell;
};

/**
 * TEP-64 off-chain content: a 0x01 tag byte followed by the snake-encoded URI of a JSON
 * document holding name/symbol/decimals/image.
 *
 * Off-chain rather than on-chain by deliberate choice, and the one place in this repo where
 * that trade goes this way: the metadata is presentation, not a claim a reader needs to
 * verify. Every number CONCEPT §9.1 governs is recomputable from a get-method, and none of
 * them live here. Putting a name and an image URL in a dictionary on chain would cost gas
 * at genesis to make a marketing string tamper-evident.
 */
export function offchainContentCell(uri: string): Cell {
    return beginCell()
        .storeUint(0x01, 8)
        .storeBuffer(Buffer.from(uri, 'utf8'))
        .endCell();
}

/**
 * Inverse of `offchainContentCell`, and of the `0x01`-tagged cell
 * `primes_collection.tolk`'s `get_nft_content` composes.
 *
 * Deliberately does NOT follow TEP-64 snake refs: nothing in this repo writes them,
 * because `validateGenesisMetadata` (genesisPipeline.ts) caps every URI at what fits in
 * one cell. A ref-chained content cell reaching this function means something other than
 * our own deploy wrote it, and reading only the head would be the silently-wrong answer —
 * so it throws instead.
 */
export function decodeOffchainContent(content: Cell): string {
    const s = content.beginParse();
    if (s.remainingBits < 8) {
        throw new Error('content cell is empty — no TEP-64 tag, so no name, symbol or decimals');
    }
    const tag = s.loadUint(8);
    if (tag !== 0x01) {
        throw new Error(`expected the TEP-64 off-chain content tag 0x01, got 0x${tag.toString(16)}`);
    }
    if (s.remainingRefs > 0) {
        throw new Error('content cell is snake-chained; this decoder only reads single-cell URIs');
    }
    return s.loadBuffer(Math.floor(s.remainingBits / 8)).toString('utf8');
}

function jettonMasterConfigToCell(config: JettonMasterConfig): Cell {
    return beginCell()
        .storeCoins(0)
        .storeAddress(config.ledgerAddr)
        .storeAddress(config.genesisScriptAddr)
        .storeUint(0, 8) // genesisSealed
        .storeRef(config.walletCode)
        .storeUint(0, 8) // ledgerSet
        .storeRef(config.content ?? beginCell().endCell())
        .endCell();
}

export class PrimesJettonMaster implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesJettonMaster(address);
    }

    static createFromConfig(config: JettonMasterConfig, code: Cell, workchain = 0) {
        const data = jettonMasterConfigToCell(config);
        const init = { code, data };
        return new PrimesJettonMaster(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendMintGenesis(provider: ContractProvider, via: Sender, opts: { to: Address; amount: bigint; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JETTON_MASTER.mint_genesis, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.to)
                .storeCoins(opts.amount)
                .endCell(),
        });
    }

    async sendSetLedger(provider: ContractProvider, via: Sender, opts: { ledgerAddr: Address; value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JETTON_MASTER.set_ledger, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.ledgerAddr)
                .endCell(),
        });
    }

    async sendSealAuthority(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JETTON_MASTER.seal_authority, 32).storeUint(opts.queryID ?? 0, 64).endCell(),
        });
    }

    async getJettonData(provider: ContractProvider) {
        const result = await provider.get('getJettonData', []);
        const totalSupply = result.stack.readBigNumber();
        const genesisSealed = result.stack.readNumber();
        const ledgerAddr = result.stack.readAddress();
        const walletCode = result.stack.readCell();
        return { totalSupply, genesisSealed, ledgerAddr, walletCode };
    }

    async getWalletAddress(provider: ContractProvider, owner: Address) {
        const result = await provider.get('getWalletAddress', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return result.stack.readAddress();
    }

    // ---- TEP-74 standard surface, called by the exact standard name ----
    // These go through the same `provider.get(name)` path a wallet or explorer uses, so a
    // test calling them proves the method ID is actually exported — which is the whole
    // failure being guarded against, since the camelCase getters above pass either way.

    async getJettonDataStandard(provider: ContractProvider) {
        const result = await provider.get('get_jetton_data', []);
        const totalSupply = result.stack.readBigNumber();
        const mintable = result.stack.readNumber();
        const adminAddress = result.stack.readAddress();
        const jettonContent = result.stack.readCell();
        const jettonWalletCode = result.stack.readCell();
        return { totalSupply, mintable, adminAddress, jettonContent, jettonWalletCode };
    }

    async getWalletAddressStandard(provider: ContractProvider, owner: Address) {
        const result = await provider.get('get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return result.stack.readAddress();
    }
}
