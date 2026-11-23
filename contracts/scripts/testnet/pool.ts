/**
 * TON PRIMES — THE SWAP LEVER. Move the DeDust pool's price across `p_f` so both
 * branches of `flush()` can be driven on purpose.
 *
 * WHY THIS EXISTS. `flush()` is the only swap the protocol performs, and §4.3.1's
 * floor guard means it fills ONLY at or below `p_f = T/S`. At a fresh genesis the
 * pool opens ~287x ABOVE `p_f` — `S` carries the 12,000,000-PRIMES bounty vault
 * against a single 4.2 GRAM donation — so the first flush REFUSES, by design and
 * as the sim measured. Testing the FILL branch therefore means making the pool
 * genuinely cheap first, and the honest way to do that is to trade into it: one
 * early mint's rebate is ~1.9M PRIMES against the pool's 42,000, so selling a
 * mint's worth of PRIMES crushes the price well below the floor.
 *
 *   npx tsx contracts/scripts/testnet/pool.ts report
 *   npx tsx contracts/scripts/testnet/pool.ts sell <handle|K> <PRIMES>   # price DOWN
 *   npx tsx contracts/scripts/testnet/pool.ts buy  <handle|K> <GRAM>      # price UP
 *
 * `report` is the one to read before and after everything: it prints the pool's
 * reserves, the price they imply, `p_f`, the ratio between them, and — the line
 * that actually predicts the next `flush()` — the HEADROOM `P*p_f - X - amount`.
 * The ratio alone does not predict anything; see `report`'s own note.
 *
 * The swap wire format is DeDust v2's own, field for field, and is the same one
 * `primes_ratchet.tolk` builds for the native leg (its comment carries the TL-B).
 * Taking the jetton leg from the same schema is deliberate: if DeDust ever moves
 * it, this script and the contract fail together and loudly, rather than this
 * script silently testing a format the contract does not use.
 */
import { Address, beginCell, Cell, fromNano, toNano } from '@ton/core';
import { TonClient } from '@ton/ton';
import { PrimesLedger } from '../../wrappers/PrimesLedger';
import { PrimesRatchet } from '../../wrappers/PrimesRatchet';
import params from '../../../shared/params.json';
import { DEDUST_NATIVE_VAULT_TESTNET, jettonAsset, jettonTransferBody } from '../dedust';
import { loadEnvFile, envValue } from '../envFile';
import { makeClient, openDeployWallet, openWallet, retry, Wallet } from './sender';
import { readCast } from './cast';
import * as A from './assert';
import { fromAsserts, record } from './journal';

/** DeDust v2. `swap` on a NATIVE vault; `swap` inside a jetton transfer's forward payload. */
const SWAP_NATIVE_OP = 0xea06185d;
const SWAP_JETTON_FORWARD_OP = 0xe3a0d482;
/** Long enough that a slow testnet hop does not expire the swap, short enough to be a real deadline. */
const DEADLINE_WINDOW = 600;

function env(name: string): string {
    const v = envValue(loadEnvFile(), name);
    if (!v) throw new Error(`${name} missing from /.env`);
    return v;
}

/**
 * `swap_params#_ deadline:Timestamp recipient_addr:MsgAddressInt referral_addr:MsgAddress
 *                fulfill_payload:(Maybe ^Cell) reject_payload:(Maybe ^Cell)`
 */
function swapParams(recipient: Address): Cell {
    return beginCell()
        .storeUint(Math.floor(Date.now() / 1000) + DEADLINE_WINDOW, 32)
        .storeAddress(recipient)
        .storeUint(0, 2) // referral_addr = addr_none
        .storeUint(0, 1) // fulfill_payload = none
        .storeUint(0, 1) // reject_payload = none
        .endCell();
}

/** The pool's two reserves, GRAM first. `get_reserves` returns them in asset order. */
async function reserves(client: TonClient, pool: Address): Promise<{ ton: bigint; primes: bigint }> {
    const r = await retry(() => client.runMethod(pool, 'get_reserves', []), 'get_reserves');
    return { ton: r.stack.readBigNumber(), primes: r.stack.readBigNumber() };
}

/**
 * THE PAIR OF QUANTITIES EVERY ASSERT HERE IS TAKEN OVER — the pool's two
 * reserves and the ledger's `(T, S)` — read together and returned as a VALUE so
 * a before and an after can be diffed (`chain.ts`'s `snapshot()` shape).
 */
type PoolFloor = { ton: bigint; primes: bigint; T: bigint; S: bigint };

async function poolFloor(client: TonClient): Promise<PoolFloor> {
    const pool = Address.parse(env('PRIMES_DEDUST_POOL_ADDR'));
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(env('PRIMES_LEDGER_ADDRESS'))));
    const { ton, primes } = await reserves(client, pool);
    return {
        ton,
        primes,
        T: await retry(() => ledger.getFloorNum(), 'getFloorNum'),
        S: await retry(() => ledger.getFloorDen(), 'getFloorDen'),
    };
}

/**
 * A swap settles over several hops, so the read-back POLLS for the reserves to
 * move rather than reading once immediately after the send and reporting the
 * before state as the after. Reserves that never move inside the budget is a
 * finding: the lever did not pull, and every flush step sequenced behind it is
 * measuring the wrong pool.
 */
async function settled(client: TonClient, before: PoolFloor, budgetMs = 180_000): Promise<PoolFloor> {
    const deadline = Date.now() + budgetMs;
    let s = await poolFloor(client);
    while (Date.now() < deadline && s.ton === before.ton && s.primes === before.primes) {
        await new Promise((r) => setTimeout(r, 10_000));
        s = await poolFloor(client);
    }
    return s;
}

/**
 * §5: `p_f = T/S` moves on a MINT and on a `flush()` and on nothing else. A trade
 * against the DeDust pool is not a protocol event at all — the protocol is not a
 * party to it — so a swap that moved either term would be a leak between the
 * market and the ratchet, in the one direction the floor guard cannot see.
 */
function floorUnmoved(before: PoolFloor, after: PoolFloor): A.AssertResult {
    const ok = after.T === before.T && after.S === before.S;
    return {
        ok,
        name: 'FLOOR_UNMOVED',
        getMethod: 'ledger.getFloorNum / ledger.getFloorDen',
        before: `T ${before.T} S ${before.S}`,
        after: `T ${after.T} S ${after.S}`,
        detail: ok
            ? 'a swap against the pool touched neither term of p_f = T/S, which is §5 saying the ' +
              'market and the ratchet are separate books'
            : `ΔT ${after.T - before.T}, ΔS ${after.S - before.S} — a plain swap moved the floor`,
    };
}

async function report(client: TonClient) {
    const pool = Address.parse(env('PRIMES_DEDUST_POOL_ADDR'));
    const { ton, primes, T, S } = await poolFloor(client);

    // Both are nanoton per nano-PRIMES, so they are directly comparable.
    const poolPrice = primes === 0n ? 0 : Number(ton) / Number(primes);
    const pf = S === 0n ? 0 : Number(T) / Number(S);
    const results: A.AssertResult[] = [
        {
            ok: ton > 0n && primes > 0n && T > 0n && S > 0n,
            name: 'POOL_HAS_BOTH_SIDES',
            getMethod: 'pool.get_reserves + ledger.getFloorNum/getFloorDen',
            after: `${fromNano(ton)} GRAM / ${fromNano(primes)} PRIMES, T ${T} S ${S}`,
            detail:
                'the verdict below predicts NOTHING over a pool with an empty side, and on ' +
                '2026-09-19 it printed "the next flush() can FILL" over a PRIMES side of 292,000 ' +
                'against a min_out of 9,146,617',
        },
    ];

    console.log(`pool     ${pool.toString({ testOnly: true })}`);
    console.log(`reserves ${fromNano(ton)} GRAM  /  ${fromNano(primes)} PRIMES`);
    console.log(`price    ${poolPrice.toExponential(4)} GRAM per PRIMES`);
    console.log(`p_f      ${pf.toExponential(4)} GRAM per PRIMES   (T=${T} S=${S})`);
    if (pf > 0) {
        const ratio = poolPrice / pf;
        console.log(`ratio    ${ratio.toFixed(4)}x the floor`);

        // THE SPOT RATIO ALONE IS NOT THE PREDICATE, and this line used to say it was:
        // "at or below the floor -> the next flush() can FILL". It printed that verdict on
        // 2026-09-19 over a pool at 0.64x the floor whose ENTIRE PRIMES side was 292,000
        // against a `min_out` of 9,146,617 — a flush that could not fill for any input at
        // any price. What binds is DEPTH, not spot price: the guard demands
        // `min_out = a * S/T` and constant product pays `P*a/(X+a)`, so
        //
        //     P*a/(X+a) >= a/p_f   <=>   P*p_f - X >= a
        //
        // i.e. THE POOL'S PRIMES VALUED AT THE FLOOR MUST EXCEED ITS GRAM BY AT LEAST THE
        // FLUSH AMOUNT. At exactly the floor the left side is `X*(1 - 1) = 0` and a flush
        // can never fill, however deep the pool — the discount has to pay for the slippage
        // the flush itself causes. Printed as headroom in GRAM so "how much further do I
        // have to sell" has a number rather than a direction.
        const ratchet = client.open(PrimesRatchet.createFromAddress(Address.parse(env('PRIMES_RATCHET_ADDRESS'))));
        const pending = (await retry(() => ratchet.getPending(), 'getPending')) as bigint;
        // `handleFlush`: min(pending, max(pending * FLUSH_PCT, FLUSH_MIN)).
        const flushPct = BigInt(Math.round(params.flush.flush_pct * 1000));
        let a = (pending * flushPct) / 1000n;
        const flushMin = toNano(String(params.flush.flush_min_ton));
        if (a < flushMin) a = flushMin;
        if (a > pending) a = pending;

        const minOut = (a * S) / T;
        // DeDust volatile pools take 0.25% on the input leg.
        const out = pending === 0n ? 0n : (primes * ((a * 9975n) / 10000n)) / (ton + (a * 9975n) / 10000n);
        const headroom = (primes * T) / S - ton - a;
        console.log(`pending  ${fromNano(pending)} GRAM  -> flush() would send ${fromNano(a)} GRAM`);
        console.log(`min_out  ${fromNano(minOut)} PRIMES   vs pool would pay ${fromNano(out)} PRIMES`);
        console.log(`headroom ${fromNano(headroom)} GRAM   (P*p_f - X - amount; must be positive)`);
        console.log(
            out >= minOut
                ? '  -> the next flush() FILLS.'
                : ratio > 1
                  ? '  -> REFUSES: the pool is ABOVE the floor (§4.3.1). Sell PRIMES in to bring it down.'
                  : '  -> REFUSES: the pool is below the floor but TOO SHALLOW to pay min_out. Sell more PRIMES in.'
        );
        results.push({
            ok: !(out >= minOut) || headroom >= 0n,
            name: 'FILL_IMPLIES_HEADROOM',
            getMethod: 'pool.get_reserves + ratchet.getPending + ledger.getFloorNum/getFloorDen',
            after: `verdict ${out >= minOut ? 'FILLS' : 'REFUSES'}, headroom ${fromNano(headroom)} GRAM`,
            detail:
                '§4.3.1 solved two ways over the same four reads: constant product pays P·a/(X+a) ' +
                'and the guard demands a·S/T, so a quote that clears min_out forces ' +
                'P·p_f − X − a ≥ 0. Deliberately ONE-DIRECTIONAL — DeDust takes 0.25% on the input ' +
                'leg and the headroom line is the fee-free bound, so the two may part at the boundary',
        });
    }
    record({ phase: '5', op: 'pool-report', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function walletFor(client: TonClient, handle: string): Promise<Wallet> {
    if (handle === 'K') return openDeployWallet(client);
    const entry = readCast().find((c) => c.handle === handle);
    if (!entry) throw new Error(`no cast wallet "${handle}" — one of K, ${readCast().map((c) => c.handle).join(', ')}`);
    return openWallet(client, entry.mnemonic.split(/\s+/), undefined, entry.version); // W5 `P` (§4b)
}

/** The sender's own PRIMES wallet, off the master's TEP-89 get-method. */
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

/** PRIMES -> GRAM. Pushes the price DOWN, which is what makes a flush fillable. */
async function sell(client: TonClient, handle: string, primesAmount: string) {
    const pool = Address.parse(env('PRIMES_DEDUST_POOL_ADDR'));
    const jettonVault = Address.parse(env('PRIMES_DEDUST_JETTON_VAULT_ADDR'));
    const w = await walletFor(client, handle);
    const myJetton = await primesWalletOf(client, w.wallet.address);
    const amount = toNano(primesAmount); // PRIMES has 9 decimals, same as GRAM

    const balance = await retry(
        () => client.runMethod(myJetton, 'get_wallet_data', []).then((r) => r.stack.readBigNumber()),
        'get_wallet_data'
    );
    if (balance < amount) {
        throw new Error(
            `${handle} holds ${fromNano(balance)} PRIMES, short of the ${primesAmount} this swap sells.`
        );
    }

    // `swap#e3a0d482 _:SwapStep swap_params:^SwapParams` — the jetton leg carries
    // no `amount` field, because the transferred amount IS the input.
    const forward = beginCell()
        .storeUint(SWAP_JETTON_FORWARD_OP, 32)
        .storeAddress(pool) // SwapStep: pool_addr
        .storeUint(0, 1) // SwapStepParams: kind = given_in$0
        .storeCoins(0n) // SwapStepParams: limit = 0, this leg is the lever and takes any price
        .storeUint(0, 1) // SwapStepParams: next = none
        .storeRef(swapParams(w.wallet.address))
        .endCell();

    console.log(`${handle} selling ${primesAmount} PRIMES into ${pool.toString({ testOnly: true })}`);
    const before = await poolFloor(client);
    await w.sender.send({
        to: myJetton,
        value: toNano('0.35'),
        bounce: true,
        body: jettonTransferBody({
            amount,
            destination: jettonVault,
            responseAddress: w.wallet.address,
            forwardTon: toNano('0.25'),
            forwardPayload: forward,
        }),
    });
    console.log('sent. Waiting for the swap to settle into the reserves ...');
    const after = await settled(client, before);
    // Cross-multiplied so no float rounds the comparison: price = X/P, so
    // `price_after < price_before` is `X1·P0 < X0·P1` over four positive integers.
    const results: A.AssertResult[] = [
        {
            ok: after.ton * before.primes < before.ton * after.primes,
            name: 'POOL_PRICE_DOWN',
            getMethod: 'pool.get_reserves',
            before: `${fromNano(before.ton)} GRAM / ${fromNano(before.primes)} PRIMES`,
            after: `${fromNano(after.ton)} GRAM / ${fromNano(after.primes)} PRIMES`,
            detail:
                'the lever pulled in the direction the step claims: PRIMES in, GRAM out, price DOWN ' +
                'and towards p_f, which is the only way §4.3.1\'s FILL branch is reachable at all — ' +
                'a fresh genesis opens the pair well above the floor and refuses by construction',
        },
        floorUnmoved(before, after),
    ];
    record({ phase: '5', op: 'pool-sell', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** GRAM -> PRIMES. Pushes the price UP, which is what makes a flush refuse. */
async function buy(client: TonClient, handle: string, tonAmount: string) {
    const pool = Address.parse(env('PRIMES_DEDUST_POOL_ADDR'));
    const nativeVault = Address.parse(
        envValue(loadEnvFile(), 'PRIMES_DEDUST_VAULT_ADDR') ?? DEDUST_NATIVE_VAULT_TESTNET.toString()
    );
    const w = await walletFor(client, handle);
    const amount = toNano(tonAmount);

    // The same cell `primes_ratchet.tolk` builds, minus the contract-specific recipient.
    const body = beginCell()
        .storeUint(SWAP_NATIVE_OP, 32)
        .storeUint(0, 64) // query_id
        .storeCoins(amount) // swap#: amount
        .storeAddress(pool) // SwapStep: pool_addr
        .storeUint(0, 1) // kind = given_in$0
        .storeCoins(0n) // limit = 0
        .storeUint(0, 1) // next = none
        .storeRef(swapParams(w.wallet.address))
        .endCell();

    console.log(`${handle} buying PRIMES with ${tonAmount} GRAM through ${nativeVault.toString({ testOnly: true })}`);
    const before = await poolFloor(client);
    await w.sender.send({ to: nativeVault, value: amount + toNano('0.25'), bounce: true, body });
    console.log('sent. Waiting for the swap to settle into the reserves ...');
    const after = await settled(client, before);
    const results: A.AssertResult[] = [
        {
            ok: after.ton * before.primes > before.ton * after.primes,
            name: 'POOL_PRICE_UP',
            getMethod: 'pool.get_reserves',
            before: `${fromNano(before.ton)} GRAM / ${fromNano(before.primes)} PRIMES`,
            after: `${fromNano(after.ton)} GRAM / ${fromNano(after.primes)} PRIMES`,
            detail:
                'GRAM in, PRIMES out, price UP and back over the floor guard — the REFUSE branch of ' +
                '§4.3.1 is only exercised on purpose if the pool is put above p_f on purpose first',
        },
        floorUnmoved(before, after),
    ];
    record({ phase: '5', op: 'pool-buy', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function main() {
    const client = makeClient();
    const [cmd, a, b] = process.argv.slice(2);
    if (!cmd || cmd === 'report') return report(client);
    if (cmd === 'sell') {
        if (!a || !b) throw new Error('usage: pool.ts sell <handle|K> <PRIMES>');
        await sell(client, a, b);
        return report(client);
    }
    if (cmd === 'buy') {
        if (!a || !b) throw new Error('usage: pool.ts buy <handle|K> <GRAM>');
        await buy(client, a, b);
        return report(client);
    }
    throw new Error(`unknown command "${cmd}" — one of: report, sell, buy`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
