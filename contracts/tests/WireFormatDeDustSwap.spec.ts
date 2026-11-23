// TON PRIMES — GAUNTLET.md V2: the DeDust native-vault swap payload, parsed
// field-by-field against DeDust v2's OWN published schema
// (docs.dedust.io/reference/tlb-schemes, fetched 2026-09-09 — see the schema
// verbatim in `shared/schemas/ratchet.tlb` and in `primes_ratchet.tolk`'s
// `handleFlush` comment) rather than merely asserted against a treasury stand-in
// that would accept any payload at all.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. This captures the REAL outbound cell a
// real `flush()` call sends and decodes it exactly the way DeDust's vault would,
// per their own documented TL-B — so a regression that drops a field, gets a bit
// width wrong, or reorders something is caught here even though every other
// flush-path spec (DecompositionSolvency.spec.ts and friends) stands a plain
// treasury in for the vault and would not notice. It does NOT prove a real
// DeDust pool accepts the message — that needs either a live testnet pool or a
// schema-faithful mock vault contract, neither of which exists in this repo
// (testnet's configured vault is a throwaway stand-in with no real liquidity,
// per docs/audit/known-limitations.md). Filed as V2.1 if that stronger proof is
// ever wanted.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, Slice, beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesRatchet, FLUSH_VALUE } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { ERRORS } from '../../shared/opcodes';

const DEDUST_SWAP_OP = 0xea06185d;
/** `DEDUST_SWAP_GAS` in primes_ratchet.tolk — what the native vault charges. */
const DEDUST_SWAP_GAS = toNano('0.25');
const MINT_PRICE = toNano('1');
const OPENING_HEAD = 4n;

describe('GAUNTLET.md V2 — the DeDust swap body matches DeDust v2\'s own published schema', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let timelockWallet: SandboxContract<TreasuryContract>;
    let vaultStub: SandboxContract<TreasuryContract>;
    let poolStub: SandboxContract<TreasuryContract>;
    let jettonVaultStub: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;
    let ratchetCode: Cell;
    let registrarCode: Cell;

    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
        collectionCode = await compile('PrimesCollection');
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        ledgerCode = await compile('PrimesLedger');
        ratchetCode = await compile('PrimesRatchet');
        registrarCode = await compile('PrimesRegistrar');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        timelockWallet = await blockchain.treasury('timelock');
        // Three DISTINCT addresses, deliberately — the vault, the pool and the
        // jetton vault must never be interchangeable in the assertions below,
        // or a bug that sends the wrong one of the three would go unnoticed.
        vaultStub = await blockchain.treasury('dedustVault');
        poolStub = await blockchain.treasury('dedustPool');
        jettonVaultStub = await blockchain.treasury('primesJettonVault');
        minter = await blockchain.treasury('minter', { balance: toNano('10000') });

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                { nextIndex: 2n, itemCode, ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
                collectionCode
            )
        );
        await collection.sendDeploy(deployer.getSender(), toNano('5'));

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: master.address,
                        treasuryAddr: treasuryWallet.address,
                        itemCode,
                    },
                    b: { genesisScriptAddr: genesisScript.address },
                },
                ledgerCode
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));

        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, registrarCode)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: timelockWallet.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: vaultStub.address,
                    dedustPool: poolStub.address,
                    primesJettonVault: jettonVaultStub.address,
                },
                ratchetCode
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: deployer.address,
            bountyVaultAddr: treasuryWallet.address,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    it('parses field-by-field against swap#ea06185d query_id:uint64 amount:Coins _:SwapStep swap_params:^SwapParams', async () => {
        // Feed `pending` so flush has something to move: 4 = 2^2, the opening
        // composite.
        await ledger.sendMint(minter.getSender(), {
            n: OPENING_HEAD,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        const pending = await ratchet.getPending();
        expect(pending).toBeGreaterThan(0n);

        const flushAt = blockchain.now!;
        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        const minOut = await ratchet.getLastMinOut();

        const swapMsg = r.transactions
            .flatMap((t) => t.outMessages?.values?.() ?? [])
            .find(
                (m) =>
                    m.info?.dest &&
                    Address.isAddress(m.info.dest) &&
                    (m.info.dest as Address).equals(vaultStub.address)
            );
        expect(swapMsg).toBeDefined();

        const s: Slice = swapMsg!.body.beginParse();
        expect(s.loadUint(32)).toBe(DEDUST_SWAP_OP); // swap#ea06185d
        expect(s.loadUint(64)).toBe(0); // query_id (Flush's default queryID)
        expect(s.loadCoins()).toBe(pending); // amount — the GRAM side of the swap

        // SwapStep, inline (NOT a ref — DeDust's `_:SwapStep`)
        expect(s.loadAddress().equals(poolStub.address)).toBe(true); // pool_addr
        expect(s.loadUint(1)).toBe(0); // SwapKind = given_in$0
        expect(s.loadCoins()).toBe(minOut); // limit — the floor guard
        expect(s.loadUint(1)).toBe(0); // next = none$0 (single-hop)

        expect(s.remainingBits).toBe(0);
        expect(s.remainingRefs).toBe(1); // swap_params:^SwapParams, and nothing else

        const params = s.loadRef().beginParse();
        expect(params.loadUint(32)).toBe(flushAt + 600); // deadline = now + DEDUST_SWAP_DEADLINE_WINDOW
        expect(params.loadAddress().equals(ratchet.address)).toBe(true); // recipient_addr — proceeds land back here
        expect(params.loadUint(2)).toBe(0); // referral_addr = addr_none$00
        expect(params.loadUint(1)).toBe(0); // fulfill_payload = none$0
        expect(params.loadUint(1)).toBe(0); // reject_payload = none$0
        expect(params.remainingBits).toBe(0);
        expect(params.remainingRefs).toBe(0);
    });

    /**
     * THE ENVELOPE, NOT THE BODY — the half this file did not check, and the
     * half that was wrong on chain for the whole of the project's life.
     *
     * Every assertion above reads the swap CELL, and every one of them passed
     * while `flush()` attached `value: amount` to a message declaring `amount`
     * as its input. The forward fee comes out of `value`, so DeDust's native
     * vault always saw `msg_value < amount`, threw its own exit 263 and bounced
     * — and `onBouncedMessage` stamped FLUSH_BOUNCED, the same code the floor
     * guard's legitimate refusal produces. Isolated on testnet 2026-09-17:
     * identical swaps from one wallet with `limit = 0`, one at `value == amount`
     * (exit 263) and one at `value == amount + 0.25` (exit 0, filled).
     */
    it('attaches the swap input PLUS the gas the vault charges, never the input alone', async () => {
        await ledger.sendMint(minter.getSender(), {
            n: OPENING_HEAD,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        const pending = await ratchet.getPending();
        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        const swapMsg = r.transactions
            .flatMap((t) => t.outMessages?.values?.() ?? [])
            .find(
                (m) =>
                    m.info?.dest &&
                    Address.isAddress(m.info.dest) &&
                    (m.info.dest as Address).equals(vaultStub.address)
            )!;
        expect(swapMsg.info.type).toBe('internal');
        const attached = (swapMsg.info as { value: { coins: bigint } }).value.coins;
        const declared = (() => {
            const b = swapMsg.body.beginParse();
            b.loadUint(32);
            b.loadUint(64);
            return b.loadCoins();
        })();
        expect(declared).toBe(pending);
        // The whole point, and note that `attached` is already NET of the forward
        // fee — that deduction is the mechanism of the bug, and it is visible
        // right here: the vault is credited a little less than the sender put in,
        // so `value == amount` can only ever arrive as `msg_value < amount`.
        expect(attached).toBeGreaterThan(declared);
        expect(attached - declared).toBeGreaterThan(DEDUST_SWAP_GAS - toNano('0.01'));
    });

    /**
     * And the other side of it (D-146, caller pays): the vault's gas comes out of the
     * CALLER's value — never `pending`, and no longer the contract's own buffer — so a
     * ratchet with NO buffer at all still flushes, and ends the call with the buffer it
     * started with. §5's `T = seeded + swapped + pending` stays exact whatever DeDust
     * charges.
     *
     * An under-funded call must refuse BY NAME. The alternative is an outbound message
     * the contract cannot afford, which fails in the ACTION phase: no compute error,
     * nothing sent, and invisible to every get-method.
     */
    it('flushes with a dry buffer because the caller pays, and refuses an under-funded caller by name', async () => {
        await ledger.sendMint(minter.getSender(), {
            n: OPENING_HEAD,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        const before = await ratchet.getPending();
        // No buffer at all: the balance is exactly `pending`.
        const account = await blockchain.getContract(ratchet.address);
        account.balance = before;

        const short = await ratchet.sendFlush(minter.getSender(), { value: toNano('0.25') });
        expect(short.transactions).toHaveTransaction({ to: ratchet.address, exitCode: ERRORS.ratchet_flush_gas });
        expect(await ratchet.getPending()).toBe(before);
        expect(await ratchet.getSwapped()).toBe(0n);

        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(r.transactions).toHaveTransaction({ from: minter.address, to: ratchet.address, success: true });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const swapped = await ratchet.getSwapped();
        expect(swapped).toBeGreaterThan(0n);
        // The buffer (balance above `pending`) did not go below where it started: zero.
        const after = (await blockchain.getContract(ratchet.address)).balance - (await ratchet.getPending());
        expect(after).toBeGreaterThanOrEqual(0n);
    });

    it('a vault payout SMALLER than the swap in flight is not its refusal — a recipient_addr swap cannot inflate `pending`', async () => {
        // Anyone can make DeDust's native vault pay this contract: swap jetton ->
        // GRAM with `recipient_addr` = the ratchet. Timed while our own swap is in
        // flight and about to FILL, that payout used to be read as the refusal and
        // put the whole `inFlightFlush` back into `pending` after the GRAM had left.
        await ledger.sendMint(minter.getSender(), {
            n: OPENING_HEAD,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        const f = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        expect(f.transactions).not.toHaveTransaction({ aborted: true });
        const inFlight = await ratchet.getInFlightFlush();
        expect(inFlight).toBeGreaterThan(toNano('0.02'));
        const pendingBefore = await ratchet.getPending();
        const swappedBefore = await ratchet.getSwapped();
        const payout = beginCell().storeUint(0x474f86cf, 32).storeUint(0, 64).storeUint(0, 1).endCell();

        const forged = await vaultStub.send({ to: ratchet.address, value: toNano('0.02'), body: payout });
        expect(forged.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await ratchet.getSwapped()).toBe(swappedBefore);
        expect(await ratchet.getInFlightFlush()).toBe(inFlight);

        // The genuine refusal pays back the whole input and is still honoured.
        const refund = await vaultStub.send({ to: ratchet.address, value: inFlight + toNano('0.01'), body: payout });
        expect(refund.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ratchet.getPending()).toBe(pendingBefore + inFlight);
        expect(await ratchet.getSwapped()).toBe(swappedBefore - inFlight);
        expect(await ratchet.getInFlightFlush()).toBe(0n);
    });

    it('the pool, the vault and the recipient are three distinct addresses, never conflated', async () => {
        await ledger.sendMint(minter.getSender(), {
            n: OPENING_HEAD,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 1n }],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        const r = await ratchet.sendFlush(minter.getSender(), { value: FLUSH_VALUE });
        const swapMsg = r.transactions
            .flatMap((t) => t.outMessages?.values?.() ?? [])
            .find(
                (m) =>
                    m.info?.dest &&
                    Address.isAddress(m.info.dest) &&
                    (m.info.dest as Address).equals(vaultStub.address)
            )!;
        const s = swapMsg.body.beginParse();
        s.loadUint(32);
        s.loadUint(64);
        s.loadCoins();
        const poolAddr = s.loadAddress();
        s.loadUint(1);
        s.loadCoins();
        s.loadUint(1);
        const params = s.loadRef().beginParse();
        params.loadUint(32); // deadline
        const recipientAddr = params.loadAddress();

        expect(poolAddr.equals(poolStub.address)).toBe(true);
        expect(poolAddr.equals(vaultStub.address)).toBe(false);
        expect(recipientAddr.equals(ratchet.address)).toBe(true);
        expect(recipientAddr.equals(poolStub.address)).toBe(false);
        expect(recipientAddr.equals(jettonVaultStub.address)).toBe(false);
    });
});
