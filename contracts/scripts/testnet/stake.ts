/**
 * TON PRIMES — D-168 PRIMES staking, driven and asserted on testnet (CONCEPT.md §5.3).
 *
 *   npx tsx contracts/scripts/testnet/stake.ts status   <handle>
 *   npx tsx contracts/scripts/testnet/stake.ts stake    <handle> <PRIMES> <tier 0..3>
 *   npx tsx contracts/scripts/testnet/stake.ts claim    <handle> <positionId>
 *   npx tsx contracts/scripts/testnet/stake.ts expire   <handle> <positionId>
 *   npx tsx contracts/scripts/testnet/stake.ts withdraw <handle> <positionId>
 *   npx tsx contracts/scripts/testnet/stake.ts relock   <handle> <positionId> <tier 0..3>
 *   npx tsx contracts/scripts/testnet/stake.ts distribute [handle] [--wait]
 *     (--wait: within 10 min of due, sleep to the due second + 5 s and send; if the
 *      keeper's lane landed first, assert ITS distribute instead of racing it)
 *
 * A stake is a TEP-74 transfer to the stake master carrying `STKL` + tier; claim,
 * relock, withdraw and expire go to the owner's child; `distribute()` goes to the treasury.
 *
 * THE DRIVER RULE (CLAUDE.md): every arm decides on its READ before it sends. A
 * missing position, a position in flight, a term still running, an already-expired
 * position, a relock that would shorten a running term (1107) or a `distribute()`
 * whose interval is not up is a computed refusal — journalled, never fired as a
 * red transaction.
 */
import { Address, beginCell, fromNano, toNano } from '@ton/core';
import { TonClient } from '@ton/ton';
import { PrimesStake } from '../../wrappers/PrimesStake';
import { PrimesStakePosition } from '../../wrappers/PrimesStakePosition';
import { PrimesTreasury } from '../../wrappers/PrimesTreasury';
import { buildStakeMessage } from '../../../shared/messages';
import { loadEnvFile, envValue } from '../envFile';
import { makeClient, openDeployWallet, openWallet, retry, Wallet } from './sender';
import { readCast } from './cast';
import * as A from './assert';
import { fromAsserts, record } from './journal';

function env(name: string): string {
    const v = envValue(loadEnvFile(), name);
    if (!v) throw new Error(`${name} missing from /.env`);
    return v;
}

async function walletFor(client: TonClient, handle: string): Promise<Wallet> {
    if (handle === 'K') return openDeployWallet(client);
    const entry = readCast().find((c) => c.handle === handle);
    if (!entry) throw new Error(`no cast wallet "${handle}"`);
    return openWallet(client, entry.mnemonic.split(/\s+/), undefined, entry.version); // W5 `P` (§4b)
}

async function primesWalletOf(client: TonClient, owner: Address): Promise<Address> {
    const master = Address.parse(env('PRIMES_JETTON_MASTER_ADDRESS'));
    const r = await retry(
        () =>
            client.runMethod(master, 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
            ]),
        'get_wallet_address'
    );
    return r.stack.readAddress();
}

/** A jetton wallet's balance. An uninitialised wallet holds nothing. */
async function primesBalance(client: TonClient, wallet: Address): Promise<bigint> {
    try {
        const r = await retry(() => client.runMethod(wallet, 'get_wallet_data', []), 'get_wallet_data');
        return r.stack.readBigNumber();
    } catch {
        return 0n;
    }
}

const stakeOf = (client: TonClient) =>
    client.open(PrimesStake.createFromAddress(Address.parse(env('PRIMES_STAKE_ADDRESS'))));
const treasuryOf = (client: TonClient) =>
    client.open(PrimesTreasury.createFromAddress(Address.parse(env('PRIMES_TREASURY_ADDRESS'))));

async function childOf(client: TonClient, owner: Address) {
    const addr = await retry(() => stakeOf(client).getStakePositionAddress(owner), 'getStakePositionAddress');
    return client.open(PrimesStakePosition.createFromAddress(addr));
}

/** ST-1 and ST-2, read in one pass — asserted either side of every write. */
async function invariants(client: TonClient): Promise<A.AssertResult[]> {
    const stake = stakeOf(client);
    const sol = await retry(() => stake.getStakeSolvency(), 'getStakeSolvency');
    const totals = await retry(() => stake.getStakeTotals(), 'getStakeTotals');
    const cfg = await retry(() => stake.getStakeConfig(), 'getStakeConfig');
    const held = await primesBalance(client, cfg.jettonWalletAddr);
    const owed = sol.lockedTotal + sol.streamRemaining + sol.unclaimedTotal;
    return [
        {
            ok: held >= owed,
            name: 'ST1_SOLVENT',
            getMethod: 'stake.getStakeSolvency() vs its wallet get_wallet_data()',
            after: `wallet ${held} >= locked ${sol.lockedTotal} + stream ${sol.streamRemaining} + unclaimed ${sol.unclaimedTotal}`,
            detail: 'ST-1: the master holds at least every PRIMES it owes — principal, the unstreamed budget and the streamed-unpaid rewards',
        },
        {
            ok: totals.budgetsIn === totals.claimedTotal + sol.unclaimedTotal + sol.streamRemaining,
            name: 'ST2_CONSERVED',
            getMethod: 'stake.getStakeTotals() + getStakeSolvency()',
            after: `budgetsIn ${totals.budgetsIn} = claimed ${totals.claimedTotal} + unclaimed ${sol.unclaimedTotal} + stream ${sol.streamRemaining}`,
            detail: 'ST-2: every budget PRIMES is claimed, owed or still streaming — none created, none lost',
        },
    ];
}

async function status(client: TonClient, handle: string) {
    const w = await walletFor(client, handle);
    const stake = stakeOf(client);
    console.log('stream', await retry(() => stake.getStakeStream(), 'getStakeStream'));
    console.log('totals', await retry(() => stake.getStakeTotals(), 'getStakeTotals'));
    console.log('distribution', await retry(() => treasuryOf(client).getDistribution(), 'getDistribution'));
    const child = await childOf(client, w.wallet.address);
    const acc = await retry(() => stake.getAccNow(), 'getAccNow');
    try {
        const ps = await child.getPositions();
        console.log(`${handle}: ${ps.positionCount} positions, ${fromNano(ps.stakedTotal)} PRIMES staked`);
        // Retried per row: an unretried 429 here fell through to the catch below and
        // printed "no child yet" halfway down a list of live positions.
        for (let id = 0; id < ps.nextId; id++) {
            const p = await retry(() => child.getPosition(id), `getPosition(${id})`);
            if (p.maturesAt === 0) continue;
            const c = await retry(() => child.getClaimable(id, acc), `getClaimable(${id})`);
            console.log(`  #${id} ${fromNano(p.amount)} tier ${p.tier} matures ${p.maturesAt} expired ${p.expired} ` +
                `inFlight ${p.inFlight} claimable ${fromNano(c)}`);
        }
    } catch {
        console.log(`${handle}: no child yet — nothing staked`);
    }
    const results = await invariants(client);
    record({ phase: '6', op: 'stake-status', ok: results.every((x) => x.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

function refuse(op: string, name: string, getMethod: string, detail: string) {
    const r: A.AssertResult[] = [{ ok: true, name, getMethod, after: 'not sent', detail }];
    A.print(r);
    record({ phase: '6', op: `${op}-refused`, ok: true, asserts: fromAsserts(r) });
}

async function waitFor(pred: () => Promise<boolean>, budgetMs = 150_000) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (await pred()) return true;
        await new Promise((x) => setTimeout(x, 10_000));
    }
    return false;
}

async function stakeIn(client: TonClient, handle: string, amount: string, tierArg: string) {
    const tier = Number(tierArg);
    const w = await walletFor(client, handle);
    const stakeAddr = Address.parse(env('PRIMES_STAKE_ADDRESS'));
    const myPrimes = await primesWalletOf(client, w.wallet.address);
    const raw = toNano(amount);
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) throw new Error('tier must be 0..3');
    if ((await primesBalance(client, myPrimes)) < raw) {
        return refuse('stake', 'STAKE_REFUSED_BALANCE', 'jettonWallet.get_wallet_data()', `${handle} holds less than ${amount} PRIMES`);
    }
    const before = await retry(() => stakeOf(client).getStakeTotals(), 'getStakeTotals');
    const m = buildStakeMessage({
        amountRaw: raw,
        tier,
        stakeAddress: stakeAddr.toString(),
        ownerAddress: w.wallet.address.toString(),
    });
    await w.sender.send({ to: myPrimes, value: m.value, bounce: true, body: m.body });
    const landed = await waitFor(async () => (await stakeOf(client).getStakeTotals()).stakeEvents > before.stakeEvents);
    const after = await retry(() => stakeOf(client).getStakeTotals(), 'getStakeTotals');
    const results: A.AssertResult[] = [
        {
            ok: landed && after.lockedTotal === before.lockedTotal + raw,
            name: 'STAKE_RECORDED',
            getMethod: 'stake.getStakeTotals().lockedTotal',
            before: before.lockedTotal.toString(),
            after: after.lockedTotal.toString(),
            detail: `the master books exactly the ${amount} PRIMES transferred, at tier ${tier}`,
        },
        ...(await invariants(client)),
    ];
    record({ phase: '6', op: 'stake', ok: results.every((x) => x.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

type Op = 'claim' | 'expire' | 'withdraw';

async function positionOp(client: TonClient, op: Op, handle: string, idArg: string) {
    const id = Number(idArg);
    const w = await walletFor(client, handle);
    const owner = w.wallet.address;
    const child = await childOf(client, owner);
    // THE READ DECIDES. A missing row reads back as all zeros (`maturesAt == 0`).
    let p;
    try {
        p = await child.getPosition(id);
    } catch {
        return refuse(op, 'STAKE_OP_REFUSED_NO_CHILD', 'stake.getStakePositionAddress(owner)', `${handle} has never staked`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (p.maturesAt === 0) return refuse(op, 'STAKE_OP_REFUSED_NO_POSITION', `child.getPosition(${id})`, `no position #${id}`);
    if (p.inFlight === 1) return refuse(op, 'STAKE_OP_REFUSED_IN_FLIGHT', `child.getPosition(${id}).inFlight`, 'a settle is already in flight (1108)');
    if ((op === 'withdraw' || op === 'expire') && now < p.maturesAt) {
        return refuse(op, 'STAKE_OP_REFUSED_TERM_RUNNING', `child.getPosition(${id}).maturesAt`,
            `term runs until ${p.maturesAt} (1106, ST-3: no early exit)`);
    }
    if (op === 'expire' && p.expired === 1) {
        return refuse(op, 'STAKE_EXPIRE_REFUSED_ALREADY', `child.getPosition(${id}).expired`, 'already expired — the poke would be a no-op');
    }
    const primesBefore = await primesBalance(client, await primesWalletOf(client, owner));
    const acc = await retry(() => stakeOf(client).getAccNow(), 'getAccNow');
    const claimable = await child.getClaimable(id, acc);
    if (op === 'claim') await child.sendClaim(w.sender, { positionId: id });
    if (op === 'expire') await child.sendExpire(w.sender, { positionId: id });
    if (op === 'withdraw') await child.sendWithdraw(w.sender, { positionId: id });
    await waitFor(async () => {
        const q = await child.getPosition(id);
        return q.inFlight === 0 && (op !== 'withdraw' || q.maturesAt === 0);
    });
    const q = await child.getPosition(id);
    const primesAfter = await primesBalance(client, await primesWalletOf(client, owner));
    const results: A.AssertResult[] = [
        op === 'expire'
            ? {
                  ok: q.expired === 1 && q.banked >= p.banked,
                  name: 'STAKE_EXPIRED_BANKED',
                  getMethod: `child.getPosition(${id})`,
                  after: `expired ${q.expired} banked ${q.banked}`,
                  detail: 'the prorated tail is banked on the child and no PRIMES moved',
              }
            : {
                  ok: primesAfter - primesBefore >= (op === 'withdraw' ? p.amount : 0n) && (op !== 'withdraw' || q.maturesAt === 0),
                  name: op === 'withdraw' ? 'STAKE_WITHDRAWN' : 'STAKE_CLAIMED',
                  getMethod: 'jettonWallet.get_wallet_data() on the owner',
                  before: primesBefore.toString(),
                  after: primesAfter.toString(),
                  detail: `paid ${primesAfter - primesBefore} (claimable read ${claimable}${op === 'withdraw' ? ` + principal ${p.amount}` : ''})`,
              },
        ...(await invariants(client)),
    ];
    record({ phase: '6', op: `stake-${op}`, ok: results.every((x) => x.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** `relock(id, tier)`: the child's 1107 rule (`newTier ≥ tier || now ≥ maturesAt`) decided on the READ. */
async function relock(client: TonClient, handle: string, idArg: string, tierArg: string) {
    const id = Number(idArg);
    const tier = Number(tierArg);
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) throw new Error('tier must be 0..3');
    const w = await walletFor(client, handle);
    const child = await childOf(client, w.wallet.address);
    let p;
    try {
        p = await child.getPosition(id);
    } catch {
        return refuse('relock', 'STAKE_OP_REFUSED_NO_CHILD', 'stake.getStakePositionAddress(owner)', `${handle} has never staked`);
    }
    const now = Math.floor(Date.now() / 1000);
    if (p.maturesAt === 0) return refuse('relock', 'STAKE_OP_REFUSED_NO_POSITION', `child.getPosition(${id})`, `no position #${id}`);
    if (p.inFlight === 1) return refuse('relock', 'STAKE_OP_REFUSED_IN_FLIGHT', `child.getPosition(${id}).inFlight`, 'a settle is already in flight (1108)');
    if (tier < p.tier && now < p.maturesAt) {
        return refuse('relock', 'STAKE_RELOCK_REFUSED_DOWNGRADE', `child.getPosition(${id}).tier/maturesAt`,
            `tier ${p.tier} -> ${tier} before maturity ${p.maturesAt} would shorten a running term (1107)`);
    }
    await child.sendRelock(w.sender, { positionId: id, tier });
    await waitFor(async () => {
        const q = await child.getPosition(id);
        return q.inFlight === 0 && q.lockedAt > p.lockedAt;
    });
    const q = await child.getPosition(id);
    const results: A.AssertResult[] = [
        {
            ok: q.tier === tier && q.lockedAt > p.lockedAt && q.maturesAt > p.maturesAt && q.expired === 0 && q.amount === p.amount,
            name: 'STAKE_RELOCKED',
            getMethod: `child.getPosition(${id})`,
            before: `tier ${p.tier} lockedAt ${p.lockedAt} maturesAt ${p.maturesAt} expired ${p.expired}`,
            after: `tier ${q.tier} lockedAt ${q.lockedAt} maturesAt ${q.maturesAt} expired ${q.expired}`,
            detail: 'the term restarts at the new tier on the same principal, and earning resumes',
        },
        ...(await invariants(client)),
    ];
    record({ phase: '6', op: 'stake-relock', ok: results.every((x) => x.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** `--wait` sleeps at most this long for the due second; a longer wait belongs in the caller's shell, not in a parked tsx. */
const DISTRIBUTE_WAIT_CAP_S = 600;
/** Seconds past the due second before sending: block `now` lags the wall clock, and a send AT the due second can earn its own 1200. */
const DISTRIBUTE_SEND_LAG_S = 5;

async function distribute(client: TonClient, handle?: string, wait = false) {
    const treasury = treasuryOf(client);
    const d = await retry(() => treasury.getDistribution(), 'getDistribution');
    const due = d.lastDistributeTime + d.interval;
    const now = Math.floor(Date.now() / 1000);
    if (now < due && !(wait && due - now <= DISTRIBUTE_WAIT_CAP_S)) {
        return refuse('distribute', 'DISTRIBUTE_REFUSED_EARLY', 'treasury.getDistribution()',
            `next due at ${due} (1200)${wait ? `; --wait only covers the last ${DISTRIBUTE_WAIT_CAP_S}s` : ''}`);
    }
    if (d.nextBudgetEstimate < 1n) {
        return refuse('distribute', 'DISTRIBUTE_REFUSED_DUST', 'treasury.getDistribution().nextBudgetEstimate', 'empty treasury (1201)');
    }
    // `distribute()` is permissionless: any handle may send it (the owner's `P` walkthrough does).
    const w = handle ? await walletFor(client, handle) : await openDeployWallet(client);
    const before = await retry(() => stakeOf(client).getStakeTotals(), 'getStakeTotals');
    const sendAt = due + DISTRIBUTE_SEND_LAG_S;
    if (Math.floor(Date.now() / 1000) < sendAt) {
        console.log(`waiting ${sendAt - Math.floor(Date.now() / 1000)}s for the due second (${due}) + ${DISTRIBUTE_SEND_LAG_S}s`);
        while (Math.floor(Date.now() / 1000) < sendAt) await new Promise((x) => setTimeout(x, 1000));
    }
    // RE-READ IMMEDIATELY BEFORE THE SEND. The keeper's distribute lane calls the same
    // permissionless op each cycle; if it landed first, this send would be a red 1200.
    // Its distribute is the same formula, so it is asserted instead of raced.
    const d2 = await retry(() => treasury.getDistribution(), 'getDistribution(pre-send)');
    const sender = d2.lastDistributeTime !== d.lastDistributeTime ? 'another caller (the keeper)' : handle ?? 'K';
    if (d2.lastDistributeTime === d.lastDistributeTime) await treasury.sendDistribute(w.sender);
    else console.log(`distribute already landed at ${d2.lastDistributeTime} from ${sender}; asserting that one, nothing sent`);
    const landed = await waitFor(async () => (await stakeOf(client).getStakeTotals()).budgetEvents > before.budgetEvents);
    const after = await retry(() => stakeOf(client).getStakeTotals(), 'getStakeTotals');
    const results: A.AssertResult[] = [
        {
            ok: landed && after.budgetEvents === before.budgetEvents + 1 && after.budgetsIn - before.budgetsIn === d.nextBudgetEstimate,
            name: 'DISTRIBUTE_FORMULA',
            getMethod: 'treasury.getDistribution().nextBudgetEstimate vs stake.getStakeTotals().budgetsIn',
            before: before.budgetsIn.toString(),
            after: after.budgetsIn.toString(),
            detail: `TR-2: the budget the master received is exactly the formula the treasury published (sent by ${sender})`,
        },
        ...(await invariants(client)),
    ];
    record({ phase: '6', op: 'distribute', ok: results.every((x) => x.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function main() {
    const client = makeClient();
    const [cmd, handle, a, b] = process.argv.slice(2);
    if (cmd === 'distribute') return distribute(client, handle === '--wait' ? undefined : handle, process.argv.includes('--wait'));
    if (!cmd || !handle) throw new Error('usage: stake.ts <status|stake|claim|relock|expire|withdraw|distribute> <handle> …');
    if (cmd === 'status') return status(client, handle);
    if (cmd === 'stake') {
        if (!a || !b) throw new Error('usage: stake.ts stake <handle> <PRIMES> <tier 0..3>');
        return stakeIn(client, handle, a, b);
    }
    if (cmd === 'relock') {
        if (!a || !b) throw new Error('usage: stake.ts relock <handle> <positionId> <tier 0..3>');
        return relock(client, handle, a, b);
    }
    if (cmd === 'claim' || cmd === 'expire' || cmd === 'withdraw') {
        if (!a) throw new Error(`usage: stake.ts ${cmd} <handle> <positionId>`);
        return positionOp(client, cmd, handle, a);
    }
    throw new Error(`unknown command "${cmd}"`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
