// TON PRIMES — venue timelock (docs/phase3-report.md §7 item 2; the entire
// admin surface of the protocol, engineering-spec.md §4.9/§6).
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';

const TIMELOCK_DELAY = 2592000; // 30 days
const VOTE_DURATION = 86400; // primes_treasury.tolk's one-day vote, which the stand-in governor mimics

describe('TON PRIMES — venue timelock', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let treasuryWallet: SandboxContract<TreasuryContract>;
    let proposer: SandboxContract<TreasuryContract>;
    /** D-194 key 2. A wallet stands in for the treasury; `VenueGovernance.spec.ts` runs the real one. */
    let governor: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let dedustVault: SandboxContract<TreasuryContract>;
    let dedustPool: SandboxContract<TreasuryContract>;
    let primesJettonVault: SandboxContract<TreasuryContract>;
    let newVault: SandboxContract<TreasuryContract>;
    let newPool: SandboxContract<TreasuryContract>;
    let newJettonVault: SandboxContract<TreasuryContract>;

    let itemCode: Cell;
    let collectionCode: Cell;
    let walletCode: Cell;
    let masterCode: Cell;
    let ledgerCode: Cell;
    let ratchetCode: Cell;
    let registrarCode: Cell;
    let timelockCode: Cell;

    let collection: SandboxContract<PrimesCollection>;
    let master: SandboxContract<PrimesJettonMaster>;
    let ledger: SandboxContract<PrimesLedger>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let registrar: SandboxContract<PrimesRegistrar>;
    let timelock: SandboxContract<PrimesVenueTimelock>;

    beforeAll(async () => {
        itemCode = await compile('PrimesItem');
        collectionCode = await compile('PrimesCollection');
        walletCode = await compile('PrimesJettonWallet');
        masterCode = await compile('PrimesJettonMaster');
        ledgerCode = await compile('PrimesLedger');
        ratchetCode = await compile('PrimesRatchet');
        registrarCode = await compile('PrimesRegistrar');
        timelockCode = await compile('PrimesVenueTimelock');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        treasuryWallet = await blockchain.treasury('treasury');
        proposer = await blockchain.treasury('proposer');
        governor = await blockchain.treasury('governor');
        attacker = await blockchain.treasury('attacker');
        dedustVault = await blockchain.treasury('dedustVault');
        dedustPool = await blockchain.treasury('dedustPool');
        primesJettonVault = await blockchain.treasury('primesJettonVault');
        newVault = await blockchain.treasury('newVault');
        newPool = await blockchain.treasury('newPool');
        newJettonVault = await blockchain.treasury('newJettonVault');

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

        // Deploy the timelock BEFORE the ledger so the ledger's (fixed at deploy)
        // venueTimelockAddr can point at the real contract. The timelock's
        // own `ledgerAddr` field is bootstrapped afterward via SetLedger (D11 —
        // the same circular-dependency pattern D7 already solved for the
        // collection/jetton-master <-> ledger relationship).
        timelock = blockchain.openContract(
            PrimesVenueTimelock.createFromConfig(
                {
                    proposerAddr: proposer.address,
                    governanceAddr: governor.address,
                    ratchetAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                },
                timelockCode
            )
        );
        await timelock.sendDeploy(deployer.getSender(), toNano('5'));

        ledger = blockchain.openContract(
            PrimesLedger.createFromConfig(
                {
                    a: {
                        collectionAddr: collection.address,
                        jettonMasterAddr: master.address,
                        treasuryAddr: treasuryWallet.address,
                        itemCode,
                    },
                    b: {
                        genesisScriptAddr: genesisScript.address,
                    },
                },
                ledgerCode
            )
        );
        await ledger.sendDeploy(deployer.getSender(), toNano('10'));

        // ---- §3.4 B1 decomposition -------------------------------------------
        // `pending` / flush() / the DeDust leg live on the RATCHET now, and the
        // ranks + naming on the REGISTRAR. Both have a circular address
        // dependency with the ledger, so both are deployed without it and linked
        // one-shot (SetLedger x2, then SetSinks). Until SetSinks lands the ledger
        // throws 233 on every mint rather than stranding pool backing.
        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: timelock.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: dedustVault.address,
                    dedustPool: dedustPool.address,
                    primesJettonVault: dedustPool.address,
                },
                ratchetCode
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));
        registrar = blockchain.openContract(
            PrimesRegistrar.createFromConfig({ genesisScriptAddr: genesisScript.address }, registrarCode)
        );
        await registrar.sendDeploy(deployer.getSender(), toNano('5'));
        await ratchet.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: ledger.address,
            value: toNano('0.05'),
        });
        await registrar.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: ledger.address,
            value: toNano('0.05'),
        });
        await ledger.sendSetSinks(genesisScript.getSender(), {
            ratchetAddr: ratchet.address,
            registrarAddr: registrar.address,
            value: toNano('0.05'),
        });
        // ----------------------------------------------------------------------

        // D11 bootstrap: resolve the timelock<->ratchet circular address
        // dependency now that both are deployed and both addresses are known.
        // §3.4: the timelock's one admin action is `update_venue`, and the venue
        // lives with flush() on the ratchet now. Its target is the RATCHET.
        await timelock.sendSetRatchet(genesisScript.getSender(), { ratchetAddr: ratchet.address, value: toNano('0.05') });
    });

    /**
     * D-194: the passed LP vote, as the treasury would send it, naming the queued record's seq.
     * Audit H1: the earliest vote the timelock accepts — opened `eta − VOTE_DURATION`, closed at `eta`.
     * (A real treasury could only execute it after `closes`; the stand-in sends it early so the
     * timelock's own ordering checks below stay testable.)
     */
    async function confirm() {
        const q = await timelock.getQueued();
        const r = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: q.seq,
            voteOpens: q.eta - VOTE_DURATION,
            voteCloses: q.eta,
            value: toNano('0.05'),
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        return r;
    }

    it('rejects queue from a non-proposer sender', async () => {
        const result = await timelock.sendQueue(attacker.getSender(), {
            dedustNativeVault: newVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta: blockchain.now! + TIMELOCK_DELAY + 10,
            value: toNano('0.05'),
        });
        expect(result.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 800 });
    });

    it('rejects an eta below the 30-day minimum delay', async () => {
        const result = await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta: blockchain.now! + 100, // far short of 30 days
            value: toNano('0.05'),
        });
        expect(result.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 801 });
    });

    it('rejects execute before eta matures, and rejects execute with nothing queued', async () => {
        const noQueue = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.05') });
        expect(noQueue.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 802 });

        const eta = blockchain.now! + TIMELOCK_DELAY + 10;
        await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta,
            value: toNano('0.05'),
        });
        const early = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.05') });
        expect(early.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 801 });
    });

    it('queue -> confirm -> wait 30 days -> permissionless execute updates the ratchet venue addresses', async () => {
        const eta = blockchain.now! + TIMELOCK_DELAY + 10;
        await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta,
            value: toNano('0.05'),
        });

        // §9.1 — BEFORE the eta, a reader sees every address `execute` will
        // write, the record's seq and whether the LP vote has confirmed it.
        const pending = await timelock.getQueued();
        expect(pending.hasQueued).toBe(1);
        expect(pending.fired).toBe(0);
        expect(pending.seq).toBe(1);
        expect(pending.confirmed).toBe(0);
        expect(pending.dedustNativeVault.toString()).toBe(newVault.address.toString());
        await confirm();
        expect((await timelock.getQueued()).confirmed).toBe(1);
        const stakingBefore = await ratchet.getStakingVenue();
        const harvestBefore = await ratchet.getHarvestDest();

        blockchain.now = eta; // matured

        const venueBefore = await ratchet.getVenue();
        expect(venueBefore.dedustNativeVault.toString()).toBe(dedustVault.address.toString());

        // Executed by `attacker` on purpose: execute is PERMISSIONLESS
        // (engineering-spec §6) -- anyone may trigger a matured, queued change.
        const result = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });
        expect(result.transactions).toHaveTransaction({ to: timelock.address, success: true });
        expect(result.transactions).toHaveTransaction({ from: timelock.address, to: ratchet.address, success: true });

        const venueAfter = await ratchet.getVenue();
        expect(venueAfter.dedustNativeVault.toString()).toBe(newVault.address.toString());
        expect(venueAfter.dedustPool.toString()).toBe(newPool.address.toString());
        expect(venueAfter.primesJettonVault.toString()).toBe(newJettonVault.address.toString());
        // D-194 — INVERTED from D-151: the staking venue is deploy data, and a
        // venue change cannot move it or the harvest destination.
        const stakingAfter = await ratchet.getStakingVenue();
        expect(stakingAfter.tonstakersPool.toString()).toBe(stakingBefore.tonstakersPool.toString());
        expect(stakingAfter.dedustTstonVault.toString()).toBe(stakingBefore.dedustTstonVault.toString());
        expect(stakingAfter.dedustTstonPool.toString()).toBe(stakingBefore.dedustTstonPool.toString());
        expect((await ratchet.getHarvestDest()).toString()).toBe(harvestBefore.toString());

        // GAUNTLET.md B30. THIS ASSERTION IS INVERTED FROM WHAT IT SAID BEFORE, and
        // the old text is the finding: it read "hasQueued stays 1 ... so this actually
        // re-executes (idempotent on the ledger side)" and asserted `success: true`.
        // That documented the defect as behaviour. `execute` was a permissionless,
        // unlimited re-send of `update_venue` -- anyone could spend this contract's gas
        // re-firing a settled change, each one a real transaction an auditor has to
        // explain, and it duplicated `retry_update_venue` while skipping that arm's
        // whole precondition. Idempotence on the ratchet's side is not a licence to
        // send; it only means the damage was bounded.
        const second = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });
        expect(second.transactions).toHaveTransaction({
            to: timelock.address,
            success: false,
            exitCode: 802, // timelock_nothing_queued -- nothing UNFIRED to execute
        });
        // And nothing went out: a refused execute is not a quiet no-op, it sends no
        // `update_venue` at all. That is the property the old test could not state.
        expect(second.transactions).not.toHaveTransaction({ from: timelock.address, to: ratchet.address });
        const venueStill = await ratchet.getVenue();
        expect(venueStill.dedustNativeVault.toString()).toBe(newVault.address.toString());
    });

    it('B30: a PENDING change cannot be silently overwritten — the advertised delay is the product', async () => {
        const first = newVault.address;
        await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: first,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta: blockchain.now! + TIMELOCK_DELAY + 10,
            value: toNano('0.05'),
        });
        // Watchers have now reviewed `first`. A second queue before the eta would
        // replace what they reviewed with something they have not seen, at the same
        // eta -- which is the one thing a timelock exists to prevent.
        const over = await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newJettonVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta: blockchain.now! + TIMELOCK_DELAY + 10,
            value: toNano('0.05'),
        });
        expect(over.transactions).toHaveTransaction({
            to: timelock.address,
            success: false,
            exitCode: 803, // timelock_already_queued -- declared since the contract was written, thrown by nothing until B30
        });
        expect((await timelock.getQueued()).dedustNativeVault.toString()).toBe(first.toString());
    });

    it('B30: withdrawing with cancel frees the slot — the refusal is not a deadlock', async () => {
        await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newJettonVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta: blockchain.now! + TIMELOCK_DELAY + 10,
            value: toNano('0.05'),
        });
        await timelock.sendCancel(proposer.getSender(), { value: toNano('0.05') });
        const replacement = newPool.address;
        const again = await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: replacement,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta: blockchain.now! + TIMELOCK_DELAY + 10,
            value: toNano('0.05'),
        });
        expect(again.transactions).toHaveTransaction({ to: timelock.address, success: true });
        expect((await timelock.getQueued()).dedustNativeVault.toString()).toBe(replacement.toString());
    });

    it('proposer can cancel a queued change before it matures', async () => {
        const eta = blockchain.now! + TIMELOCK_DELAY + 10;
        await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta,
            value: toNano('0.05'),
        });
        const cancel = await timelock.sendCancel(proposer.getSender(), { value: toNano('0.05') });
        expect(cancel.transactions).toHaveTransaction({ to: timelock.address, success: true });

        blockchain.now = eta;
        const execAfterCancel = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.05') });
        expect(execAfterCancel.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 802 });

        const venue = await ratchet.getVenue();
        expect(venue.dedustNativeVault.toString()).toBe(dedustVault.address.toString()); // unchanged
    });

    it('rejects cancel/queue from a non-proposer, and cancel with nothing queued', async () => {
        const cancelWrongSender = await timelock.sendCancel(attacker.getSender(), { value: toNano('0.05') });
        expect(cancelWrongSender.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 800 });

        const cancelNothing = await timelock.sendCancel(proposer.getSender(), { value: toNano('0.05') });
        expect(cancelNothing.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 802 });
    });

    it('retry_update_venue re-sends after a fired execute, permissionlessly, without a new wait', async () => {
        const eta = blockchain.now! + TIMELOCK_DELAY + 10;
        await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta,
            value: toNano('0.05'),
        });
        await confirm();
        blockchain.now = eta;
        await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });

        const retry = await timelock.sendRetryUpdateVenue(attacker.getSender(), { value: toNano('0.1') });
        expect(retry.transactions).toHaveTransaction({ to: timelock.address, success: true });
        expect(retry.transactions).toHaveTransaction({ from: timelock.address, to: ratchet.address, success: true });
    });

    it('retry_update_venue is caller-funded: under 0.03 TON throws 103, a funded repeat costs the timelock nothing', async () => {
        const eta = blockchain.now! + TIMELOCK_DELAY + 10;
        await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newVault.address,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta,
            value: toNano('0.05'),
        });
        await confirm();
        blockchain.now = eta;
        await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });

        const short = await timelock.sendRetryUpdateVenue(attacker.getSender(), { value: toNano('0.02') });
        expect(short.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 103 });
        const before = (await blockchain.getContract(timelock.address)).balance;
        for (let i = 0; i < 3; i++) {
            const r = await timelock.sendRetryUpdateVenue(attacker.getSender(), { value: toNano('0.05') });
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            expect(r.transactions).toHaveTransaction({ from: timelock.address, to: ratchet.address, success: true });
        }
        expect((await blockchain.getContract(timelock.address)).balance).toBeGreaterThanOrEqual(before);
    });

    it('rejects retry_update_venue before anything has ever been executed', async () => {
        const retry = await timelock.sendRetryUpdateVenue(attacker.getSender(), { value: toNano('0.05') });
        expect(retry.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 802 });
    });

    // -----------------------------------------------------------------------
    // D-194 — two keys: the proposer queues, the LP vote confirms.
    // -----------------------------------------------------------------------

    async function queueNew(vault = newVault.address) {
        const eta = blockchain.now! + TIMELOCK_DELAY + 10;
        const r = await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: vault,
            dedustPool: newPool.address,
            primesJettonVault: newJettonVault.address,
            eta,
            value: toNano('0.05'),
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        return eta;
    }

    it('D-194: publishes both keys', async () => {
        const k = await timelock.getKeys();
        expect(k.proposerAddr.toString()).toBe(proposer.address.toString());
        expect(k.governanceAddr.toString()).toBe(governor.address.toString());
    });

    it('D-194: execute is refused (804) without confirmation, even after the eta', async () => {
        const eta = await queueNew();
        blockchain.now = eta + 1;
        const r = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });
        expect(r.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 804 });
        expect(r.transactions).not.toHaveTransaction({ from: timelock.address, to: ratchet.address });
        expect((await ratchet.getVenue()).dedustNativeVault.toString()).toBe(dedustVault.address.toString());
        expect((await timelock.getQueued()).fired).toBe(0);
    });

    it('D-194: the eta is still checked first — a confirmed record before its eta throws 801', async () => {
        await queueNew();
        await confirm();
        const r = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });
        expect(r.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 801 });
    });

    it('D-194: confirm_venue from anyone but governance is refused (805) — the proposer included', async () => {
        await queueNew();
        const { seq, queuedAt, eta } = await timelock.getQueued();
        for (const who of [attacker, proposer]) {
            const r = await timelock.sendConfirmVenue(who.getSender(), {
                seq,
                voteOpens: queuedAt,
                voteCloses: eta,
                value: toNano('0.05'),
            });
            expect(r.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 805 });
        }
        expect((await timelock.getQueued()).confirmed).toBe(0);
    });

    it('D-194: a stale seq is refused (806), and so is a confirm with nothing queued', async () => {
        const none = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: 0,
            voteOpens: 0,
            voteCloses: 0,
            value: toNano('0.05'),
        });
        expect(none.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 806 });
        await queueNew();
        const { seq, queuedAt, eta } = await timelock.getQueued();
        const stale = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: seq + 1,
            voteOpens: queuedAt,
            voteCloses: eta,
            value: toNano('0.05'),
        });
        expect(stale.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 806 });
        expect((await timelock.getQueued()).confirmed).toBe(0);
    });

    it('a vote that opened before its record was queued is refused (807) — seq is predictable, the addresses were not', async () => {
        // The attack: open "confirm seq N+1" while nothing is queued, pass it
        // unopposed, then have the proposer fill N+1 in. The vote's `opens`
        // predates the record, so it voted on a number, not on these addresses.
        blockchain.now = 1_800_000_000;
        const voteOpens = blockchain.now;
        blockchain.now = voteOpens + 60;
        await queueNew();
        const q = await timelock.getQueued();
        expect(q.queuedAt).toBe(voteOpens + 60);
        const early = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: q.seq,
            voteOpens,
            voteCloses: q.eta,
            value: toNano('0.05'),
        });
        expect(early.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 807 });
        expect((await timelock.getQueued()).confirmed).toBe(0);
        // The same second as the queue is the boundary: the addresses are public for the whole vote.
        const onTime = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: q.seq,
            voteOpens: q.queuedAt,
            voteCloses: q.eta,
            value: toNano('0.05'),
        });
        expect(onTime.transactions).not.toHaveTransaction({ aborted: true });
        expect((await timelock.getQueued()).confirmed).toBe(1);
    });

    it('audit H1: a vote that closed before the eta is refused (808) — it opened before holders had the notice', async () => {
        // The attack: queue, open the confirm vote in the same block, pass it with a dust
        // lock. Only LP locked before a vote opens counts (treasury 1202), so nobody could
        // lock in response. `voteCloses >= eta` is `voteOpens >= eta − voteDuration`.
        await queueNew();
        const q = await timelock.getQueued();
        const sameBlock = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: q.seq,
            voteOpens: q.queuedAt,
            voteCloses: q.queuedAt + VOTE_DURATION,
            value: toNano('0.05'),
        });
        expect(sameBlock.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 808 });
        // One second short of the boundary is still refused…
        const oneShort = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: q.seq,
            voteOpens: q.eta - VOTE_DURATION - 1,
            voteCloses: q.eta - 1,
            value: toNano('0.05'),
        });
        expect(oneShort.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 808 });
        expect((await timelock.getQueued()).confirmed).toBe(0);
        // …and a vote opened in the final window (closing exactly at the eta) confirms.
        await confirm();
        expect((await timelock.getQueued()).confirmed).toBe(1);
    });

    it('D-194: cancel + requeue invalidates a prior confirmation — new seq, unconfirmed, old seq refused', async () => {
        await queueNew();
        const q1 = await timelock.getQueued();
        await confirm();
        expect((await timelock.getQueued()).confirmed).toBe(1);

        await timelock.sendCancel(proposer.getSender(), { value: toNano('0.05') });
        const eta = await queueNew(newJettonVault.address);
        const q2 = await timelock.getQueued();
        expect(q2.seq).toBe(q1.seq + 1);
        expect(q2.confirmed).toBe(0);

        // The vote on the old record cannot confirm the new one.
        const old = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: q1.seq,
            voteOpens: q2.queuedAt,
            voteCloses: q2.eta,
            value: toNano('0.05'),
        });
        expect(old.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 806 });
        blockchain.now = eta;
        const r = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });
        expect(r.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 804 });
    });

    it('D-194: after confirm + eta, execute fires exactly once; a fired record cannot be confirmed again', async () => {
        const eta = await queueNew();
        await confirm();
        blockchain.now = eta;
        const r = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: timelock.address, to: ratchet.address, success: true });
        expect((await ratchet.getVenue()).dedustNativeVault.toString()).toBe(newVault.address.toString());

        const again = await timelock.sendExecute(attacker.getSender(), { value: toNano('0.1') });
        expect(again.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 802 });
        expect(again.transactions).not.toHaveTransaction({ from: timelock.address, to: ratchet.address });

        const fired = await timelock.getQueued();
        const reconfirm = await timelock.sendConfirmVenue(governor.getSender(), {
            seq: fired.seq,
            voteOpens: fired.queuedAt,
            voteCloses: fired.eta,
            value: toNano('0.05'),
        });
        expect(reconfirm.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 806 });
    });
});
