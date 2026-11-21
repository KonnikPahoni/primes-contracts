import { Address, Contract, ContractProvider, Sender, SendMode, beginCell } from '@ton/core';
import { ITEM } from '../../shared/opcodes';
import { buildClaimTributeMessage, buildTopUpMessage } from '../../shared/messages';

export class PrimesItem implements Contract {
    constructor(readonly address: Address) {}

    static createFromAddress(address: Address) {
        return new PrimesItem(address);
    }

    async sendClaimTribute(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buildClaimTributeMessage({ queryId: BigInt(opts.queryID ?? 0) }).body,
        });
    }

    async sendTransfer(provider: ContractProvider, via: Sender, opts: { newOwner: Address; value: bigint; queryID?: number; responseDestination?: Address | null; forwardAmount?: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(ITEM.transfer, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.newOwner)
                .storeAddress(opts.responseDestination ?? null)
                .storeMaybeRef(null)
                .storeCoins(opts.forwardAmount ?? 0n)
                .storeUint(0, 1)
                .endCell(),
        });
    }

    /** D-62/GAUNTLET.md D9.1: permissionless — anyone may extend a composite's rent runway. */
    async sendTopUp(provider: ContractProvider, via: Sender, opts: { value: bigint; queryID?: number }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buildTopUpMessage({ queryId: BigInt(opts.queryID ?? 0) }).body,
        });
    }

    async getNumberData(provider: ContractProvider) {
        const result = await provider.get('getNumberData', []);
        const n = result.stack.readBigNumber();
        const owner = result.stack.readAddress();
        const isPrime = result.stack.readNumber();
        return { n, owner, isPrime };
    }

    /**
     * CONCEPT §9.8 / §9.1: the mint date, in DAYS SINCE THE UNIX EPOCH.
     *
     * The NFT artwork prints this date on its overlay strip, and §9.1's rule is that every
     * number the UI shows maps to a public get-method — so the picture is checkable against
     * the chain rather than against an indexer. 0 until `Populate` lands.
     */
    async getMintedDay(provider: ContractProvider) {
        return (await provider.get('getMintedDay', [])).stack.readNumber();
    }

    async getOwed(provider: ContractProvider) {
        const result = await provider.get('getOwed', []);
        return result.stack.readBigNumber();
    }

    /**
     * D-72 / GAUNTLET T4 (D9.1). Seconds until this item freezes at the CURRENT
     * config-18 storage price, or -1 when the price is zero and the runway is
     * therefore unbounded. Pairs with the permissionless `TopUp` (D-62): that
     * opcode extends the runway, this reports it, and until this existed no
     * surface could tell anyone when to use it.
     */
    /** D-188 point 4 / §3.2 — the flat dividend's bookmark `entry[p]`, held on the item. */
    async getDivEntry(provider: ContractProvider) {
        return (await provider.get('getDivEntry', [])).stack.readBigNumber();
    }

    /** `max(0, divAcc − entry[p])` for the ledger's `getDivAcc()` the caller passes. */
    async getClaimableDividend(provider: ContractProvider, divAcc: bigint) {
        return (await provider.get('getClaimableDividend', [{ type: 'int', value: divAcc }])).stack.readBigNumber();
    }

    /** §6 point 2 — the forfeit counter handed over at sale; frozen once the prime is owned. */
    async getForfeited(provider: ContractProvider) {
        return (await provider.get('getForfeited', [])).stack.readBigNumber();
    }

    /** CONCEPT §3.2.1 — cumulative divisor tribute ever credited; a claim does not lower it. */
    async getTributeTotal(provider: ContractProvider) {
        return (await provider.get('getTributeTotal', [])).stack.readBigNumber();
    }

    /** CONCEPT §9.11 / D-177 (G89) — cumulative §4.1 referral TON this key has relayed, as received. */
    async getReferralPaid(provider: ContractProvider) {
        return (await provider.get('getReferralPaid', [])).stack.readBigNumber();
    }

    /**
     * §4.7.1 / D-212: who holds the pen on this number — its CURRENT OWNER. null before
     * Populate lands.
     */
    async getNamer(provider: ContractProvider): Promise<Address | null> {
        return (await provider.get('getNamer', [])).stack.readAddressOpt();
    }

    /** §4.7.1 / D-212: (count, text); count 0 means unnamed — the next naming costs `nameFee`, else `renameFee`. */
    async getAnnotation(provider: ContractProvider) {
        const r = await provider.get('getAnnotation', []);
        return { count: r.stack.readNumber(), text: r.stack.readCell() };
    }

    async getStorageRunway(provider: ContractProvider) {
        const result = await provider.get('getStorageRunway', []);
        return result.stack.readBigNumber();
    }

    /**
     * TEP-62 `get_nft_data`, resolved by its exact standard name — which is the
     * point of it existing alongside `getNumberData`. Marketplaces, wallets and
     * indexers call this one and nothing else, and CONCEPT §3.1's royalty is
     * uncollectable if they cannot read the item.
     */
    async getNftData(provider: ContractProvider) {
        const result = await provider.get('get_nft_data', []);
        return {
            init: result.stack.readNumber(),
            index: result.stack.readBigNumber(),
            collectionAddress: result.stack.readAddress(),
            ownerAddress: result.stack.readAddress(),
            individualContent: result.stack.readCell(),
        };
    }
}
