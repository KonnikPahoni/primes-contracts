// TON PRIMES — the open-time race between a lot and the head (D-45, D-90).
//
// REPLACES `EscrowAggregate.spec.ts`. That suite existed to prove the market's
// running total over per-shard escrow — §4.4's "347 numbers reserved ahead of
// the head, 512 GRAM escrowed" — tracked the shards it summed. D-90 deletes the
// escrow: a won lot MINTS IN ITS OWN CLOSE, so there is no pool to aggregate,
// no shard to derive an address for, and no `shard_*` message to forge. §3.4's
// decomposition is two pools now, `pending` and `owed`, and neither is here.
//
// TWO PROPERTIES SURVIVE THAT DELETION, and they are what this file keeps:
//
//   1. `open_lot` sends `mark_off_head` to the LEDGER in the same transaction
//      (D-45), and the ledger's answer is authoritative. A lot opened on a
//      number a direct mint already claimed — the race the market's lagging
//      `headHint` cannot see — is unwound by `mark_rejected`, the opener is
//      refunded the bid less REJECT_GAS, and `headHint` learns the real head. `forceCancels` counts it, and `getMarketStats`
//      publishes that count (§9.1); it moved there from the deleted
//      `getEscrowAggregate`.
//   2. `mark_rejected` is accepted ONLY from the genesis-fixed ledger address.
//      A third party able to forge it could delete any open lot and redirect
//      its refund.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { testMarketConfig, F, OPENING_HEAD, RESERVABLE_12 } from './helpers/market';
import { MARKET } from '../../shared/opcodes';

const MINT_PRICE = toNano('1');

describe('TON PRIMES — the open-time head race (D-45/D-90)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let dedust: SandboxContract<TreasuryContract>;
    let bountyVault: SandboxContract<TreasuryContract>;
    let reserver: SandboxContract<TreasuryContract>;
    let minter: SandboxContract<TreasuryContract>;
    let impostor: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;
    let ratchetCode: Cell;
    let registrarCode: Cell;
    let bookCode: Cell;

    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let book: SandboxContract<PrimesMarket>;

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
        collectionCode = await compile('PrimesCollection');
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        ledgerCode = await compile('PrimesLedger');
        ratchetCode = await compile('PrimesRatchet');
        registrarCode = await compile('PrimesRegistrar');
        bookCode = await compile('PrimesMarket');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        dedust = await blockchain.treasury('dedust');
        bountyVault = await blockchain.treasury('bountyVault');
        reserver = await blockchain.treasury('reserver');
        minter = await blockchain.treasury('minter');
        impostor = await blockchain.treasury('impostor');

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

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: dedust.address,
                    dedustPool: dedust.address,
                    primesJettonVault: dedust.address,
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

        book = blockchain.openContract(
            PrimesMarket.createFromConfig(
                testMarketConfig({
                    headHint: OPENING_HEAD,
                    ledgerAddr: ledger.address,
                    ratchetAddr: ratchet.address,
                }),
                bookCode
            )
        );
        await book.sendDeploy(deployer.getSender(), toNano('5'));

        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), {
            seedT: toNano('1000'),
            seedS: 1_200_000_000_000_000n,
            // D-20: the head opens at the first COMPOSITE; the walk marks 2 and 3.
            seedHead: OPENING_HEAD,
            value: toNano('0.05'),
        });
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: book.address,
            bountyVaultAddr: bountyVault.address,
            value: toNano('0.05'),
        });
        // CONCEPT §6 point 0: nothing mints until Unity does.
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    });

    const SMALL_FACTORS: Record<string, FactorEntry[]> = {
        '4': [F(2n, 2, 1n)],
        '6': [F(2n, 1, 1n), F(3n, 1, 1n)],
        '8': [F(2n, 3, 1n)],
        '9': [F(3n, 2, 1n)],
        '10': [F(2n, 1, 1n), F(5n, 1, 2n)],
        '12': [F(2n, 2, 1n), F(3n, 1, 1n)],
    };

    /**
     * Mint sequentially from the current head up to (but not including) `target`.
     * D-20: the head is only ever a COMPOSITE (or Unity), and each mint walks it
     * past every prime immediately above — so this loop re-reads the head rather
     * than counting, and never sends `kind = 1`.
     */
    async function mintHeadUpTo(target: bigint) {
        for (let n = await ledger.getHead(); n < target; n = await ledger.getHead()) {
            const factors = SMALL_FACTORS[n.toString()];
            expect(factors).toBeDefined(); // a head not in the table is a bug in the table
            await ledger.sendMint(minter.getSender(), {
                n,
                kind: 0,
                factors: factors!,
                referralKey: 0,
                beneficiary: null,
                value: MINT_PRICE,
            });
        }
    }

    it('unwinds a lot opened on a number the head already took, and counts it', async () => {
        // Walk the head PAST 12. Minting 12 itself walks past 13 (prime), so the
        // head lands on 14 while the market's cache is untouched at 4 — which is
        // the whole setup: the market's `n > headHint` pre-filter passes happily,
        // and the refusal is one hop later, on the ledger.
        await mintHeadUpTo(13n);
        expect(await ledger.getHead()).toBe(14n);
        expect(await book.getHeadHint()).toBe(OPENING_HEAD); // the accepted lag

        const before = await reserver.getBalance();
        // Phase 3 (§4): quoted WITH the factors this open sends.
        const quote = await book.getLotPriceFrom(RESERVABLE_12.n, RESERVABLE_12.factors);
        const opened = await book.sendOpenLot(reserver.getSender(), {
            n: RESERVABLE_12.n,
            kind: 0,
            factors: RESERVABLE_12.factors,
            beneficiary: null,
            referralKey: 0,
            value: quote.p0 + toNano('0.1'),
        });
        // The market's own handler succeeds; `mark_rejected` comes back from the
        // ledger and deletes the lot this transaction just created.
        expect(opened.transactions).toHaveTransaction({ to: book.address, success: true });
        expect((await book.getLot(RESERVABLE_12.n)).found).toBe(false);

        // Refunded in full, less gas: the auction never actually started, so
        // there is nothing to forfeit.
        const after = await reserver.getBalance();
        expect(before - after).toBeLessThan(toNano('0.2'));

        // §9.1: the count is readable. It moved to `getMarketStats` when D-90
        // deleted `getEscrowAggregate`, whose under-report bound it used to be.
        const stats = await book.getMarketStats();
        expect(stats.forceCancels).toBe(1);
        expect(stats.openLots).toBe(0);
        expect(stats.closedLots).toBe(0);
    });

    it('a rejected open costs the market nothing, and cannot be repeated on the same n', async () => {
        // The drain this closes: `headHint` lags, so `open_lot` on a number the
        // head already took passes the market's pre-filter, the market funds the
        // open (its compute and the `mark_off_head` hop), the ledger refuses,
        // and the refund returned the whole attached value. Rejection set no
        // sold bit and left `headHint` where it was, so the same `n` reopened at
        // once — the market's float paid for every round.
        await mintHeadUpTo(13n);
        const quote = await book.getLotPriceFrom(RESERVABLE_12.n, RESERVABLE_12.factors);
        const marketBalance = async () => (await blockchain.getContract(book.address)).balance;

        const before = await marketBalance();
        const opened = await book.sendOpenLot(reserver.getSender(), {
            n: RESERVABLE_12.n,
            kind: 0,
            factors: RESERVABLE_12.factors,
            beneficiary: null,
            referralKey: 0,
            value: quote.p0 + toNano('0.1'),
        });
        expect(opened.transactions).not.toHaveTransaction({ aborted: true });
        expect((await book.getMarketStats()).forceCancels).toBe(1);
        // The market ends no poorer than it started: the failed open's gas came
        // out of the opener's refund, not the float.
        expect(await marketBalance()).toBeGreaterThanOrEqual(before);
        // and the rejection taught the market the real head.
        expect(await book.getHeadHint()).toBe(await ledger.getHead());

        // So the same `n` is refused at the cheap pre-filter, on the caller's gas.
        const again = await book.sendOpenLot(reserver.getSender(), {
            n: RESERVABLE_12.n,
            kind: 0,
            factors: RESERVABLE_12.factors,
            beneficiary: null,
            referralKey: 0,
            value: quote.p0 + toNano('0.1'),
        });
        expect(again.transactions).toHaveTransaction({ to: book.address, success: false, exitCode: 1007 });
        expect((await book.getMarketStats()).forceCancels).toBe(1);
    });

    it('refuses a forged mark_rejected', async () => {
        // A third party able to forge this could delete any open lot and take
        // its refund. It is gated on the genesis-fixed LEDGER address.
        const forged = await impostor.send({
            to: book.address,
            value: toNano('0.5'),
            body: beginCell()
                .storeUint(MARKET.mark_rejected, 32)
                .storeUint(0, 64)
                .storeUint(7n, 256)
                .storeUint(1_000_000n, 256) // head: a forger would also poison headHint
                .endCell(),
        });
        expect(forged.transactions).toHaveTransaction({
            from: impostor.address,
            to: book.address,
            success: false,
            exitCode: 100, // wrong_sender
        });
        expect((await book.getMarketStats()).forceCancels).toBe(0);
    });

    it('has no escrow aggregate left to read (D-90.3)', async () => {
        // The absence IS the assertion. §3.4's decomposition is `pending` and
        // `owed`, and this contract holds neither, so the get-methods that
        // published the third pool are gone from the contract itself — a call
        // to one now fails outright rather than reading a comforting zero.
        await expect(
            (book as any).getEscrowAggregate?.() ?? Promise.reject(new Error('no such method'))
        ).rejects.toBeDefined();
        // and the surviving demand signal is the one that was always stronger:
        // premium goes to the ratchet at close and can never walk back out.
        expect((await book.getMarketStats()).lotPremiumTotal).toBe(0n);
    });
});
