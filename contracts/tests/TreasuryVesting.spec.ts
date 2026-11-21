// TON PRIMES — THE TREASURY VESTING LOCK (CONCEPT.md §2 point 4 / §3.3 / §6
// point 3; DECISIONS.md D-166, which amends D-100 point 6, which amended D-91,
// D-77 point 2 and D-46 points 1 and 3).
//
// D-100 point 6 split the vest into two instances of `primes_vesting.tolk`, one
// to the operator's wallet and one to the treasury contract. D-166 DELETED the
// operator's instance; this file was `OperatorVesting.spec.ts` and now covers the
// one lock genesis still deploys. Its beneficiary is a CONTRACT
// (`primes_treasury.tolk`, which has no key at all — D-100 point 7), so every
// claim below has to hold when the recipient cannot sign anything. The last
// block tests exactly that hop, because a vest that silently fails to land is
// the worst failure this contract could have.
//
// What each instance has to establish, because the whole point of the contract
// is a claim about what it CANNOT do:
//   1. the schedule is real — nothing moves early, and each 90-day step releases
//      exactly `1 / VEST_TRANCHES` of the allocation;
//   2. it is exact — the last release empties the lock to the nanoPRIMES, with
//      no stranded dust from the truncating divisions before it;
//   3. it cannot be steered — `release` is permissionless, so a stranger can
//      call it, and when they do the PRIMES still land on the beneficiary and
//      nowhere else. There is no message that names a recipient, no owner field,
//      and no opcode that is not one of the two declared.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesVesting, VEST_TRANCHES, VEST_INTERVAL } from '../wrappers/PrimesVesting';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { PrimesTreasury } from '../wrappers/PrimesTreasury';
import { PrimesLpSink } from '../wrappers/PrimesLpSink';
import params from '../../shared/params.json';

/** The one lock genesis deploys (D-166), sized from `shared/params.json`. */
const INSTANCES = [
    {
        label: 'treasury (beneficiary: a CONTRACT with no key)',
        total: toNano(String(params.genesis.vesting.treasury.total_primes)),
    },
] as const;

/**
 * Every expectation below divides by this rather than by a literal. D-91 re-cut
 * the schedule from D-77's nine tranches to four and every hardcoded `9n` in
 * this file had to be found by hand; deriving them means the next re-cut is one
 * constant in `primes_vesting.tolk` and its wrapper mirror, not a grep.
 */
const TRANCHES = BigInt(VEST_TRANCHES);
/** The clock offset at which the final tranche has matured. */
const LAST_UNLOCK = (VEST_TRANCHES - 1) * VEST_INTERVAL;

const START = 1_770_000_000;
/**
 * 0.2 TON. The contract's floor is `TRANSFER_GAS + NOTIFY_GAS` = 0.15 — the
 * 0.1 TON transfer hop plus the 0.05 TON that rides it as `forwardTonAmount` so
 * a CONTRACT beneficiary gets a `transfer_notification` (D-100 point 6; see
 * block 5). This sends the floor plus a margin rather than the floor exactly,
 * which is the repo's standing rule for any on-chain send (CLAUDE.md: nominal
 * plus a fee margin, never the exact figure) and is also what keeps this
 * constant from silently becoming the thing under test.
 */
const RELEASE_VALUE = toNano('0.2');

let walletCode: Cell;
let masterCode: Cell;
let vestingCode: Cell;
let treasuryCode: Cell;
let positionCode: Cell;
let lpSinkCode: Cell;

beforeAll(async () => {
    walletCode = await compile('PrimesJettonWallet');
    masterCode = await compile('PrimesJettonMaster');
    vestingCode = await compile('PrimesVesting');
    // D-100 point 6's second beneficiary. Deployed for real rather than stood in
    // for by a bare address, because the claim under test is that PRIMES reach a
    // contract that cannot sign — and only a real contract can fail to receive.
    treasuryCode = await compile('PrimesTreasury');
    positionCode = await compile('PrimesLpPosition');
    lpSinkCode = await compile('PrimesLpSink');
});

describe.each(INSTANCES)('TON PRIMES — vesting lock: $label', (instance) => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    /** A plain wallet: the treasury's recorded operator, and a non-beneficiary sender. */
    let operator: SandboxContract<TreasuryContract>;
    /** Nobody. Calls `release` to prove permissionless does not mean unsafe. */
    let stranger: SandboxContract<TreasuryContract>;

    let master: SandboxContract<PrimesJettonMaster>;
    let vesting: SandboxContract<PrimesVesting>;
    /** Whoever this instance pays: the governed treasury contract. */
    let beneficiary: import('@ton/core').Address;
    let beneficiaryWallet: SandboxContract<PrimesJettonWallet>;
    let vestingWallet: SandboxContract<PrimesJettonWallet>;

    const ALLOCATION = instance.total;

    /** The genesis sequence for this contract alone: deploy, mint in, bootstrap. */
    async function bootstrap(opts: { setWallet?: boolean } = {}) {
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vesting.address,
            amount: ALLOCATION,
            value: toNano('0.3'),
        });
        if (opts.setWallet === false) return;
        const addr = await master.getWalletAddress(vesting.address);
        await vesting.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: addr,
            value: toNano('0.05'),
        });
    }

    /** PRIMES actually delivered to the beneficiary, read off their own wallet. */
    async function beneficiaryBalance(): Promise<bigint> {
        const state = await blockchain.getContract(beneficiaryWallet.address);
        if (state.accountState?.type !== 'active') return 0n;
        return (await beneficiaryWallet.getWalletData()).balance;
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = START;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        operator = await blockchain.treasury('operator');
        stranger = await blockchain.treasury('stranger');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        {
            // The real thing, deployed the way `genesisPipeline.deployAndWire`
            // deploys it: the LP sink first (its address is in the treasury's
            // init data and there is no setter), then the treasury.
            const lpSink = blockchain.openContract(
                PrimesLpSink.createFromConfig({ genesisScriptAddr: genesisScript.address }, lpSinkCode)
            );
            await lpSink.sendDeploy(deployer.getSender(), toNano('0.5'));
            const treasury = blockchain.openContract(
                PrimesTreasury.createFromConfig(
                    {
                        operatorAddr: operator.address,
                        sinkAddr: lpSink.address,
                        stakeAddr: operator.address, // D-168: no distribute() in this spec
                    distributionRateBpsPerDay: params.staking.distribution_rate_bps_per_day,
                        positionCode,
                        genesisScriptAddr: genesisScript.address,
                    },
                    treasuryCode
                )
            );
            await treasury.sendDeploy(deployer.getSender(), toNano('0.6'));
            beneficiary = treasury.address;
        }

        vesting = blockchain.openContract(
            PrimesVesting.createFromConfig(
                {
                    beneficiary,
                    jettonMasterAddr: master.address,
                    genesisScriptAddr: genesisScript.address,
                    totalAmount: ALLOCATION,
                },
                vestingCode
            )
        );
        await vesting.sendDeploy(deployer.getSender(), toNano('0.6'));

        beneficiaryWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(beneficiary))
        );
        vestingWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(vesting.address))
        );
    });

    // -----------------------------------------------------------------------
    // 1. The schedule
    // -----------------------------------------------------------------------

    it('holds the whole allocation and releases nothing before the clock starts', async () => {
        await bootstrap({ setWallet: false });

        // The PRIMES are in custody, but `set_wallet` has not run, so the lock
        // does not know its own wallet and cannot transfer from it.
        expect((await vestingWallet.getWalletData()).balance).toBe(ALLOCATION);
        const v = await vesting.getVesting();
        expect(v.startTime).toBe(0);
        expect(v.totalAmount).toBe(ALLOCATION);
        expect(v.releasedAmount).toBe(0n);
        expect(v.unlocked).toBe(0);
        expect(v.nextUnlockAt).toBe(0);
        expect((await vesting.getVestingSchedule()).releasableNow).toBe(0n);

        const r = await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        expect(r.transactions).toHaveTransaction({ to: vesting.address, exitCode: 1140 }); // vest_wallet_unset
        expect(await beneficiaryBalance()).toBe(0n);
    });

    it('starts the clock at set_wallet, not at deploy', async () => {
        // Deploy happened at START; move time on before the bootstrap so the two
        // are distinguishable. The stamp must follow custody, not deployment.
        blockchain.now = START + 5_000;
        await bootstrap();

        const v = await vesting.getVesting();
        expect(v.startTime).toBe(START + 5_000);
        expect(v.tranches).toBe(VEST_TRANCHES);
        // Unlock 0 matures at `startTime` itself, so unlock 1 is one interval on.
        expect(v.nextUnlockAt).toBe(START + 5_000 + VEST_INTERVAL);
    });

    it('releases exactly one quarter at genesis and refuses a second before day 90', async () => {
        await bootstrap();

        expect((await vesting.getVestingSchedule()).releasableNow).toBe(ALLOCATION / TRANCHES);
        await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });

        expect(await beneficiaryBalance()).toBe(ALLOCATION / TRANCHES);
        expect((await vesting.getVesting()).releasedAmount).toBe(ALLOCATION / TRANCHES);
        expect((await vesting.getVestingSchedule()).releasableNow).toBe(0n);

        // One second before the day-90 boundary is still tranche 0's territory.
        blockchain.now = START + VEST_INTERVAL - 1;
        const early = await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        expect(early.transactions).toHaveTransaction({ to: vesting.address, exitCode: 1141 }); // vest_nothing_due
        expect(await beneficiaryBalance()).toBe(ALLOCATION / TRANCHES);
    });

    it('advances one tranche per 90 days', async () => {
        await bootstrap();
        await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });

        for (let i = 1; i <= 3; i++) {
            blockchain.now = START + i * VEST_INTERVAL;
            expect((await vesting.getVesting()).unlocked).toBe(i + 1);
            await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
            // The TARGET is cumulative and recomputed from the total each time,
            // which is what keeps the truncation from compounding.
            expect(await beneficiaryBalance()).toBe((ALLOCATION * BigInt(i + 1)) / TRANCHES);
        }
    });

    it('catches up every matured tranche in ONE call', async () => {
        await bootstrap();

        // Nobody touches it for three quarters, then someone does. Four unlocks
        // have matured (0, 1, 2, 3) and all four land in a single transfer —
        // `unlocked` is derived from the clock, not counted up per call.
        blockchain.now = START + 3 * VEST_INTERVAL;
        expect((await vesting.getVesting()).unlocked).toBe(4);
        expect((await vesting.getVestingSchedule()).releasableNow).toBe((ALLOCATION * TRANCHES) / TRANCHES);

        await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        expect(await beneficiaryBalance()).toBe((ALLOCATION * TRANCHES) / TRANCHES);
    });

    // -----------------------------------------------------------------------
    // 2. Exactness at the terminus
    // -----------------------------------------------------------------------

    it('empties to the nanoPRIMES at the last unlock, leaving no dust', async () => {
        await bootstrap();
        // Release each tranche in turn, so every truncating intermediate
        // targets all actually happen — the dust bug this guards against only
        // appears if the divisions are taken one at a time.
        for (let i = 0; i < VEST_TRANCHES; i++) {
            blockchain.now = START + i * VEST_INTERVAL;
            await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        }

        expect(blockchain.now).toBe(START + LAST_UNLOCK); // day 270 = 9 months
        expect(await beneficiaryBalance()).toBe(ALLOCATION);
        expect((await vestingWallet.getWalletData()).balance).toBe(0n);

        const v = await vesting.getVesting();
        expect(v.releasedAmount).toBe(ALLOCATION);
        expect(v.unlocked).toBe(VEST_TRANCHES);
        // Schedule complete: no next unlock to count down to.
        expect(v.nextUnlockAt).toBe(0);
    });

    it('has nothing left to give after the last tranche, however long anyone waits', async () => {
        await bootstrap();
        blockchain.now = START + LAST_UNLOCK;
        await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        expect(await beneficiaryBalance()).toBe(ALLOCATION);

        // A decade later, the schedule is still four tranches and still spent.
        blockchain.now = START + 40 * VEST_INTERVAL;
        expect((await vesting.getVesting()).unlocked).toBe(VEST_TRANCHES);
        const r = await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        expect(r.transactions).toHaveTransaction({ to: vesting.address, exitCode: 1141 }); // vest_nothing_due
        expect(await beneficiaryBalance()).toBe(ALLOCATION);
    });

    // -----------------------------------------------------------------------
    // 3. It cannot be steered
    // -----------------------------------------------------------------------

    it('pays the BENEFICIARY when a stranger calls release, never the caller', async () => {
        await bootstrap();
        const strangerWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(stranger.address))
        );

        await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });

        expect(await beneficiaryBalance()).toBe(ALLOCATION / TRANCHES);
        // The stranger's wallet was never even deployed — TEP-74 wallets deploy
        // lazily on first transfer, so its absence is the honest proof that
        // nothing was sent there.
        const state = await blockchain.getContract(strangerWallet.address);
        expect(state.accountState?.type).not.toBe('active');
    });

    it('refuses a second set_wallet, so the clock can never be restarted', async () => {
        await bootstrap();
        const started = (await vesting.getVesting()).startTime;

        blockchain.now = START + 4 * VEST_INTERVAL;
        const again = await vesting.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: await master.getWalletAddress(vesting.address),
            value: toNano('0.05'),
        });
        expect(again.transactions).toHaveTransaction({ to: vesting.address, exitCode: 104 }); // already_processed
        expect((await vesting.getVesting()).startTime).toBe(started);
    });

    it('refuses set_wallet from anyone but the genesis script', async () => {
        await bootstrap({ setWallet: false });
        const r = await vesting.sendSetWallet(operator.getSender(), {
            jettonWalletAddr: await master.getWalletAddress(vesting.address),
            value: toNano('0.05'),
        });
        expect(r.transactions).toHaveTransaction({ to: vesting.address, exitCode: 100 }); // wrong_sender
        expect((await vesting.getVesting()).startTime).toBe(0);
    });

    it('has no third opcode — every message that is not set_wallet or release throws', async () => {
        await bootstrap();
        // The shape an admin surface would have to arrive in. There is none:
        // no owner field, no cancel, no re-schedule, no beneficiary change, so
        // anything the operator sends beyond the two declared messages is
        // rejected exactly as a stranger's would be.
        for (const opcode of [0x95000003, 0x95000000, 0xdeadbeef]) {
            const r = await operator.send({
                to: vesting.address,
                value: toNano('0.2'),
                body: beginCell().storeUint(opcode, 32).storeUint(0, 64).endCell(),
            });
            expect(r.transactions).toHaveTransaction({ to: vesting.address, exitCode: 101 }); // wrong_opcode
        }
        expect(await beneficiaryBalance()).toBe(0n);
    });

    it('refuses an underfunded release rather than banking it', async () => {
        await bootstrap();
        // The failure mode this guards against is the expensive one: advancing
        // `releasedAmount` and then failing to pay, which would burn a tranche.
        const r = await vesting.sendRelease(stranger.getSender(), { value: toNano('0.05') });
        expect(r.transactions).toHaveTransaction({ to: vesting.address, exitCode: 103 }); // insufficient_value
        expect((await vesting.getVesting()).releasedAmount).toBe(0n);

        // 0.12 TON: ABOVE the 0.1 TON transfer hop and BELOW the 0.15 the send
        // now costs, because D-100 point 6 put a 0.05 TON `forwardTonAmount` on
        // it (see block 5). This value funded a release before that change and
        // must not fund one after it — a caller who kept paying the old figure
        // has to be refused, not paid a transfer whose notification leg the
        // destination wallet cannot afford to emit.
        const stale = await vesting.sendRelease(stranger.getSender(), { value: toNano('0.12') });
        expect(stale.transactions).toHaveTransaction({ to: vesting.address, exitCode: 103 });
        expect((await vesting.getVesting()).releasedAmount).toBe(0n);

        // and the tranche is still there to take, properly funded
        await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        expect(await beneficiaryBalance()).toBe(ALLOCATION / TRANCHES);
    });

    // -----------------------------------------------------------------------
    // 4. §9.1 — the numbers a dashboard is allowed to draw
    // -----------------------------------------------------------------------

    it('reports a schedule a reader can check against the wallet without trusting it', async () => {
        await bootstrap();
        blockchain.now = START + 2 * VEST_INTERVAL;
        await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });

        const v = await vesting.getVesting();
        const held = (await vestingWallet.getWalletData()).balance;
        // The §3.3 check, in one get-call each and no trust in the lock's own
        // arithmetic: what it says it has not yet released is what it holds.
        expect(v.totalAmount - v.releasedAmount).toBe(held);
        expect(v.beneficiary.toString()).toBe(beneficiary.toString());

        const cfg = await vesting.getVestingConfig();
        expect(cfg.walletSet).toBe(1);
        expect(cfg.jettonWalletAddr.toString()).toBe(vestingWallet.address.toString());
        expect(cfg.beneficiary.toString()).toBe(beneficiary.toString());
    });

    // -----------------------------------------------------------------------
    // 5. A bounced release is retryable, not stranded (B26)
    // -----------------------------------------------------------------------

    it('rolls back releasedAmount when the transfer bounces, and a retry re-sends the same tranche', async () => {
        // `onBouncedMessage`'s rollback (`storage.releasedAmount -= original
        // .amount` when the JettonTransfer to `b.jettonWalletAddr` bounces) had
        // zero coverage anywhere in this file or `BounceCoverage.spec.ts` —
        // B23's arm-by-arm read filed this as B26. Reuse Treasury.spec.ts's
        // (B25) dead-address trick rather than a real jetton wallet: `set_wallet`
        // accepts any address once and never again (see the refusal test
        // above), so pointing it at a bare address with no contract deployed
        // there makes every `release` bounce for real — exactly what a
        // destination wallet that cannot accept the forward looks like from
        // this contract's side.
        const DEAD_WALLET = Address.parse('0:' + 'e3'.repeat(32));
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vesting.address,
            amount: ALLOCATION,
            value: toNano('0.3'),
        });
        await vesting.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: DEAD_WALLET,
            value: toNano('0.05'),
        });

        const r1 = await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        expect(r1.transactions).toHaveTransaction({ from: vesting.address, to: DEAD_WALLET });
        expect(r1.transactions).toHaveTransaction({ to: vesting.address, inMessageBounced: true });
        // THE ROLLBACK: `releasedAmount` is back to zero, not stuck at one
        // tranche marked paid and never delivered — the failure mode that
        // would otherwise burn a quarter of the allocation permanently.
        expect((await vesting.getVesting()).releasedAmount).toBe(0n);
        expect((await vesting.getVestingSchedule()).releasableNow).toBe(ALLOCATION / TRANCHES);

        // RETRYABLE: a second `release` re-attempts the SAME tranche rather
        // than treating it as already paid and skipping it.
        const r2 = await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        expect(r2.transactions).toHaveTransaction({ from: vesting.address, to: DEAD_WALLET });
        expect(r2.transactions).toHaveTransaction({ to: vesting.address, inMessageBounced: true });
        expect((await vesting.getVesting()).releasedAmount).toBe(0n);
    });
});

// ---------------------------------------------------------------------------
// 5. D-100 point 6 — THE HOP INTO A CONTRACT BENEFICIARY, END TO END.
//
// The parametrised block above proves the treasury instance's SCHEDULE, which is
// the same schedule because it is the same contract. It does not prove that the
// treasury can USE what arrives, and those are different claims: the PRIMES land
// in the treasury's own TEP-74 jetton wallet either way, but the treasury's
// books — `primesBalance`, which is what the D-100 point 5 miner budgets from
// and what TR-1's solvency reading compares against — only move when a
// `transfer_notification` reaches the contract itself.
//
// THE GAP THIS BLOCK WAS WRITTEN TO PIN, NOW CLOSED. `primes_vesting.tolk` sent
// its `JettonTransfer` with `forwardTonAmount: 0`, and `primes_jetton_wallet
// .tolk` emits a `transfer_notification` only when that is positive. So a
// released tranche reached the treasury's WALLET and never reached the
// TREASURY: `primesBalance` stayed 0, the miner's daily budget — a fraction of
// `primesBalance` — stayed 0, and there is no reconcile path that could notice
// later, because nothing re-reads the wallet. PRIMES released under that
// contract would have been permanently uncounted, which is why it had to be
// fixed BEFORE genesis rather than after the first tranche.
//
// The fix is `NOTIFY_GAS` in `primes_vesting.tolk`: 0.05 TON forwarded on every
// release, unconditionally — the lock cannot tell a wallet beneficiary from a
// contract one, and a deploy-time flag saying which it is would be exactly the
// configurable surface that file exists to prove the absence of. The caller
// funds it (`release` is permissionless), and the 103 floor moved from 0.1 to
// 0.15 TON with it.
//
// So the assertions below are now all four load-bearing, and the last two are
// the ones that would have shipped a dead treasury: the transfer lands, the
// wallet moves, AND the treasury's own books move by exactly the tranche —
// end to end through the real jetton wallet, lock -> wallet -> wallet ->
// notification -> books. Nothing here stubs the notification; the companion
// test below does that, and on its own it proves nothing about this bug.
// ---------------------------------------------------------------------------
describe('TON PRIMES — D-100 point 6: the treasury vest actually arrives', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let operator: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let master: SandboxContract<PrimesJettonMaster>;
    let treasury: SandboxContract<PrimesTreasury>;
    let vesting: SandboxContract<PrimesVesting>;
    let treasuryPrimesWallet: SandboxContract<PrimesJettonWallet>;

    const ALLOCATION = toNano(String(params.genesis.vesting.treasury.total_primes));

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = START;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        operator = await blockchain.treasury('operator');
        stranger = await blockchain.treasury('stranger');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                { ledgerAddr: deployer.address, genesisScriptAddr: genesisScript.address, walletCode },
                masterCode
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        const lpSink = blockchain.openContract(
            PrimesLpSink.createFromConfig({ genesisScriptAddr: genesisScript.address }, lpSinkCode)
        );
        await lpSink.sendDeploy(deployer.getSender(), toNano('0.5'));
        treasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: operator.address,
                    sinkAddr: lpSink.address,
                    stakeAddr: operator.address, // D-168: no distribute() in this spec
                    distributionRateBpsPerDay: params.staking.distribution_rate_bps_per_day,
                    positionCode,
                    genesisScriptAddr: genesisScript.address,
                },
                treasuryCode
            )
        );
        await treasury.sendDeploy(deployer.getSender(), toNano('0.6'));

        // The genesis bootstrap, so the treasury would accept a notification if
        // one arrived. Without this every inbound is refused with 1150, and the
        // gap below would be indistinguishable from a missing `set_wallets`.
        treasuryPrimesWallet = blockchain.openContract(
            PrimesJettonWallet.createFromAddress(await master.getWalletAddress(treasury.address))
        );
        await treasury.sendSetWallets(genesisScript.getSender(), {
            lpJettonWallet: (await blockchain.treasury('lpwallet')).address,
            primesJettonWallet: treasuryPrimesWallet.address,
            value: toNano('0.05'),
        });
        expect((await treasury.getTreasuryConfig()).walletsSet).toBe(1);

        vesting = blockchain.openContract(
            PrimesVesting.createFromConfig(
                {
                    beneficiary: treasury.address,
                    jettonMasterAddr: master.address,
                    genesisScriptAddr: genesisScript.address,
                    totalAmount: ALLOCATION,
                },
                vestingCode
            )
        );
        await vesting.sendDeploy(deployer.getSender(), toNano('0.6'));
        await master.sendMintGenesis(genesisScript.getSender(), {
            to: vesting.address,
            amount: ALLOCATION,
            value: toNano('0.3'),
        });
        await vesting.sendSetWallet(genesisScript.getSender(), {
            jettonWalletAddr: await master.getWalletAddress(vesting.address),
            value: toNano('0.05'),
        });
    });

    it('lands tranche 0 in the treasury jetton wallet AND on the treasury books', async () => {
        const tranche = ALLOCATION / TRANCHES;

        const r = await vesting.sendRelease(stranger.getSender(), { value: RELEASE_VALUE });
        // 1. The transfer succeeded and did not bounce. This is the failure the
        //    whole block exists to rule out: a lock paying an address that
        //    rejects the message would strand the tranche, and `releasedAmount`
        //    would have advanced against PRIMES that came back.
        expect(r.transactions).toHaveTransaction({ to: vesting.address, success: true });
        expect(r.transactions).not.toHaveTransaction({ inMessageBounced: true });

        // 2. The PRIMES really are the treasury's: they sit in the TEP-74 wallet
        //    whose owner is the treasury contract, and the lock's own books agree.
        expect((await treasuryPrimesWallet.getWalletData()).balance).toBe(tranche);
        expect((await treasuryPrimesWallet.getWalletData()).owner.toString()).toBe(treasury.address.toString());
        expect((await vesting.getVesting()).releasedAmount).toBe(tranche);

        // 3. THE FIX, END TO END. `NOTIFY_GAS` rides the transfer, the
        //    destination wallet emits the `transfer_notification` it funds, and
        //    the treasury credits the tranche. `primesBalance` is the figure
        //    D-168's `distribute()` budgets from, so this assertion is the whole
        //    difference between a treasury that funds stakers and one that
        //    reads zero against a wallet holding a quarter of a million PRIMES.
        expect((await treasury.getTreasuryBalances()).primesBalance).toBe(tranche);
        expect((await treasury.getTreasuryBalances()).primesIn).toBe(tranche);

        // 4. And the notification really came from the chain, not from the test:
        //    the treasury's own PRIMES wallet is what delivered it, and the
        //    treasury transaction it triggered succeeded. A credit that appeared
        //    without this transaction would mean the assertion above was reading
        //    a stub.
        expect(r.transactions).toHaveTransaction({
            from: treasuryPrimesWallet.address,
            to: treasury.address,
            op: 0x7362d09c, // TEP-74 transfer_notification
            success: true,
        });
    });

    it('the treasury WOULD credit the same tranche if the notification arrived', async () => {
        // The other half of the finding, so that "the treasury cannot receive
        // PRIMES" is not read into it. Impersonating the treasury's own PRIMES
        // wallet — the sender check is the whole authentication on this edge —
        // the credit lands exactly. Nothing about the
        // treasury needs changing; the notification simply is not sent.
        const tranche = ALLOCATION / TRANCHES;
        await treasury.sendTransferNotification(blockchain.sender(treasuryPrimesWallet.address), {
            amount: tranche,
            from: vesting.address,
            value: toNano('0.2'),
        });

        const bal = await treasury.getTreasuryBalances();
        expect(bal.primesBalance).toBe(tranche);
        expect(bal.primesIn).toBe(tranche);
    });
});
