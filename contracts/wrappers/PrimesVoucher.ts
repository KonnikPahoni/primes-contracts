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
import { VOUCHER } from '../../shared/opcodes';
import { buildClaimVoucherMessage } from '../../shared/messages';
import { sign } from '@ton/crypto';
import { PrimesClaimReceipt } from './PrimesClaimReceipt';
import {
    PROGRAM_TAG_QUESTS,
    VOUCHER_BURN_MIN_GRACE,
    VOUCHER_BURN_TAG,
    VOUCHER_CLAIM_TAG,
    voucherBurnPayload,
    voucherClaimPayload,
} from '../../shared/voucher';


/**
 * The signed payloads and the domain tags live in `shared/voucher.ts`, not here.
 * Two independent pieces of software have to build the signed cell byte for byte —
 * this harness and the backend signer — and if they ever drift the failure is a
 * batch of correctly-signed, on-chain-rejected vouchers rather than a crash. One
 * definition, both importers.
 */
export {
    PROGRAM_TAG_QUESTS,
    VOUCHER_BURN_MIN_GRACE,
    VOUCHER_BURN_TAG,
    VOUCHER_CLAIM_TAG,
    voucherBurnPayload,
    voucherClaimPayload,
};
export type VoucherConfig = {
    /** 32-byte Ed25519 public key. §9.5's signing key, fixed at deploy. */
    signerPubkey: Buffer;
    /**
     * The vault track this instance pays from: `PROGRAM_TAG_QUESTS` (§9.4) or
     * `PROGRAM_TAG_SECURITY` (D-170). Defaults to quests.
     */
    programTag?: number;
    /**
     * D22: the vault's address is NOT known at this contract's deploy time — the
     * vault's allow-list names this contract and is part of the VAULT's own
     * address-determining data, so the dependency is circular with no fixed point.
     * Deploy with the genesis-script address as a placeholder and close the loop
     * with the one-shot `SetVault`.
     */
    vaultAddr: Address;
    genesisScriptAddr: Address;
    /**
     * D-191 point 2 (V26.3): `PrimesClaimReceipt`'s code. The per-claimant high-water
     * mark lives on that child; the voucher derives its address from this code.
     */
    receiptCode: Cell;
    /**
     * Audit 2026-11-19 R2-M2: the most this instance may ever pay one wallet, nano-PRIMES.
     * Deploy data with no setter; a claim whose signed total is above it is refused 716
     * before the receipt is touched. Genesis reads it from params.json (`genesisPipeline.ts`).
     */
    maxPerWallet: bigint;
};

function voucherConfigToCell(config: VoucherConfig): Cell {
    return beginCell()
        .storeUint(BigInt('0x' + config.signerPubkey.toString('hex')), 256)
        .storeUint(0, 32) // burnedAt — live
        .storeUint(0, 32) // claimDeadline — none
        .storeRef(config.receiptCode) // receiptCode — D-191 point 2
        .storeCoins(0) // paidTotal
        .storeUint(0, 32) // claimCount
        .storeAddress(config.vaultAddr) // placeholder until SetVault (D22)
        .storeUint(0, 8) // vaultSet
        .storeRef(
            // VoucherInit — write-once, in a ref (the root is at the 1023-bit limit).
            beginCell()
                .storeUint(config.programTag ?? PROGRAM_TAG_QUESTS, 32)
                .storeAddress(config.genesisScriptAddr)
                .storeCoins(config.maxPerWallet)
                .endCell()
        )
        .endCell();
}

/**
 * `globalId` and `voucher` are the network and the instance that will verify it (audit M2):
 * the hash binds both. In a sandbox, read the id off the emulator's config param 19.
 */
export function signVoucherClaim(
    secretKey: Buffer,
    globalId: number,
    voucher: Address,
    wallet: Address,
    cumulativeTotal: bigint,
    validUntil: number,
    programTag: number = PROGRAM_TAG_QUESTS
): Buffer {
    return sign(voucherClaimPayload(globalId, voucher, wallet, cumulativeTotal, validUntil, programTag).hash(), secretKey);
}

export function signVoucherBurn(
    secretKey: Buffer,
    globalId: number,
    voucher: Address,
    claimDeadline: number,
    programTag: number = PROGRAM_TAG_QUESTS
): Buffer {
    return sign(voucherBurnPayload(globalId, voucher, claimDeadline, programTag).hash(), secretKey);
}

export class PrimesVoucher implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesVoucher(address);
    }

    static createFromConfig(config: VoucherConfig, code: Cell, workchain = 0) {
        const data = voucherConfigToCell(config);
        const init = { code, data };
        return new PrimesVoucher(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /**
     * §9.5: redeem a signed voucher. MUST be sent by the wallet named in the
     * signature — `via` is the claimant, and the claimant pays the gas.
     *
     * Replaying is not an error and does not throw: the delta is zero, so the
     * message settles having paid nothing.
     */
    async sendClaim(
        provider: ContractProvider,
        via: Sender,
        opts: {
            cumulativeTotal: bigint;
            validUntil: number;
            signature: Buffer;
            value: bigint;
            queryID?: number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buildClaimVoucherMessage({
                cumulativeTotal: opts.cumulativeTotal,
                validUntil: opts.validUntil,
                signature: opts.signature,
                queryId: BigInt(opts.queryID ?? 0),
            }).body,
        });
    }

    /**
     * EARN_PLAN §3: end the program. Authenticated by the signing key itself, not
     * by an owner address — there is no owner. `claimDeadline` must be at least
     * `VOUCHER_BURN_MIN_GRACE` seconds out, so a burn cannot strand an earned
     * balance; that floor is an on-chain assert.
     */
    async sendBurnSigner(
        provider: ContractProvider,
        via: Sender,
        opts: { claimDeadline: number; signature: Buffer; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(VOUCHER.burn_signer, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeUint(opts.claimDeadline, 32)
                .storeBuffer(opts.signature, 64)
                .endCell(),
        });
    }

    /**
     * D-191 point 2: where `wallet`'s claim receipt lives. The receipt's `getPaid()` is the
     * cumulative nano-PRIMES this program has PAID `wallet`; an undeployed receipt means 0.
     */
    async getReceiptAddress(provider: ContractProvider, wallet: Address) {
        return (
            await provider.get('getReceiptAddress', [{ type: 'slice', cell: beginCell().storeAddress(wallet).endCell() }])
        ).stack.readAddress();
    }

    /**
     * Cumulative nano-PRIMES this program has PAID `wallet`, read off its claim receipt
     * (0 while the receipt is undeployed). Deliberately not a "claimable" figure: only the
     * backend knows what a wallet has earned, and §9.1 forbids a contract asserting a
     * number it cannot verify.
     */
    async getPaid(provider: ContractProvider, wallet: Address) {
        return provider
            .open(PrimesClaimReceipt.createFromAddress(await this.getReceiptAddress(provider, wallet)))
            .getPaidOrZero();
    }

    /** (paidTotal, claimCount) — reconcilable against the vault's `getVaultPayouts`. */
    async getProgramPayouts(provider: ContractProvider) {
        const r = await provider.get('getProgramPayouts', []);
        return { paidTotalPrimes: r.stack.readBigNumber(), claimCount: r.stack.readNumber() };
    }

    /** (signerPubkey, burnedAt, claimDeadline, minGrace, programTag). */
    async getSignerState(provider: ContractProvider) {
        const r = await provider.get('getSignerState', []);
        return {
            signerPubkey: r.stack.readBigNumber(),
            burnedAt: r.stack.readNumber(),
            claimDeadline: r.stack.readNumber(),
            minGrace: r.stack.readNumber(),
            programTag: r.stack.readNumber(),
        };
    }

    /** R2-M2: the per-wallet lifetime cap baked in at deploy, nano-PRIMES. */
    async getMaxPerWallet(provider: ContractProvider) {
        return (await provider.get('getMaxPerWallet', [])).stack.readBigNumber();
    }

    /** True iff a claim sent now would be refused for being out of time. */
    async getIsProgramClosed(provider: ContractProvider) {
        return (await provider.get('isProgramClosed', [])).stack.readNumber() === 1;
    }

    /**
     * D22, genesis-only one-shot: point this program at the vault whose
     * allow-list names it. Refused once `vaultSet` is 1, so it is a used-up
     * bootstrap credential rather than a standing admin key.
     */
    async sendSetVault(
        provider: ContractProvider,
        via: Sender,
        opts: { vaultAddr: Address; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(VOUCHER.set_vault, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.vaultAddr)
                .endCell(),
        });
    }

    /** (vaultAddr, vaultSet) — the wiring, and whether it is closed. */
    async getVault(provider: ContractProvider) {
        const r = await provider.get('getVault', []);
        return { vaultAddr: r.stack.readAddress(), vaultSet: r.stack.readNumber() === 1 };
    }
}
