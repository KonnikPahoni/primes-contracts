// TON PRIMES — signed-voucher claim. CONCEPT §9.5 / §9.4 / §3.3, EARN_PLAN E2/E6.
//
// The two properties EARN_PLAN §7 names explicitly are the first two tests here:
// a replayed voucher pays ZERO, and a burned signing key ends the program without
// stranding anyone's earned balance. Everything else on this page exists to show
// that the voucher is not bearer paper and that no new emission path was created.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { KeyPair, keyPairFromSeed } from '@ton/crypto';
import {
    PrimesVoucher,
    PROGRAM_TAG_QUESTS,
    VOUCHER_BURN_MIN_GRACE,
    signVoucherBurn,
    signVoucherClaim,
} from '../wrappers/PrimesVoucher';
import { PrimesBountyVault } from '../wrappers/PrimesBountyVault';
import { PROGRAM_TAG_PRIME_QUESTS, PROGRAM_TAG_SECURITY } from '../../shared/voucher';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { PrimesClaimReceipt } from '../wrappers/PrimesClaimReceipt';
import { VOUCHER } from '../../shared/opcodes';
import { sandboxGlobalId } from './helpers/globalId';
// The attribution service's own signer, not a re-derivation of it (audit M2 hash parity).
import { InMemoryVoucherSignerStore, VoucherSigner } from '../../backend/attribution/src/voucher-signer';

/** params.json genesis.bounty_vault_size_primes, in nano-PRIMES (9 decimals). */
const VAULT_PRIMES = 1_327_374_997_252_625n;
/**
 * params.json genesis.era_bounty_schedule.remaining_vault_split.tracks.quests —
 * 5% of the remaining 70%, i.e. 3.5% of the vault. This is the program's WHOLE
 * lifetime budget and it is enforced by the vault's allow-list entry, not by the
 * voucher contract: the voucher contract cannot pay itself more than genesis
 * allocated no matter what the backend signs.
 */
const QUESTS_BUDGET = (VAULT_PRIMES * 35n) / 1000n;

const E = {
    voucher_program_closed: 710,
    voucher_expired: 711,
    voucher_bad_signature: 712,
    voucher_already_burned: 713,
    voucher_grace_too_short: 714,
    voucher_total_above_cap: 716,
    vault_not_allowlisted: 700,
    vault_insufficient_balance: 701,
};

const NOW = 1_770_000_000;
const FAR_FUTURE = NOW + 86_400;

describe('TON PRIMES — §9.5 signed vouchers', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let ledgerStandIn: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;

    let walletCode: Cell;
    let masterCode: Cell;
    let vaultCode: Cell;
    let voucherCode: Cell;
    let receiptCode: Cell;

    let master: SandboxContract<PrimesJettonMaster>;
    let vault: SandboxContract<PrimesBountyVault>;
    let voucher: SandboxContract<PrimesVoucher>;

    /** The backend's §9.5 signing key. Deterministic so failures are reproducible. */
    let signer: KeyPair;
    /** A key that is NOT the signer — for the forged-voucher test. */
    let impostor: KeyPair;

    beforeAll(async () => {
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        vaultCode = await compile('PrimesBountyVault');
        voucherCode = await compile('PrimesVoucher');
        receiptCode = await compile('PrimesClaimReceipt');
        signer = keyPairFromSeed(Buffer.alloc(32, 7));
        impostor = keyPairFromSeed(Buffer.alloc(32, 9));
    });

    /**
     * Deploy the vault + voucher pair the way a real genesis would: the voucher
     * contract's address has to be known before the vault is deployed, because the
     * allow-list is part of the vault's ADDRESS-DETERMINING data and no message
     * can ever write to it (primes_bounty_vault.tolk, "ADMIN SURFACE: none").
     *
     * `allowlisted: false` skips that step, which is what v1 genesis actually does
     * and therefore what an un-allow-listed program looks like on-chain.
     */
    let deployedTag = PROGRAM_TAG_QUESTS;
    /**
     * R2-M2's per-wallet cap the instance was deployed with. Defaults to the whole track, so
     * every test that is about the VAULT's budget still reaches the vault: a cap at or above
     * the track never binds before the allow-list entry does.
     */
    let deployedCap = QUESTS_BUDGET;
    /** The emulator's network global id (M2): every signature binds it. */
    let net: number;
    async function deployPair(opts?: { allowlisted?: boolean; budget?: bigint; voucherTag?: number; entryTag?: number; funded?: bigint; maxPerWallet?: bigint }) {
        deployedTag = opts?.voucherTag ?? PROGRAM_TAG_QUESTS;
        deployedCap = opts?.maxPerWallet ?? QUESTS_BUDGET;
        blockchain = await Blockchain.create();
        net = sandboxGlobalId(blockchain);
        blockchain.now = NOW;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        ledgerStandIn = await blockchain.treasury('ledger');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        // D22 — the bootstrap, exactly as genesis will have to do it. The vault's
        // allow-list names this program and is part of the VAULT's
        // address-determining data; the program needs the vault's address to send
        // to. There is no fixed point to iterate to, so the circularity is broken
        // the way every other one in this repo is: the voucher deploys with the
        // genesis script as a placeholder (so its address is final), the vault
        // deploys with that address allow-listed, and a one-shot `SetVault`
        // closes the loop.
        const voucherContract = PrimesVoucher.createFromConfig(
            {
                signerPubkey: signer.publicKey,
                programTag: opts?.voucherTag,
                vaultAddr: genesisScript.address, // placeholder
                genesisScriptAddr: genesisScript.address,
                receiptCode,
                maxPerWallet: deployedCap,
            },
            voucherCode
        );
        const vaultContract = PrimesBountyVault.createFromConfig(
            {
                schedule: [],
                ledgerAddr: ledgerStandIn.address,
                jettonMasterAddr: master.address,
                genesisScriptAddr: genesisScript.address,
                fundedPrimes: opts?.funded ?? VAULT_PRIMES, // V26.7 — the genesis mint below
                allowlist:
                    opts?.allowlisted === false
                        ? []
                        : [
                              {
                                  addressHash: BigInt('0x' + voucherContract.address.hash.toString('hex')),
                                  programTag: opts?.entryTag ?? PROGRAM_TAG_QUESTS,
                                  remaining: opts?.budget ?? QUESTS_BUDGET,
                              },
                          ],
            },
            vaultCode
        );
        const vaultCandidate = vaultContract;
        const voucherCandidate = voucherContract;

        vault = blockchain.openContract(vaultCandidate);
        voucher = blockchain.openContract(voucherCandidate);
        await vault.sendDeploy(deployer.getSender(), toNano('2'));
        await voucher.sendDeploy(deployer.getSender(), toNano('1'));
        await voucher.sendSetVault(genesisScript.getSender(), {
            vaultAddr: vault.address,
            value: toNano('0.05'),
        });

        // Genesis pre-funds the vault with real PRIMES (D20) and wires its wallet.
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vault.address,
            amount: opts?.funded ?? VAULT_PRIMES,
            value: toNano('0.2'),
        });
        await vault.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: await master.getWalletAddress(vault.address),
            value: toNano('0.05'),
        });
    }

    async function primesBalanceOf(owner: SandboxContract<TreasuryContract>) {
        const addr = await master.getWalletAddress(owner.address);
        const w = blockchain.openContract(PrimesJettonWallet.createFromAddress(addr));
        const acct = await blockchain.getContract(addr);
        if (acct.accountState?.type !== 'active') return 0n;
        return (await w.getWalletData()).balance;
    }

    /** Redeem as `who`, with a voucher the backend signed for `who`. */
    async function redeem(
        who: SandboxContract<TreasuryContract>,
        cumulativeTotal: bigint,
        opts?: { validUntil?: number; key?: KeyPair; signFor?: SandboxContract<TreasuryContract>; tag?: number; value?: bigint }
    ) {
        const validUntil = opts?.validUntil ?? FAR_FUTURE;
        const subject = opts?.signFor ?? who;
        const key = opts?.key ?? signer;
        return await voucher.sendClaim(who.getSender(), {
            cumulativeTotal,
            validUntil,
            signature: signVoucherClaim(key.secretKey, net, voucher.address, subject.address, cumulativeTotal, validUntil, opts?.tag ?? deployedTag),
            value: opts?.value ?? toNano('0.2'),
        });
    }

    describe('the wiring', () => {
        beforeEach(() => deployPair());

        it('is allow-listed at the vault, holds the signing key it was deployed with, and starts live', async () => {
            expect(
                await vault.isAllowlisted(BigInt('0x' + voucher.address.hash.toString('hex')))
            ).toBe(1);
            const st = await voucher.getSignerState();
            expect(st.signerPubkey).toBe(BigInt('0x' + signer.publicKey.toString('hex')));
            expect(st.burnedAt).toBe(0);
            expect(st.claimDeadline).toBe(0);
            expect(st.minGrace).toBe(VOUCHER_BURN_MIN_GRACE);
            expect(st.programTag).toBe(PROGRAM_TAG_QUESTS);
            expect(await voucher.getIsProgramClosed()).toBe(false);
            const wiring = await voucher.getVault();
            expect(wiring.vaultAddr.equals(vault.address)).toBe(true);
            expect(wiring.vaultSet).toBe(true);
            // It has never paid anything, and it holds no PRIMES of its own — it
            // cannot: it has no jetton wallet and no mint authority (§3.3).
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: 0n, claimCount: 0 });
        });
    });

    describe('redeeming', () => {
        beforeEach(() => deployPair());

        it('pays the signed total in PRIMES from the vault, and the claimant pays their own gas', async () => {
            const total = 1_000_000_000n; // 1 PRIMES
            const r = await redeem(alice, total);
            expect(r.transactions).toHaveTransaction({ from: voucher.address, to: vault.address, success: true });
            expect(await primesBalanceOf(alice)).toBe(total);
            expect(await voucher.getPaid(alice.address)).toBe(total);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: total, claimCount: 1 });
            // The vault's own counter agrees — the two are reconcilable, which is
            // the point of both existing (§9.1).
            expect((await vault.getVaultPayouts()).paidTotalPrimes).toBe(total);
        });

        it('§9.5 the claimant pays: under 0.15 TON throws 103 and moves nothing; a funded claim costs the voucher nothing', async () => {
            const short = await redeem(alice, 1_000_000_000n, { value: toNano('0.1') });
            expect(short.transactions).toHaveTransaction({ to: voucher.address, success: false, exitCode: 103 });
            expect(await voucher.getPaid(alice.address)).toBe(0n);
            const before = (await blockchain.getContract(voucher.address)).balance;
            const r = await redeem(alice, 1_000_000_000n, { value: toNano('0.15') });
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            expect(await primesBalanceOf(alice)).toBe(1_000_000_000n);
            expect((await blockchain.getContract(voucher.address)).balance).toBeGreaterThanOrEqual(before);
        });

        it('REPLAY PAYS ZERO — and settles quietly rather than bouncing', async () => {
            const total = 1_000_000_000n;
            const validUntil = FAR_FUTURE;
            const signature = signVoucherClaim(signer.secretKey, net, voucher.address, alice.address, total, validUntil);

            await voucher.sendClaim(alice.getSender(), { cumulativeTotal: total, validUntil, signature, value: toNano('0.2') });
            expect(await primesBalanceOf(alice)).toBe(total);

            // The very same voucher, byte for byte, a second time.
            const replay = await voucher.sendClaim(alice.getSender(), {
                cumulativeTotal: total,
                validUntil,
                signature,
                value: toNano('0.2'),
            });
            // Not an error: a replay is a no-op. Nothing bounced, and no second
            // request reached the vault.
            expect(replay.transactions).toHaveTransaction({ to: voucher.address, success: true });
            expect(replay.transactions).not.toHaveTransaction({ from: voucher.address, to: vault.address });
            expect(await primesBalanceOf(alice)).toBe(total);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: total, claimCount: 1 });
        });

        it('pays only the DELTA as the cumulative total grows, so the backend need not track redemptions', async () => {
            await redeem(alice, 1_000_000_000n);
            await redeem(alice, 3_000_000_000n);
            expect(await primesBalanceOf(alice)).toBe(3_000_000_000n);
            expect(await voucher.getPaid(alice.address)).toBe(3_000_000_000n);
            // Three payouts' worth of counter, two payouts' worth of tokens? No —
            // the counter counts CLAIMS that moved money, and the total is the
            // high-water mark, not a sum of deltas that could drift from it.
            expect(await voucher.getProgramPayouts()).toEqual({
                paidTotalPrimes: 3_000_000_000n,
                claimCount: 2,
            });
        });

        it('an OUT-OF-ORDER voucher settles to the higher total and the lower one is a no-op', async () => {
            const high = 5_000_000_000n;
            const low = 2_000_000_000n;
            await redeem(alice, high);
            expect(await primesBalanceOf(alice)).toBe(high);
            const stale = await redeem(alice, low);
            expect(stale.transactions).not.toHaveTransaction({ from: voucher.address, to: vault.address });
            expect(await primesBalanceOf(alice)).toBe(high);
            expect(await voucher.getPaid(alice.address)).toBe(high);
        });

        it('a voucher is NOT bearer paper: bob cannot redeem a voucher signed for alice', async () => {
            const r = await redeem(bob, 1_000_000_000n, { signFor: alice });
            expect(r.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_bad_signature,
            });
            expect(await primesBalanceOf(bob)).toBe(0n);
            expect(await voucher.getPaid(alice.address)).toBe(0n);
        });

        it('a voucher signed by the wrong key is refused', async () => {
            const r = await redeem(alice, 1_000_000_000n, { key: impostor });
            expect(r.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_bad_signature,
            });
            expect(await primesBalanceOf(alice)).toBe(0n);
        });

        it('an expired voucher is refused', async () => {
            const r = await redeem(alice, 1_000_000_000n, { validUntil: NOW - 1 });
            expect(r.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_expired,
            });
        });

        it('two wallets are independent high-water marks', async () => {
            await redeem(alice, 1_000_000_000n);
            await redeem(bob, 4_000_000_000n);
            expect(await primesBalanceOf(alice)).toBe(1_000_000_000n);
            expect(await primesBalanceOf(bob)).toBe(4_000_000_000n);
        });
    });

    describe('the budget is the vault\'s, not the voucher contract\'s', () => {
        it('a program that is NOT allow-listed cannot pay, however valid the signature', async () => {
            await deployPair({ allowlisted: false });
            const r = await redeem(alice, 1_000_000_000n);
            // The signature check passes; the VAULT is what refuses.
            expect(r.transactions).toHaveTransaction({
                to: vault.address,
                success: false,
                exitCode: E.vault_not_allowlisted,
            });
            expect(await primesBalanceOf(alice)).toBe(0n);
            // ...and the refusal bounced back, so alice's high-water mark was
            // rolled back rather than left charged for a payment she never got.
            expect(await voucher.getPaid(alice.address)).toBe(0n);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: 0n, claimCount: 0 });
        });

        // D-170 — the tag is init data, so one code serves two tracks. A SECU instance pays from
        // the SECU entry; an instance whose tag does not match its entry is refused by the vault.
        it('D-170: the track tag belongs to the instance, and the vault holds it to the entry', async () => {
            await deployPair({ voucherTag: PROGRAM_TAG_SECURITY, entryTag: PROGRAM_TAG_SECURITY });
            expect((await voucher.getSignerState()).programTag).toBe(PROGRAM_TAG_SECURITY);
            const ok = await redeem(alice, 1_000_000_000n);
            expect(ok.transactions).not.toHaveTransaction({ aborted: true });
            expect(await primesBalanceOf(alice)).toBe(1_000_000_000n);

            await deployPair({ voucherTag: PROGRAM_TAG_QUESTS, entryTag: PROGRAM_TAG_SECURITY });
            const r = await redeem(alice, 1_000_000_000n);
            expect(r.transactions).toHaveTransaction({
                to: vault.address,
                success: false,
                exitCode: E.vault_not_allowlisted,
            });
            expect(await primesBalanceOf(alice)).toBe(0n);
            expect(await voucher.getPaid(alice.address)).toBe(0n);
        });

        // G78 / D-171 — the tag is in the signed hash, so even on ONE key (QSTS and PQST shared
        // one until R2-M2 split them) a voucher signed for one instance is a bad signature on the
        // other, and so is a burn. Kept: the split is a deploy-time choice, the tag is the contract's.
        it('G78: a voucher or burn signed for another instance on the same key is refused', async () => {
            await deployPair({ voucherTag: PROGRAM_TAG_PRIME_QUESTS, entryTag: PROGRAM_TAG_PRIME_QUESTS });
            const r = await redeem(alice, 1_000_000_000n, { tag: PROGRAM_TAG_QUESTS });
            expect(r.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_bad_signature,
            });
            expect(await primesBalanceOf(alice)).toBe(0n);
            const deadline = NOW + VOUCHER_BURN_MIN_GRACE + 10;
            const b = await voucher.sendBurnSigner(deployer.getSender(), {
                claimDeadline: deadline,
                signature: signVoucherBurn(signer.secretKey, net, voucher.address, deadline, PROGRAM_TAG_QUESTS),
                value: toNano('0.1'),
            });
            expect(b.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_bad_signature,
            });
            expect((await voucher.getSignerState()).burnedAt).toBe(0);
            // The right tag pays.
            await redeem(alice, 1_000_000_000n);
            expect(await primesBalanceOf(alice)).toBe(1_000_000_000n);
        });

        // Audit 2026-11-19 M2 — the tag tells instances apart, but not two DEPLOYMENTS of one
        // instance (testnet then mainnet, or a redeploy) on a reused key. The address does.
        // `twin` has the same key, tag and genesis script and differs only in its init's
        // placeholder vault, so its address is the one thing that tells it from `voucher`.
        async function twin() {
            const b = blockchain.openContract(
                PrimesVoucher.createFromConfig(
                    {
                        signerPubkey: signer.publicKey,
                        programTag: deployedTag,
                        vaultAddr: bob.address,
                        genesisScriptAddr: genesisScript.address,
                        receiptCode,
                        maxPerWallet: deployedCap,
                    },
                    voucherCode
                )
            );
            expect(b.address.equals(voucher.address)).toBe(false);
            await b.sendDeploy(deployer.getSender(), toNano('1'));
            await b.sendSetVault(genesisScript.getSender(), { vaultAddr: vault.address, value: toNano('0.05') });
            expect((await b.getVault()).vaultSet).toBe(true);
            return b;
        }

        it('M2: a voucher signed for one voucher contract is a bad signature on another with the same key and tag', async () => {
            await deployPair();
            const b = await twin();
            const total = 1_000_000_000n;
            const signature = signVoucherClaim(signer.secretKey, net, voucher.address, alice.address, total, FAR_FUTURE);
            const r = await b.sendClaim(alice.getSender(), { cumulativeTotal: total, validUntil: FAR_FUTURE, signature, value: toNano('0.2') });
            expect(r.transactions).toHaveTransaction({ to: b.address, success: false, exitCode: E.voucher_bad_signature });
            expect(await b.getPaid(alice.address)).toBe(0n);
            // The same signature pays on the contract it was signed for.
            const ok = await voucher.sendClaim(alice.getSender(), { cumulativeTotal: total, validUntil: FAR_FUTURE, signature, value: toNano('0.2') });
            expect(ok.transactions).not.toHaveTransaction({ aborted: true });
            expect(await primesBalanceOf(alice)).toBe(total);
        });

        it('M2: a burn signed for one voucher contract cannot end another with the same key and tag', async () => {
            await deployPair();
            const b = await twin();
            const deadline = NOW + VOUCHER_BURN_MIN_GRACE + 10;
            const signature = signVoucherBurn(signer.secretKey, net, voucher.address, deadline);
            const r = await b.sendBurnSigner(deployer.getSender(), { claimDeadline: deadline, signature, value: toNano('0.1') });
            expect(r.transactions).toHaveTransaction({ to: b.address, success: false, exitCode: E.voucher_bad_signature });
            expect((await b.getSignerState()).burnedAt).toBe(0);
            const ok = await voucher.sendBurnSigner(deployer.getSender(), { claimDeadline: deadline, signature, value: toNano('0.1') });
            expect(ok.transactions).toHaveTransaction({ to: voucher.address, success: true });
            expect((await voucher.getSignerState()).burnedAt).toBe(NOW);
        });

        // Audit M2, the network half: the instance address is the SAME on testnet and mainnet
        // (a v4r2 genesis wallet, one mnemonic), so the address cannot tell them apart. The
        // contract hashes its own config param 19; a signature made for the other network is refused.
        it('M2: a voucher or burn signed for the other network is a bad signature on this one', async () => {
            await deployPair();
            const other = net === -239 ? -3 : -239;
            const total = 1_000_000_000n;
            const r = await voucher.sendClaim(alice.getSender(), {
                cumulativeTotal: total,
                validUntil: FAR_FUTURE,
                signature: signVoucherClaim(signer.secretKey, other, voucher.address, alice.address, total, FAR_FUTURE),
                value: toNano('0.2'),
            });
            expect(r.transactions).toHaveTransaction({ to: voucher.address, success: false, exitCode: E.voucher_bad_signature });
            expect(await voucher.getPaid(alice.address)).toBe(0n);
            expect(await primesBalanceOf(alice)).toBe(0n);

            const deadline = NOW + VOUCHER_BURN_MIN_GRACE + 10;
            const b = await voucher.sendBurnSigner(deployer.getSender(), {
                claimDeadline: deadline,
                signature: signVoucherBurn(signer.secretKey, other, voucher.address, deadline),
                value: toNano('0.1'),
            });
            expect(b.transactions).toHaveTransaction({ to: voucher.address, success: false, exitCode: E.voucher_bad_signature });
            expect((await voucher.getSignerState()).burnedAt).toBe(0);

            // Signed for this network, both go through.
            await redeem(alice, total);
            expect(await primesBalanceOf(alice)).toBe(total);
            const ok = await voucher.sendBurnSigner(deployer.getSender(), {
                claimDeadline: deadline,
                signature: signVoucherBurn(signer.secretKey, net, voucher.address, deadline),
                value: toNano('0.1'),
            });
            expect(ok.transactions).toHaveTransaction({ to: voucher.address, success: true });
            expect((await voucher.getSignerState()).burnedAt).toBe(NOW);
        });

        // HASH PARITY, end to end: the attribution service's REAL signer issues the voucher and
        // the contract redeems it. A drift between `voucher-signer.ts` and `hashSignedClaim`
        // would refuse every live quest claim with 712; this is the test that sees it first.
        it('M2: a voucher from the backend signer (backend/attribution) redeems on its own instance only', async () => {
            await deployPair({ voucherTag: PROGRAM_TAG_PRIME_QUESTS, entryTag: PROGRAM_TAG_PRIME_QUESTS });
            const b = await twin();
            const backend = new VoucherSigner(signer.secretKey, new InMemoryVoucherSignerStore(), net, {
                quests: b.address.toString(),
                prime_quests: voucher.address.toString(),
            });
            const v = await backend.issue({
                wallet: alice.address.toString(),
                earnedPrimes: 3,
                program: 'prime_quests',
                mintGate: { attributedMintExists: true, evidence: 'test' },
                now: new Date(NOW * 1000),
            });
            const claim = { cumulativeTotal: BigInt(v.cumulativeTotal), validUntil: v.validUntil, signature: Buffer.from(v.signature, 'hex'), value: toNano('0.2') };
            // Not on the twin, whose address the signer has under the other program.
            const wrong = await b.sendClaim(alice.getSender(), claim);
            expect(wrong.transactions).toHaveTransaction({ to: b.address, success: false, exitCode: E.voucher_bad_signature });
            const r = await voucher.sendClaim(alice.getSender(), claim);
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            expect(await primesBalanceOf(alice)).toBe(3_000_000_000n);
        });

        it('a signed total above the genesis-fixed budget is refused BY THE VAULT, and rolls back', async () => {
            // The per-wallet cap (R2-M2) stays at the whole track here, above this entry's
            // `remaining`, so the refusal below is the vault's and not the voucher's 716.
            await deployPair({ budget: 1_000_000_000n });
            expect(await voucher.getMaxPerWallet()).toBeGreaterThan(1_000_000_000n);
            const r = await redeem(alice, 2_000_000_000n);
            expect(r.transactions).toHaveTransaction({
                to: vault.address,
                success: false,
                exitCode: E.vault_insufficient_balance,
            });
            expect(await primesBalanceOf(alice)).toBe(0n);
            expect(await voucher.getPaid(alice.address)).toBe(0n);

            // The budget still pays what it can — the refusal was of the excess,
            // not of the program.
            await redeem(alice, 1_000_000_000n);
            expect(await primesBalanceOf(alice)).toBe(1_000_000_000n);
        });
    });

    // Audit 2026-11-19 R2-M2. The track's `remaining` bounds the PROGRAM; nothing bounded one
    // WALLET, so a stolen key could sign "this wallet earned the whole track" and drain it in
    // one claim. `maxPerWallet` is deploy data, and the receipt stores the signed total, so a
    // wallet's lifetime payout is bounded by it however many vouchers it redeems.
    describe('R2-M2: the per-wallet cap', () => {
        const CAP = 5_000_000_000n; // 5 PRIMES
        beforeEach(() => deployPair({ maxPerWallet: CAP }));

        it('is deploy data, readable by its own get-method, and leaves getSignerState as it was', async () => {
            expect(await voucher.getMaxPerWallet()).toBe(CAP);
            expect((await voucher.getSignerState()).programTag).toBe(PROGRAM_TAG_QUESTS);
        });

        it('a claim at exactly the cap pays it', async () => {
            const r = await redeem(alice, CAP);
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            expect(r.transactions).toHaveTransaction({ from: voucher.address, to: vault.address, success: true });
            expect(await primesBalanceOf(alice)).toBe(CAP);
            expect(await voucher.getPaid(alice.address)).toBe(CAP);
        });

        it('cap + 1 is refused 716 before the receipt is messaged: no mark, no PRIMES', async () => {
            const r = await redeem(alice, CAP + 1n);
            expect(r.transactions).toHaveTransaction({ to: voucher.address, success: false, exitCode: E.voucher_total_above_cap });
            expect(r.transactions).not.toHaveTransaction({ from: voucher.address, op: VOUCHER.receipt_advance });
            expect(r.transactions).not.toHaveTransaction({ to: vault.address });
            const receipt = await blockchain.getContract(await voucher.getReceiptAddress(alice.address));
            expect(receipt.accountState?.type).not.toBe('active');
            expect(await voucher.getPaid(alice.address)).toBe(0n);
            expect(await primesBalanceOf(alice)).toBe(0n);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: 0n, claimCount: 0 });
        });

        it('two vouchers in sequence cannot take one wallet past the cap', async () => {
            await redeem(alice, 3_000_000_000n);
            const over = await redeem(alice, CAP + 1_000_000_000n);
            expect(over.transactions).toHaveTransaction({ to: voucher.address, success: false, exitCode: E.voucher_total_above_cap });
            expect(await voucher.getPaid(alice.address)).toBe(3_000_000_000n);
            expect(await primesBalanceOf(alice)).toBe(3_000_000_000n);
            const rest = await redeem(alice, CAP);
            expect(rest.transactions).not.toHaveTransaction({ aborted: true });
            expect(await primesBalanceOf(alice)).toBe(CAP);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: CAP, claimCount: 2 });
        });

        it('a replay after reaching the cap pays zero', async () => {
            await redeem(alice, CAP);
            const replay = await redeem(alice, CAP);
            expect(replay.transactions).not.toHaveTransaction({ aborted: true });
            expect(replay.transactions).not.toHaveTransaction({ from: voucher.address, to: vault.address });
            expect(await primesBalanceOf(alice)).toBe(CAP);
            expect(await voucher.getPaid(alice.address)).toBe(CAP);
        });
    });

    describe('burning the signing key (EARN_PLAN §3)', () => {
        beforeEach(() => deployPair());

        it('ends the program, and CANNOT strand an earned balance: the grace floor is an on-chain assert', async () => {
            // Too little notice is refused. This is the whole of "without
            // stranding anyone's earned balance" — a promise turned into an
            // arithmetic condition.
            const tooSoon = NOW + 60;
            const bad = await voucher.sendBurnSigner(deployer.getSender(), {
                claimDeadline: tooSoon,
                signature: signVoucherBurn(signer.secretKey, net, voucher.address, tooSoon),
                value: toNano('0.1'),
            });
            expect(bad.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_grace_too_short,
            });
            expect((await voucher.getSignerState()).burnedAt).toBe(0);

            const deadline = NOW + VOUCHER_BURN_MIN_GRACE + 1;
            const ok = await voucher.sendBurnSigner(deployer.getSender(), {
                claimDeadline: deadline,
                signature: signVoucherBurn(signer.secretKey, net, voucher.address, deadline),
                value: toNano('0.1'),
            });
            expect(ok.transactions).toHaveTransaction({ to: voucher.address, success: true });
            const st = await voucher.getSignerState();
            expect(st.burnedAt).toBe(NOW);
            expect(st.claimDeadline).toBe(deadline);
            // Still open — that is the point of the grace.
            expect(await voucher.getIsProgramClosed()).toBe(false);
        });

        it('is authenticated by the KEY, not by an owner: nobody without the key can end the program', async () => {
            const deadline = NOW + VOUCHER_BURN_MIN_GRACE + 1;
            const forged = await voucher.sendBurnSigner(bob.getSender(), {
                claimDeadline: deadline,
                signature: signVoucherBurn(impostor.secretKey, net, voucher.address, deadline),
                value: toNano('0.1'),
            });
            expect(forged.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_bad_signature,
            });
            expect((await voucher.getSignerState()).burnedAt).toBe(0);

            // ...and holding the key is enough, from ANY wallet: the burn is
            // permissionless to send. `bob` relays a correctly signed burn.
            const relayed = await voucher.sendBurnSigner(bob.getSender(), {
                claimDeadline: deadline,
                signature: signVoucherBurn(signer.secretKey, net, voucher.address, deadline),
                value: toNano('0.1'),
            });
            expect(relayed.transactions).toHaveTransaction({ to: voucher.address, success: true });
            expect((await voucher.getSignerState()).burnedAt).toBe(NOW);
        });

        it('is one-shot: the deadline cannot be walked forward to fake a live program', async () => {
            const d1 = NOW + VOUCHER_BURN_MIN_GRACE + 1;
            await voucher.sendBurnSigner(deployer.getSender(), {
                claimDeadline: d1,
                signature: signVoucherBurn(signer.secretKey, net, voucher.address, d1),
                value: toNano('0.1'),
            });
            const d2 = NOW + VOUCHER_BURN_MIN_GRACE + 100_000;
            const again = await voucher.sendBurnSigner(deployer.getSender(), {
                claimDeadline: d2,
                signature: signVoucherBurn(signer.secretKey, net, voucher.address, d2),
                value: toNano('0.1'),
            });
            expect(again.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_already_burned,
            });
            expect((await voucher.getSignerState()).claimDeadline).toBe(d1);
        });

        it('a voucher signed BEFORE the burn still redeems during the grace, and stops after the deadline', async () => {
            const total = 1_000_000_000n;
            const validUntil = NOW + VOUCHER_BURN_MIN_GRACE + 10_000;
            const signature = signVoucherClaim(signer.secretKey, net, voucher.address, alice.address, total, validUntil);

            const deadline = NOW + VOUCHER_BURN_MIN_GRACE + 1;
            await voucher.sendBurnSigner(deployer.getSender(), {
                claimDeadline: deadline,
                signature: signVoucherBurn(signer.secretKey, net, voucher.address, deadline),
                value: toNano('0.1'),
            });

            // Inside the grace: redeems normally. Refusing here would be exactly
            // the stranding the grace exists to prevent.
            blockchain.now = deadline - 100;
            await voucher.sendClaim(alice.getSender(), { cumulativeTotal: total, validUntil, signature, value: toNano('0.2') });
            expect(await primesBalanceOf(alice)).toBe(total);

            // Past the deadline: closed, and the get-method says so before the
            // user spends gas finding out.
            blockchain.now = deadline + 1;
            expect(await voucher.getIsProgramClosed()).toBe(true);
            const late = await voucher.sendClaim(bob.getSender(), {
                cumulativeTotal: total,
                validUntil,
                signature: signVoucherClaim(signer.secretKey, net, voucher.address, bob.address, total, validUntil),
                value: toNano('0.2'),
            });
            expect(late.transactions).toHaveTransaction({
                to: voucher.address,
                success: false,
                exitCode: E.voucher_program_closed,
            });
            expect(await primesBalanceOf(bob)).toBe(0n);
        });

        it('§8: there is no admin path that moves the unspent budget anywhere', async () => {
            // The vault's remaining PRIMES after a burn stay in the vault, which
            // has no withdraw path either — and because §3.3 pre-counted the whole
            // vault into `S`, an unspent bucket is a floor-price gift to holders
            // rather than money anyone lost. Assert the negative structurally: the
            // only two opcodes this contract accepts are claim and burn.
            const junk = await deployer.send({
                to: voucher.address,
                value: toNano('0.1'),
                body: (await import('@ton/core')).beginCell().storeUint(0xdeadbeef, 32).endCell(),
            });
            void junk;
            const acct = await blockchain.getContract(voucher.address);
            expect(acct.accountState?.type).toBe('active');
            // ...and nothing left the vault.
            expect((await vault.getVaultPayouts()).paidTotalPrimes).toBe(0n);
        });
    });
    // D-191 point 2 (GAUNTLET.md V26.3): the high-water mark moved off the voucher onto a
    // per-claimant receipt, so the voucher's storage no longer grows with its claimants.
    describe('D-191 point 2: the per-claimant claim receipt', () => {
        beforeEach(() => deployPair());

        function receiptOf(who: SandboxContract<TreasuryContract>) {
            return blockchain.openContract(
                PrimesClaimReceipt.createFromConfig({ voucherAddr: voucher.address, claimant: who.address }, receiptCode)
            );
        }

        async function voucherDataCells(): Promise<number> {
            const state = (await blockchain.getContract(voucher.address)).account.account!.storage.state;
            if (state.type !== 'active') throw new Error('not active');
            const seen = new Set<string>();
            const walk = (c: Cell) => {
                const h = c.hash().toString('hex');
                if (seen.has(h)) return;
                seen.add(h);
                c.refs.forEach(walk);
            };
            walk(state.state.data!);
            return seen.size;
        }

        it('a claim deploys the receipt at the address both sides derive, with no aborted hop', async () => {
            const receipt = receiptOf(alice);
            expect((await voucher.getReceiptAddress(alice.address)).equals(receipt.address)).toBe(true);
            expect((await blockchain.getContract(receipt.address)).accountState?.type).not.toBe('active');

            const r = await redeem(alice, 1_000_000_000n, { value: toNano('0.15') });
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            expect(r.transactions).toHaveTransaction({ from: voucher.address, to: receipt.address, deploy: true, success: true });
            expect(r.transactions).toHaveTransaction({ from: receipt.address, to: voucher.address, success: true });
            expect(r.transactions).toHaveTransaction({ from: voucher.address, to: vault.address, success: true });
            expect(await receipt.getPaid()).toBe(1_000_000_000n);
            const owner = await receipt.getReceiptOwner();
            expect(owner.voucherAddr.equals(voucher.address) && owner.claimant.equals(alice.address)).toBe(true);
            expect(await primesBalanceOf(alice)).toBe(1_000_000_000n);
            // §9.5 "the claimant pays": the 0.15 must still carry every hop — the voucher twice,
            // the receipt's deploy and its storage reserve — and arrive at the vault with enough
            // for the vault's own 0.1 TRANSFER_GAS jetton hop plus its compute, as before V26.3.
            const measure = (txs: typeof r.transactions) => {
                const toVault = txs.find((t) => t.inMessage?.info.dest?.toString() === vault.address.toString())!;
                const arrived = toVault.inMessage!.info.type === 'internal' ? toVault.inMessage!.info.value.coins : 0n;
                return { arrived, vaultFees: toVault.totalFees.coins };
            };
            const first = measure(r.transactions);
            const r2 = await redeem(alice, 2_000_000_000n, { value: toNano('0.15') });
            expect(r2.transactions).not.toHaveTransaction({ aborted: true });
            const repeat = measure(r2.transactions);
            console.log(
                `V26.3 claim at 0.15 TON: reaches the vault with ${Number(first.arrived) / 1e9} TON on the first ` +
                    `(receipt deploy) and ${Number(repeat.arrived) / 1e9} on a repeat; vault compute ${Number(first.vaultFees) / 1e9}`
            );
            expect(first.arrived).toBeGreaterThanOrEqual(toNano('0.1') + first.vaultFees);
            expect(repeat.arrived).toBeGreaterThanOrEqual(first.arrived);
        });

        it('a replay or a stale voucher pays nothing, and the receipt refunds the claimant', async () => {
            await redeem(alice, 5_000_000_000n);
            const receipt = receiptOf(alice);
            for (const total of [5_000_000_000n, 2_000_000_000n]) {
                const r = await redeem(alice, total);
                expect(r.transactions).not.toHaveTransaction({ aborted: true });
                expect(r.transactions).not.toHaveTransaction({ from: receipt.address, to: voucher.address });
                expect(r.transactions).not.toHaveTransaction({ from: voucher.address, to: vault.address });
                expect(r.transactions).toHaveTransaction({ from: receipt.address, to: alice.address, success: true });
            }
            expect(await receipt.getPaid()).toBe(5_000_000_000n);
            expect(await primesBalanceOf(alice)).toBe(5_000_000_000n);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: 5_000_000_000n, claimCount: 1 });
        });

        it('two wallets get two receipts', async () => {
            await redeem(alice, 1_000_000_000n);
            await redeem(bob, 4_000_000_000n);
            const a = receiptOf(alice);
            const b = receiptOf(bob);
            expect(a.address.equals(b.address)).toBe(false);
            expect(await a.getPaid()).toBe(1_000_000_000n);
            expect(await b.getPaid()).toBe(4_000_000_000n);
        });

        it('a vault refusal rolls the receipt back, and a re-claim then pays once', async () => {
            await deployPair({ budget: 1_000_000_000n });
            const receipt = receiptOf(alice);
            const refused = await redeem(alice, 2_000_000_000n);
            expect(refused.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: E.vault_insufficient_balance });
            expect(refused.transactions).toHaveTransaction({
                from: voucher.address,
                to: receipt.address,
                success: true,
                op: VOUCHER.receipt_restore,
            });
            expect(await receipt.getPaid()).toBe(0n);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: 0n, claimCount: 0 });

            await redeem(alice, 1_000_000_000n);
            await redeem(alice, 1_000_000_000n);
            expect(await primesBalanceOf(alice)).toBe(1_000_000_000n);
            expect(await receipt.getPaid()).toBe(1_000_000_000n);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: 1_000_000_000n, claimCount: 1 });
        });

        // The vault's track can outlast its wallet: era bounties and special rebates
        // draw on the same PRIMES without touching the allow-list entry. The vault
        // used to accept such a claim and send it, the wallet bounced it back to the
        // vault alone, and the receipt kept a mark for PRIMES that never moved — a
        // claim lost for good. `canCover` now refuses it at the vault, so the
        // voucher's bounce arm rolls the receipt back.
        it('an EXHAUSTED vault refuses before sending, so the receipt rolls back rather than eating the claim', async () => {
            await deployPair({ funded: 1_000_000_000n });
            const receipt = receiptOf(alice);
            const refused = await redeem(alice, 2_000_000_000n);
            expect(refused.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: E.vault_insufficient_balance });
            expect(refused.transactions).not.toHaveTransaction({ from: vault.address, to: (await vault.getVaultConfig()).jettonWalletAddr });
            expect(refused.transactions).not.toHaveTransaction({ aborted: true, to: receipt.address });
            expect(await receipt.getPaid()).toBe(0n);
            expect(await vault.getVaultPayouts()).toMatchObject({ paidTotalPrimes: 0n, payoutCount: 0 });

            await redeem(alice, 1_000_000_000n);
            expect(await primesBalanceOf(alice)).toBe(1_000_000_000n);
            expect(await receipt.getPaid()).toBe(1_000_000_000n);
        });

        it('a forged advance, restore or delta from anyone but the other side is refused (100)', async () => {
            await redeem(alice, 3_000_000_000n);
            const receipt = receiptOf(alice);
            const advance = beginCell().storeUint(VOUCHER.receipt_advance, 32).storeUint(0, 64).storeCoins(9_000_000_000n).endCell();
            const restore = beginCell().storeUint(VOUCHER.receipt_restore, 32).storeUint(0, 64).storeCoins(3_000_000_000n).endCell();
            for (const body of [advance, restore]) {
                const r = await alice.send({ to: receipt.address, value: toNano('0.2'), body });
                expect(r.transactions).toHaveTransaction({ to: receipt.address, success: false, exitCode: 100 });
            }
            expect(await receipt.getPaid()).toBe(3_000_000_000n);

            const delta = beginCell()
                .storeUint(VOUCHER.receipt_delta, 32)
                .storeUint(0, 64)
                .storeAddress(bob.address)
                .storeCoins(9_000_000_000n)
                .endCell();
            const d = await bob.send({ to: voucher.address, value: toNano('0.2'), body: delta });
            expect(d.transactions).toHaveTransaction({ to: voucher.address, success: false, exitCode: 100 });
            expect(d.transactions).not.toHaveTransaction({ from: voucher.address, to: vault.address });
            expect(await primesBalanceOf(bob)).toBe(0n);
        });

        it('BOUND: the voucher holds no per-claimant state, so its storage does not grow with N claimants', async () => {
            await redeem(alice, 1_000_000_000n);
            const cells1 = await voucherDataCells();
            const wallets = await Promise.all(Array.from({ length: 8 }, (_, i) => blockchain.treasury(`claimant${i}`)));
            for (const w of wallets) await redeem(w, 1_000_000_000n);
            expect(await voucherDataCells()).toBe(cells1);
            expect(await voucher.getProgramPayouts()).toEqual({ paidTotalPrimes: 9_000_000_000n, claimCount: 9 });
        });
    });
});
