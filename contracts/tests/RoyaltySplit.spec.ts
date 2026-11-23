import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import params from '../../shared/params.json';
import { LEDGER } from '../../shared/opcodes';

/**
 * DECISIONS.md D-128 / GAUNTLET W1 -- the TEP-66 secondary royalty splits.
 *
 * Two claims, and they fail independently:
 *
 *   1. A royalty arriving with a TEXT COMMENT splits instead of BOUNCING. That was a
 *      live defect before the split existed at all: the collection's catch-all arm was
 *      `assert (in.body.isEmpty()) throw 101`, and a comment is the most ordinary thing
 *      a marketplace attaches to a payout. A bounced royalty is money the project never
 *      receives, in either half.
 *   2. The split is CLOSED and the ratchet's half is BACKING. `ratchetShare +
 *      operatorShare` is exactly what was available at every amount including dust,
 *      because the arithmetic is D-114's -- one multiplication, one subtraction -- and
 *      the ratchet's half reaches the LEDGER as `T += amount` with `S` UNTOUCHED, which
 *      is what makes a royalty a pure floor step rather than a dilution (the same two
 *      effects `clearing_cleared` has, CONCEPT.md section 5).
 *
 * The bps is imported from `shared/params.json` and never retyped: CLAUDE.md rule 3.
 */
const RATCHET_BPS = BigInt(params.fees.royalty_ratchet_bps);
const BPS_DEN = 10_000n;
/** `ROYALTY_FORWARD_GAS` in both collections -- the whole three-hop delivery. */
const FORWARD_GAS = toNano('0.02');
/** `ROYALTY_STORAGE_FLOOR` in both collections -- the genesis endowment, reserved. */
const STORAGE_FLOOR = toNano('0.5');

describe('D-128 -- the secondary royalty splits between the operator and the ratchet', () => {
    const codes: Record<string, Cell> = {};
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let operator: SandboxContract<TreasuryContract>;
    let venue: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<PrimesCollection>;
    let ledger: SandboxContract<PrimesLedger>;

    beforeAll(async () => {
        for (const n of ['PrimesItem', 'PrimesCollection', 'PrimesJettonWallet', 'PrimesJettonMaster',
                         'PrimesLedger', 'PrimesRatchet', 'PrimesRegistrar']) {
            codes[n] = await compile(n);
        }
    }, 300_000);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        operator = await blockchain.treasury('operator');
        venue = await blockchain.treasury('venue', { balance: toNano('100') });
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
            b: { genesisScriptAddr: genesisScript.address }, seedHead: 4n, seedPrimes: [2n, 3n],
        }, codes['PrimesLedger']));
        await ledger.sendDeploy(deployer.getSender(), toNano('20'));

        const ratchet = blockchain.openContract(PrimesRatchet.createFromConfig({
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
        await ledger.sendGenesisSeed(genesisScript.getSender(), { seedT: toNano('1000'), seedS: 1_200_000_000_000_000n, seedHead: 4n, value: toNano('0.2') });
    });

    // `p_f = T / S` (CONCEPT.md section 5): `getFloorNum` IS `T`, `getFloorDen` IS `S`.
    // The ledger publishes the floor as its two terms rather than as a ratio, so these
    // are the reads that say whether a royalty added BACKING or added SUPPLY.
    const comment = (text: string) => beginCell().storeUint(0, 32).storeStringTail(text).endCell();

    /** Whatever a marketplace actually sends: a plain transfer with a comment on it. */
    const payRoyalty = (value: bigint, body: Cell) =>
        venue.send({ to: collection.address, value, body, bounce: true });

    it('hands a marketplace the COLLECTION as the TEP-66 destination, not the operator', async () => {
        const rp = await collection.getRoyaltyParams();
        expect(rp.numerator).toBe(Number(params.fees.royalty_numerator));
        expect(rp.denominator).toBe(Number(params.fees.royalty_denominator));
        // TEP-66 carries ONE destination, so a two-way split has to happen at the
        // address that is declared -- which is why it is this contract.
        expect(rp.destination.equals(collection.address)).toBe(true);
        expect(rp.destination.equals(operator.address)).toBe(false);
    });

    it('splits a royalty that carries a TEXT COMMENT instead of bouncing it (the live defect)', async () => {
        const r = await payRoyalty(toNano('2'), comment('GetGems royalty payout'));
        // The thing that used to happen and must not: throw 101, money home again.
        expect(r.transactions).not.toHaveTransaction({ from: collection.address, to: venue.address, inMessageBounced: true });
        expect(r.transactions).toHaveTransaction({ from: collection.address, to: ledger.address, success: true });
        expect(r.transactions).toHaveTransaction({ from: collection.address, to: operator.address, success: true });
    });

    it('splits closed, credits T and leaves S untouched -- a royalty is a pure floor step', async () => {
        const sBefore = await ledger.getFloorDen();
        const tBefore = await ledger.getFloorNum();
        const opBefore = (await blockchain.getContract(operator.address)).balance;
        const balBefore = (await blockchain.getContract(collection.address)).balance;

        const paid = toNano('2');
        await payRoyalty(paid, comment('royalty'));

        // What the arm had to work with, recomputed from the same three figures the
        // contract uses -- so this asserts the ARITHMETIC, not a number copied out of a
        // passing run.
        const net = balBefore + paid - STORAGE_FLOOR - FORWARD_GAS;
        const operatorShare = (net * (BPS_DEN - RATCHET_BPS)) / BPS_DEN;
        const ratchetShare = net - operatorShare;
        expect(operatorShare + ratchetShare).toBe(net);   // closed at every amount, including dust

        // `T` rises by EXACTLY the ratchet's half -- not "about". The ledger asserts the
        // message really carried the money, so a mismatch here is the floor being
        // inflated against backing that never arrived.
        expect((await ledger.getFloorNum()) - tBefore).toBe(ratchetShare);
        // ...and `S` does not move at all. This is the half that makes it a FLOOR STEP:
        // `donate_floor` would have minted PRIMES here and raised `S`.
        expect(await ledger.getFloorDen()).toBe(sBefore);

        // The operator's half lands, less the forward fee that leg pays for itself.
        const opGain = (await blockchain.getContract(operator.address)).balance - opBefore;
        expect(opGain).toBeGreaterThan(0n);
        expect(opGain).toBeLessThanOrEqual(operatorShare);

        // The floor is RESERVED, not spent: the collection keeps its rent endowment.
        expect((await blockchain.getContract(collection.address)).balance).toBeGreaterThanOrEqual(STORAGE_FLOOR);
    });

    it('lets a royalty too small for three hops accumulate instead of burning it on gas', async () => {
        // THE ARM SWEEPS THE BALANCE ABOVE THE FLOOR, not this message's own value --
        // which is exactly what makes accumulation work, and what this case is about.
        // So the collection has to be AT the floor first: one real royalty takes
        // everything above it (including the surplus the deploy and the `SetLedger`
        // bootstrap left there), and only then is a dust payment genuinely alone.
        await payRoyalty(toNano('2'), comment('sweep to the floor'));
        const tBefore = await ledger.getFloorNum();
        const r = await payRoyalty(toNano('0.001'), comment('dust'));
        // Nothing forwarded...
        expect(r.transactions).not.toHaveTransaction({ from: collection.address, to: ledger.address });
        expect(await ledger.getFloorNum()).toBe(tBefore);
        // ...and nothing thrown either. The money waits on a contract with no withdraw
        // path, and the next royalty above the threshold sweeps it.
        expect(r.transactions).not.toHaveTransaction({ from: collection.address, to: venue.address, inMessageBounced: true });
    });

    // GAUNTLET W7. D-128 divides 50/50, but it divides the NET -- the balance above the
    // storage floor LESS `ROYALTY_FORWARD_GAS`, which the three-hop delivery genuinely
    // costs. At section 3.1's 5% rate that skim is 40% of the royalty on a 1 GRAM resale
    // and 4% on a 10 GRAM one, so the split a holder EXPERIENCES is not the nominal
    // figure, and section 9.1 forbids printing a number a reader cannot recompute.
    // `getRoyaltySplit()` is what makes it recomputable from chain state.
    it('W7: publishes the REALISED split, so no surface has to quote the nominal one', async () => {
        const cold = await collection.getRoyaltySplit();
        expect(cold.toRatchetNanoton).toBe(0n);
        expect(cold.toOperatorNanoton).toBe(0n);
        expect(cold.forwards).toBe(0);

        const balBefore = (await blockchain.getContract(collection.address)).balance;
        const paid = toNano('2');
        await payRoyalty(paid, comment('royalty'));

        // Recomputed from the same three figures the contract uses, exactly as the
        // arithmetic case above does -- never copied out of a passing run.
        const net = balBefore + paid - STORAGE_FLOOR - FORWARD_GAS;
        const operatorShare = (net * (BPS_DEN - RATCHET_BPS)) / BPS_DEN;
        const ratchetShare = net - operatorShare;

        const hot = await collection.getRoyaltySplit();
        expect(hot.toRatchetNanoton).toBe(ratchetShare);
        expect(hot.toOperatorNanoton).toBe(operatorShare);
        expect(hot.forwards).toBe(1);

        // THE POINT OF THE ITEM, asserted rather than described: the delivery cost is
        // recoverable from `forwards`, and what a holder can compute from this call is
        // therefore the split they actually got, gross of nothing.
        expect(hot.forwards * Number(FORWARD_GAS)).toBe(Number(FORWARD_GAS));
        expect(hot.toRatchetNanoton + hot.toOperatorNanoton).toBe(net);
    });

    it('W7: a royalty too small to forward moves no counter', async () => {
        // The accumulation case above proves the money waits. This proves the FIGURE
        // waits with it -- counting an arrival that forwarded nothing would report a
        // realised split against a delivery that never happened.
        await payRoyalty(toNano('2'), comment('sweep to the floor'));
        const before = await collection.getRoyaltySplit();
        expect(before.forwards).toBe(1);
        await payRoyalty(toNano('0.001'), comment('dust'));
        const after = await collection.getRoyaltySplit();
        expect(after.forwards).toBe(1);
        expect(after.toRatchetNanoton).toBe(before.toRatchetNanoton);
        expect(after.toOperatorNanoton).toBe(before.toOperatorNanoton);
    });

    it('G81: an operator leg below one hop waits with the ratchet leg, and the trace stays green', async () => {
        await payRoyalty(toNano('2'), comment('sweep to the floor'));
        const before = await collection.getRoyaltySplit();
        // Sized so the NET is 0.001 GRAM: the operator half is 0.0005 — a bare credit
        // below one hop, which (sent) could land `skipped (no_gas)`. Read the balance
        // first: the last forward leaves some gas margin above the floor.
        const bal = (await blockchain.getContract(collection.address)).balance;
        const small = await payRoyalty(STORAGE_FLOOR + FORWARD_GAS + toNano('0.001') - bal, comment('small'));
        expect(small.transactions).not.toHaveTransaction({ from: collection.address, to: ledger.address });
        expect(small.transactions).not.toHaveTransaction({ aborted: true });
        expect((await collection.getRoyaltySplit()).forwards).toBe(before.forwards);
        // the next royalty sweeps both waiting halves out, green
        const next = await payRoyalty(toNano('0.01'), comment('next'));
        expect(next.transactions).toHaveTransaction({ from: collection.address, to: ledger.address, success: true });
        expect(next.transactions).not.toHaveTransaction({ aborted: true });
        const after = await collection.getRoyaltySplit();
        expect(after.forwards).toBe(before.forwards + 1);
        expect(after.toOperatorNanoton - before.toOperatorNanoton).toBeGreaterThanOrEqual(toNano('0.001'));
    });

    it('refuses the ledger op from a sender that is not one of the two collections', async () => {
        const stranger = await blockchain.treasury('stranger', { balance: toNano('100') });
        const r = await stranger.send({
            to: ledger.address,
            value: toNano('5'),
            bounce: true,
            body: beginCell().storeUint(LEDGER.royalty_to_ratchet, 32).storeUint(0, 64).storeCoins(toNano('1')).endCell(),
        });
        expect(r.transactions).toHaveTransaction({ to: ledger.address, success: false, exitCode: 100 });
    });
});
