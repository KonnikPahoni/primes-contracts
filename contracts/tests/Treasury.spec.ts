// TON PRIMES — U3: the GOVERNED TREASURY, the governance half.
// CONCEPT.md §5.5 (§2 point 4, §3.4, §8, §9.1); DECISIONS.md D-100, points 7-10.
// (LP custody — deposits, tiers, relock, expire, sink-forward — is `LpCustody.spec.ts`;
// `distribute()` and the stake master are `Staking.spec.ts`.)
//
// WHAT THIS FILE EXISTS TO PROVE:
//
//   1. THERE IS NO ADMIN INBOUND (D-100 point 7). No `update_config`, no owner,
//      no pause, no upgrade. The only one-shot is the D21 wallet bootstrap, and
//      it refuses a second call and a wrong sender. Anything else throws.
//   2. TR-2: NO MESSAGE THE TREASURY SENDS IS UNSOLICITED. Every outbound is
//      either a passed proposal's `execute` or `distribute()` (D-168). There
//      is no third path, so an unfunded, unvoted, or unclosed proposal
//      moves nothing.
//   3. TR-3: THE CAP IS MEASURED AT EXECUTE TIME. 25% of the named asset's
//      balance when it executes, not when it opened — a treasury that shrank in
//      between is respected.
//   4. TR-5 BY CONSTRUCTION (D-167): the treasury owns no LP, no proposal asset
//      names LP, and a depositor's LP is never the treasury's to propose.
//   5. THE VOTE'S OWN RULES (D-100 point 8): one day, simple majority of votes
//      cast, no quorum, A TIE FAILS, one open proposal per proposer, a 1%
//      threshold measured as a FRACTION of the electorate and never as a token
//      count, one wallet one vote, execute permissionless after close.
//   6. A BOUNCED EXECUTE IS RETRYABLE — `retry_credit`'s precedent, which is this
//      repo's standing answer to "the send failed and the state already moved".
//
// The 25% cap, the 1% threshold and the 1-day vote are `shared/params.json`
// `treasury.{proposal_cap_bps,propose_min_bps,vote_duration_seconds}` (D-100
// point 8); this file asserts the contract publishes them and enforces them.
import { Blockchain, internal, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    PrimesTreasury,
    TreasuryAsset,
    TREASURY_TIERS,
    depositPayload,
} from '../wrappers/PrimesTreasury';
import { PrimesLpPosition } from '../wrappers/PrimesLpPosition';
import { buildPositionWithdrawMessage } from '../../shared/messages';
import { TEP74 } from '../../shared/opcodes';
import params from '../../shared/params.json';

/** `staking.distribution_rate_bps_per_day` — deploy data, D-168. */
const RATE_BPS_PER_DAY = params.staking.distribution_rate_bps_per_day;
/** Treasury-only tests never pay the stake master; any address stands in for it. */
const STAKE_STANDIN = Address.parse('0:' + '5a'.repeat(32));
const FORWARD = toNano('0.5');
// Read from params.json, never typed: the NOTICE and the VOTE LENGTH are two
// parameters (D-173 amendment 2026-11-19). That they are equal today is a
// coincidence of the owner's value, so every clock below names the one it means.
const VOTE_DURATION = params.treasury.vote_duration_seconds;
const NOTICE = params.treasury.notice_duration_seconds;

/** An address with no contract at it: a bounceable send to it bounces. */
const DEAD_ADDRESS = Address.parse('0:' + 'de'.repeat(32));

function jettonSentTo(result: { transactions: any[] }, wallet: Address) {
    const out: { amount: bigint; destination: Address }[] = [];
    for (const tx of result.transactions) {
        for (const m of tx.outMessages.values()) {
            if (m.info.type !== 'internal') continue;
            if (!m.info.dest.equals(wallet)) continue;
            const s = m.body.beginParse();
            if (s.remainingBits < 32) continue;
            if (s.loadUint(32) !== 0x0f8a7ea5) continue;
            s.loadUintBig(64);
            out.push({ amount: s.loadCoins(), destination: s.loadAddress() });
        }
    }
    return out;
}

describe('U3 — the governed treasury (§5.5, D-100 points 7-10)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let operator: SandboxContract<TreasuryContract>;
    let whale: SandboxContract<TreasuryContract>;
    let minnow: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let lpWallet: SandboxContract<TreasuryContract>;
    let primesWallet: SandboxContract<TreasuryContract>;
    /** D-151: the treasury's own tsTON wallet — Tonstakers' jetton, not ours. */
    let tstonWallet: SandboxContract<TreasuryContract>;
    let sink: SandboxContract<TreasuryContract>;

    let treasuryCode: Cell;
    let positionCode: Cell;
    let treasury: SandboxContract<PrimesTreasury>;

    beforeAll(async () => {
        treasuryCode = await compile('PrimesTreasury');
        positionCode = await compile('PrimesLpPosition');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        // One second before T0 = 1800000000: see `deposit`.
        blockchain.now = 1800000000 - 1;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        operator = await blockchain.treasury('operator');
        whale = await blockchain.treasury('whale');
        minnow = await blockchain.treasury('minnow');
        stranger = await blockchain.treasury('stranger');
        lpWallet = await blockchain.treasury('lpWallet');
        primesWallet = await blockchain.treasury('primesWallet');
        tstonWallet = await blockchain.treasury('tstonWallet');
        sink = await blockchain.treasury('lpSink');

        treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: operator.address,
                    sinkAddr: sink.address,
                    stakeAddr: STAKE_STANDIN,
                    distributionRateBpsPerDay: RATE_BPS_PER_DAY,
                    positionCode,
                    genesisScriptAddr: genesisScript.address,
                },
                treasuryCode
            )
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('100'));
        await treasury.sendSetWallets(genesisScript.getSender(), {
            lpJettonWallet: lpWallet.address,
            primesJettonWallet: primesWallet.address,
            tstonJettonWallet: tstonWallet.address,
            value: toNano('0.1'),
        });
    });

    // CONCEPT §5.5.5 counts only LP locked strictly BEFORE a proposal opened
    // (1202). The suite starts at T0 - 1, so a deposit made before anything else
    // lands a second before T0 and the clock then steps to T0, where the tests
    // propose. `lateDeposit` does not touch the clock.
    async function deposit(who: SandboxContract<TreasuryContract>, amount: bigint, tier: number) {
        const r = await lateDeposit(who, amount, tier);
        if (blockchain.now! < 1800000000) blockchain.now = 1800000000;
        return r;
    }

    async function lateDeposit(who: SandboxContract<TreasuryContract>, amount: bigint, tier: number) {
        return await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount,
            from: who.address,
            value: FORWARD,
            forwardPayload: depositPayload(tier),
        });
    }

    function childOf(owner: Address) {
        return blockchain.openContract(
            PrimesLpPosition.createFromConfig(
                { owner, treasuryAddr: treasury.address },
                positionCode
            )
        );
    }

    /** Step the clock to the end of proposal `seq`'s notice — the first second a
     *  vote on it is accepted (1206 before). Read off chain, never computed. */
    async function openVote(seq = 0, t: SandboxContract<PrimesTreasury> = treasury) {
        blockchain.now = (await t.getProposal(seq)).opens;
    }

    /** One 6-month whale: the whole electorate unless someone else deposits. */
    async function seedElectorate() {
        await deposit(whale, toNano('1000'), 2);
        return childOf(whale.address);
    }

    // -----------------------------------------------------------------------
    // 1. No admin surface.
    // -----------------------------------------------------------------------

    it('has no admin inbound at all — an unknown opcode is refused', async () => {
        // Every opcode the treasury recognises is a jetton notification, a
        // message from a depositor's own child, or the permissionless execute.
        // There is nothing else to send, and D-100 point 7 is that absence.
        const r = await stranger.send({
            to: treasury.address,
            value: toNano('1'),
            body: beginCell().storeUint(0x96009999, 32).storeUint(0, 64).endCell(),
        });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 101, // wrong_opcode
        });
    });

    /**
     * GAUNTLET.md B27 — TEP-74's excess return, coming home.
     *
     * FOURTH instance of the class `CLAUDE.md` records three of. `Execute`'s
     * jetton branch names THIS CONTRACT as the payout's `responseAddr` ("a
     * proposal's excess belongs to the treasury that funded it", which is the
     * right intent), so the destination's wallet answers `excesses#d53276db`.
     * With no arm for it the reply fell to `else => assert (in.body.isEmpty())
     * throw 101` and aborted.
     *
     * The test above cannot see that, and neither could any balance assertion:
     * the reply is non-bounceable, so its value is credited in the credit phase
     * and stays put while the compute phase throws. The money reads right and
     * the trace reads FAILED. So this asserts the trace.
     */
    it('answers TEP-74 excesses instead of throwing 101 at it (B27)', async () => {
        const before = (await treasury.getTreasuryBalances()).tonBalance;
        const r = await stranger.send({
            to: treasury.address,
            value: toNano('0.05'),
            bounce: true,
            body: beginCell().storeUint(TEP74.excesses, 32).storeUint(7n, 64).endCell(),
        });
        // THE REGRESSION: this leaf was success: false, exitCode: 101,
        // aborted: true, on every governance payout the treasury ever made.
        expect(r.transactions).toHaveTransaction({
            from: stranger.address,
            to: treasury.address,
            op: TEP74.excesses,
            success: true,
            aborted: false,
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).not.toHaveTransaction({ exitCode: 101 });
        // Accepted and KEPT — the change is the treasury's, which is the whole
        // reason `Execute` names itself rather than the destination.
        expect((await treasury.getTreasuryBalances()).tonBalance).toBeGreaterThan(before);
    });

    it('still refuses a genuinely unknown opcode with 101, arm or no arm (B27)', async () => {
        // The guard this widened is still a guard: accepting `excesses` must not
        // turn the catch-all into a silent sink for anything else.
        const r = await stranger.send({
            to: treasury.address,
            value: toNano('0.05'),
            bounce: true,
            body: beginCell().storeUint(0xdeadbeef, 32).storeUint(0n, 64).endCell(),
        });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            success: false,
            exitCode: 101,
        });
    });

    it('accepts bare GRAM — the 58% forfeit share (D-166) — with nothing to authorise', async () => {
        const before = (await treasury.getTreasuryBalances()).tonBalance;
        await treasury.sendTon(stranger.getSender(), toNano('50'));
        const after = (await treasury.getTreasuryBalances()).tonBalance;
        expect(after).toBeGreaterThan(before + toNano('49'));
    });

    it('bootstraps its wallets once, from the genesis script only', async () => {
        // A fresh instance, so `walletsSet` is still 0.
        const t2 = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: operator.address,
                    sinkAddr: sink.address,
                    stakeAddr: STAKE_STANDIN,
                    distributionRateBpsPerDay: RATE_BPS_PER_DAY,
                    positionCode,
                    genesisScriptAddr: genesisScript.address,
                },
                treasuryCode,
                0
            )
        );
        // Same config as `treasury`, so it is the same address — deploy a
        // distinct one by giving it a different operator.
        const t3 = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: stranger.address,
                    sinkAddr: sink.address,
                    stakeAddr: STAKE_STANDIN,
                    distributionRateBpsPerDay: RATE_BPS_PER_DAY,
                    positionCode,
                    genesisScriptAddr: genesisScript.address,
                },
                treasuryCode
            )
        );
        expect(t2.address.toString()).toEqual(treasury.address.toString());
        await t3.sendDeploy(deployer.getSender(), toNano('5'));

        const wrongSender = await t3.sendSetWallets(stranger.getSender(), {
            lpJettonWallet: lpWallet.address,
            primesJettonWallet: primesWallet.address,
            value: toNano('0.1'),
        });
        expect(wrongSender.transactions).toHaveTransaction({
            to: t3.address,
            exitCode: 100, // wrong_sender
        });

        await t3.sendSetWallets(genesisScript.getSender(), {
            lpJettonWallet: lpWallet.address,
            primesJettonWallet: primesWallet.address,
            tstonJettonWallet: tstonWallet.address,
            value: toNano('0.1'),
        });
        const twice = await t3.sendSetWallets(genesisScript.getSender(), {
            lpJettonWallet: stranger.address,
            primesJettonWallet: stranger.address,
            tstonJettonWallet: stranger.address,
            value: toNano('0.1'),
        });
        expect(twice.transactions).toHaveTransaction({
            to: t3.address,
            exitCode: 104, // already_processed
        });
        const cfg = await t3.getTreasuryConfig();
        expect(cfg.lpJettonWallet.toString()).toEqual(lpWallet.address.toString());
        expect(cfg.walletsSet).toEqual(1);
        // D-151: the tsTON wallet is in the SAME one-shot and under the same
        // flag, so the second call did not move it either.
        expect(cfg.tstonJettonWallet.toString()).toEqual(tstonWallet.address.toString());
    });

    it('refuses a child message whose owner does not derive to the sender', async () => {
        // A stranger forging `relock_vote` for the whale's position — which would
        // otherwise inflate `eligibleWeight` 30x for free: the treasury re-derives
        // `positionAddress(owner)` and refuses, which IS the whole authentication
        // of that edge.
        await seedElectorate();
        const forged = await stranger.send({
            to: treasury.address,
            value: toNano('1'),
            body: beginCell()
                .storeUint(0x96000002, 32) // relock_vote
                .storeUint(0, 64)
                .storeAddress(whale.address)
                .storeUint(0, 32)
                .storeCoins(toNano('1000'))
                .storeUint(2, 8) // tier
                .storeUint(3, 8) // newTier
                .storeUint(0, 8) // expired
                .endCell(),
        });
        expect(forged.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1152, // treasury_not_position
        });
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('1000') * 10n);
    });

    it('moves eligibleWeight on a relock: drops the old term unless expired, adds the new', async () => {
        const child = await seedElectorate(); // 1000 LP, 6 months, 10x
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('10000'));

        // Live term, upgraded: -1000*10 +1000*30.
        const up = await child.sendRelock(whale.getSender(), { positionId: 0, tier: 3, value: FORWARD });
        expect(up.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('30000'));

        // Matured and EXPIRED, then relocked down: the old weight already left with
        // the expire, so only the new one is added.
        blockchain.now = 1800000000 + 365 * 86400 + 10;
        await child.sendExpire(stranger.getSender(), { positionId: 0, value: FORWARD });
        expect((await treasury.getGov()).eligibleWeight).toEqual(0n);
        const down = await child.sendRelock(whale.getSender(), { positionId: 0, tier: 0, value: FORWARD });
        expect(down.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('1000'));

        // Matured but NOT expired: the stale weight is dropped by the relock itself.
        blockchain.now = 1800000000 + 365 * 86400 + 10 + 31 * 86400;
        const again = await child.sendRelock(whale.getSender(), { positionId: 0, tier: 1, value: FORWARD });
        expect(again.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('3000'));
    });

    it('an expire racing an in-flight withdraw takes the weight out once, not twice (2026-11-08 audit)', async () => {
        // The withdraw's `WithdrawLp` already carries `expired == 0`, so the treasury drops
        // the weight when it lands. An `Expire` sent while it is in flight used to drop it
        // a second time; a second depositor makes the double subtraction visible instead
        // of letting the floor at 0 hide it.
        const child = await seedElectorate(); // whale: 1000 LP, 6 months, 10x
        await deposit(minnow, toNano('100'), 2); // minnow: 100 LP, 10x
        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('11000'));

        blockchain.now = 1800000000 + 365 * 86400 + 10; // both terms matured
        const it = await blockchain.sendMessageIter(
            internal({
                from: whale.address,
                to: child.address,
                value: FORWARD,
                body: buildPositionWithdrawMessage(0, 0n).body,
            }),
            { allowParallel: true }, // its own queue, so the expire below runs alone
        );
        await it.next(); // the child marks the position in flight; WithdrawLp is queued
        expect((await child.getPosition(0)).inFlight).toBe(1);

        const expire = await child.sendExpire(stranger.getSender(), { positionId: 0, value: FORWARD });
        expect(expire.transactions).not.toHaveTransaction({ aborted: true });
        expect(expire.transactions).not.toHaveTransaction({ from: child.address, to: treasury.address });
        for await (const _ of it) { /* drain the withdraw */ }

        expect((await treasury.getGov()).eligibleWeight).toEqual(toNano('1000'));
    });

    // -----------------------------------------------------------------------
    // 1a. B25 — negative/recovery paths B22's arm-by-arm read left uncovered.
    // -----------------------------------------------------------------------

    it('refuses every wallets-gated arm before set_wallets — treasury_wallets_unset (1150)', async () => {
        // A second, distinct instance (different operator, so a different
        // address) whose `walletsSet` is still 0 — `beforeEach`'s `treasury`
        // already bootstrapped. `TransferNotification`, `WithdrawLp`, `Execute`
        // and `Distribute` all guard on `w.walletsSet == 1` before anything else;
        // every existing test calls `sendSetWallets` first, so none of them ever
        // throws this code (grep: the only hits on 1150 in `contracts/tests/`
        // before this were a comment in `OperatorVesting.spec.ts`, now `TreasuryVesting.spec.ts`).
        const fresh = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: stranger.address,
                    sinkAddr: sink.address,
                    stakeAddr: STAKE_STANDIN,
                    distributionRateBpsPerDay: RATE_BPS_PER_DAY,
                    positionCode,
                    genesisScriptAddr: genesisScript.address,
                },
                treasuryCode
            )
        );
        await fresh.sendDeploy(deployer.getSender(), toNano('10'));

        const tn = await fresh.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('1'),
            from: whale.address,
            value: FORWARD,
            forwardPayload: depositPayload(0),
        });
        expect(tn.transactions).toHaveTransaction({ to: fresh.address, exitCode: 1150 });

        const withdrawBody = beginCell()
            .storeUint(0x96000003, 32) // WithdrawLp
            .storeUint(0, 64)
            .storeAddress(whale.address)
            .storeUint(0, 32)
            .storeCoins(toNano('1000'))
            .storeUint(2, 8) // tier
            .storeUint(0, 8) // toSink
            .storeUint(0, 8) // D-147 expired
            .endCell();
        const w = await stranger.send({ to: fresh.address, value: FORWARD, body: withdrawBody });
        expect(w.transactions).toHaveTransaction({ to: fresh.address, exitCode: 1150 });

        const ex = await fresh.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(ex.transactions).toHaveTransaction({ to: fresh.address, exitCode: 1150 });

        const dist = await fresh.sendDistribute(stranger.getSender());
        expect(dist.transactions).toHaveTransaction({ to: fresh.address, exitCode: 1150 });
    });

    it('refuses TransferNotification/WithdrawLp/Distribute underfunded below the published minimum (103)', async () => {
        // The LP deposit path: `TREASURY_MIN_FORWARD` (0.15 GRAM) is refused
        // before anything is recorded — the burn sink's "refuse before crediting
        // what we cannot finish" precedent.
        const low = await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('10'),
            from: whale.address,
            value: toNano('0.01'),
            forwardPayload: depositPayload(0),
        });
        expect(low.transactions).toHaveTransaction({ to: treasury.address, exitCode: 103 });
        expect((await treasury.getTreasuryCounts()).depositEvents).toEqual(0);

        // WithdrawLp requires `TRANSFER_GAS + CHILD_GAS`. Seed a
        // real position so the message derives to a real child address, then
        // send the raw arm directly FROM that address, underfunded — the same
        // authentication the child's own outbound messages carry.
        const child = await seedElectorate();

        const withdrawBody = beginCell()
            .storeUint(0x96000003, 32) // WithdrawLp
            .storeUint(0, 64)
            .storeAddress(whale.address)
            .storeUint(0, 32)
            .storeCoins(toNano('1000'))
            .storeUint(2, 8) // tier
            .storeUint(0, 8) // toSink
            .storeUint(0, 8) // D-147 expired
            .endCell();
        const w = await blockchain.sendMessage(
            internal({ from: child.address, to: treasury.address, value: toNano('0.01'), body: withdrawBody })
        );
        expect(w.transactions).toHaveTransaction({ to: treasury.address, exitCode: 103 });

        // `distribute()` requires its published `distributeMinForward` (0.15 GRAM).
        const d = await treasury.sendDistribute(stranger.getSender(), { value: toNano('0.05') });
        expect(d.transactions).toHaveTransaction({ to: treasury.address, exitCode: 103 });

        // Nothing was recorded on either underfunded attempt: the electorate
        // seed's own deposit is the only one counted.
        expect((await treasury.getTreasuryCounts()).depositEvents).toEqual(1);
    });

    it('recovers a bounced QTAG_EXECUTE jetton payout — PRIMES and tsTON both reset and restore', async () => {
        // The only `onBouncedMessage` branch with no covering test anywhere in
        // `contracts/tests/`: a passed PRIMES or tsTON proposal's payout bouncing.
        // `BounceCoverage.spec.ts` only proves every contract HAS a handler, and
        // `Treasury.spec.ts`'s only existing bounce test is the TonPayout/asset-0
        // path. Reuse `LpMiner.spec.ts`'s dead-jetton-wallet trick: a bare
        // address with no contract at it bounces any `RichBounce` sent there,
        // which is exactly what a jetton wallet whose transfer bounces looks
        // like from this contract's side.
        const DEAD_PRIMES = Address.parse('0:' + 'e1'.repeat(32));
        const DEAD_LP = Address.parse('0:' + 'e2'.repeat(32));
        const DEAD_TSTON = Address.parse('0:' + 'e3'.repeat(32));
        const genesis2 = await blockchain.treasury('genesisScript-dead-b25');
        const dead = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: operator.address,
                    sinkAddr: sink.address,
                    stakeAddr: STAKE_STANDIN,
                    distributionRateBpsPerDay: RATE_BPS_PER_DAY,
                    positionCode,
                    genesisScriptAddr: genesis2.address,
                },
                treasuryCode
            )
        );
        await dead.sendDeploy(deployer.getSender(), toNano('10'));
        await dead.sendSetWallets(genesis2.getSender(), {
            lpJettonWallet: DEAD_LP,
            primesJettonWallet: DEAD_PRIMES,
            tstonJettonWallet: DEAD_TSTON,
            value: toNano('0.1'),
        });

        function deadChildOf(owner: Address) {
            return blockchain.openContract(
                PrimesLpPosition.createFromConfig({ owner, treasuryAddr: dead.address }, positionCode)
            );
        }
        async function seedDeadElectorate() {
            await dead.sendTransferNotification(blockchain.sender(DEAD_LP), {
                amount: toNano('1000'),
                from: whale.address,
                value: FORWARD,
                forwardPayload: depositPayload(2),
            });
            if (blockchain.now! < 1800000000) blockchain.now = 1800000000; // see `deposit`
            return deadChildOf(whale.address);
        }

        // --- PRIMES: executed resets, primesBalance is restored. ---
        await dead.sendTransferNotification(blockchain.sender(DEAD_PRIMES), {
            amount: toNano('1000'),
            from: deployer.address,
            value: toNano('0.1'),
        });
        const childP = await seedDeadElectorate();
        await childP.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.PRIMES,
            amount: toNano('200'),
            dest: minnow.address,
            positionId: 0,
            value: FORWARD,
        });
        await openVote(0, dead);
        await childP.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;

        const before = await dead.getTreasuryBalances();
        const r1 = await dead.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(r1.transactions).toHaveTransaction({ from: dead.address, to: DEAD_PRIMES });
        expect(r1.transactions).toHaveTransaction({ to: dead.address, inMessageBounced: true });
        expect((await dead.getProposal(0)).executed).toEqual(0);
        expect((await dead.getExecutable(0)).executable).toBe(true);
        expect((await dead.getTreasuryBalances()).primesBalance).toEqual(before.primesBalance);

        // Retryable — nothing was stranded. But the EXECUTOR pays the hop (audit Low):
        // a re-execute for compute alone would have the treasury pay it each time.
        const cheap = await dead.sendExecute(stranger.getSender(), { seq: 0, value: toNano('0.05') });
        expect(cheap.transactions).toHaveTransaction({ to: dead.address, exitCode: 103 });
        expect(cheap.transactions).not.toHaveTransaction({ from: dead.address, to: DEAD_PRIMES });
        const again = await dead.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(again.transactions).toHaveTransaction({ from: dead.address, to: DEAD_PRIMES });

        // --- tsTON (D-151): executed resets, tstonBalance is restored. ---
        await dead.sendTransferNotification(blockchain.sender(DEAD_TSTON), {
            amount: toNano('40'),
            from: deployer.address,
            value: toNano('0.1'),
        });
        await childP.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.TSTON,
            amount: toNano('8'),
            dest: minnow.address,
            positionId: 0,
            value: FORWARD,
        });
        await openVote(1, dead);
        await childP.sendVote(whale.getSender(), { seq: 1, support: true, positionId: 0, value: FORWARD });
        blockchain.now = (await dead.getProposal(1)).closes;

        const tstonBefore = (await dead.getTreasuryBalances()).tstonBalance;
        const r3 = await dead.sendExecute(stranger.getSender(), { seq: 1, value: toNano('1') });
        expect(r3.transactions).toHaveTransaction({ from: dead.address, to: DEAD_TSTON });
        expect(r3.transactions).toHaveTransaction({ to: dead.address, inMessageBounced: true });
        expect((await dead.getProposal(1)).executed).toEqual(0);
        expect((await dead.getTreasuryBalances()).tstonBalance).toEqual(tstonBefore);
    });

    // -----------------------------------------------------------------------
    // 2. The proposal threshold and the one-open-proposal rule.
    // -----------------------------------------------------------------------

    it('publishes the vote parameters it enforces', async () => {
        const gov = await treasury.getGov();
        expect(gov.proposalCapBps).toEqual(2500); // treasury.proposal_cap_bps
        expect(gov.proposeMinBps).toEqual(100); // treasury.propose_min_bps
        expect(gov.voteDuration).toEqual(VOTE_DURATION); // treasury.vote_duration_seconds
        expect(gov.noticeDuration).toEqual(NOTICE); // treasury.notice_duration_seconds
        expect(gov.proposalSeq).toEqual(0);
    });

    it('refuses a proposal from below 1% of the electorate', async () => {
        // The whale is 1000 LP at 10x = 10,000 units of vote weight; the minnow
        // is 1 LP at 1x = 1 unit, which is 0.01% and not 1%. The threshold is a
        // FRACTION of the electorate, never a fixed token count (D-100 "options
        // not taken": a fixed count is two different rules over time).
        await seedElectorate();
        await deposit(minnow, toNano('1'), 0);
        const small = childOf(minnow.address);
        const r = await small.sendPropose(minnow.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: minnow.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1156, // treasury_propose_below_threshold
        });
        expect((await treasury.getGov()).proposalSeq).toEqual(0);
    });

    it('refuses a proposal from a position with no live vote weight', async () => {
        // Every tier votes since D-168, so the position with no weight is a
        // MATURED one (D-147) — and the refusal happens on the CHILD, before the
        // treasury is bothered.
        await deposit(minnow, toNano('1000'), 0);
        blockchain.now = 1800000000 + 30 * 86400 + 1;
        const child = childOf(minnow.address);
        const r = await child.sendPropose(minnow.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: minnow.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(r.transactions).toHaveTransaction({
            to: child.address,
            exitCode: 1169, // position_no_vote_weight
        });
    });

    it('allows one open proposal per proposer, and a second once the first closes', async () => {
        const child = await seedElectorate();
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        const second = await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('2'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(second.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1157, // treasury_proposal_open
        });
        expect((await treasury.getGov()).proposalSeq).toEqual(1);

        // The slot is held through the NOTICE and the vote alike — to the last
        // second before `closes`.
        blockchain.now = (await treasury.getProposal(0)).closes - 1;
        const stillOpen = await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('2'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(stillOpen.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1157 });

        // Once the vote has closed the slot is free: a proposal whose vote has
        // closed is settled business either way.
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('2'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        expect((await treasury.getGov()).proposalSeq).toEqual(2);
    });

    it("D13: executing a stale, unexecuted proposal does not clear a LATER open proposal's throttle slot", async () => {
        // A: opens, passes, but is left unexecuted past its own close.
        const child = await seedElectorate();
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        await openVote();
        await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });

        // A's window closes. `Propose` treats A as settled (closed, whether or
        // not executed) and lets the same proposer open B.
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('2'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        expect((await treasury.getGov()).proposalSeq).toEqual(2); // A=0, B=1

        // Anyone executes A late. Before D13's fix this unconditionally
        // deleted openBy[whale], even though it now names B (seq 1) — freeing
        // the slot while B is still mid-vote.
        const execA = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(execA.transactions).toHaveTransaction({
            from: treasury.address,
            to: whale.address,
            value: toNano('1'),
            success: true,
        });
        expect((await treasury.getProposal(0)).executed).toEqual(1);

        // B is still open (its own window has not closed) — the proposer must
        // still be refused a third proposal, C.
        const attemptC = await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('3'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(attemptC.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1157, // treasury_proposal_open — B is still B's slot
        });
        expect((await treasury.getGov()).proposalSeq).toEqual(2); // C never opened

        // Once B itself closes, the slot frees normally.
        blockchain.now = (await treasury.getProposal(1)).closes;
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('3'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        expect((await treasury.getGov()).proposalSeq).toEqual(3);
    });

    it('records a proposal exactly as opened: the vote opens after the notice, for one day', async () => {
        const child = await seedElectorate();
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.PRIMES,
            amount: toNano('7'),
            dest: minnow.address,
            positionId: 0,
            value: FORWARD,
        });
        const p = await treasury.getProposal(0);
        expect(p.proposer!.toString()).toEqual(whale.address.toString());
        expect(p.asset).toEqual(TreasuryAsset.PRIMES);
        expect(p.amount).toEqual(toNano('7'));
        expect(p.dest!.toString()).toEqual(minnow.address.toString());
        // `opens` is when the VOTE opens — the notice after it was proposed (T0).
        expect(p.opens).toEqual(1800000000 + NOTICE);
        expect(p.closes).toEqual(p.opens + VOTE_DURATION);
        expect(p.yes).toEqual(0n);
        expect(p.no).toEqual(0n);
        expect(p.executed).toEqual(0);
    });

    // -----------------------------------------------------------------------
    // 3. Voting.
    // -----------------------------------------------------------------------

    it('tallies one wallet one vote at its full weight, and refuses a second', async () => {
        const child = await seedElectorate();
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        await openVote();
        await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect((await treasury.getProposal(0)).yes).toEqual(toNano('1000') * 10n);
        // D-188 point 7: the record is on the voter's own child, not the treasury.
        expect(await child.getHasVoted(0, 0)).toBe(true);
        expect(await child.getVotedCount(0)).toEqual(1);

        const again = await child.sendVote(whale.getSender(), {
            seq: 0,
            support: false,
            positionId: 0,
            value: FORWARD,
        });
        expect(again.transactions).toHaveTransaction({
            to: child.address,
            exitCode: 1155, // treasury_already_voted — refused by the CHILD
        });
        expect(again.transactions).not.toHaveTransaction({ from: child.address, to: treasury.address });
        expect((await treasury.getProposal(0)).no).toEqual(0n);
    });

    it('refuses a vote after the window closes', async () => {
        const child = await seedElectorate();
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
        const late = await child.sendVote(whale.getSender(), {
            seq: 0,
            support: true,
            positionId: 0,
            value: FORWARD,
        });
        expect(late.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1154, // treasury_vote_closed
        });
    });

    it('refuses a vote from LP locked once the VOTE has opened (§5.5.5, 1202)', async () => {
        const child = await seedElectorate();
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        const opens = (await treasury.getProposal(0)).opens;
        for (const late of [opens, opens + 60]) {
            blockchain.now = late;
            await lateDeposit(minnow, toNano('5000'), 3);
        }
        const mc = childOf(minnow.address);
        expect((await mc.getPosition(0)).weightSince).toEqual(opens);
        for (const positionId of [0, 1]) {
            const r = await mc.sendVote(minnow.getSender(), { seq: 0, support: false, positionId, value: FORWARD });
            expect(r.transactions).toHaveTransaction({
                to: treasury.address,
                exitCode: 1202, // treasury_vote_locked_late
            });
        }
        expect((await treasury.getProposal(0)).no).toEqual(0n);
    });

    /** The whale proposes 1 GRAM to itself; the clock is left IN THE NOTICE. */
    async function proposeAt(child: SandboxContract<PrimesLpPosition>) {
        const r = await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
    }

    // §5.5.5: `weightSince` marks when a position's CURRENT weight began. Only a
    // same-tier relock before maturity (a pure extension) keeps it.
    async function proposeFromWhale(child: SandboxContract<PrimesLpPosition>) {
        await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: whale.address,
            positionId: 0,
            value: FORWARD,
        });
        await openVote(); // the tests below act MID-VOTE, past the notice
    }

    it('a same-tier relock mid-vote keeps weightSince, so the position still votes', async () => {
        const child = await seedElectorate();
        const before = await child.getPosition(0);
        await proposeFromWhale(child);
        blockchain.now = blockchain.now! + 60;
        await child.sendRelock(whale.getSender(), { positionId: 0, tier: 2, value: FORWARD });
        const after = await child.getPosition(0);
        expect(after.lockedAt).toEqual(blockchain.now);
        expect(after.weightSince).toEqual(before.weightSince);
        await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect((await treasury.getProposal(0)).yes).toEqual(toNano('1000') * 10n);
    });

    it('refuses a vote after a mid-vote tier UPGRADE — new weight cannot swing an open proposal', async () => {
        // Without the restamp: lock 1× weight, wait for a proposal, upgrade to
        // the 1-year term and vote at 30×.
        const child = await seedElectorate();
        await proposeFromWhale(child);
        blockchain.now = blockchain.now! + 60;
        await child.sendRelock(whale.getSender(), { positionId: 0, tier: 3, value: FORWARD });
        expect((await child.getPosition(0)).weightSince).toEqual(blockchain.now);
        const r = await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1202, // treasury_vote_locked_late
        });
        expect((await treasury.getProposal(0)).yes).toEqual(0n);
    });

    it('a vote cast BEFORE an upgrade stays counted at the old weight', async () => {
        const child = await seedElectorate();
        await proposeFromWhale(child);
        await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        blockchain.now = blockchain.now! + 60;
        await child.sendRelock(whale.getSender(), { positionId: 0, tier: 3, value: FORWARD });
        const p = await treasury.getProposal(0);
        expect(p.yes).toEqual(toNano('1000') * 10n);
        expect(p.no).toEqual(0n);
    });

    it('reviving a MATURED term restamps weightSince, even at the same tier', async () => {
        const child = await seedElectorate();
        const { maturesAt } = await child.getPosition(0);
        blockchain.now = maturesAt + 1;
        await child.sendRelock(whale.getSender(), { positionId: 0, tier: 2, value: FORWARD });
        expect((await child.getPosition(0)).weightSince).toEqual(maturesAt + 1);
    });

    // -----------------------------------------------------------------------
    // 3a. THE NOTICE (D-173 as amended 2026-11-19, audit R2-H1). A proposal is
    // public for `notice_duration_seconds` before its vote opens; LP locked
    // during the notice votes on it, LP locked once the vote is open does not.
    //
    // WHICH OF THESE PROVE THE FIX, AND WHICH STATE A LIMIT IT LEAVES. Each test
    // below is tagged. [FIX] asserts what the amendment added: 1206, the in-notice
    // lock that votes, the dust spend that fails, the notice that cannot be
    // pruned, the `opens − 1` boundary. [LIMIT] asserts what the amendment does
    // NOT change, so nobody reads [FIX] as "closed": a lock from `opens` on is
    // still refused 1202, an unopposed dust spend still pays, and the proposer
    // can top up in the notice's last second. MEASURED 2026-11-20 against the
    // pre-amendment `primes_treasury.tolk`: EVERY test in this block is red there
    // — the [FIX] ones on behaviour, the [LIMIT] ones because they are written
    // on the notice's clock and on the six-value `getGov`. The one test that
    // passes on both contracts is the older 'refuses a vote from LP locked once
    // the VOTE has opened (1202)' above, which is D-173 as signed.
    // Not pinned by any sandbox test: that the notice and the vote length are
    // not swapped — both compile to 86400, so only SimCrossCheck's name binding
    // and the reading of `Propose` hold that.
    // -----------------------------------------------------------------------

    // [FIX]
    it('refuses a vote before the notice ends (1206), and the same position votes once it has', async () => {
        const child = await seedElectorate();
        await proposeAt(child);
        const { opens } = await treasury.getProposal(0);
        expect(opens).toEqual(1800000000 + NOTICE);

        // The proposal's own second, and the last second of the notice.
        for (const t of [1800000000, opens - 1]) {
            blockchain.now = t;
            const early = await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
            // The chain answers first, on its own clock — what a driver polls.
            expect(await treasury.getVotable(0)).toEqual({ votable: false, reason: 1206 });
            expect(early.transactions).toHaveTransaction({
                to: treasury.address,
                exitCode: 1206, // treasury_vote_not_open
            });
            // The refusal bounced and the child forgot the record, so it does
            // not answer 1155 to the real vote below.
            expect(await child.getHasVoted(0, 0)).toBe(false);
        }
        expect((await treasury.getProposal(0)).yes).toEqual(0n);

        blockchain.now = opens;
        expect(await treasury.getVotable(0)).toEqual({ votable: true, reason: 0 });
        const r = await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getProposal(0)).yes).toEqual(toNano('1000') * 10n);
        expect(await child.getHasVoted(0, 0)).toBe(true);

        // ...and `getVotable` names the other two clock refusals.
        blockchain.now = (await treasury.getProposal(0)).closes;
        expect(await treasury.getVotable(0)).toEqual({ votable: false, reason: 1154 });
        expect(await treasury.getVotable(9)).toEqual({ votable: false, reason: 1153 });
    });

    // [FIX] for the notice half (it did not exist); 1158/1205 during the vote are older.
    it('a proposal in its notice can be neither executed nor pruned', async () => {
        const child = await seedElectorate();
        await deposit(minnow, toNano('1000'), 2);
        await proposeAt(child);
        const { opens, closes } = await treasury.getProposal(0);
        // The whole notice and the whole vote, to the last second before `closes`.
        for (const t of [1800000000, opens - 1, opens, closes - 1]) {
            blockchain.now = t;
            expect((await treasury.getExecutable(0)).reason).toEqual(1158);
            const ex = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
            expect(ex.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1158 }); // treasury_not_closed
            expect(await treasury.getPrunable(0)).toBe(false);
            const pr = await treasury.sendPrune(stranger.getSender(), { seq: 0 });
            expect(pr.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1205 }); // treasury_not_prunable
        }
        // A later `propose` prunes the two oldest DUE rows — never this one.
        const later = await childOf(minnow.address).sendPropose(minnow.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: minnow.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(later.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getGov()).proposalSeq).toEqual(2);
        expect((await treasury.getProposal(0)).opens).toEqual(opens);
    });

    // AUDIT R2-H1, the reproduced scenario. Empty electorate; one wallet locks ONE
    // NANO-UNIT of LP for 30 days and proposes 24 of the treasury's 100 GRAM to a
    // fresh address. Before the notice the vote opened in the proposal's own
    // second, so 1202 refused everyone who was not already locked and a stranger's
    // `execute` paid out a day later.
    async function dustSpend() {
        const dust = await blockchain.treasury('r2h1-dust');
        const payee = await blockchain.treasury('r2h1-payee');
        await deposit(dust, 1n, 0);
        expect((await treasury.getGov()).eligibleWeight).toEqual(1n);
        const dc = childOf(dust.address);
        const p = await dc.sendPropose(dust.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('24'),
            dest: payee.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(p.transactions).not.toHaveTransaction({ aborted: true });
        const { opens, closes } = await treasury.getProposal(0);
        return { dust, dc, payee, opens, closes };
    }

    // [FIX] — the audit's reproduction, inverted.
    it('R2-H1: LP locked DURING the notice votes no, and the dust spend fails (1160)', async () => {
        const { dust, dc, payee, opens, closes } = await dustSpend();

        // The defender reacts: a lock made 60 s after the proposal appeared.
        blockchain.now = 1800000000 + 60;
        expect(blockchain.now).toBeLessThan(opens);
        await lateDeposit(whale, toNano('5000'), 3);
        const wc = childOf(whale.address);
        expect((await wc.getPosition(0)).weightSince).toEqual(1800000000 + 60);

        blockchain.now = opens;
        const yes = await dc.sendVote(dust.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect(yes.transactions).not.toHaveTransaction({ aborted: true });
        const no = await wc.sendVote(whale.getSender(), { seq: 0, support: false, positionId: 0, value: FORWARD });
        expect(no.transactions).not.toHaveTransaction({ aborted: true });
        const tally = await treasury.getProposal(0);
        expect(tally.yes).toEqual(1n);
        expect(tally.no).toEqual(toNano('5000') * 30n);

        blockchain.now = closes;
        expect((await treasury.getExecutable(0)).reason).toEqual(1160);
        const ex = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(ex.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1160, // treasury_vote_failed
        });
        expect(ex.transactions).not.toHaveTransaction({ from: treasury.address, to: payee.address });
    });

    // [LIMIT] — D-173 as signed still refuses, and an unopposed dust spend still pays.
    it('R2-H1: a lock made once the vote is OPEN still cannot vote (1202) — D-173 stands', async () => {
        const { dust, dc, payee, opens, closes } = await dustSpend();
        blockchain.now = opens;
        await dc.sendVote(dust.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });

        // The vote's own second, and a minute into it.
        for (const t of [opens, opens + 60]) {
            blockchain.now = t;
            await lateDeposit(whale, toNano('5000'), 3);
        }
        const wc = childOf(whale.address);
        for (const positionId of [0, 1]) {
            const r = await wc.sendVote(whale.getSender(), { seq: 0, support: false, positionId, value: FORWARD });
            expect(r.transactions).toHaveTransaction({
                to: treasury.address,
                exitCode: 1202, // treasury_vote_locked_late
            });
        }
        expect((await treasury.getProposal(0)).no).toEqual(0n);

        // NOT OVERCLAIMED: the notice makes the spend OPPOSABLE, it does not stop
        // it. Nobody locked in time and voted no, so it still pays — after the
        // notice and the vote, never before.
        blockchain.now = closes;
        const ex = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(ex.transactions).not.toHaveTransaction({ aborted: true });
        expect(ex.transactions).toHaveTransaction({
            from: treasury.address,
            to: payee.address,
            value: toNano('24'),
            success: true,
        });
    });

    // [FIX] THE BOUNDARY, to the second: `weightSince < opens` is strict.
    it('a lock in the last second of the notice votes; a lock in the first second of the vote does not', async () => {
        const { dust, dc, payee, opens, closes } = await dustSpend();
        blockchain.now = opens - 1;
        await lateDeposit(whale, toNano('5000'), 3); // position 0, weightSince = opens − 1
        blockchain.now = opens;
        await lateDeposit(minnow, toNano('5000'), 3); // weightSince = opens

        await dc.sendVote(dust.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        const inTime = await childOf(whale.address).sendVote(whale.getSender(), {
            seq: 0, support: false, positionId: 0, value: FORWARD,
        });
        expect(inTime.transactions).not.toHaveTransaction({ aborted: true });
        const late = await childOf(minnow.address).sendVote(minnow.getSender(), {
            seq: 0, support: false, positionId: 0, value: FORWARD,
        });
        expect(late.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1202 });
        // Only the in-time lock is in the tally.
        expect((await treasury.getProposal(0)).no).toEqual(toNano('5000') * 30n);

        blockchain.now = closes;
        const ex = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(ex.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1160 });
        expect(ex.transactions).not.toHaveTransaction({ from: treasury.address, to: payee.address });
    });

    // [FIX] D-173 as amended 2026-11-21: THE DEFENDER MOVES LAST. Before it, the
    // proposer read the defender's lock and topped up at `opens − 1`, and from
    // `opens` the defender could not answer (1202) — the spend paid. A YES now needs
    // weight held since the proposal's own second, so the top-up cannot vote yes.
    it('the proposer tops up in the last second of the notice — the top-up cannot vote yes, the spend fails', async () => {
        const { dust, dc, payee, opens, closes } = await dustSpend();
        blockchain.now = 1800000000 + 60;
        await lateDeposit(whale, toNano('5000'), 3); // the defender: 150,000 units
        const wc = childOf(whale.address);

        blockchain.now = opens - 1;
        const topUp = await lateDeposit(dust, toNano('6000'), 3); // the proposer: 180,000 units
        expect(topUp.transactions).not.toHaveTransaction({ aborted: true });

        blockchain.now = opens;
        // The proposer's original dust (locked in the proposal's own second) votes;
        // its top-up does not.
        const own = await dc.sendVote(dust.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect(own.transactions).not.toHaveTransaction({ aborted: true });
        const late = await dc.sendVote(dust.getSender(), { seq: 0, support: true, positionId: 1, value: FORWARD });
        expect(late.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1202 });
        // The defender, locked during the notice, votes no.
        const no = await wc.sendVote(whale.getSender(), { seq: 0, support: false, positionId: 0, value: FORWARD });
        expect(no.transactions).not.toHaveTransaction({ aborted: true });

        const tally = await treasury.getProposal(0);
        expect(tally.yes).toEqual(1n);
        expect(tally.no).toEqual(toNano('5000') * 30n);

        blockchain.now = closes;
        const ex = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(ex.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1160 });
        expect(ex.transactions).not.toHaveTransaction({ from: treasury.address, to: payee.address });
    });

    // [FIX] The yes boundary, to the second: weight held AT the proposal's own
    // second votes yes; one second later does not, and the same position may still
    // vote no.
    it('a yes needs weight held since the proposal second; a lock one second later votes only no', async () => {
        const { opens } = await dustSpend();
        const proposed = opens - NOTICE;
        blockchain.now = proposed + 1;
        await lateDeposit(whale, toNano('5000'), 3);
        const wc = childOf(whale.address);
        blockchain.now = opens;
        const yes = await wc.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        expect(yes.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1202 });
        // The refusal bounced the child's record away, so the same position votes no.
        const no = await wc.sendVote(whale.getSender(), { seq: 0, support: false, positionId: 0, value: FORWARD });
        expect(no.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getProposal(0)).no).toEqual(toNano('5000') * 30n);
    });

    // [FIX] in the sense that the case did not exist before the notice did.
    it('a position that matures during the notice does not vote', async () => {
        // The other edge of a notice: weight is read at VOTE time (TR-7), so a
        // 30-day term that ends before `opens` has nothing to cast.
        const child = await seedElectorate();
        await deposit(minnow, toNano('1000'), 0);
        const mc = childOf(minnow.address);
        const { maturesAt } = await mc.getPosition(0);
        blockchain.now = maturesAt - NOTICE; // proposed with exactly a notice of term left
        await proposeAt(child);
        await openVote();
        expect(blockchain.now).toEqual(maturesAt);
        const r = await mc.sendVote(minnow.getSender(), { seq: 0, support: false, positionId: 0, value: FORWARD });
        expect(r.transactions).toHaveTransaction({ to: mc.address, exitCode: 1169 }); // position_no_vote_weight
    });

    it('refuses a vote on a sequence number that was never opened', async () => {
        const child = await seedElectorate();
        const r = await child.sendVote(whale.getSender(), {
            seq: 42,
            support: true,
            positionId: 0,
            value: FORWARD,
        });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1153, // treasury_no_proposal
        });
    });

    // -----------------------------------------------------------------------
    // 4. Execute.
    // -----------------------------------------------------------------------

    async function openAndPass(opts: {
        asset: number;
        amount: bigint;
        dest: Address;
        vote?: boolean;
    }) {
        const child = await seedElectorate();
        await child.sendPropose(whale.getSender(), {
            asset: opts.asset,
            amount: opts.amount,
            dest: opts.dest,
            positionId: 0,
            value: FORWARD,
        });
        await openVote();
        if (opts.vote !== false) {
            await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        }
        return child;
    }

    it('refuses an execute before the vote closes', async () => {
        await openAndPass({ asset: TreasuryAsset.GRAM, amount: toNano('1'), dest: minnow.address });
        expect((await treasury.getExecutable(0)).reason).toEqual(1158);
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1158, // treasury_not_closed
        });
    });

    it('refuses an execute on a tie — the incumbent state keeps the money', async () => {
        // Two equal 6-month positions, one yes and one no. No quorum means a
        // simple majority of votes cast, and `yes > no` is strict.
        await lateDeposit(whale, toNano('1000'), 2);
        await deposit(minnow, toNano('1000'), 2);
        const wc = childOf(whale.address);
        const mc = childOf(minnow.address);
        await wc.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.GRAM,
            amount: toNano('1'),
            dest: minnow.address,
            positionId: 0,
            value: FORWARD,
        });
        await openVote();
        await wc.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
        await mc.sendVote(minnow.getSender(), { seq: 0, support: false, positionId: 0, value: FORWARD });
        const p = await treasury.getProposal(0);
        expect(p.yes).toEqual(p.no);

        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
        expect((await treasury.getExecutable(0)).reason).toEqual(1160);
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1160, // treasury_vote_failed
        });
    });

    it('refuses an execute above 25% of the asset balance AT EXECUTE TIME (TR-3)', async () => {
        // The treasury holds ~100 GRAM. A 40 GRAM proposal is above the cap.
        await openAndPass({ asset: TreasuryAsset.GRAM, amount: toNano('40'), dest: minnow.address });
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
        const view = await treasury.getExecutable(0);
        expect(view.executable).toBe(false);
        expect(view.reason).toEqual(1161);
        expect(view.cap).toBeLessThan(toNano('40'));
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1161, // treasury_cap_exceeded
        });
        expect((await treasury.getProposal(0)).executed).toEqual(0);
    });

    it('refuses an execute whose asset fell below the amount after the vote passed (1162)', async () => {
        // TR-3's other half: `available` is read AT EXECUTE TIME, so a balance that
        // dropped between the vote and the execute refuses by name, ahead of the cap.
        await openAndPass({ asset: TreasuryAsset.GRAM, amount: toNano('10'), dest: minnow.address });
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
        expect((await treasury.getExecutable(0)).executable).toBe(true);

        (await blockchain.getContract(treasury.address)).balance = toNano('5'); // the sandbox balance seam
        expect((await treasury.getExecutable(0)).reason).toEqual(1162);
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            success: false,
            exitCode: 1162, // treasury_insufficient_asset
        });
        expect(r.transactions).not.toHaveTransaction({ from: treasury.address, to: minnow.address });
        expect((await treasury.getProposal(0)).executed).toEqual(0);
    });

    it('executes a passed GRAM proposal permissionlessly, once', async () => {
        await openAndPass({ asset: TreasuryAsset.GRAM, amount: toNano('10'), dest: minnow.address });
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
        expect((await treasury.getExecutable(0)).executable).toBe(true);

        // A STRANGER pushes it — the vesting lock's `release` precedent: no field
        // here names a destination or an amount, so who calls it cannot matter.
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(r.transactions).toHaveTransaction({
            from: treasury.address,
            to: minnow.address,
            value: toNano('10'),
            success: true,
        });
        expect((await treasury.getProposal(0)).executed).toEqual(1);

        const again = await treasury.sendExecute(stranger.getSender(), {
            seq: 0,
            value: toNano('1'),
        });
        expect(again.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1159, // treasury_already_executed
        });
    });

    it('executes a PRIMES proposal out of the whole PRIMES balance (D-168: nothing accrues)', async () => {
        await treasury.sendTransferNotification(primesWallet.getSender(), {
            amount: toNano('1000'),
            from: deployer.address,
            value: toNano('0.1'),
        });
        await openAndPass({
            asset: TreasuryAsset.PRIMES,
            amount: toNano('200'),
            dest: minnow.address,
        });
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;

        // Nothing accrues inside the treasury since D-168 (TR-1 is deleted), so
        // the cap is 25% of the WHOLE balance.
        const view = await treasury.getExecutable(0);
        expect(view.available).toEqual(toNano('1000'));
        expect(view.cap).toEqual(toNano('250'));

        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const paid = jettonSentTo(r, primesWallet.address);
        expect(paid).toHaveLength(1);
        expect(paid[0].amount).toEqual(toNano('200'));
        expect(paid[0].destination.toString()).toEqual(minnow.address.toString());
        expect((await treasury.getTreasuryBalances()).primesBalance).toEqual(toNano('800'));
    });

    it('has no LP a proposal can name — every LP token is a depositor\'s (TR-5, D-167)', async () => {
        // 1000 LP of depositor money is in the wallet from the electorate seed.
        const child = await seedElectorate();

        // No asset id past tsTON exists, so a proposal cannot name LP at all.
        // (D-194's venue confirm, 3, is the last kind and moves no value.)
        const r = await child.sendPropose(whale.getSender(), {
            asset: TreasuryAsset.VENUE + 1,
            amount: toNano('1'),
            dest: minnow.address,
            positionId: 0,
            value: FORWARD,
        });
        expect(r.transactions).toHaveTransaction({ to: treasury.address, exitCode: 102 }); // malformed_body
        expect((await treasury.getGov()).proposalSeq).toEqual(0);

        // The retired donate tag refunds like any unrecognised one, so no LP ever
        // sits in the treasury outside a position.
        const donated = await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('100'),
            from: deployer.address,
            value: FORWARD,
            forwardPayload: beginCell().storeUint(0x54444f4e, 32).endCell(), // "TDON"
        });
        const refunds = jettonSentTo(donated, lpWallet.address);
        expect(refunds).toHaveLength(1);
        expect(refunds[0].amount).toEqual(toNano('100'));
        expect((await treasury.getTreasuryBalances()).lpHeld).toEqual(toNano('1000'));
    });

    // -----------------------------------------------------------------------
    // 4a. D-151 / §4.3.2 — tsTON, the fourth asset.
    //
    // `harvest()` on the ratchet sends realized staking yield here as a plain
    // TEP-74 transfer, and LP governs its spending like any other asset. These
    // two tests are the whole of what that adds: a credit that only the tsTON
    // wallet can make, and a proposal round trip that gets it back out.
    // -----------------------------------------------------------------------

    it('credits tsTON from harvest and spends it by proposal — the full round trip', async () => {
        // 1. The harvest arrives. NO PAYLOAD: tsTON has exactly one meaning
        //    here, so unlike LP there is nothing for a tag to select between.
        const credit = await treasury.sendTransferNotification(tstonWallet.getSender(), {
            amount: toNano('40'),
            from: deployer.address,
            value: toNano('0.1'),
        });
        expect(credit.transactions).not.toHaveTransaction({ aborted: true });
        expect((await treasury.getTreasuryBalances()).tstonBalance).toEqual(toNano('40'));

        // 2. It is not PRIMES: `distribute()`'s base did not move.
        expect((await treasury.getTreasuryBalances()).primesBalance).toEqual(0n);

        // 3. Propose, vote, wait out the day.
        await openAndPass({
            asset: TreasuryAsset.TSTON,
            amount: toNano('9'),
            dest: minnow.address,
        });
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;

        // The whole balance is available.
        const view = await treasury.getExecutable(0);
        expect(view.available).toEqual(toNano('40'));
        expect(view.cap).toEqual(toNano('10')); // 25%, TR-3
        expect(view.executable).toBe(true);

        // 4. Execute: the jetton leaves through the treasury's OWN tsTON wallet.
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const paid = jettonSentTo(r, tstonWallet.address);
        expect(paid).toHaveLength(1);
        expect(paid[0].amount).toEqual(toNano('9'));
        expect(paid[0].destination.toString()).toEqual(minnow.address.toString());
        expect((await treasury.getTreasuryBalances()).tstonBalance).toEqual(toNano('31'));
        // And it went out of the tsTON wallet only — no other asset moved.
        expect(jettonSentTo(r, primesWallet.address)).toHaveLength(0);
        expect(jettonSentTo(r, lpWallet.address)).toHaveLength(0);
    });

    it('credits nothing on a tsTON notification from a wallet that is not ours', async () => {
        // THE SENDER CHECK IS THE WHOLE AUTHENTICATION on this edge. A stranger
        // claiming to have delivered tsTON reaches the LP arm instead and is
        // refused there — `treasury_wrong_wallet` — because a forged
        // notification names a jetton this contract has no wallet for.
        const r = await treasury.sendTransferNotification(stranger.getSender(), {
            amount: toNano('1000'),
            from: stranger.address,
            value: toNano('0.1'),
        });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 1151, // treasury_wrong_wallet
        });
        expect((await treasury.getTreasuryBalances()).tstonBalance).toEqual(0n);
    });

    it('makes a bounced execute retryable — the retry_credit precedent', async () => {
        // A bounceable GRAM payout to an address with no contract at it bounces.
        // `executed` was already set when the send went out, so without the
        // bounce handler the proposal would be lost forever.
        await openAndPass({ asset: TreasuryAsset.GRAM, amount: toNano('10'), dest: DEAD_ADDRESS });
        blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
        const r = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
        // The payout left and came back.
        expect(r.transactions).toHaveTransaction({
            from: treasury.address,
            to: DEAD_ADDRESS,
            inMessageBounced: false,
        });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            inMessageBounced: true,
        });
        // Reset, and executable again by anyone.
        expect((await treasury.getProposal(0)).executed).toEqual(0);
        expect((await treasury.getExecutable(0)).executable).toBe(true);
    });

    // -----------------------------------------------------------------------
    // 5. Solvency and the get-method surface (§9.1).
    // -----------------------------------------------------------------------

    it('publishes the config a reader needs and nothing that grants authority', async () => {
        const cfg = await treasury.getTreasuryConfig();
        expect(cfg.operatorAddr.toString()).toEqual(operator.address.toString());
        expect(cfg.sinkAddr.toString()).toEqual(sink.address.toString());
        const dist = await treasury.getDistribution();
        expect(dist.rateBps).toEqual(RATE_BPS_PER_DAY);
        expect(dist.stakeAddr.toString()).toEqual(STAKE_STANDIN.toString());
        expect(dist.interval).toEqual(params.staking.epoch_seconds);
        // The operator address is a published FACT, not a capability: the
        // operator has no message on this contract that anyone else lacks.
        const r = await operator.send({
            to: treasury.address,
            value: toNano('1'),
            body: beginCell().storeUint(0x96000001, 32).storeUint(0, 64)
                .storeAddress(operator.address).storeAddress(operator.address).endCell(),
        });
        expect(r.transactions).toHaveTransaction({
            to: treasury.address,
            exitCode: 100, // wrong_sender
        });
    });

    it('reports the four tiers from the contract, not from a config file', async () => {
        expect(await treasury.getVoteMultipliers()).toEqual(TREASURY_TIERS.map((t) => t.voteMultiplier));
        expect(await treasury.getTierTerms()).toEqual(TREASURY_TIERS.map((t) => t.termSeconds));
        const actions = await treasury.getTreasuryActions();
        expect(actions.deposit).toEqual(0x54444550); // "TDEP"
        expect(await treasury.getTreasuryMinForward()).toEqual({
            treasuryMinForward: 150000000n,
            distributeMinForward: 150000000n,
        });
    });

    it('counts deposits the way the burn sink counts its own events', async () => {
        // `getTreasuryCounts()` is `(depositEvents, distributeEvents)` — the
        // indexer's reconciliation pair. A deposit that only refunds (bad payload)
        // increments nothing, because nothing was recorded for it.
        expect(await treasury.getTreasuryCounts()).toEqual({ depositEvents: 0, distributeEvents: 0 });
        await seedElectorate();
        expect(await treasury.getTreasuryCounts()).toEqual({ depositEvents: 1, distributeEvents: 0 });
        await deposit(minnow, toNano('10'), 0);
        expect(await treasury.getTreasuryCounts()).toEqual({ depositEvents: 2, distributeEvents: 0 });
        await treasury.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('1'),
            from: minnow.address,
            value: FORWARD,
        });
        expect(await treasury.getTreasuryCounts()).toEqual({ depositEvents: 2, distributeEvents: 0 });
    });

    // -----------------------------------------------------------------------
    // D-188 point 7 — THE TREASURY'S STATE IS O(LIVE PROPOSALS). Config 43 caps
    // an account at 65,536 cells; a vote book of one row per (proposal,
    // position) filled it for ~650-900 GRAM of dust votes. Votes are recorded on
    // the voter's child now, and settled proposals are deleted.
    // -----------------------------------------------------------------------
    describe('storage ceiling · D-188 point 7', () => {
        async function cellsOf(addr: Address): Promise<number> {
            const acc = (await blockchain.getContract(addr)).account;
            const state = acc.account!.storage.state;
            if (state.type !== 'active') throw new Error('not active');
            const seen = new Set<string>();
            const walk = (c: Cell) => {
                const h = c.hash().toString('hex');
                if (seen.has(h)) return;
                seen.add(h);
                c.refs.forEach(walk);
            };
            walk(state.state.data!);
            return seen.size;
        }

        async function propose(child: SandboxContract<PrimesLpPosition>) {
            await child.sendPropose(whale.getSender(), {
                asset: TreasuryAsset.GRAM,
                amount: toNano('1'),
                dest: whale.address,
                positionId: 0,
                value: FORWARD,
            });
        }

        it('many votes on one proposal do not grow the treasury per vote', async () => {
            const voters: SandboxContract<TreasuryContract>[] = [];
            for (let i = 0; i < 12; i++) {
                const v = await blockchain.treasury(`dust${i}`);
                await lateDeposit(v, 1n, 0); // one nano-LP: the dust the attack used
                voters.push(v);
            }
            const child = await seedElectorate();
            await propose(child);
            await openVote();
            const afterPropose = await cellsOf(treasury.address);
            for (const v of voters) {
                const r = await childOf(v.address).sendVote(v.getSender(), {
                    seq: 0,
                    support: false,
                    positionId: 0,
                    value: FORWARD,
                });
                expect(r.transactions).not.toHaveTransaction({ aborted: true });
            }
            expect((await treasury.getProposal(0)).no).toEqual(12n);
            expect(await cellsOf(treasury.address)).toEqual(afterPropose);
        });

        it('returns to its baseline once a closed proposal is pruned', async () => {
            const child = await seedElectorate();
            const baseline = await cellsOf(treasury.address);
            await propose(child);
            // IN ITS NOTICE: not prunable, whatever the tally (audit R2-H1).
            expect(await treasury.getPrunable(0)).toBe(false);
            const inNotice = await treasury.sendPrune(stranger.getSender(), { seq: 0 });
            expect(inNotice.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1205 });
            await openVote();
            await child.sendVote(whale.getSender(), { seq: 0, support: false, positionId: 0, value: FORWARD });
            expect(await cellsOf(treasury.address)).toBeGreaterThan(baseline);

            // Still voting: not prunable, and the refusal is readable first.
            expect(await treasury.getPrunable(0)).toBe(false);
            const early = await treasury.sendPrune(stranger.getSender(), { seq: 0 });
            expect(early.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1205 });

            // Failed (no > yes) and closed: prunable at once.
            blockchain.now = 1800000000 + NOTICE + VOTE_DURATION;
            expect(await treasury.getPrunable(0)).toBe(true);
            const r = await treasury.sendPrune(stranger.getSender(), { seq: 0 });
            expect(r.transactions).toHaveTransaction({ to: treasury.address, success: true });
            expect((await treasury.getProposal(0)).opens).toEqual(0);
            expect(await cellsOf(treasury.address)).toEqual(baseline);
        });

        it('keeps a PASSED proposal for one execute window, then lets it go', async () => {
            const child = await seedElectorate();
            await propose(child);
            await openVote();
            await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
            blockchain.now = 1800000000 + NOTICE + VOTE_DURATION;
            expect(await treasury.getPrunable(0)).toBe(false); // still executable
            // The execute window is one VOTE length after `closes` — to its last second.
            blockchain.now = 1800000000 + NOTICE + 2 * VOTE_DURATION - 1;
            expect(await treasury.getPrunable(0)).toBe(false);
            expect((await treasury.getExecutable(0)).executable).toBe(true);
            blockchain.now = 1800000000 + NOTICE + 2 * VOTE_DURATION;
            // The window has lapsed: execute refuses, readably, and prune is allowed.
            expect(await treasury.getExecutable(0)).toMatchObject({ executable: false, reason: 1204 });
            const late = await treasury.sendExecute(stranger.getSender(), { seq: 0, value: toNano('1') });
            expect(late.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1204 });
            expect(await treasury.getPrunable(0)).toBe(true);
        });

        it('every propose prunes the oldest due proposal, and frees its slot', async () => {
            const child = await seedElectorate();
            await propose(child); // seq 0, no votes: fails at close
            blockchain.now = 1800000000 + NOTICE + VOTE_DURATION;
            await propose(child); // seq 1 prunes seq 0 on the way in
            expect((await treasury.getProposal(0)).opens).toEqual(0);
            // Proposed at seq 0's close; its own vote opens a notice later.
            expect((await treasury.getProposal(1)).opens).toEqual(1800000000 + NOTICE + VOTE_DURATION + NOTICE);
            expect((await treasury.getGov()).proposalSeq).toEqual(2);
        });

        it("the child forgets a vote the treasury refused, and a lapsed one", async () => {
            const child = await seedElectorate();
            // A vote on a proposal that does not exist yet bounces; the record goes with it.
            const r = await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
            expect(r.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1153 });
            expect(await child.getHasVoted(0, 0)).toBe(false);

            await propose(child);
            await openVote();
            await child.sendVote(whale.getSender(), { seq: 0, support: true, positionId: 0, value: FORWARD });
            expect(await child.getHasVoted(0, 0)).toBe(true);
            const withRecord = await cellsOf(child.address);

            // One vote duration later the record is pruned by the next vote.
            blockchain.now = 1800000000 + NOTICE + VOTE_DURATION + 1;
            await propose(child); // seq 1
            await openVote(1);
            await child.sendVote(whale.getSender(), { seq: 1, support: true, positionId: 0, value: FORWARD });
            expect(await child.getHasVoted(0, 0)).toBe(false);
            expect(await child.getHasVoted(1, 0)).toBe(true);
            expect(await cellsOf(child.address)).toEqual(withRecord);
        });

        it('refuses a vote whose proposal would outlive the child record (1203)', async () => {
            // A hand-built `vote` from the child's own address stands in for the
            // race: a record written before the proposal opened.
            const child = await seedElectorate();
            await propose(child);
            const opens = (await treasury.getProposal(0)).opens;
            blockchain.now = opens; // past the notice, or 1206 would answer first
            const pos = await child.getPosition(0);
            const body = beginCell()
                .storeUint(0x96000004, 32)
                .storeUint(0, 64)
                .storeAddress(whale.address)
                .storeUint(0, 32)
                .storeUint(toNano('1000') * 10n, 128)
                .storeUint(1, 8)
                .storeUint(0, 32)
                .storeUint(pos.weightSince, 40)
                .storeUint(opens + VOTE_DURATION - 1, 40) // lapses a second before close
                .endCell();
            const r = await blockchain.sendMessage(
                internal({ from: child.address, to: treasury.address, value: FORWARD, body })
            );
            expect(r.transactions).toHaveTransaction({ to: treasury.address, exitCode: 1203 });
            expect((await treasury.getProposal(0)).yes).toEqual(0n);
        });
    });
});
