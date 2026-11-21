import { Address, beginCell, Cell, Contract, ContractProvider, contractAddress } from '@ton/core';
import { minterCardCode, minterCardData, minterCardInit } from '../../shared/minterCard';
import { MINTER_CARD } from '../../shared/opcodes';

/** The card's wire values, from the registry (shared/opcodes.ts `MINTER_CARD`). */
export const MinterCardOpcodes = MINTER_CARD;

/**
 * TON PRIMES — the MINTER CARD wrapper (DECISIONS.md D-191 point 1,
 * `primes_minter_card.tolk`). One card per (ledger, wallet); a mint is sent to the
 * BENEFICIARY's card (see `PrimesLedger.sendMint`). Every getter reads a card that was
 * never deployed as zero standing — that wallet has never been part of an accepted event.
 */
export type MinterCardState = {
    primesMinted: number;
    window: number;
    newcomerWindow: number;
    recruits: number;
    newcomerOpened: boolean;
    seen: boolean;
    eraSeq: number;
    eraRecruits: number;
    inFlight: number;
    edgeSentAt: number;
};

/** The card's full `Storage` cell — `minterCardData` is the empty case of the same layout. */
export function minterCardDataWith(ledger: Address, owner: Address, s: Partial<MinterCardState>): Cell {
    return beginCell()
        .storeAddress(ledger)
        .storeAddress(owner)
        .storeUint(s.primesMinted ?? 0, 32)
        .storeUint(s.window ?? 0, 8)
        .storeUint(s.newcomerWindow ?? 0, 8)
        .storeUint(s.recruits ?? 0, 32)
        .storeBit(s.newcomerOpened ?? (s.newcomerWindow ?? 0) > 0)
        .storeBit(s.seen ?? false)
        .storeUint(s.eraSeq ?? 0, 8)
        .storeUint(s.eraRecruits ?? 0, 32)
        .storeUint(s.inFlight ?? 0, 32)
        .storeUint(s.edgeSentAt ?? 0, 32)
        .endCell();
}

export class PrimesMinterCard implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesMinterCard(address);
    }

    static forWallet(ledger: Address, owner: Address, code: Cell = minterCardCode()) {
        const init = minterCardInit(ledger, owner, code);
        return new PrimesMinterCard(contractAddress(0, init), { code: init.code!, data: init.data! });
    }

    private async active(provider: ContractProvider) {
        return (await provider.getState()).state.type === 'active';
    }

    /** (primesMinted, tier, uplift, window) — the ledger's old `getMinterState(owner)`. */
    async getMinterState(provider: ContractProvider) {
        if (!(await this.active(provider))) return { primesMinted: 0, tier: 0, uplift: 0n, window: 0 };
        const r = await provider.get('getMinterState', []);
        return {
            primesMinted: r.stack.readNumber(),
            tier: r.stack.readNumber(),
            uplift: r.stack.readBigNumber(),
            window: r.stack.readNumber(),
        };
    }

    async getRecruitRank(provider: ContractProvider) {
        if (!(await this.active(provider))) return { recruits: 0, tier: 0, uplift: 0n, nextTierAt: 1 };
        const r = await provider.get('getRecruitRank', []);
        return {
            recruits: r.stack.readNumber(),
            tier: r.stack.readNumber(),
            uplift: r.stack.readBigNumber(),
            nextTierAt: r.stack.readNumber(),
        };
    }

    /** `total`/`uplift` are the contract's constants, so an undeployed card reads them as 0. */
    async getNewcomerWindow(provider: ContractProvider) {
        if (!(await this.active(provider))) return { left: 0, total: 0, uplift: 0n, opened: false };
        const r = await provider.get('getNewcomerWindow', []);
        return {
            left: r.stack.readNumber(),
            total: r.stack.readNumber(),
            uplift: r.stack.readBigNumber(),
            opened: r.stack.readBoolean(),
        };
    }

    async getUpliftLine(provider: ContractProvider) {
        if (!(await this.active(provider)))
            return { primeRank: 0n, primeWindow: 0n, newcomer: 0n, recruitRank: 0n, summed: 0n };
        const r = await provider.get('getUpliftLine', []);
        return {
            primeRank: r.stack.readBigNumber(),
            primeWindow: r.stack.readBigNumber(),
            newcomer: r.stack.readBigNumber(),
            recruitRank: r.stack.readBigNumber(),
            summed: r.stack.readBigNumber(),
        };
    }

    /** (eraSeq, eraRecruits) — this era's count only while `eraSeq` equals the ledger's. */
    async getEraRecruits(provider: ContractProvider) {
        if (!(await this.active(provider))) return { eraSeq: 0, eraRecruits: 0 };
        const r = await provider.get('getEraRecruits', []);
        return { eraSeq: r.stack.readNumber(), eraRecruits: r.stack.readNumber() };
    }

    async getCardOwner(provider: ContractProvider) {
        const r = await provider.get('getCardOwner', []);
        return { ledger: r.stack.readAddress(), owner: r.stack.readAddress(), seen: r.stack.readBoolean() };
    }
}

export { minterCardCode, minterCardData };
