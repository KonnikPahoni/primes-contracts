// TON PRIMES — D-194: a venue change needs TWO keys, end to end with the REAL treasury.
//
// The venue timelock's proposer queues; the governed treasury's LP electorate confirms
// by a passed venue-confirm proposal (asset 3: `amount` = the timelock record's `seq`,
// `dest` = the timelock); only then does the permissionless `execute` re-point the
// ratchet's flush venue. `PrimesVenueTimelock.spec.ts` covers the timelock's own
// refusals with a wallet standing in for the treasury; this file runs the real one.
//
// Audit H1 (2026-11-19): the confirming vote must CLOSE at or after the record's
// `eta` (808) — open no earlier than `eta − VOTE_DURATION` — because only LP locked
// before a vote opens counts (1202). Opened at the end of the notice, the vote can be
// opposed by anyone who locked during it; opened at `queue` time, by nobody new.
//
// Every step asserts the TRACE, never a balance (MISTAKES.md 2026-09-17).
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesTreasury, TreasuryAsset, TREASURY_VENUE_CONFIRM_GAS, depositPayload } from '../wrappers/PrimesTreasury';
import { PrimesLpPosition } from '../wrappers/PrimesLpPosition';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import { PrimesRatchet, FLUSH_VALUE } from '../wrappers/PrimesRatchet';
import params from '../../shared/params.json';

const TIMELOCK_DELAY = 2592000;
// Two parameters, read from params.json: the treasury's NOTICE (D-173 amendment
// 2026-11-19, audit R2-H1) and its vote length. Equal today by coincidence only.
const VOTE_DURATION = params.treasury.vote_duration_seconds;
const NOTICE = params.treasury.notice_duration_seconds;
const T0 = 1800000000;
const FORWARD = toNano('0.5');
const STAKE_STANDIN = Address.parse('0:' + '5a'.repeat(32));

describe('D-194 — venue governance: proposer key + LP vote', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let proposer: SandboxContract<TreasuryContract>;
    let whale: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let lpWallet: SandboxContract<TreasuryContract>;
    let oldVault: SandboxContract<TreasuryContract>;
    let newVault: SandboxContract<TreasuryContract>;

    let codes: Record<string, Cell>;
    let treasury: SandboxContract<PrimesTreasury>;
    let timelock: SandboxContract<PrimesVenueTimelock>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let child: SandboxContract<PrimesLpPosition>;

    beforeAll(async () => {
        codes = {
            treasury: await compile('PrimesTreasury'),
            position: await compile('PrimesLpPosition'),
            timelock: await compile('PrimesVenueTimelock'),
            ratchet: await compile('PrimesRatchet'),
        };
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = T0 - 1;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        proposer = await blockchain.treasury('proposer');
        whale = await blockchain.treasury('whale');
        stranger = await blockchain.treasury('stranger');
        lpWallet = await blockchain.treasury('lpWallet');
        oldVault = await blockchain.treasury('oldVault');
        newVault = await blockchain.treasury('newVault');
        const operator = await blockchain.treasury('operator');
        const sink = await blockchain.treasury('lpSink');
        const primesWallet = await blockchain.treasury('primesWallet');
        const tstonWallet = await blockchain.treasury('tstonWallet');

        // The genesis order (genesisPipeline.ts): treasury, then the timelock that
        // names it as governance, then the ratchet that names the timelock.
        treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: operator.address,
                    sinkAddr: sink.address,
                    stakeAddr: STAKE_STANDIN,
                    distributionRateBpsPerDay: params.staking.distribution_rate_bps_per_day,
                    positionCode: codes.position,
                    genesisScriptAddr: genesisScript.address,
                },
                codes.treasury
            )
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('100'));
        await treasury.sendSetWallets(genesisScript.getSender(), {
            lpJettonWallet: lpWallet.address,
            primesJettonWallet: primesWallet.address,
            tstonJettonWallet: tstonWallet.address,
            value: toNano('0.1'),
        });

        timelock = blockchain.openContract(
            PrimesVenueTimelock.createFromConfig(
                {
                    proposerAddr: proposer.address,
                    governanceAddr: treasury.address,
                    ratchetAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                },
                codes.timelock
            )
        );
        await timelock.sendDeploy(deployer.getSender(), toNano('1'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: timelock.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: oldVault.address,
                    dedustPool: oldVault.address,
                    primesJettonVault: oldVault.address,
                },
                codes.ratchet
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('1'));
        await timelock.sendSetRatchet(genesisScript.getSender(), { ratchetAddr: ratchet.address, value: toNano('0.05') });

        // The electorate: one 6-month LP position, locked before any proposal opens
        // (§5.5.5), then the clock steps to T0.
        await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('1000'),
            from: whale.address,
            value: FORWARD,
            forwardPayload: depositPayload(2),
        });
        blockchain.now = T0;
        child = blockchain.openContract(
            PrimesLpPosition.createFromConfig({ owner: whale.address, treasuryAddr: treasury.address }, codes.position)
        );
    });

    async function queue() {
        const eta = blockchain.now! + TIMELOCK_DELAY + 10;
        const r = await timelock.sendQueue(proposer.getSender(), {
            dedustNativeVault: newVault.address,
            dedustPool: newVault.address,
            primesJettonVault: newVault.address,
            eta,
            value: toNano('0.05'),
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        return { eta, seq: (await timelock.getQueued()).seq };
    }

    /**
     * Audit H1 + R2-H1: the earliest a confirming proposal may be PROPOSED. Its vote
     * opens a treasury notice later, at `eta − VOTE_DURATION`, and closes exactly at the eta.
     */
    function toFinalWindow(eta: number) {
        blockchain.now = eta - NOTICE - VOTE_DURATION;
    }

    /**
     * Propose venue-confirm proposal #0 naming timelock record `timelockSeq` NOW, wait out
     * the treasury's notice, optionally vote it yes, and step past its close. `inNotice` runs
     * while the proposal is public and not yet votable; `between` while the vote is open.
     */
    async function propose(
        timelockSeq: number,
        voteYes: boolean,
        between?: () => Promise<void>,
        inNotice?: () => Promise<void>
    ) {
        const p = await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.VENUE,
            amount: BigInt(timelockSeq),
            dest: timelock.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(p.transactions).not.toHaveTransaction({ aborted: true });
        if (inNotice) await inNotice();
        const { opens, closes } = await treasury.getProposal(0);
        blockchain.now = opens; // read off chain: the first second a vote is accepted
        if (voteYes) {
            const v = await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
            expect(v.transactions).not.toHaveTransaction({ aborted: true });
        }
        if (between) await between();
        blockchain.now = closes + 1;
    }

    it('queue -> LP vote in the final window -> treasury execute confirms after the eta -> timelock execute re-points the ratchet', async () => {
        const { eta, seq } = await queue();
        // Audit H1: the vote opens at the boundary, `eta − VOTE_DURATION`, and closes at the eta.
        toFinalWindow(eta);
        await propose(seq, true);
        // The treasury can execute only after `closes`, so the confirm lands AFTER the eta —
        // and the timelock's `execute` needs nothing earlier.
        expect(blockchain.now!).toBeGreaterThan(eta);

        const row = await treasury.getProposal(0);
        // Proposed a notice before the final window: the VOTE is what 808 measures.
        expect(row.opens).toBe(eta - VOTE_DURATION);
        expect(row.closes).toBe(eta);
        expect(row.asset).toBe(TreasuryAsset.VENUE);
        expect(row.amount).toBe(BigInt(seq));
        expect(row.dest!.toString()).toBe(timelock.address.toString());
        // D-194: moves no value, so only the vote and the window decide.
        expect(await treasury.getExecutable(0)).toEqual({ executable: true, reason: 0, cap: 0n, available: 0n });

        // Under-funded: the executor pays the hop to the timelock.
        const short = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('0.02') });
        expect(short.transactions).toHaveTransaction({ to: treasury.address, success: false, exitCode: 103 });

        const tonBefore = (await treasury.getTreasuryBalances()).tonBalance;
        const exec = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: TREASURY_VENUE_CONFIRM_GAS });
        expect(exec.transactions).not.toHaveTransaction({ aborted: true });
        expect(exec.transactions).toHaveTransaction({ from: treasury.address, to: timelock.address, success: true });
        expect((await treasury.getProposal(0)).executed).toBe(1);
        expect((await treasury.getExecutable(0)).reason).toBe(1159); // treasury_already_executed
        expect((await treasury.getTreasuryBalances()).tonBalance).toBe(tonBefore);

        const q = await timelock.getQueued();
        expect(q.confirmed).toBe(1);
        expect(q.seq).toBe(seq);

        const fire = await timelock.sendExecute(stranger.getSender(), { value: toNano('0.1') });
        expect(fire.transactions).not.toHaveTransaction({ aborted: true });
        expect(fire.transactions).toHaveTransaction({ from: timelock.address, to: ratchet.address, success: true });
        const v = await ratchet.getVenue();
        expect(v.dedustNativeVault.toString()).toBe(newVault.address.toString());
        expect(v.dedustPool.toString()).toBe(newVault.address.toString());
        expect(v.primesJettonVault.toString()).toBe(newVault.address.toString());
    });

    it('audit R2-M1: the REAL execute hop with a flush open — the change lands, the old vault still settles the trip, and the redelivery is harmless', async () => {
        // The attack as it was run: `flush`, then the timelock's permissionless
        // `execute`, back to back. A wallet stands in for the ledger so `pending` exists.
        await ratchet.sendSetLedger(genesisScript.getSender(), { ledgerAddr: deployer.address, value: toNano('0.05') });
        await ratchet.sendPoolInject(deployer.getSender(), {
            amount: toNano('100'),
            tSnapshot: toNano('100'),
            sSnapshot: toNano('1000000'),
            value: toNano('100.01'),
        });
        const { eta, seq } = await queue();
        toFinalWindow(eta);
        await propose(seq, true);
        await treasury.sendExecute(stranger.getSender(), { seq: 0, value: TREASURY_VENUE_CONFIRM_GAS });
        expect((await timelock.getQueued()).confirmed).toBe(1);

        const pendingBefore = await ratchet.getPending();
        const flush = await ratchet.sendFlush(stranger.getSender(), { value: FLUSH_VALUE });
        expect(flush.transactions).toHaveTransaction({ from: ratchet.address, to: oldVault.address, success: true });
        const inFlight = await ratchet.getInFlightFlush();
        expect(inFlight).toBe(toNano('20')); // FLUSH_PCT of 100

        const fire = await timelock.sendExecute(stranger.getSender(), { value: toNano('0.1') });
        expect(fire.transactions).not.toHaveTransaction({ aborted: true });
        expect(fire.transactions).toHaveTransaction({ from: timelock.address, to: ratchet.address, success: true });
        expect((await ratchet.getVenue()).dedustNativeVault.toString()).toBe(newVault.address.toString());
        const pin = await ratchet.getFlushReplyVenue();
        expect(pin.pinned).toBe(true);
        expect(pin.dedustNativeVault.toString()).toBe(oldVault.address.toString());
        expect(pin.primesJettonVault.toString()).toBe(oldVault.address.toString());

        // `retry_update_venue` is permissionless and repeatable: a redelivery mid-flight
        // must not re-pin the trip to the NEW venue.
        const retry = await timelock.sendRetryUpdateVenue(stranger.getSender(), { value: toNano('0.1') });
        expect(retry.transactions).not.toHaveTransaction({ aborted: true });
        expect((await ratchet.getFlushReplyVenue()).dedustNativeVault.toString()).toBe(oldVault.address.toString());

        const refund = await oldVault.send({
            to: ratchet.address,
            value: inFlight,
            bounce: false,
            body: beginCell().storeUint(0x474f86cf, 32).storeUint(0, 64).storeUint(0, 1).endCell(),
        });
        expect(refund.transactions).not.toHaveTransaction({ aborted: true });
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await ratchet.getSwapped()).toBe(0n);
        expect((await ratchet.getFlushReplyVenue()).pinned).toBe(false);
    });

    it('a venue-confirm proposal nobody voted for cannot execute (1160), and the timelock stays unconfirmed', async () => {
        const { eta, seq } = await queue();
        toFinalWindow(eta);
        await propose(seq, false);
        expect((await treasury.getExecutable(0)).reason).toBe(1160); // treasury_vote_failed
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('0.05') });
        expect(r.transactions).toHaveTransaction({ to: treasury.address, success: false, exitCode: 1160 });
        expect(r.transactions).not.toHaveTransaction({ from: treasury.address, to: timelock.address });

        expect(blockchain.now!).toBeGreaterThanOrEqual(eta);
        const fire = await timelock.sendExecute(stranger.getSender(), { value: toNano('0.1') });
        expect(fire.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 804 });
        expect((await ratchet.getVenue()).dedustNativeVault.toString()).toBe(oldVault.address.toString());
    });

    it('a vote opened BEFORE its record was queued cannot confirm it (807) — the pre-voted seq attack', async () => {
        // seq is predictable: the next queue gets queueSeq + 1. A vote opened on
        // it while nothing is queued passes unopposed (one yes, no quorum), and
        // the proposer fills the record in afterwards.
        const predicted = (await timelock.getQueued()).seq + 1;
        await propose(predicted, true);
        const { seq } = await queue();
        expect(seq).toBe(predicted);
        expect((await treasury.getExecutable(0)).executable).toBe(true);

        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: TREASURY_VENUE_CONFIRM_GAS });
        expect(r.transactions).toHaveTransaction({ from: treasury.address, to: timelock.address, exitCode: 807 });
        expect(r.transactions).toHaveTransaction({
            from: timelock.address,
            to: treasury.address,
            inMessageBounced: true,
            success: true,
        });
        expect((await timelock.getQueued()).confirmed).toBe(0);
    });

    it('a stale seq bounces off the timelock (806) and resets `executed`; the bounce itself does not abort', async () => {
        const { seq } = await queue();
        await propose(seq + 7, true);
        expect((await treasury.getExecutable(0)).executable).toBe(true);

        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('0.05') });
        expect(r.transactions).toHaveTransaction({ from: treasury.address, to: timelock.address, exitCode: 806 });
        expect(r.transactions).toHaveTransaction({
            from: timelock.address,
            to: treasury.address,
            inMessageBounced: true,
            success: true,
        });
        // The ONE aborted transaction is the timelock's refusal; nothing on the way back.
        const aborted = r.transactions.filter((t) => (t.description as any).aborted === true);
        expect(aborted.map((t) => t.inMessage!.info.dest!.toString())).toEqual([timelock.address.toString()]);

        expect((await treasury.getProposal(0)).executed).toBe(0);
        expect((await treasury.getExecutable(0)).executable).toBe(true);
        expect((await timelock.getQueued()).confirmed).toBe(0);
    });
    /** The bounce of a refused confirm: the timelock aborted with `code`, the treasury reset `executed`. */
    async function expectRefusedConfirm(code: number) {
        expect((await treasury.getExecutable(0)).executable).toBe(true);
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: TREASURY_VENUE_CONFIRM_GAS });
        expect(r.transactions).toHaveTransaction({ from: treasury.address, to: timelock.address, exitCode: code });
        expect(r.transactions).toHaveTransaction({
            from: timelock.address,
            to: treasury.address,
            inMessageBounced: true,
            success: true,
        });
        expect((await treasury.getProposal(0)).executed).toBe(0);
        expect((await timelock.getQueued()).confirmed).toBe(0);
    }

    it('audit H1 regression: a vote opened right after `queue` cannot confirm (808), so the eta passes unexecutable', async () => {
        // The attack: queue and open the confirm vote together. Only positions that already
        // existed could vote no (1202), so the 30-day notice gave holders nothing to act on.
        const { eta, seq } = await queue();
        await propose(seq, true);
        await expectRefusedConfirm(808); // timelock_vote_before_notice_end

        blockchain.now = eta;
        const fire = await timelock.sendExecute(stranger.getSender(), { value: toNano('0.1') });
        expect(fire.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 804 });
        expect((await ratchet.getVenue()).dedustNativeVault.toString()).toBe(oldVault.address.toString());
    });

    it('audit H1: one second before the final window is still too early (808)', async () => {
        const { eta, seq } = await queue();
        blockchain.now = eta - NOTICE - VOTE_DURATION - 1;
        await propose(seq, true);
        expect((await treasury.getProposal(0)).closes).toBe(eta - 1);
        await expectRefusedConfirm(808);
    });

    it('R2-H1: a proposal written BEFORE the queue whose vote opens after it clears 807 and is still refused 808', async () => {
        // The treasury's notice means `voteOpens` is no longer the moment the proposal
        // was written, so 807 alone no longer says the record existed when it was
        // proposed. 808 does the work: the vote must close at or after the eta.
        const predicted = (await timelock.getQueued()).seq + 1;
        let queuedAt = 0;
        await propose(predicted, true, undefined, async () => {
            blockchain.now = blockchain.now! + 10; // inside the proposal's notice
            const { seq } = await queue();
            expect(seq).toBe(predicted);
            queuedAt = (await timelock.getQueued()).queuedAt;
        });
        expect((await treasury.getProposal(0)).opens).toBeGreaterThanOrEqual(queuedAt); // 807 holds
        await expectRefusedConfirm(808);
    });

    it('R2-H1: a holder who locks LP during the confirm proposal notice votes no and blocks the change', async () => {
        const { eta, seq } = await queue();
        const holder = await blockchain.treasury('holder-notice');
        const holderChild = blockchain.openContract(
            PrimesLpPosition.createFromConfig({ owner: holder.address, treasuryAddr: treasury.address }, codes.position)
        );
        toFinalWindow(eta);
        await propose(
            seq,
            true,
            async () => {
                const no = await holderChild.sendVote(holder.getSender(), { seq: 0, support: false, positionId: 0, value: FORWARD });
                expect(no.transactions).not.toHaveTransaction({ aborted: true });
            },
            async () => {
                // The proposal is public and its vote has not opened: lock now.
                blockchain.now = blockchain.now! + 60;
                const dep = await treasury.sendTransferNotification(lpWallet.getSender(), {
                    amount: toNano('20000'),
                    from: holder.address,
                    value: FORWARD,
                    forwardPayload: depositPayload(0),
                });
                expect(dep.transactions).not.toHaveTransaction({ aborted: true });
            }
        );
        const row = await treasury.getProposal(0);
        expect(row.no).toBeGreaterThan(row.yes);
        expect((await treasury.getExecutable(0)).reason).toBe(1160); // treasury_vote_failed
        const fire = await timelock.sendExecute(stranger.getSender(), { value: toNano('0.1') });
        expect(fire.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 804 });
        expect((await ratchet.getVenue()).dedustNativeVault.toString()).toBe(oldVault.address.toString());
    });

    it('audit H1: a holder who locks LP AFTER the queue, before the vote opens, can vote no and block the change', async () => {
        const { eta, seq } = await queue();
        // A day into the notice, a holder who had no position when the change was queued
        // locks LP at the 30-day tier — enough weight to outvote the whale's 10× six-month
        // position (1000 × 10 < 20000 × 1).
        blockchain.now = T0 + 86400;
        const holder = await blockchain.treasury('holder');
        const dep = await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('20000'),
            from: holder.address,
            value: FORWARD,
            forwardPayload: depositPayload(0),
        });
        expect(dep.transactions).not.toHaveTransaction({ aborted: true });
        const holderChild = blockchain.openContract(
            PrimesLpPosition.createFromConfig({ owner: holder.address, treasuryAddr: treasury.address }, codes.position)
        );

        toFinalWindow(eta);
        await propose(seq, true, async () => {
            // The holder's weight predates `opens`, so 1202 lets it vote.
            const no = await holderChild.sendVote(holder.getSender(), { seq: 0, support: false, positionId: 0, value: FORWARD });
            expect(no.transactions).not.toHaveTransaction({ aborted: true });
        });
        const row = await treasury.getProposal(0);
        expect(row.no).toBeGreaterThan(row.yes);
        expect((await treasury.getExecutable(0)).reason).toBe(1160); // treasury_vote_failed

        const fire = await timelock.sendExecute(stranger.getSender(), { value: toNano('0.1') });
        expect(fire.transactions).toHaveTransaction({ to: timelock.address, success: false, exitCode: 804 });
        expect((await ratchet.getVenue()).dedustNativeVault.toString()).toBe(oldVault.address.toString());
    });
});
