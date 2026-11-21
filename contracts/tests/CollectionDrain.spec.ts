import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger, FactorEntry } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';

const MINT_PRICE = toNano('1.05');

/**
 * GAUNTLET V1.2 — the collection must not pay for a mint out of its own balance.
 *
 * `primes_collection.tolk`'s `MintItem` arm used to send `msg.mintValue` under
 * `SEND_MODE_REGULAR`. The incoming message added `ITEM_DEPLOY_VALUE` to the
 * collection's balance and the send took the same figure straight back out — so the
 * collection funded this transaction's compute gas AND the deploy message's forward
 * fee (which carries the item's entire code cell in `stateInit`, so it is not small)
 * from its OWN balance, on every mint, with no income on any path. Measured here at
 * 549,869-589,602 nanoton per mint against the 0.5 TON genesis endowment
 * (`genesisPipeline.ts:822`): empty at roughly 900 mints, and from that point EVERY
 * `MintItem` bounces.
 *
 * That matters because of what a bounced `MintItem` costs. Since V1 the ledger
 * correctly does not roll `head` back (no value is safe against the race with other
 * players' mints), so the number is orphaned behind the head permanently, and the
 * minter's 1 TON has already gone out through the split. V1.1 filed that as a rare
 * event worth a new reclaim mechanic. It was not rare — it was scheduled, and this is
 * its cause.
 *
 * The fix is a send mode, not a new constant and not more TON: carry the incoming
 * value, so gas and forward fee come out of what the ledger already attached and the
 * item is endowed with the remainder. This suite is the regression — it asserts the
 * collection's balance is EXACTLY unchanged across consecutive head mints, which is
 * the only reading that distinguishes "carried" from "cheap".
 */
describe("GAUNTLET V1.2 — the collection does not fund mints from its own balance", () => {
    const codes: Record<string, Cell> = {};
    beforeAll(async () => {
        for (const n of ['PrimesItem','PrimesCollection','PrimesJettonWallet','PrimesJettonMaster','PrimesLedger','PrimesRatchet','PrimesRegistrar']) {
            codes[n] = await compile(n);
        }
    }, 300_000);

    it('holds its balance EXACTLY across consecutive head mints', async () => {
        const blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        const deployer = await blockchain.treasury('deployer');
        const genesisScript = await blockchain.treasury('genesisScript');
        const treasuryWallet = await blockchain.treasury('treasury');
        const player = await blockchain.treasury('player', { balance: toNano('5000') });

        const collection = blockchain.openContract(PrimesCollection.createFromConfig(
            { nextIndex: 2n, itemCode: codes['PrimesItem'], ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address },
            codes['PrimesCollection']));
        // The REAL genesis endowment (genesisPipeline.ts:822), not a test-fixture 5 TON.
        await collection.sendDeploy(deployer.getSender(), toNano('0.5'));

        const master = blockchain.openContract(PrimesJettonMaster.createFromConfig(
            { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode: codes['PrimesJettonWallet'] },
            codes['PrimesJettonMaster']));
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        const ledger = blockchain.openContract(PrimesLedger.createFromConfig({
            a: { collectionAddr: collection.address, jettonMasterAddr: master.address, treasuryAddr: treasuryWallet.address,
                 itemCode: codes['PrimesItem'] },
            b: { genesisScriptAddr: genesisScript.address }, seedHead: 4n, seedPrimes: [2n, 3n],
        }, codes['PrimesLedger']));
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));

        const ratchet = blockchain.openContract(PrimesRatchet.createFromConfig({
            venueTimelockAddr: deployer.address, genesisScriptAddr: genesisScript.address,
            dedustNativeVault: deployer.address, dedustPool: deployer.address, primesJettonVault: deployer.address,
        }, codes['PrimesRatchet']));
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        const registrar = blockchain.openContract(PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, codes['PrimesRegistrar']));
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));

        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await registrar.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await ledger.sendSetSinks(genesisScript.getSender(), { ratchetAddr: ratchet.address, registrarAddr: registrar.address, value: toNano('0.05') });
        await collection.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSetLedger(genesisScript.getSender(), { ledgerAddr: ledger.address, value: toNano('0.05') });
        await master.sendSealAuthority(genesisScript.getSender(), { value: toNano('0.05') });
        await ledger.sendGenesisSeed(genesisScript.getSender(), { seedT: toNano('1000'), seedS: 1_200_000_000_000_000n, seedHead: 4n, value: toNano('0.2') });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });

        const bal = async () => (await blockchain.getContract(collection.address)).balance;
        console.log(`[drain] after genesis+ignite: ${await bal()}`);

        // Composite head mints. seedHead 4; heads walk 4,6,8,9,10,12,...
        const composites: [bigint, FactorEntry[]][] = [
            [4n,  [{ prime: 2n, exponent: 2, s: 1n }]],
            [6n,  [{ prime: 2n, exponent: 1, s: 1n }, { prime: 3n, exponent: 1, s: 1n }]],
            [8n,  [{ prime: 2n, exponent: 3, s: 1n }]],
            [9n,  [{ prime: 3n, exponent: 2, s: 1n }]],
            [10n, [{ prime: 2n, exponent: 1, s: 1n }, { prime: 5n, exponent: 1, s: 2n }]],
            [12n, [{ prime: 2n, exponent: 2, s: 1n }, { prime: 3n, exponent: 1, s: 1n }]],
        ];
        const opening = await bal();
        let prev = opening;
        for (const [n, factors] of composites) {
            const r = await ledger.sendMint(player.getSender(), { n, kind: 0, factors, referralKey: 0, beneficiary: null, value: MINT_PRICE });
            // Real proof the mint landed: the collection actually deployed the item.
            const itemAddr = await ledger.getItemAddress(n);
            expect(r.transactions).toHaveTransaction({ from: collection.address, to: itemAddr, deploy: true, success: true });
            const now = await bal();
            const head = await ledger.getHead();
            console.log(`[drain] mint n=${n}: balance ${now}  delta ${now - prev}  head->${head}`);
            // EXACTLY zero, not "small". A tolerance here would pass the old code too,
            // just more slowly, and slowly is the whole failure mode.
            expect({ n, delta: now - prev }).toEqual({ n, delta: 0n });
            prev = now;
        }
        expect(await bal()).toBe(opening);
        console.log(`[drain] opening ${opening}; after ${composites.length} mints ${await bal()}`);
    }, 300_000);
});
