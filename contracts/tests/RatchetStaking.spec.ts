// TON PRIMES — §4.3.2, THE STAKED RESERVE (DECISIONS.md D-151, STAKING_PLAN P2).
//
// The ratchet's idle `pending` is deposited into Tonstakers above a sim-sized
// liquid reserve, held as tsTON, counted in `T` AT COST, brought back by rule
// when `flush()` needs it, and its accrual is realized to the LP-governed
// treasury as tsTON. This file is the non-vacuous proof of all of it.
//
// WHAT IT IS DRIVEN AGAINST. `contracts/test-mocks/mock_tonstakers_pool.tolk`,
// which parses the REAL upstream wire format rather than accepting any payload:
// the flat 1 GRAM deposit fee, the mint notification that is the only place the
// tsTON rate is ever learned, and the three withdrawal outcomes the pool
// actually has. There is no Tonstakers testnet deployment and there cannot be a
// useful one (STAKING_PLAN P0 point 1 — the rate only moves when a Controller
// lends to an approved validator that wins a testnet election), so the mock is
// the primary surface and not a fallback.
//
// WHY THE MOCK IS ALSO THE DEDUST VAULT HERE. It stands in for the pool, the
// pool-jetton minter, the ratchet's own tsTON wallet, DeDust's tsTON jetton
// vault and DeDust's native vault at once. The last two are forced: leg 2's swap
// is a TEP-74 `transfer` sent to our OWN tsTON wallet, and that wallet is this
// mock, so the swap cannot reach a separate double without a wallet hop that
// does not exist in a collapsed mock.
//
// THE ASSERTION SHAPE, and it is the one MISTAKES.md 2026-09-17 exists to
// impose: every one of these replies is NON-BOUNCEABLE, so the value is credited
// before the compute phase throws and A BALANCE ASSERTION CANNOT SEE THE BUG.
// Every test here asserts `not.toHaveTransaction({ aborted: true })` on the whole
// trace instead.
import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, toNano } from '@ton/core';
import { randomBytes } from 'crypto';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet, FLUSH_VALUE, HARVEST_VALUE, STAKE_VALUE, UNSTAKE_VALUE } from '../wrappers/PrimesRatchet';
import { MockTonstakersPool } from '../wrappers/MockTonstakersPool';
import { PrimesTreasury } from '../wrappers/PrimesTreasury';
import { RATCHET, TEP74 } from '../../shared/opcodes';
import { buildFlushMessage } from '../../shared/messages';
import params from '../../shared/params.json';

const HARVEST_INTERVAL = 2592000; // §4.3.2 / params `staked_reserve.harvest_interval_seconds`
const EXIT_RECOVERY = 259200; // D-155 — 72 h, 2x leg 3's ~36 h round
const STAKE_MIN = toNano(String(params.staked_reserve.stake_min_ton)); // the sim's, never a copy
const RESERVE_BPS = 2000n; // params `staked_reserve.reserve_fraction_of_pending` = 0.20
// params `staked_reserve.harvest_dust_tston`, floored to nano-tsTON — the sim's, never a copy
const HARVEST_DUST = BigInt(Math.floor(params.staked_reserve.harvest_dust_tston * 1e9));

/**
 * The exit restores the reserve to within a nanoton of the target. The dust is
 * one truncation: `unstake` converts GRAM -> tsTON at the cost basis to size the
 * tranche and back again to book `exitCostBasis`, and the round trip is floored
 * both ways deliberately — under-redeeming leaves the GRAM staked, where
 * over-redeeming would size the exit off a number the contract does not own.
 */
// A refill lands ON the target or a rounding step above it — never under, or the
// reserve reads short for ever and `unstake` stays open on a dust tranche
// (2026-11-21: testnet sat 1 nano short after a clean leg-1 refill).
function expectRestoredTo(pending: bigint, target: bigint) {
    expect(pending).toBeGreaterThanOrEqual(target);
    expect(pending - target).toBeLessThan(4n);
}

/** The whole trace is clean — never a balance check (MISTAKES.md 2026-09-17). */
function clean(r: any, label: string) {
    const bad = r.transactions
        .filter((t: any) => (t.description as any)?.aborted === true)
        .map((t: any) => ({
            to: t.inMessage?.info?.dest?.toString(),
            op: t.inMessage?.body?.beginParse?.().remainingBits >= 32
                ? '0x' + t.inMessage.body.beginParse().loadUint(32).toString(16)
                : 'empty',
            compute: (t.description as any)?.computePhase?.exitCode,
            action: (t.description as any)?.actionPhase?.resultCode,
        }));
    expect({ label, bad }).toEqual({ label, bad: [] });
    expect(r.transactions).not.toHaveTransaction({ aborted: true });
}

describe('TON PRIMES — §4.3.2 the staked reserve (D-151)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let fakeLedger: SandboxContract<TreasuryContract>;
    let primesWallet: SandboxContract<TreasuryContract>;
    let treasury: SandboxContract<TreasuryContract>;
    let keeper: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;

    let ratchet: SandboxContract<PrimesRatchet>;
    let pool: SandboxContract<MockTonstakersPool>;

    const INJECTED = toNano('1000');

    /**
     * §4.3.2's five-term identity, in the form this file can check without a
     * ledger: the ratchet's own obligation. `T = seeded + swapped + pending +
     * stakedCost + exiting` is asserted against the ledger's `T` in
     * `FuzzInvariants.spec.ts` I2; here `seeded` is 0 and `swapped` is whatever
     * `flush()` has taken, so what is left must be conserved by every staking
     * operation. `realizedLoss` is the sixth term and is the GRAM that left `T`
     * for good — it has to be counted or the sum falls silently.
     */
    async function obligation(): Promise<bigint> {
        const s = await ratchet.getStaking();
        return (await ratchet.getPending()) + (await ratchet.getSwapped()) + s.stakedCost + s.exiting + s.realizedLoss;
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1800000000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        fakeLedger = await blockchain.treasury('fakeLedger');
        primesWallet = await blockchain.treasury('primesWallet');
        treasury = await blockchain.treasury('treasury');
        keeper = await blockchain.treasury('keeper');
        stranger = await blockchain.treasury('stranger');

        const poolCode = await compile('MockTonstakersPool');
        const ratchetCode = await compile('PrimesRatchet');

        // 1 tsTON = 1 GRAM at genesis. `sendSetRate` moves it; nothing else can.
        pool = blockchain.openContract(
            MockTonstakersPool.createFromConfig({ rateNum: toNano('1'), rateDen: toNano('1') }, poolCode)
        );
        await pool.sendDeploy(deployer.getSender(), toNano('2000'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    ledgerAddr: fakeLedger.address, // `PoolInject`'s only legal sender
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    // The mock is the native vault too — see the header.
                    dedustNativeVault: pool.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                    tonstakersPool: pool.address,
                    dedustTstonVault: pool.address,
                    dedustTstonPool: deployer.address,
                    treasuryAddr: treasury.address,
                },
                ratchetCode
            )
        );
        // 10 GRAM of gas buffer. The pool's fees come out of THIS, never out of
        // `pending` — a fee taken from the staked amount would drop `T` and break
        // the ratchet theorem (D-151).
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));

        // The two one-shot wallet bootstraps. The PRIMES one arms the burn tally
        // and the flush fill signal; the tsTON one arms §4.3.2 entirely.
        await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
            jettonWalletAddr: primesWallet.address,
            value: toNano('0.05'),
        });
        await ratchet.sendSetTstonWallet(genesisScript.getSender(), {
            tstonWalletAddr: pool.address,
            value: toNano('0.05'),
        });

        await ratchet.sendPoolInject(fakeLedger.getSender(), {
            amount: INJECTED,
            tSnapshot: INJECTED,
            sSnapshot: toNano('1000000'),
            value: INJECTED + toNano('0.01'),
        });
    });

    /** `flush()` is the ONLY thing that lowers `pending`, and therefore the only
     *  way the reserve ever runs short — which is the only state `unstake` is
     *  callable in. The mock swallows the swap; the PRIMES wallet's notification
     *  is the fill signal that clears `inFlightFlush` (GAUNTLET B2.1). */
    async function flushAway(amount: bigint) {
        const f = await ratchet.sendFlush(keeper.getSender(), { value: FLUSH_VALUE, amount });
        clean(f, 'flush');
        const note = await primesWallet.send({
            to: ratchet.address,
            value: toNano('0.1'),
            body: beginCell()
                .storeUint(TEP74.transfer_notification, 32)
                .storeUint(0, 64)
                .storeCoins(await ratchet.getLastMinOut()) // the swap's `limit`: the least a fill pays
                .storeAddress(deployer.address) // the venue's PRIMES jetton vault in this harness
                .storeUint(0, 1) // forward_payload — Either-left, empty
                .endCell(),
        });
        clean(note, 'flush fill signal');
        expect(await ratchet.getInFlightFlush()).toBe(0n);
    }

    async function stakeOnce(label: string) {
        const r = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        clean(r, label);
        return r;
    }

    // -----------------------------------------------------------------------
    // STAKE, and the rate the deposit teaches
    // -----------------------------------------------------------------------

    it('stakes everything above the reserve, learns the rate from the mint, and conserves the identity', async () => {
        const before = await obligation();
        expect(before).toBe(INJECTED);
        const target0 = (await ratchet.getStaking()).reserveTarget;
        expect(target0).toBe((INJECTED * RESERVE_BPS) / 10000n);

        await stakeOnce('stake');

        const s = await ratchet.getStaking();
        const pending = await ratchet.getPending();
        // The reserve is a fraction of the WHOLE obligation, not of the liquid
        // part, so a stake leaves `pending` exactly ON the target.
        expect(pending).toBe(target0);
        expect(s.stakedCost).toBe(INJECTED - target0);
        expect(s.stakedCost).toBeGreaterThan(STAKE_MIN);
        expect(s.reserveTarget).toBe(target0); // invariant across the move
        expect(await obligation()).toBe(before); // the five-term identity

        // THE RATE IS LEARNED HERE AND NOWHERE ELSE (D-151): `lastRateNum` is the
        // GRAM we charged to `stakedCost` and `lastRateDen` the tsTON the pool
        // minted against it. Published as the pair, unrounded.
        expect(s.lastRateNum).toBe(s.stakedCost);
        expect(s.lastRateDen).toBe(s.tstonHeld);
        expect(s.tstonHeld).toBeGreaterThan(0n);
        // and nothing is left in flight
        expect((await ratchet.getExitLeg()).inFlightExit).toBe(0n);
    });

    it('refuses a second stake below the minimum, by name', async () => {
        await stakeOnce('stake');
        const again = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        expect(again.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 226 }); // ratchet_stake_below_min
    });

    it('refuses every arm before the genesis script has wired the tsTON wallet', async () => {
        // A fresh ratchet with no SetTstonWallet — a half-wired genesis must be
        // visible by name, not silently stake nothing.
        const bare = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    ledgerAddr: fakeLedger.address,
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: pool.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                    tonstakersPool: pool.address,
                    treasuryAddr: treasury.address,
                },
                await compile('PrimesRatchet')
            )
        );
        await bare.sendDeploy(deployer.getSender(), toNano('10'));
        for (const send of [bare.sendStake, bare.sendUnstake, bare.sendHarvest]) {
            const r = await (send as any).call(bare, keeper.getSender(), { value: toNano('0.05') });
            expect(r.transactions).toHaveTransaction({ to: bare.address, exitCode: 231 }); // ratchet_tston_wallet_unset
        }
    });

    it('refuses a flush with nothing pending, by name (208) — after the cooldown, gas and in-flight gates pass', async () => {
        const empty = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    ledgerAddr: fakeLedger.address,
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: pool.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                },
                await compile('PrimesRatchet')
            )
        );
        await empty.sendDeploy(deployer.getSender(), toNano('10'));
        expect(await empty.getPending()).toBe(0n);
        const r = await empty.sendFlush(keeper.getSender(), { value: FLUSH_VALUE });
        expect(r.transactions).toHaveTransaction({ to: empty.address, success: false, exitCode: 208 }); // ratchet_flush_below_min
        expect(r.transactions).not.toHaveTransaction({ from: empty.address, to: pool.address });
        expect(await empty.getSwapped()).toBe(0n);
        expect(await empty.getInFlightFlush()).toBe(0n);
    });

    // -----------------------------------------------------------------------
    // HARVEST — realize, never mark
    // -----------------------------------------------------------------------

    /** Stake, move the pool rate, inject and stake again so the SECOND deposit
     *  teaches the new rate. That is the only way accrual becomes visible:
     *  tsTON does not rebase, so `tstonHeld` never grows — what changes is how
     *  little of it our cost is worth at the current rate. */
    async function stakeTwiceAcrossARateRise() {
        await stakeOnce('stake 1');
        await pool.sendSetRate(keeper.getSender(), {
            rateNum: toNano('1.05'),
            rateDen: toNano('1'),
            value: toNano('0.05'),
        });
        await ratchet.sendPoolInject(fakeLedger.getSender(), {
            amount: INJECTED,
            tSnapshot: INJECTED * 2n,
            sSnapshot: toNano('1000000'),
            value: INJECTED + toNano('0.01'),
        });
        await stakeOnce('stake 2');
    }

    it('refuses a harvest below the dust threshold, by name', async () => {
        // One stake teaches a rate consistent with itself, so accrued is exactly
        // 0 — which is the correct answer and must refuse rather than send a
        // jetton transfer that costs more than it moves.
        await stakeOnce('stake');
        const h = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(h.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 229 }); // ratchet_harvest_dust
    });

    it('harvests accrued tsTON to the governed treasury and TOUCHES NO TERM OF T', async () => {
        await stakeTwiceAcrossARateRise();

        const before = await ratchet.getStaking();
        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();

        const h = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        clean(h, 'harvest');

        // The accrual really went out, to the treasury and to nobody else.
        expect(h.transactions).toHaveTransaction({ from: ratchet.address, to: pool.address, success: true });
        expect(h.transactions).toHaveTransaction({ from: pool.address, to: treasury.address, success: true });

        const after = await ratchet.getStaking();
        expect(after.tstonHeld).toBeLessThan(before.tstonHeld);
        // THE WHOLE POINT: `harvest()` moves `tstonHeld`, which is not in `T`,
        // and writes no other term. "Realize, never mark", as arithmetic.
        expect(after.stakedCost).toBe(before.stakedCost);
        expect(after.exiting).toBe(before.exiting);
        expect(after.realizedLoss).toBe(before.realizedLoss);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await obligation()).toBe(obligationBefore);
        expect(after.lastHarvestTime).toBe(blockchain.now!);
    });

    it('B37: a small stake after a large one keeps the higher learned rate, so harvest neither refuses on a negative accrual nor sends backing', async () => {
        // The 20261121 testnet shape at a constant pool rate: each deposit is
        // credited `X + what STAKE_CREDIT_MARGIN leaves`, the pair books X, so a small stake's
        // pair under-states GRAM per tsTON the most. Valuing the large tranche at
        // it read accrued < 0 and refused 229. Large first, then just over the min.
        const inject = async (amount: bigint, tAfter: bigint) =>
            ratchet.sendPoolInject(fakeLedger.getSender(), {
                amount,
                tSnapshot: tAfter,
                sSnapshot: toNano('1000000'),
                value: amount + toNano('0.01'),
            });
        await inject(toNano('9000'), toNano('10000'));
        await stakeOnce('stake 1 (large)');
        const s1 = await ratchet.getStaking();
        await inject(toNano('700'), toNano('10700'));
        await stakeOnce('stake 2 (small)');
        const s2 = await ratchet.getStaking();
        expect(s2.stakedCost - s1.stakedCost).toBeGreaterThan(STAKE_MIN);
        expect(s2.stakedCost - s1.stakedCost).toBeLessThan(s1.stakedCost / 10n);

        // The small stake's pair is LOWER GRAM-per-tsTON, so it is not taken.
        expect(s2.lastRateNum).toBe(s1.lastRateNum);
        expect(s2.lastRateDen).toBe(s1.lastRateDen);

        // The old rule read accrued < 0 here. Now it is the two stakes' credit-margin
        // surplus: never negative, and under 0.01 GRAM of it is dust, so the harvest
        // refuses by name and sends nothing — and at the pool's true 1:1 rate the
        // tsTON held still covers every nanoton of cost.
        const accrued = s2.tstonHeld - (s2.stakedCost * s2.lastRateDen) / s2.lastRateNum;
        expect(accrued).toBeGreaterThanOrEqual(0n);
        expect(accrued).toBeLessThan(HARVEST_DUST);
        expect(s2.tstonHeld).toBeGreaterThanOrEqual(s2.stakedCost);

        blockchain.now = blockchain.now! + HARVEST_INTERVAL;
        const obligationBefore = await obligation();
        await expectNothingToHarvest();
        const after = await ratchet.getStaking();
        expect(after.tstonHeld).toBe(s2.tstonHeld);
        expect(after.stakedCost).toBe(s2.stakedCost);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('gates the next harvest for 30 days, by name', async () => {
        await stakeTwiceAcrossARateRise();
        clean(await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE }), 'harvest 1');

        const tooSoon = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(tooSoon.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 228 }); // ratchet_harvest_too_soon
        // G68: the gate a caller must read before sending is the one enforced, and no stake is open.
        expect(await ratchet.getStakingGates()).toEqual({
            inFlightStake: 0n,
            harvestIntervalSec: HARVEST_INTERVAL,
            harvestDustTston: HARVEST_DUST,
            stakeStartedAt: 0,
            writtenOff: 0n,
            stakeCredited: 0n,
        });

        blockchain.now = blockchain.now! + HARVEST_INTERVAL - 1;
        const stillTooSoon = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(stillTooSoon.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 228 });

        // Past the gate it is the DUST guard that answers, not the clock — the
        // first harvest took the whole accrual.
        blockchain.now = blockchain.now! + 2;
        const past = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(past.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 229 });
    });

    // -----------------------------------------------------------------------
    // THE EXIT, leg by leg
    // -----------------------------------------------------------------------

    /** Stake, then spend `pending` through `flush()` so the reserve runs short.
     *  That is the ONLY state `unstake` is callable in, by design (§11.14: an
     *  exit anyone may call on demand is the discretionary surface Q14 refused). */
    async function stakeThenBreachTheReserve() {
        await stakeOnce('stake');
        const target = (await ratchet.getStaking()).reserveTarget;
        await flushAway(target / 2n);
        expect(await ratchet.getPending()).toBeLessThan((await ratchet.getStaking()).reserveTarget);
    }

    it('refuses an unstake while the reserve is still funded, by name', async () => {
        await stakeOnce('stake');
        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        expect(u.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 227 }); // ratchet_reserve_sufficient
    });

    it('LEG 1 fills: the pool pays at its own rate and `pending` is restored', async () => {
        await stakeThenBreachTheReserve();
        // The pool's free-GRAM buffer covers the tranche, so `fill_or_kill = 1`
        // is answered with GRAM and there is no second leg.
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: toNano('1000'), value: toNano('0.05') });

        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();
        const target = (await ratchet.getStaking()).reserveTarget;

        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(u, 'unstake leg 1');

        // `withdrawal#0a77535c` really came back — no bill, no swap.
        expect(u.transactions).toHaveTransaction({
            from: pool.address,
            to: ratchet.address,
            op: RATCHET.tonstakers_withdrawal,
            success: true,
        });

        const s = await ratchet.getStaking();
        expect(s.exiting).toBe(0n);
        expect(s.realizedLoss).toBe(0n); // leg 1 is the exact rate; it cannot lose
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expectRestoredTo(await ratchet.getPending(), target);
        expect(await ratchet.getPending()).toBeGreaterThan(pendingBefore);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('a refill at a rate off 1:1 lands at or above the target, and a second unstake refuses (2026-11-21)', async () => {
        // Two stakes across a rate rise make `tstonHeld / stakedCost` a non-integer
        // ratio — the case where flooring the tranche AND its cost lost a nano.
        await stakeTwiceAcrossARateRise();
        const s0 = await ratchet.getStaking();
        expect(s0.tstonHeld).not.toBe(s0.stakedCost);
        await flushAway((await ratchet.getStaking()).reserveTarget / 3n);
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: toNano('5000'), value: toNano('0.05') });
        const obligationBefore = await obligation();

        clean(await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE }), 'unstake off 1:1');

        expectRestoredTo(await ratchet.getPending(), (await ratchet.getStaking()).reserveTarget);
        expect(await obligation()).toBe(obligationBefore);
        const again = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        expect(again.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 227 }); // ratchet_reserve_sufficient
    });

    it('refuses a DUST unstake by name — a 2-nano shortfall cannot park the exit machine (2026-11-21)', async () => {
        // A stranger flushes 2 nanotons: the reserve is now short, by dust. Before the
        // floor this sent a 1-2 nano-tsTON tranche that redeemed to 0 GRAM and held
        // stake/unstake shut for the 72 h recovery window.
        await stakeOnce('stake');
        await flushAway(2n);
        const s = await ratchet.getStaking();
        expect(await ratchet.getPending()).toBeLessThan(s.reserveTarget);

        const u = await ratchet.sendUnstake(stranger.getSender(), { value: UNSTAKE_VALUE });
        expect(u.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 227 }); // ratchet_reserve_sufficient
        expect(u.transactions).not.toHaveTransaction({ from: ratchet.address, to: pool.address });
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        // The gate is the one `getStakingGates()` already publishes — the sim's dust.
        expect((await ratchet.getStakingGates()).harvestDustTston).toBe(HARVEST_DUST);
    });

    it('LEG 1 refused -> LEG 2 fills on DeDust, above the guarded floor', async () => {
        await stakeThenBreachTheReserve();
        // Nothing in the pool's buffer, plenty on the DEX. The re-mint is the
        // refusal, and the ratchet's answer to it is the guarded swap.
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: toNano('1000'), value: toNano('0.05') });

        const obligationBefore = await obligation();
        const target = (await ratchet.getStaking()).reserveTarget;

        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(u, 'unstake leg 2');

        // The tsTON went out as a TEP-74 transfer (leg 2) and the GRAM came back
        // as DeDust's own `payout#474f86cf`, not as a withdrawal.
        expect(u.transactions).toHaveTransaction({
            from: ratchet.address,
            to: pool.address,
            op: TEP74.transfer,
            success: true,
        });
        expect(u.transactions).toHaveTransaction({
            from: pool.address,
            to: ratchet.address,
            op: 0x474f86cf,
            success: true,
        });

        const s = await ratchet.getStaking();
        expect(s.exiting).toBe(0n);
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expectRestoredTo(await ratchet.getPending(), target);
        // At a rate of 1.0 the fill clears cost exactly, so the 50 bps tolerance
        // is never spent and nothing is realized as a loss.
        expect(s.realizedLoss).toBe(0n);
        expect(await obligation()).toBe(obligationBefore);
    });

    it("LEG 2 still fills after update_venue re-points the flush vault — the payout is checked against the tsTON pool's own vault (2026-11-08 audit)", async () => {
        // The flush venue moves to another factory; the tsTON pool does not. Checked
        // against `venue.dedustNativeVault`, leg 2's payout threw 100 and stranded.
        const moved = beginCell()
            .storeUint(RATCHET.update_venue, 32)
            .storeUint(0, 64)
            .storeAddress(stranger.address)
            .storeAddress(stranger.address)
            .storeAddress(stranger.address)
            .endCell();
        await stakeThenBreachTheReserve(); // flushes, so it runs before the move
        clean(await deployer.send({ to: ratchet.address, value: toNano('0.1'), body: moved }), 'update_venue');
        expect((await ratchet.getTstonPayoutVault()).toString()).toBe(pool.address.toString());

        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: toNano('1000'), value: toNano('0.05') });
        const target = (await ratchet.getStaking()).reserveTarget;

        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(u, 'unstake leg 2 after venue move');
        expect(u.transactions).toHaveTransaction({ from: pool.address, to: ratchet.address, op: 0x474f86cf, success: true });
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expectRestoredTo(await ratchet.getPending(), target);
    });

    it('LEG 2 refused -> LEG 3: the bill is minted, settles at round end, and `pending` comes home', async () => {
        await stakeThenBreachTheReserve();
        // Neither the pool nor the DEX can pay: the exit falls all the way to the
        // ~36 h bill, which is the correct answer to a book that cannot clear our
        // cost basis (D-151 — waiting is right exactly then).
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: 0n, value: toNano('0.05') });

        const obligationBefore = await obligation();
        const target = (await ratchet.getStaking()).reserveTarget;

        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(u, 'unstake leg 3');

        expect(u.transactions).toHaveTransaction({
            from: pool.address,
            to: ratchet.address,
            op: RATCHET.payout_ownership_assigned,
            success: true,
        });

        // The bill is outstanding: `exiting` holds the tranche, `pending` has not
        // moved, and the identity still closes with the GRAM in neither place.
        const mid = await ratchet.getStaking();
        expect(mid.exiting).toBeGreaterThan(0n);
        expect((await ratchet.getExitLeg()).leg).toBe(3);
        expect(await obligation()).toBe(obligationBefore);
        // and the machine is fail-closed while it is open
        const blocked = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        expect(blocked.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 230 }); // ratchet_stake_in_flight

        const settle = await pool.sendSettleBill(keeper.getSender(), { value: toNano('0.05') });
        clean(settle, 'settle bill');
        expect(settle.transactions).toHaveTransaction({
            from: pool.address,
            to: ratchet.address,
            op: RATCHET.payout_distributed_asset,
            success: true,
        });

        const s = await ratchet.getStaking();
        expect(s.exiting).toBe(0n);
        expect(s.realizedLoss).toBe(0n);
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expectRestoredTo(await ratchet.getPending(), target);
        expect(await obligation()).toBe(obligationBefore);
    });

    // -----------------------------------------------------------------------
    // D-146 — CALLER PAYS. The owner's rule: "calling flush from any wallet
    // should not affect the gas and fees reserve in any way", applied to all
    // four legs. The reserve is `balance − pending`; every leg must end with it
    // unchanged or higher, and an under-funded call is a named refusal (225).
    // -----------------------------------------------------------------------

    async function gasBuffer(): Promise<bigint> {
        return (await blockchain.getContract(ratchet.address)).balance - (await ratchet.getPending());
    }

    // -----------------------------------------------------------------------
    // THE BOUNCE ARMS (ratchet.tolk onBouncedMessage, D-151). Each refusal below
    // is the POOL contract's own throw — a real compute-phase failure, so TVM
    // builds the rich bounce and the ratchet's real handler runs. The trigger is
    // a mock knob or the sandbox balance seam; the bounce is never forged.
    // -----------------------------------------------------------------------

    /** The refusal is the ONLY red transaction, and it is the pool's. */
    function abortedOnlyAtPool(r: any) {
        const bad = r.transactions
            .filter((t: any) => (t.description as any)?.aborted === true)
            .map((t: any) => t.inMessage?.info?.dest?.toString());
        expect(bad.length).toBeGreaterThan(0);
        expect([...new Set(bad)]).toEqual([pool.address.toString()]);
        expect(r.transactions).toHaveTransaction({ from: pool.address, to: ratchet.address, inMessageBounced: true, success: true });
    }

    // ---- audit R2-M1: a flush open across a venue change, on the paths the mock-vault
    // spec cannot reach (a stale close by `stake`, and a real bounce) ----------------
    const venueTo = (nativeVault: Address) =>
        deployer.send({
            to: ratchet.address,
            value: toNano('0.1'),
            body: beginCell()
                .storeUint(RATCHET.update_venue, 32)
                .storeUint(0, 64)
                .storeAddress(nativeVault)
                .storeAddress(stranger.address)
                .storeAddress(stranger.address)
                .endCell(),
        });
    const payoutFromPool = (value: bigint) =>
        blockchain.sendMessage(
            internal({
                from: pool.address,
                to: ratchet.address,
                value,
                bounce: false,
                body: beginCell().storeUint(0x474f86cf, 32).storeUint(0, 64).storeUint(0, 1).endCell(),
            })
        );

    /** A 10 GRAM flush the pool swallows, then the venue moves away from the pool. */
    async function flushThenMoveVenue() {
        const pendingBefore = await ratchet.getPending();
        const obligationBefore = await obligation();
        clean(await ratchet.sendFlush(keeper.getSender(), { value: FLUSH_VALUE, amount: toNano('10') }), 'flush');
        expect(await ratchet.getInFlightFlush()).toBe(toNano('10'));
        clean(await venueTo(stranger.address), 'update_venue');
        const pin = await ratchet.getFlushReplyVenue();
        expect(pin.pinned).toBe(true);
        expect(pin.dedustNativeVault.equals(pool.address)).toBe(true);
        return { pendingBefore, obligationBefore };
    }

    it('R2-M1: the stale close is LAZY — a pinned refund more than an hour late still restores, until something closes the trip', async () => {
        const { pendingBefore, obligationBefore } = await flushThenMoveVenue();
        blockchain.now = blockchain.now! + (await ratchet.getFlushStaleSec()) + 600;
        // Nobody has called flush, stake or unstake: the trip is still open and still pinned.
        expect((await ratchet.getFlushReplyVenue()).pinned).toBe(true);
        clean(await payoutFromPool(toNano('10')), 'late pinned refund');
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('R2-M1: `stake` closes a stale pinned trip as filled; the old vault\'s reply after that is refused and moves no term of T', async () => {
        const { pendingBefore, obligationBefore } = await flushThenMoveVenue();
        blockchain.now = blockchain.now! + (await ratchet.getFlushStaleSec());
        await stakeOnce('stake over a stale pinned flush');
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect((await ratchet.getFlushReplyVenue()).pinned).toBe(false);
        expect(await obligation()).toBe(obligationBefore); // closed AS FILLED: `swapped` keeps the 10
        const pendingAfterStake = await ratchet.getPending();
        expect(pendingAfterStake).toBeLessThan(pendingBefore - toNano('10') + 1n);

        // The trip is closed, so the pin is inert and the old vault is a stranger again.
        const late = await payoutFromPool(toNano('10'));
        expect(late.transactions).toHaveTransaction({ from: pool.address, to: ratchet.address, success: false, exitCode: 100 });
        expect(await ratchet.getPending()).toBe(pendingAfterStake);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('R2-M1: a swap BOUNCE that crosses a venue change still restores pending', async () => {
        // A native vault that does not exist bounces the swap. The venue moves between
        // the flush and its bounce.
        const dead = new Address(0, randomBytes(32));
        clean(await venueTo(dead), 'update_venue to a vault that bounces');
        const pendingBefore = await ratchet.getPending();
        const obligationBefore = await obligation();

        const it = await blockchain.sendMessageIter(
            internal({
                from: keeper.address,
                to: ratchet.address,
                value: FLUSH_VALUE,
                body: buildFlushMessage({ queryId: 0n, amountNanoton: toNano('10') }).body,
            }),
            { allowParallel: true },
        );
        const first = await it.next();
        expect((first.value as any).description.aborted).toBe(false);
        expect(await ratchet.getInFlightFlush()).toBe(toNano('10'));

        await drain(
            await blockchain.sendMessageIter(
                internal({
                    from: deployer.address,
                    to: ratchet.address,
                    value: toNano('0.1'),
                    body: beginCell()
                        .storeUint(RATCHET.update_venue, 32)
                        .storeUint(0, 64)
                        .storeAddress(stranger.address)
                        .storeAddress(stranger.address)
                        .storeAddress(stranger.address)
                        .endCell(),
                }),
                { allowParallel: true },
            ),
            'update_venue mid-flight',
        );
        const pin = await ratchet.getFlushReplyVenue();
        expect(pin.pinned).toBe(true);
        expect(pin.dedustNativeVault.equals(dead)).toBe(true);

        // The rest of the flush's own trace: the dead vault bounces, the ratchet restores.
        let bounced = 0;
        for await (const tx of it) {
            const info = tx.inMessage?.info as any;
            if (info?.dest?.equals?.(ratchet.address)) {
                expect((tx.description as any).aborted).toBe(false);
                if (info.bounced) bounced += 1;
            }
        }
        expect(bounced).toBe(1);
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await obligation()).toBe(obligationBefore);
        expect((await ratchet.getFlushReplyVenue()).pinned).toBe(false);
    });

    it('R2-L3: a late bounce of a trip closed stale restores nothing, and the open trip still restores its own amount', async () => {
        // Both trips go to a vault that does not exist, so both bounce; each trace is held
        // open (sendMessageIter) so the OLD trip's bounce can be delivered while the NEW one
        // is in flight — the order the audit's R2-L3 is about.
        const dead = new Address(0, randomBytes(32));
        clean(await venueTo(dead), 'update_venue to a vault that bounces');
        const flushIter = (amount: bigint) =>
            blockchain.sendMessageIter(
                internal({
                    from: keeper.address,
                    to: ratchet.address,
                    value: FLUSH_VALUE,
                    body: buildFlushMessage({ queryId: 0n, amountNanoton: amount }).body,
                }),
                { allowParallel: true },
            );

        const tripA = await flushIter(toNano('4'));
        expect(((await tripA.next()).value as any).description.aborted).toBe(false);
        expect(await ratchet.getInFlightFlush()).toBe(toNano('4'));

        // Past the stale hour and any cooldown: trip B closes A as filled and opens itself.
        blockchain.now = blockchain.now! + (await ratchet.getFlushStaleSec()) + 2 * 86_400;
        const tripB = await flushIter(toNano('6'));
        expect(((await tripB.next()).value as any).description.aborted).toBe(false);
        expect(await ratchet.getInFlightFlush()).toBe(toNano('6'));
        const pendingWithBOpen = await ratchet.getPending();
        const obligationWithBOpen = await obligation();

        // The dead vault's own transaction aborts — that IS the bounce. Only the ratchet's
        // side of each trace must be clean, and each must take exactly one bounce.
        const deliver = async (trace: AsyncIterable<any>) => {
            let bounced = 0;
            for await (const tx of trace) {
                const info = tx.inMessage?.info as any;
                if (!info?.dest?.equals?.(ratchet.address)) continue;
                expect((tx.description as any).aborted).toBe(false);
                if (info.bounced) bounced += 1;
            }
            expect(bounced).toBe(1);
        };

        await deliver(tripA);
        expect(await ratchet.getInFlightFlush()).toBe(toNano('6'));
        expect(await ratchet.getPending()).toBe(pendingWithBOpen);
        expect(await obligation()).toBe(obligationWithBOpen);

        await deliver(tripB);
        expect(await ratchet.getInFlightFlush()).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingWithBOpen + toNano('6'));
        expect(await obligation()).toBe(obligationWithBOpen);
    });

    it('BOUNCE: a refused Tonstakers deposit returns the stake to `pending` and backs out `stakedCost`', async () => {
        // rateNum = 0 is the pool refusing outright (1302, rate_unset).
        await pool.sendSetRate(keeper.getSender(), { rateNum: 0n, rateDen: toNano('1'), value: toNano('0.05') });
        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();

        const r = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        expect(r.transactions).toHaveTransaction({ from: ratchet.address, to: pool.address, op: RATCHET.tonstakers_deposit, success: false, exitCode: 1302 });
        abortedOnlyAtPool(r);

        expect(await ratchet.getPending()).toBe(pendingBefore);
        const s = await ratchet.getStaking();
        expect(s.stakedCost).toBe(0n);
        expect(s.tstonHeld).toBe(0n);
        const gates = await ratchet.getStakingGates();
        expect(gates.inFlightStake).toBe(0n);
        expect(gates.stakeStartedAt).toBe(0);
        expect(await obligation()).toBe(obligationBefore); // the T identity

        // Not locked: the pool accepts again, and the same stake lands.
        await pool.sendSetRate(keeper.getSender(), { rateNum: toNano('1'), rateDen: toNano('1'), value: toNano('0.05') });
        await stakeOnce('stake after a bounced deposit');
        expect((await ratchet.getStaking()).stakedCost).toBeGreaterThan(0n);
    });

    async function expectExitAborted(before: Awaited<ReturnType<PrimesRatchet['getStaking']>>, obligationBefore: bigint, pendingBefore: bigint) {
        const s = await ratchet.getStaking();
        expect(s.tstonHeld).toBe(before.tstonHeld);
        expect(s.stakedCost).toBe(before.stakedCost);
        expect(s.exiting).toBe(0n);
        expect(s.realizedLoss).toBe(0n);
        const leg = await ratchet.getExitLeg();
        expect(leg.leg).toBe(0);
        expect(leg.inFlightExit).toBe(0n);
        expect(leg.exitStartedAt).toBe(0);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await obligation()).toBe(obligationBefore);
    }

    it('BOUNCE: a refused LEG 1 burn aborts the exit — tsTON and cost basis restored, nothing exiting', async () => {
        await stakeThenBreachTheReserve();
        // The buffer says it can fill; the pool's GRAM cannot (1305, mock_under_funded).
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: toNano('1000'), value: toNano('0.05') });
        const poolAcct = await blockchain.getContract(pool.address);
        const poolBalance = poolAcct.balance;
        poolAcct.balance = toNano('1');
        const before = await ratchet.getStaking();
        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();

        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        expect(u.transactions).toHaveTransaction({ from: ratchet.address, to: pool.address, op: TEP74.burn, success: false, exitCode: 1305 });
        abortedOnlyAtPool(u);
        await expectExitAborted(before, obligationBefore, pendingBefore);

        // Not locked: funded again, the exit runs and fills on leg 1.
        poolAcct.balance = poolBalance;
        clean(await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE }), 'unstake after a bounced burn');
        expect((await ratchet.getPending())).toBeGreaterThan(pendingBefore);
    });

    it('BOUNCE: a refused LEG 2 swap aborts the exit (exitLeg tells it from a harvest) and invents no tsTON', async () => {
        await stakeThenBreachTheReserve();
        // Leg 1 is refused by re-mint (empty buffer); leg 2's DEX quotes a fill the
        // pool's GRAM cannot pay, so the swap transfer itself throws (1305).
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: toNano('1000'), value: toNano('0.05') });
        const poolAcct = await blockchain.getContract(pool.address);
        poolAcct.balance = toNano('1');
        const before = await ratchet.getStaking();
        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();

        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        expect(u.transactions).toHaveTransaction({ from: ratchet.address, to: pool.address, op: TEP74.transfer, success: false, exitCode: 1305 });
        abortedOnlyAtPool(u);
        await expectExitAborted(before, obligationBefore, pendingBefore);
    });

    /** A stranger's TEP-74 transfer on the mock (its knobs are unauthenticated):
     *  empties the pool's tsTON position so the ratchet's own transfer exceeds it. */
    async function drainPoolPosition() {
        const owed = (await pool.getMockPoolConfig()).tstonSupplyOwed;
        const r = await stranger.send({
            to: pool.address,
            value: toNano('0.1'),
            body: beginCell()
                .storeUint(TEP74.transfer, 32)
                .storeUint(0, 64)
                .storeCoins(owed)
                .storeAddress(stranger.address)
                .storeAddress(null) // response: none
                .storeMaybeRef(null) // custom payload: none
                .storeCoins(0)
                .storeBit(0) // forward payload: inline, empty
                .endCell(),
        });
        expect(r.transactions).toHaveTransaction({ from: stranger.address, to: pool.address, success: true });
        expect((await pool.getMockPoolConfig()).tstonSupplyOwed).toBe(0n);
    }

    it('BOUNCE: a refused harvest gives `tstonHeld` back the bounced amount and touches no term of T', async () => {
        await stakeTwiceAcrossARateRise();
        await drainPoolPosition();
        const before = await ratchet.getStaking();
        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();

        const h = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(h.transactions).toHaveTransaction({ from: ratchet.address, to: pool.address, op: TEP74.transfer, success: false, exitCode: 1307 });
        abortedOnlyAtPool(h);
        expect(h.transactions).not.toHaveTransaction({ to: treasury.address, op: TEP74.transfer_notification });

        const after = await ratchet.getStaking();
        expect(after.tstonHeld).toBe(before.tstonHeld);
        expect(after.stakedCost).toBe(before.stakedCost);
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await obligation()).toBe(obligationBefore);
    });

    // `handleHarvest` writes `lastHarvestTime` before the send, so the TEP-74 bounce arm
    // resets it (the V11 pattern the DeDust arm uses for `lastFlushTime`). CONCEPT §4.3.2:
    // the interval runs "since the last one", and a refused harvest is not one.
    it('BOUNCE: a refused harvest does not start the 30-day harvest gate', async () => {
        await stakeTwiceAcrossARateRise();
        await drainPoolPosition();
        expect((await ratchet.getStaking()).lastHarvestTime).toBe(0);
        const h = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        abortedOnlyAtPool(h);
        expect((await ratchet.getStaking()).lastHarvestTime).toBe(0);
    });

    it('D-146: stake is caller-paid — under-funded refuses 225, funded leaves the buffer whole', async () => {
        const b0 = await gasBuffer();
        const short = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE - toNano('0.02') });
        expect(short.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 225 });
        expect(await gasBuffer()).toBeGreaterThanOrEqual(b0);

        await stakeOnce('stake, caller-paid');
        expect(await gasBuffer()).toBeGreaterThanOrEqual(b0);
    });

    it("2026-11-23: the pool's unspent 1 GRAM reserve goes back to the stake caller, once, and only the stake's own excess", async () => {
        const excessBody = (q: number) => beginCell().storeUint(TEP74.excesses, 32).storeUint(q, 64).endCell();
        const forwarded = (r: any) =>
            r.transactions.filter((t: any) => t.inMessage?.info?.src?.equals?.(ratchet.address) && t.inMessage.info.dest.equals(keeper.address));

        const b0 = await gasBuffer();
        const k0 = await keeper.getBalance();
        const r = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE, queryID: 42 });
        clean(r, 'stake with refund');
        // Upstream order: the notification, then the pool's excess, then ours to the caller.
        expect(r.transactions).toHaveTransaction({
            from: ratchet.address,
            to: keeper.address,
            op: TEP74.excesses,
            value: (v?: bigint) => v! > toNano('0.8'),
        });
        // What the caller is out: the 0.1 notification (it pays the ratchet's fill), the
        // 0.01 credit margin and gas — not the 1 GRAM reserve, and no 0.3 any more.
        const out = k0 - (await keeper.getBalance());
        console.log(`stake caller net cost: ${out} nanoGRAM`);
        expect(out).toBeLessThan(toNano('0.15'));
        // The buffer neither paid the refund nor kept it.
        const b1 = await gasBuffer();
        expect(b1).toBeGreaterThanOrEqual(b0);
        expect(b1 - b0).toBeLessThan(toNano('0.1'));

        // A replay of the same excess, from the wallet itself, is not paid twice.
        const replay = await blockchain.sendMessage(
            internal({ from: pool.address, to: ratchet.address, value: toNano('1'), body: excessBody(42) })
        );
        clean(replay, 'replayed excess');
        expect(forwarded(replay)).toHaveLength(0);

        // A stranger echoing an OPEN stake's query id is ignored: open one with no excess
        // (the non-optimistic bill path), then forge the reply.
        await nonOptimistic(false);
        await injectMore();
        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        clean(await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE, queryID: 77 }), 'bill stake');
        const forged = await blockchain.sendMessage(
            internal({ from: stranger.address, to: ratchet.address, value: toNano('1'), body: excessBody(77) })
        );
        clean(forged, 'stranger excess');
        expect(forwarded(forged)).toHaveLength(0);
        const wrongId = await blockchain.sendMessage(
            internal({ from: pool.address, to: ratchet.address, value: toNano('1'), body: excessBody(78) })
        );
        expect(forwarded(wrongId)).toHaveLength(0);
        const right = await blockchain.sendMessage(
            internal({ from: pool.address, to: ratchet.address, value: toNano('1'), body: excessBody(77) })
        );
        clean(right, 'the wallet excess');
        expect(forwarded(right)).toHaveLength(1);
    });

    it('2026-11-23: a stake that ended with no excess leaves no refund for a later arm with the same query id', async () => {
        const toStranger = (r: any) =>
            r.transactions.filter((t: any) => t.inMessage?.info?.src?.equals?.(ratchet.address) && t.inMessage.info.dest.equals(stranger.address));
        // The bill path: the stake fills with no `excesses`. Query id 5, reused below.
        await nonOptimistic(false);
        clean(await ratchet.sendStake(stranger.getSender(), { value: STAKE_VALUE, queryID: 5 }), 'bill stake, id 5');
        await settleDepositBill('the bill pays');
        // A bill is unauthenticated tsTON: the stake stays open until it is written off.
        await recoverAfterWindow('write off the bill stake');
        await nonOptimistic(true);

        // A later unstake reusing id 5, whose wallet `excesses` comes home here.
        await flushAway(toNano('100'));
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: toNano('1000'), value: toNano('0.05') });
        const b0 = await gasBuffer();
        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE, queryID: 5 });
        clean(u, 'unstake, id 5');
        expect(toStranger(u)).toHaveLength(0);
        const late = await blockchain.sendMessage(
            internal({
                from: pool.address,
                to: ratchet.address,
                value: toNano('0.5'),
                body: beginCell().storeUint(TEP74.excesses, 32).storeUint(5, 64).endCell(),
            })
        );
        clean(late, 'an id-5 excess after the unstake');
        expect(toStranger(late)).toHaveLength(0);
        expect(await gasBuffer()).toBeGreaterThanOrEqual(b0);
    });

    it('D-146: harvest is caller-paid — under-funded refuses 225, funded leaves the buffer whole', async () => {
        await stakeTwiceAcrossARateRise();
        const b0 = await gasBuffer();
        const short = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE - toNano('0.02') });
        expect(short.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 225 });

        clean(await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE }), 'harvest, caller-paid');
        expect(await gasBuffer()).toBeGreaterThanOrEqual(b0);
    });

    it('D-146: unstake prepays the WHOLE exit — the buffer is whole after leg 1, and after legs 2 and 3', async () => {
        await stakeThenBreachTheReserve();
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: 0n, value: toNano('0.05') });

        const b0 = await gasBuffer();
        // Enough for leg 1 alone is NOT enough: legs 2 and 3 are sent by replies.
        const short = await ratchet.sendUnstake(keeper.getSender(), { value: toNano('0.85') });
        expect(short.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 225 });

        clean(await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE }), 'unstake to leg 3');
        expect((await ratchet.getExitLeg()).leg).toBe(3);
        expect(await gasBuffer()).toBeGreaterThanOrEqual(b0);

        clean(await pool.sendSettleBill(keeper.getSender(), { value: toNano('0.05') }), 'settle bill');
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expect(await gasBuffer()).toBeGreaterThanOrEqual(b0);
    });

    it('D-146: flush is caller-paid here too — the buffer is whole after a flush', async () => {
        await stakeOnce('stake');
        const b0 = await gasBuffer();
        await flushAway((await ratchet.getStaking()).reserveTarget / 2n);
        expect(await gasBuffer()).toBeGreaterThanOrEqual(b0);
    });

    it('LEG 2 REFUSES a quote under cost and falls to LEG 3 — this is the case that used to lose money', async () => {
        // THE REGRESSION THIS FILE EXISTS FOR. The bound used to read
        // `max(lastRate, costBasis) * (1 - 50 bps)`, which sits BELOW cost
        // whenever the two are close — and at exactly one stake they are EQUAL by
        // construction, because the rate is learned from that same deposit. A
        // quote in that band filled and realized a loss. The bound now floors at
        // `costBasis`, so the 50 bps governs how far under the OBSERVED RATE we
        // will fill and never takes us under what we paid.
        //
        // The owner's sentence is the spec: "If exchange rate is bad — activate
        // manual withdrawal and when it lands flush." A book that will not pay
        // cost IS a bad rate, and leg 3 is the manual withdrawal.
        await stakeThenBreachTheReserve();

        const s0 = await ratchet.getStaking();
        // One stake, so cost basis and the learned rate are the same number:
        // `stakedCost / tstonHeld` = `lastRateNum / lastRateDen`.
        expect(s0.lastRateNum).toBe(s0.stakedCost);
        expect(s0.lastRateDen).toBe(s0.tstonHeld);

        // A DeDust quote strictly inside (costBasis * (1 - 50 bps), costBasis):
        // 0.9975 GRAM per tsTON against a cost basis of ~0.99962 and an old floor
        // of ~0.99463. The OLD bound would have filled this; the new one cannot.
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: toNano('2000'), value: toNano('0.05') });
        await pool.sendSetRate(keeper.getSender(), {
            rateNum: toNano('0.9975'),
            rateDen: toNano('1'),
            value: toNano('0.05'),
        });
        const costBasisNum = s0.stakedCost * 10n ** 9n / s0.tstonHeld;
        expect(toNano('0.9975')).toBeLessThan(costBasisNum); // under cost...
        expect(toNano('0.9975')).toBeGreaterThan((costBasisNum * 9950n) / 10000n); // ...but inside 50 bps

        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(u, 'unstake refused into leg 3');

        // The swap went out and was REFUSED — no GRAM came back from the venue.
        expect(u.transactions).toHaveTransaction({
            from: ratchet.address,
            to: pool.address,
            op: TEP74.transfer,
            success: true,
        });
        expect(u.transactions).not.toHaveTransaction({ from: pool.address, to: ratchet.address, op: 0x474f86cf });
        // and the machine waited instead: leg 3's bill, at the pool's exact rate.
        expect(u.transactions).toHaveTransaction({
            from: pool.address,
            to: ratchet.address,
            op: RATCHET.payout_ownership_assigned,
            success: true,
        });
        expect((await ratchet.getExitLeg()).leg).toBe(3);
        // Nothing has been sold, so nothing has been lost — the tranche is still
        // whole inside `exiting` and the identity still closes.
        const s1 = await ratchet.getStaking();
        expect(s1.realizedLoss).toBe(0n);
        expect(s1.exiting).toBeGreaterThan(0n);
    });

    // -----------------------------------------------------------------------
    // D-155 — the stranded exit, and the way out of it
    // -----------------------------------------------------------------------
    //
    // THE DEFECT THIS BLOCK EXISTS FOR, and it was proved live on testnet
    // 2026-09-21, not imagined: every transition of the exit machine is driven
    // by an INBOUND REPLY, and a reply that is lost, malformed, under-gassed in
    // a way that does not bounce, or sent by an address a sender gate rejects
    // leaves `exitLeg` outstanding with nothing left to move it. `flush()`
    // refuses while an exit is open (230), so that is not a staking outage —
    // it is the ratchet's own core loop (§4.3.1) stopped by a lost message.

    /** Leg 3's bill, left outstanding: the state a lost reply strands. */
    async function strandInLeg3() {
        await stakeThenBreachTheReserve();
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: 0n, value: toNano('0.05') });
        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(u, 'unstake into leg 3');
        expect((await ratchet.getExitLeg()).leg).toBe(3);
    }

    it('refuses recovery when no exit is open, by name', async () => {
        await stakeOnce('stake');
        const e = await ratchet.getExitLeg();
        expect(e.leg).toBe(0);
        expect(e.exitStartedAt).toBe(0); // the clock is per-exit, not free-running
        expect(e.recoverAfter).toBe(EXIT_RECOVERY); // divisor 1 is the identity

        const r = await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') });
        expect(r.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 232 }); // ratchet_exit_not_stranded
    });

    it('a stake whose mint never lands is written off after the window — staking is not locked for ever', async () => {
        // The deposit is accepted (no bounce) but the mint notification is lost: only
        // the notification or a bounce cleared `inFlightStake`, and stake/unstake
        // refuse (230) while it is set, so this used to lock staking permanently.
        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();
        const it = await blockchain.sendMessageIter(
            internal({
                from: keeper.address,
                to: ratchet.address,
                value: STAKE_VALUE,
                body: beginCell().storeUint(RATCHET.stake, 32).storeUint(0, 64).endCell(),
            }),
            { allowParallel: true }, // its own queue: abandoning the iterator drops the rest
        );
        await it.next(); // the ratchet sends the deposit
        const gates = await ratchet.getStakingGates();
        expect(gates.inFlightStake).toBeGreaterThan(0n);
        expect(gates.stakeStartedAt).toBe(blockchain.now!);
        const amount = gates.inFlightStake;

        const locked = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        expect(locked.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 230 });
        blockchain.now = blockchain.now! + EXIT_RECOVERY - 1;
        const early = await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') });
        expect(early.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 232 });

        blockchain.now = blockchain.now! + 1;
        const before = await ratchet.getStaking();
        clean(await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') }), 'recover_exit');
        const after = await ratchet.getStaking();
        expect((await ratchet.getStakingGates()).inFlightStake).toBe(0n);
        expect((await ratchet.getStakingGates()).writtenOff).toBe(amount);
        expect(after.stakedCost).toBe(before.stakedCost - amount);
        expect(after.realizedLoss).toBe(before.realizedLoss + amount);
        expect(after.tstonHeld).toBe(before.tstonHeld); // no invented tsTON
        expect(await ratchet.getPending()).toBe(pendingBefore - amount); // the GRAM left; not restored
        expect(await obligation()).toBe(obligationBefore);

        // RE-AUDIT: while the mint may still land, a new stake is held (230), so a stale
        // mint can never be read as the new stake's fill...
        const held = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        expect(held.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 230 });
        // ...and when it does land, it RESTORES cost — not a zero-cost donation that the
        // next harvest would send to the treasury as "yield". Since audit H2 it restores
        // min(amount · lastRate, writtenOff) and teaches NO rate: `writtenOff` accumulates
        // across write-offs, so a late mint may not restore more than it is worth. Here the
        // pool's rate is 1:1 and the 1/1 seed values the mint (X + the credit margin) above
        // X, so the whole stake comes back.
        for await (const tx of it) expect((tx as any).description.aborted).toBe(false);
        const restored = await ratchet.getStaking();
        expect(restored.stakedCost).toBe(before.stakedCost);
        expect(restored.realizedLoss).toBe(before.realizedLoss);
        expect(restored.tstonHeld).toBeGreaterThan(before.tstonHeld);
        expect(restored.tstonHeld - before.tstonHeld).toBeGreaterThanOrEqual(amount); // A·1 >= X
        expect(restored.lastRateNum).toBe(1n); // a late mint learns nothing
        expect(restored.lastRateDen).toBe(1n);
        expect((await ratchet.getStakingGates()).writtenOff).toBe(0n);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('refuses recovery INSIDE the window — a leg that is merely waiting its turn is not stranded', async () => {
        await strandInLeg3();
        const opened = (await ratchet.getExitLeg()).exitStartedAt;
        expect(opened).toBe(blockchain.now!);

        // One second short of 72 h. Leg 3's bill pays at round end (~36 h), so
        // the whole point of the window is that it cannot abort a live leg.
        blockchain.now = blockchain.now! + EXIT_RECOVERY - 1;
        const early = await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') });
        expect(early.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 232 });
        expect((await ratchet.getExitLeg()).leg).toBe(3); // and nothing moved

        // The clock is written ONCE, by `unstake`, and no later hop refreshes it.
        expect((await ratchet.getExitLeg()).exitStartedAt).toBe(opened);
    });

    it('recovers a leg 3 AFTER the window by WRITING IT OFF — the burned tsTON is never restored (D-197)', async () => {
        await stakeThenBreachTheReserve();
        const before = await ratchet.getStaking();
        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();

        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: 0n, value: toNano('0.05') });
        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(u, 'unstake into leg 3');
        expect((await ratchet.getExitLeg()).leg).toBe(3);

        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        const r = await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') });
        clean(r, 'recover_exit'); // MISTAKES.md 2026-09-17: the trace, never the balance

        // Leg 3's burn TOOK — a bounce or a re-mint would have aborted on arrival —
        // so the tsTON is gone and the unpaid basis is the realized loss. Nothing
        // comes back into `tstonHeld`, `pending` has not moved, and the
        // obligation (with `realizedLoss` as its sixth term) is conserved.
        const after = await ratchet.getStaking();
        expect(after.tstonHeld).toBeLessThan(before.tstonHeld);
        expect(after.stakedCost).toBe(before.stakedCost - after.realizedLoss);
        expect(after.realizedLoss).toBeGreaterThan(0n);
        expect(after.exiting).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await obligation()).toBe(obligationBefore);

        const e = await ratchet.getExitLeg();
        expect(e.leg).toBe(0);
        expect(e.inFlightExit).toBe(0n);
        expect(e.exitStartedAt).toBe(0);
    });

    it('after recovery the whole contract is callable again — `flush` above all', async () => {
        await strandInLeg3();
        // Past the flush cooldown, so `flush` reaches the exit guard rather than
        // refusing on the clock (207) and proving nothing.
        blockchain.now = blockchain.now! + 86400;

        // The staking arms are dead while the exit is outstanding — harvest too
        // (D-197: `tstonHeld` and `stakedCost` are mid-move).
        for (const send of [
            () => ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE }),
            () => ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE }),
            () => ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE }),
        ]) {
            expect((await send()).transactions).toHaveTransaction({ to: ratchet.address, exitCode: 230 });
        }
        // `flush` is NOT (D-197): leg 3 is paid by an opcode no flush reply
        // shares, so a ~36 h bill does not hold §4.3.1's core loop shut.
        await flushAway(toNano('1'));

        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        clean(await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') }), 'recover_exit');

        // The exit machine really works again: with the pool's buffer funded, a
        // fresh `unstake` fills on leg 1 and `pending` comes home.
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: toNano('1000'), value: toNano('0.05') });
        const target = (await ratchet.getStaking()).reserveTarget;
        const again = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(again, 'unstake after recovery');
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expectRestoredTo(await ratchet.getPending(), target);

        // And neither of the other two refuses on 230 any more. (`stake` still
        // refuses 226 — `pending` is back ON the reserve target, so there is
        // nothing above it to stake — which is the ordinary rule and not the
        // block this test is about.)
        for (const send of [
            () => ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE }),
            () => ratchet.sendFlush(keeper.getSender(), { value: FLUSH_VALUE, amount: toNano('1') }),
        ]) {
            expect((await send()).transactions).not.toHaveTransaction({ to: ratchet.address, exitCode: 230 });
        }
    });

    it('D-197: a bill that pays UNDER COST is written off at recovery — harvest cannot send the backing away', async () => {
        // THE DEFECT: the under-cost bill is credited PARTIALLY (a forged one
        // must not close a tranche), so the exit stayed open with a residual
        // basis nothing would ever pay. Recovery then ran `abortExit`, which put
        // the WHOLE burned tranche back into `tstonHeld` against only that
        // residual cost — and `harvest()` read the gap as yield and sent real
        // staked tsTON to the treasury.
        await stakeThenBreachTheReserve();
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: 0n, value: toNano('0.05') });
        // A slashing event: the pool's rate halves, so the bill pays half of cost.
        await pool.sendSetRate(keeper.getSender(), { rateNum: toNano('0.5'), rateDen: toNano('1'), value: toNano('0.05') });
        const obligationBefore = await obligation();

        clean(await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE }), 'unstake into leg 3');
        const opened = await ratchet.getStaking();
        const pendingOpened = await ratchet.getPending();
        clean(await pool.sendSettleBill(keeper.getSender(), { value: toNano('0.05') }), 'under-cost bill');

        // Credited what it paid, and the residual stays open.
        const paid = (await ratchet.getPending()) - pendingOpened;
        expect(paid).toBeGreaterThan(0n);
        const mid = await ratchet.getStaking();
        expect((await ratchet.getExitLeg()).leg).toBe(3);
        expect(mid.exiting).toBe(opened.exiting - paid);
        expect(mid.exiting).toBeGreaterThan(0n);

        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        clean(await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') }), 'recover_exit');

        const after = await ratchet.getStaking();
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expect(after.exiting).toBe(0n);
        expect(after.realizedLoss).toBe(mid.exiting); // the residual, published
        expect(after.tstonHeld).toBe(mid.tstonHeld); // no burned tsTON restored
        expect(after.stakedCost).toBe(mid.stakedCost);
        expect(await obligation()).toBe(obligationBefore);

        // Nothing is accrued, so nothing reaches the treasury.
        const h = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(h.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 229 }); // ratchet_harvest_dust
        expect(h.transactions).not.toHaveTransaction({ to: treasury.address });
    });

    it('a payout that arrives AFTER recovery is a donation, not a double credit', async () => {
        await strandInLeg3();
        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        clean(await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') }), 'recover_exit');

        const before = await obligation();
        const pendingBefore = await ratchet.getPending();
        // The bill settles late. `creditExitArrival` returns on the very state
        // recovery leaves behind (`inFlightExit == 0 && exitCostBasis == 0`), so
        // the GRAM joins the gas buffer instead of being counted a second time.
        const settle = await pool.sendSettleBill(keeper.getSender(), { value: toNano('0.05') });
        clean(settle, 'late settle');
        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await obligation()).toBe(before);
        expect((await ratchet.getStaking()).exiting).toBe(0n);
    });

    // -----------------------------------------------------------------------
    // The unauthenticatable senders
    // -----------------------------------------------------------------------

    it('a FORGED payout_distributed_asset moves no term of T — it is a donation', async () => {
        await stakeOnce('stake');
        const before = await obligation();
        const pendingBefore = await ratchet.getPending();

        // The bill collection's address is salted with random() upstream and
        // cannot be whitelisted, so this arm accepts any sender. What makes that
        // safe is arithmetic, not a check: with no exit outstanding there is
        // nothing to credit against, so the stranger's GRAM joins the gas buffer
        // and every term of `T` is where it was.
        const forged = await stranger.send({
            to: ratchet.address,
            value: toNano('7'),
            body: beginCell().storeUint(RATCHET.payout_distributed_asset, 32).storeUint(0, 64).endCell(),
        });
        clean(forged, 'forged distributed_asset');

        expect(await ratchet.getPending()).toBe(pendingBefore);
        expect(await obligation()).toBe(before);
        expect((await ratchet.getStaking()).exiting).toBe(0n);
    });

    // -----------------------------------------------------------------------
    // Forged replies interleaved with a LIVE round trip (2026-09-26). The tests
    // above forge with nothing outstanding, where every arm is trivially a
    // donation; the attacks need an open stake, exit or flush to land in.
    // `sendMessageIter` runs the trigger's first hop, the forgery lands, and
    // the rest of the genuine trace follows — the ordering a watcher of the
    // chain gets for free.
    // -----------------------------------------------------------------------

    /** What the ratchet's OWN tsTON wallet delivers when a stranger transfers it
     *  `amount` tsTON: a genuine `transfer_notification` from the wallet address
     *  (the mock is the wallet), with `from` = the stranger. One hop, so it can be
     *  dropped between two hops of a live round trip. */
    function forgedTston(amount: bigint) {
        return internal({
            from: pool.address,
            to: ratchet.address,
            value: toNano('0.1'),
            body: beginCell()
                .storeUint(TEP74.transfer_notification, 32)
                .storeUint(0, 64)
                .storeCoins(amount)
                .storeAddress(stranger.address)
                .storeUint(0, 1) // forward_payload, Either-left empty
                .endCell(),
        });
    }

    /** Drain an iterator, failing on any aborted transaction. */
    async function drain(it: AsyncIterable<any>, label: string) {
        for await (const tx of it) {
            expect({ label, aborted: tx.description.aborted }).toEqual({ label, aborted: false });
        }
    }

    /** Send `op` to the ratchet as `keeper` and run ONE hop; then the forgery,
     *  on its own queue (`allowParallel` — the sandbox's man-in-the-middle mode),
     *  lands and runs to completion; then the genuine trace resumes. */
    async function interleave(op: number, value: bigint, forged: ReturnType<typeof internal>, mid?: () => Promise<void>) {
        const it = await blockchain.sendMessageIter(
            internal({
                from: keeper.address,
                to: ratchet.address,
                value,
                body: beginCell().storeUint(op, 32).storeUint(0, 64).endCell(),
            }),
            { allowParallel: true },
        );
        const first = await it.next();
        expect((first.value as any).description.aborted).toBe(false);
        await drain(await blockchain.sendMessageIter(forged, { allowParallel: true }), 'forgery');
        if (mid) await mid();
        await drain(it, 'genuine trace');
    }

    it('a FORGED tsTON transfer during an in-flight stake cannot teach the rate — harvest has nothing to drain', async () => {
        // Before the fix the 1 nano-tsTON arrived first, was read as the mint,
        // and set `lastRateDen = 1`: `harvest()` then counted the whole reserve
        // as accrued yield and sent it to the treasury while `stakedCost` still
        // backed `T`.
        await interleave(RATCHET.stake, STAKE_VALUE, forgedTston(1n), async () => {
            // the forgery really landed first: the stake is still open
            expect((await ratchet.getStakingGates()).inFlightStake).toBeGreaterThan(0n);
        });

        const s = await ratchet.getStaking();
        expect(s.lastRateNum).toBe(s.stakedCost); // the genuine deposit taught it
        expect(s.lastRateDen).toBe(s.tstonHeld - 1n); // the forged nano is a donation
        expect((await ratchet.getStakingGates()).inFlightStake).toBe(0n);
        expect((await ratchet.getStakingGates()).stakeCredited).toBe(0n); // the real fill closed it

        blockchain.now = blockchain.now! + HARVEST_INTERVAL;
        const h = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(h.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 229 }); // ratchet_harvest_dust
    });

    it('a FORGED tsTON transfer during leg 1 is a donation, not a refusal that starts leg 2', async () => {
        await stakeThenBreachTheReserve();
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: toNano('1000'), value: toNano('0.05') });
        const before = await ratchet.getStaking();
        const obligationBefore = await obligation();
        let tranche = 0n;

        await interleave(RATCHET.unstake, UNSTAKE_VALUE, forgedTston(1n), async () => {
            tranche = (await ratchet.getExitLeg()).inFlightExit;
            expect((await ratchet.getExitLeg()).leg).toBe(1); // still leg 1: no swap was sent
        });

        const s = await ratchet.getStaking();
        expect(tranche).toBeGreaterThan(0n);
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expect(s.exiting).toBe(0n);
        expect(s.realizedLoss).toBe(0n);
        // exactly the tranche left, and the forged nano stayed
        expect(s.tstonHeld).toBe(before.tstonHeld - tranche + 1n);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('a FORGED withdrawal from a stranger cannot close an exit', async () => {
        await strandInLeg3();
        const before = await ratchet.getStaking();
        const pendingBefore = await ratchet.getPending();

        const f = await stranger.send({
            to: ratchet.address,
            value: toNano('0.02'),
            body: beginCell().storeUint(RATCHET.tonstakers_withdrawal, 32).storeUint(0, 64).endCell(),
        });
        clean(f, 'forged withdrawal');

        const s = await ratchet.getStaking();
        expect((await ratchet.getExitLeg()).leg).toBe(3);
        expect(s.exiting).toBe(before.exiting);
        expect(s.realizedLoss).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore);
    });

    it("a stranger's OWN burn naming the ratchet as response address pays the stranger and cannot close leg 1", async () => {
        // The pool pays the burning wallet's owner and ignores `response_address`
        // (`pool::withdraw`), so the only withdrawal the ratchet can receive is
        // its own. Burned mid-leg-1, while the exit is open and waiting.
        await stakeThenBreachTheReserve();
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: toNano('1000'), value: toNano('0.05') });
        const obligationBefore = await obligation();

        const strangerBurn = internal({
            from: stranger.address,
            to: pool.address,
            value: toNano('1'),
            body: beginCell()
                .storeUint(RATCHET.tston_burn, 32)
                .storeUint(0, 64)
                .storeCoins(1n)
                .storeAddress(ratchet.address) // response_address = the ratchet
                .storeMaybeRef(beginCell().storeUint(0, 1).storeUint(1, 1).endCell()) // fill_or_kill
                .endCell(),
        });

        await interleave(RATCHET.unstake, UNSTAKE_VALUE, strangerBurn, async () => {
            const leg = await ratchet.getExitLeg();
            expect(leg.leg).toBe(1); // the stranger's payout went to the stranger
            expect(leg.inFlightExit).toBeGreaterThan(0n);
        });

        const s = await ratchet.getStaking();
        expect((await ratchet.getExitLeg()).leg).toBe(0); // our own leg 1 closed it
        expect(s.exiting).toBe(0n);
        expect(s.realizedLoss).toBe(0n);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('a FORGED payout_distributed_asset during leg 3 credits what it pays and no more; the real bill closes the rest', async () => {
        await strandInLeg3();
        const before = await ratchet.getStaking();
        const obligationBefore = await obligation();
        const pendingBefore = await ratchet.getPending();
        const target = before.reserveTarget;
        const forged = toNano('0.02');

        const f = await stranger.send({
            to: ratchet.address,
            value: forged,
            body: beginCell().storeUint(RATCHET.payout_distributed_asset, 32).storeUint(0, 64).endCell(),
        });
        clean(f, 'forged distributed_asset in leg 3');

        // Same figure on both terms of `T`: a donation, not a closed exit.
        const mid = await ratchet.getStaking();
        expect((await ratchet.getExitLeg()).leg).toBe(3);
        expect(mid.exiting).toBe(before.exiting - forged);
        expect(mid.realizedLoss).toBe(0n);
        expect(await ratchet.getPending()).toBe(pendingBefore + forged);
        expect(await obligation()).toBe(obligationBefore);

        clean(await pool.sendSettleBill(keeper.getSender(), { value: toNano('0.05') }), 'settle bill');
        const s = await ratchet.getStaking();
        expect((await ratchet.getExitLeg()).leg).toBe(0);
        expect(s.exiting).toBe(0n);
        expect(s.realizedLoss).toBe(0n);
        expectRestoredTo(await ratchet.getPending(), target);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('a FORGED ownership_assigned and a stray excesses are accepted and change nothing', async () => {
        await stakeOnce('stake');
        const before = await obligation();
        const s0 = await ratchet.getStaking();

        for (const body of [
            beginCell()
                .storeUint(RATCHET.payout_ownership_assigned, 32)
                .storeUint(0, 64)
                .storeUint(0, 2) // prev_owner = addr_none
                .storeUint(0, 1) // forward_payload
                .endCell(),
            beginCell().storeUint(RATCHET.excesses, 32).storeUint(0, 64).endCell(),
        ]) {
            const r = await stranger.send({ to: ratchet.address, value: toNano('0.5'), body });
            // The point of these arms: without them the catch-all `throw 101`
            // eats a protocol reply and paints the trace red while the balance
            // looks right (MISTAKES.md 2026-09-17).
            clean(r, 'non-bounceable reply');
        }

        const s1 = await ratchet.getStaking();
        expect(s1.stakedCost).toBe(s0.stakedCost);
        expect(s1.tstonHeld).toBe(s0.tstonHeld);
        expect(s1.exiting).toBe(s0.exiting);
        expect(await obligation()).toBe(before);
    });

    it('never burns the reserve: a tsTON notification is NOT answered with a burn-back', async () => {
        // The §4.3 proceeds leg answers a notification with a burn of exactly
        // what arrived. If that branch caught the tsTON wallet too, the reserve
        // would be burned as fast as it is staked — the branch IS the safety.
        const r = await stakeOnce('stake');
        expect(r.transactions).not.toHaveTransaction({
            from: ratchet.address,
            to: pool.address,
            op: TEP74.burn,
        });
        expect((await ratchet.getStaking()).tstonHeld).toBeGreaterThan(0n);
    });

    // -----------------------------------------------------------------------
    // AUDIT H2 / M1 (docs/audit/contract-audit-2026-11-19.md) — THE
    // NON-OPTIMISTIC FILL. With Tonstakers' `optimistic_deposit` off
    // (`pool.func:291-301`, governor-settable) a deposit becomes a payout bill and
    // its tsTON arrives at round end as a jetton TRANSFER from the payout
    // collection — `from` is the collection, never `addr_none`. So the ratchet's
    // OWN fill is unauthenticatable, and before the fix it landed as a zero-cost
    // donation: `recover_exit` wrote the stake off and `harvest()` then sent the
    // whole fill — tsTON backing `T` — to the treasury. No attacker needed.
    // -----------------------------------------------------------------------

    const RATE_105 = { rateNum: toNano('1.05'), rateDen: toNano('1') };

    async function nonOptimistic(on = false) {
        const collection = await blockchain.treasury('billCollection');
        clean(await pool.sendSetOptimistic(keeper.getSender(), {
            optimistic: on,
            collection: collection.address,
            value: toNano('0.05'),
        }), 'set optimistic');
    }

    async function poolRate(r: { rateNum: bigint; rateDen: bigint }) {
        await pool.sendSetRate(keeper.getSender(), { ...r, value: toNano('0.05') });
    }

    async function injectMore() {
        await ratchet.sendPoolInject(fakeLedger.getSender(), {
            amount: INJECTED,
            tSnapshot: INJECTED * 2n,
            sSnapshot: toNano('1000000'),
            value: INJECTED + toNano('0.01'),
        });
    }

    /** Round end: the bill pays as a 0.01 GRAM transfer whose `from` is the collection. */
    async function settleDepositBill(label: string) {
        const r = await pool.sendSettleDepositBill(keeper.getSender(), { value: toNano('0.05') });
        clean(r, label); // the ratchet's handler fits in the bill's 0.01 GRAM
        expect(r.transactions).toHaveTransaction({
            from: pool.address,
            to: ratchet.address,
            op: TEP74.transfer_notification,
            success: true,
        });
        return r;
    }

    async function recoverAfterWindow(label: string) {
        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        clean(await ratchet.sendRecoverExit(stranger.getSender(), { value: toNano('0.05') }), label);
    }

    /** The harvest refuses on dust and nothing at all reaches the treasury. */
    async function expectNothingToHarvest() {
        const h = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(h.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 229 }); // ratchet_harvest_dust
        expect(h.transactions).not.toHaveTransaction({ to: treasury.address });
    }

    it('2026-11-23: the stake credit margin outbids the forward fee, so a learned rate never over-states GRAM per tsTON', async () => {
        // The pool credits `value - 1 GRAM`, and the forward fee comes off `value`. With no
        // margin the credit is X − fwd_fee and the floored mint makes X/minted ABOVE the pool's
        // rate — the side B37's keep-the-higher rule, the late-mint restore and leg 2 rely on
        // never seeing.
        await poolRate(RATE_105);
        await stakeOnce('optimistic stake at 1.05');
        const s = await ratchet.getStaking();
        expect(s.lastRateNum).toBe(s.stakedCost);
        expect(s.lastRateNum * RATE_105.rateDen).toBeLessThanOrEqual(RATE_105.rateNum * s.lastRateDen);
    });

    it('H2 T1: a first stake filled non-optimistically is credited at the seed rate; recover_exit writes off only the residual and harvest sends nothing', async () => {
        await nonOptimistic();
        await poolRate(RATE_105);
        const obligationBefore = await obligation();
        const r = await stakeOnce('non-optimistic stake');
        // A bill was minted, not tsTON: the stake stays open.
        expect(r.transactions).toHaveTransaction({ from: pool.address, to: ratchet.address, op: RATCHET.payout_ownership_assigned });
        const X = (await ratchet.getStakingGates()).inFlightStake;
        expect(X).toBeGreaterThan(0n);

        await settleDepositBill('bill pays');
        const A = (await ratchet.getStaking()).tstonHeld;
        expect(A).toBeGreaterThan(0n);
        expect(A).toBeLessThan(X); // 1 tsTON > 1 GRAM: the fill is fewer tsTON than the stake's GRAM
        const open = await ratchet.getStakingGates();
        expect(open.inFlightStake).toBe(X); // the unauthenticated fill never closes the stake
        expect(open.stakeCredited).toBe(A); // ...but carries its cost, at the seed 1/1
        await recoverAfterWindow('recover the stake');

        await expectNothingToHarvest();
        const s = await ratchet.getStaking();
        // Credited at the 1/1 seed: A of X was matched, only X − A is a loss.
        expect(s.realizedLoss).toBe(X - A);
        expect(s.stakedCost).toBe(A);
        expect(s.tstonHeld).toBe(A);
        expect(s.lastRateNum).toBe(1n); // an unauthenticated arrival teaches no rate
        expect(s.lastRateDen).toBe(1n);
        const gates = await ratchet.getStakingGates();
        expect(gates.writtenOff).toBe(X - A);
        expect(gates.inFlightStake).toBe(0n);
        expect(gates.stakeCredited).toBe(0n);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('H2 T2: with a learned rate, a non-optimistic stake writes off only the drift; the treasury gets no backing', async () => {
        await stakeOnce('optimistic stake 1');
        const s1 = await ratchet.getStaking();
        await poolRate(RATE_105);
        await injectMore();
        await nonOptimistic();
        const obligationBefore = await obligation();
        await stakeOnce('non-optimistic stake 2');
        const X2 = (await ratchet.getStakingGates()).inFlightStake;
        const held = (await ratchet.getStaking()).tstonHeld;

        await settleDepositBill('bill 2 pays');
        const A2 = (await ratchet.getStaking()).tstonHeld - held;
        const credited = (A2 * s1.lastRateNum) / s1.lastRateDen; // at the last learned rate
        expect(credited).toBeLessThan(X2);
        await recoverAfterWindow('recover stake 2');

        await expectNothingToHarvest();
        const s = await ratchet.getStaking();
        expect(s.realizedLoss).toBe(X2 - credited); // the drift since the last learned rate
        expect(s.stakedCost).toBe(s1.stakedCost + credited);
        expect(s.lastRateNum).toBe(s1.lastRateNum);
        expect(s.lastRateDen).toBe(s1.lastRateDen);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('H2 T3: stranger tsTON in the window credits only d·r and teaches no rate; the bill credits the rest', async () => {
        await stakeOnce('optimistic stake 1');
        const s1 = await ratchet.getStaking();
        await poolRate(RATE_105);
        await injectMore();
        await nonOptimistic();
        const obligationBefore = await obligation();
        await stakeOnce('non-optimistic stake 2');
        const X2 = (await ratchet.getStakingGates()).inFlightStake;
        const held = (await ratchet.getStaking()).tstonHeld;

        const d = toNano('1');
        clean(await blockchain.sendMessage(forgedTston(d)), 'stranger tsTON');
        const dCredit = (d * s1.lastRateNum) / s1.lastRateDen;
        expect((await ratchet.getStakingGates()).stakeCredited).toBe(dCredit); // d · r, no more
        await settleDepositBill('bill 2 pays');
        const s = await ratchet.getStaking();
        expect(s.lastRateNum).toBe(s1.lastRateNum);
        expect(s.lastRateDen).toBe(s1.lastRateDen);
        // Neither arrival closes the stake: only an authenticated mint may.
        expect((await ratchet.getStakingGates()).inFlightStake).toBe(X2);
        const A2 = s.tstonHeld - held - d;

        await recoverAfterWindow('recover stake 2');
        const credited = dCredit + (A2 * s1.lastRateNum) / s1.lastRateDen;
        expect((await ratchet.getStaking()).realizedLoss).toBe(X2 - credited);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('H2 T4: a bill that pays AFTER recover_exit restores min(A·r, writtenOff); harvest sends nothing', async () => {
        await nonOptimistic();
        await poolRate(RATE_105);
        await stakeOnce('non-optimistic stake');
        const X = (await ratchet.getStakingGates()).inFlightStake;
        await recoverAfterWindow('recover the unpaid stake');
        expect((await ratchet.getStakingGates()).writtenOff).toBe(X);
        const obligationBefore = await obligation();

        await settleDepositBill('late bill');
        const s = await ratchet.getStaking();
        const A = s.tstonHeld;
        expect(s.stakedCost).toBe(A); // A·1 at the seed rate, and A < X
        expect(s.realizedLoss).toBe(X - A);
        expect((await ratchet.getStakingGates()).writtenOff).toBe(X - A);
        expect(await obligation()).toBe(obligationBefore);
        await expectNothingToHarvest();
    });

    it('H2 T5: a bill that pays after the two-window hold and a fresh stake still restores; harvest takes only real yield', async () => {
        await nonOptimistic();
        await poolRate(RATE_105);
        await stakeOnce('non-optimistic stake 1');
        const X1 = (await ratchet.getStakingGates()).inFlightStake;
        await recoverAfterWindow('recover stake 1');
        blockchain.now = blockchain.now! + EXIT_RECOVERY; // two windows since the stake

        await nonOptimistic(true);
        await injectMore();
        await stakeOnce('optimistic stake 2 after the hold');
        const s2 = await ratchet.getStaking();
        const obligationBefore = await obligation();

        await settleDepositBill('bill 1 pays, very late');
        const mid = await ratchet.getStaking();
        const A1 = mid.tstonHeld - s2.tstonHeld;
        let restored = (A1 * s2.lastRateNum) / s2.lastRateDen;
        if (restored > X1) restored = X1;

        // The harvest takes exactly the accrual its own formula sees, and that accrual is
        // the bill's STAKE_CREDIT_MARGIN surplus — never the bill. Under 0.01 GRAM it is
        // dust, so the harvest refuses and nothing leaves.
        const accrued = mid.tstonHeld - (mid.stakedCost * mid.lastRateDen) / mid.lastRateNum;
        expect(accrued).toBeGreaterThanOrEqual(0n);
        expect(accrued).toBeLessThan(toNano('0.01'));
        await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(mid.tstonHeld - (await ratchet.getStaking()).tstonHeld).toBe(accrued >= HARVEST_DUST ? accrued : 0n);
        expect(mid.stakedCost).toBe(s2.stakedCost + restored);
        expect(mid.realizedLoss).toBe(X1 - restored);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('H2 T6: stranger tsTON after a write-off restores only d·r of it', async () => {
        await nonOptimistic();
        await stakeOnce('non-optimistic stake');
        const X = (await ratchet.getStakingGates()).inFlightStake;
        await recoverAfterWindow('recover the unpaid stake');
        const obligationBefore = await obligation();

        const d = toNano('3');
        clean(await blockchain.sendMessage(forgedTston(d)), 'stranger tsTON');
        const s = await ratchet.getStaking();
        expect(s.stakedCost).toBe(d); // d · 1/1 — a stranger restores cost only by paying it
        expect(s.realizedLoss).toBe(X - d);
        expect(s.tstonHeld).toBe(d);
        expect((await ratchet.getStakingGates()).writtenOff).toBe(X - d);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('H2 T8: a written-off bill that lands during a later open stake spills past it into the write-off', async () => {
        // Bill 1 is written off; after the hold a second non-optimistic stake opens
        // and the round pays BOTH bills (the mock's one slot sums them). Credited
        // against stake 2 alone, the surplus would sit at zero cost and harvest.
        await nonOptimistic();
        await poolRate(RATE_105);
        await stakeOnce('non-optimistic stake 1');
        await recoverAfterWindow('recover stake 1');
        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        await injectMore();
        await stakeOnce('non-optimistic stake 2');
        const obligationBefore = await obligation();

        await settleDepositBill('both bills pay');
        await recoverAfterWindow('recover stake 2');
        await expectNothingToHarvest();
        const s = await ratchet.getStaking();
        expect(s.stakedCost).toBe(s.tstonHeld); // every tsTON carries cost at r = 1/1
        expect(await obligation()).toBe(obligationBefore);
    });

    it('H2 B1: when a rate is learned after a credited non-optimistic stake, the write-off is restored before harvest sees it', async () => {
        // The first stake is valued at the 1/1 seed against a true 1.05, so X − A is written
        // off while its tsTON is still held. Without a restore on the next authenticated fill,
        // harvest at the learned rate reads that tsTON as yield and sends it to the treasury.
        await nonOptimistic();
        await poolRate(RATE_105);
        await stakeOnce('non-optimistic stake 1');
        await settleDepositBill('bill 1 pays');
        await recoverAfterWindow('recover stake 1');
        const W = (await ratchet.getStakingGates()).writtenOff;
        expect(W).toBeGreaterThan(0n);
        blockchain.now = blockchain.now! + EXIT_RECOVERY; // the hold

        await nonOptimistic(true);
        await injectMore();
        const obligationBefore = await obligation();
        await stakeOnce('optimistic stake 2 teaches the rate');
        const s = await ratchet.getStaking();
        expect((await ratchet.getStakingGates()).writtenOff).toBe(0n);
        expect(s.realizedLoss).toBe(0n);
        expect(await obligation()).toBe(obligationBefore);

        const accrued = s.tstonHeld - (s.stakedCost * s.lastRateDen) / s.lastRateNum;
        expect(accrued).toBeLessThan(toNano('0.01')); // the credit-margin surplus only — not the ~36 tsTON behind W
        const before = s.tstonHeld;
        await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        expect(before - (await ratchet.getStaking()).tstonHeld).toBe(accrued >= HARVEST_DUST ? accrued : 0n);
    });

    it('H2 nit 1: a written-off bill that lands between an optimistic stake and its mint still restores the write-off', async () => {
        await nonOptimistic();
        await poolRate(RATE_105);
        await stakeOnce('non-optimistic stake 1');
        const X1 = (await ratchet.getStakingGates()).inFlightStake;
        await recoverAfterWindow('recover the unpaid stake 1');
        expect((await ratchet.getStakingGates()).writtenOff).toBe(X1);
        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        await nonOptimistic(true);
        await injectMore();
        const obligationBefore = await obligation();

        const bill = internal({
            from: keeper.address,
            to: pool.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0x92000035, 32).storeUint(0, 64).endCell(), // SettleDepositBill
        });
        await interleave(RATCHET.stake, STAKE_VALUE, bill, async () => {
            expect((await ratchet.getStakingGates()).inFlightStake).toBeGreaterThan(0n); // landed mid-stake
        });
        const s = await ratchet.getStaking();
        expect((await ratchet.getStakingGates()).inFlightStake).toBe(0n);
        expect((await ratchet.getStakingGates()).writtenOff).toBe(0n);
        expect(s.realizedLoss).toBe(0n);
        expect(await obligation()).toBe(obligationBefore);
        const accrued = s.tstonHeld - (s.stakedCost * s.lastRateDen) / s.lastRateNum;
        expect(accrued).toBeLessThan(toNano('1'));
    });

    it('H2 nit 2: a stranded stake covered by a donation still holds the next stake for two windows', async () => {
        // The mint is lost; a stranger's tsTON covers the whole stake, so nothing is written
        // off — and the late mint must still not be read as the NEXT stake's fill.
        const iter = await blockchain.sendMessageIter(
            internal({
                from: keeper.address,
                to: ratchet.address,
                value: STAKE_VALUE,
                body: beginCell().storeUint(RATCHET.stake, 32).storeUint(0, 64).endCell(),
            }),
            { allowParallel: true },
        );
        await iter.next();
        const X = (await ratchet.getStakingGates()).inFlightStake;
        clean(await blockchain.sendMessage(forgedTston(X)), 'a donation covering the stake');
        await recoverAfterWindow('recover the stake');
        expect((await ratchet.getStakingGates()).writtenOff).toBe(0n);

        await injectMore();
        const held = await ratchet.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        expect(held.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 230 });
        blockchain.now = blockchain.now! + EXIT_RECOVERY;
        await stakeOnce('stake after two windows');
    });

    it('H2 nit 3: a leg-1 re-mint that lands after recover_exit aborted the exit is not counted twice', async () => {
        await stakeThenBreachTheReserve();
        await pool.sendSetBuffer(keeper.getSender(), { freeTon: 0n, value: toNano('0.05') });
        const iter = await blockchain.sendMessageIter(
            internal({
                from: keeper.address,
                to: ratchet.address,
                value: UNSTAKE_VALUE,
                body: beginCell().storeUint(RATCHET.unstake, 32).storeUint(0, 64).endCell(),
            }),
            { allowParallel: true },
        );
        await iter.next(); // the ratchet sends leg 1's burn
        await iter.next(); // the pool refuses and re-mints — the reply is now in flight
        expect((await ratchet.getExitLeg()).leg).toBe(1);
        await recoverAfterWindow('recover leg 1');
        const recovered = await ratchet.getStaking();
        const obligationBefore = await obligation();

        await drain(iter, 'the late re-mint');
        const s = await ratchet.getStaking();
        expect(s.tstonHeld).toBe(recovered.tstonHeld); // the tranche is already back
        expect(s.stakedCost).toBe(recovered.stakedCost);
        expect(await obligation()).toBe(obligationBefore);
    });

    it('H2 B1(b): while the rate is still the seed, a refused leg 1 skips the DeDust swap and goes to the exact-rate bill', async () => {
        await nonOptimistic();
        await poolRate(RATE_105);
        await stakeOnce('non-optimistic stake');
        await settleDepositBill('bill pays');
        await recoverAfterWindow('recover the stake');
        expect((await ratchet.getStaking()).lastRateNum).toBe(1n); // never learned
        await flushAway((await ratchet.getStaking()).reserveTarget / 2n);
        await pool.sendSetDedustTon(keeper.getSender(), { dedustTon: toNano('2000'), value: toNano('0.05') });

        const u = await ratchet.sendUnstake(keeper.getSender(), { value: UNSTAKE_VALUE });
        clean(u, 'unstake on the seed rate');
        expect(u.transactions).not.toHaveTransaction({ from: ratchet.address, to: pool.address, op: TEP74.transfer });
        expect(u.transactions).toHaveTransaction({ from: pool.address, to: ratchet.address, op: RATCHET.payout_ownership_assigned });
        expect((await ratchet.getExitLeg()).leg).toBe(3);
    });

    it('M1 T7: harvest reaches the REAL treasury with gas to run — its tstonBalance grows by exactly the accrual', async () => {
        const realTreasury = blockchain.openContract(
            PrimesTreasury.createFromConfig(
                {
                    operatorAddr: deployer.address,
                    sinkAddr: deployer.address,
                    stakeAddr: deployer.address,
                    distributionRateBpsPerDay: 100, // fixture; harvest does not read it
                    positionCode: await compile('PrimesLpPosition'),
                    genesisScriptAddr: genesisScript.address,
                },
                await compile('PrimesTreasury')
            )
        );
        await realTreasury.sendDeploy(deployer.getSender(), toNano('10'));
        await realTreasury.sendSetWallets(genesisScript.getSender(), {
            lpJettonWallet: stranger.address,
            primesJettonWallet: primesWallet.address,
            tstonJettonWallet: pool.address, // the mock is every tsTON wallet
            value: toNano('0.1'),
        });
        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    ledgerAddr: fakeLedger.address,
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: pool.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                    tonstakersPool: pool.address,
                    dedustTstonVault: pool.address,
                    dedustTstonPool: deployer.address,
                    treasuryAddr: realTreasury.address,
                },
                await compile('PrimesRatchet')
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));
        await ratchet.sendSetTstonWallet(genesisScript.getSender(), { tstonWalletAddr: pool.address, value: toNano('0.05') });
        await ratchet.sendPoolInject(fakeLedger.getSender(), {
            amount: INJECTED,
            tSnapshot: INJECTED,
            sSnapshot: toNano('1000000'),
            value: INJECTED + toNano('0.01'),
        });
        await stakeTwiceAcrossARateRise();

        const before = (await ratchet.getStaking()).tstonHeld;
        const h = await ratchet.sendHarvest(keeper.getSender(), { value: HARVEST_VALUE });
        clean(h, 'harvest to the real treasury');
        const accrued = before - (await ratchet.getStaking()).tstonHeld;
        expect(accrued).toBeGreaterThan(0n);
        expect(h.transactions).toHaveTransaction({ from: pool.address, to: realTreasury.address, success: true });
        expect((await realTreasury.getTreasuryBalances()).tstonBalance).toBe(accrued);
    });

    // D-194. `stake()` sends `pending - reserve` to the Tonstakers pool in one
    // message, so the one admin message this contract takes must not be able to
    // re-point it. In this harness the deployer IS `venueTimelockAddr`, so it can
    // send `update_venue` directly — as the timelock would after a confirmed vote.
    it('D-194: update_venue re-points the flush venue and never the staking venue — stake() still pays the deploy-time pool', async () => {
        const attacker = await blockchain.treasury('attacker');
        const venueBody = (withStakingRef: boolean) => {
            const b = beginCell()
                .storeUint(RATCHET.update_venue, 32)
                .storeUint(0, 64)
                .storeAddress(stranger.address)
                .storeAddress(stranger.address)
                .storeAddress(stranger.address);
            // The pre-D-194 wire shape: a staking ref aimed at the attacker.
            if (withStakingRef) {
                b.storeRef(
                    beginCell()
                        .storeAddress(attacker.address)
                        .storeAddress(attacker.address)
                        .storeAddress(attacker.address)
                        .storeRef(beginCell().storeAddress(attacker.address).endCell())
                        .endCell()
                );
            }
            return b.endCell();
        };

        const ok = await deployer.send({ to: ratchet.address, value: toNano('0.1'), body: venueBody(false) });
        clean(ok, 'update_venue');
        expect((await ratchet.getVenue()).dedustNativeVault.toString()).toBe(stranger.address.toString());
        // Whatever the ratchet does with a trailing staking ref, it cannot apply it.
        await deployer.send({ to: ratchet.address, value: toNano('0.1'), body: venueBody(true) });

        const v = await ratchet.getStakingVenue();
        expect(v.tonstakersPool.toString()).toBe(pool.address.toString());
        expect(v.dedustTstonVault.toString()).toBe(pool.address.toString());
        expect(v.dedustTstonPool.toString()).toBe(deployer.address.toString());
        expect((await ratchet.getHarvestDest()).toString()).toBe(treasury.address.toString());

        const r = await stakeOnce('stake after update_venue');
        expect(r.transactions).toHaveTransaction({ from: ratchet.address, to: pool.address, success: true });
        expect(r.transactions).not.toHaveTransaction({ from: ratchet.address, to: attacker.address });
        expect(r.transactions).not.toHaveTransaction({ from: ratchet.address, to: stranger.address });
        expect((await ratchet.getStaking()).stakedCost).toBeGreaterThan(0n);
    });

    it('publishes the venue, the wallet and the harvest destination', async () => {
        // §9.1: every number and address the dashboard shows maps to a
        // get-method, and `getVenue`'s 3-tuple is unchanged so nothing reading it
        // has to move.
        const v = await ratchet.getStakingVenue();
        expect(v.tonstakersPool.toString()).toBe(pool.address.toString());
        expect((await ratchet.getHarvestDest()).toString()).toBe(treasury.address.toString());
        const w = await ratchet.getTstonWallet();
        expect(w.walletSet).toBe(1);
        expect(w.tstonWalletAddr.toString()).toBe(pool.address.toString());
        const legacy = await ratchet.getVenue();
        expect(legacy.dedustNativeVault.toString()).toBe(pool.address.toString());
    });

    // -----------------------------------------------------------------------
    // D-153 — the deploy-time stake divisor
    // -----------------------------------------------------------------------

    /** A second ratchet, identical but for `stakeDivisor`, funded with a
     *  `pending` far BELOW the mainnet threshold. Everything else — the venue,
     *  the wallet bootstrap, the gas buffer — is the same fixture, so the only
     *  variable between the assertions below is the divisor.
     *
     *  `salt` IS LOAD-BEARING, and leaving it out cost a red gate. A contract's
     *  address is its init data, so two calls with the same config are the SAME
     *  CONTRACT — and `stakeDivisor: undefined` serialises to 1, which is also
     *  the `beforeEach` fixture's config. Without a salt the first iteration of
     *  the identity loop below re-opened the already-deployed ratchet carrying
     *  `INJECTED`, so `pending` was 1100 GRAM, the stake was 880, and the 226 it
     *  was written to prove never fired. The salt goes in `dedustPool`, which
     *  these tests never send to. */
    async function dividedRatchet(salt: string, stakeDivisor: number | undefined, pending: bigint) {
        const unique = await blockchain.treasury(`divisor-${salt}`);
        const r = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    ledgerAddr: fakeLedger.address,
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: pool.address,
                    dedustPool: unique.address,
                    primesJettonVault: deployer.address,
                    tonstakersPool: pool.address,
                    dedustTstonVault: pool.address,
                    dedustTstonPool: deployer.address,
                    treasuryAddr: treasury.address,
                    stakeDivisor,
                },
                await compile('PrimesRatchet')
            )
        );
        await r.sendDeploy(deployer.getSender(), toNano('10'));
        await r.sendSetTstonWallet(genesisScript.getSender(), {
            tstonWalletAddr: pool.address,
            value: toNano('0.05'),
        });
        await r.sendPoolInject(fakeLedger.getSender(), {
            amount: pending,
            tSnapshot: pending,
            sSnapshot: toNano('1000000'),
            value: pending + toNano('0.01'),
        });
        return r;
    }

    it('MAINNET IS THE IDENTITY: omitted and 1 both enforce the declared stake_min_ton', async () => {
        // The assertion that makes "this changes nothing on mainnet" a test
        // rather than a claim, and it is the same shape D-139's own identity
        // test takes.
        for (const divisor of [undefined, 1]) {
            const r = await dividedRatchet(`identity-${divisor}`, divisor, STAKE_MIN);
            expect(await r.getStakeMin()).toBe(STAKE_MIN);
            // `pending` = STAKE_MIN gives a 0.8 × STAKE_MIN stake — under the minimum.
            const attempt = await r.sendStake(keeper.getSender(), { value: STAKE_VALUE });
            expect(attempt.transactions).toHaveTransaction({ to: r.address, exitCode: 226 });
        }
    });

    it('a divided deploy publishes the divided minimum AND enforces it', async () => {
        // 168 is the testnet figure — the same divisor `PRIMES_AUCTION_SECONDS
        // = 3600` produces for the clocks, so a wave can set both from one
        // decision. 50/168 = 0.298 GRAM, and the reserve takes 20%, so a stake
        // becomes legal at ~0.37 GRAM of `pending` instead of 62.5.
        const r = await dividedRatchet('divided', 168, toNano('100'));
        expect(await r.getStakeMin()).toBe(STAKE_MIN / 168n);

        const staked = await r.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        clean(staked, 'divided stake');
        expect(staked.transactions).not.toHaveTransaction({ to: r.address, exitCode: 226 });

        // And it really staked: 80 GRAM — the same `pending − reserveTarget` the
        // undivided contract computes — left `pending` for `stakedCost`. The
        // divisor moves the GATE and nothing about the arithmetic behind it.
        const k = await r.getStaking();
        expect(k.stakedCost).toBe(toNano('80'));
        expect(await r.getPending()).toBe(toNano('20'));
    });

    it('the divisor is deploy-time only — no message reaches it', async () => {
        // §8's zero-admin claim, checked on the new field rather than assumed
        // from the old one. There is no setter, so the strongest available proof
        // is that the figure is unchanged after the contract has handled every
        // arm a sender can reach it with.
        const r = await dividedRatchet('no-setter', 168, toNano('100'));
        const before = await r.getStakeMin();
        await r.sendStake(keeper.getSender(), { value: STAKE_VALUE });
        await r.sendHarvest(stranger.getSender(), { value: HARVEST_VALUE });
        await r.sendUnstake(stranger.getSender(), { value: UNSTAKE_VALUE });
        expect(await r.getStakeMin()).toBe(before);
    });

    it('SetTstonWallet is one-shot and genesis-only', async () => {
        const wrongSender = await ratchet.sendSetTstonWallet(stranger.getSender(), {
            tstonWalletAddr: stranger.address,
            value: toNano('0.05'),
        });
        expect(wrongSender.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 100 });

        const twice = await ratchet.sendSetTstonWallet(genesisScript.getSender(), {
            tstonWalletAddr: stranger.address,
            value: toNano('0.05'),
        });
        expect(twice.transactions).toHaveTransaction({ to: ratchet.address, exitCode: 104 });
    });
});
