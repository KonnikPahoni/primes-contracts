import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesItem } from '../wrappers/PrimesItem';
import { LEDGER as LEDGER_OPS, REGISTRAR as REGISTRAR_OPS, REBATE_KIND } from '../../shared/opcodes';
import { scoreOf, scoreOfFrom } from '../../shared/score';

/**
 * D-26 (§5) and D-36 (§4.7, §7) — the two things the launch fix plan's W3 and W4
 * add to the ledger, proved on chain rather than argued about.
 *
 * W3, `seedT`. §5's backing identity has THREE terms:
 *
 *     T = seeded + swapped + pending
 *
 * `swapped` and `pending` live on the ratchet; `seeded` is the founder capital
 * §6 point 3 credits straight into `T`, which backs `S` from the DeDust LP and
 * never passes through the ratchet's `pending`. Before D-26 that term was
 * assigned into `T` and then unrecoverable, so the live dashboard's two-term
 * check reported a permanent false gap of exactly the seed. The fix is a
 * storage field and a get-method — never a reader that rounds the gap away,
 * which the signed decision explicitly forbids.
 *
 * W4, the era trophy. The era DIVIDEND is dropped from the design; the trophy is
 * built. The single highest recruiter of an era takes permanent naming rights
 * over that era's primorial, and the era bounty continues to pay 100% to the
 * primorial's MINTER — two people, two rewards, no arithmetic shared.
 *
 * What is under test here, specifically:
 *   - the era-scoped counter increments on the ACTIVATION edge (§4.6's φ₁ — the
 *     recruit's own first mint), not on the claim;
 *   - the running max tracks the leader without a scan, and its TIE-BREAK is
 *     earliest-to-reach-the-count (a strict `>` on the contract);
 *   - the ceremony writes naming rights to that leader on the registrar and
 *     resets the era counter for everyone in the same transaction;
 *   - the era bounty is still one undivided message naming the minter.
 */

const MINT_PRICE = toNano('1');

/**
 * The head opens at a composite well below a primorial so there is room for
 * several activations before the ceremony. `seedHead: 22` walks 2..21, marking
 * 2, 3, 5, 7, 11, 13, 17, 19 as primes, and leaves the head on 22.
 *
 * From there the composites are 22, 24, 25, 26, 27, 28 and then 30 — the era
 * boundary. Six mints to arrange the leaderboard with, and the seventh is the
 * ceremony.
 */
const OPENING_HEAD = 22n;
const ERA_BOUNDARY = 30n;

const SEED_T = toNano('200');
const SEED_S = 4_000_000_000_000_000n;

describe('TON PRIMES — D-26 seedT and D-36 the era trophy', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let vaultStub: SandboxContract<TreasuryContract>;
    let marketStub: SandboxContract<TreasuryContract>;

    let recruiterA: SandboxContract<TreasuryContract>;
    let recruiterB: SandboxContract<TreasuryContract>;
    let gifteeA1: SandboxContract<TreasuryContract>;
    let gifteeB1: SandboxContract<TreasuryContract>;
    let gifteeB2: SandboxContract<TreasuryContract>;
    let gifteeA2: SandboxContract<TreasuryContract>;
    let bystander: SandboxContract<TreasuryContract>;

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

    /**
     * D-106: nothing is seeded any more. The era tally is fed by the RECRUIT
     * EDGE — a §4.5 gift mint to an address `minterState` has never seen — which
     * is an ordinary transaction any wallet can send, so the recruits in this
     * suite are made rather than planted. That also deletes the two-pass deploy
     * this file used to need (seed records naming addresses that only exist once
     * the chain does).
     */
    async function deployStack() {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        vaultStub = await blockchain.treasury('vaultStub');
        marketStub = await blockchain.treasury('marketStub');
        recruiterA = await blockchain.treasury('recruiterA');
        recruiterB = await blockchain.treasury('recruiterB');
        gifteeA1 = await blockchain.treasury('gifteeA1');
        gifteeB1 = await blockchain.treasury('gifteeB1');
        gifteeB2 = await blockchain.treasury('gifteeB2');
        gifteeA2 = await blockchain.treasury('gifteeA2');
        bystander = await blockchain.treasury('bystander');

        // D-212: the collection fixes the registrar as the one non-item sender of
        // `naming_paid` (a trophy re-engraving's fee), so the registrar is computed first.
        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, registrarCode)
        );
        collection = blockchain.openContract(
            PrimesCollection.createFromConfig(
                {
                    nextIndex: 2n,
                    itemCode,
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    registrarAddr: registrar.address,
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
                    dedustNativeVault: deployer.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                },
                ratchetCode
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        await registrar.sendDeploy(deployer.getSender(), toNano('5'));
        await registrar.sendSetCollection(genesisScript.getSender(), { collectionAddr: collection.address, value: toNano('0.05') });

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
            seedT: SEED_T,
            seedS: SEED_S,
            seedHead: OPENING_HEAD,
            value: toNano('0.2'),
        });
        // The bounty vault is a treasury stub: this suite reads the ceremony's
        // OUTBOUND message rather than the vault's payout, because what W4 has
        // to prove about the bounty is that the ledger still sends it whole and
        // still names the minter — the vault's own schedule is its file's job.
        await ledger.sendSetPeers(genesisScript.getSender(), {
            marketAddr: marketStub.address,
            bountyVaultAddr: vaultStub.address,
            value: toNano('0.05'),
        });
        await ledger.sendIgnite(genesisScript.getSender(), { owner: deployer.address, value: toNano('0.3') });
    }

    /**
     * Mint whatever the head currently is, as the given wallet.
     *
     * `to` is §4.5's beneficiary, and since D-106 naming one is the ONLY way to
     * move the era tally: a gift to an address the ledger has never seen is a
     * recruit for the payer. Omit it for an ordinary self-mint.
     */
    async function mintHead(
        who: SandboxContract<TreasuryContract>,
        to?: SandboxContract<TreasuryContract>
    ) {
        const n = await ledger.getHead();
        const prime = isPrime(n);
        const r = await ledger.sendMint(who.getSender(), {
            n,
            kind: prime ? 1 : 0,
            factors: prime ? [] : factorize(n),
            referralKey: 0,
            beneficiary: to ? to.address : null,
            value: MINT_PRICE + toNano('0.1'),
        });
        const after = await ledger.getHead();
        if (after <= n) {
            const failed = r.transactions.filter((t) => (t as any).description?.computePhase?.exitCode ?? 0);
            throw new Error(
                `mintHead(${n}) did not advance the head (still ${after}). ` +
                    `Exit codes: ${JSON.stringify(failed.map((t) => (t as any).description?.computePhase?.exitCode))}`
            );
        }
        return { n, result: r };
    }

    /** Walk the head to `target`, bounded, with mints nobody in this file cares about. */
    async function advanceHeadTo(target: bigint) {
        for (let guard = 0; guard < 40; guard++) {
            const head = await ledger.getHead();
            if (head >= target) return;
            await mintHead(bystander);
        }
        throw new Error(`advanceHeadTo(${target}) never got there (head ${await ledger.getHead()})`);
    }

    /** Every opcode the ledger sent, so a ceremony's legs can be counted. */
    function opcodesTo(result: any, dest: Address): number[] {
        return result.transactions
            .flatMap((t: any) => t.outMessages?.values?.() ?? [])
            .filter((m: any) => m.info?.dest && Address.isAddress(m.info.dest) && m.info.dest.equals(dest))
            .map((m: any) => {
                const s = m.body.beginParse();
                return s.remainingBits >= 32 ? s.loadUint(32) : 0;
            });
    }

    function bodiesTo(result: any, dest: Address, opcode: number): any[] {
        return result.transactions
            .flatMap((t: any) => t.outMessages?.values?.() ?? [])
            .filter((m: any) => m.info?.dest && Address.isAddress(m.info.dest) && m.info.dest.equals(dest))
            .map((m: any) => m.body.beginParse())
            .filter((s: any) => s.remainingBits >= 32 && s.preloadUint(32) === opcode);
    }

    // ------------------------------------------------------------------ //
    // W3 — D-26, the `seeded` term
    // ------------------------------------------------------------------ //

    describe('D-26 (§5): T = seedT + swapped + pending, as exact bigints', () => {
        beforeEach(async () => {
            await deployStack();
        });

        it('records the genesis seed in its own field, readable by getSeedT', async () => {
            expect(await ledger.getSeedT()).toBe(SEED_T);
            // The seed is credited into T as well — the field is a RECORD of the
            // same TON, not a second pool. `ignite` has already run, so T has
            // moved past the seed by Unity's injection; the seed itself has not.
            expect(await ledger.getFloorNum()).toBeGreaterThanOrEqual(SEED_T);
        });

        it('closes the three-term identity at genesis', async () => {
            const T = await ledger.getFloorNum();
            const seeded = await ledger.getSeedT();
            const pending = await ratchet.getPending();
            const swapped = await ratchet.getSwapped();
            expect(T).toBe(seeded + swapped + pending);
        });

        it('closes the three-term identity after mints, and the seeded term never moves', async () => {
            await mintHead(bystander);
            await mintHead(bystander);
            await mintHead(bystander);

            const T = await ledger.getFloorNum();
            const seeded = await ledger.getSeedT();
            const pending = await ratchet.getPending();
            const swapped = await ratchet.getSwapped();

            expect(seeded).toBe(SEED_T);
            expect(T).toBe(seeded + swapped + pending);
            // And the thing D-26 was filed about: the TWO-term reading is off by
            // exactly the seed. This assertion is the regression — if it ever
            // starts passing as an equality, someone has closed the gap on the
            // wrong side.
            expect(T - (swapped + pending)).toBe(SEED_T);
        });
    });

    // ------------------------------------------------------------------ //
    // W4 — D-36, the era trophy
    // ------------------------------------------------------------------ //

    describe('D-36 (§4.7, §7): the era-scoped tally and its running max', () => {
        beforeEach(async () => {
            await deployStack();
        });

        it('starts an era with no leader at all', async () => {
            const { leader, recruits } = await ledger.getEraLeader();
            expect(leader).toBeNull();
            expect(recruits).toBe(0);
            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(0);
        });

        it('D-106: an ordinary self-mint is not a recruit — only a GIFT is', async () => {
            await mintHead(recruiterA);
            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(0);
            expect((await ledger.getEraLeader()).leader).toBeNull();
        });

        it('counts a gift to an address the ledger has never seen', async () => {
            await mintHead(recruiterA, gifteeA1);

            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(1);
            const { leader, recruits } = await ledger.getEraLeader();
            expect(leader!.equals(recruiterA.address)).toBe(true);
            expect(recruits).toBe(1);
        });

        it('D-106 THE SYBIL GUARD: gifting the SAME wallet again counts once', async () => {
            await mintHead(recruiterA, gifteeA1);
            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(1);

            // `minterState` has seen this address now, so the second gift is a
            // present and not a recruit. A recruit costs a FRESH address plus a
            // full 1 TON mint, which is the whole of the guard. (Past EDGE_HOLD:
            // inside it the card would refuse the gift outright.)
            blockchain.now! += 300;
            await mintHead(recruiterA, gifteeA1);
            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(1);

            // ...and a fresh one does count, so the guard is on the address and
            // not on the recruiter.
            await mintHead(recruiterA, gifteeA2);
            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(2);
        });

        it('moves the LIFETIME rank too — the two counters answer different questions', async () => {
            const before = (await ledger.getRecruitRank(recruiterA.address)).recruits;
            await mintHead(recruiterA, gifteeA1);
            // D-106 put both counters on the SAME edge. They still differ in
            // scope: the lifetime one is never reset, the era one is dropped at
            // every primorial ceremony (asserted below).
            expect((await ledger.getRecruitRank(recruiterA.address)).recruits).toBe(before + 1);
            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(1);
        });

        it('opens the giftee NEWCOMER window, and does not spend it on the gift itself', async () => {
            const w = await ledger.getNewcomerWindow(gifteeA1.address);
            expect(w.left).toBe(0);
            await mintHead(recruiterA, gifteeA1);
            // All five, not four: the mint that CREATES the window must not also
            // consume one of it.
            const after = await ledger.getNewcomerWindow(gifteeA1.address);
            expect(after.left).toBe(after.total);
        });

        // G80: `left` counts down to 0, which alone reads the same as "never gifted".
        // The `opened` bit is what the §9.4 newcomer quests read, and it must survive
        // the fifth window mint — the mint that used to un-complete them.
        it('G80: `opened` is set by the gift and stays set after all five window mints', async () => {
            expect((await ledger.getNewcomerWindow(gifteeA1.address)).opened).toBe(false);
            await mintHead(recruiterA, gifteeA1);
            expect((await ledger.getNewcomerWindow(gifteeA1.address)).opened).toBe(true);
            blockchain.now! += 300; // past the edge hold: an unresolved edge lends no window
            for (let i = 0; i < 5; i++) {
                blockchain.now! += 60; // clocked mints spend the window; k_min settlements do not
                await mintHead(gifteeA1);
            }
            const spent = await ledger.getNewcomerWindow(gifteeA1.address);
            expect(spent.left).toBe(0);
            expect(spent.opened).toBe(true);
            // a wallet never gifted still reads false
            expect((await ledger.getNewcomerWindow(gifteeB2.address)).opened).toBe(false);
        });

        it('breaks a tie in favour of the wallet that got there FIRST', async () => {
            await mintHead(recruiterA, gifteeA1); // A -> 1, leader A
            await mintHead(recruiterB, gifteeB1); // B -> 1, TIE

            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(1);
            expect(await ledger.getEraRecruits(recruiterB.address)).toBe(1);
            const tied = await ledger.getEraLeader();
            expect(tied.leader!.equals(recruiterA.address)).toBe(true);
            expect(tied.recruits).toBe(1);

            await mintHead(recruiterB, gifteeB2); // B -> 2, strictly ahead
            const ahead = await ledger.getEraLeader();
            expect(ahead.leader!.equals(recruiterB.address)).toBe(true);
            expect(ahead.recruits).toBe(2);

            await mintHead(recruiterA, gifteeA2); // A -> 2, TIE again at the top
            const retied = await ledger.getEraLeader();
            expect(retied.leader!.equals(recruiterB.address)).toBe(true);
            expect(retied.recruits).toBe(2);
            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(2);
        });
    });

    describe('D-36: the primorial ceremony', () => {
        beforeEach(async () => {
            await deployStack();
            await mintHead(recruiterA, gifteeA1); // A -> 1
            await mintHead(recruiterB, gifteeB1); // B -> 1 (tie, A still leads)
            await mintHead(recruiterB, gifteeB2); // B -> 2, the winner
            await advanceHeadTo(ERA_BOUNDARY);
            expect(await ledger.getHead()).toBe(ERA_BOUNDARY);
        });

        it('writes naming rights over the primorial to the era winner, and resets the era', async () => {
            expect((await ledger.getEraLeader()).leader!.equals(recruiterB.address)).toBe(true);
            expect((await registrar.getTrophy(ERA_BOUNDARY)).holder).toBeNull();

            await mintHead(bystander);

            const namer = (await registrar.getTrophy(ERA_BOUNDARY)).holder;
            expect(namer).not.toBeNull();
            expect(namer!.equals(recruiterB.address)).toBe(true);

            // The season ends with the ceremony: everyone back to zero.
            const after = await ledger.getEraLeader();
            expect(after.leader).toBeNull();
            expect(after.recruits).toBe(0);
            expect(await ledger.getEraRecruits(recruiterA.address)).toBe(0);
            expect(await ledger.getEraRecruits(recruiterB.address)).toBe(0);
        });

        it("keeps the trophy apart from the item — the item's pen is its owner, the trophy the winner's", async () => {
            await mintHead(bystander);
            // D-212: the primorial's ITEM is named by whoever owns it (the minter here);
            // the TROPHY is the registrar's (≤8-row) record and goes to the era winner.
            const item = blockchain.openContract(PrimesItem.createFromAddress(await ledger.getItemAddress(ERA_BOUNDARY)));
            expect((await item.getNamer())!.equals(bystander.address)).toBe(true);
            expect((await registrar.getTrophy(ERA_BOUNDARY)).holder!.equals(recruiterB.address)).toBe(true);
        });

        it('D-212: the first engraving is free, a re-engraving pays renameFee to the floor, a refusal refunds', async () => {
            await mintHead(bystander);
            const fee = await registrar.getTrophyRenameFee();
            expect(fee).toBe((await collection.getNaming()).renameFee);
            const text = (t: string) => beginCell().storeStringTail(t).endCell();
            const engrave = (who: typeof recruiterB, t: string, value: bigint) =>
                registrar.sendAnnotate(who.getSender(), { n: ERA_BOUNDARY, text: text(t), value });

            // Free, gas only; T does not move.
            const T0 = await ledger.getFloorNum();
            const S0 = await ledger.getFloorDen();
            const free = await engrave(recruiterB, 'first', toNano('0.05'));
            expect(free.transactions).not.toHaveTransaction({ aborted: true });
            expect((await registrar.getTrophyAnnotation(ERA_BOUNDARY)).count).toBe(1);
            expect(await ledger.getFloorNum()).toBe(T0);

            // A second engraving without the fee is REFUNDED, not thrown, and writes nothing.
            const short = await engrave(recruiterB, 'cheap', toNano('1'));
            expect(short.transactions).not.toHaveTransaction({ aborted: true });
            expect(short.transactions).toHaveTransaction({ from: registrar.address, to: recruiterB.address });
            expect((await registrar.getTrophyAnnotation(ERA_BOUNDARY)).count).toBe(1);

            // A stranger with the full fee is refunded too.
            const before = await bystander.getBalance();
            const stranger = await engrave(bystander, 'not mine', fee + toNano('0.1'));
            expect(stranger.transactions).not.toHaveTransaction({ aborted: true });
            expect(before - (await bystander.getBalance())).toBeLessThan(toNano('0.05'));

            // Paid: registrar -> collection -> ledger, T rises by exactly the fee, S does not.
            const regBal = (await blockchain.getContract(registrar.address)).balance;
            const paid = await engrave(recruiterB, 'second', fee + toNano('0.1'));
            expect(paid.transactions).not.toHaveTransaction({ aborted: true });
            expect(paid.transactions).toHaveTransaction({ from: collection.address, to: ledger.address, success: true });
            expect(await ledger.getFloorNum()).toBe(T0 + fee);
            expect(await ledger.getFloorDen()).toBe(S0);
            const a = await registrar.getTrophyAnnotation(ERA_BOUNDARY);
            expect(a.count).toBe(2);
            expect(a.text.beginParse().loadStringTail()).toBe('second');
            const book = await collection.getNaming();
            expect(book.renamed).toBe(1);
            expect(book.toFloor).toBe(fee);
            // The registrar keeps nothing of it (§3.4: declared liability zero).
            expect((await blockchain.getContract(registrar.address)).balance).toBeLessThanOrEqual(regBal);
        });

        it('still pays the era bounty whole, to the MINTER, in its own message', async () => {
            const { result } = await mintHead(bystander);

            const bounty = bodiesTo(result, vaultStub.address, LEDGER_OPS.pay_era_bounty);
            expect(bounty).toHaveLength(1);
            const s = bounty[0];
            s.loadUint(32); // opcode
            s.loadUint(64); // queryId
            expect(s.loadUintBig(256)).toBe(ERA_BOUNDARY);
            // 100% to the primorial's minter. Not sliced with the recruiter,
            // who is a different wallet and is paid in naming rights instead.
            expect(s.loadAddress().equals(bystander.address)).toBe(true);

            const trophy = bodiesTo(result, registrar.address, REGISTRAR_OPS.award_era_trophy);
            expect(trophy).toHaveLength(1);
            const t = trophy[0];
            t.loadUint(32);
            t.loadUint(64);
            expect(t.loadUintBig(256)).toBe(ERA_BOUNDARY);
            expect(t.loadAddress().equals(recruiterB.address)).toBe(true);
            expect(t.loadUint(32)).toBe(2); // the winning era count
        });

        it('fires exactly one trophy write, and only at the boundary', async () => {
            const before = await mintHead(bystander); // n = 30, the ceremony
            expect(opcodesTo(before.result, registrar.address).filter((o) => o === REGISTRAR_OPS.award_era_trophy))
                .toHaveLength(1);

            const next = await mintHead(bystander); // n = 32, an ordinary mint
            expect(opcodesTo(next.result, registrar.address).filter((o) => o === REGISTRAR_OPS.award_era_trophy))
                .toHaveLength(0);
        });
    });

    describe('D-36: an era nobody recruited in', () => {
        beforeEach(async () => {
            await deployStack();
            await advanceHeadTo(ERA_BOUNDARY);
        });

        it('leaves the primorial unnamed rather than inventing a winner', async () => {
            const { result } = await mintHead(bystander);
            expect(opcodesTo(result, registrar.address).filter((o) => o === REGISTRAR_OPS.award_era_trophy))
                .toHaveLength(0);
            expect((await registrar.getTrophy(ERA_BOUNDARY)).holder).toBeNull();
            // The bounty is unaffected: it has a minter either way.
            expect(bodiesTo(result, vaultStub.address, LEDGER_OPS.pay_era_bounty)).toHaveLength(1);
        });
    });

    // C15 (signed ADOPT 2026-09-24): the head-mint rebate pays per point of the
    // FACTORED score, the same D(n) `open_lot` prices an auction at. 22 = 2·11 is
    // a semiprime and squarefree, so its factored score is strictly above the
    // from-`n` lower bound — the rebate must carry the higher one.
    describe('C15: the head-mint rebate pays the factored score', () => {
        beforeEach(async () => {
            await deployStack();
        });

        it('carries scoreOfFrom(n, factors), not scoreOf(n), on a composite head mint', async () => {
            const { n, result } = await mintHead(bystander);
            expect(n).toBe(OPENING_HEAD);
            const factored = scoreOfFrom(n, factorize(n).map((f) => ({ p: f.prime, e: f.exponent }))).score;
            expect(factored).toBeGreaterThan(scoreOf(n).score);

            const rebate = bodiesTo(result, vaultStub.address, LEDGER_OPS.pay_special_number_rebate);
            expect(rebate).toHaveLength(1);
            const s = rebate[0];
            s.loadUint(32); // opcode
            s.loadUint(64); // queryId
            expect(s.loadUintBig(256)).toBe(n);
            expect(s.loadUint(8)).toBe(REBATE_KIND.COMPOSITE_PER_POINT);
            expect(s.loadUint(16)).toBe(factored);
        });
    });
});

function isPrime(n: bigint): boolean {
    if (n < 2n) return false;
    for (let i = 2n; i * i <= n; i++) {
        if (n % i === 0n) return false;
    }
    return true;
}

function factorize(n: bigint): { prime: bigint; exponent: number }[] {
    const out: { prime: bigint; exponent: number }[] = [];
    let m = n;
    for (let p = 2n; p * p <= m; p++) {
        let e = 0;
        while (m % p === 0n) {
            m /= p;
            e++;
        }
        if (e > 0) out.push({ prime: p, exponent: e });
    }
    if (m > 1n) out.push({ prime: m, exponent: 1 });
    return out;
}
