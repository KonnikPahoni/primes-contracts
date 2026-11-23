/**
 * TON PRIMES — the lane no acceptance wave has ever reached: a REAL LP position
 * in the governed treasury, and the vote it carries.
 *
 * WHY IT WAS NEVER TESTED. A custody position exists only when LP JETTONS arrive
 * at the treasury's own LP wallet (`primes_treasury.tolk`'s `set_wallets`
 * bootstrap), and every prior testnet set was deployed with
 * `PRIMES_DEDUST_LP_STANDIN=1` — a hash-derived address nothing can send from.
 * So `getTreasuryBalances().lpHeld` was structurally 0, and with it the whole
 * `propose` / `vote` / `execute` path and `GAUNTLET.md` R14/R15. This set has a
 * real DeDust v2 pool, so the lane is reachable for the first time.
 *
 *   npx tsx contracts/scripts/testnet/lpGovernance.ts deposit <handle> <GRAM> <tier>
 *   npx tsx contracts/scripts/testnet/lpGovernance.ts status
 *   npx tsx contracts/scripts/testnet/lpGovernance.ts propose <handle> <asset> <amount> <dest>
 *   npx tsx contracts/scripts/testnet/lpGovernance.ts vote|execute <handle> <seq | last>
 *
 * D-194's venue confirm is `propose L 3 queued timelock`: asset 3, the timelock's
 * current record seq, the deployed timelock. It is proposed no earlier than the record's
 * `eta − noticeDuration − voteDuration` (audit H1: the vote must close at or after the
 * eta, 808; audit R2-H1: the vote opens a notice after the proposal), waiting up to 20
 * minutes for that and refusing beyond.
 *
 * EVERY PROPOSAL HAS A NOTICE (D-173 as amended 2026-11-19): its vote opens
 * `getGov().noticeDuration` after `propose`, and a vote before the row's `opens` is
 * refused 1206. `vote` reads `opens` off the row and waits up to 20 minutes for it,
 * refusing beyond; `execute` waits out a vote window of up to 20 minutes on the row's
 * own `closes`, then decides. At D-139's divisor 168 that is ~514 s of notice plus
 * ~514 s of vote per proposal.
 *
 * `deposit` is the whole chain in order, each step guarded so a re-run finishes
 * what the last one did not:
 *   1. buy PRIMES for `<handle>` if it has none (a two-sided deposit needs both);
 *   2. deposit both legs into the pool FROM THE SAME WALLET — DeDust stages a
 *      deposit in an LP-account contract derived from the depositor, so two
 *      senders make two half-filled deposits that never settle;
 *   3. forward the LP receipt to the TREASURY with `TDEP` + tier, which is what
 *      `deposit_liquidity` cannot express itself: it has no recipient field in
 *      either half of its schema (GAUNTLET R13), so the LP jetton can only go to
 *      the depositor and must then be transferred on.
 *
 * D-168: four tiers (30 d / 3 m / 6 m / 1 y), every one of which VOTES while its
 * term runs and none of which earns PRIMES. Tier 0 is the one to test withdrawal
 * on: `getPosition().maturesAt` is scaled by D-139's clock divisor on both
 * contracts, so on a divided testnet the 30-day rung matures within hours.
 */
import { Address, beginCell, fromNano, toNano } from '@ton/core';
import { TonClient } from '@ton/ton';
import { PrimesTreasury, depositPayload } from '../../wrappers/PrimesTreasury';
import { PrimesLpPosition } from '../../wrappers/PrimesLpPosition';
import { PrimesVenueTimelock } from '../../wrappers/PrimesVenueTimelock';
import {
    DEPOSIT_JETTON_FORWARD,
    DEPOSIT_JETTON_VALUE,
    DEPOSIT_NATIVE_GAS,
    depositJettonForwardPayload,
    depositNativeBody,
    jettonAsset,
    jettonTransferBody,
} from '../dedust';
import type { DedustAsset } from '../dedust';
import { loadEnvFile, envValue } from '../envFile';
import { ERRORS } from '../../../shared/opcodes';
import params from '../../../shared/params.json';
import { makeClient, openDeployWallet, openWallet, retry, Wallet } from './sender';
import { readCast } from './cast';
import * as A from './assert';
import { fromAsserts, record } from './journal';

/**
 * A guard that answered from a GET-METHOD and did not send (§2.5 rule 1). It is
 * journalled as evidence rather than lost to stderr: a refusal that was correctly
 * predicted is the cheapest possible coverage of the error code behind it, and a
 * run record that omits it reads as though the arm was never reached.
 */
class Refusal extends Error {
    constructor(
        message: string,
        readonly getMethod: string
    ) {
        super(message);
    }
}

function env(name: string): string {
    const v = envValue(loadEnvFile(), name);
    if (!v) throw new Error(`${name} missing from /.env`);
    return v;
}

const NATIVE_ASSET = { kind: 'native' as const };

async function walletFor(client: TonClient, handle: string): Promise<Wallet> {
    if (handle === 'K') return openDeployWallet(client);
    const entry = readCast().find((c) => c.handle === handle);
    if (!entry) throw new Error(`no cast wallet "${handle}"`);
    return openWallet(client, entry.mnemonic.split(/\s+/), undefined, entry.version); // W5 `P` (§4b)
}

async function walletAddressOn(client: TonClient, master: Address, owner: Address): Promise<Address> {
    const r = await retry(
        () =>
            client.runMethod(master, 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
            ]),
        'get_wallet_address'
    );
    return r.stack.readAddress();
}

async function jettonBalance(client: TonClient, wallet: Address): Promise<bigint> {
    try {
        // RETRIED: without it a single 429 returns 0n, and `deposit` then refuses a
        // funded wallet with "holds 0 PRIMES, short of …" — a rate limit reported as
        // an economic fact. The catch is kept for the genuinely uninitialised wallet,
        // which is what `retry` re-raises after it has exhausted its attempts.
        const r = await retry(() => client.runMethod(wallet, 'get_wallet_data', []), 'get_wallet_data');
        return r.stack.readBigNumber();
    } catch {
        return 0n; // uninitialised wallet = no balance, not an error
    }
}

function treasuryOf(client: TonClient) {
    return client.open(PrimesTreasury.createFromAddress(Address.parse(env('PRIMES_TREASURY_ADDRESS'))));
}

/** `1153` -> `treasury_no_proposal`. Every code getExecutable can return is in ERRORS. */
function errName(code: number): string {
    if (code === 0) return 'ok';
    const hit = Object.entries(ERRORS).find(([, v]) => v === code);
    return hit ? hit[0] : 'unknown';
}

/**
 * `proposalSeq` is a COUNT, not an id — the treasury issues seq `proposalSeq`
 * and then increments, so the newest proposal is `proposalSeq - 1`. Reading it
 * as an id cost a live wasted on-chain `position_vote` on a proposal that did
 * not exist, answered only by an all-zero row and `reason 1153`.
 */
function seqLine(proposalSeq: number): string {
    return proposalSeq === 0
        ? 'no proposal has ever been opened (proposalSeq is a COUNT, currently 0)'
        : `highest valid seq is #${proposalSeq - 1} (proposalSeq is a COUNT: ids run 0..proposalSeq-1)`;
}

/**
 * `voteMultiplier(tier)` (D-168: every tier votes). Taken from
 * `shared/params.json` rather than retyped, because a ladder written out by hand
 * in a harness is exactly the invented parameter CLAUDE.md rule 3 forbids.
 * `LADDER_IS_THE_SIM` below asserts the DEPLOYED bytecode agrees with it.
 */
const VOTE_MULTS: readonly number[] = params.treasury.vote_multipliers;

/** `amount × voteMultiplier(tier)`. */
const voteWeight = (amount: bigint, tier: number) => amount * BigInt(VOTE_MULTS[tier] ?? 0);

type PositionRow = Awaited<ReturnType<PrimesLpPosition['getPosition']>>;
type PositionsRow = Awaited<ReturnType<PrimesLpPosition['getPositions']>>;

/**
 * `seqLine`'s counterpart on the position side, and the trap is one turn worse.
 * `nextId` is a COUNT of ids ever ISSUED (the exclusive upper bound of the id
 * range) and `positionCount` is how many of them are still LIVE — neither is an
 * id. Ids are never reused, so a withdrawn position leaves its id below `nextId`
 * for ever: `positionCount 0, nextId 1` is one position created and gone, and a
 * naive `id < nextId` test PASSES for it. Only the dict row is the honest test.
 */
export function idLine(ps: PositionsRow): string {
    return ps.nextId === 0
        ? 'this wallet has never held a position (nextId is a COUNT of ids ever issued, currently 0).'
        : `ids ever issued run 0..${ps.nextId - 1}, of which ${ps.positionCount} are still live — ` +
              `the live ones are listed above. Neither figure is an id: ids are never reused, so a ` +
              `withdrawn id stays below nextId for ever and "id < nextId" is not a test of existence.`;
}

/**
 * THE GUARD every positionId-taking command goes through before it spends a
 * message, `requireProposal`'s sibling. A missing position reads back as a
 * ZERO ROW from `getPosition` — the dict miss, not an error and saying nothing
 * — which is exactly what `withdraw` printed to the console and then sent a
 * message over anyway. Pure over state the caller has already read, so the read
 * decides and the message is not sent.
 */
export function requirePosition(ps: PositionsRow, positionId: number, row: PositionRow, what: string): PositionRow {
    if (!Number.isInteger(positionId) || positionId < 0 || row.amount === 0n) {
        throw new Refusal(
            `position #${positionId} does not exist (empty row) — ${idLine(ps)} Refusing to ${what}.`,
            'positionChild.getPositions() + getPosition(id)'
        );
    }
    // `position_in_flight` 1168: an LP move is already out and the contract refuses
    // the second message rather than double-spending it.
    if (row.inFlight) {
        throw new Refusal(
            `position #${positionId} has an LP move IN FLIGHT — the contract refuses a second ` +
                `message (1168 position_in_flight) until the treasury's reply lands. Refusing to ${what}.`,
            'positionChild.getPosition(id).inFlight'
        );
    }
    return row;
}

/** `position_term_running` 1166, answered from `maturesAt` instead of provoked. */
export function requireMatured(positionId: number, row: PositionRow, what: string) {
    const now = Math.floor(Date.now() / 1000);
    if (now < row.maturesAt) {
        throw new Refusal(
            `position #${positionId} has not matured: ${row.maturesAt - now}s ` +
                `(${((row.maturesAt - now) / 3600).toFixed(2)}h) of its term left — the tier's own LOCK ` +
                `TERM, divided by D-139's clock (1166 position_term_running). Refusing to ${what}.`,
            'positionChild.getPosition(id).maturesAt'
        );
    }
}

async function status(client: TonClient) {
    const treasury = treasuryOf(client);
    console.log('distribution', await retry(() => treasury.getDistribution(), 'getDistribution'));
    const gov = await retry(() => treasury.getGov(), 'getGov');
    console.log('gov     ', gov);
    console.log(`         proposalSeq ${gov.proposalSeq} = proposals ever opened; ${seqLine(gov.proposalSeq)}`);
    console.log('balances', await retry(() => treasury.getTreasuryBalances(), "getTreasuryBalances"));

    const voteMults = await retry(() => treasury.getVoteMultipliers(), 'getVoteMultipliers');
    const results: A.AssertResult[] = [
        {
            ok: JSON.stringify(voteMults) === JSON.stringify(VOTE_MULTS),
            name: 'LADDER_IS_THE_SIM',
            getMethod: 'treasury.getVoteMultipliers()',
            before: `params.json ${JSON.stringify(VOTE_MULTS)}`,
            after: `chain ${JSON.stringify(voteMults)}`,
            detail:
                "the DEPLOYED bytecode's vote ladder against `shared/params.json`'s " +
                '`treasury.vote_multipliers` — the only authority for it (CLAUDE.md rule 3). Every ' +
                'weight assert below is computed from it, so a set compiled against a different ' +
                'ladder must fail HERE and not silently downstream',
        },
        {
            ok: voteMults.length === 4 && voteMults.every((m) => m > 0),
            name: 'EVERY_TIER_VOTES',
            getMethod: 'treasury.getVoteMultipliers()',
            after: JSON.stringify(voteMults),
            detail: 'D-168 deleted the rungs that only ever mined: all four remaining terms vote while they run',
        },
    ];
    record({ phase: '5', op: 'lp-status', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * THE GUARD every seq-taking command goes through before it spends a message.
 * A missing proposal reads back as a zero row (`opens === 0`, `proposer` null),
 * which is not an error and says nothing — so say it here, once, for every
 * caller, and name the highest seq that does exist.
 */
/**
 * `last` (D-194): the newest proposal `handle` opened. The treasury publishes no
 * per-owner index (`openBy` has no getter), so the rows are walked down from
 * `proposalSeq - 1` for one whose `proposer` is the handle's wallet. A pruned row
 * reads as empty and is skipped; finding none is a refusal, not a guess.
 */
async function lastSeqOf(client: TonClient, handle: string): Promise<number> {
    const w = await walletFor(client, handle);
    const treasury = treasuryOf(client);
    const gov = await retry(() => treasury.getGov(), 'getGov');
    for (let seq = gov.proposalSeq - 1; seq >= 0 && seq >= gov.proposalSeq - 64; seq--) {
        const p = await retry(() => treasury.getProposal(seq), `getProposal(${seq})`);
        if (p.proposer && p.proposer.equals(w.wallet.address)) {
            console.log(`${handle}'s latest proposal is #${seq}`);
            return seq;
        }
    }
    throw new Refusal(
        `${handle} has no proposal among the latest 64 rows — ${seqLine(gov.proposalSeq)}. Refusing to resolve \`last\`.`,
        'treasury.getGov().proposalSeq + getProposal(seq).proposer'
    );
}

/** A `<seq>` argument: a number, or `last` for `handle`'s newest proposal. */
async function seqArg(client: TonClient, handle: string, arg: string): Promise<number> {
    return arg === 'last' ? lastSeqOf(client, handle) : Number(arg);
}

async function requireProposal(client: TonClient, seq: number, what: string) {
    const treasury = treasuryOf(client);
    const gov = await retry(() => treasury.getGov(), 'getGov');
    if (!Number.isInteger(seq) || seq < 0 || seq >= gov.proposalSeq) {
        throw new Refusal(
            `proposal #${seq} does not exist — ${seqLine(gov.proposalSeq)}. Refusing to ${what}.`,
            'treasury.getGov().proposalSeq'
        );
    }
    const p = await retry(() => treasury.getProposal(seq), 'getProposal');
    if (p.opens === 0 || p.proposer === null) {
        throw new Refusal(
            `proposal #${seq} does not exist (empty row: never opened, or pruned once settled — ` +
                `D-188 point 7) — ${seqLine(gov.proposalSeq)}. Refusing to ${what}.`,
            'treasury.getProposal(seq)'
        );
    }
    return p;
}

async function deposit(client: TonClient, handle: string, tonSide: string, tier: number) {
    const pool = Address.parse(env('PRIMES_DEDUST_POOL_ADDR'));
    const master = Address.parse(env('PRIMES_JETTON_MASTER_ADDRESS'));
    const jettonVault = Address.parse(env('PRIMES_DEDUST_JETTON_VAULT_ADDR'));
    const nativeVault = Address.parse(env('PRIMES_DEDUST_VAULT_ADDR'));
    const treasuryAddr = Address.parse(env('PRIMES_TREASURY_ADDRESS'));

    const w = await walletFor(client, handle);
    const assets: [DedustAsset, DedustAsset] = [NATIVE_ASSET, jettonAsset(master)];

    // The pool's live ratio decides the PRIMES side: a deposit off-ratio is
    // trimmed by DeDust and the remainder returned, which wastes a round trip.
    const r = await retry(() => client.runMethod(pool, 'get_reserves', []), 'get_reserves');
    const tonRes = r.stack.readBigNumber();
    const primesRes = r.stack.readBigNumber();
    const tonAmount = toNano(tonSide);
    const primesAmount = (tonAmount * primesRes) / tonRes;
    console.log(
        `pool ${fromNano(tonRes)} GRAM / ${fromNano(primesRes)} PRIMES -> depositing ` +
            `${fromNano(tonAmount)} GRAM + ${fromNano(primesAmount)} PRIMES from ${handle}`
    );

    // The pool IS the LP jetton master, so the depositor's LP wallet is derived
    // off it exactly like any other jetton wallet. LP ALREADY SITTING THERE is a
    // previous run's minted-but-unforwarded receipt: forward it, do not deposit
    // both legs a second time (the driver rule — the read decides).
    const myLp = await walletAddressOn(client, pool, w.wallet.address);
    const unforwarded = await jettonBalance(client, myLp);
    if (unforwarded > 0n) console.log(`${fromNano(unforwarded)} LP already minted and unforwarded — skipping both legs`);

    const myPrimes = await walletAddressOn(client, master, w.wallet.address);
    const have = await jettonBalance(client, myPrimes);
    if (unforwarded === 0n && have < primesAmount) {
        throw new Refusal(
            `${handle} holds ${fromNano(have)} PRIMES, short of the ${fromNano(primesAmount)} this deposit needs. ` +
                `Buy some first: pool.ts buy ${handle} <GRAM>`,
            'jettonWallet.get_wallet_data() + pool.get_reserves'
        );
    }

    if (unforwarded === 0n) {
        console.log('depositing the GRAM leg ...');
        await w.sender.send({
            to: nativeVault,
            value: tonAmount + DEPOSIT_NATIVE_GAS,
            bounce: true,
            body: depositNativeBody({ assets, targetBalances: [tonAmount, primesAmount], amount: tonAmount }),
        });

        console.log('depositing the PRIMES leg ...');
        await w.sender.send({
            to: myPrimes,
            value: DEPOSIT_JETTON_VALUE,
            bounce: true,
            body: jettonTransferBody({
                amount: primesAmount,
                destination: jettonVault,
                responseAddress: w.wallet.address,
                forwardTon: DEPOSIT_JETTON_FORWARD,
                forwardPayload: depositJettonForwardPayload({ assets, targetBalances: [tonAmount, primesAmount] }),
            }),
        });
    }

    const lp = await jettonBalance(client, myLp);
    console.log(`LP receipt: ${fromNano(lp)} units in ${myLp.toString({ testOnly: true })}`);
    if (lp === 0n) {
        throw new Error('no LP minted yet — the two legs settle asynchronously; re-run in a minute');
    }

    console.log(`forwarding the LP receipt to the treasury with TDEP tier ${tier} ...`);
    const position = await positionOf(client, w);
    const beforeBal = await retry(() => treasuryOf(client).getTreasuryBalances(), 'getTreasuryBalances-before');
    const beforeWeights = await weightsOrEmpty(client, position);
    await w.sender.send({
        to: myLp,
        value: toNano('0.35'),
        bounce: true,
        body: jettonTransferBody({
            amount: lp,
            destination: treasuryAddr,
            responseAddress: w.wallet.address,
            forwardTon: toNano('0.25'),
            forwardPayload: depositPayload(tier),
        }),
    });
    // THE CUSTODY HOP IS ASYNCHRONOUS — the LP jetton reaches the treasury, which
    // then derives and writes the child. Reading once here reported the before
    // state as the after.
    console.log('sent. Waiting for the treasury to book the position ...');
    const deadline = Date.now() + 180_000;
    let afterWeights = await weightsOrEmpty(client, position);
    while (Date.now() < deadline && afterWeights.ps.nextId === beforeWeights.ps.nextId) {
        await new Promise((r) => setTimeout(r, 10_000));
        afterWeights = await weightsOrEmpty(client, position);
    }
    const afterBal = await retry(() => treasuryOf(client).getTreasuryBalances(), 'getTreasuryBalances-after');
    const results: A.AssertResult[] = [
        {
            ok:
                afterWeights.ps.nextId === beforeWeights.ps.nextId + 1 &&
                afterWeights.ps.positionCount === beforeWeights.ps.positionCount + 1,
            name: 'POSITION_OPENED',
            getMethod: 'positionChild.getPositions().{nextId,positionCount}',
            before: `nextId ${beforeWeights.ps.nextId} live ${beforeWeights.ps.positionCount}`,
            after: `nextId ${afterWeights.ps.nextId} live ${afterWeights.ps.positionCount}`,
            detail:
                'ONE id issued and ONE live row added. Ids are never reused, so both figures must ' +
                'move together here — a `nextId` that moved alone is a row the treasury booked and ' +
                'then lost',
        },
        {
            ok: afterBal.lpHeld === beforeBal.lpHeld + lp,
            name: 'TREASURY_HOLDS_THE_DEPOSITORS_LP',
            getMethod: 'treasury.getTreasuryBalances().lpHeld',
            before: beforeBal.lpHeld.toString(),
            after: afterBal.lpHeld.toString(),
            detail:
                `the ${lp} LP units forwarded landed in \`lpHeld\`, which is the DEPOSITORS' pot and ` +
                'is never proposable (TR-5). Since D-167 it is ALL the LP the treasury holds — no ' +
                'proposal asset names LP at all',
        },
        ...ladderAsserts(afterWeights),
    ];
    record({ phase: '5', op: 'lp-deposit', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.print(results);
    console.log('Reading the treasury back:');
    await status(client);
    A.requireAll(results);
}

type Position = Awaited<ReturnType<typeof positionOf>>;

/**
 * THE VOTE LADDER, RECOMPUTED OVER THE WALLET'S OWN ROWS and read back off the
 * aggregate the child publishes: `voteWeight` is `Σ amount × voteMultiplier(tier)`
 * less what `expire` has retired.
 */
async function weights(position: Position) {
    const ps = await retry(() => position.getPositions(), 'getPositions');
    const read = await retry(() => position.getVoteWeight(), 'getVoteWeight');
    let vote = 0n;
    for (let id = 0; id < ps.nextId; id++) {
        const row = await retry(() => position.getPosition(id), `getPosition(${id})`);
        if (row.amount === 0n) continue;
        if (row.expired !== 1) vote += voteWeight(row.amount, row.tier);
    }
    return { ps, vote, read };
}

/**
 * `weights()` for a child that may not exist yet. A wallet's FIRST deposit is what
 * deploys its child, so before it (and until the custody hop lands) every get-method
 * answers exit -13; reading that as eight retries and a throw stopped the first-ever
 * deposit on the 20260927 set after the LP was minted and before it was forwarded.
 */
async function weightsOrEmpty(client: TonClient, position: Position) {
    const st = await retry(() => client.getContractState(position.address), 'getContractState(position)');
    if (st.state === 'active') return weights(position);
    return { ps: { positionCount: 0, nextId: 0, voteWeight: 0n }, vote: 0n, read: 0n };
}

/** The ladder assert, over one `weights()` reading. */
function ladderAsserts(w: Awaited<ReturnType<typeof weights>>): A.AssertResult[] {
    return [
        {
            ok: w.read === w.vote && w.ps.voteWeight === w.vote,
            name: 'VOTE_WEIGHT_IS_LADDER',
            getMethod: 'positionChild.getVoteWeight() + getPositions().voteWeight vs Σ amount × vote_multipliers[tier]',
            before: `Σ from the ladder ${w.vote}`,
            after: `getVoteWeight ${w.read}, getPositions ${w.ps.voteWeight}`,
            detail:
                'the GOVERNANCE aggregate over the same rows and a DIFFERENT ladder ' +
                '(`treasury.vote_multipliers`): an `expire`d row contributes nothing whatever its ' +
                'tier. Both published spellings must ' +
                'agree with the recomputation or a vote is weighed by a figure nobody can check',
        },
    ];
}

/** The depositor's own position child, derived by the treasury from their address. */
async function positionOf(client: TonClient, w: Wallet) {
    const treasury = client.open(PrimesTreasury.createFromAddress(Address.parse(env('PRIMES_TREASURY_ADDRESS'))));
    const addr = await retry(() => treasury.getPositionAddress(w.wallet.address), 'getPositionAddress');
    return client.open(PrimesLpPosition.createFromAddress(addr));
}

/**
 * A proposal is opened BY THE POSITION, not by the wallet: the treasury
 * authenticates the child by re-deriving its address, which is what makes
 * "only a custody position may propose" structural rather than a check on a claimed
 * identity. `asset` is 0 GRAM / 1 PRIMES / 2 tsTON — the third added by
 * D-151 (LP is not proposable, D-167), which lets the treasury hold and spend the ratchet's harvested yield.
 * A tsTON proposal has a balance to move only AFTER `tston.ts harvest` has run,
 * which is why phase 10 and not phase 5 is where it is sequenced.
 *
 * Asset 3 (D-194) is a VENUE CONFIRM, not a transfer: `amount` is the venue
 * timelock's record `seq` (a plain integer, not GRAM) and `dest` the timelock.
 */
async function propose(client: TonClient, handle: string, asset: number, amount: string, dest: string) {
    const w = await walletFor(client, handle);
    const position = await positionOf(client, w);
    // `dest` may be a raw address OR a cast handle. Sequencing a proposal from
    // `run.ts` means naming a destination in a file that must stay free of any
    // address (§2's "nothing in it is tied to an address"), so a handle resolves
    // here rather than being pasted into the step list.
    // `timelock` (D-194) names the deployed venue timelock, for the same reason.
    const to =
        dest === 'timelock'
            ? Address.parse(env('PRIMES_VENUE_TIMELOCK_ADDRESS'))
            : Address.isFriendly(dest) || Address.isRaw(dest)
              ? Address.parse(dest)
              : (await walletFor(client, dest)).wallet.address;
    // `queued` (D-194, asset 3 only): the seq of the record the timelock holds NOW,
    // read off chain — `run.ts` cannot know it when the step list is written. A
    // record that is fired or already confirmed has nothing left for a vote to do.
    if (amount === 'queued') {
        if (asset !== 3) throw new Error('`queued` is a venue-confirm amount (asset 3) only');
        const q = await retry(() => client.open(PrimesVenueTimelock.createFromAddress(to)).getQueued(), 'timelock.getQueued');
        if (q.hasQueued !== 1 || q.fired !== 0 || q.confirmed !== 0) {
            throw new Refusal(
                `the venue timelock has no record to confirm (hasQueued ${q.hasQueued}, fired ${q.fired}, ` +
                    `confirmed ${q.confirmed}, seq ${q.seq}) — a vote on it would confirm nothing. Refusing to propose.`,
                'venueTimelock.getQueued()'
            );
        }
        amount = String(q.seq);
        console.log(`the timelock's queued record is seq ${q.seq}`);
    }
    // Audit H1 (D-194 amendment, 2026-11-19): the timelock confirms only a vote that
    // CLOSES at or after its record's `eta` (808), i.e. one whose vote opens no earlier
    // than `eta − voteDuration` — so holders get the whole notice to lock LP and vote no.
    // Audit R2-H1: the treasury opens the vote `noticeDuration` after the propose, so
    // the PROPOSE goes no earlier than `eta − noticeDuration − voteDuration`. Proposing
    // earlier would pass here and bounce at execute; decide it now, off the timelock's
    // own `eta` and the treasury's own two durations.
    if (asset === 3) {
        const q = await retry(() => client.open(PrimesVenueTimelock.createFromAddress(to)).getQueued(), 'timelock.getQueued');
        const { voteDuration, noticeDuration } = await retry(() => treasuryOf(client).getGov(), 'getGov');
        const earliest = q.eta - noticeDuration - voteDuration;
        // +15 s: the block clock, not this machine's, stamps `opens`.
        const wait = earliest - Math.floor(Date.now() / 1000) + 15;
        if (wait > 0 && wait <= MAX_VOTE_WAIT_S) {
            console.log(
                `a confirming proposal may be proposed from ${earliest} (eta ${q.eta} − notice ${noticeDuration}s − ` +
                    `vote ${voteDuration}s); waiting ${wait}s`
            );
            await new Promise((r) => setTimeout(r, wait * 1000));
        } else if (wait > 0) {
            throw new Refusal(
                `timelock seq ${q.seq} matures at ${q.eta}; a confirming proposal may be proposed no earlier than ` +
                    `${earliest} (eta − noticeDuration ${noticeDuration}s − voteDuration ${voteDuration}s), ${wait}s ` +
                    `from now — proposed earlier its vote would close before the eta and confirm_venue would throw ` +
                    `808. Refusing to propose.`,
                'venueTimelock.getQueued().eta + treasury.getGov().{noticeDuration,voteDuration}'
            );
        }
    }
    const units = asset === 3 ? BigInt(amount) : toNano(amount);
    // One OPEN proposal per proposer (1157): read the handle's newest row's `closes`.
    const prior = await lastSeqOf(client, handle).catch((e) => {
        if (e instanceof Refusal) return null; // no proposal yet — nothing open
        throw e;
    });
    if (prior !== null) {
        const pr = await retry(() => treasuryOf(client).getProposal(prior), 'getProposal(prior)');
        const now = Math.floor(Date.now() / 1000);
        if (now < pr.closes) {
            throw new Refusal(
                `${handle}'s proposal #${prior} is still open for ${pr.closes - now}s — one open proposal per ` +
                    `proposer (1157). Refusing to propose.`,
                'treasury.getProposal(seq).closes'
            );
        }
    }
    console.log(`${handle} proposing ${amount} of asset ${asset} -> ${to.toString({ testOnly: true })}`);
    // D-147: a proposal carries ONE position's weight and cannot pool them, so the
    // heaviest LIVE term is the one to open on — the same choice the app makes.
    const positionId = await heaviestLiveTerm(position);
    console.log(`  on position #${positionId}`);
    // The seq this propose will take, read BEFORE it is sent: the contract
    // issues `proposalSeq` and then increments it.
    const newSeq = (await retry(() => treasuryOf(client).getGov(), 'getGov')).proposalSeq;
    await position.sendPropose(w.sender, {
        asset,
        amount: units,
        dest: to,
        positionId,
        value: toNano('0.25'),
    });
    console.log(
        `>>> proposal #${newSeq} opened. VOTE AND EXECUTE ON #${newSeq}, NOT on proposalSeq below: ` +
            `proposalSeq is a COUNT of proposals ever opened, so the new proposal is proposalSeq - 1.`
    );
    console.log(`>>> next:  lpGovernance.ts vote <handle> ${newSeq}   |   lpGovernance.ts execute <handle> ${newSeq}`);
    await new Promise((r) => setTimeout(r, 25_000));
    const gov = await retry(() => treasuryOf(client).getGov(), 'getGov-after');
    const p = await retry(() => treasuryOf(client).getProposal(newSeq), 'getProposal-after');
    // `opens − noticeDuration` is the block time the propose landed at — derived, the row
    // stores no "proposed at". Printed, not compared: this machine's clock is not the
    // block's, so no tolerance against it would be a fact about the chain.
    const proposedAt = p.opens - gov.noticeDuration;
    const results: A.AssertResult[] = [
        {
            ok: gov.proposalSeq === newSeq + 1 && p.opens !== 0 && p.closes === p.opens + gov.voteDuration,
            name: 'PROPOSAL_OPENED_AT_SEQ',
            getMethod: `treasury.getGov().{proposalSeq,noticeDuration,voteDuration} + treasury.getProposal(${newSeq})`,
            before: `seq to be issued ${newSeq}`,
            after:
                `proposalSeq ${gov.proposalSeq}, vote opens ${p.opens} closes ${p.closes} ` +
                `(notice ${gov.noticeDuration}s, window ${gov.voteDuration}s, proposed at ${proposedAt})`,
            detail:
                'the treasury issues `proposalSeq` and THEN increments, so the id this call took is ' +
                'the count read before it — the confusion that once cost a live `position_vote` on a ' +
                'proposal that did not exist. The vote opens `noticeDuration` after the propose (D-173 ' +
                'amendment, audit R2-H1) and runs `voteDuration` from there, both D-139-divided',
        },
        {
            // The child SENDS the proposal and the treasury authenticates it by
            // re-deriving the child's address from the owner it names — but the row
            // records that OWNER (`proposer: msg.owner`), because D-100 point 8's
            // one-open-proposal slot is keyed by the owner, not by the child. This
            // assert compared against the child until the 20260927 smoke read it back.
            ok: !!p.proposer && p.proposer.equals(w.wallet.address),
            name: 'PROPOSER_IS_THE_OWNER',
            getMethod: `treasury.getProposal(${newSeq}).proposer`,
            before: w.wallet.address.toString({ testOnly: true }),
            after: p.proposer?.toString({ testOnly: true }) ?? 'null',
            detail:
                'the proposal is sent BY THE POSITION CHILD, authenticated by RE-DERIVING its address ' +
                'from the owner it names, and recorded against that owner — which is what makes "only a ' +
                'custody position may propose" structural rather than a check on a claimed identity',
        },
        {
            ok: p.asset === asset && p.amount === units && !!p.dest && p.dest.equals(to),
            name: 'PROPOSAL_MATCHES_THE_ASK',
            getMethod: `treasury.getProposal(${newSeq}).{asset,amount,dest}`,
            before: `asset ${asset} amount ${units} dest ${to.toString({ testOnly: true })}`,
            after: `asset ${p.asset} amount ${p.amount} dest ${p.dest?.toString({ testOnly: true }) ?? 'null'}`,
            detail:
                'what was asked for is what is on the ballot — the row voters read and `execute` ' +
                'pays out of is the one the proposer signed, field for field (asset 0 GRAM / 1 PRIMES ' +
                '/ 2 tsTON)',
        },
    ];
    record({ phase: '5', op: 'lp-propose', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    await status(client);
    A.requireAll(results);
}

/**
 * D-147: a vote is cast PER POSITION, so a wallet holding three live terms casts
 * three votes. This sends one per live term rather than picking one, because the
 * point of the script is to exercise what the contract actually does — and a
 * wallet whose weight is split across terms is the case a single-message helper
 * would quietly under-report.
 */
async function vote(client: TonClient, handle: string, seq: number, support: boolean) {
    const prop = await requireProposal(client, seq, 'vote');
    // THE BLOCK'S CLOCK DECIDES, AND THE CHAIN IS ASKED (1206, 1154). `getVotable(seq)`
    // compares `opens`/`closes` against `blockchain.now()` on the node, so this never
    // sets this machine's clock against the row's. D-173 amendment (audit R2-H1): until
    // `opens` the proposal is in its NOTICE and a vote is refused 1206 — a bounce that
    // costs gas and tallies nothing — so it is waited out by POLLING the get-method. The
    // local clock is used for one thing only: to refuse a wait that is obviously
    // mainnet-length instead of hanging a run, and to bound the poll.
    const treasuryNow = treasuryOf(client);
    let can = await retry(() => treasuryNow.getVotable(seq), 'getVotable');
    if (!can.votable && can.reason === ERRORS.treasury_vote_not_open) {
        const roughly = prop.opens - Math.floor(Date.now() / 1000);
        if (roughly > MAX_VOTE_WAIT_S) {
            throw new Refusal(
                `proposal #${seq} is in its notice: its vote opens at ${prop.opens}, about ${roughly}s from now — ` +
                    `a vote before that is refused 1206. Refusing to send.`,
                'treasury.getVotable(seq) + treasury.getProposal(seq).opens'
            );
        }
        console.log(`proposal #${seq} is in its notice (vote opens at ${prop.opens}); polling getVotable until the chain says it is open`);
        const giveUp = Date.now() + (MAX_VOTE_WAIT_S + 120) * 1000;
        while (!can.votable && can.reason === ERRORS.treasury_vote_not_open && Date.now() < giveUp) {
            await new Promise((r) => setTimeout(r, 10_000));
            can = await retry(() => treasuryNow.getVotable(seq), 'getVotable(poll)');
        }
    }
    if (!can.votable) {
        throw new Refusal(
            `proposal #${seq} is not votable right now: the treasury would throw ${can.reason} ` +
                `(1206 still in its notice, 1154 closed at ${prop.closes}). Refusing to send.`,
            'treasury.getVotable(seq)'
        );
    }
    const w = await walletFor(client, handle);
    const position = await positionOf(client, w);
    // CONCEPT §5.5.5: the treasury refuses a position whose weight appeared at or
    // after the proposal's VOTE opened (1202; LP locked during the notice votes NO only) — read `weightSince` and skip it rather than send.
    // D-188 point 7: the CHILD refuses a position that already voted (1155) — read its
    // own record and skip it too.
    // D-173 as amended 2026-11-21: a YES also needs the weight held since the proposal's
    // own second, `opens − noticeDuration` (1202 too). A NO keeps the whole notice.
    const { noticeDuration } = await retry(() => treasuryOf(client).getGov(), 'getGov(notice)');
    const yesCutoff = prop.opens - noticeDuration;
    const ids: number[] = [];
    for (const id of await liveTerms(position)) {
        const row = await retry(() => position.getPosition(id), `getPosition(${id})`);
        if (row.weightSince >= prop.opens) {
            console.log(`position #${id} took its weight after #${seq} opened — it cannot vote on it`);
        } else if (support && row.weightSince > yesCutoff) {
            console.log(`position #${id} took its weight after #${seq} was proposed — it may vote NO, not YES`);
        } else if (await retry(() => position.getHasVoted(seq, id), `getHasVoted(${seq}, ${id})`)) {
            console.log(`position #${id} already voted on #${seq}`);
        } else {
            ids.push(id);
        }
    }
    if (ids.length === 0) {
        throw new Refusal(
            `${handle} holds no live term locked before #${seq} opened that has not already voted — ` +
                `nothing to vote with. D-147 retires a vote at MATURITY, §5.5.5 refuses LP locked after ` +
                `the proposal opened, and D-188 point 7 refuses a second vote per position.`,
            'positionChild.getPosition(id).{maturesAt,weightSince} + getHasVoted(seq, id) vs treasury.getProposal(seq).opens'
        );
    }
    const before = await retry(() => treasuryOf(client).getProposal(seq), 'getProposal-before');
    let cast = 0n;
    for (const positionId of ids) {
        console.log(`${handle} voting ${support ? 'YES' : 'NO'} on #${seq} with position #${positionId}`);
        const row = await retry(() => position.getPosition(positionId), `getPosition(${positionId})`);
        cast += voteWeight(row.amount, row.tier);
        await position.sendVote(w.sender, { seq, support, positionId, value: toNano('0.2') });
        if (ids.length > 1) await new Promise((r) => setTimeout(r, 20_000));
    }
    await new Promise((r) => setTimeout(r, 25_000));
    await proposal(client, seq);
    const after = await retry(() => treasuryOf(client).getProposal(seq), 'getProposal-after');
    const counted: bigint[] = [];
    for (const positionId of ids) {
        counted.push(
            (await retry(() => position.getHasVoted(seq, positionId), 'getHasVoted'))
                ? 1n
                : 0n
        );
    }
    const results: A.AssertResult[] = [
        {
            ok: support
                ? after.yes === before.yes + cast && after.no === before.no
                : after.no === before.no + cast && after.yes === before.yes,
            name: 'VOTE_WEIGHT_COUNTED',
            getMethod: `treasury.getProposal(${seq}).{yes,no} vs Σ amount × vote_multipliers[tier]`,
            before: `yes ${before.yes} no ${before.no}`,
            after: `yes ${after.yes} no ${after.no} (cast ${cast} on ${ids.length} position(s))`,
            detail:
                'the tally moved by exactly the D-147 vote ladder applied to the positions that ' +
                'voted, and only on the side that was voted. A vote is cast PER POSITION, so a ' +
                'wallet holding three live terms casts three — which is why this sums the rows ' +
                'rather than reading one',
        },
        {
            ok: counted.every((c) => c === 1n),
            name: 'DOUBLE_VOTE_CLOSED',
            getMethod: `positionChild.getHasVoted(${seq}, positionId)`,
            after: ids.map((id, i) => `#${id} ${counted[i] === 1n}`).join(' · '),
            detail:
                "the voter's own child records the (proposal, position) pair (D-188 point 7 — the " +
                'treasury keeps only totals), which is what makes a second vote from the same position ' +
                'a refusal rather than a second tally entry — the weight is per position, not per message',
        },
    ];
    record({ phase: '5', op: 'lp-vote', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * The positions whose term is still running AND whose tier carries a vote — the
 * exact set `position_vote` will accept, computed from `maturesAt` rather than
 * from `getVoteWeight()`, which D-147 leaves as an upper bound until `expire`.
 */
async function liveTerms(position: ReturnType<TonClient['open']>): Promise<number[]> {
    const p = position as unknown as PrimesLpPosition & {
        getPositions(): Promise<{ nextId: number }>;
        getPosition(id: number): Promise<{ amount: bigint; tier: number; maturesAt: number }>;
    };
    const now = Math.floor(Date.now() / 1000);
    const ps = await retry(() => p.getPositions(), 'getPositions');
    const out: number[] = [];
    for (let id = 0; id < ps.nextId; id++) {
        const row = await retry(() => p.getPosition(id), `getPosition(${id})`);
        if (row.amount === 0n) continue;
        if (row.maturesAt <= now) continue;
        if ((VOTE_MULTS[row.tier] ?? 0) === 0) continue;
        out.push(id);
    }
    return out;
}

async function heaviestLiveTerm(position: ReturnType<TonClient['open']>): Promise<number> {
    const p = position as unknown as PrimesLpPosition & {
        getPosition(id: number): Promise<{ amount: bigint; tier: number }>;
    };
    const ids = await liveTerms(position);
    if (ids.length === 0) {
        throw new Refusal(
            'no live voting term — deposit at 30 d or longer first. Below tier 3 a position mines ' +
                'and does not vote (D-147), so there is nothing to open a proposal on.',
            'positionChild.getPosition(id).{tier,maturesAt}'
        );
    }
    let best = ids[0];
    let bestW = -1n;
    for (const id of ids) {
        const row = await retry(() => p.getPosition(id), `getPosition(${id})`);
        const w = voteWeight(row.amount, row.tier);
        if (w > bestW) {
            bestW = w;
            best = id;
        }
    }
    return best;
}

/**
 * Permissionless — anybody may push a passed proposal through once its window
 * closes. `getExecutable` answers, without provoking the throw, whether this
 * call would succeed, so the READ DECIDES AND THE MESSAGE IS NOT SENT
 * (TESTNET_MASTER_PLAN §2.5 rule 1). Reading it afterwards, which is what this
 * did, buys a red transaction to learn a fact the node would have given away
 * for free — `reason 1158` while the vote window was still open.
 */
/** The longest `execute` will wait for a vote window to close: D-139's ~514 s, with room. */
const MAX_VOTE_WAIT_S = 1200;

async function execute(client: TonClient, handle: string, seq: number) {
    const p = await requireProposal(client, seq, 'execute');
    const treasury = treasuryOf(client);
    let ex = await retry(() => treasury.getExecutable(seq), 'getExecutable');
    // THE VOTE WINDOW IS WAITED OUT HERE, NOT GUESSED IN `run.ts`. At D-139's divisor
    // it is ~514 s, and the execute window after it is one more vote duration
    // (D-188 point 7) — so "run the execute in a later phase" can LAPSE (1204), and
    // "run it right after the vote" is 1158. The row's own `closes` is the clock;
    // bounded so a mainnet-length day refuses instead of hanging a run.
    if (!ex.executable && ex.reason === ERRORS.treasury_not_closed) {
        const wait = p.closes - Math.floor(Date.now() / 1000) + 15;
        if (wait > 0 && wait <= MAX_VOTE_WAIT_S) {
            console.log(`proposal #${seq}'s vote closes at ${p.closes}; waiting ${wait}s (read off the row)`);
            await new Promise((r) => setTimeout(r, wait * 1000));
            ex = await retry(() => treasury.getExecutable(seq), 'getExecutable(after wait)');
        }
    }
    if (!ex.executable) {
        const now = Math.floor(Date.now() / 1000);
        const detail =
            ex.reason === ERRORS.treasury_not_closed
                ? ` — its vote window closes in ${p.closes - now}s`
                : ex.reason === ERRORS.treasury_vote_failed
                  ? ` — yes ${p.yes} vs no ${p.no}; a tie fails`
                  : ex.reason === ERRORS.treasury_cap_exceeded
                    ? ` — amount ${p.amount} over the cap ${ex.cap} (of ${ex.available} available)`
                    : ex.reason === ERRORS.treasury_insufficient_asset
                      ? ` — amount ${p.amount} over the ${ex.available} the treasury holds`
                      : ex.reason === ERRORS.treasury_execute_lapsed
                        ? ` — its execute window closed ${now - (p.closes + (p.closes - p.opens))}s ago (D-188 point 7)`
                        : '';
        throw new Refusal(
            `proposal #${seq} is not executable: ${ex.reason} ${errName(ex.reason)}${detail}. Refusing to send.`,
            'treasury.getExecutable(seq)'
        );
    }
    // D-194: a venue confirm the timelock would refuse (806) bounces; decide on its row first.
    if (p.asset === 3) {
        const q = await retry(
            () => client.open(PrimesVenueTimelock.createFromAddress(p.dest!)).getQueued(),
            'timelock.getQueued'
        );
        if (q.hasQueued !== 1 || q.fired !== 0 || q.seq !== Number(p.amount)) {
            throw new Refusal(
                `proposal #${seq} confirms timelock seq ${p.amount}, but the timelock's record is seq ${q.seq} ` +
                    `(hasQueued ${q.hasQueued}, fired ${q.fired}) — confirm_venue would throw 806. Refusing to send.`,
                'venueTimelock.getQueued()'
            );
        }
        if (p.opens < q.queuedAt) {
            throw new Refusal(
                `proposal #${seq} opened at ${p.opens}, before timelock seq ${q.seq} was queued at ${q.queuedAt} ` +
                    `— confirm_venue would throw 807. Refusing to send.`,
                'venueTimelock.getQueued()'
            );
        }
        if (p.closes < q.eta) {
            throw new Refusal(
                `proposal #${seq} closed at ${p.closes}, before timelock seq ${q.seq}'s eta ${q.eta} — it opened ` +
                    `before holders had the whole notice (audit H1), so confirm_venue would throw 808. ` +
                    `Propose a new venue-confirm proposal from eta − noticeDuration − voteDuration. Refusing to send.`,
                'venueTimelock.getQueued().eta'
            );
        }
    }
    const w = await walletFor(client, handle);
    console.log(`${handle} executing #${seq}`);
    const before = await retry(() => treasury.getTreasuryBalances(), 'getTreasuryBalances-before');
    const execValue = toNano('0.3');
    await treasury.sendExecute(w.sender, { seq, value: execValue });
    await new Promise((r) => setTimeout(r, 30_000));
    await proposal(client, seq);
    const row = await retry(() => treasury.getProposal(seq), 'getProposal-after');
    const exAfter = await retry(() => treasury.getExecutable(seq), 'getExecutable-after');
    const after = await retry(() => treasury.getTreasuryBalances(), 'getTreasuryBalances-after');
    // ASSET 0 GRAM / 1 PRIMES / 2 tsTON, onto the balance each one is paid from.
    const held = (b: typeof before) =>
        p.asset === 0 ? b.tonBalance : p.asset === 1 ? b.primesBalance : b.tstonBalance;
    const executedOnce: A.AssertResult = {
        ok: row.executed === 1 && !exAfter.executable,
        name: 'PROPOSAL_EXECUTED_ONCE',
        getMethod: `treasury.getProposal(${seq}).executed + getExecutable(${seq})`,
        before: `executable ${ex.executable} reason ${ex.reason} ${errName(ex.reason)}`,
        after: `executed ${row.executed}, executable ${exAfter.executable} reason ${exAfter.reason} ${errName(exAfter.reason)}`,
        detail:
            'the row is marked spent and the same read that authorised this send now refuses the ' +
            'next one — `getExecutable` answers WITHOUT provoking the throw, so a replay is ' +
            'declined from a get-method instead of bought with a red transaction (§2.5 rule 1)',
    };
    // D-194: a venue confirm moves no value; its effect is the timelock record's `confirmed`.
    if (p.asset === 3) {
        const q = await retry(
            () => client.open(PrimesVenueTimelock.createFromAddress(p.dest!)).getQueued(),
            'timelock.getQueued-after'
        );
        const results: A.AssertResult[] = [
            executedOnce,
            {
                ok: q.seq === Number(p.amount) && q.confirmed === 1,
                name: 'VENUE_CONFIRMED',
                getMethod: 'venueTimelock.getQueued().{seq,confirmed}',
                before: `seq ${p.amount}`,
                after: `seq ${q.seq} confirmed ${q.confirmed}`,
                detail: 'D-194: the passed vote confirmed exactly the record it named',
            },
        ];
        record({ phase: '7', op: 'lp-venue-confirm', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
        A.requireAll(results);
        return;
    }
    const results: A.AssertResult[] = [
        executedOnce,
        {
            // Asset 0 is paid from the same GRAM balance the execute message lands in, and
            // the treasury keeps what the caller attached beyond the payout's gas, so the
            // bound for GRAM is net of `execValue` (the 20260927 smoke: -0.1 paid, +0.3 in).
            ok: held(after) <= held(before) - p.amount + (p.asset === 0 ? execValue : 0n),
            name: 'TREASURY_PAID_THE_AMOUNT',
            getMethod: `treasury.getTreasuryBalances() — asset ${p.asset}`,
            before: held(before).toString(),
            after: held(after).toString(),
            detail:
                `the balance the proposal names fell by at least its ${p.amount}. "At least" because ` +
                'asset 0 is the contract\'s own GRAM and also pays the gas of the message that moves ' +
                'it; an execution that marked the row and moved nothing is the failure this catches',
        },
    ];
    record({ phase: '5', op: 'lp-execute', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * THE EXIT PATH — `withdraw`, `to_sink`, and D-147’s `relock` / `expire`.
 *
 * Every one of these is on the position child and in `LpCustody.spec.ts`. D-168
 * deleted `claim`: custody earns no PRIMES. `withdraw`
 * takes the LP back once `maturesAt` has passed, in one message with no request
 * behind it. `relock` restarts the term under a new tier (never a shorter one
 * while the current term runs). `expire` is the permissionless poke that retires
 * a matured term's vote weight from the two published aggregates. `to_sink`
 * forwards the LP to the sink instead, locked forever.
 */
async function positionStatus(client: TonClient, handle: string) {
    const w = await walletFor(client, handle);
    const position = await positionOf(client, w);
    const ps = await retry(() => position.getPositions(), 'getPositions');
    console.log(`${handle} position child ${position.address.toString({ testOnly: true })}`);
    console.log('positions', ps);
    console.log('voteWeight', (await retry(() => position.getVoteWeight(), 'getVoteWeight')).toString());
    const now = Math.floor(Date.now() / 1000);
    for (let id = 0; id < ps.nextId; id++) {
        const p = await retry(() => position.getPosition(id), `getPosition(${id})`);
        if (p.amount === 0n) continue;
        console.log(
            `  #${id} amount ${p.amount} tier ${p.tier} inFlight ${p.inFlight} ` +
                `expired ${p.expired} maturesAt ${p.maturesAt}` +
                (p.maturesAt > now
                    ? ` (${p.maturesAt - now}s away)`
                    : ` (matured ${now - p.maturesAt}s ago — not voting)`)
        );
    }
    return { w, position, ps };
}

/** The `position` command proper — `positionStatus` is also the five arms' own read. */
async function positionReport(client: TonClient, handle: string) {
    const { position } = await positionStatus(client, handle);
    const results = ladderAsserts(await weights(position));
    record({ phase: '5', op: 'lp-position', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** D-147: restart the term under a new tier. Refused as a downgrade while it runs. */
async function relock(client: TonClient, handle: string, positionId: number, tier: number) {
    const { w, position, ps } = await positionStatus(client, handle);
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) throw new Error('tier must be 0..3');
    const row = await retry(() => position.getPosition(positionId), 'getPosition');
    requirePosition(ps, positionId, row, 'relock');
    // `position_relock_downgrade` 1167: before maturity the tier may only go UP.
    const now = Math.floor(Date.now() / 1000);
    if (tier < row.tier && now < row.maturesAt) {
        throw new Refusal(
            `position #${positionId} is tier ${row.tier} with ${row.maturesAt - now}s of its term left, so ` +
                `tier ${tier} is a DOWNGRADE (1167 position_relock_downgrade) — only tier ${row.tier} or ` +
                `higher is accepted until it matures. Refusing to relock.`,
            'positionChild.getPosition(id).{tier,maturesAt}'
        );
    }
    console.log(`${handle} relocking #${positionId} to tier ${tier} — restarts the term at now`);
    const terms = await retry(() => position.getTierTerms(), 'getTierTerms');
    await position.sendRelock(w.sender, { positionId, tier, value: toNano('0.35') });
    await new Promise((r) => setTimeout(r, 30_000));
    await positionStatus(client, handle);
    const after = await retry(() => position.getPosition(positionId), 'getPosition-after');
    const results: A.AssertResult[] = [
        {
            ok: after.tier === tier && after.maturesAt === after.lockedAt + terms[tier],
            name: 'RELOCK_RESTARTS_THE_TERM',
            getMethod: `positionChild.getPosition(${positionId}) vs getTierTerms()[${tier}]`,
            before: `tier ${row.tier} lockedAt ${row.lockedAt} maturesAt ${row.maturesAt}`,
            after: `tier ${after.tier} lockedAt ${after.lockedAt} maturesAt ${after.maturesAt}`,
            detail:
                `the new term is the tier's own LOCK TERM (${terms[tier]}s, already divided by ` +
                "D-139's clock on this contract) measured from the relock, not a withdrawal delay " +
                'and not an extension of what was left — D-147 restarts the clock',
        },
        {
            ok: after.amount === row.amount,
            name: 'RELOCK_MOVES_NO_LP',
            getMethod: `positionChild.getPosition(${positionId}).amount`,
            before: row.amount.toString(),
            after: after.amount.toString(),
            detail:
                'a relock is a change of TERM and nothing else: the LP never leaves custody, so the ' +
                'amount is untouched and only the two weights it feeds may move',
        },
        ...ladderAsserts(await weights(position)),
    ];
    record({ phase: '5', op: 'lp-relock', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * D-147's permissionless `expire`. Deliberately sent from a DIFFERENT handle than
 * the position's owner where one is given, because "anyone may send it" is the
 * property worth demonstrating at a live node and the contract takes no sender.
 */
async function expire(client: TonClient, ownerHandle: string, positionId: number, fromHandle?: string) {
    const { w: owner, position, ps } = await positionStatus(client, ownerHandle);
    // EVERY GUARD HERE IS ABOUT THE POSITION'S STATE, never about who is sending
    // — the point of this arm is that anybody may send it.
    const row = await retry(() => position.getPosition(positionId), 'getPosition');
    requirePosition(ps, positionId, row, 'expire');
    if (row.expired) {
        throw new Refusal(
            `position #${positionId} is already expired — its vote weight is already out of both ` +
                `published aggregates and the contract would accept this message and do nothing. ` +
                `Refusing to expire.`,
            'positionChild.getPosition(id).expired'
        );
    }
    requireMatured(positionId, row, 'expire');
    const sender = await walletFor(client, fromHandle ?? ownerHandle);
    console.log(
        `${fromHandle ?? ownerHandle} retiring ${ownerHandle}'s #${positionId} — vote weight only, moves nothing`
    );
    const before = await weights(position);
    const beforeGov = await retry(() => treasuryOf(client).getGov(), 'getGov-before');
    const retired = voteWeight(row.amount, row.tier);
    await position.sendExpire(sender.sender, { positionId, value: toNano('0.3') });
    await new Promise((r) => setTimeout(r, 25_000));
    await positionStatus(client, ownerHandle);
    const after = await weights(position);
    const afterGov = await retry(() => treasuryOf(client).getGov(), 'getGov-after');
    const afterRow = await retry(() => position.getPosition(positionId), 'getPosition-after');
    const results: A.AssertResult[] = [
        {
            ok: afterRow.expired === 1 && after.read === before.read - retired,
            name: 'VOTE_WEIGHT_RETIRED',
            getMethod: `positionChild.getVoteWeight() + getPosition(${positionId}).expired`,
            before: before.read.toString(),
            after: `${after.read} (expired ${afterRow.expired})`,
            detail:
                `exactly ${retired} came out — the position's amount times ` +
                `\`vote_multipliers[${row.tier}]\` and not a nanounit more. This is the arm that ` +
                'makes `getVoteWeight()` exact again after maturity had already made it an upper bound',
        },
        {
            ok: afterGov.eligibleWeight === beforeGov.eligibleWeight - retired,
            name: 'ELECTORATE_SHRANK_BY_THE_SAME',
            getMethod: 'treasury.getGov().eligibleWeight',
            before: beforeGov.eligibleWeight.toString(),
            after: afterGov.eligibleWeight.toString(),
            detail:
                'the treasury\'s published electorate and the child\'s own aggregate move together ' +
                'or the `propose_min_bps` floor is measured against a denominator nobody holds — ' +
                'which is what a stale `eligibleWeight` is',
        },
        {
            ok: afterRow.expired === 1 && !sender.wallet.address.equals(owner.wallet.address),
            name: 'EXPIRE_ACCEPTED_FROM_A_STRANGER',
            getMethod: `positionChild.getPosition(${positionId}).expired + the sending address`,
            after: `sent by ${fromHandle ?? ownerHandle} (${sender.wallet.address.toString({ testOnly: true })})`,
            detail:
                'the one arm on either treasury contract with no sender check at all, and the ' +
                'permissionless poke is what stops a matured vote lingering in the aggregates ' +
                'because its owner declines to retire it. It FAILS when the owner sends it — not ' +
                'because the contract refused, but because that run demonstrates nothing',
        },
    ];
    record({ phase: '5', op: 'lp-expire', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    await status(client);
    A.requireAll(results);
}

async function withdraw(client: TonClient, handle: string, positionId: number) {
    const { w, position, ps } = await positionStatus(client, handle);
    const p = await retry(() => position.getPosition(positionId), 'getPosition');
    requirePosition(ps, positionId, p, 'withdraw');
    requireMatured(positionId, p, 'withdraw');
    const myLp = await walletAddressOn(client, Address.parse(env('PRIMES_DEDUST_POOL_ADDR')), w.wallet.address);
    const beforeLp = await jettonBalance(client, myLp);
    const beforeBal = await retry(() => treasuryOf(client).getTreasuryBalances(), 'getTreasuryBalances-before');
    await position.sendWithdraw(w.sender, { positionId, value: toNano('0.35') });
    await new Promise((r) => setTimeout(r, 30_000));
    const { ps: psAfter } = await positionStatus(client, handle);
    const after = await retry(() => position.getPosition(positionId), 'getPosition-after');
    const afterLp = await jettonBalance(client, myLp);
    const afterBal = await retry(() => treasuryOf(client).getTreasuryBalances(), 'getTreasuryBalances-after');
    const results: A.AssertResult[] = [
        {
            ok: after.amount === 0n && psAfter.positionCount === ps.positionCount - 1,
            name: 'POSITION_RETIRED',
            getMethod: `positionChild.getPosition(${positionId}).amount + getPositions().positionCount`,
            before: `amount ${p.amount} live ${ps.positionCount}`,
            after: `amount ${after.amount} live ${psAfter.positionCount}`,
            detail:
                'the row is emptied and the live count falls by one; the ID stays below `nextId` for ' +
                'ever, which is why `id < nextId` is never a test of existence (see `idLine`)',
        },
        {
            ok: afterLp === beforeLp + p.amount && afterBal.lpHeld === beforeBal.lpHeld - p.amount,
            name: 'LP_CAME_BACK_OUT',
            getMethod: "treasury.getTreasuryBalances().lpHeld + the depositor's own LP jetton wallet",
            before: `lpHeld ${beforeBal.lpHeld}, depositor ${beforeLp}`,
            after: `lpHeld ${afterBal.lpHeld}, depositor ${afterLp}`,
            detail:
                `the same ${p.amount} LP units left custody and arrived in the depositor's wallet, in ` +
                'one message with no request behind it. LP had gone INTO this treasury on every ' +
                'testnet set and no route back out had ever been demonstrated — the worst shape a ' +
                'governed pot can have on an audit',
        },
    ];
    record({ phase: '5', op: 'lp-withdraw', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    await status(client);
    A.requireAll(results);
}

/** The one-way door: LP to the sink, locked depth, no maturity gate and no way back. */
async function toSink(client: TonClient, handle: string, positionId: number) {
    const { w, position, ps } = await positionStatus(client, handle);
    const row = await retry(() => position.getPosition(positionId), 'getPosition');
    // NO MATURITY GATE (D-100 point 4): giving up LP for ever is not what the
    // term exists to slow down, so existence and `inFlight` are the whole guard.
    requirePosition(ps, positionId, row, 'send to the sink');
    console.log(`${handle} forwarding #${positionId} to the LP SINK — this is irreversible`);
    const beforeBal = await retry(() => treasuryOf(client).getTreasuryBalances(), 'getTreasuryBalances-before');
    await position.sendToSink(w.sender, { positionId, value: toNano('0.35') });
    await new Promise((r) => setTimeout(r, 30_000));
    await positionStatus(client, handle);
    const after = await retry(() => position.getPosition(positionId), 'getPosition-after');
    const afterBal = await retry(() => treasuryOf(client).getTreasuryBalances(), 'getTreasuryBalances-after');
    const results: A.AssertResult[] = [
        {
            ok: after.amount === 0n && afterBal.lpHeld === beforeBal.lpHeld - row.amount,
            name: 'LP_LEFT_CUSTODY_FOR_THE_SINK',
            getMethod: `positionChild.getPosition(${positionId}).amount + treasury.getTreasuryBalances().lpHeld`,
            before: `amount ${row.amount} lpHeld ${beforeBal.lpHeld}`,
            after: `amount ${after.amount} lpHeld ${afterBal.lpHeld}`,
            detail:
                'the one-way door: the position closes and the depositors\' pot falls by exactly its ' +
                'amount. There is no maturity gate on this arm (D-100 point 4) — giving up LP for ' +
                'ever is not what the term exists to slow down',
        },
    ];
    record({ phase: '5', op: 'lp-to-sink', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    await status(client);
    A.requireAll(results);
}

async function proposal(client: TonClient, seq: number) {
    const treasury = treasuryOf(client);
    const p = await retry(() => treasury.getProposal(seq), 'getProposal');
    const now = Math.floor(Date.now() / 1000);
    console.log(`proposal #${seq}`, p);
    if (p.opens) {
        console.log(`  closes in ${p.closes - now}s`);
    } else {
        const gov = await retry(() => treasury.getGov(), 'getGov');
        console.log(`  EMPTY ROW — proposal #${seq} does not exist; ${seqLine(gov.proposalSeq)}`);
    }
    const ex = await retry(() => treasury.getExecutable(seq), 'getExecutable');
    console.log('executable', { ...ex, reason: `${ex.reason} ${errName(ex.reason)}` });
}

async function main() {
    const client = makeClient();
    const [cmd, a, b, c, d] = process.argv.slice(2);
    if (!cmd || cmd === 'status') return status(client);
    if (cmd === 'deposit') {
        if (!a || !b) throw new Error('usage: lpGovernance.ts deposit <handle> <GRAM> <tier>');
        return deposit(client, a, b, Number(c ?? 0));
    }
    if (cmd === 'propose') {
        if (!a || !b || !c || !d) {
            throw new Error(
                'usage: lpGovernance.ts propose <handle> <asset 0|1|2|3> <amount | seq | queued> <dest | handle | timelock>'
            );
        }
        return propose(client, a, Number(b), c, d);
    }
    if (cmd === 'vote') {
        if (!a || !b) throw new Error('usage: lpGovernance.ts vote <handle> <seq | last> [no]');
        return vote(client, a, await seqArg(client, a, b), c !== 'no');
    }
    if (cmd === 'execute') {
        if (!a || !b) throw new Error('usage: lpGovernance.ts execute <handle> <seq | last>');
        return execute(client, a, await seqArg(client, a, b));
    }
    if (cmd === 'proposal') {
        if (!a) throw new Error('usage: lpGovernance.ts proposal <seq>');
        return proposal(client, Number(a));
    }
    if (cmd === 'position') {
        if (!a) throw new Error('usage: lpGovernance.ts position <handle>');
        return positionReport(client, a);
    }
    if (cmd === 'relock') {
        if (!a) throw new Error('usage: lpGovernance.ts relock <handle> <positionId> <tier>');
        return relock(client, a, Number(b ?? 0), Number(process.argv[5] ?? 0));
    }
    if (cmd === 'expire') {
        if (!a) throw new Error('usage: lpGovernance.ts expire <ownerHandle> <positionId> [fromHandle]');
        return expire(client, a, Number(b ?? 0), process.argv[5]);
    }
    if (cmd === 'withdraw' || cmd === 'to-sink') {
        if (!a) throw new Error(`usage: lpGovernance.ts ${cmd} <handle> [positionId]`);
        const id = Number(b ?? 0);
        if (cmd === 'withdraw') return withdraw(client, a, id);
        return toSink(client, a, id);
    }
    throw new Error(
        `unknown command "${cmd}" — one of: deposit, status, position, propose, vote, execute, ` +
            `proposal, relock, expire, withdraw, to-sink`
    );
}

if (require.main === module) {
    const cmd = process.argv[2] ?? 'status';
    main().catch((e) => {
        // A REFUSAL IS EVIDENCE, NOT A GAP. Every guard above answered from a
        // get-method and declined to send; §2.5 rule 1 prefers that to a fired
        // refusal, but a run record that omits it reads as though the arm was
        // never reached. Journalled `ok: true` — the prediction was correct —
        // and still exit 1, so the step is visibly not the thing it set out to do.
        if (e instanceof Refusal) {
            const refusal: A.AssertResult[] = [
                {
                    ok: true,
                    name: 'REFUSED_BEFORE_SENDING',
                    getMethod: e.getMethod,
                    detail: e.message,
                },
            ];
            A.print(refusal);
            record({ phase: '5', op: `lp-${cmd}-refused`, ok: true, asserts: fromAsserts(refusal) });
        }
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
