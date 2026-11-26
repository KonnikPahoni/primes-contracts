/**
 * TON PRIMES — §4.3.2's STAKED RESERVE, driven at a live node (D-151).
 *
 * `primes_ratchet.tolk` deposits idle `pending` above a liquid reserve into
 * Tonstakers, holds it as tsTON, counts it in `T` AT COST, exits by rule when
 * `flush()` needs the GRAM back, and once per 30 days sends the accrued tsTON to
 * the LP-governed treasury. `contracts/tests/RatchetStaking.spec.ts` proves all
 * of that in `@ton/sandbox`; this file is what proves it on a chain.
 *
 * WHY A TESTNET RUN ADDS ANYTHING OVER THE SANDBOX, since the counterparty is a
 * mock on both:
 *
 *  1. **The genesis wiring.** `SetTstonWallet` and the treasury's third wallet
 *     are ONE-SHOT bootstraps, and the staking venue is address-determining deploy
 *     data on the ratchet. A sandbox fixture wires them by construction; only a
 *     real genesis can get them wrong, and `STAKING_PLAN.md` P4 is exactly that
 *     step.
 *  2. **Every reply on this path is NON-BOUNCEABLE** — the deposit's
 *     `transfer_notification` and `excesses`, leg 1's `withdrawal`, leg 3's
 *     `ownership_assigned` and `distributed_asset`. That is the 2026-09-17 class
 *     in `MISTAKES.md`: the value is credited before the compute phase throws, so
 *     the balances reconcile and the only trace is a red row in an explorer.
 *     `txAudit.ts` is the check, and it only exists against a real chain.
 *  3. **The read surface**: `/ratchet/staking` on the read-proxy and the
 *     `RatchetPanel`'s staked segment render `getStaking()`, and §9.1 says every
 *     number the UI shows maps to a get-method somebody has actually called.
 *
 * WHAT IT DOES NOT ADD: anything about the RATE. There is no Tonstakers pool on
 * testnet and there cannot be a useful one — the rate only moves when a Controller
 * lends to an Approver-approved validator that wins a testnet election
 * (`STAKING_PLAN.md` P0 point 1) — so genesis points all five of §4.3.2's
 * addresses at `contracts/test-mocks/mock_tonstakers_pool.tolk`, whose knobs are
 * deliberately unauthenticated. The economics remain a sandbox claim.
 *
 * THE THRESHOLD, which used to decide this phase's whole budget. The liquid
 * reserve is 20% of the obligation, so `amount = pending − 0.2·pending` must
 * clear the stake minimum — which at the declared 50 GRAM means **`pending`
 * above 62.5 GRAM**, and `pending` is not fundable by a plain top-up (that
 * credits the gas buffer, deliberately not a term of `T`). The only
 * permissionless route in is `donate_floor#b000000c`, and §8 guarantees that
 * GRAM never comes back.
 *
 * `DECISIONS.md` **D-153** made the minimum deploy-time: `test_overrides.stake_min_ton: 3`
 * puts it at 2.976 GRAM and `stake` becomes legal at ~3.72 GRAM of `pending`,
 * which a run reaches in phase 1. **This file reads `getStakeMin()` and never a
 * constant**, so it is correct against a set deployed either way.
 *
 *   npx tsx contracts/scripts/testnet/tston.ts status
 *   npx tsx contracts/scripts/testnet/tston.ts refusals
 *   npx tsx contracts/scripts/testnet/tston.ts buffer <GRAM> [handle]
 *   npx tsx contracts/scripts/testnet/tston.ts rate <num> <den> [handle]
 *   npx tsx contracts/scripts/testnet/tston.ts stake [handle]
 *   npx tsx contracts/scripts/testnet/tston.ts yield <tsTON> [handle]
 *   npx tsx contracts/scripts/testnet/tston.ts harvest [handle]
 *   npx tsx contracts/scripts/testnet/tston.ts exit <leg1|leg2|leg3|loss> [handle]
 *   npx tsx contracts/scripts/testnet/tston.ts settle [handle]
 *   npx tsx contracts/scripts/testnet/tston.ts forge [handle]
 *
 * `handle` defaults to `F`, a wallet with no authority over anything — which is
 * the point: all three arms are permissionless.
 */
import { beginCell, toNano, type Address } from '@ton/core';
import { PrimesTreasury } from '../../wrappers/PrimesTreasury';
import { MockTonstakersPool } from '../../wrappers/MockTonstakersPool';
import { STAKE_VALUE, UNSTAKE_VALUE, HARVEST_VALUE } from '../../wrappers/PrimesRatchet';
import { RATCHET } from '../../../shared/opcodes';
import { retry } from './sender';
import { addr, contracts, foreignCredits, snapshot, walletFor, type Contracts, type Snapshot } from './chain';
import * as A from './assert';
import { fromAsserts, record } from './journal';

/** Long enough for a three-hop staking round trip (us → pool → wallet → us). */
const SETTLE_MS = 40_000;
/** The ratchet's `EXIT_LEG_BILL` (primes_ratchet.tolk): leg 3 parked on its payout bill. */
const EXIT_LEG_BILL = 3;

/**
 * SETTLE_MS, then — when the step HAS a terminal state — poll that state (one cheap read)
 * for up to 3 more minutes. The fixed wait alone read the 20261124 `yield` 2 s before its
 * tsTON landed at the ratchet (08:06:02) and journalled a red step for a credit that arrived.
 * Poll the TERMINAL predicate, never "something moved": an exit passes through states
 * (`exiting` rises, then falls) and a first-change poll would snapshot mid-trace.
 */
async function settle(done?: () => Promise<boolean>) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    for (let i = 0; done && i < 18; i++) {
        if (await done().catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 10_000));
    }
}
const GAS = toNano('0.1');

/** `primes_ratchet.tolk`'s reserve fraction, restated ONLY to compute what a
 *  refusal will say before sending nothing. Never used to size a message.
 *
 *  THE STAKE MINIMUM IS NOT RESTATED HERE. D-153 makes it deploy-time
 *  (`stakeDivisor`), so a constant in this file would check one half of the
 *  test against a figure the set may not use — exactly the §9.1 failure the
 *  get-method exists to prevent. It is read from `getStakeMin()` every time. */
const RESERVE_BPS = 2000n;
const BPS_DEN = 10000n;

const ton = (v: bigint) => `${Number(v) / 1e9}`;

type Staking = NonNullable<Snapshot['staking']>;

function requireStaking(s: Snapshot): Staking {
    if (!s.staking) {
        throw new Error(
            'this set answers no getStaking — it was deployed before D-151. §4.3.2 needs a ' +
                'genesis at or after the staked-reserve commit; see docs/testnet-deployment.md.'
        );
    }
    return s.staking;
}

/** The ratchet's obligation, which is what the reserve is a fraction OF — not
 *  `pending`, which is only its liquid part (`primes_ratchet.tolk`'s "one naming
 *  trap"). */
const obligation = (s: Snapshot) => s.pending + requireStaking(s).stakedCost + requireStaking(s).exiting;

async function mockOf(c: Contracts) {
    const venue = await retry(() => c.ratchet.getStakingVenue(), 'getStakingVenue');
    return {
        venue,
        pool: c.client.open(MockTonstakersPool.createFromAddress(venue.tonstakersPool)),
    };
}

/**
 * Puts the shared mock back to a pool that PAYS: this set's learned rate, a buffer covering any
 * exit (leg 1 answers at once, as Tonstakers' does), DeDust off. Every `exit` stage ends here.
 * 20261124: `exit loss` left the mock at half rate with no buffer and no DeDust; two hours later
 * the keeper's routine reserve refill burned into a leg-3 bill nothing on testnet pays, and its
 * own `recover_exit` wrote the whole 0.102 GRAM tranche off as `realizedLoss`. That was the second
 * time (`MISTAKES.md` 2026-11-24): staging a counterparty is only safe if the step un-stages it.
 */
async function healMock(c: Contracts, sender: Parameters<MockTonstakersPool['sendSetRate']>[1]) {
    const { pool } = await mockOf(c);
    const raw = await retry(() => c.ratchet.getStaking(), 'getStaking');
    const m = await retry(() => pool.getMockPoolConfig(), 'getMockPoolConfig');
    const bal = await retry(() => c.client.getBalance(pool.address), 'getBalance(mock)');
    // Within what the mock holds, less any outstanding bill: a leg-1 payout past its balance throws 1305.
    const free = bal - m.pendingBill - toNano('1');
    await pool.sendSetRate(sender, { rateNum: raw.lastRateNum, rateDen: raw.lastRateDen, value: GAS });
    await pool.sendSetBuffer(sender, { freeTon: free > 0n ? free : 0n, value: GAS });
    await pool.sendSetDedustTon(sender, { dedustTon: 0n, value: GAS });
}

async function cmdHeal(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    await healMock(c, w.sender);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const { pool } = await mockOf(c);
    const m = await retry(() => pool.getMockPoolConfig(), 'getMockPoolConfig');
    console.log(`mock rate ${m.rateNum}/${m.rateDen}, buffer ${ton(m.freeTon)} GRAM, dedust ${ton(m.dedustTon)} GRAM`);
}

function treasuryOf(c: Contracts) {
    return c.client.open(PrimesTreasury.createFromAddress(addr('PRIMES_TREASURY_ADDRESS')));
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

async function cmdStatus(c: Contracts) {
    const s = await snapshot(c);
    const k = requireStaking(s);
    const { venue, pool } = await mockOf(c);
    const [wallet, dest, leg] = await Promise.all([
        retry(() => c.ratchet.getTstonWallet(), 'getTstonWallet'),
        retry(() => c.ratchet.getHarvestDest(), 'getHarvestDest'),
        retry(() => c.ratchet.getExitLeg(), 'getExitLeg'),
    ]);
    const raw = await retry(() => c.ratchet.getStaking(), 'getStaking');
    const bal = await retry(() => treasuryOf(c).getTreasuryBalances(), 'getTreasuryBalances');
    console.log('--- §4.3.2, the staked reserve -------------------------------------');
    console.log(`pending (liquid)   ${ton(s.pending)} GRAM`);
    console.log(`stakedCost         ${ton(k.stakedCost)} GRAM`);
    console.log(`exiting            ${ton(k.exiting)} GRAM`);
    console.log(`realizedLoss       ${ton(k.realizedLoss)} GRAM`);
    console.log(`obligation         ${ton(obligation(s))} GRAM  (reserveTarget ${ton(k.reserveTarget)})`);
    console.log(`tstonHeld          ${ton(k.tstonHeld)} tsTON`);
    // Printed as the PAIR it was learned as, never as a quotient we rounded:
    // `lastRateNum` nanotons of deposit minted `lastRateDen` nano-tsTON.
    console.log(`lastRate           ${raw.lastRateNum} GRAM-nano per ${raw.lastRateDen} tsTON-nano`);
    console.log(`exitLeg            ${leg.leg}  inFlightExit ${ton(leg.inFlightExit)}`);
    console.log(`tsTON wallet       ${wallet.tstonWalletAddr.toString({ testOnly: true })} set=${wallet.walletSet}`);
    console.log(`harvest dest       ${dest.toString({ testOnly: true })}`);
    console.log(`treasury tstonBal  ${ton(bal.tstonBalance)} tsTON`);
    console.log('--- the mock (all five venue addresses are this one contract) ------');
    console.log(`tonstakersPool     ${venue.tonstakersPool.toString({ testOnly: true })}`);
    console.log(`dedustTstonVault   ${venue.dedustTstonVault.toString({ testOnly: true })}`);
    console.log(`dedustTstonPool    ${venue.dedustTstonPool.toString({ testOnly: true })}`);
    const m = await retry(() => pool.getMockPoolConfig(), 'getMockPoolConfig');
    console.log(
        `rate ${m.rateNum}/${m.rateDen}  freeTon ${ton(m.freeTon)}  owed ${ton(m.tstonSupplyOwed)} tsTON  ` +
            `bill ${ton(m.pendingBill)}  dedustTon ${ton(m.dedustTon)}`
    );
    A.print([A.tIdentity(s), A.solvency(s)]);
    return s;
}

/**
 * THE REFUSALS, COMPUTED AND NOT FIRED. `TESTNET_MASTER_PLAN.md` §2.5 rule 1: an
 * op that THROWS is gated on a get-method rather than sent, because a red
 * transaction proving a refusal the sandbox already covers costs the run a
 * finding it has to explain and buys nothing. All four of §4.3.2's named guards
 * are decidable from `getStaking()` + `getTstonWallet()` + the account balance,
 * so this journals what each arm WOULD answer, by name, with the figure.
 */
async function cmdRefusals(c: Contracts) {
    const s = await snapshot(c);
    const k = requireStaking(s);
    const wallet = await retry(() => c.ratchet.getTstonWallet(), 'getTstonWallet');
    // D-153: from the chain, never a constant — the set decides this figure.
    const stakeMin = await retry(() => c.ratchet.getStakeMin(), 'getStakeMin');
    const balance = await A.balance(addr('PRIMES_RATCHET_ADDRESS'));
    const buffer = balance - s.pending;

    const target = (obligation(s) * RESERVE_BPS) / BPS_DEN;
    const stakeSize = s.pending - target;
    const results: A.AssertResult[] = [
        {
            ok: wallet.walletSet === 1,
            name: 'TSTON_WALLET_ARMED',
            getMethod: 'ratchet.getTstonWallet',
            after: `${wallet.tstonWalletAddr.toString({ testOnly: true })} set=${wallet.walletSet}`,
            detail:
                wallet.walletSet === 1
                    ? 'the genesis one-shot landed; without it all three arms refuse 231'
                    : 'NOT SET — stake/unstake/harvest all refuse 231 (ratchet_tston_wallet_unset)',
        },
        {
            ok: true,
            name: stakeSize > stakeMin ? 'STAKE_LEGAL' : 'STAKE_REFUSES_226',
            getMethod: 'ratchet.getPending − getStaking().reserveTarget vs ratchet.getStakeMin',
            after: `${ton(stakeSize)} vs ${ton(stakeMin)}`,
            detail:
                stakeSize > stakeMin
                    ? `pending ${ton(s.pending)} − target ${ton(target)} = ${ton(stakeSize)} > ` +
                      `${ton(stakeMin)} — stake is legal`
                    : `pending ${ton(s.pending)} − target ${ton(target)} = ${ton(stakeSize)} <= ` +
                      `${ton(stakeMin)}, so stake refuses 226 (ratchet_stake_below_min). This deploy ` +
                      `needs pending above ${(Number(stakeMin) / 1e9 / 0.8).toFixed(4)} GRAM for a FIRST ` +
                      `stake — D-153 sets the minimum at deploy time; see TESTNET_MASTER_PLAN.md §4c`,
        },
        {
            ok: true,
            name: s.pending < k.reserveTarget ? 'UNSTAKE_LEGAL' : 'UNSTAKE_REFUSES_227',
            getMethod: 'ratchet.getPending < getStaking().reserveTarget',
            after: `${ton(s.pending)} vs ${ton(k.reserveTarget)}`,
            detail:
                s.pending < k.reserveTarget
                    ? 'the reserve is short, so the exit is callable — which is the ONLY state it is'
                    : 'the floor’s standing bid is funded, so unstake refuses 227 ' +
                      '(ratchet_reserve_sufficient). §11.14 refused an exit anyone may call on demand',
        },
        {
            ok: true,
            name: 'HARVEST_ACCRUAL',
            getMethod: 'getStaking().tstonHeld − stakedCost·lastRateDen/lastRateNum',
            after: ton(k.tstonHeld),
            detail:
                k.stakedCost === 0n
                    ? 'nothing staked, so accrued is 0 and harvest refuses 229 (ratchet_harvest_dust)'
                    : 'accrued is tstonHeld above cost AT THE LEARNED RATE; exactly 0 after a single ' +
                      'stake, which is the correct answer and must refuse 229 rather than send a ' +
                      'jetton transfer costing more than it moves',
        },
        {
            ok: true,
            name: 'GAS_BUFFER',
            getMethod: 'ratchet balance − getPending (the gas buffer, never a term of T)',
            after: ton(buffer),
            detail:
                `D-146: no arm spends this any more — the caller attaches the pool's 1 GRAM deposit ` +
                `fee + 0.3 stake gas (stake), the whole exit's gas (unstake) or the transfer gas ` +
                `(harvest), and gets the change back. Buffer ${ton(buffer)} GRAM pays storage rent only`,
        },
    ];
    A.print(results);
    record({ phase: '10', op: 'staking-refusals', ok: true, asserts: fromAsserts(results) });
}

// ---------------------------------------------------------------------------
// SETUP — the two things a live set needs before the arms are reachable
// ---------------------------------------------------------------------------

/**
 * Top up the ratchet's GAS BUFFER with a bare-body transfer. Every Tolk contract
 * here ends its `match` with "accept a bare top-up, refuse everything else", so
 * this is the supported way in — and it credits the balance WITHOUT touching
 * `pending`, which is the whole distinction §4.3.2 rests on: the counterparty's
 * fees are paid from here, never from a term of `T`.
 */
async function cmdBuffer(c: Contracts, amount: string, handle: string) {
    const w = await walletFor(c.client, handle);
    const before = await A.balance(addr('PRIMES_RATCHET_ADDRESS'));
    const s0 = await snapshot(c);
    // No body at all — the catch-all's `assert (in.body.isEmpty()) throw 101`
    // arm is the supported door for a bare top-up.
    await w.sender.send({ to: addr('PRIMES_RATCHET_ADDRESS'), value: toNano(amount), bounce: true });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const after = await A.balance(addr('PRIMES_RATCHET_ADDRESS'));
    const s1 = await snapshot(c);
    const results: A.AssertResult[] = [
        {
            ok: after > before,
            name: 'BUFFER_TOPPED',
            getMethod: 'account balance of PRIMES_RATCHET_ADDRESS',
            before: ton(before),
            after: ton(after),
            detail: `a bare top-up is accepted by the catch-all and adds ${ton(after - before)} GRAM of gas buffer`,
        },
        {
            ok: s1.pending === s0.pending && s1.T === s0.T,
            name: 'TOPUP_IS_NOT_BACKING',
            getMethod: 'ratchet.getPending, ledger.getFloorNum',
            before: ton(s0.pending),
            after: ton(s1.pending),
            detail:
                'GRAM sent with an empty body is gas, not floor backing: `pending` and `T` must both be ' +
                'unmoved, or a stranger could raise p_f without minting and the ratchet theorem would ' +
                'be measuring a donation',
        },
        A.tIdentity(s1),
    ];
    A.print(results);
    record({ phase: '10', op: 'ratchet-buffer', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * The mock's rate knob. Genesis deploys it at 1:1, so this is only needed to
 * STAGE a case: a rate under the tranche's cost basis is how leg 2's guarded
 * floor is proved, and a rate of 0 is how the deposit's bounce arm is proved.
 * Unauthenticated by design — it is a test double, not a contract with an owner.
 */
async function cmdRate(c: Contracts, num: string, den: string, handle: string) {
    const w = await walletFor(c.client, handle);
    const { pool } = await mockOf(c);
    await pool.sendSetRate(w.sender, { rateNum: toNano(num), rateDen: toNano(den), value: GAS });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const m = await retry(() => pool.getMockPoolConfig(), 'getMockPoolConfig');
    console.log(`mock rate now ${m.rateNum}/${m.rateDen} (${Number(m.rateNum) / Number(m.rateDen)} GRAM per tsTON)`);
}

// ---------------------------------------------------------------------------
// THE THREE ARMS
// ---------------------------------------------------------------------------

/**
 * STAKE. Permissionless and carries no amount — the contract computes
 * `pending − reserveTarget` itself, which is the whole reason §11.14's
 * "discretionary surface" objection does not apply.
 *
 * The asserts are the five that matter and they are all about ARITHMETIC, not
 * about a balance that moved: `T` unchanged (a stake is a rearrangement), the
 * obligation unchanged, `pending` down by exactly what `stakedCost` gained, and
 * the rate LEARNED from the mint notification — the only place it is ever
 * learned, since a withdrawal's body carries no amount at all.
 */
async function cmdStake(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const before = await snapshot(c);
    const k0 = requireStaking(before);
    const target = (obligation(before) * RESERVE_BPS) / BPS_DEN;
    const expected = before.pending - target;
    const stakeMin = await retry(() => c.ratchet.getStakeMin(), 'getStakeMin');
    if (expected <= stakeMin) {
        throw new Error(
            `stake would refuse 226: pending ${ton(before.pending)} − reserve ${ton(target)} = ` +
                `${ton(expected)} GRAM, and this deploy's minimum is ${ton(stakeMin)} (D-153). Raise ` +
                `pending with npx tsx contracts/scripts/donateFloor.ts --ton <n> — see ` +
                `TESTNET_MASTER_PLAN.md §4c for what that costs and why the divisor exists.`
        );
    }
    console.log(`${handle} staking ${ton(expected)} GRAM (pending ${ton(before.pending)} − reserve ${ton(target)})`);
    await c.ratchet.sendStake(w.sender, { value: STAKE_VALUE }); // D-146: caller pays the pool's fees
    await settle(async () => (await c.ratchet.getStaking()).stakedCost > k0.stakedCost);
    const after = await snapshot(c);
    const k1 = requireStaking(after);
    const foreign = await foreignCredits(c, before, after); // other senders' pool_inject, mid-step

    const results: A.AssertResult[] = [
        {
            ok: k1.stakedCost - k0.stakedCost === expected && before.pending + foreign - after.pending === expected,
            name: 'STAKE_SIZED_BY_THE_CONTRACT',
            getMethod: 'ratchet.getPending, getStaking().stakedCost',
            before: `pending ${ton(before.pending)} staked ${ton(k0.stakedCost)}`,
            after: `pending ${ton(after.pending)} staked ${ton(k1.stakedCost)}`,
            detail: `the caller named no amount; the contract moved exactly pending − reserveTarget`,
        },
        A.stakeNeutral(before, after, foreign),
        A.tIdentity(after),
        {
            ok: k1.tstonHeld > k0.tstonHeld,
            name: 'TSTON_MINTED',
            getMethod: 'getStaking().tstonHeld',
            before: ton(k0.tstonHeld),
            after: ton(k1.tstonHeld),
            detail:
                'the pool minted against value − DEPOSIT_FEE, and the notification is the ONLY place ' +
                'the rate is learned (D-151 deleted the probe-burn design that tried to learn it from ' +
                'a withdrawal, whose body carries no amount)',
        },
        {
            ok: after.pending >= k1.reserveTarget,
            name: 'RESERVE_LEFT_INTACT',
            getMethod: 'ratchet.getPending >= getStaking().reserveTarget',
            after: `${ton(after.pending)} vs ${ton(k1.reserveTarget)}`,
            detail: 'the floor’s standing bid is still funded — a stake may never spend the reserve',
        },
        A.solvency(after),
    ];
    A.print(results);
    record({ phase: '10', op: 'stake', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * ACCRUED YIELD, on a chain where the rate cannot move.
 *
 * tsTON does not rebase, so real yield shows up as the rate rising and the
 * sandbox proves it by staking twice across a `SetRate`. A second stake here
 * would need `pending` back above 75 GRAM, which is the same unrecoverable
 * donation a second time. The contract offers a cheaper door that is not a
 * cheat: tsTON arriving with no stake and no exit outstanding, and nothing
 * written off, is credited to `tstonHeld` at ZERO COST (`creditStakeArrival`;
 * with a write-off outstanding it restores that first — audit H2), and
 * therefore surfaces as accrued yield at the next harvest and never as backing
 * for `T`. Sending it is a `Transfer` to the mock naming the ratchet as
 * destination; the mock answers with the notification a real wallet hop would.
 *
 * Keep the amount just over `HARVEST_DUST_TSTON` (0.01595068119659424 tsTON):
 * the mock decrements its own `tstonSupplyOwed` on the way through, and a large
 * donation would leave the ratchet holding more tsTON than the mock admits
 * owing, which a later burn refuses with 1304.
 */
async function cmdYield(c: Contracts, amount: string, handle: string) {
    const w = await walletFor(c.client, handle);
    const { venue } = await mockOf(c);
    const before = await snapshot(c);
    const k0 = requireStaking(before);
    const body = beginCell()
        .storeUint(0x0f8a7ea5, 32) // TEP-74 transfer, as the mock's own `Transfer` struct
        .storeUint(0, 64)
        .storeCoins(toNano(amount))
        .storeAddress(addr('PRIMES_RATCHET_ADDRESS')) // destination
        .storeAddress(w.wallet.address) // responseAddr
        .storeMaybeRef(null) // customPayload
        // A forward of 0 is a SILENT transfer: a TEP-74 wallet (and the mock, since
        // audit M1) sends no notification and the ratchet never sees the tsTON.
        .storeCoins(toNano('0.05')) // forwardTonAmount
        .storeUint(0, 1) // forwardPayload: Either-left, empty — NOT a swap
        .endCell();
    console.log(`${handle} donating ${amount} tsTON to the reserve through ${venue.tonstakersPool.toString({ testOnly: true })}`);
    await w.sender.send({ to: venue.tonstakersPool, value: toNano('0.2'), bounce: true, body });
    await settle(async () => (await c.ratchet.getStaking()).tstonHeld - k0.tstonHeld >= toNano(amount));
    const after = await snapshot(c);
    const k1 = requireStaking(after);
    const foreign = await foreignCredits(c, before, after); // other senders' pool_inject, mid-step

    const results: A.AssertResult[] = [
        {
            ok: k1.tstonHeld - k0.tstonHeld === toNano(amount),
            name: 'YIELD_CREDITED_AT_ZERO_COST',
            getMethod: 'getStaking().tstonHeld',
            before: ton(k0.tstonHeld),
            after: ton(k1.tstonHeld),
            detail: 'tsTON with no stake and no exit outstanding raises tstonHeld and NOT stakedCost',
        },
        {
            ok: k1.stakedCost === k0.stakedCost,
            name: 'YIELD_IS_NOT_BACKING',
            getMethod: 'getStaking().stakedCost',
            before: ton(k0.stakedCost),
            after: ton(k1.stakedCost),
            detail:
                'the conservative direction, and the one §4.3.2 requires: unrealized yield never ' +
                'enters T, so it can never inflate p_f — "realize, never mark"',
        },
        A.stakeNeutral(before, after, foreign),
        A.tIdentity(after),
    ];
    A.print(results);
    record({ phase: '10', op: 'tston-yield', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * HARVEST. The accrual goes to the LP-GOVERNED TREASURY as tsTON, and the
 * assert everybody should read twice is the negative one: no term of `T` moves.
 * That is "realize, never mark" written as arithmetic, and it is why unrealized
 * yield can never enter the floor price.
 */
async function cmdHarvest(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const treasury = treasuryOf(c);
    const before = await snapshot(c);
    const k0 = requireStaking(before);
    const bal0 = await retry(() => treasury.getTreasuryBalances(), 'getTreasuryBalances');
    const dest = await retry(() => c.ratchet.getHarvestDest(), 'getHarvestDest');

    // Decide on the read BEFORE sending (CLAUDE.md): the ratchet's own 229 test,
    // accrued = tstonHeld − stakedCost·den/num >= HARVEST_DUST_TSTON. On 20261121 it was
    // −0.18 tsTON after a second stake and this script sent anyway, buying a 229.
    const raw = await retry(() => c.ratchet.getStaking(), 'getStaking');
    const gates = await retry(() => c.ratchet.getStakingGates(), 'getStakingGates');
    const wait = raw.lastHarvestTime + gates.harvestIntervalSec - Math.floor(Date.now() / 1000);
    if (wait > 0) throw new Error(`harvest would refuse 228: next harvest in ${wait}s. Nothing is sent.`);
    const HARVEST_DUST_NANO = gates.harvestDustTston;
    const costInTston = raw.lastRateNum > 0n ? (k0.stakedCost * raw.lastRateDen) / raw.lastRateNum : 0n;
    const accrued = k0.tstonHeld - costInTston;
    if (accrued < HARVEST_DUST_NANO) {
        throw new Error(
            `harvest would refuse 229: accrued ${ton(accrued)} tsTON at the learned rate ` +
                `${raw.lastRateNum}/${raw.lastRateDen} is under the dust ${ton(HARVEST_DUST_NANO)}. Nothing is sent.`
        );
    }
    await c.ratchet.sendHarvest(w.sender, { value: HARVEST_VALUE }); // D-146: caller pays
    await settle(async () => (await c.ratchet.getStaking()).tstonHeld < k0.tstonHeld);
    const after = await snapshot(c);
    const k1 = requireStaking(after);
    const foreign = await foreignCredits(c, before, after); // other senders' pool_inject, mid-step
    const bal1 = await retry(() => treasury.getTreasuryBalances(), 'getTreasuryBalances');

    const moved = k0.tstonHeld - k1.tstonHeld;
    const results: A.AssertResult[] = [
        {
            ok: dest.equals(addr('PRIMES_TREASURY_ADDRESS')),
            name: 'HARVEST_DEST_IS_GOVERNED',
            getMethod: 'ratchet.getHarvestDest',
            after: dest.toString({ testOnly: true }),
            detail:
                'D-151 point 1: the yield destination is the LP-staker-governed treasury and the ' +
                'operator gets nothing from it. A get-method, so a reader can check it too',
        },
        {
            ok: moved > 0n && bal1.tstonBalance - bal0.tstonBalance === moved,
            name: 'HARVEST_REALIZED',
            getMethod: 'getStaking().tstonHeld, treasury.getTreasuryBalances().tstonBalance',
            before: `held ${ton(k0.tstonHeld)} / treasury ${ton(bal0.tstonBalance)}`,
            after: `held ${ton(k1.tstonHeld)} / treasury ${ton(bal1.tstonBalance)}`,
            detail: `${ton(moved)} tsTON left the reserve and arrived as tsTON — no DEX leg, by decision`,
        },
        {
            ok:
                k1.stakedCost === k0.stakedCost &&
                k1.exiting === k0.exiting &&
                k1.realizedLoss === k0.realizedLoss &&
                after.pending - before.pending === foreign &&
                after.T - before.T === foreign,
            name: 'HARVEST_TOUCHES_NO_TERM_OF_T',
            getMethod: 'ledger.getFloorNum, ratchet.getPending, getStaking().{stakedCost,exiting,realizedLoss}',
            before: `T ${before.T}`,
            after: `T ${after.T}`,
            detail: 'THE WHOLE POINT: tstonHeld is not in the identity, so realizing it moves no backing',
        },
        A.tIdentity(after),
        A.floorUp(before, after, false),
    ];
    A.print(results);
    record({ phase: '10', op: 'harvest', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

// ---------------------------------------------------------------------------
// THE EXIT MACHINE — three legs, staged at the mock
// ---------------------------------------------------------------------------

/**
 * `unstake` is callable only when the liquid reserve is short, so the mock is
 * staged FIRST and the burn is sent second. Which leg runs is decided entirely
 * by what the mock can pay:
 *
 *   leg1  freeTon ≥ the tranche          → immediate fill at the pool's own rate
 *   leg2  freeTon 0, dedustTon deep      → fill_or_kill re-mints, guarded swap fills
 *   leg3  freeTon 0, dedustTon 0         → the quote cannot clear cost, a bill is minted
 *   loss  leg 3 at a rate UNDER cost     → §5's one external risk, published as realizedLoss
 *
 * `loss` is the case worth staging even though no path the contract chooses can
 * produce it: leg 2's `min_out` is floored at cost, and legs 1 and 3 redeem at
 * the pool's own rate, so a shortfall can only arrive from the counterparty
 * paying under cost — a slashing. The term exists so that lands somewhere honest
 * instead of silently breaking the identity, and this is the only place a live
 * run ever sees `realizedLoss` non-zero.
 */
/**
 * LEG 2'S FILL IS NOT REACHABLE ON EVERY SET, and the reason is a single field.
 *
 * The mock pays a swap output as `payout#474f86cf` from its OWN address, and
 * `primes_ratchet.tolk`'s `DedustPayout` arm asserts the sender is
 * `venue.dedustNativeVault` (throw 100). So leg 2's FILL needs the mock to BE
 * that field — which is exactly what the mock's own header says it exists for —
 * and `handleFlush` sends its GRAM to the same field, so a set pointed at the
 * real DeDust native vault cannot also point it at the mock. One deployment, one
 * owner of that field.
 *
 * Staging the fill anyway is not a red transaction and a finding: the payout
 * aborts on 100, the GRAM stays on the ratchet as an unattributed gas buffer, and
 * the machine is left at `EXIT_LEG_DEDUST` with `inFlightExit` outstanding —
 * which makes `stake`, `unstake` AND `flush` throw 230 until somebody nudges it
 * out by hand. So it is refused before anything is sent.
 */
async function requireLeg2Fillable(c: Contracts, mockAddr: Address) {
    const venue = await retry(() => c.ratchet.getVenue(), 'getVenue');
    if (venue.dedustNativeVault.equals(mockAddr)) return;
    throw new Error(
        "leg 2's FILL branch is unreachable on this deployment. The mock pool " +
            `(${mockAddr.toString({ testOnly: true })}) pays the swap output from its own address, and the ` +
            `ratchet's DedustPayout arm only accepts venue.dedustNativeVault, which here is the real DeDust ` +
            `native GRAM vault (${venue.dedustNativeVault.toString({ testOnly: true })}) because handleFlush ` +
            'sends its GRAM there. The payout would abort on 100 (wrong_sender), the exit machine would stay ' +
            'at EXIT_LEG_DEDUST with inFlightExit outstanding, and stake/unstake/flush would all throw 230 ' +
            "until it was nudged out by hand. On a real-DeDust set the reachable leg-2 behaviour is the " +
            'REFUSAL, which `tston.ts exit leg3` already drives through the same EXIT_LEG_DEDUST → ' +
            'EXIT_LEG_BILL transition. To cover leg 2 FILLING, deploy a set with PRIMES_DEDUST_LP_STANDIN=1.'
    );
}

async function cmdExit(c: Contracts, leg: string, handle: string) {
    const w = await walletFor(c.client, handle);
    const { venue: stakingVenue, pool } = await mockOf(c);
    if (leg === 'leg2') await requireLeg2Fillable(c, stakingVenue.dedustTstonVault);
    const before = await snapshot(c);
    const k0 = requireStaking(before);
    if (before.pending >= k0.reserveTarget) {
        throw new Error(
            `unstake would refuse 227: pending ${ton(before.pending)} still covers the reserve ` +
                `${ton(k0.reserveTarget)}. Spend pending first — one flush of any size is enough, ` +
                `because the target falls more slowly than pending does.`
        );
    }
    // AN EXIT IN FLIGHT REFUSES 230. The G93 run's dust leg 3 parked on its bill and the next
    // `exit leg3` was sent into it — a red ratchet transaction for a state one read shows.
    const inFlight = await retry(() => c.ratchet.getExitLeg(), 'getExitLeg');
    if (inFlight.inFlightExit > 0n || inFlight.leg !== 0) {
        throw new Error(
            `an exit is still in flight (leg ${inFlight.leg}, ${ton(inFlight.inFlightExit)} GRAM) — unstake would ` +
                `refuse 230. Close it first (\`tston.ts settle\`). Nothing sent.`
        );
    }
    const tranche = k0.reserveTarget - before.pending;
    // A DUST SHORTFALL IS NOT AN EXIT. Leg 1 refilled the reserve to within 1 nanoton on the
    // G93 run; the shortfall still read "legal", `exit leg3` sized a 1e-9 GRAM tranche, it
    // rounded to 0 tsTON and the contract refused 227. Decide on the size, not the sign.
    if (tranche < toNano('0.1')) {
        throw new Error(
            `the reserve is short by only ${ton(tranche)} GRAM — a tranche that small rounds to no tsTON and ` +
                `refuses 227. Spend pending first (one venue-sized flush), then re-run. Nothing sent.`
        );
    }
    // EVERY SEND BELOW IS PAID BY `w`, so the balance is decided before the FIRST one. The
    // staging sends used to go out and only the unstake hit `sender.ts`'s guard — on 20260929
    // `exit loss` left the shared mock slashed with no exit behind it, and the next leg 3
    // redeemed at the slashed rate (a 0.875 GRAM realizedLoss nobody meant to stage).
    const need = UNSTAKE_VALUE + 7n * GAS + toNano('0.1'); // + 3 for healMock
    const have = await retry(() => c.client.getBalance(w.wallet.address), 'getBalance');
    if (have < need) throw new Error(`${handle} holds ${ton(have)} GRAM, short of the ${ton(need)} this exit spends — nothing sent`);
    // THE RATE IS PINNED TO THIS SET'S OWN STAKE, never to the knob's current value: the mock
    // is shared across geneses, so its rate is whatever the last run left. Legs 1-3 redeem at
    // the learned (cost) rate and so realize nothing; `loss` redeems at half of it.
    const raw = await retry(() => c.ratchet.getStaking(), 'getStaking');
    const learnedNum = leg === 'loss' ? raw.lastRateNum / 2n : raw.lastRateNum;
    // A leg-3 bill is fixed at the burn (`pendingBill`), so un-staging after the step is safe —
    // and it runs even when an assert below throws.
    try {
        await pool.sendSetRate(w.sender, { rateNum: learnedNum, rateDen: raw.lastRateDen, value: GAS });

        // Stage the counterparty. `freeTon` must stay within what the mock actually
        // holds — it asserts `keep >= 0` (1305, mock_under_funded) rather than
        // pretending to pay what it does not have.
        if (leg === 'leg1') {
            await pool.sendSetBuffer(w.sender, { freeTon: tranche + toNano('1'), value: GAS });
            await pool.sendSetDedustTon(w.sender, { dedustTon: 0n, value: GAS });
        } else if (leg === 'leg2') {
            await pool.sendSetBuffer(w.sender, { freeTon: 0n, value: GAS });
            await pool.sendSetDedustTon(w.sender, { dedustTon: tranche + toNano('1'), value: GAS });
        } else if (leg === 'leg3') {
            await pool.sendSetBuffer(w.sender, { freeTon: 0n, value: GAS });
            await pool.sendSetDedustTon(w.sender, { dedustTon: 0n, value: GAS });
        } else if (leg === 'loss') {
            await pool.sendSetBuffer(w.sender, { freeTon: 0n, value: GAS });
            await pool.sendSetDedustTon(w.sender, { dedustTon: 0n, value: GAS });
            // Half the cost basis (set above). Leg 2 refuses it (its floor is cost), leg 3
            // takes it, and the shortfall lands in `realizedLoss`.
        } else {
            throw new Error(`unknown leg "${leg}" — one of: leg1, leg2, leg3, loss`);
        }
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        console.log(`${handle} unstaking ~${ton(tranche)} GRAM via ${leg}`);
        await c.ratchet.sendUnstake(w.sender, { value: UNSTAKE_VALUE }); // D-146: prepays legs 1-3
        const parked = leg === 'leg3' || leg === 'loss';
        await settle(async () => {
            const e = await c.ratchet.getExitLeg();
            return parked ? e.leg === EXIT_LEG_BILL : e.leg === 0 && (await c.ratchet.getPending()) > before.pending;
        });

        const after = await snapshot(c);
        const k1 = requireStaking(after);
        const foreign = await foreignCredits(c, before, after); // other senders' pool_inject, mid-step
        const exit = await retry(() => c.ratchet.getExitLeg(), 'getExitLeg');

        const results: A.AssertResult[] = [
            {
                ok: parked ? exit.leg !== 0 && k1.exiting > 0n : exit.leg === 0 && k1.exiting === 0n,
                name: parked ? 'EXIT_PARKED_ON_THE_BILL' : 'EXIT_COMPLETED',
                getMethod: 'ratchet.getExitLeg, getStaking().exiting',
                before: `exiting ${ton(k0.exiting)}`,
                after: `leg ${exit.leg} exiting ${ton(k1.exiting)}`,
                detail: parked
                    ? 'the tranche is a payout bill until the round closes — run `tston.ts settle` to close it'
                    : 'the GRAM came home inside the same round trip and `exiting` is back to zero',
            },
            {
                ok: parked ? after.pending - before.pending === foreign : after.pending - foreign > before.pending,
                name: 'PENDING_REFILLED',
                getMethod: 'ratchet.getPending',
                before: ton(before.pending),
                after: ton(after.pending),
                detail: parked
                    ? 'nothing has arrived yet, which is correct: leg 3 pays at round end and not before'
                    : 'the reserve is refilled, which is the only purpose the exit exists for',
            },
            {
                ok: k1.stakedCost < k0.stakedCost,
                name: 'TRANCHE_LEFT_THE_POSITION',
                getMethod: 'getStaking().stakedCost',
                before: ton(k0.stakedCost),
                after: ton(k1.stakedCost),
                detail: 'sized at COST BASIS, not at the learned rate — the one ratio the contract knows without trusting a number',
            },
            A.stakeNeutral(before, after, foreign),
            A.tIdentity(after),
            A.solvency(after),
        ];
        A.print(results);
        record({ phase: '10', op: `exit-${leg}`, ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
        A.requireAll(results);
    } finally {
        await healMock(c, w.sender);
    }
}

/** Leg 3's round end, without waiting ~36 hours for it. The bill pays its GRAM
 *  share as `payout_distributed_asset`, and THAT is the message with no
 *  authenticatable sender — see `cmdForge`. */
/**
 * `recover_exit#b0000057` — permissionless, legal once `now - exitStartedAt >= recoverAfter`
 * (72 h, D-139-divided). A leg-3 exit past the window is WRITTEN OFF (D-197): its residual
 * cost becomes `realizedLoss` and the machine goes idle. Reads the window before sending.
 */
async function cmdRecover(c: Contracts, handle: string) {
    const exit = await retry(() => c.ratchet.getExitLeg(), 'getExitLeg');
    const now = Math.floor(Date.now() / 1000);
    if (exit.leg === 0) throw new Error('no exit open — recover_exit would refuse 232. Nothing sent.');
    const due = exit.exitStartedAt + exit.recoverAfter + 30; // margin for this laptop's clock skew
    // A window up to 30 min (this set's D-139-divided 72 h reads 1542 s) is waited out here, so
    // `run.ts` can sequence loss → settle → recover; a longer one refuses rather than park a process.
    if (now < due && due - now > 1800) throw new Error(`exit (leg ${exit.leg}) is recoverable in ${due - now}s — refuses 232 until then. Nothing sent.`);
    if (now < due) {
        console.log(`waiting ${due - now}s for the exit's recovery window`);
        await new Promise((r) => setTimeout(r, (due - now) * 1000));
    }
    const w = await walletFor(c.client, handle);
    const before = await snapshot(c);
    const k0 = requireStaking(before);
    await c.ratchet.sendRecoverExit(w.sender, { value: GAS });
    await settle(async () => (await c.ratchet.getExitLeg()).leg === 0);
    const after = await snapshot(c);
    const k1 = requireStaking(after);
    const exit1 = await retry(() => c.ratchet.getExitLeg(), 'getExitLeg(after)');
    const results: A.AssertResult[] = [
        {
            ok: exit1.leg === 0 && exit1.inFlightExit === 0n && k1.exiting === 0n,
            name: 'EXIT_RECOVERED',
            getMethod: 'ratchet.getExitLeg, getStaking().exiting',
            before: `leg ${exit.leg} inFlight ${ton(exit.inFlightExit)} exiting ${ton(k0.exiting)}`,
            after: `leg ${exit1.leg} exiting ${ton(k1.exiting)} realizedLoss ${ton(k1.realizedLoss)}`,
            detail: 'a stranded leg 3 is written off (D-197): its residual cost is published as realizedLoss',
        },
        {
            ok: k1.realizedLoss - k0.realizedLoss === k0.exiting,
            name: 'WRITE_OFF_IS_THE_RESIDUAL',
            getMethod: 'getStaking().realizedLoss',
            after: `+${ton(k1.realizedLoss - k0.realizedLoss)}`,
            detail: 'the loss booked equals what was exiting — over-published, never backing given away',
        },
        A.tIdentity(after),
    ];
    record({ phase: '10', op: 'recover-exit', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function cmdSettle(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const { pool } = await mockOf(c);
    const before = await snapshot(c);
    const k0 = requireStaking(before);
    // The mock throws 1306 with no bill outstanding. A dust tranche can park the ratchet on
    // leg 3 with a 0 GRAM bill (the G93 run) — that exit is closed by `recover`, not here.
    const m0 = await retry(() => pool.getMockPoolConfig(), 'getMockPoolConfig');
    if (m0.pendingBill === 0n) {
        throw new Error('the mock holds no bill (pendingBill 0) — settle would throw 1306. A leg-3 exit with ' +
            'nothing to pay is closed by `tston.ts recover` once its window passes. Nothing sent.');
    }

    await pool.sendSettleBill(w.sender, { value: GAS });
    await settle(async () => (await c.ratchet.getStaking()).exiting < k0.exiting);
    const after = await snapshot(c);
    const k1 = requireStaking(after);
    const foreign = await foreignCredits(c, before, after); // other senders' pool_inject, mid-step
    const exit = await retry(() => c.ratchet.getExitLeg(), 'getExitLeg');

    const credited = after.pending - before.pending - foreign;
    const loss = k1.realizedLoss - k0.realizedLoss;
    const results: A.AssertResult[] = [
        // D-197: a bill paying UNDER cost credits what it paid and leaves the exit OPEN on the
        // bill (`creditExitArrival`, partial) until `recover_exit` writes the residual off as
        // `realizedLoss`. So an underpaid settle is green with the machine still on leg 3.
        exit.leg === 0
            ? {
                  ok: k1.exiting === 0n,
                  name: 'BILL_SETTLED',
                  getMethod: 'ratchet.getExitLeg, getStaking().exiting',
                  before: `exiting ${ton(k0.exiting)}`,
                  after: `leg ${exit.leg} exiting ${ton(k1.exiting)}`,
                  detail: 'the machine is idle again and `unstake` is callable',
              }
            : {
                  ok: exit.leg === EXIT_LEG_BILL && credited > 0n && k1.exiting > 0n && loss === 0n,
                  name: 'BILL_UNDERPAID_EXIT_STAYS_OPEN',
                  getMethod: 'ratchet.getExitLeg, getStaking().{exiting,realizedLoss}',
                  before: `exiting ${ton(k0.exiting)}`,
                  after: `leg ${exit.leg} exiting ${ton(k1.exiting)} (residual) credited ${ton(credited)}`,
                  detail: 'D-197: the bill paid under cost; the residual stays exiting until `tston.ts recover` writes it off as realizedLoss',
              },
        {
            ok: credited + loss + k1.exiting === k0.exiting,
            name: 'EXIT_CLOSED_TO_THE_NANOTON',
            getMethod: 'ratchet.getPending, getStaking().realizedLoss',
            before: ton(k0.exiting),
            after: `credited ${ton(credited)} + loss ${ton(loss)}`,
            detail:
                'every credit is matched by an equal debit of `exiting`; the surplus is off T: up to the ' +
                "answering leg's gas of it is refunded to the unstake caller, and any rate gain above that stays in the gas buffer",
        },
        {
            ok: true,
            name: loss > 0n ? 'REALIZED_LOSS_PUBLISHED' : 'NO_LOSS',
            getMethod: 'getStaking().realizedLoss',
            after: ton(k1.realizedLoss),
            detail:
                loss > 0n
                    ? `the counterparty paid ${ton(loss)} GRAM under cost. §5's ONE external risk to the ` +
                      `ratchet theorem, published beside stakedCost and never netted into it — a reader ` +
                      `who finds it non-zero is looking at Tonstakers, not at a decision made here`
                    : 'redeemed at or above cost, so nothing to publish',
        },
        A.tIdentity(after),
        A.solvency(after),
    ];
    A.print(results);
    record({ phase: '10', op: 'settle-bill', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * THE FORGERY, sent on purpose. `payout_distributed_asset` and
 * `ownership_assigned` arrive from a payout collection whose address is SALTED
 * with `random()` at deploy, so it cannot be precomputed at genesis or
 * whitelisted afterwards without adding an admin surface to a contract whose
 * whole claim is that it has none. The handler is therefore written to be SAFE
 * UNDER FORGERY instead: it credits `pending` and draws `exiting` down by the
 * same figure, both terms of `T`, so a forged message leaves `T` unchanged and
 * the GRAM backing the credit is the message value itself.
 *
 * With the machine IDLE there is nothing outstanding, so the correct behaviour is
 * to keep the GRAM as gas buffer and move no term at all. Firing it from a wallet
 * with no authority is the only way to show that at a live node — and the
 * transaction must be GREEN, which is the other half: a non-bounceable reply the
 * catch-all throws 101 on is the 2026-09-17 failure class, where the balances
 * reconcile and the only trace is a red row in an explorer.
 */
async function cmdForge(c: Contracts, handle: string) {
    // FORGERY IS ONLY A TEST WHILE THE MACHINE IS IDLE. Against an open exit the forged
    // payout_distributed_asset is credited against `exitCostBasis` — a donation the contract
    // documents, but on 20261124 it paid off the loss leg's residual and hid the very
    // `realizedLoss` the run was there to publish (G98). Read first, send nothing otherwise.
    const open = await retry(() => c.ratchet.getExitLeg(), 'getExitLeg');
    if (open.leg !== 0 || open.inFlightExit > 0n) {
        throw new Error(`an exit is open (leg ${open.leg}, ${ton(open.inFlightExit)} GRAM in flight) — a forged payout ` +
            'would be credited to it. Close it first (`tston.ts settle` / `tston.ts recover`). Nothing sent.');
    }
    const w = await walletFor(c.client, handle);
    const ratchet = addr('PRIMES_RATCHET_ADDRESS');
    const before = await snapshot(c);
    const k0 = requireStaking(before);

    const distributed = beginCell().storeUint(RATCHET.payout_distributed_asset, 32).storeUint(0, 64).endCell();
    const assigned = beginCell()
        .storeUint(RATCHET.payout_ownership_assigned, 32)
        .storeUint(0, 64)
        .storeAddress(null) // prevOwner: addr_none, as the bill sends it
        .storeUint(0, 1)
        .endCell();
    const excesses = beginCell().storeUint(RATCHET.excesses, 32).storeUint(0, 64).endCell();

    for (const [name, body] of [
        ['payout_distributed_asset', distributed],
        ['ownership_assigned', assigned],
        ['excesses', excesses],
    ] as const) {
        console.log(`${handle} forging ${name} at the ratchet`);
        await w.sender.send({ to: ratchet, value: toNano('0.3'), bounce: false, body });
        await new Promise((r) => setTimeout(r, SETTLE_MS / 2));
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const after = await snapshot(c);
    const k1 = requireStaking(after);
    const foreign = await foreignCredits(c, before, after); // other senders' pool_inject, mid-step

    const results: A.AssertResult[] = [
        {
            ok:
                after.T - before.T === foreign &&
                after.pending - before.pending === foreign &&
                k1.stakedCost === k0.stakedCost &&
                k1.exiting === k0.exiting &&
                k1.realizedLoss === k0.realizedLoss,
            name: 'FORGERY_MOVES_NO_TERM_OF_T',
            getMethod: 'ledger.getFloorNum, ratchet.getPending, getStaking()',
            before: `T ${before.T} pending ${ton(before.pending)}`,
            after: `T ${after.T} pending ${ton(after.pending)}`,
            detail:
                'with the exit machine idle the GRAM is unattributable and stays as gas buffer. ' +
                'Forging is a donation that costs the forger exactly what it gives the ratchet — the ' +
                'defence is arithmetic, not a check, and it is why leg 3 is buildable at all',
        },
        A.tIdentity(after),
        A.solvency(after),
    ];
    A.print(results);
    console.log(
        'NOW RUN `txAudit.ts --since 1h`: these three are the non-bounceable shape that credits ' +
            'before the compute phase throws. A balance assert cannot see that class; only the sweep can.'
    );
    record({ phase: '10', op: 'forged-payout', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

// ---------------------------------------------------------------------------

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const c = contracts();
    switch (cmd) {
        case 'status':
            await cmdStatus(c);
            return;
        case 'refusals':
            return cmdRefusals(c);
        case 'buffer':
            if (!rest[0]) throw new Error('usage: tston.ts buffer <GRAM> [handle]');
            return cmdBuffer(c, rest[0], rest[1] ?? 'K');
        case 'rate':
            if (!rest[0] || !rest[1]) throw new Error('usage: tston.ts rate <num> <den> [handle]');
            return cmdRate(c, rest[0], rest[1], rest[2] ?? 'F');
        case 'stake':
            return cmdStake(c, rest[0] ?? 'F');
        case 'yield':
            if (!rest[0]) throw new Error('usage: tston.ts yield <tsTON> [handle]');
            return cmdYield(c, rest[0], rest[1] ?? 'F');
        case 'harvest':
            return cmdHarvest(c, rest[0] ?? 'F');
        case 'exit':
            if (!rest[0]) throw new Error('usage: tston.ts exit <leg1|leg2|leg3|loss> [handle]');
            return cmdExit(c, rest[0], rest[1] ?? 'F');
        case 'settle':
            return cmdSettle(c, rest[0] ?? 'F');
        case 'forge':
            return cmdForge(c, rest[0] ?? 'F');
        case 'recover':
            return cmdRecover(c, rest[0] ?? 'F');
        case 'heal':
            return cmdHeal(c, rest[0] ?? 'F');
        default:
            throw new Error(
                `unknown command "${cmd}" — one of: status, refusals, buffer, rate, stake, yield, ` +
                    `harvest, exit, settle, forge, recover, heal`
            );
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
