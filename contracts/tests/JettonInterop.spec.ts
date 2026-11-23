// TON PRIMES — TEP-74 standard surface on the PRIMES jetton.
//
// WHY THIS EXISTS
//
// TVM method IDs are derived from the exact method-name string. `getJettonData`
// and `get_jetton_data` are therefore two unrelated selectors, and until this
// change the contracts exported only the first: every camelCase getter worked,
// every internal test passed, and no wallet, explorer or DEX on TON could read
// the jetton at all. The NFT half of that gap was closed earlier (the TEP-62
// block in primes_collection.tolk / primes_item.tolk, pinned in FeeLines.spec);
// the jetton half was not.
//
// That matters beyond cosmetics. PRIMES is one side of the ratchet's DeDust pair
// (CONCEPT.md §4.3): a jetton a venue cannot identify is a jetton that cannot be
// listed, and `flush()` has nothing to sell into. The bounty-readiness gate is
// explicit that the bounty audience will check with Tonviewer.
//
// Every assertion below calls the method by its STANDARD name through the same
// `provider.get(name)` path a wallet uses, because that is the only thing that
// proves the selector is exported. Asserting on the camelCase getters would pass
// with or without the fix.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesJettonMaster, offchainContentCell } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { TEP74, JETTON_MASTER } from '../../shared/opcodes';
import { internal as sandboxInternal } from '@ton/sandbox';
import { firstHop, outTo } from './helpers/inFlight';

const METADATA_URI = 'https://primes.live/jetton.json';

describe('TEP-74 — the PRIMES jetton as a wallet or DEX sees it', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let holder: SandboxContract<TreasuryContract>;
    let master: SandboxContract<PrimesJettonMaster>;
    let masterCode: Cell;
    let walletCode: Cell;

    beforeAll(async () => {
        masterCode = await compile('PrimesJettonMaster');
        walletCode = await compile('PrimesJettonWallet');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        holder = await blockchain.treasury('holder');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                {
                    ledgerAddr: deployer.address, // stands in for the ledger
                    genesisScriptAddr: genesisScript.address,
                    walletCode,
                    content: offchainContentCell(METADATA_URI),
                },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));
    });

    describe('get_jetton_data on the master', () => {
        it('is exported under its standard method ID at all', async () => {
            // The regression in one line: before the fix this threw "method not found",
            // which is exactly what Tonviewer would have reported.
            await expect(master.getJettonDataStandard()).resolves.toBeDefined();
        });

        it('agrees with the project-native getter on supply and wallet code', async () => {
            const std = await master.getJettonDataStandard();
            const native = await master.getJettonData();
            expect(std.totalSupply).toBe(native.totalSupply);
            expect(std.jettonWalletCode.equals(native.walletCode)).toBe(true);
        });

        it('returns the configured TEP-64 content verbatim', async () => {
            const { jettonContent } = await master.getJettonDataStandard();
            const s = jettonContent.beginParse();
            expect(s.loadUint(8)).toBe(0x01); // off-chain content tag
            expect(s.loadBuffer(Math.floor(s.remainingBits / 8)).toString('utf8')).toBe(METADATA_URI);
        });

        it('reports mintable, because the ledger never stops emitting rebates', async () => {
            // §5: SealAuthority retires the GENESIS mint path only; MintOp from the ledger
            // stays live for every composite mint thereafter. Reporting a fixed supply here
            // would be a false claim about the tokenomics, not a conservative one.
            const before = await master.getJettonDataStandard();
            expect(before.mintable).toBe(-1);

            // Sealing before `set_ledger` is refused (402): the placeholder would keep mint authority.
            const early = await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
            expect(early.transactions).toHaveTransaction({ to: master.address, success: false, exitCode: 402 });
            expect((await master.getJettonData()).genesisSealed).toBe(0);

            await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: deployer.address, value: toNano('0.05') });
            await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
            expect((await master.getJettonData()).genesisSealed).toBe(1);

            const after = await master.getJettonDataStandard();
            expect(after.mintable).toBe(-1);
        });

        it('names the ledger as admin — the address that may actually mint', async () => {
            // TEP-74's "admin" is defined as the minter, and that is `ledgerAddr`. §8's
            // guarantee is that no PERSON holds a key over any GRAM balance, which naming a
            // keyless contract here does not weaken. addr_none would read as a stronger
            // claim while being false.
            const { adminAddress } = await master.getJettonDataStandard();
            expect(adminAddress.toString()).toBe(deployer.address.toString());
        });

        it('defaults to empty content when a deploy omits it, rather than failing', async () => {
            // Rehearsals and the other contract suites construct a master without metadata.
            // Empty must stay a legal, readable value — an explorer showing an unnamed token
            // is a deployment mistake to catch at genesis, not a get-method that throws.
            const bare = blockchain.openContract(
                PrimesJettonMaster.createFromConfig(
                    { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                    masterCode
                )
            );
            await bare.sendDeploy(deployer.getSender(), toNano('5'));
            const { jettonContent } = await bare.getJettonDataStandard();
            expect(jettonContent.bits.length).toBe(0);
        });
    });

    describe('get_wallet_address on the master', () => {
        it('is exported, and agrees with the native getter', async () => {
            const std = await master.getWalletAddressStandard(holder.address);
            const native = await master.getWalletAddress(holder.address);
            expect(std.toString()).toBe(native.toString());
        });

        it('resolves to the address the master actually deploys a wallet at', async () => {
            // The whole point of the standard method: a DEX derives the wallet address this
            // way and sends to it. If the derivation disagreed with the deploy, transfers
            // would land on an uninitialised account.
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: holder.address,
                amount: toNano('100'),
                value: toNano('0.5'),
            });

            const derived = await master.getWalletAddressStandard(holder.address);
            const wallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(derived));
            expect((await wallet.getWalletData()).balance).toBe(toNano('100'));
        });
    });

    describe('get_wallet_data on a holder wallet', () => {
        it('is exported and reports balance, owner and master', async () => {
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: holder.address,
                amount: toNano('42'),
                value: toNano('0.5'),
            });

            const walletAddr = await master.getWalletAddressStandard(holder.address);
            const wallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(walletAddr));

            const std = await wallet.getWalletDataStandard();
            expect(std.balance).toBe(toNano('42'));
            expect(std.owner.toString()).toBe(holder.address.toString());
            expect(std.jettonMaster.toString()).toBe(master.address.toString());
            expect(std.code.equals(walletCode)).toBe(true);
        });

        it('agrees with the project-native getter field for field', async () => {
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: holder.address,
                amount: toNano('7'),
                value: toNano('0.5'),
            });
            const walletAddr = await master.getWalletAddressStandard(holder.address);
            const wallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(walletAddr));

            const std = await wallet.getWalletDataStandard();
            const native = await wallet.getWalletData();
            expect(std.balance).toBe(native.balance);
            expect(std.owner.toString()).toBe(native.owner.toString());
            expect(std.jettonMaster.toString()).toBe(native.jettonMaster.toString());
        });
    });

    it('carries the URI a genesis deploy stamps in, readable end to end', async () => {
        // The one path that matters in production: deployGenesis.ts passes this URI, the
        // pipeline turns it into a content cell, the master stores it immutably, and an
        // explorer reads it back out of get_jetton_data. webapp/src/lib/jettonMetadata
        // pins what is served AT that URL; this pins that the URL itself survives.
        const uri = 'https://primes.live/jetton.json';
        const deployed = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                {
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    walletCode,
                    content: offchainContentCell(uri),
                },
                masterCode
            )
        );
        await deployed.sendDeploy(deployer.getSender(), toNano('5'));

        const s = (await deployed.getJettonDataStandard()).jettonContent.beginParse();
        expect(s.loadUint(8)).toBe(0x01);
        expect(s.loadBuffer(Math.floor(s.remainingBits / 8)).toString('utf8')).toBe(uri);
    });

    it('keeps every standard selector resolvable together — the Tonviewer check', () => {
        // A deploy is only renderable if ALL of these answer. Grouping them makes the
        // failure legible as "the jetton is invisible" rather than as one odd getter.
        return Promise.all([
            master.getJettonDataStandard(),
            master.getWalletAddressStandard(holder.address),
        ]).then((results) => {
            expect(results).toHaveLength(2);
        });
    });
});

describe('GAUNTLET.md V4 — the wallet parses a real TEP-74 transfer#0f8a7ea5 body', () => {
    // Every body in this block is built BY HAND straight from `@ton/core`
    // primitives against the standard's own published TL-B
    // (github.com/ton-blockchain/TEPs 0074), not through
    // `PrimesJettonWallet.sendTransfer` — the whole point is that a bug shared
    // between this repo's wrapper and its contract (exactly what happened
    // before this fix: both agreed on a shape that no real wallet, DEX or
    // indexer would ever send) cannot hide behind a test that goes through the
    // same wrapper.
    //
    //   transfer#0f8a7ea5 query_id:uint64 amount:(VarUInteger 16)
    //     destination:MsgAddress response_destination:MsgAddress
    //     custom_payload:(Maybe ^Cell) forward_ton_amount:(VarUInteger 16)
    //     forward_payload:(Either Cell ^Cell) = InternalMsgBody;
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let holder: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let master: SandboxContract<PrimesJettonMaster>;
    let masterCode: Cell;
    let walletCode: Cell;
    let holderWallet: SandboxContract<PrimesJettonWallet>;

    beforeAll(async () => {
        masterCode = await compile('PrimesJettonMaster');
        walletCode = await compile('PrimesJettonWallet');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        holder = await blockchain.treasury('holder', { balance: toNano('1000') });
        stranger = await blockchain.treasury('stranger');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));
        await master.sendMintGenesis(genesisScript.getSender(), { to: holder.address, amount: toNano('1000'), value: toNano('0.5') });
        const holderWalletAddr = await master.getWalletAddressStandard(holder.address);
        holderWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(holderWalletAddr));
    });

    /** A real TEP-74 transfer body, every field chosen by the caller — no defaults borrowed from this repo's own wrapper. */
    function realTransferBody(opts: {
        amount: bigint;
        destination: Address;
        responseDestination: Address | null;
        customPayload: Cell | null; // null = Maybe absent
        forwardTonAmount: bigint;
        forwardPayloadInline: Cell | null; // non-null = Either bit 0, inline
        forwardPayloadRef: Cell | null; // non-null = Either bit 1, ref (ignored if forwardPayloadInline set)
    }): Cell {
        const b = beginCell()
            .storeUint(0x0f8a7ea5, 32)
            .storeUint(1, 64)
            .storeCoins(opts.amount)
            .storeAddress(opts.destination)
            .storeAddress(opts.responseDestination);
        if (opts.customPayload) {
            b.storeBit(true).storeRef(opts.customPayload);
        } else {
            b.storeBit(false);
        }
        b.storeCoins(opts.forwardTonAmount);
        if (opts.forwardPayloadInline) {
            b.storeBit(false).storeSlice(opts.forwardPayloadInline.beginParse());
        } else {
            b.storeBit(true).storeRef(opts.forwardPayloadRef ?? beginCell().endCell());
        }
        return b.endCell();
    }

    it('accepts custom_payload absent (Maybe bit 0) and forward_payload as a REF (Either bit 1) — the pre-fix contract threw on this', async () => {
        const destWalletAddr = await master.getWalletAddressStandard(stranger.address);
        const payload = beginCell().storeUint(0xdead, 16).endCell();
        const r = await holder.send({
            to: holderWallet.address,
            value: toNano('0.3'),
            bounce: true,
            body: realTransferBody({
                amount: toNano('10'),
                destination: stranger.address,
                responseDestination: holder.address,
                customPayload: null,
                forwardTonAmount: toNano('0.05'),
                forwardPayloadInline: null,
                forwardPayloadRef: payload,
            }),
        });
        expect(r.transactions).toHaveTransaction({ to: holderWallet.address, success: true });
        expect(r.transactions).toHaveTransaction({ to: destWalletAddr, success: true });

        const destWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(destWalletAddr));
        expect((await destWallet.getWalletData()).balance).toBe(toNano('10'));
        expect((await holderWallet.getWalletData()).balance).toBe(toNano('990'));
    });

    it('accepts custom_payload present (Maybe bit 1 + ref) and forward_payload INLINE (Either bit 0) — the standards-legal case this repo never sends itself', async () => {
        const destWalletAddr = await master.getWalletAddressStandard(stranger.address);
        const inlinePayload = beginCell().storeUint(0x1234, 16).endCell();
        const r = await holder.send({
            to: holderWallet.address,
            value: toNano('0.3'),
            bounce: true,
            body: realTransferBody({
                amount: toNano('5'),
                destination: stranger.address,
                responseDestination: holder.address,
                customPayload: beginCell().storeUint(1, 8).endCell(),
                forwardTonAmount: toNano('0.05'),
                forwardPayloadInline: inlinePayload,
                forwardPayloadRef: null,
            }),
        });
        expect(r.transactions).toHaveTransaction({ to: holderWallet.address, success: true });
        expect(r.transactions).toHaveTransaction({ to: destWalletAddr, success: true });

        const destWallet = blockchain.openContract(PrimesJettonWallet.createFromAddress(destWalletAddr));
        expect((await destWallet.getWalletData()).balance).toBe(toNano('5'));
    });

    it('the inline forward_payload survives the relay byte-for-byte into transfer_notification', async () => {
        const destWalletAddr = await master.getWalletAddressStandard(stranger.address);
        const inlinePayload = beginCell().storeUint(0xcafe, 16).endCell();
        const r = await holder.send({
            to: holderWallet.address,
            value: toNano('0.3'),
            bounce: true,
            body: realTransferBody({
                amount: toNano('1'),
                destination: stranger.address,
                responseDestination: null,
                customPayload: null,
                forwardTonAmount: toNano('0.05'),
                forwardPayloadInline: inlinePayload,
                forwardPayloadRef: null,
            }),
        });
        const notifyMsg = r.transactions
            .flatMap((t) => t.outMessages?.values?.() ?? [])
            .find((m) => m.info?.dest && Address.isAddress(m.info.dest) && (m.info.dest as Address).equals(stranger.address));
        expect(notifyMsg).toBeDefined();
        const s = notifyMsg!.body.beginParse();
        expect(s.loadUint(32)).toBe(0x7362d09c);
        s.loadUint(64); // queryId
        expect(s.loadCoins()).toBe(toNano('1')); // amount
        s.loadAddress(); // sender
        const carried = s.loadRef(); // this wallet's own always-a-ref forwardPayload
        expect(carried.equals(inlinePayload)).toBe(true);
    });

    it('response_destination = addr_none sends no excesses at all', async () => {
        const r = await holder.send({
            to: holderWallet.address,
            value: toNano('0.3'),
            bounce: true,
            body: realTransferBody({
                amount: toNano('1'),
                destination: stranger.address,
                responseDestination: null,
                customPayload: null,
                forwardTonAmount: 0n,
                forwardPayloadInline: null,
                forwardPayloadRef: null,
            }),
        });
        const excesses = r.transactions
            .flatMap((t) => t.outMessages?.values?.() ?? [])
            .filter((m) => m.body.beginParse().preloadUint(32) === 0xd53276db);
        expect(excesses).toHaveLength(0);
    });

    it('a real response_destination gets the excesses message back (0xd53276db)', async () => {
        const r = await holder.send({
            to: holderWallet.address,
            value: toNano('0.3'),
            bounce: true,
            body: realTransferBody({
                amount: toNano('1'),
                destination: stranger.address,
                responseDestination: holder.address,
                customPayload: null,
                forwardTonAmount: 0n,
                forwardPayloadInline: null,
                forwardPayloadRef: null,
            }),
        });
        const excesses = r.transactions
            .flatMap((t) => t.outMessages?.values?.() ?? [])
            .find(
                (m) =>
                    m.info?.dest &&
                    Address.isAddress(m.info.dest) &&
                    (m.info.dest as Address).equals(holder.address) &&
                    m.body.beginParse().preloadUint(32) === 0xd53276db
            );
        expect(excesses).toBeDefined();
    });

    it('a notification to a masterchain owner that cannot pay its fee does not undo the credit (2026-11-08 audit)', async () => {
        // The ledger's rebate mint forwards 0.005 GRAM; a `-1:` owner prices the notification
        // at masterchain rates (~0.011 GRAM). Sent without IGNORE_ERRORS, that action-phase
        // failure aborted the receiving wallet and bounced the PRIMES away.
        const mcOwner = new Address(-1, Buffer.alloc(32, 0x11));
        const r = await holder.send({
            to: holderWallet.address,
            value: toNano('0.3'),
            bounce: true,
            body: realTransferBody({
                amount: toNano('1'),
                destination: mcOwner,
                responseDestination: holder.address,
                customPayload: null,
                forwardTonAmount: toNano('0.005'),
                forwardPayloadInline: null,
                forwardPayloadRef: null,
            }),
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const dest = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddressStandard(mcOwner)),
        );
        expect((await dest.getWalletData()).balance).toBe(toNano('1'));
    });

    it('too little value for the requested forward throws 709, TEP-74\'s own gas check', async () => {
        const r = await holder.send({
            to: holderWallet.address,
            value: toNano('0.02'), // well under any real forward_ton_amount + overhead
            bounce: true,
            body: realTransferBody({
                amount: toNano('1'),
                destination: stranger.address,
                responseDestination: holder.address,
                customPayload: null,
                forwardTonAmount: toNano('0.5'), // far more than was attached
                forwardPayloadInline: null,
                forwardPayloadRef: null,
            }),
        });
        expect(r.transactions).toHaveTransaction({ to: holderWallet.address, success: false, exitCode: 709 });
        // Refused before state moved: balance is untouched.
        expect((await holderWallet.getWalletData()).balance).toBe(toNano('1000'));
    });

    it('the forward is paid from the attached value, never the receiving wallet\'s own GRAM', async () => {
        // Pre-fix the receiver sent the notification REGULAR out of its balance
        // AND a mode-64 excesses carrying the whole inbound value, so a funded
        // wallet lost `forward_ton_amount` on every transfer it received.
        const destWalletAddr = await master.getWalletAddressStandard(stranger.address);
        const body = (forwardTonAmount: bigint) =>
            realTransferBody({
                amount: toNano('1'),
                destination: stranger.address,
                responseDestination: holder.address,
                customPayload: null,
                forwardTonAmount,
                forwardPayloadInline: null,
                forwardPayloadRef: null,
            });
        await holder.send({ to: holderWallet.address, value: toNano('0.3'), bounce: true, body: body(0n) }); // deploy it
        await holder.send({ to: destWalletAddr, value: toNano('1'), bounce: false }); // fund it
        const before = (await blockchain.getContract(destWalletAddr)).balance;

        const attached = toNano('0.3');
        const forward = toNano('0.05');
        const r = await holder.send({ to: holderWallet.address, value: attached, bounce: true, body: body(forward) });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: destWalletAddr, to: stranger.address, op: 0x7362d09c });

        const after = (await blockchain.getContract(destWalletAddr)).balance;
        expect(after).toBeGreaterThanOrEqual(before - toNano('0.001')); // storage only

        const excess = r.transactions
            .flatMap((t) => t.outMessages?.values?.() ?? [])
            .find((m) => m.info.type === 'internal' && m.body.beginParse().preloadUint(32) === 0xd53276db);
        expect(excess).toBeDefined();
        const excessValue = excess!.info.type === 'internal' ? excess!.info.value.coins : 0n;
        expect(excessValue).toBeLessThan(attached - forward);
        expect(excessValue).toBeGreaterThan(attached - forward - toNano('0.03')); // two hops of gas + fwd fees
    });

    it('value that clears forward + flat overhead but not the fwd_count fees is refused with 709', async () => {
        const forward = toNano('0.05');
        const r = await holder.send({
            to: holderWallet.address,
            value: forward + toNano('0.01') + 1n, // passes the pre-fix check, not the fwd_count one
            bounce: true,
            body: realTransferBody({
                amount: toNano('1'),
                destination: stranger.address,
                responseDestination: holder.address,
                customPayload: null,
                forwardTonAmount: forward,
                forwardPayloadInline: null,
                forwardPayloadRef: null,
            }),
        });
        expect(r.transactions).toHaveTransaction({ to: holderWallet.address, success: false, exitCode: 709 });
        expect((await holderWallet.getWalletData()).balance).toBe(toNano('1000'));
    });
});

/**
 * TEP-89 — the ON-CHAIN half of the same gap the file above closes off-chain.
 *
 * The `get_jetton_data` tests prove a HUMAN with an explorer can read PRIMES.
 * They cannot prove a CONTRACT can, because a get-method is not callable from
 * one. A DEX vault deploying against a jetton master learns its wallet address
 * by sending `provide_wallet_address#2c76b973` and waiting for
 * `take_wallet_address#d1735400`, and until 2026-09-16 this master answered
 * that with `throw 101`.
 *
 * Measured on testnet that day, and the reason these tests exist: DeDust's
 * factory accepted `create_vault#21cfe02b`, its new PRIMES vault deployed and
 * asked, the master aborted with exit 101, the message bounced, and the vault
 * never reached `is_ready` — uninit, 0 GRAM, stake returned. `create_vault`
 * itself reports success, so nothing upstream notices. A pool in that state can
 * never hold liquidity, which makes the ratchet's flush leg (CONCEPT.md §4.3)
 * unsellable on mainnet exactly as on testnet.
 *
 * So the assertion that matters is not "a reply came back" — it is that the
 * request did not ABORT. A test that only checked for a reply would still pass
 * against a master that bounced.
 */
describe('TEP-89 — the PRIMES jetton as a DEX VAULT sees it', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let venue: SandboxContract<TreasuryContract>;
    let master: SandboxContract<PrimesJettonMaster>;
    let masterCode: Cell;
    let walletCode: Cell;

    const provideBody = (queryId: bigint, owner: Address, includeAddress: boolean) =>
        beginCell()
            .storeUint(0x2c76b973, 32)
            .storeUint(queryId, 64)
            .storeAddress(owner)
            .storeBit(includeAddress)
            .endCell();

    beforeAll(async () => {
        masterCode = await compile('PrimesJettonMaster');
        walletCode = await compile('PrimesJettonWallet');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        venue = await blockchain.treasury('venue'); // stands in for a DeDust jetton vault
        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                {
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    walletCode,
                    content: offchainContentCell(METADATA_URI),
                },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));
    });

    it('answers provide_wallet_address instead of aborting on it', async () => {
        const r = await venue.send({
            to: master.address,
            value: toNano('0.15'), // what DeDust's vault actually attached on testnet
            bounce: true,
            body: provideBody(42n, venue.address, false),
        });

        // THE REGRESSION, in one assertion. Before the fix this was
        // success: false, exitCode: 101, aborted: true.
        expect(r.transactions).toHaveTransaction({
            from: venue.address,
            to: master.address,
            success: true,
        });
        // And nothing anywhere bounced — the vault's stake was not handed back.
        expect(r.transactions).not.toHaveTransaction({ inMessageBounced: true });
    });

    it('returns the address the master itself would deploy for that owner', async () => {
        const r = await venue.send({
            to: master.address,
            value: toNano('0.15'),
            bounce: true,
            body: provideBody(7n, venue.address, false),
        });

        const reply = r.transactions
            .flatMap((t) => t.outMessages.values())
            .find((m) => {
                try {
                    return m.body.beginParse().preloadUint(32) === 0xd1735400;
                } catch {
                    return false;
                }
            });
        expect(reply).toBeDefined();

        const s = reply!.body.beginParse();
        expect(s.loadUint(32)).toBe(0xd1735400);
        expect(s.loadUintBig(64)).toBe(7n);
        const answered = s.loadAddress();

        // Cross-checked against the get-method, so the two halves of the
        // standard surface cannot drift apart.
        const viaGetter = await master.getWalletAddress(venue.address);
        expect(answered.equals(viaGetter)).toBe(true);

        // include_address was false, so the Maybe ref is absent.
        expect(s.loadMaybeRef()).toBeNull();
        expect(s.remainingBits).toBe(0);
    });

    it('echoes the owner in a MAYBE REF when include_address is set', async () => {
        const r = await venue.send({
            to: master.address,
            value: toNano('0.15'),
            bounce: true,
            body: provideBody(9n, venue.address, true),
        });

        const reply = r.transactions
            .flatMap((t) => t.outMessages.values())
            .find((m) => {
                try {
                    return m.body.beginParse().preloadUint(32) === 0xd1735400;
                } catch {
                    return false;
                }
            })!;
        const s = reply.body.beginParse();
        s.skip(32 + 64);
        s.loadAddress();
        const ownerRef = s.loadMaybeRef();
        expect(ownerRef).not.toBeNull();
        // A REF, not inline — the shape DeDust and every TEP-89 reader expects.
        expect(ownerRef!.beginParse().loadAddress().equals(venue.address)).toBe(true);
    });

    it('replies non-bounceable, so the master is never handed GRAM it cannot route', async () => {
        const r = await venue.send({
            to: master.address,
            value: toNano('0.15'),
            bounce: true,
            body: provideBody(1n, venue.address, false),
        });
        const reply = r.transactions
            .flatMap((t) => t.outMessages.values())
            .find((m) => {
                try {
                    return m.body.beginParse().preloadUint(32) === 0xd1735400;
                } catch {
                    return false;
                }
            })!;
        expect(reply.info.type).toBe('internal');
        expect((reply.info as { bounce: boolean }).bounce).toBe(false);
    });
});

/**
 * TEP-74's EXCESS RETURN, coming home to the master.
 *
 * Third instance of the same shape as the two blocks above: a standard message
 * this contract is on the receiving end of, with no arm to receive it, falling
 * into `else => assert (in.body.isEmpty()) throw 101`.
 *
 * `deployAndCredit` names the MASTER as `responseAddr` — it funds the 0.012 GRAM
 * wallet deploy out of the value the ledger attached, so the change is its own —
 * and the freshly deployed wallet answers with `excesses#d53276db`. Until this
 * arm existed that reply aborted with exit 101 on EVERY mint the game has ever
 * performed.
 *
 * Measured on testnet 2026-09-17, trace `8c354845…d724a`: a 1 GRAM mint whose
 * every economic leg was exit 0 — item minted, PRIMES credited, splitter,
 * ratchet, treasury, bounty — and which Tonviewer nonetheless renders as
 * FAILED, because a trace is red if any transaction in it aborted. The GRAM was
 * never at risk (the wallet sends it `NoBounce`, so the credit phase had landed
 * it before the compute phase threw), which is exactly why nine months of tests
 * that assert on BALANCES never saw it.
 *
 * So these assertions are about the SHAPE OF THE TRACE, not about money. A test
 * that checked the recipient's balance would pass with or without the fix — the
 * existing ones in this file do.
 */
describe('TEP-74 excesses — the master accepts its own change back', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let holder: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let master: SandboxContract<PrimesJettonMaster>;
    let masterCode: Cell;
    let walletCode: Cell;

    const excessesBody = (queryId: bigint) =>
        beginCell().storeUint(TEP74.excesses, 32).storeUint(queryId, 64).endCell();

    beforeAll(async () => {
        masterCode = await compile('PrimesJettonMaster');
        walletCode = await compile('PrimesJettonWallet');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        holder = await blockchain.treasury('holder');
        stranger = await blockchain.treasury('stranger');
        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                {
                    ledgerAddr: deployer.address, // stands in for the ledger
                    genesisScriptAddr: genesisScript.address,
                    walletCode,
                    content: offchainContentCell(METADATA_URI),
                },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));
    });

    it('a mint aborts NOTHING — the wallet’s excesses reply is answered, not thrown at', async () => {
        const r = await master.sendMintGenesis(genesisScript.getSender(), {
            to: holder.address,
            amount: toNano('1000'),
            value: toNano('0.5'),
        });

        // THE REGRESSION. Before the fix this leaf was
        // success: false, exitCode: 101, aborted: true — and the mint above it
        // succeeded anyway, which is why it hid for so long.
        expect(r.transactions).toHaveTransaction({
            to: master.address,
            op: TEP74.excesses,
            success: true,
            aborted: false,
        });

        // And the whole trace is clean, which is the thing a reader with an
        // explorer actually sees.
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).not.toHaveTransaction({ exitCode: 101 });
    });

    it('the change is KEPT, not bounced away — the deploy reserve funds the next mint', async () => {
        const balanceOf = async () => (await blockchain.getContract(master.address)).balance;

        await master.sendMintGenesis(genesisScript.getSender(), {
            to: holder.address, amount: toNano('1000'), value: toNano('0.5'),
        });
        const afterFirst = await balanceOf();

        // A second mint to the SAME holder: no wallet to deploy, so almost all
        // of `deployAndCredit`'s 0.012 GRAM comes straight back. The master must
        // end up richer than the 0.012 GRAM it just committed would suggest.
        const before = await balanceOf();
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: holder.address, amount: toNano('1000'), value: toNano('0.5'),
        });
        expect(await balanceOf()).toBeGreaterThan(before);
        expect(afterFirst).toBeGreaterThan(0n);
    });

    it('accepts a bare excesses from anyone, because there is nothing to gate', async () => {
        // No sender check by design: nothing moves, the value is credited before
        // the arm runs, and the worst an impostor achieves is donating GRAM to the
        // contract that pays for wallet deploys. Asserted so that adding a gate
        // later is a deliberate change rather than a quiet one.
        const supplyBefore = (await master.getJettonData()).totalSupply;
        const r = await stranger.send({
            to: master.address,
            value: toNano('0.05'),
            bounce: true,
            body: excessesBody(7n),
        });
        expect(r.transactions).toHaveTransaction({
            from: stranger.address, to: master.address, success: true, aborted: false,
        });
        expect(r.transactions).not.toHaveTransaction({ inMessageBounced: true });
        // Accepting is not recording: supply is a function of mints alone.
        expect((await master.getJettonData()).totalSupply).toBe(supplyBefore);
    });

    /**
     * GAUNTLET.md B28 — the same excess return, going OUT.
     *
     * The wallet carries the burner's `response_destination` all the way down to
     * the master (`primes_jetton_wallet.tolk:256`), and the master's
     * `BurnNotification` arm used to DROP it: the field was declared and never
     * read. Every PRIMES burn therefore left its remaining value with the master
     * — a contract with NO WITHDRAW PATH (§8), so not a leak to anybody, but a
     * one-way transfer out of every burner's gas budget, and a standard message
     * the master silently failed to answer.
     *
     * Asserted on the trace and on the recipient's balance together, because
     * here they say different things: the trace says the reply happened, the
     * balance says it carried the value rather than an empty message.
     */
    it('returns the burn excess to the responseAddr the burner named (B28)', async () => {
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: holder.address, amount: toNano('1000'), value: toNano('0.5'),
        });
        const wallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(holder.address))
        );
        const before = (await blockchain.getContract(holder.address)).balance;
        const r = await wallet.sendBurn(holder.getSender(), {
            amount: toNano('10'),
            responseAddr: holder.address,
            value: toNano('0.3'),
        });
        // THE REGRESSION: before this arm, no such message existed at all.
        expect(r.transactions).toHaveTransaction({
            from: master.address,
            to: holder.address,
            op: TEP74.excesses,
            success: true,
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        // The burn still happened, and is still the only thing that moved supply.
        expect((await master.getJettonData()).totalSupply).toBe(toNano('990'));
        // And the change is real value, not an empty envelope: the burner spent
        // 0.3 GRAM on the hop and got most of it back, so the net cost is gas.
        const spent = before - (await blockchain.getContract(holder.address)).balance;
        expect(spent).toBeLessThan(toNano('0.1'));
    });

    /**
     * GAUNTLET.md B28 wrote this and could not run it; B33 made it runnable.
     *
     * `addr_none` is a legal `response_destination` meaning "keep the change",
     * and B28 gave the master's `BurnNotification` arm a null branch for it. The
     * spec written to drive that branch failed ONE HOP UPSTREAM: the wallet typed
     * `Burn.responseAddr` as `address` — Tolk's non-none type — so parsing an
     * `addr_none` underflowed and the burn **aborted with exit 9 before it
     * happened**. Not a lost refund; a refused burn.
     *
     * It stood as `it.skip` naming B33 for two iterations rather than being
     * deleted, which is the loop's rule for coverage that cannot yet be driven:
     * the assertions were already the ones B33 had to make pass.
     */
    it('sends NOTHING when the burner names addr_none — keep-the-change is an answer (B28/B33)', async () => {
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: holder.address, amount: toNano('1000'), value: toNano('0.5'),
        });
        const wallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(holder.address))
        );
        const masterBefore = (await blockchain.getContract(master.address)).balance;
        const r = await wallet.sendBurn(holder.getSender(), {
            amount: toNano('10'),
            // TEP-74's `addr_none`: a legal value meaning the burner does not
            // want the change. Not a missing argument, and not a case to
            // "helpfully" default to the owner — that would send value to an
            // address the burn never named.
            responseAddr: null,
            value: toNano('0.3'),
        });
        const excesses = r.transactions
            .flatMap((t) => t.outMessages.values())
            .filter((m) => m.body.beginParse().preloadUint(32) === TEP74.excesses);
        expect(excesses).toHaveLength(0);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        // The value stays here, which is what every burn did before B28 — the
        // arm changes who gets the change, never whether the burn works.
        expect((await blockchain.getContract(master.address)).balance).toBeGreaterThan(masterBefore);
        expect((await master.getJettonData()).totalSupply).toBe(toNano('990'));
    });

    it('still refuses a genuinely unknown opcode with 101', async () => {
        // The guard this fix widened is still a guard. `0xdeadbeef` is not a
        // message this system speaks, and the master must not silently eat it.
        const r = await stranger.send({
            to: master.address,
            value: toNano('0.05'),
            bounce: true,
            body: beginCell().storeUint(0xdeadbeef, 32).storeUint(0n, 64).endCell(),
        });
        expect(r.transactions).toHaveTransaction({
            from: stranger.address, to: master.address, success: false, exitCode: 101,
        });
    });
});

/** Content-cell shape, checked without a chain — cheap and independent of compilation. */
describe('offchainContentCell', () => {
    it('emits the TEP-64 off-chain tag followed by the URI', () => {
        const cell = offchainContentCell('https://example.test/x.json');
        const s = cell.beginParse();
        expect(s.loadUint(8)).toBe(0x01);
        expect(s.loadBuffer(Math.floor(s.remainingBits / 8)).toString('utf8')).toBe('https://example.test/x.json');
    });

    it('is distinguishable from an empty default', () => {
        expect(offchainContentCell('x').equals(beginCell().endCell())).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The jetton family's three bounce arms (primes_jetton_wallet.tolk and
// primes_jetton_master.tolk onBouncedMessage): a refused InternalTransfer or
// BurnNotification gives the WALLET its debit back; a refused mint takes the
// MASTER's totalSupply back down. A wired PRIMES hop has no natural refusal, so
// each case runs the sender's first transaction alone, takes its REAL outbound
// message off it, and delivers that message to a real PRIMES contract of a
// SECOND master, whose own sender check refuses it (100). TVM builds the rich
// bounce from the message's own flags; the sender's real handler runs.
// ---------------------------------------------------------------------------
describe('jetton bounce arms: a refused hop restores the debit', () => {
    let blockchain: Blockchain;
    let genesisScript: SandboxContract<TreasuryContract>;
    let holder: SandboxContract<TreasuryContract>;
    let other: SandboxContract<TreasuryContract>;
    let master: SandboxContract<PrimesJettonMaster>;
    let foreign: SandboxContract<PrimesJettonMaster>;
    let masterCode: Cell;
    let walletCode: Cell;
    const AMOUNT = toNano('100');

    beforeAll(async () => {
        masterCode = await compile('PrimesJettonMaster');
        walletCode = await compile('PrimesJettonWallet');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        const deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        holder = await blockchain.treasury('holder');
        other = await blockchain.treasury('other');
        const mk = (uri: string) =>
            blockchain.openContract(
                PrimesJettonMaster.createFromConfig(
                    { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode, content: offchainContentCell(uri) },
                    masterCode
                )
            );
        master = mk(METADATA_URI);
        foreign = mk('https://example.test/foreign.json'); // same code, different address
        await master.sendDeploy(deployer.getSender(), toNano('5'));
        await foreign.sendDeploy(deployer.getSender(), toNano('5'));
        await master.sendMintGenesis(genesisScript.getSender(), { to: holder.address, amount: AMOUNT, value: toNano('0.2') });
        // The refusing counterparty: `other`'s ACTIVE wallet under the foreign master.
        await foreign.sendMintGenesis(genesisScript.getSender(), { to: other.address, amount: 1n, value: toNano('0.2') });
    });

    const walletOf = async (m: SandboxContract<PrimesJettonMaster>, owner: Address) =>
        blockchain.openContract(PrimesJettonWallet.createFromAddress(await m.getWalletAddress(owner)));

    /** Deliver `msg` to `dest` instead, without its deploy. */
    function redirect(msg: any, dest: Address) {
        return blockchain.sendMessage({ ...msg, info: { ...msg.info, dest }, init: undefined });
    }

    function onlyRed(r: any, at: Address) {
        const red = r.transactions.filter((t: any) => t.description.aborted).map((t: any) => t.inMessage.info.dest.toString());
        expect(red).toEqual([at.toString()]);
    }

    it('a refused InternalTransfer bounces home and the sending wallet gets its balance back', async () => {
        const w = await walletOf(master, holder.address);
        const sent = toNano('40');
        const body = beginCell()
            .storeUint(TEP74.transfer, 32).storeUint(0, 64).storeCoins(sent)
            .storeAddress(other.address).storeAddress(holder.address)
            .storeBit(false).storeCoins(0).storeBit(false).endCell();
        const hop = await firstHop(blockchain, sandboxInternal({ from: holder.address, to: w.address, value: toNano('0.2'), body }));
        expect(hop.first.description.aborted).toBe(false);
        expect((await w.getWalletData()).balance).toBe(AMOUNT - sent); // debited at send
        const msg = outTo(hop.first, await master.getWalletAddress(other.address));
        expect(msg.body.beginParse().preloadUint(32)).toBe(0x178d4519);
        expect(msg.info.bounce).toBe(true);

        const refuser = (await walletOf(foreign, other.address)).address;
        const r = await redirect(msg, refuser);
        expect(r.transactions).toHaveTransaction({ to: refuser, success: false, exitCode: 100 });
        expect(r.transactions).toHaveTransaction({ from: refuser, to: w.address, inMessageBounced: true, success: true });
        onlyRed(r, refuser);
        expect((await w.getWalletData()).balance).toBe(AMOUNT);
        expect((await master.getJettonData()).totalSupply).toBe(AMOUNT);
    });

    it('a refused BurnNotification bounces home and the burning wallet gets its balance back', async () => {
        const w = await walletOf(master, holder.address);
        const burned = toNano('25');
        const body = beginCell()
            .storeUint(TEP74.burn, 32).storeUint(0, 64).storeCoins(burned)
            .storeAddress(holder.address).storeMaybeRef(null).endCell();
        const hop = await firstHop(blockchain, sandboxInternal({ from: holder.address, to: w.address, value: toNano('0.2'), body }));
        expect(hop.first.description.aborted).toBe(false);
        expect((await w.getWalletData()).balance).toBe(AMOUNT - burned);
        const msg = outTo(hop.first, master.address);
        expect(msg.body.beginParse().preloadUint(32)).toBe(0x7bdd97de);

        // The foreign master derives a different wallet for `holder`: 100.
        const r = await redirect(msg, foreign.address);
        expect(r.transactions).toHaveTransaction({ to: foreign.address, success: false, exitCode: 100 });
        expect(r.transactions).toHaveTransaction({ from: foreign.address, to: w.address, inMessageBounced: true, success: true });
        onlyRed(r, foreign.address);
        expect((await w.getWalletData()).balance).toBe(AMOUNT);
        expect((await master.getJettonData()).totalSupply).toBe(AMOUNT); // never decremented
    });

    it('a refused mint bounces home and the master takes totalSupply back down', async () => {
        const minted = toNano('7');
        const supplyBefore = (await master.getJettonData()).totalSupply;
        const mintBody = beginCell()
            .storeUint(JETTON_MASTER.mint_genesis, 32).storeUint(0, 64)
            .storeAddress(other.address).storeCoins(minted).endCell();
        const hop = await firstHop(blockchain, sandboxInternal({ from: genesisScript.address, to: master.address, value: toNano('0.2'), body: mintBody }));
        expect(hop.first.description.aborted).toBe(false);
        expect((await master.getJettonData()).totalSupply).toBe(supplyBefore + minted); // counted at send
        const msg = outTo(hop.first, await master.getWalletAddress(other.address));
        expect(msg.body.beginParse().preloadUint(32)).toBe(0x178d4519);

        // Neither the foreign wallet's master nor a sibling of `from`: 100.
        const refuser = (await walletOf(foreign, other.address)).address;
        const r = await redirect(msg, refuser);
        expect(r.transactions).toHaveTransaction({ to: refuser, success: false, exitCode: 100 });
        expect(r.transactions).toHaveTransaction({ from: refuser, to: master.address, inMessageBounced: true, success: true });
        onlyRed(r, refuser);
        expect((await master.getJettonData()).totalSupply).toBe(supplyBefore);
    });
});
