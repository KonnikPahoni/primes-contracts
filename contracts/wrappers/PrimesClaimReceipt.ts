import { Address, beginCell, Cell, Contract, ContractProvider, contractAddress } from '@ton/core';
// The receipt's three messages (`receipt_advance`/`_delta`/`_restore`) live in the VOUCHER
// block: only the voucher ever sends to a receipt, and this wrapper builds no body of its own.
// The re-export has no importer; it is what keeps this wrapper on the registry
// (`OpcodeRegistryRule.spec.ts`: every wrapper reads shared/opcodes).
export { VOUCHER as RECEIPT_OPS } from '../../shared/opcodes';

/**
 * D-191 point 2 (GAUNTLET.md V26.3): one claim receipt per (voucher, claimant), holding
 * the claimant's cumulative high-water mark. The voucher deploys it on the first claim;
 * nothing else ever does. Init data mirrors primes_claim_receipt.tolk's `Storage` in its
 * empty state, so this derivation must equal the voucher's `getReceiptAddress(wallet)`.
 */
export class PrimesClaimReceipt implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesClaimReceipt(address);
    }

    static createFromConfig(config: { voucherAddr: Address; claimant: Address }, code: Cell, workchain = 0) {
        const data = beginCell()
            .storeAddress(config.voucherAddr)
            .storeAddress(config.claimant)
            .storeCoins(0)
            .endCell();
        const init = { code, data };
        return new PrimesClaimReceipt(contractAddress(workchain, init), init);
    }

    /** Cumulative nano-PRIMES the voucher has paid this claimant. */
    async getPaid(provider: ContractProvider) {
        return (await provider.get('getPaid', [])).stack.readBigNumber();
    }

    /** `getPaid()`, or 0 while the receipt is undeployed (nothing was ever paid). */
    async getPaidOrZero(provider: ContractProvider) {
        const st = await provider.getState();
        return st.state.type === 'active' ? (await provider.get('getPaid', [])).stack.readBigNumber() : 0n;
    }

    /** (voucherAddr, claimant). */
    async getReceiptOwner(provider: ContractProvider) {
        const r = await provider.get('getReceiptOwner', []);
        return { voucherAddr: r.stack.readAddress(), claimant: r.stack.readAddress() };
    }
}
