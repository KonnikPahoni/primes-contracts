import {
    Address,
    beginCell,
    Builder,
    Cell,
    Contract,
    ContractProvider,
    contractAddress,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
} from '@ton/core';
import { BOUNTY_VAULT } from '../../shared/opcodes';

/**
 * One entry of the genesis-fixed era schedule (DENOMINATION_PLAN P4).
 *
 * `bountyTon` is what the ceremony is WORTH and is the number the design fixes;
 * `maxPrimes` is what that TON buys at the genesis floor and is the largest the
 * boundary can ever pay. The vault pays `min(bountyTon * S / T, maxPrimes)`.
 */
export type EraBounty = { eraBoundary: bigint; bountyTon: bigint; maxPrimes: bigint };

export type AllowEntry = { addressHash: bigint; programTag: number; remaining: bigint };

/** SPECIAL_NUMBERS_PLAN.md Phase 2: tier (0=discount,1=free,2=bonus) -> (TON value, PRIMES cap). */
/** D-99 §1.5 — one entry of the two-entry rebate schedule. `tier` is the KIND
 *  (0 = composite per point, 1 = prime family); the word survives only as a
 *  dictionary key name. */
export type RebateScheduleEntry = { tier: number; bountyTon: bigint; maxPrimes: bigint };

export type BountyVaultConfig = {
    schedule: EraBounty[];
    ledgerAddr: Address;
    jettonMasterAddr: Address;
    genesisScriptAddr: Address;
    /**
     * V26.7 — the nanoPRIMES genesis mints into the vault's wallet
     * (`genesis.bounty_vault_size_primes`). No default: an era bounty or special
     * rebate that `fundedPrimes - paidTotal` cannot cover is refused unsent.
     */
    fundedPrimes: bigint;
    /** Genesis-fixed program tracks, one per program, each under a DISTINCT `programTag` (V26.1). */
    allowlist?: AllowEntry[];
    /**
      * D-99 §1.5 — genesis-fixed, EXACTLY TWO entries. Kind 0
      * (`REBATE_COMPOSITE_PER_POINT`) is PER POINT of D(n): the vault multiplies
      * both `bountyTon` and `maxPrimes` by the score the ledger reports. Kind 1
      * (`REBATE_PRIME_FAMILY`) is flat.
      */
     rebateSchedule?: RebateScheduleEntry[];
};

const EraEntryValue: DictionaryValue<{ bountyTon: bigint; maxPrimes: bigint }> = {
    serialize(src, builder: Builder) {
        builder.storeCoins(src.bountyTon).storeCoins(src.maxPrimes);
    },
    parse(slice) {
        return { bountyTon: slice.loadCoins(), maxPrimes: slice.loadCoins() };
    },
};

const AllowValue: DictionaryValue<{ programTag: number; remaining: bigint }> = {
    serialize(src, builder: Builder) {
        builder.storeUint(src.programTag, 32).storeCoins(src.remaining);
    },
    parse(slice) {
        return { programTag: slice.loadUint(32), remaining: slice.loadCoins() };
    },
};

function bountyVaultConfigToCell(config: BountyVaultConfig): Cell {
    const schedule = Dictionary.empty(Dictionary.Keys.BigUint(256), EraEntryValue);
    config.schedule.forEach((e) =>
        schedule.set(e.eraBoundary, { bountyTon: e.bountyTon, maxPrimes: e.maxPrimes })
    );
    const allowlist = Dictionary.empty(Dictionary.Keys.BigUint(256), AllowValue);
    // V26.1: a bounced program payout finds its track again by `programTag`
    // alone (it rides in the queryId), so two entries under one tag would let
    // one program's bounce re-credit the other's track.
    const tags = (config.allowlist ?? []).map((e) => e.programTag);
    if (new Set(tags).size !== tags.length) throw new Error('bounty vault allow-list: duplicate programTag');
    (config.allowlist ?? []).forEach((e) =>
        allowlist.set(e.addressHash, { programTag: e.programTag, remaining: e.remaining })
    );
    const rebateSchedule = Dictionary.empty(Dictionary.Keys.Uint(8), EraEntryValue);
    (config.rebateSchedule ?? []).forEach((e) =>
        rebateSchedule.set(e.tier, { bountyTon: e.bountyTon, maxPrimes: e.maxPrimes })
    );
    return beginCell()
        .storeDict(schedule)
        .storeDict(undefined) // paidEras
        .storeDict((config.allowlist ?? []).length > 0 ? allowlist : undefined)
        .storeCoins(config.fundedPrimes) // fundedPrimes — V26.7
        .storeCoins(0) // paidTotal — §3.3 / §11.21
        .storeUint(0, 32) // payoutCount
        .storeUint(0, 64) // journalKey — H12/D-129, split from payoutCount
        .storeUint(0, 32) // deferredCount — H12/D-129
        .storeRef(
            beginCell()
                .storeAddress(config.ledgerAddr)
                .storeAddress(config.jettonMasterAddr)
                .storeRef(
                    beginCell()
                        .storeAddress(config.genesisScriptAddr) // jettonWalletAddr placeholder
                        .storeUint(0, 8) // walletSet
                        .storeAddress(config.genesisScriptAddr)
                        .storeRef(
                            // SPECIAL_NUMBERS_PLAN.md Phase 2 — hung off VaultConfigB
                            // rather than a fourth top-level ref (4-ref cell limit).
                            beginCell()
                                .storeDict((config.rebateSchedule ?? []).length > 0 ? rebateSchedule : undefined)
                                .storeDict(undefined) // paidSpecials
                                .endCell()
                        )
                        .storeDict(undefined) // retryJournal — D-53/B12.1
                        .endCell()
                )
                .endCell()
        )
        .endCell();
}

export class PrimesBountyVault implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesBountyVault(address);
    }

    static createFromConfig(config: BountyVaultConfig, code: Cell, workchain = 0) {
        const data = bountyVaultConfigToCell(config);
        const init = { code, data };
        return new PrimesBountyVault(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() });
    }

    async sendSetWallet(
        provider: ContractProvider,
        via: Sender,
        opts: { jettonWalletAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(BOUNTY_VAULT.set_wallet, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.jettonWalletAddr)
                .endCell(),
        });
    }

    async sendPayEraBounty(
        provider: ContractProvider,
        via: Sender,
        opts: {
            eraBoundary: bigint;
            beneficiary: Address;
            value: bigint;
            queryID?: number;
            /** Ledger's post-mint T (nanoTON) and S (nano-PRIMES). P4: the vault
             *  prices the ceremony at `T/S`, capped by the entry's `maxPrimes`. */
            t: bigint;
            s: bigint;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(BOUNTY_VAULT.pay_era_bounty, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.eraBoundary, 256)
                .storeAddress(opts.beneficiary)
                .storeCoins(opts.t)
                .storeCoins(opts.s)
                .endCell(),
        });
    }

    async sendPaySpecialNumberRebate(
        provider: ContractProvider,
        via: Sender,
        opts: {
            n: bigint;
            /** 0 = composite per point, 1 = prime family. */
            kind: number;
            /** D(n). Multiplies the schedule on kind 0, ignored on kind 1. */
            points: number;
            beneficiary: Address;
            value: bigint;
            queryID?: number;
            t: bigint;
            s: bigint;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(BOUNTY_VAULT.pay_special_number_rebate, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.n, 256)
                .storeUint(opts.kind, 8)
                .storeUint(opts.points, 16)
                .storeAddress(opts.beneficiary)
                .storeCoins(opts.t)
                .storeCoins(opts.s)
                .endCell(),
        });
    }

    async sendPayProgramBounty(
        provider: ContractProvider,
        via: Sender,
        opts: { programTag: number; beneficiary: Address; amount: bigint; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(BOUNTY_VAULT.pay_program_bounty, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.programTag, 32)
                .storeAddress(opts.beneficiary)
                .storeCoins(opts.amount)
                .endCell(),
        });
    }

    /** D-53/B12.1: replays a deferred or bounced era/special payout by its journal key (V26.1: nothing else is journalled). */
    async sendRetryBountyPayout(
        provider: ContractProvider,
        via: Sender,
        opts: { queryID: number; value: bigint }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(BOUNTY_VAULT.retry_bounty_payout, 32)
                .storeUint(opts.queryID, 64)
                .endCell(),
        });
    }

    /** (scheduled, bountyTon, maxPrimes, paid) — two amounts since P4; see EraBounty. */
    async getEraSchedule(provider: ContractProvider, eraBoundary: bigint) {
        const result = await provider.get('getEraSchedule', [{ type: 'int', value: eraBoundary }]);
        return {
            scheduled: result.stack.readNumber(),
            bountyTon: result.stack.readBigNumber(),
            maxPrimes: result.stack.readBigNumber(),
            paid: result.stack.readNumber(),
        };
    }

    /**
      * (scheduled, bountyTon, maxPrimes, paid) for a rebate kind + number `n`.
      * On kind 0 the two amounts are PER POINT — multiply by D(n) to get what a
      * given number is actually owed.
      */
    async getRebateSchedule(provider: ContractProvider, kind: number, n: bigint) {
        const result = await provider.get('getRebateSchedule', [
            { type: 'int', value: BigInt(kind) },
            { type: 'int', value: n },
        ]);
        return {
            scheduled: result.stack.readNumber(),
            bountyTon: result.stack.readBigNumber(),
            maxPrimes: result.stack.readBigNumber(),
            paid: result.stack.readNumber(),
        };
    }

    /** §3.3 / §11.21 — (paidTotal, payoutCount) in nano-PRIMES, never netted against burns. */
    async getVaultPayouts(provider: ContractProvider) {
        const result = await provider.get('getVaultPayouts', []);
        return {
            paidTotalPrimes: result.stack.readBigNumber(),
            payoutCount: result.stack.readNumber(),
        };
    }

    /** V26.7 — the declared genesis funding the pushed routes are gated on. */
    async getVaultFunded(provider: ContractProvider) {
        return (await provider.get('getVaultFunded', [])).stack.readBigNumber();
    }

    /**
     * H12/D-129 — journal rows written but unpaid (deferred by the balance
     * guard, or rolled back by a bounce), and the next low-half journal key.
     * `journalKey` bounds the scan a retrier walks: a deferred row was never
     * sent, so unlike a bounced one it announces no queryId of its own.
     */
    async getDeferredPayouts(provider: ContractProvider): Promise<{ deferredCount: number; journalKey: number }> {
        const result = await provider.get('getDeferredPayouts', []);
        return { deferredCount: result.stack.readNumber(), journalKey: result.stack.readNumber() };
    }

    /**
     * GAUNTLET.md G59 — one journal row, and whether `RetryBountyPayout` on its key
     * would pay (`retryable`, the retry arm's own asserts). A scan gates on this ROW
     * before it sends, never on `getDeferredPayouts()`'s counter.
     */
    async getRetryEntry(provider: ContractProvider, key: bigint) {
        const result = await provider.get('getRetryEntry', [{ type: 'int', value: key }]);
        return {
            found: result.stack.readNumber() === 1,
            retryable: result.stack.readNumber() === 1,
            kind: result.stack.readNumber(),
            entryKey: result.stack.readBigNumber(),
            amount: result.stack.readBigNumber(),
        };
    }

    async getVaultConfig(provider: ContractProvider) {
        const result = await provider.get('getVaultConfig', []);
        return {
            ledgerAddr: result.stack.readAddress(),
            jettonMasterAddr: result.stack.readAddress(),
            jettonWalletAddr: result.stack.readAddress(),
            walletSet: result.stack.readNumber(),
        };
    }

    /**
     * D-170 point 4 / F79 — the allow-list entry under `programTag`: whether it exists,
     * the program contract's address hash, and the nanoPRIMES it may still spend.
     */
    async getProgram(provider: ContractProvider, programTag: number) {
        const r = await provider.get('getProgram', [{ type: 'int', value: BigInt(programTag) }]);
        return {
            found: r.stack.readNumber() === 1,
            addrHash: r.stack.readBigNumber(),
            remaining: r.stack.readBigNumber(),
        };
    }

    async isAllowlisted(provider: ContractProvider, addrHash: bigint) {
        return (await provider.get('isAllowlisted', [{ type: 'int', value: addrHash }])).stack.readNumber();
    }
}
