import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { LEDGER } from '../../shared/opcodes';

/**
 * 2026-09-19 — GENESIS IS GRIEFABLE FOR THE PRICE OF ONE MESSAGE. Found on testnet
 * genesis `20260923`, not in this sandbox, which is why this file exists.
 *
 * WHAT FAILED. `handleGenesisSeed` used to open with two asserts, not one:
 *
 *     assert (meters.genesisSeeded == 0) throw 104;
 *     assert (storage.T == 0 && storage.S == 0) throw 104;   // <- the hazard
 *     storage.T = msg.seedT;  storage.S = msg.seedS;         // <- assignments
 *
 * The second one required a VIRGIN ledger, on the reasoning that an assignment onto
 * accrued backing would silently ERASE it. But `T` does not need a mint to become
 * non-zero: `handleRoyaltyToRatchet` (`royalty_to_ratchet#b0000079`, D-128) raises it
 * on any TEP-66 royalty, and BOTH the numbers and the generators collection sweep GRAM
 * that merely ARRIVES at them. So any stranger who sent either collection a fraction
 * of a GRAM between its deploy and the seed made the seed throw 104 — forever, on a
 * ledger that cannot be re-deployed to the same address. On testnet a faucet-spam bot
 * did exactly that, unprompted, within four minutes.
 *
 * THE FIX THIS PINS. The assert is gone and `T`/`S` ACCUMULATE (`+=`), so early
 * backing is added to rather than overwritten — the hazard is removed instead of
 * detected. `seedT` stays an ASSIGNMENT: it is the founder-capital TERM of D-26's
 * identity `T = seedT + swapped + pending`, and an early royalty is already counted in
 * `pending` (the ledger forwarded it to the ratchet when it credited `T`), so adding it
 * there too would double-count it.
 *
 * The four things below are the ones a future "tighten the genesis guard" change must
 * not break: the griefed seed survives, D-26's identity still closes, the one-shot
 * guarantee still comes from `meters.genesisSeeded` alone, and D-20's head walk still
 * opens the line at the first composite.
 */
describe('genesis seed survives an early royalty (2026-09-19, testnet genesis 20260923)', () => {
    const codes: Record<string, Cell> = {};
    /** What the faucet-spam bot's sweep was worth by the time it reached the ledger. */
    const EARLY_ROYALTY = toNano('0.37');
    const SEED_T = toNano('1000');
    const SEED_S = 1_200_000_000_000_000n;
    /** D-20 / §6 point 1: the line opens at the first composite, crossing 2 and 3. */
    const SEED_HEAD = 4n;

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<PrimesCollection>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;

    beforeAll(async () => {
        for (const n of ['PrimesItem', 'PrimesCollection', 'PrimesJettonWallet', 'PrimesJettonMaster',
                         'PrimesLedger', 'PrimesRatchet', 'PrimesRegistrar']) {
            codes[n] = await compile(n);
        }
    }, 300_000);

    // The real genesis order, stopped one step short: everything bootstrapped, nothing
    // seeded. `seedHead`/`seedPrimes` are deliberately NOT passed — this deploys at
    // head 2 with an empty bitmap, the way genesis actually does, so the walk in the
    // fourth case is the real one.
    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        const operator = await blockchain.treasury('operator');
        const treasuryWallet = await blockchain.treasury('treasury');

        collection = blockchain.openContract(PrimesCollection.createFromConfig(
            { nextIndex: 2n, itemCode: codes['PrimesItem'], ledgerAddr: deployer.address,
              genesisScriptAddr: genesisScript.address, royaltyDest: operator.address },
            codes['PrimesCollection']));
        await collection.sendDeploy(deployer.getSender(), toNano('0.5'));

        const master = blockchain.openContract(PrimesJettonMaster.createFromConfig(
            { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode: codes['PrimesJettonWallet'] },
            codes['PrimesJettonMaster']));
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        ledger = blockchain.openContract(PrimesLedger.createFromConfig({
            a: { collectionAddr: collection.address, jettonMasterAddr: master.address, treasuryAddr: treasuryWallet.address,
                 itemCode: codes['PrimesItem'] },
            b: { genesisScriptAddr: genesisScript.address },
        }, codes['PrimesLedger']));
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));

        ratchet = blockchain.openContract(PrimesRatchet.createFromConfig({
            venueTimelockAddr: deployer.address, genesisScriptAddr: genesisScript.address,
            dedustNativeVault: deployer.address, dedustPool: deployer.address, primesJettonVault: deployer.address,
        }, codes['PrimesRatchet']));
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        const registrar = blockchain.openContract(PrimesRegistrar.createFromConfig(
            { genesisScriptAddr: genesisScript.address }, codes['PrimesRegistrar']));
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), { ratchetAddr: ratchet.address, registrarAddr: registrar.address, value: toNano('0.05') });
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
    });

    /**
     * The griefing message itself. `handleRoyaltyToRatchet`'s door is two addresses —
     * `ConfigA.collectionAddr`, and the generators collection once `inviteSet` — so it
     * is sent with the numbers collection as `from`. There is no `sendRoyaltyToRatchet`
     * on the wrapper (nothing off-chain ever sends this op; the collection does), so the
     * body is built here, as `RoyaltySplit.spec.ts` already does.
     */
    const earlyRoyalty = () =>
        blockchain.sendMessage(internal({
            from: collection.address,
            to: ledger.address,
            value: EARLY_ROYALTY + toNano('0.05'), // the handler asserts amount + RATCHET_HOP_GAS
            body: beginCell()
                .storeUint(LEDGER.royalty_to_ratchet, 32)
                .storeUint(0, 64)
                .storeCoins(EARLY_ROYALTY)
                .endCell(),
        }));

    const seed = () =>
        ledger.sendGenesisSeed(genesisScript.getSender(),
            { seedT: SEED_T, seedS: SEED_S, seedHead: SEED_HEAD, value: toNano('0.2') });

    it('seeds a ledger a stranger already pushed T off zero, instead of throwing 104 forever', async () => {
        const grief = await earlyRoyalty();
        expect(grief.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ledger.getFloorNum()).toBe(EARLY_ROYALTY); // T is no longer virgin

        const r = await seed();
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        // `+=`, not `=`: the royalty is still backing the floor after genesis.
        expect(await ledger.getFloorNum()).toBe(EARLY_ROYALTY + SEED_T);
        expect(await ledger.getFloorDen()).toBe(SEED_S);
    });

    it('closes D-26 — T = seedT + swapped + pending — across the griefed seed', async () => {
        await earlyRoyalty();
        await seed();
        const seedT = await ledger.getSeedT();
        // The royalty was forwarded to the ratchet by the same handler that credited
        // `T`, so it lands in `pending` and must NOT be added to `seedT` as well.
        expect(seedT).toBe(SEED_T);
        expect(seedT + (await ratchet.getSwapped()) + (await ratchet.getPending()))
            .toBe(await ledger.getFloorNum());
    });

    it('still lets genesis run exactly once — the flag is meters.genesisSeeded, not T', async () => {
        await earlyRoyalty();
        await seed();
        const denAfterFirst = await ledger.getFloorDen();

        const second = await seed();
        expect(second.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 104 });
        expect(second.transactions).toHaveTransaction({ to: ledger.address, aborted: true });
        expect(await ledger.getFloorDen()).toBe(denAfterFirst);
    });

    it('still walks the head to the first composite and marks 2 and 3 (D-20, §6 point 1)', async () => {
        await earlyRoyalty();
        await seed();
        expect(await ledger.getHead()).toBe(SEED_HEAD);
        expect(await ledger.getPrimesCount()).toBe(2); // π(4) — 2 and 3, verified by MR
    });
});
