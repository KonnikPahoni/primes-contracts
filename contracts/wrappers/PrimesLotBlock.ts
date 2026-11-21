import { Address, Cell, Contract, ContractProvider } from '@ton/core';
import { lotBlockCode, lotBlockInit } from '../../shared/lotBlock';
import { contractAddress } from '@ton/core';
// No importer: keeps this wrapper on the registry (`OpcodeRegistryRule.spec.ts`).
export { LOT_BLOCK as LOT_BLOCK_OPS } from '../../shared/opcodes';

/**
 * D-196 (GAUNTLET.md V30): one lot block per (ledger, 256-number block) beyond the
 * ledger's import frontier, holding that block's auction marks until the import. The
 * ledger deploys and writes it; nothing else does, so this wrapper builds no body.
 */
export class PrimesLotBlock implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesLotBlock(address);
    }

    static forBlock(ledger: Address, block: bigint | number, code: Cell = lotBlockCode()) {
        const init = lotBlockInit(ledger, block, code);
        return new PrimesLotBlock(contractAddress(0, init), { code: init.code!, data: init.data! });
    }

    /** (claimed, soldPrime), bit `n & 255` of each. */
    async getWords(provider: ContractProvider) {
        const r = await provider.get('getWords', []);
        return { claimed: r.stack.readBigNumber(), soldPrime: r.stack.readBigNumber() };
    }

    /** `getWords()`, or zeros while undeployed (no lot has touched the block). */
    async getWordsOrZero(provider: ContractProvider) {
        const st = await provider.getState();
        return st.state.type === 'active' ? this.getWords(provider) : { claimed: 0n, soldPrime: 0n };
    }

    /** D-198: prime n's unsold bookmark — `entry` (2^120 − 1 once released at its sale) and
     *  its forfeit counter as of the flush, frozen. `found: false` = never flushed here. */
    async getBookmark(provider: ContractProvider, n: bigint) {
        const r = await provider.get('getBookmark', [{ type: 'int', value: n }]);
        return { found: r.stack.readNumber() === 1, entry: r.stack.readBigNumber(), forfeited: r.stack.readBigNumber() };
    }

    /** (ledgerAddr, block). */
    async getLotBlockOwner(provider: ContractProvider) {
        const r = await provider.get('getLotBlockOwner', []);
        return { ledgerAddr: r.stack.readAddress(), block: r.stack.readBigNumber() };
    }
}
