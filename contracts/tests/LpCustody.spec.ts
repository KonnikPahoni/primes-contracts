// TON PRIMES — LP CUSTODY, the vote-only half of the governed treasury.
// CONCEPT.md §5.5.3; DECISIONS.md D-100 points 4 and 9, D-147, D-168.
//
// WHAT THIS FILE EXISTS TO PROVE:
//
//   1. A DEPOSIT AND A WITHDRAWAL WORK IN EVERY ONE OF THE FOUR TIERS, and the
//      tier decides the lock term and the vote multiplier — nothing else. D-168
//      deleted the LP miner: custody earns no PRIMES.
//   2. THE TERM IS REAL. `withdraw` before `maturesAt` is refused.
//   3. RELOCK may never shorten a running term, and moves the vote weight.
//   4. THE VOTE DIES AT MATURITY without any message; `expire` is permissionless
//      bookkeeping that never decrements twice.
//   5. THE OPERATOR'S LP VOTES LIKE ANYONE'S (D-100 point 9).
//   6. TR-5 holds: `lpHeld` equals the sum of the positions.
//   7. NOTHING MINTS (TR-4) — there is no opcode for it.
//   8. The LP-move bounce arms restore the position, matured and expired.
//
// The ladders are `shared/params.json` `treasury.{vote_multipliers,
// tier_term_seconds}`; this file asserts the contract equals the wrapper's mirror.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    PrimesTreasury,
    TreasuryOpcodes,
    TREASURY_TIERS,
    TreasuryAsset,
    depositPayload,
} from '../wrappers/PrimesTreasury';
import { PrimesLpPosition } from '../wrappers/PrimesLpPosition';
import { FOREVER_POSITION_ID, FOREVER_VOTE_MULTIPLIER } from '../../shared/opcodes';
import params from '../../shared/params.json';
import { internal as sandboxInternal } from '@ton/sandbox';
import { buildPositionWithdrawMessage } from '../../shared/messages';
import { firstHop } from './helpers/inFlight';

/** Comfortable margin over the published minimums — CLAUDE.md: never the exact figure. */
const FORWARD = toNano('0.5');

type JettonOut = { amount: bigint; destination: Address; responseAddr: Address };

/** Every TEP-74 transfer this transaction chain sent to `wallet`. */
function jettonSentTo(result: { transactions: any[] }, wallet: Address): JettonOut[] {
    const out: JettonOut[] = [];
    for (const tx of result.transactions) {
        for (const m of tx.outMessages.values()) {
            if (m.info.type !== 'internal') continue;
            if (!m.info.dest.equals(wallet)) continue;
            const s = m.body.beginParse();
            if (s.remainingBits < 32) continue;
            if (s.loadUint(32) !== 0x0f8a7ea5) continue;
            s.loadUintBig(64);
            const amount = s.loadCoins();
            const destination = s.loadAddress();
            const responseAddr = s.loadAddress();
            out.push({ amount, destination, responseAddr });
        }
    }
    return out;
}

const mult = (tier: number) => BigInt(TREASURY_TIERS[tier].voteMultiplier);
const FOREVER = BigInt(FOREVER_VOTE_MULTIPLIER);

describe('LP custody (§5.5.3, D-100 points 4/9, D-147, D-168)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let operator: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let lpWallet: SandboxContract<TreasuryContract>;
    let primesWallet: SandboxContract<TreasuryContract>;
    let tstonWallet: SandboxContract<TreasuryContract>;
    let sink: SandboxContract<TreasuryContract>;
    let stake: SandboxContract<TreasuryContract>;

    let treasuryCode: Cell;
    let positionCode: Cell;
    let treasury: SandboxContract<PrimesTreasury>;

    beforeAll(async () => {
        treasuryCode = await compile('PrimesTreasury');
        positionCode = await compile('PrimesLpPosition');
    });

    function treasuryConfig(genesis: Address) {
        return {
            operatorAddr: operator.address,
            sinkAddr: sink.address,
            stakeAddr: stake.address,
            distributionRateBpsPerDay: params.staking.distribution_rate_bps_per_day,
            positionCode,
            genesisScriptAddr: genesis,
        };
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1800000000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        operator = await blockchain.treasury('operator');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');
        lpWallet = await blockchain.treasury('lpWallet');
        primesWallet = await blockchain.treasury('primesWallet');
        tstonWallet = await blockchain.treasury('tstonWallet');
        sink = await blockchain.treasury('lpSink');
        stake = await blockchain.treasury('stakeMaster');

        treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(treasuryConfig(genesisScript.address), treasuryCode)
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('10'));
        await treasury.sendSetWallets(genesisScript.getSender(), {
            lpJettonWallet: lpWallet.address,
            primesJettonWallet: primesWallet.address,
            tstonJettonWallet: tstonWallet.address,
            value: toNano('0.1'),
        });
    });

    async function deposit(who: SandboxContract<TreasuryContract>, amount: bigint, tier: number) {
        return await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount,
            from: who.address,
            value: FORWARD,
            forwardPayload: depositPayload(tier),
        });
    }

    function childOf(owner: Address) {
        return blockchain.openContract(
            PrimesLpPosition.createFromConfig({ owner, treasuryAddr: treasury.address }, positionCode)
        );
    }

    // -----------------------------------------------------------------------
    // 1. The ladders and the child address derivation.
    // -----------------------------------------------------------------------

    it('publishes the two tier ladders the wrapper mirrors', async () => {
        await deposit(alice, toNano('1'), 0);
        expect(await treasury.getVoteMultipliers()).toEqual(TREASURY_TIERS.map((t) => t.voteMultiplier));
        expect(await treasury.getTierTerms()).toEqual(TREASURY_TIERS.map((t) => t.termSeconds));
        // The child's copy is the ENFORCED one, and the two must agree.
        expect(await childOf(alice.address).getTierTerms()).toEqual(TREASURY_TIERS.map((t) => t.termSeconds));
    });

    it("derives a child's address exactly as the wrapper does — the init-data mirror", async () => {
        const derived = await treasury.getPositionAddress(alice.address);
        expect(derived.toString()).toEqual(childOf(alice.address).address.toString());
    });

    // -----------------------------------------------------------------------
    // 2. Deposit and withdraw, every tier.
    // -----------------------------------------------------------------------

    it.each(TREASURY_TIERS.map((t, i) => [i, t.label, t.voteMultiplier, t.termSeconds] as const))(
        'tier %i (%s) deposits, votes %ix, and withdraws after a %i s term',
        async (tier, _label, vm, term) => {
            const amount = toNano('100');
            const d = await deposit(alice, amount, tier);
            expect(d.transactions).not.toHaveTransaction({ aborted: true });

            expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(amount);
            expect((await treasury.getGov()).eligibleWeight).toEqual(amount * BigInt(vm));

            const child = childOf(alice.address);
            const p0 = await child.getPosition(0);
            expect(p0.amount).toEqual(amount);
            expect(p0.tier).toEqual(tier);
            expect(p0.expired).toEqual(0);
            expect(p0.maturesAt).toEqual(p0.lockedAt + term);
            expect(p0.inFlight).toEqual(0);
            expect(await child.getVoteWeight()).toEqual(amount * BigInt(vm));

            blockchain.now = 1800000000 + term + 10;
            const w = await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
            expect(w.transactions).not.toHaveTransaction({ aborted: true });
            const lpOut = jettonSentTo(w, lpWallet.address);
            expect(lpOut).toHaveLength(1);
            expect(lpOut[0].amount).toEqual(amount);
            expect(lpOut[0].destination.toString()).toEqual(alice.address.toString());
            // `responseAddr` is the OWNER on both LP-move arms (bounce recovery).
            expect(lpOut[0].responseAddr.toString()).toEqual(alice.address.toString());
            // D-168: custody earns nothing, so no PRIMES move on the way out.
            expect(jettonSentTo(w, primesWallet.address)).toHaveLength(0);

            // TR-5, and the vote weight left with the LP.
            expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(0n);
            expect((await treasury.getGov()).eligibleWeight).toEqual(0n);
            expect((await child.getPositions()).positionCount).toEqual(0);
            expect(await child.getVoteWeight()).toEqual(0n);
        }
    );

    it('refuses a withdraw while the term is still running', async () => {
        const tier = 0; // 30 days
        await deposit(alice, toNano('100'), tier);
        const child = childOf(alice.address);

        const early = await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
        expect(early.transactions).toHaveTransaction({ to: child.address, exitCode: 1166 });

        blockchain.now = 1800000000 + TREASURY_TIERS[tier].termSeconds - 60;
        const stillEarly = await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
        expect(stillEarly.transactions).toHaveTransaction({ to: child.address, exitCode: 1166 });
        expect((await child.getPositions()).positionCount).toEqual(1);
    });

    it('refuses a second withdraw while the first is in flight (1168), and one after it landed (1165)', async () => {
        const tier = 0;
        const amount = toNano('100');
        await deposit(alice, amount, tier);
        const child = childOf(alice.address);
        blockchain.now = 1800000000 + TREASURY_TIERS[tier].termSeconds + 10;

        // Only the child's own transaction: inFlight set, the WithdrawLp still queued.
        const hop = await firstHop(
            blockchain,
            sandboxInternal({ from: alice.address, to: child.address, value: FORWARD, body: buildPositionWithdrawMessage(0, 0n).body })
        );
        expect(hop.first.description.aborted).toBe(false);
        expect((await child.getPosition(0)).inFlight).toEqual(1);

        const again = await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
        expect(again.transactions).toHaveTransaction({ to: child.address, success: false, exitCode: 1168 });
        expect(again.transactions).not.toHaveTransaction({ from: child.address, to: treasury.address });

        // The first finishes clean and moves the LP once.
        const rest = await hop.rest();
        expect(rest.filter((t: any) => t.description.aborted)).toEqual([]);
        expect(jettonSentTo({ transactions: rest }, lpWallet.address)).toHaveLength(1);
        expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(0n);
        expect((await child.getPositions()).positionCount).toEqual(0);

        const third = await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
        expect(third.transactions).toHaveTransaction({ to: child.address, success: false, exitCode: 1165 });
        expect(third.transactions).not.toHaveTransaction({ from: child.address, to: treasury.address });
    });

    // -----------------------------------------------------------------------
    // 3. Relock (D-147): never shortens a running term; moves the vote weight.
    // -----------------------------------------------------------------------

    it('refuses a relock that SHORTENS a term still running, and allows one that lengthens it', async () => {
        blockchain.now = 1800000100;
        const amount = toNano('100');
        await deposit(alice, amount, 1); // 3 months
        const child = childOf(alice.address);

        const down = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 0, value: FORWARD });
        expect(down.transactions).toHaveTransaction({ to: child.address, exitCode: 1167 });
        expect((await child.getPosition(0)).tier).toEqual(1);

        blockchain.now = 1800000100 + 86400;
        const up = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 3, value: FORWARD });
        expect(up.transactions).not.toHaveTransaction({ aborted: true });
        // Fire-and-forget: the treasury moves the weight and sends nothing back.
        expect(up.transactions).toHaveTransaction({
            from: child.address,
            to: treasury.address,
            op: TreasuryOpcodes.RelockVote,
            success: true,
        });
        const p = await child.getPosition(0);
        expect(p.tier).toEqual(3);
        expect(p.lockedAt).toEqual(blockchain.now);
        expect(p.maturesAt).toEqual(blockchain.now + TREASURY_TIERS[3].termSeconds);
        expect(p.inFlight).toEqual(0);
        expect((await treasury.getGov()).eligibleWeight).toEqual(amount * mult(3));
        expect(await child.getVoteWeight()).toEqual(amount * mult(3));
        // No PRIMES move on a relock any more.
        expect(jettonSentTo(up, primesWallet.address)).toHaveLength(0);
    });

    it('allows a relock DOWN once the term has matured', async () => {
        blockchain.now = 1800000100;
        await deposit(alice, toNano('100'), 1);
        const child = childOf(alice.address);
        blockchain.now = 1800000100 + TREASURY_TIERS[1].termSeconds + 10;
        const r = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 0, value: FORWARD });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await child.getPosition(0)).tier).toEqual(0);
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('100') * mult(0));
    });

    it('refuses a relock to a tier outside the ladder (102)', async () => {
        await deposit(alice, toNano('100'), 0);
        const child = childOf(alice.address);
        const r = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 4, value: FORWARD });
        expect(r.transactions).toHaveTransaction({ to: child.address, exitCode: 102 });
    });

    it('refuses an owner-only op from anyone but the owner', async () => {
        await deposit(alice, toNano('100'), 0);
        const child = childOf(alice.address);
        const r = await child.sendToSink(bob.getSender(), { positionId: 0, value: FORWARD });
        expect(r.transactions).toHaveTransaction({ to: child.address, exitCode: 1164 });
    });

    // -----------------------------------------------------------------------
    // 4. The electorate.
    // -----------------------------------------------------------------------

    it("refunds the retired donate tag and counts the operator's LP like anyone's", async () => {
        const donated = await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('500'),
            from: deployer.address,
            value: FORWARD,
            forwardPayload: beginCell().storeUint(0x54444f4e, 32).endCell(), // "TDON"
        });
        expect(jettonSentTo(donated, lpWallet.address)).toHaveLength(1);
        expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(0n);
        expect((await treasury.getGov()).eligibleWeight).toEqual(0n);

        await deposit(operator, toNano('100'), 2);
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('100') * 10n);
        expect(await childOf(operator.address).getVoteWeight()).toEqual(toNano('100') * 10n);
    });

    it('gives vote weight amount x {1,3,10,30} to the four tiers — every tier votes', async () => {
        for (let tier = 0; tier < 4; tier++) {
            const who = await blockchain.treasury(`voter${tier}`);
            await deposit(who, toNano('40'), tier);
            expect(await childOf(who.address).getVoteWeight()).toEqual(toNano('40') * mult(tier));
        }
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('40') * 44n);
    });

    it('refuses a vote from a matured term, before anyone has expired it', async () => {
        blockchain.now = 1800000100;
        await deposit(alice, toNano('100'), 2);
        const child = childOf(alice.address);
        blockchain.now = 1800000100 + TREASURY_TIERS[2].termSeconds + 1;
        // The aggregates have not moved — and the vote is refused anyway.
        expect(await child.getVoteWeight()).toEqual(toNano('100') * 10n);
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('100') * 10n);
        const v = await child.sendVote(alice.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect(v.transactions).toHaveTransaction({ to: child.address, exitCode: 1169 });
    });

    it('lets ANYONE retire a matured term, once, and only after it has matured', async () => {
        blockchain.now = 1800000100;
        await deposit(alice, toNano('100'), 2);
        const child = childOf(alice.address);

        const early = await child.sendExpire(bob.getSender(), { positionId: 0, value: FORWARD });
        expect(early.transactions).toHaveTransaction({ to: child.address, exitCode: 1166 });

        blockchain.now = 1800000100 + TREASURY_TIERS[2].termSeconds + 1;
        const r = await child.sendExpire(bob.getSender(), { positionId: 0, value: FORWARD });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(await child.getVoteWeight()).toEqual(0n);
        expect((await treasury.getGov()).eligibleWeight).toEqual(0n);
        expect((await child.getPosition(0)).expired).toEqual(1);
        // Bookkeeping only: the LP is untouched.
        expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(toNano('100'));

        const again = await child.sendExpire(bob.getSender(), { positionId: 0, value: FORWARD });
        expect(again.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getGov()).eligibleWeight).toEqual(0n);
    });

    it('does not decrement the electorate twice when an expired term is withdrawn', async () => {
        blockchain.now = 1800000100;
        await deposit(alice, toNano('100'), 2);
        await deposit(bob, toNano('100'), 2);
        const child = childOf(alice.address);
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('200') * 10n);

        blockchain.now = 1800000100 + TREASURY_TIERS[2].termSeconds + 1;
        await child.sendExpire(bob.getSender(), { positionId: 0, value: FORWARD });
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('100') * 10n);
        await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('100') * 10n);
    });

    it('restores a retired term to the electorate when it is relocked', async () => {
        blockchain.now = 1800000100;
        await deposit(alice, toNano('100'), 2);
        const child = childOf(alice.address);
        blockchain.now = 1800000100 + TREASURY_TIERS[2].termSeconds + 1;
        await child.sendExpire(bob.getSender(), { positionId: 0, value: FORWARD });
        expect((await treasury.getGov()).eligibleWeight).toEqual(0n);

        const r = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 2, value: FORWARD });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await child.getPosition(0)).expired).toEqual(0);
        expect(await child.getVoteWeight()).toEqual(toNano('100') * 10n);
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('100') * 10n);
    });

    // -----------------------------------------------------------------------
    // 5. Sink-forward, payload rules, several positions.
    // -----------------------------------------------------------------------

    it('forwards a position to the sink with no wait', async () => {
        blockchain.now = 1800000100;
        await deposit(alice, toNano('100'), 2);
        const child = childOf(alice.address);

        blockchain.now = 1800000100 + 86400;
        const r = await child.sendToSink(alice.getSender(), { positionId: 0, value: FORWARD });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const lpOut = jettonSentTo(r, lpWallet.address);
        expect(lpOut).toHaveLength(1);
        expect(lpOut[0].destination.toString()).toEqual(sink.address.toString());
        expect(lpOut[0].responseAddr.toString()).toEqual(alice.address.toString());
        expect(jettonSentTo(r, primesWallet.address)).toHaveLength(0);

        expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(0n);
        // D-214: the row is gone, but the LP votes on as the forever total.
        expect((await child.getPositions()).positionCount).toEqual(0);
        expect(await child.getForever()).toEqual({
            amount: toNano('100'),
            since: 1800000100 + 86400,
            multiplier: FOREVER_VOTE_MULTIPLIER,
        });
        expect(await treasury.getForeverVoteMultiplier()).toEqual(FOREVER_VOTE_MULTIPLIER);
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('100') * FOREVER);
        expect(await child.getVoteWeight()).toEqual(toNano('100') * FOREVER);
    });

    it('D-214: many sinks are ONE total — the account does not grow, and each credit restamps since', async () => {
        const child = childOf(alice.address);
        for (let i = 0; i < 5; i++) {
            blockchain.now = 1800000100 + i * 1000;
            await deposit(alice, 1n, 0); // dust, the spam an attacker would send
            const r = await child.sendToSink(alice.getSender(), { positionId: i, value: FORWARD });
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
        }
        const f = await child.getForever();
        expect(f.amount).toEqual(5n);
        expect(f.since).toEqual(1800000100 + 4000);
        expect((await child.getPositions()).positionCount).toEqual(0);
        // The positions map is empty again: five sinks left one coins field behind.
        const state = (await blockchain.getContract(child.address)).accountState;
        if (state?.type !== 'active' || !state.state.data) throw new Error('child not active');
        // No refs: the positions and vote dictionaries are both empty again.
        expect(state.state.data.refs).toHaveLength(0);
        expect((await treasury.getGov()).eligibleWeight).toEqual(5n * FOREVER);
    });

    it('D-214: the forever total proposes and votes under FOREVER_POSITION_ID, and cannot be moved', async () => {
        blockchain.now = 1800000100;
        await deposit(alice, toNano('100'), 3);
        const child = childOf(alice.address);
        await child.sendToSink(alice.getSender(), { positionId: 0, value: FORWARD });

        // Not a position: no withdraw, relock, sink or expire can name it.
        for (const send of [
            () => child.sendWithdraw(alice.getSender(), { positionId: FOREVER_POSITION_ID, value: FORWARD }),
            () => child.sendRelock(alice.getSender(), { positionId: FOREVER_POSITION_ID, tier: 3, value: FORWARD }),
            () => child.sendToSink(alice.getSender(), { positionId: FOREVER_POSITION_ID, value: FORWARD }),
        ]) {
            const r = await send();
            expect(r.transactions).toHaveTransaction({ to: child.address, exitCode: 1165 });
        }

        blockchain.now = 1800000100 + 10;
        const p = await child.sendPropose(alice.getSender(), {
            asset: 0,
            amount: 1n,
            dest: bob.address,
            positionId: FOREVER_POSITION_ID,
            value: FORWARD,
        });
        expect(p.transactions).not.toHaveTransaction({ aborted: true });
        const prop = await treasury.getProposal(0);
        expect(prop.proposer?.toString()).toEqual(alice.address.toString());

        blockchain.now = prop.opens;
        const v = await child.sendVote(alice.getSender(), {
            seq: 0,
            support: true,
            positionId: FOREVER_POSITION_ID,
            value: FORWARD,
        });
        expect(v.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getProposal(0)).yes).toEqual(toNano('100') * FOREVER);
        expect(await child.getHasVoted(0, FOREVER_POSITION_ID)).toBe(true);

        // A second vote from the same total is refused by the child's own record (1155).
        const again = await child.sendVote(alice.getSender(), {
            seq: 0,
            support: true,
            positionId: FOREVER_POSITION_ID,
            value: FORWARD,
        });
        expect(again.transactions).toHaveTransaction({ to: child.address, exitCode: 1155 });
    });

    it('D-214: LP sunk after a proposal opened cannot vote yes on it — the credit restamps since', async () => {
        blockchain.now = 1800000100;
        await deposit(alice, toNano('100'), 3);
        await deposit(bob, toNano('100'), 3);
        const alices = childOf(alice.address);
        const bobs = childOf(bob.address);
        await alices.sendPropose(alice.getSender(), {
            asset: 0,
            amount: 1n,
            dest: bob.address,
            positionId: 0,
            value: FORWARD,
        });
        const prop = await treasury.getProposal(0);
        blockchain.now = prop.opens;
        // Bob votes with the TERM, then sinks it and tries again as forever weight.
        await bobs.sendVote(bob.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        await bobs.sendToSink(bob.getSender(), { positionId: 0, value: FORWARD });
        const r = await bobs.sendVote(bob.getSender(), {
            seq: 0,
            support: true,
            positionId: FOREVER_POSITION_ID,
            value: FORWARD,
        });
        expect(r.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1202 });
        expect((await treasury.getProposal(0)).yes).toEqual(toNano('100') * mult(3));
    });

    it('publishes its own (owner, treasuryAddr) pair and the nominal forward, matching deploy config', async () => {
        await deposit(alice, toNano('10'), 0);
        const child = childOf(alice.address);
        const info = await child.getPositionOwner();
        expect(info.owner.toString()).toEqual(alice.address.toString());
        expect(info.treasuryAddr.toString()).toEqual(treasury.address.toString());
        expect(await child.getPositionMinForward()).toEqual(toNano('0.2'));
        // THE MIRROR GUARD: the child's hand-copied treasury minimum against the
        // treasury's OWN published figure.
        const { treasuryMinForward } = await treasury.getTreasuryMinForward();
        expect(await child.getPositionMinForward()).toEqual(treasuryMinForward + toNano('0.05'));
    });

    it('refunds an LP transfer with an absent, unrecognised or out-of-range payload', async () => {
        const bare = await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('10'),
            from: alice.address,
            value: FORWARD,
        });
        const refunds = jettonSentTo(bare, lpWallet.address);
        expect(refunds).toHaveLength(1);
        expect(refunds[0].amount).toEqual(toNano('10'));
        expect(refunds[0].destination.toString()).toEqual(alice.address.toString());

        const wrong = await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('10'),
            from: alice.address,
            value: FORWARD,
            forwardPayload: beginCell().storeUint(0x4e4f5045, 32).endCell(),
        });
        expect(jettonSentTo(wrong, lpWallet.address)).toHaveLength(1);

        // Tiers 4..7 exist in three bits and not in the ladder (D-168: four rungs).
        for (const t of [4, 7]) {
            const bad = await treasury.sendTransferNotification(lpWallet.getSender(), {
                amount: toNano('10'),
                from: alice.address,
                value: FORWARD,
                forwardPayload: beginCell().storeUint(0x54444550, 32).storeUint(t, 3).endCell(),
            });
            expect(jettonSentTo(bad, lpWallet.address)).toHaveLength(1);
        }

        expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(0n);
        expect((await treasury.getGov()).eligibleWeight).toEqual(0n);
    });

    it('refuses a notification from a wallet that is none of its own', async () => {
        const r = await treasury.sendTransferNotification(bob.getSender(), {
            amount: toNano('10'),
            from: alice.address,
            value: FORWARD,
            forwardPayload: depositPayload(0),
        });
        expect(r.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1151 });
    });

    it('keeps several positions per wallet independent, each with its own tier', async () => {
        await deposit(alice, toNano('10'), 0);
        await deposit(alice, toNano('20'), 1);
        await deposit(alice, toNano('30'), 2);
        const child = childOf(alice.address);
        const p = await child.getPositions();
        expect(p.positionCount).toEqual(3);
        expect(p.nextId).toEqual(3);
        expect((await child.getPosition(0)).tier).toEqual(0);
        expect((await child.getPosition(1)).tier).toEqual(1);
        expect((await child.getPosition(2)).tier).toEqual(2);
        expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(toNano('60'));
        const vw = toNano('10') * 1n + toNano('20') * 3n + toNano('30') * 10n;
        expect(await child.getVoteWeight()).toEqual(vw);
        expect(p.voteWeight).toEqual(vw);
    });

    it('has no message that mints — TR-4, asserted by the opcode table', () => {
        const ops = Object.values(TreasuryOpcodes);
        expect(ops).not.toContain(0x642b7d07); // JETTON_MASTER.mint
        for (const op of ops) expect(op >>> 24).not.toEqual(0xb0);
    });

    it('holds harvested tsTON and spends it by proposal', async () => {
        const amount = toNano('100');
        await deposit(alice, amount, 2);
        const child = childOf(alice.address);

        const credit = await treasury.sendTransferNotification(tstonWallet.getSender(), {
            amount: toNano('40'),
            from: deployer.address,
            value: toNano('0.1'),
        });
        expect(credit.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getTreasuryBalances()).tstonBalance).toEqual(toNano('40'));

        // §5.5.5: only LP locked strictly before the proposal opened votes on it.
        blockchain.now = blockchain.now! + 1;
        await child.sendPropose(alice.getSender(), {
            asset: TreasuryAsset.TSTON,
            amount: toNano('10'),
            dest: bob.address,
            positionId: 0,
            value: FORWARD,
        });
        // D-173 amendment 2026-11-19: the vote opens after the notice.
        const window = await treasury.getProposal(0);
        blockchain.now = window.opens;
        const voted = await child.sendVote(alice.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect(voted.transactions).not.toHaveTransaction({ aborted: true });
        blockchain.now = window.closes + 1;

        const r = await treasury.sendExecute(bob.getSender(), { seq: 0, value: toNano('1') });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const sent = jettonSentTo(r, tstonWallet.address);
        expect(sent).toHaveLength(1);
        expect(sent[0].amount).toEqual(toNano('10'));
        expect(sent[0].destination.toString()).toEqual(bob.address.toString());
        expect((await treasury.getTreasuryBalances()).tstonBalance).toEqual(toNano('30'));
    });

    // -----------------------------------------------------------------------
    // 6. The LP-move bounce arms — the treasury's wallets are DEAD addresses,
    //    so every outbound jetton transfer bounces.
    // -----------------------------------------------------------------------

    describe('bounce recovery (the header\'s LP-move paragraph)', () => {
        const DEAD_LP = Address.parse('0:' + 'de'.repeat(32));
        const DEAD_PRIMES = Address.parse('0:' + 'df'.repeat(32));
        let dead: SandboxContract<PrimesTreasury>;

        beforeEach(async () => {
            // A DIFFERENT genesis script, or this derives the SAME address as `treasury`.
            const genesis2 = await blockchain.treasury('genesisScript-dead');
            dead = blockchain.openContract(
                PrimesTreasury.createFromConfig(treasuryConfig(genesis2.address), treasuryCode)
            );
            await dead.sendDeploy(deployer.getSender(), toNano('10'));
            await dead.sendSetWallets(genesis2.getSender(), {
                lpJettonWallet: DEAD_LP,
                primesJettonWallet: DEAD_PRIMES,
                value: toNano('0.1'),
            });
        });

        function deadChildOf(owner: Address) {
            return blockchain.openContract(
                PrimesLpPosition.createFromConfig({ owner, treasuryAddr: dead.address }, positionCode)
            );
        }

        it('restores a position whose LP withdrawal bounced — matured, expired, retryable', async () => {
            const amount = toNano('100');
            await dead.sendTransferNotification(blockchain.sender(DEAD_LP), {
                amount,
                from: alice.address,
                value: FORWARD,
                forwardPayload: depositPayload(0),
            });
            const child = deadChildOf(alice.address);
            blockchain.now = 1800000000 + TREASURY_TIERS[0].termSeconds + 10;

            const w = await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
            expect(w.transactions).toHaveTransaction({ from: dead.address, to: DEAD_LP });
            expect(w.transactions).toHaveTransaction({ to: dead.address, inMessageBounced: true });
            expect(w.transactions).toHaveTransaction({
                from: dead.address,
                to: child.address,
                op: TreasuryOpcodes.RestorePosition,
                success: true,
            });

            // TR-5: the books are back to the wallet — the LP never left — but the
            // vote weight is not: it left `eligibleWeight` on the way out.
            expect((await dead.getTreasuryBalances()).lpHeld).toEqual(amount);
            expect((await dead.getGov()).eligibleWeight).toEqual(0n);
            const p = await child.getPosition(0);
            expect(p.amount).toEqual(amount);
            expect(p.tier).toEqual(0);
            expect(p.inFlight).toEqual(0);
            expect(p.lockedAt).toEqual(1);
            expect(p.maturesAt).toBeLessThanOrEqual(blockchain.now!);
            expect(p.expired).toEqual(1);
            expect(await child.getVoteWeight()).toEqual(0n);

            const again = await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
            expect(again.transactions).toHaveTransaction({ from: dead.address, to: DEAD_LP });
            expect((await child.getPositions()).positionCount).toEqual(1);
            // Still no double decrement.
            expect((await dead.getGov()).eligibleWeight).toEqual(0n);
        });

        it('restores a position whose sink-forward bounced — the owner survives via responseAddr', async () => {
            const amount = toNano('50');
            await dead.sendTransferNotification(blockchain.sender(DEAD_LP), {
                amount,
                from: bob.address,
                value: FORWARD,
                forwardPayload: depositPayload(2),
            });
            const child = deadChildOf(bob.address);
            const r = await child.sendToSink(bob.getSender(), { positionId: 0, value: FORWARD });
            expect(r.transactions).toHaveTransaction({ to: dead.address, inMessageBounced: true });
            expect(r.transactions).toHaveTransaction({
                from: dead.address,
                to: child.address,
                op: TreasuryOpcodes.RestorePosition,
                success: true,
            });
            expect((await dead.getTreasuryBalances()).lpHeld).toEqual(amount);
            expect((await child.getPosition(0)).amount).toEqual(amount);
            expect((await child.getPosition(0)).tier).toEqual(2);
            // D-214: the LP never reached the sink, so no forever weight survives on
            // EITHER side — the bounce is the one path that could mint votes from nothing.
            expect((await child.getForever()).amount).toEqual(0n);
            expect(await child.getVoteWeight()).toEqual(0n);
            expect((await dead.getGov()).eligibleWeight).toEqual(0n);
        });

        it('a relock brings a bounce-restored position back into the electorate exactly once', async () => {
            const amount = toNano('100');
            await dead.sendTransferNotification(blockchain.sender(DEAD_LP), {
                amount,
                from: alice.address,
                value: FORWARD,
                forwardPayload: depositPayload(0),
            });
            const child = deadChildOf(alice.address);
            blockchain.now = 1800000000 + TREASURY_TIERS[0].termSeconds + 10;
            await child.sendWithdraw(alice.getSender(), { positionId: 0, value: FORWARD });
            expect((await child.getPosition(0)).expired).toEqual(1);

            const rl = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 1, value: FORWARD });
            expect(rl.transactions).not.toHaveTransaction({ aborted: true });
            expect((await dead.getGov()).eligibleWeight).toEqual(amount * mult(1));
            expect(await child.getVoteWeight()).toEqual(amount * mult(1));
        });
    });
});
