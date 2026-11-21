import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesCollection, snakeCell } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesItem } from '../wrappers/PrimesItem';

/**
 * P0.3 / P2.C4 — `retry_credit` (0xb0000005), the permissionless retry of a
 * bounced `credit_tribute` (engineering-spec.md §3.3). Handled by
 * `primes_ledger.tolk` since the split, but never previously exercised by any
 * test in the repo: the wire-format census found it live in code with zero
 * send sites anywhere, on-chain or in TS.
 *
 * A genuine `credit_tribute` bounce (item-side out-of-gas) is not
 * deterministically reproducible in the sandbox without forcing a fragile,
 * magic-number gas failure. Instead this seeds `unroutedCredits` directly via
 * `LedgerConfig.seedUnroutedCredits` — a test-harness-only deploy override, the
 * same pattern `seedHead`/`seedPrimes`/`seedBoosts` already use elsewhere in
 * this wrapper to reach a state a real transaction sequence would also reach,
 * without needing thousands of transactions (or, here, an unreproducible gas
 * failure) to get there. What this test proves is `retry_credit`'s own logic:
 * it clears the retry record, and the resend it fires actually delivers value
 * once the item is reachable — which is the whole point of the mechanism.
 */

const MINT_PRICE = toNano('1');
const CONTENT_PREFIX = 'https://tonprimes.io/nft/';
const SEEDED_CREDIT_ID = 999n;
const SEEDED_AMOUNT = toNano('0.05');

describe('TON PRIMES — retry_credit (engineering-spec.md §3.3, P0.3/P2.C4)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
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
        stranger = await blockchain.treasury('stranger');
        minter = await blockchain.treasury('minter');

        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                {
                    nextIndex: 2n,
                    itemCode,
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    collectionContent: snakeCell('https://tonprimes.io/collection.json'),
                    commonContentPrefix: snakeCell(CONTENT_PREFIX),
                },
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

        // The credit under test names prime 2 — seeded here so the retry has
        // something real to find once it resends.
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
                    seedUnroutedCredits: [{ creditId: SEEDED_CREDIT_ID, p: 2n, amount: SEEDED_AMOUNT }],
                },
                ledgerCode
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: deployer.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                },
                ratchetCode
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));
        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, registrarCode)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });

        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('200'),
            seedS: 4_000_000_000_000_000n,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    async function itemAt(n: bigint) {
        const addr = await ledger.getItemAddress(n);
        return blockchain.openContract(PrimesItem.createFromAddress(addr));
    }

    it('seeds a declared liability: getSolvency reflects the unrouted credit before any retry', async () => {
        const { liability } = await ledger.getSolvency();
        expect(liability).toBe(SEEDED_AMOUNT);
    });

    it('retry_credit delivers the credit once the item is reachable, and clears the retry record', async () => {
        // Prime 2 is minted AFTER the ledger (and its seeded retry record) already
        // exist — mirroring a real bounce-then-retry sequence, where the bounce
        // happened before the item did.
        await ledger.sendMint(minter.getSender(), {
            n: 2n,
            kind: 1,
            factors: [],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        const item = await itemAt(2n);
        expect(await item.getOwed()).toBe(0n);

        const r = await ledger.sendRetryCredit(stranger.getSender(), {
            creditId: SEEDED_CREDIT_ID,
            value: toNano('0.1'),
        });
        expect(r.transactions).not.toHaveTransaction({ success: false });

        expect(await item.getOwed()).toBe(SEEDED_AMOUNT);

        // B-1: the retry MOVES the liability between lanes, it does not
        // discharge it. `credit_tribute` carries gas and a number, so the TON
        // never left this contract — it stopped being "owed to a retry" and
        // started being "owed to the owner of 2". The total is unchanged, and
        // it must be, because the same 0.05 TON is still sitting here.
        //
        // This assertion used to read `liability === 0n`, which is B-1 in
        // miniature: a successful retry appeared to make the ledger solvent
        // while it had merely stopped declaring what it held.
        const { liability } = await ledger.getSolvency();
        expect(liability).toBe(SEEDED_AMOUNT);
        const br = await ledger.getLiabilityBreakdown();
        expect(br.unroutedHeld).toBe(0n); // the retry lane is empty...
        expect(br.tributeOwed).toBe(SEEDED_AMOUNT); // ...and the owed lane holds it
        expect(br.tributeOwed).toBe(await item.getOwed()); // reconciles against the item
    });

    it('is permissionless: any sender may trigger the retry, not just the credit\'s owner', async () => {
        await ledger.sendMint(minter.getSender(), {
            n: 2n,
            kind: 1,
            factors: [],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        // `stranger` has no relationship to the credit or the item — the retry
        // still succeeds, matching flush()'s liveness pattern (engineering-spec
        // §3.3: "permissionless retry").
        await ledger.sendRetryCredit(stranger.getSender(), { creditId: SEEDED_CREDIT_ID, value: toNano('0.1') });
        const item = await itemAt(2n);
        expect(await item.getOwed()).toBe(SEEDED_AMOUNT);
    });

    it('an already-retried (or never-seeded) credit ID is a cheap no-op, not an error', async () => {
        await ledger.sendMint(minter.getSender(), {
            n: 2n,
            kind: 1,
            factors: [],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        await ledger.sendRetryCredit(stranger.getSender(), { creditId: SEEDED_CREDIT_ID, value: toNano('0.1') });
        const item = await itemAt(2n);
        expect(await item.getOwed()).toBe(SEEDED_AMOUNT);

        // Retrying the same ID again finds nothing (already deleted) and returns
        // without sending a second CreditTribute — `owed` and the declared
        // liability both stay exactly where the first retry left them.
        //
        // B-1 makes this test sharper than it was: a no-op retry that
        // double-credited `tributeOwed` would be invisible in `owed` (the item
        // is never messaged) and would show up ONLY here, as a ledger declaring
        // twice what it holds. That is the failure mode the paired
        // increment/decrement across the bounce and retry lanes has to avoid.
        const r = await ledger.sendRetryCredit(stranger.getSender(), { creditId: SEEDED_CREDIT_ID, value: toNano('0.1') });
        expect(r.transactions).not.toHaveTransaction({ success: false });
        expect(await item.getOwed()).toBe(SEEDED_AMOUNT);
        const { liability } = await ledger.getSolvency();
        expect(liability).toBe(SEEDED_AMOUNT);
        expect((await ledger.getLiabilityBreakdown()).tributeOwed).toBe(await item.getOwed());

        // An ID that was never seeded at all behaves identically.
        const r2 = await ledger.sendRetryCredit(stranger.getSender(), { creditId: 12345n, value: toNano('0.1') });
        expect(r2.transactions).not.toHaveTransaction({ success: false });
    });

    it('GAUNTLET B1.1: refuses an underfunded send instead of draining the ledger', async () => {
        await ledger.sendMint(minter.getSender(), {
            n: 2n,
            kind: 1,
            factors: [],
            referralKey: 0,
            beneficiary: null,
            value: MINT_PRICE,
        });
        const item = await itemAt(2n);

        // Below CLAIM_DIVIDEND_MIN_VALUE (0.01 TON): refused before any state
        // changes, never a partial drain of the ledger's own balance.
        const underfunded = await ledger.sendRetryCredit(stranger.getSender(), {
            creditId: SEEDED_CREDIT_ID,
            value: toNano('0.004'),
        });
        expect(underfunded.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 103 });
        expect(await item.getOwed()).toBe(0n); // untouched — the retry never ran

        // Exactly funded (this file's usual 0.1 TON fixture value) still works.
        const ok = await ledger.sendRetryCredit(stranger.getSender(), {
            creditId: SEEDED_CREDIT_ID,
            value: toNano('0.1'),
        });
        expect(ok.transactions).not.toHaveTransaction({ success: false });
        expect(await item.getOwed()).toBe(SEEDED_AMOUNT);
    });
});
