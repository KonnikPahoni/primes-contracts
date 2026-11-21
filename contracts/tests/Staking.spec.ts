// TON PRIMES — PRIMES staking paid from the treasury vest. CONCEPT.md §5.3 / §5.5.3;
// DECISIONS.md D-168; STAKING_PLAN.md §3.1-3.2.
//
// WHAT THIS FILE PROVES:
//   * ST-1 solvency — the master's PRIMES wallet balance is at least
//     `lockedTotal + streamRemaining + unclaimedTotal`, read from `getStakeSolvency()`
//     against the wallet's own `get_wallet_data`, after every step of a full life cycle.
//   * ST-2 conservation — `budgetsIn == claimedTotal + unclaimedTotal + streamRemaining`,
//     exactly, including across the maturity proration and both bounce arms.
//   * ST-3 no early exit — `withdraw` before `maturesAt` is refused (1106); principal
//     leaves only to its owner.
//   * ST-4 bounded stream — nothing streams faster than the budget's rate, and nothing
//     streams past `streamRemaining`.
//   * TR-2's second exit — `distribute()` at most once per interval (1200), amount = the
//     formula to the nano, an empty treasury refused by name (1201), and a bounced
//     budget restores both the balance and the clock so it is retryable at once.
//   * the maturity rule (the one shared settle function): earning stops at `maturesAt`,
//     the tail is prorated and the excess goes BACK to the stream; `expire` is
//     permissionless and idempotent; a relock may not shorten a running term.
//   * refunds: an untagged stake, a wrong tag, a tier above 3, a tag with no tier, and
//     anything from the treasury without `SBGT` all come back; nothing is kept.
//   * first-depositor timing: a first staker after a quiet stretch earns none of it
//     (Q16); a 1-nano first staker earns only while alone; an accumulator step past
//     the 2^120 bound is skipped, so a dust stake can never brick the master.
//   * every happy path's trace has no aborted transaction (CLAUDE.md, the standard-reply
//     rule).
import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { buildStakeClaimMessage } from '../../shared/messages';
import { firstHop } from './helpers/inFlight';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesStake, stakePayload, budgetPayload, STAKE_ACC_SCALE } from '../wrappers/PrimesStake';
import { PrimesStakePosition } from '../wrappers/PrimesStakePosition';
import { PrimesTreasury } from '../wrappers/PrimesTreasury';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { STAKE } from '../../shared/opcodes';
import params from '../../shared/params.json';

const P = 1_000_000_000n; // 1 PRIMES
const RATE = BigInt(params.staking.distribution_rate_bps_per_day);
const EPOCH = BigInt(params.staking.epoch_seconds);
const TERMS = params.staking.tier_term_seconds.map(BigInt);
const WEIGHTS = params.staking.tier_weights.map(BigInt);
const SCALE = STAKE_ACC_SCALE;
const T0 = 1_800_000_000;

/** The treasury's `distributeBudget`, recomputed here. */
const budgetOf = (bal: bigint, interval = EPOCH) => (bal * RATE * interval) / (10000n * 86400n);

describe('PRIMES staking (§5.3, D-168)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesis: SandboxContract<TreasuryContract>;
    let alice: SandboxContract<TreasuryContract>;
    let bob: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let stakeCode: Cell;
    let positionCode: Cell;
    let treasuryCode: Cell;
    let lpPositionCode: Cell;
    let masterCode: Cell;
    let walletCode: Cell;

    beforeAll(async () => {
        stakeCode = await compile('PrimesStake');
        positionCode = await compile('PrimesStakePosition');
        treasuryCode = await compile('PrimesTreasury');
        lpPositionCode = await compile('PrimesLpPosition');
        masterCode = await compile('PrimesJettonMaster');
        walletCode = await compile('PrimesJettonWallet');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = T0;
        deployer = await blockchain.treasury('deployer');
        genesis = await blockchain.treasury('genesis');
        alice = await blockchain.treasury('alice');
        bob = await blockchain.treasury('bob');
        stranger = await blockchain.treasury('stranger');
    });

    // -----------------------------------------------------------------------
    // World A — real jettons end to end: master, treasury, their wallets.
    // -----------------------------------------------------------------------
    async function realWorld(opts: { treasuryPrimes?: bigint } = {}) {
        const jetton = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesis.address, walletCode },
                masterCode,
            ),
        );
        await jetton.sendDeploy(deployer.getSender(), toNano('1'));
        const walletOf = async (a: Address) =>
            blockchain.openContract(PrimesJettonWallet.createFromAddress(await jetton.getWalletAddress(a)));

        const stake = blockchain.openContract(
            PrimesStake.createFromConfig(
                { jettonMasterAddr: jetton.address, positionCode, genesisScriptAddr: genesis.address },
                stakeCode,
            ),
        );
        await stake.sendDeploy(deployer.getSender(), toNano('1'));
        const treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: deployer.address,
                    sinkAddr: deployer.address,
                    stakeAddr: stake.address,
                    distributionRateBpsPerDay: Number(RATE),
                    positionCode: lpPositionCode,
                    genesisScriptAddr: genesis.address,
                },
                treasuryCode,
            ),
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('1'));
        await treasury.sendSetWallets(genesis.getSender(), {
            lpJettonWallet: deployer.address,
            primesJettonWallet: await jetton.getWalletAddress(treasury.address),
            value: toNano('0.05'),
        });
        await stake.sendSetWallet(genesis.getSender(), {
            jettonWalletAddr: await jetton.getWalletAddress(stake.address),
            treasuryAddr: treasury.address,
            value: toNano('0.05'),
        });

        for (const u of [alice, bob, stranger, deployer]) {
            await jetton.sendMintGenesis(genesis.getSender(), { to: u.address, amount: 1_000_000n * P, value: toNano('0.3') });
        }
        const tp = opts.treasuryPrimes ?? 1_000_000n * P;
        if (tp > 0n) {
            await jetton.sendMintGenesis(genesis.getSender(), { to: genesis.address, amount: tp, value: toNano('0.3') });
            // Via a transfer WITH a forward, so the treasury is notified and tracks it.
            await (await walletOf(genesis.address)).sendTransfer(genesis.getSender(), {
                destination: treasury.address,
                responseAddr: genesis.address,
                amount: tp,
                value: toNano('0.3'),
                forwardTonAmount: toNano('0.05'),
            });
        }
        const stakeWallet = await walletOf(stake.address);
        const childOf = (a: Address) =>
            blockchain.openContract(PrimesStakePosition.createFromConfig({ owner: a, stakeAddr: stake.address }, positionCode));

        async function doStake(who: SandboxContract<TreasuryContract>, amount: bigint, tier: number, payload?: Cell) {
            return (await walletOf(who.address)).sendTransfer(who.getSender(), {
                destination: stake.address,
                responseAddr: who.address,
                amount,
                value: toNano('0.4'),
                forwardTonAmount: toNano('0.2'),
                forwardPayload: payload ?? stakePayload(tier),
            });
        }
        async function st1() {
            const s = await stake.getStakeSolvency();
            const bal = (await stakeWallet.getWalletData()).balance;
            expect(bal).toBeGreaterThanOrEqual(s.lockedTotal + s.streamRemaining + s.unclaimedTotal);
            return { ...s, bal };
        }
        async function st2() {
            const t = await stake.getStakeTotals();
            const s = await stake.getStakeSolvency();
            expect(t.budgetsIn).toBe(t.claimedTotal + s.unclaimedTotal + s.streamRemaining);
        }
        return { jetton, walletOf, stake, treasury, stakeWallet, childOf, doStake, st1, st2 };
    }

    it('derives a child exactly as the wrapper does — the PositionInit mirror', async () => {
        const w = await realWorld({ treasuryPrimes: 0n });
        expect((await w.stake.getStakePositionAddress(alice.address)).equals(w.childOf(alice.address).address)).toBe(true);
        const d = blockchain.openContract(
            PrimesStake.createFromConfig(
                { jettonMasterAddr: w.jetton.address, positionCode, genesisScriptAddr: genesis.address, clockDivisor: 168 },
                stakeCode,
            ),
        );
        await d.sendDeploy(deployer.getSender(), toNano('1'));
        const viaWrapper = PrimesStakePosition.createFromConfig(
            { owner: alice.address, stakeAddr: d.address, clockDivisor: 168 },
            positionCode,
        ).address;
        expect((await d.getStakePositionAddress(alice.address)).equals(viaWrapper)).toBe(true);
    });

    it('publishes the params it runs on (staking.*), divided by the clock', async () => {
        const w = await realWorld({ treasuryPrimes: 0n });
        expect((await w.stake.getTierTerms()).map(BigInt)).toEqual(TERMS);
        expect((await w.stake.getTierWeights()).map(BigInt)).toEqual(WEIGHTS);
        expect(await w.stake.getStakeMinForward()).toBe(toNano('0.15'));
        const cfg = await w.stake.getStakeConfig();
        expect(cfg.treasuryAddr.equals(w.treasury.address)).toBe(true);
        expect(cfg.walletSet).toBe(1);
        expect(BigInt(cfg.interval)).toBe(EPOCH);
        const s = await w.stake.getStakeStream();
        expect(s.accScale).toBe(SCALE);
    });

    it('stakes into a per-owner child, weighted amount x tierWeight, with a clean trace', async () => {
        const w = await realWorld({ treasuryPrimes: 0n });
        const r = await w.doStake(alice, 1000n * P, 2);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const child = w.childOf(alice.address);
        const pos = await child.getPosition(0);
        expect(pos.amount).toBe(1000n * P);
        expect(pos.tier).toBe(2);
        expect(pos.lockedAt).toBe(T0);
        expect(BigInt(pos.maturesAt)).toBe(BigInt(T0) + TERMS[2]);
        expect(pos.expired).toBe(0);
        expect((await child.getPositions()).stakedTotal).toBe(1000n * P);
        const s = await w.stake.getStakeStream();
        expect(s.totalWeight).toBe(1000n * P * WEIGHTS[2]);
        const t = await w.stake.getStakeTotals();
        expect(t.lockedTotal).toBe(1000n * P);
        expect(t.livePositions).toBe(1);
        await w.st1();
        await w.st2();
    });

    it.each([
        ['no payload at all', beginCell().endCell()],
        ['a wrong tag', beginCell().storeUint(0x12345678, 32).storeUint(0, 8).endCell()],
        ['the tag with no tier', beginCell().storeUint(0x53544b4c, 32).endCell()],
        ['a tier above 3', beginCell().storeUint(0x53544b4c, 32).storeUint(4, 8).endCell()],
        ['a budget tag from a non-treasury sender', budgetPayload()],
    ])('refunds a transfer carrying %s — nothing is kept, nothing recorded', async (_label, payload) => {
        const w = await realWorld({ treasuryPrimes: 0n });
        const aliceWallet = await w.walletOf(alice.address);
        const before = (await aliceWallet.getWalletData()).balance;
        const r = await w.doStake(alice, 500n * P, 0, payload as Cell);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await aliceWallet.getWalletData()).balance).toBe(before);
        const t = await w.stake.getStakeTotals();
        expect(t.lockedTotal).toBe(0n);
        expect(t.stakeEvents).toBe(0);
        expect((await w.stakeWallet.getWalletData()).balance).toBe(0n);
    });

    it('distribute(): the formula to the nano, once per interval, then again after it (TR-2)', async () => {
        const w = await realWorld();
        const bal0 = (await w.treasury.getTreasuryBalances()).primesBalance;
        const est = await w.treasury.getDistribution();
        expect(est.lastDistributeTime).toBe(0);
        expect(BigInt(est.interval)).toBe(EPOCH);
        expect(BigInt(est.rateBps)).toBe(RATE);
        expect(est.stakeAddr.equals(w.stake.address)).toBe(true);
        const b1 = budgetOf(bal0);
        expect(est.nextBudgetEstimate).toBe(b1);

        const r = await w.treasury.sendDistribute(stranger.getSender());
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await w.treasury.getTreasuryBalances()).primesBalance).toBe(bal0 - b1);
        const d = await w.treasury.getDistribution();
        expect(d.lastDistributeTime).toBe(T0);
        expect(d.distributedTotal).toBe(b1);
        expect((await w.treasury.getTreasuryCounts()).distributeEvents).toBe(1);
        const s = await w.stake.getStakeStream();
        expect(s.streamRemaining).toBe(b1);
        expect(s.streamRate).toBe(b1 / EPOCH);
        expect(BigInt(s.streamEnd)).toBe(BigInt(T0) + EPOCH);
        expect((await w.stake.getStakeTotals()).budgetsIn).toBe(b1);
        await w.st1();
        await w.st2();

        // Too early — refused by name, nothing moves.
        blockchain.now = T0 + Number(EPOCH) - 1;
        const early = await w.treasury.sendDistribute(stranger.getSender());
        expect(early.transactions).toHaveTransaction({ to: w.treasury.address, success: false, exitCode: 1200 });
        expect((await w.treasury.getDistribution()).distributedTotal).toBe(b1);

        blockchain.now = T0 + Number(EPOCH);
        const b2 = budgetOf(bal0 - b1);
        const r2 = await w.treasury.sendDistribute(stranger.getSender());
        expect(r2.transactions).not.toHaveTransaction({ aborted: true });
        expect((await w.treasury.getDistribution()).distributedTotal).toBe(b1 + b2);
        // Q16: no stakers the whole epoch, so nothing streamed and the first budget
        // rolled into the second epoch's rate.
        const s2 = await w.stake.getStakeStream();
        expect(s2.streamRemaining).toBe(b1 + b2);
        expect(s2.streamRate).toBe((b1 + b2) / EPOCH);
        expect((await w.stake.getStakeSolvency()).unclaimedTotal).toBe(0n);
        await w.st1();
        await w.st2();
    });

    it('distribute() refuses an empty treasury by name (1201)', async () => {
        const w = await realWorld({ treasuryPrimes: 0n });
        expect((await w.treasury.getDistribution()).nextBudgetEstimate).toBe(0n);
        const r = await w.treasury.sendDistribute(stranger.getSender());
        expect(r.transactions).toHaveTransaction({ to: w.treasury.address, success: false, exitCode: 1201 });
    });

    it('distribute() refuses an underfunded call (103)', async () => {
        const w = await realWorld();
        const r = await w.treasury.sendDistribute(stranger.getSender(), { value: toNano('0.1') });
        expect(r.transactions).toHaveTransaction({ to: w.treasury.address, success: false, exitCode: 103 });
    });

    it('streams pro rata to amount x tierWeight, and a claim pays what getClaimable said', async () => {
        const w = await realWorld();
        await w.doStake(alice, 1000n * P, 0); // weight 5000
        await w.doStake(bob, 1000n * P, 3); // weight 8000
        await w.treasury.sendDistribute(stranger.getSender());
        blockchain.now = T0 + 10 * 86400;
        const acc = await w.stake.getAccNow();
        const ca = await w.childOf(alice.address).getClaimable(0, acc);
        const cb = await w.childOf(bob.address).getClaimable(0, acc);
        expect(ca).toBeGreaterThan(0n);
        // 5 : 8, to within the per-position truncation.
        expect(ca * 8n - cb * 5n).toBeLessThanOrEqual(16n);
        expect(cb * 5n - ca * 8n).toBeLessThanOrEqual(16n);

        const aliceWallet = await w.walletOf(alice.address);
        const before = (await aliceWallet.getWalletData()).balance;
        const r = await w.childOf(alice.address).sendClaim(alice.getSender(), { positionId: 0 });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await aliceWallet.getWalletData()).balance - before).toBe(ca);
        const pos = await w.childOf(alice.address).getPosition(0);
        expect(pos.inFlight).toBe(0);
        expect(pos.lastSettleTime).toBe(blockchain.now);
        // ST-4: nothing streamed faster than the rate.
        const s = await w.stake.getStakeStream();
        const streamed = (await w.stake.getStakeTotals()).budgetsIn - s.streamRemaining;
        expect(streamed).toBeLessThanOrEqual(s.streamRate * 10n * 86400n);
        await w.st1();
        await w.st2();
    });

    it('earning stops at maturesAt: expire banks the prorated tail, the excess returns to the stream', async () => {
        const w = await realWorld();
        const A = 1000n * P;
        await w.doStake(alice, A, 0); // matures at T0 + 30 d, same length as the epoch
        await w.treasury.sendDistribute(stranger.getSender());
        const budget = (await w.stake.getStakeTotals()).budgetsIn;
        const rate = budget / EPOCH;
        const D = 5 * 86400;
        blockchain.now = T0 + Number(TERMS[0]) + D;

        // Before maturity it was refused; a stranger may poke after it.
        const r = await w.childOf(alice.address).sendExpire(stranger.getSender(), { positionId: 0 });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });

        const W = A * WEIGHTS[0];
        const amt = rate * EPOCH; // the whole stream ended at T0 + EPOCH
        const acc = (amt * SCALE) / W;
        const full = (W * acc) / SCALE;
        const paid = (full * TERMS[0]) / (TERMS[0] + BigInt(D));
        const pos = await w.childOf(alice.address).getPosition(0);
        expect(pos.expired).toBe(1);
        expect(pos.banked).toBe(paid);
        const s = await w.stake.getStakeStream();
        expect(s.totalWeight).toBe(0n);
        expect(s.streamRemaining).toBe(budget - amt + (full - paid));
        // `unclaimedTotal` also carries the accumulator's truncation dust (at most a
        // nano per settle) — it stays there, never paid to anyone, ST-2 still exact.
        const unclaimed = (await w.stake.getStakeSolvency()).unclaimedTotal;
        expect(unclaimed - paid).toBeGreaterThanOrEqual(0n);
        expect(unclaimed - paid).toBeLessThanOrEqual(1n);
        await w.st1();
        await w.st2();

        // Idempotent: a second poke returns, it does not throw or double-count.
        const again = await w.childOf(alice.address).sendExpire(stranger.getSender(), { positionId: 0 });
        expect(again.transactions).not.toHaveTransaction({ aborted: true });
        expect((await w.childOf(alice.address).getPosition(0)).banked).toBe(paid);

        // The claimable of an expired position is exactly its banked tail, and a
        // claim pays exactly that.
        expect(await w.childOf(alice.address).getClaimable(0, await w.stake.getAccNow())).toBe(paid);
        const aliceWallet = await w.walletOf(alice.address);
        const before = (await aliceWallet.getWalletData()).balance;
        await w.childOf(alice.address).sendClaim(alice.getSender(), { positionId: 0 });
        expect((await aliceWallet.getWalletData()).balance - before).toBe(paid);
        expect((await w.childOf(alice.address).getPosition(0)).banked).toBe(0n);
        await w.st1();
        await w.st2();
    });

    it('refuses expire before maturity (1106), and a withdraw before it (ST-3)', async () => {
        const w = await realWorld({ treasuryPrimes: 0n });
        await w.doStake(alice, 10n * P, 1);
        blockchain.now = T0 + Number(TERMS[1]) - 1;
        const e = await w.childOf(alice.address).sendExpire(stranger.getSender(), { positionId: 0 });
        expect(e.transactions).toHaveTransaction({ to: w.childOf(alice.address).address, success: false, exitCode: 1106 });
        const wd = await w.childOf(alice.address).sendWithdraw(alice.getSender(), { positionId: 0 });
        expect(wd.transactions).toHaveTransaction({ to: w.childOf(alice.address).address, success: false, exitCode: 1106 });
        expect((await w.stake.getStakeSolvency()).lockedTotal).toBe(10n * P);
    });

    it('withdraws at maturity: principal + final reward in ONE transfer to the owner only', async () => {
        const w = await realWorld();
        const A = 1000n * P;
        await w.doStake(alice, A, 0);
        await w.treasury.sendDistribute(stranger.getSender());
        blockchain.now = T0 + Number(TERMS[0]);
        const acc = await w.stake.getAccNow();
        const reward = await w.childOf(alice.address).getClaimable(0, acc);
        expect(reward).toBeGreaterThan(0n);

        // Not the owner.
        const theft = await w.childOf(alice.address).sendWithdraw(stranger.getSender(), { positionId: 0 });
        expect(theft.transactions).toHaveTransaction({ to: w.childOf(alice.address).address, success: false, exitCode: 1104 });

        const aliceWallet = await w.walletOf(alice.address);
        const before = (await aliceWallet.getWalletData()).balance;
        const r = await w.childOf(alice.address).sendWithdraw(alice.getSender(), { positionId: 0 });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        // One transfer out of the master's wallet.
        expect(r.transactions.filter((t: any) => t.inMessage?.info?.dest?.equals?.(w.stakeWallet.address)
            && t.inMessage.body.beginParse().preloadUint(32) === 0x0f8a7ea5).length).toBe(1);
        expect((await aliceWallet.getWalletData()).balance - before).toBe(A + reward);
        expect((await w.childOf(alice.address).getPosition(0)).maturesAt).toBe(0);
        expect((await w.childOf(alice.address).getPositions()).positionCount).toBe(0);
        const t = await w.stake.getStakeTotals();
        expect(t.lockedTotal).toBe(0n);
        expect(t.livePositions).toBe(0);
        expect((await w.stake.getStakeStream()).totalWeight).toBe(0n);
        await w.st1();
        await w.st2();
    });

    it('relock: refuses a downgrade before maturity (1107), allows an upgrade, and any tier after', async () => {
        const w = await realWorld();
        const A = 100n * P;
        await w.doStake(alice, A, 1);
        await w.treasury.sendDistribute(stranger.getSender());
        blockchain.now = T0 + 86400;
        const child = w.childOf(alice.address);
        const down = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 0 });
        expect(down.transactions).toHaveTransaction({ to: child.address, success: false, exitCode: 1107 });
        expect((await child.getPosition(0)).inFlight).toBe(0);

        const aliceWallet = await w.walletOf(alice.address);
        const before = (await aliceWallet.getWalletData()).balance;
        const owed = await child.getClaimable(0, await w.stake.getAccNow());
        const up = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 3 });
        expect(up.transactions).not.toHaveTransaction({ aborted: true });
        expect((await aliceWallet.getWalletData()).balance - before).toBe(owed);
        const p = await child.getPosition(0);
        expect(p.tier).toBe(3);
        expect(p.lockedAt).toBe(blockchain.now);
        expect(BigInt(p.maturesAt)).toBe(BigInt(blockchain.now) + TERMS[3]);
        expect((await w.stake.getStakeStream()).totalWeight).toBe(A * WEIGHTS[3]);

        // After maturity, any tier — and an EXPIRED position rejoins the weight.
        blockchain.now = p.maturesAt + 10;
        await child.sendExpire(stranger.getSender(), { positionId: 0 });
        expect((await w.stake.getStakeStream()).totalWeight).toBe(0n);
        const r = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 0 });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const p2 = await child.getPosition(0);
        expect(p2.tier).toBe(0);
        expect(p2.expired).toBe(0);
        expect(p2.banked).toBe(0n);
        expect((await w.stake.getStakeStream()).totalWeight).toBe(A * WEIGHTS[0]);
        await w.st1();
        await w.st2();
    });

    it('a matured, never-poked position is prorated on its own withdraw — the excess goes back to the stream', async () => {
        const w = await realWorld();
        const A = 1000n * P;
        await w.doStake(alice, A, 0); // 30 d
        await w.doStake(bob, A, 3); // 1 y
        await w.treasury.sendDistribute(stranger.getSender());
        // Alice matures at T0+30d; nobody pokes for another 30 d. The rule is
        // time-prorated over [lastSettleTime, now] (STAKING_PLAN §3.1 step 2), so
        // she keeps TERM / (TERM + 30 d) of what the accumulator says — the
        // disclosed approximation the keeper's `expire` poke exists to shrink.
        blockchain.now = T0 + Number(TERMS[0]) + 30 * 86400;
        const acc = await w.stake.getAccNow();
        const WA = A * WEIGHTS[0];
        const full = (WA * acc) / SCALE;
        const paid = (full * TERMS[0]) / (TERMS[0] + 30n * 86400n);
        expect(await w.childOf(alice.address).getClaimable(0, acc)).toBe(paid);
        const budget = (await w.stake.getStakeTotals()).budgetsIn;
        const amt = (budget / EPOCH) * EPOCH; // the whole stream ended at T0 + EPOCH
        const aliceWallet = await w.walletOf(alice.address);
        const before = (await aliceWallet.getWalletData()).balance;
        const r = await w.childOf(alice.address).sendWithdraw(alice.getSender(), { positionId: 0 });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await aliceWallet.getWalletData()).balance - before).toBe(A + paid);
        expect((await w.stake.getStakeStream()).streamRemaining).toBe(budget - amt + (full - paid));
        await w.st1();
        await w.st2();
        // Bob can still claim everything that streamed to him.
        const cb = await w.childOf(bob.address).getClaimable(0, await w.stake.getAccNow());
        expect(cb).toBeGreaterThan(0n);
        const rb = await w.childOf(bob.address).sendClaim(bob.getSender(), { positionId: 0 });
        expect(rb.transactions).not.toHaveTransaction({ aborted: true });
        await w.st1();
        await w.st2();
    });

    it('refuses a settle from anything but the owner\'s own child (1101)', async () => {
        const w = await realWorld({ treasuryPrimes: 0n });
        const forged = beginCell()
            .storeUint(STAKE.settle, 32).storeUint(0, 64).storeAddress(stranger.address).storeUint(0, 32)
            .storeCoins(1000n * P).storeUint(0, 8).storeUint(0, 40).storeUint(0, 256).storeUint(0, 40)
            .storeUint(0, 8).storeCoins(0).storeUint(2, 8).storeUint(0, 8).endCell();
        const r = await stranger.send({ to: w.stake.address, value: toNano('0.5'), body: forged });
        expect(r.transactions).toHaveTransaction({ to: w.stake.address, success: false, exitCode: 1101 });
    });

    it('has no admin: set_wallet is one-shot and genesis-only, unknown opcodes are refused', async () => {
        const w = await realWorld({ treasuryPrimes: 0n });
        const again = await w.stake.sendSetWallet(genesis.getSender(), {
            jettonWalletAddr: stranger.address, treasuryAddr: stranger.address, value: toNano('0.05'),
        });
        expect(again.transactions).toHaveTransaction({ to: w.stake.address, success: false, exitCode: 104 });
        const other = await w.stake.sendSetWallet(stranger.getSender(), {
            jettonWalletAddr: stranger.address, treasuryAddr: stranger.address, value: toNano('0.05'),
        });
        expect(other.transactions).toHaveTransaction({ to: w.stake.address, success: false, exitCode: 100 });
        const junk = await stranger.send({ to: w.stake.address, value: toNano('0.1'), body: beginCell().storeUint(0xdeadbeef, 32).endCell() });
        expect(junk.transactions).toHaveTransaction({ to: w.stake.address, success: false, exitCode: 101 });
        // A notification not from its own wallet cannot record a liability.
        const fake = await w.stake.sendTransferNotification(stranger.getSender(), { amount: 1n, from: stranger.address, value: toNano('0.3') });
        expect(fake.transactions).toHaveTransaction({ to: w.stake.address, success: false, exitCode: 1102 });
    });

    // -----------------------------------------------------------------------
    // World B — the master's and the treasury's PRIMES wallets are UNDEPLOYED
    // addresses. Notifications are impersonated from them with `blockchain.sender`,
    // and every transfer sent TO them bounces — which is how the bounce arms run.
    // -----------------------------------------------------------------------
    async function deadWorld() {
        const deadStakeWallet = new Address(0, Buffer.alloc(32, 7));
        const deadTreasuryWallet = new Address(0, Buffer.alloc(32, 9));
        const treasuryStandIn = await blockchain.treasury('treasury-standin');
        const stake = blockchain.openContract(
            PrimesStake.createFromConfig(
                { jettonMasterAddr: deployer.address, positionCode, genesisScriptAddr: genesis.address },
                stakeCode,
            ),
        );
        await stake.sendDeploy(deployer.getSender(), toNano('1'));
        await stake.sendSetWallet(genesis.getSender(), {
            jettonWalletAddr: deadStakeWallet, treasuryAddr: treasuryStandIn.address, value: toNano('0.05'),
        });
        const childOf = (a: Address) =>
            blockchain.openContract(PrimesStakePosition.createFromConfig({ owner: a, stakeAddr: stake.address }, positionCode));
        const notify = (amount: bigint, from: Address, payload: Cell) =>
            stake.sendTransferNotification(blockchain.sender(deadStakeWallet), { amount, from, value: toNano('0.5'), forwardPayload: payload });
        return { stake, childOf, notify, treasuryStandIn, deadTreasuryWallet };
    }

    it('a bounced reward transfer goes back to the stream — nobody is paid twice (ST-2 exact)', async () => {
        const w = await deadWorld();
        await w.notify(1000n * P, alice.address, stakePayload(0));
        await w.notify(10_000n * P, w.treasuryStandIn.address, budgetPayload());
        blockchain.now = T0 + 86400;
        const before = await w.stake.getStakeSolvency();
        const r = await w.childOf(alice.address).sendClaim(alice.getSender(), { positionId: 0 });
        // The payout bounced off the undeployed wallet and came home.
        expect(r.transactions).toHaveTransaction({ from: w.stake.address, to: new Address(0, Buffer.alloc(32, 7)), success: false });
        const t = await w.stake.getStakeTotals();
        const s = await w.stake.getStakeSolvency();
        expect(t.claimedTotal).toBe(0n);
        expect(s.unclaimedTotal).toBeLessThanOrEqual(1n); // truncation dust only
        expect(s.streamRemaining).toBeGreaterThanOrEqual(before.streamRemaining - 1n); // all but the dust came back
        expect(t.budgetsIn).toBe(t.claimedTotal + s.unclaimedTotal + s.streamRemaining);
        // The child's debt advanced and inFlight cleared — no second claim of the same.
        const pos = await w.childOf(alice.address).getPosition(0);
        expect(pos.inFlight).toBe(0);
        expect(pos.lastSettleTime).toBe(T0 + 86400);
    });

    it('a bounced withdraw restores the position matured, expired, principal and reward separate', async () => {
        const w = await deadWorld();
        const A = 1000n * P;
        await w.notify(A, alice.address, stakePayload(0));
        await w.notify(10_000n * P, w.treasuryStandIn.address, budgetPayload());
        blockchain.now = T0 + Number(TERMS[0]);
        const reward = await w.childOf(alice.address).getClaimable(0, await w.stake.getAccNow());
        expect(reward).toBeGreaterThan(0n);
        const r = await w.childOf(alice.address).sendWithdraw(alice.getSender(), { positionId: 0 });
        expect(r.transactions).toHaveTransaction({ from: w.stake.address, to: new Address(0, Buffer.alloc(32, 7)), success: false });
        const pos = await w.childOf(alice.address).getPosition(0);
        expect(pos.amount).toBe(A);
        expect(pos.banked).toBe(reward);
        expect(pos.expired).toBe(1);
        expect(pos.inFlight).toBe(0);
        expect(pos.maturesAt).toBeLessThanOrEqual(blockchain.now);
        const t = await w.stake.getStakeTotals();
        const s = await w.stake.getStakeSolvency();
        expect(s.lockedTotal).toBe(A);
        expect(s.unclaimedTotal - reward).toBeGreaterThanOrEqual(0n);
        expect(s.unclaimedTotal - reward).toBeLessThanOrEqual(1n); // truncation dust
        expect(t.livePositions).toBe(1);
        expect(t.budgetsIn).toBe(t.claimedTotal + s.unclaimedTotal + s.streamRemaining);
        // It stays expired: nothing more accrues to it.
        blockchain.now += 86400;
        expect(await w.childOf(alice.address).getClaimable(0, await w.stake.getAccNow())).toBe(reward);
    });

    it('refunds PRIMES from the treasury that do not carry SBGT, and streams only those that do', async () => {
        const w = await deadWorld();
        const r = await w.notify(5n * P, w.treasuryStandIn.address, stakePayload(0));
        // Refund transfer went out (and bounced off the dead wallet — that arm is a
        // documented surplus, not a liability).
        expect(r.transactions).toHaveTransaction({ from: w.stake.address, to: new Address(0, Buffer.alloc(32, 7)) });
        expect((await w.stake.getStakeTotals()).stakeEvents).toBe(0);
        expect((await w.stake.getStakeTotals()).budgetsIn).toBe(0n);
        await w.notify(5n * P, w.treasuryStandIn.address, budgetPayload());
        expect((await w.stake.getStakeTotals()).budgetsIn).toBe(5n * P);
        expect((await w.stake.getStakeTotals()).budgetEvents).toBe(1);
    });

    it('a bounced distribute() restores the balance AND the clock, so it is retryable at once', async () => {
        const deadPrimesWallet = new Address(0, Buffer.alloc(32, 11));
        const stakeAddr = new Address(0, Buffer.alloc(32, 12));
        const treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: deployer.address,
                    sinkAddr: deployer.address,
                    stakeAddr,
                    distributionRateBpsPerDay: Number(RATE),
                    positionCode: lpPositionCode,
                    genesisScriptAddr: genesis.address,
                },
                treasuryCode,
            ),
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('1'));
        await treasury.sendSetWallets(genesis.getSender(), {
            lpJettonWallet: deployer.address, primesJettonWallet: deadPrimesWallet, value: toNano('0.05'),
        });
        await treasury.sendTransferNotification(blockchain.sender(deadPrimesWallet), {
            amount: 1_000_000n * P, from: alice.address, value: toNano('0.1'),
        });
        const bal = (await treasury.getTreasuryBalances()).primesBalance;
        const r = await treasury.sendDistribute(stranger.getSender());
        expect(r.transactions).toHaveTransaction({ from: treasury.address, to: deadPrimesWallet, success: false });
        expect((await treasury.getTreasuryBalances()).primesBalance).toBe(bal);
        const d = await treasury.getDistribution();
        expect(d.lastDistributeTime).toBe(0);
        expect(d.distributedTotal).toBe(0n);
        expect((await treasury.getTreasuryCounts()).distributeEvents).toBe(0);
        // Retryable now — not refused as early.
        const again = await treasury.sendDistribute(stranger.getSender());
        expect(again.transactions).not.toHaveTransaction({ to: treasury.address, exitCode: 1200 });
    });

    it('ST-1 and ST-2 hold across a mixed life cycle of several stakers and epochs', async () => {
        const w = await realWorld();
        const users = [alice, bob, stranger];
        for (let i = 0; i < users.length; i++) await w.doStake(users[i], BigInt(100 + 50 * i) * P, i);
        for (let epoch = 0; epoch < 4; epoch++) {
            await w.treasury.sendDistribute(deployer.getSender());
            await w.st1();
            await w.st2();
            for (let k = 0; k < 3; k++) {
                blockchain.now = (blockchain.now ?? T0) + Math.floor(Number(EPOCH) / 3);
                const u = users[(epoch + k) % users.length];
                const child = w.childOf(u.address);
                const p = await child.getPosition(0);
                if (p.maturesAt !== 0 && blockchain.now >= p.maturesAt) {
                    await child.sendExpire(deployer.getSender(), { positionId: 0 });
                    if (k % 2 === 0) await child.sendRelock(u.getSender(), { positionId: 0, tier: (epoch + k) % 4 });
                } else if (p.maturesAt !== 0) {
                    await child.sendClaim(u.getSender(), { positionId: 0 });
                }
                await w.st1();
                await w.st2();
            }
        }
    });

    // -----------------------------------------------------------------------
    // First-depositor timing (the 2026-09-24 audit note).
    // -----------------------------------------------------------------------

    it('Q16: a first staker after a quiet stretch earns from its own stake on, never the quiet part', async () => {
        const w = await realWorld();
        await w.treasury.sendDistribute(stranger.getSender()); // nobody staked
        blockchain.now = T0 + 10 * 86400;
        await w.doStake(alice, 1000n * P, 0);
        expect(await w.stake.getAccNow()).toBe(0n);
        blockchain.now = T0 + 20 * 86400;
        const rate = (await w.stake.getStakeStream()).streamRate;
        const earned = await w.childOf(alice.address).getClaimable(0, await w.stake.getAccNow());
        // Ten days alone, not twenty: the quiet ten stay in the stream.
        expect(earned).toBeLessThanOrEqual(rate * 10n * 86400n);
        expect(earned).toBeGreaterThanOrEqual(rate * 10n * 86400n - 1n);
        await w.st1();
        await w.st2();
    });

    it('a 1-nano first staker earns only the stretch it was alone; the next staker is pro rata at once', async () => {
        const w = await realWorld();
        await w.doStake(alice, 1n, 0); // weight 5
        await w.treasury.sendDistribute(stranger.getSender());
        const rate = (await w.stake.getStakeStream()).streamRate;
        const half = rate * 5n * 86400n;
        blockchain.now = T0 + 5 * 86400;
        await w.doStake(bob, 1000n * P, 0);
        blockchain.now = T0 + 10 * 86400;
        const acc = await w.stake.getAccNow();
        const ca = await w.childOf(alice.address).getClaimable(0, acc);
        const cb = await w.childOf(bob.address).getClaimable(0, acc);
        expect(ca).toBeGreaterThanOrEqual(half - 1n);
        expect(ca).toBeLessThanOrEqual(half + 100n); // + its 5/(5+5e12) of the second half
        expect(cb).toBeGreaterThanOrEqual(half - 100n);
        expect(cb).toBeLessThanOrEqual(half);
        expect(ca + cb).toBeLessThanOrEqual(2n * half);
        await w.st1();
        await w.st2();
    });

    it('an accumulator step past 2^120 is skipped, never thrown — a dust staker cannot lock principal', async () => {
        const w = await deadWorld();
        await w.notify(1n, alice.address, stakePayload(0)); // totalWeight 5
        const B = 400_000_000n * P; // 5·2^56 ≈ 360M PRIMES is the threshold at weight 5
        await w.notify(B, w.treasuryStandIn.address, budgetPayload());
        blockchain.now = T0 + Number(EPOCH);
        // The get-method runs the same accrue: it answers instead of throwing.
        expect(await w.stake.getAccNow()).toBe(0n);

        // A state-touching message still lands, and the skipped slice stayed in the stream.
        const r = await w.notify(1000n * P, bob.address, stakePayload(0));
        expect(r.transactions).not.toHaveTransaction({ to: w.stake.address, success: false });
        expect((await w.stake.getStakeTotals()).stakeEvents).toBe(2);
        const s = await w.stake.getStakeSolvency();
        expect(s.streamRemaining).toBe(B);
        expect(s.unclaimedTotal).toBe(0n);

        // Real weight shrinks the step: the next budget streams again.
        await w.notify(P, w.treasuryStandIn.address, budgetPayload());
        blockchain.now = T0 + Number(EPOCH) + 86400;
        expect(await w.stake.getAccNow()).toBeGreaterThan(0n);
        const t = await w.stake.getStakeTotals();
        const s2 = await w.stake.getStakeSolvency();
        expect(t.budgetsIn).toBe(t.claimedTotal + s2.unclaimedTotal + s2.streamRemaining);
    });

    // -----------------------------------------------------------------------
    // The child's in-flight flag and its bounce arm (primes_stake_position.tolk
    // forwardSettle / onBouncedMessage), and the master's two named guards that
    // had no runtime test: 1100 stake_wallet_unset, 1103 stake_overflow.
    // -----------------------------------------------------------------------

    it('refuses a second settle while the first is in flight (1108); the master\'s reply clears the flag', async () => {
        const w = await realWorld();
        await w.doStake(alice, 1000n * P, 0);
        await w.treasury.sendDistribute(stranger.getSender());
        blockchain.now = T0 + 86400;
        const child = w.childOf(alice.address);
        const claim = buildStakeClaimMessage(0);

        // Only the child's own transaction runs: inFlight is set, the Settle is queued.
        const hop = await firstHop(blockchain, internal({ from: alice.address, to: child.address, value: claim.value, body: claim.body }));
        expect(hop.first.description.aborted).toBe(false);
        expect((await child.getPosition(0)).inFlight).toBe(1);

        const second = await child.sendClaim(alice.getSender(), { positionId: 0 });
        expect(second.transactions).toHaveTransaction({ to: child.address, success: false, exitCode: 1108 });
        // and an id that was never issued is a named miss, not a zero row (1105)
        const ghost = await child.sendClaim(alice.getSender(), { positionId: 7 });
        expect(ghost.transactions).toHaveTransaction({ to: child.address, success: false, exitCode: 1105 });
        expect(second.transactions).not.toHaveTransaction({ from: child.address, to: w.stake.address });

        // The first round trip finishes, clean, and pays exactly once.
        const rest = await hop.rest();
        expect(rest.filter((t: any) => t.description.aborted)).toEqual([]);
        expect((await child.getPosition(0)).inFlight).toBe(0);
        expect((await w.stake.getStakeTotals()).claimedTotal).toBeGreaterThan(0n);
        await w.st1();
        await w.st2();
    });

    it('a settle the master REFUSES bounces home and clears inFlight; nothing moved on either side', async () => {
        const w = await deadWorld();
        // 5A < 2^120 <= 8A: staking at tier 0 fits, re-weighting to tier 3 overflows
        // the master's `totalWeight` bound — its own 1103, a real compute failure.
        const A = (1n << 120n) / 6n;
        await w.notify(A, alice.address, stakePayload(0));
        const child = w.childOf(alice.address);
        const weightBefore = (await w.stake.getStakeStream()).totalWeight;
        expect(weightBefore).toBe(A * 5n);

        const r = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 3 });
        expect(r.transactions).toHaveTransaction({ from: child.address, to: w.stake.address, success: false, exitCode: 1103 });
        expect(r.transactions).toHaveTransaction({ from: w.stake.address, to: child.address, inMessageBounced: true, success: true });
        const red = r.transactions.filter((t: any) => t.description.aborted).map((t: any) => t.inMessage.info.dest.toString());
        expect(red).toEqual([w.stake.address.toString()]);

        const pos = await child.getPosition(0);
        expect(pos.inFlight).toBe(0);
        expect(pos.tier).toBe(0);
        expect(pos.amount).toBe(A);
        expect((await w.stake.getStakeStream()).totalWeight).toBe(weightBefore);

        // Not locked: a settle the master accepts goes straight through.
        const ok = await child.sendRelock(alice.getSender(), { positionId: 0, tier: 0 });
        expect(ok.transactions).not.toHaveTransaction({ aborted: true });
        expect((await child.getPosition(0)).inFlight).toBe(0);
    });

    it('refuses a stake whose weight would cross the 2^120 bound (1103) — nothing recorded', async () => {
        const w = await deadWorld();
        const r = await w.notify((1n << 120n) / 5n + 1n, alice.address, stakePayload(0));
        expect(r.transactions).toHaveTransaction({ to: w.stake.address, success: false, exitCode: 1103 });
        const t = await w.stake.getStakeTotals();
        expect(t.stakeEvents).toBe(0);
        expect(t.lockedTotal).toBe(0n);
    });

    it('refuses a notification before set_wallet (1100) — no wallet, nothing can be authenticated', async () => {
        const stake = blockchain.openContract(
            PrimesStake.createFromConfig({ jettonMasterAddr: deployer.address, positionCode, genesisScriptAddr: genesis.address }, stakeCode),
        );
        await stake.sendDeploy(deployer.getSender(), toNano('1'));
        expect((await stake.getStakeConfig()).walletSet).toBe(0);
        const r = await stake.sendTransferNotification(stranger.getSender(), {
            amount: 1000n * P, from: stranger.address, value: toNano('0.5'), forwardPayload: stakePayload(0),
        });
        expect(r.transactions).toHaveTransaction({ to: stake.address, success: false, exitCode: 1100 });
        expect((await stake.getStakeTotals()).stakeEvents).toBe(0);
    });
});
