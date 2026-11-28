/**
 * TON PRIMES — read and CLOSE an auction lot.
 *
 * D-90 is what makes this worth its own script: **winning MINTS the number, in
 * the transaction that closes the lot**, for both kinds. There is no escrowed
 * claim, no `settle(n)`, no wait for the head. So a close is the one moment
 * where the market and the ledger have to agree in a single trace, and it is
 * the step every prior acceptance wave ran out of clock before reaching
 * (`GAUNTLET.md` H4 for the composite lane, H3 for the prime one).
 *
 *   npx tsx contracts/scripts/testnet/lot.ts show <n>
 *   npx tsx contracts/scripts/testnet/lot.ts close <n> [handle]
 *   npx tsx contracts/scripts/testnet/lot.ts open <n> [handle]        # ascending: the open IS the first bid, at p0
 *   npx tsx contracts/scripts/testnet/lot.ts open-dutch <n> [handle]  # descending: gas only, places no bid
 *   npx tsx contracts/scripts/testnet/lot.ts buy <n> [handle]         # a Dutch lot's purchase at the standing price
 *   npx tsx contracts/scripts/testnet/lot.ts snipe <n> [handle] [lead]   # X1/D-8: raise inside the extension window
 *   npx tsx contracts/scripts/testnet/lot.ts rest-check <upTo>         # D-218: on-chain rest == params table, read-only
 *
 * The three writes (G54) each decide on the read BEFORE they send: the lot's state,
 * the quoted price, the sender's balance. Every value is the quote plus MARGIN.
 *
 * `close` is PERMISSIONLESS — the default sender is `F`, the cast wallet that
 * has done nothing else, so the permissionlessness is what is being shown and
 * not merely assumed.
 */
import { Address, beginCell, fromNano, toNano } from '@ton/core';
import { TonClient } from '@ton/ton';
import { PrimesMarket } from '../../wrappers/PrimesMarket';
import { PrimesLedger } from '../../wrappers/PrimesLedger';
import { PrimesCollection } from '../../wrappers/PrimesCollection';
import { loadEnvFile, envValue } from '../envFile';
import { makeClient, retry } from './sender';
// chain.ts's walletFor carries the entry's wallet VERSION: `P` is W5R1, and this file's own
// v4-only copy would have driven the same seed's v4 account instead (G54).
import { walletFor } from './chain';
import { factorize, isPrime as isPrimeN } from './money';
import { record } from './journal';
import { contracts, snapshot } from './chain';
import { PrimesItem } from '../../wrappers/PrimesItem';

function env(name: string): string {
    const v = envValue(loadEnvFile(), name);
    if (!v) throw new Error(`${name} missing from /.env`);
    return v;
}

function market(client: TonClient) {
    return client.open(PrimesMarket.createFromAddress(Address.parse(env('PRIMES_MARKET_ADDRESS'))));
}

async function show(client: TonClient, n: bigint) {
    const m = market(client);
    const lot = await retry(() => m.getLot(n), 'getLot');
    const now = Math.floor(Date.now() / 1000);
    console.log(`lot ${n}`, lot);
    if (lot.found && !lot.closed) {
        console.log(`  closesAt - now = ${lot.closesAt - now}s`);
        console.log(`  window was ${lot.closesAt - lot.openedAt}s (D-139's divided AUCTION_WINDOW)`);
    }
    console.log('lane  ', await retry(() => m.getLotLane(n), 'getLotLane'));
}

async function close(client: TonClient, n: bigint, handle: string) {
    const m = market(client);
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(env('PRIMES_LEDGER_ADDRESS'))));
    const collection = client.open(PrimesCollection.createFromAddress(Address.parse(env('PRIMES_COLLECTION_ADDRESS'))));

    const before = await retry(() => m.getLot(n), 'getLot');
    const headBefore = await retry(() => ledger.getHead(), 'getHead');
    const tBefore = await retry(() => ledger.getFloorNum(), 'getFloorNum');
    const sBefore = await retry(() => ledger.getFloorDen(), 'getFloorDen');
    console.log(`before: closed=${before.closed} highBid=${fromNano(before.highBid)} GRAM winner=${before.highBidder}`);
    console.log(`        head=${headBefore} T=${tBefore} S=${sBefore}`);

    // DECIDE ON THE READ, BEFORE THE SEND (CLAUDE.md, driver scripts). The market throws 1005
    // on a close before `closesAt`, and a refused close is a red transaction in an explorer
    // plus a bounce home — four of them landed on 20260929 when this script had no guard.
    // 30 s of slack covers a local clock ahead of the chain's.
    if (!before.found) throw new Error(`no lot ${n} — nothing sent`);
    if (before.closed) throw new Error(`lot ${n} is already closed — nothing sent`);
    const wait = before.closesAt + 30 - Math.floor(Date.now() / 1000);
    if (wait > 0) throw new Error(`lot ${n} closes at ${new Date(before.closesAt * 1000).toISOString()} — ${wait}s to go; nothing sent`);

    const w = await walletFor(client, handle);
    console.log(`${handle} closing lot ${n} (permissionless)`);
    // D-90: the close MINTS, so it funds a mint's worth of onward hops, not just
    // its own gas. The winner's bid is already held by the market.
    await m.sendClose(w.sender, { n, value: toNano('0.5') });

    const after = await retry(() => m.getLot(n), 'getLot');
    const headAfter = await retry(() => ledger.getHead(), 'getHead');
    const tAfter = await retry(() => ledger.getFloorNum(), 'getFloorNum');
    const sAfter = await retry(() => ledger.getFloorDen(), 'getFloorDen');
    console.log(`after:  closed=${after.closed}`);
    console.log(`        head=${headAfter} T=${tAfter} S=${sAfter}`);
    console.log(`        ratchet theorem (T'·S > T·S'): ${tAfter * sBefore > tBefore * sAfter}`);

    // The whole point of D-90: the NFT exists now, owned by the winner.
    try {
        const item = await retry(() => collection.getNftAddressByIndex(n), 'getNftAddressByIndex');
        console.log(`        item ${item.toString({ testOnly: true })}`);
        const data = await retry(() => client.runMethod(item, 'get_nft_data', []), 'get_nft_data');
        data.stack.readNumber(); // init
        data.stack.readNumber(); // index
        data.stack.readAddress(); // collection
        console.log(`        owner ${data.stack.readAddress().toString({ testOnly: true })}`);
    } catch (e: any) {
        console.log(`        item not readable yet (${e?.message ?? e}) — the close fans out asynchronously`);
    }
}

const MARGIN = toNano('0.05');
const OPEN_DUTCH_GAS = toNano('0.2');

async function guardBalance(client: TonClient, handle: string, addr: Address, need: bigint) {
    const bal = await retry(() => client.getBalance(addr), 'getBalance');
    if (bal < need + MARGIN) throw new Error(`${handle} holds ${fromNano(bal)} GRAM, needs ${fromNano(need + MARGIN)} — nothing sent`);
}

async function openAscending(client: TonClient, n: bigint, handle: string) {
    const m = market(client);
    const lot = await retry(() => m.getLot(n), 'getLot');
    if (lot.found) throw new Error(`lot ${n} is already open (highBid ${fromNano(lot.highBid)}) — nothing sent`);
    if (!(await retry(() => m.getIsOpenable(n), 'getIsOpenable'))) throw new Error(`${n} is not openable — nothing sent`);
    const prime = isPrimeN(n);
    const factors = prime ? [] : factorize(n);
    const price = prime
        ? await retry(() => m.getLotPrice(n), 'getLotPrice')
        : await retry(() => m.getLotPriceFrom(n, factors), 'getLotPriceFrom');
    const value = price.p0 + MARGIN;
    const w = await walletFor(client, handle);
    await guardBalance(client, handle, w.wallet.address, value);
    console.log(`${handle} opens ascending lot ${n} (kind ${prime ? 1 : 0}) at p0 ${fromNano(price.p0)} GRAM, value ${fromNano(value)}`);
    await m.sendOpenLot(w.sender, { n, kind: prime ? 1 : 0, factors, beneficiary: null, referralKey: 0, value });
    await new Promise((r) => setTimeout(r, 25_000));
    const after = await retry(() => m.getLot(n), 'getLot(after)');
    if (!after.found) throw new Error(`open of ${n} did not land`);
    console.log(`landed: highBid ${fromNano(after.highBid)} bidder ${after.highBidder} closesAt ${new Date(after.closesAt * 1000).toISOString()}`);
}

async function openDutch(client: TonClient, n: bigint, handle: string) {
    const m = market(client);
    const lot = await retry(() => m.getLot(n), 'getLot');
    if (lot.found) throw new Error(`lot ${n} is already open — nothing sent`);
    if (!isPrimeN(n)) throw new Error(`${n} is not prime; the descending lane is primes only — nothing sent`);
    // The MARKET's head hint, not the ledger's head: the ledger's sync_head reaches the market
    // one hop later, and inside that gap `open_head_lot` throws 1024 (ahead of the head).
    // `getIsOpenable` says yes to the ascending lane too, so it cannot answer this.
    let hint = await retry(() => m.getHeadHint(), 'getHeadHint');
    // X5: WAIT_HINT=1 polls for the head to pass `n`, so the open can beat the keeper's 60 s cycle.
    for (let i = 0; process.env.WAIT_HINT && n >= hint && i < 400; i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        hint = await retry(() => m.getHeadHint(), 'getHeadHint');
    }
    if (n >= hint) throw new Error(`${n} is not behind the market's head hint ${hint} yet — nothing sent`);
    const w = await walletFor(client, handle);
    await guardBalance(client, handle, w.wallet.address, OPEN_DUTCH_GAS);
    // X5: decide on the freshest read — the keeper's prime lane races this open.
    if ((await retry(() => m.getLot(n), 'getLot(re-read)')).found) throw new Error(`lot ${n} opened meanwhile (keeper) — nothing sent`);
    const mktBefore = await retry(() => client.getBalance(m.address), 'market balance');
    const callerBefore = await retry(() => client.getBalance(w.wallet.address), 'caller balance');
    const sentAt = Math.floor(Date.now() / 1000);
    console.log(`${handle} opens the descending lot on ${n} (gas only, no bid)`);
    await m.sendOpenHeadLot(w.sender, { n, value: OPEN_DUTCH_GAS });
    let after = await retry(() => m.getLot(n), 'getLot(after)');
    for (let i = 0; i < 12 && !after.found; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        after = await retry(() => m.getLot(n), 'getLot(after)');
    }
    if (!after.found) throw new Error(`open-dutch of ${n} did not land`);
    console.log(`landed: mode ${after.mode} p0 ${fromNano(after.p0)} standing ${fromNano(after.standingPrice)} minPayment ${fromNano(after.minPayment)}`);
    // The refund rides back in the same trace; give it one more poll to land.
    let callerAfter = await retry(() => client.getBalance(w.wallet.address), 'caller balance after');
    for (let i = 0; i < 8 && callerBefore - callerAfter > OPEN_DUTCH_GAS / 2n; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        callerAfter = await retry(() => client.getBalance(w.wallet.address), 'caller balance after');
    }
    const mktAfter = await retry(() => client.getBalance(m.address), 'market balance after');
    const spent = callerBefore - callerAfter;
    const asserts = [
        {
            ok: after.mode === 2 && Math.abs(after.openedAt - sentAt) < 300,
            name: 'DESCENDING_LOT_OPENED_NOW',
            getMethod: `market.getLot(${n}).{mode,openedAt}`,
            after: `mode ${after.mode} openedAt ${after.openedAt} (sent ~${sentAt})`,
            detail: 'D-20/D-88: a prime whose turn has passed opens a descending lot from now, by anyone',
        },
        {
            // The market pays its own storage phase on the inbound (19 nanoGRAM on 71, 2026-11-27):
            // rent is not the open spending the float, so a microGRAM of it is allowed.
            ok: mktAfter >= mktBefore - 1000n,
            name: 'MARKET_FLOAT_NOT_DRAINED',
            getMethod: 'market balance',
            before: fromNano(mktBefore),
            after: fromNano(mktAfter),
            detail: "the open is caller-funded (2026-11-23): its hop and compute come out of the caller's value, never the float",
        },
        {
            ok: spent > 0n && spent < OPEN_DUTCH_GAS / 2n,
            name: 'OPENER_REFUNDED_REMAINDER',
            getMethod: `${handle} wallet balance`,
            before: fromNano(callerBefore),
            after: `${fromNano(callerAfter)} (net ${fromNano(spent)} of ${fromNano(OPEN_DUTCH_GAS)} attached)`,
            detail: 'what the open did not spend returns to the caller in the same trace (e0f8ae26b, 0109aa471)',
        },
    ];
    for (const r of asserts) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name} ${r.after}`);
    record({ phase: '3', op: `open-head-lot-${n}`, ok: asserts.every((r) => r.ok), asserts: asserts.map((r) => ({ name: r.name, ok: r.ok, getMethod: r.getMethod, detail: `${r.detail} — ${r.before ? r.before + ' → ' : ''}${r.after}` })) });
    if (!asserts.every((r) => r.ok)) process.exit(1);
}

async function primesHeld(client: TonClient, owner: Address): Promise<bigint> {
    const master = Address.parse(env('PRIMES_JETTON_MASTER_ADDRESS'));
    const r = await retry(
        () => client.runMethod(master, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }]),
        'get_wallet_address'
    );
    const wallet = r.stack.readAddress();
    try {
        return (await client.runMethod(wallet, 'get_wallet_data', [])).stack.readBigNumber();
    } catch {
        return 0n;
    }
}

/**
 * A Dutch lot's purchase at the standing price — and, since X4, the asserts that make it
 * evidence: the lot closes in the buy's own transaction, the buyer owns `n`, a prime mint
 * emits nothing (§5.1, k = 0: the buyer's PRIMES do not move), `T` rises, `S` does not, and
 * the head does not move (an auction mints off-head).
 */
async function buy(client: TonClient, n: bigint, handle: string) {
    const m = market(client);
    const lot = await retry(() => m.getLot(n), 'getLot');
    if (!lot.found || lot.closed) throw new Error(`lot ${n} is not open — nothing sent`);
    const value = lot.minPayment + MARGIN;
    const w = await walletFor(client, handle);
    await guardBalance(client, handle, w.wallet.address, value);
    const c = contracts(client);
    const before = await snapshot(c);
    const primesBefore = await primesHeld(client, w.wallet.address);
    const rest = await retry(() => m.getPrimeFloor(n), 'getPrimeFloor');
    console.log(`${handle} buys lot ${n} at minPayment ${fromNano(lot.minPayment)} GRAM (rest ${fromNano(rest)}), value ${fromNano(value)}`);
    await m.sendBid(w.sender, { n, beneficiary: null, referralKey: 0, value });
    let after = lot;
    for (let i = 0; i < 12 && !after.closed; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        after = await retry(() => m.getLot(n), 'getLot(after)');
    }
    const snapAfter = await snapshot(c);
    const primesAfter = await primesHeld(client, w.wallet.address);
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(env('PRIMES_LEDGER_ADDRESS'))));
    const itemAddr = await retry(() => ledger.getItemAddress(n), 'getItemAddress');
    let owner: Address | null = null;
    for (let i = 0; i < 6 && !owner; i++) {
        try {
            owner = (await client.open(PrimesItem.createFromAddress(itemAddr)).getNumberData()).owner;
        } catch {
            await new Promise((r) => setTimeout(r, 10_000));
        }
    }
    const asserts = [
        { name: 'LOT_CLOSED_BY_BUY', ok: after.closed, getMethod: 'market.getLot(n).closed', detail: `closed=${after.closed}` },
        { name: 'BUYER_OWNS_N', ok: !!owner?.equals(w.wallet.address), getMethod: 'item(n).getNumberData().owner', detail: `owner ${owner}` },
        {
            name: 'PRIME_EMITS_NOTHING',
            ok: primesAfter === primesBefore,
            getMethod: 'buyer jetton wallet get_wallet_data',
            detail: `buyer PRIMES ${primesBefore} -> ${primesAfter} (§5.1: k = 0 on a prime)`,
        },
        { name: 'T_UP', ok: snapAfter.T > before.T, getMethod: 'ledger.getFloorNum', detail: `T +${fromNano(snapAfter.T - before.T)} GRAM` },
        { name: 'S_UNMOVED_BY_BUY', ok: snapAfter.S === before.S, getMethod: 'ledger.getFloorDen', detail: `S ${before.S} -> ${snapAfter.S}` },
        { name: 'HEAD_UNMOVED', ok: snapAfter.head === before.head, getMethod: 'ledger.getHead', detail: `head ${before.head} -> ${snapAfter.head}` },
        {
            name: 'PAID_AT_REST',
            // `minPayment` = standing + the lane's fixed gas component (0.07), so the PRICE is `standingPrice`.
            ok: lot.standingPrice === rest,
            getMethod: 'market.getLot(n).standingPrice vs getPrimeFloor(n)',
            detail: `standing ${fromNano(lot.standingPrice)} (paid ${fromNano(lot.minPayment)} incl. gas) vs D-218 rest ${fromNano(rest)}`,
        },
    ];
    const ok = asserts.every((a) => a.ok);
    record({ phase: '3', op: `dutch-buy-${n}`, ok, asserts });
    for (const a of asserts) console.log(`  ${a.ok ? 'OK  ' : 'FAIL'} ${a.name}  ${a.detail}`);
    if (!ok) process.exit(1);
}

/**
 * X1, D-8 anti-snipe on chain: a raise that LANDS inside the final `bidExtension` seconds moves
 * `closesAt` to `now + bidExtension` (the max() form), and the displaced bid is refunded in the
 * same trace. Decides on the read: refuses when `handle` already holds the high bid, when the
 * lot is closed, or when the window has already passed. Sends `lead` seconds before close
 * (default 15 — the external plus one hop must land inside the 23 s window on a D-139 set).
 */
async function snipe(client: TonClient, n: bigint, handle: string, lead: number) {
    const m = market(client);
    const params = await retry(() => m.getMarketParams(), 'getMarketParams');
    const lot = await retry(() => m.getLot(n), 'getLot');
    const w = await walletFor(client, handle);
    if (!lot.found || lot.closed || lot.closesAt === 0) throw new Error(`lot ${n} is not a running ascending lot — nothing sent`);
    if (lot.highBidder?.equals(w.wallet.address)) throw new Error(`${handle} already holds the high bid on ${n} — nothing sent`);
    if (lead >= params.bidExtension) throw new Error(`lead ${lead}s is outside the ${params.bidExtension}s extension window`);
    const sendAt = lot.closesAt - lead;
    const wait = sendAt - Math.floor(Date.now() / 1000);
    if (wait < 0) throw new Error(`too late: ${-wait}s past the send point for closesAt ${lot.closesAt} — nothing sent`);
    const value = lot.minPayment + MARGIN;
    await guardBalance(client, handle, w.wallet.address, value);
    const prevBidder = lot.highBidder;
    const prevBal = prevBidder ? await retry(() => client.getBalance(prevBidder), 'getBalance(prev)') : 0n;
    console.log(`waiting ${wait}s, then ${handle} raises ${n} to ${fromNano(lot.minPayment)} with ${lead}s left (window ${params.bidExtension}s)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    await m.sendBid(w.sender, { n, beneficiary: null, referralKey: 0, value });
    let after = lot;
    for (let i = 0; i < 12 && !after.highBidder?.equals(w.wallet.address); i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        after = await retry(() => m.getLot(n), 'getLot(after)');
    }
    const prevAfter = prevBidder ? await retry(() => client.getBalance(prevBidder), 'getBalance(prev after)') : 0n;
    const won = !!after.highBidder?.equals(w.wallet.address);
    const extended = after.closesAt > lot.closesAt;
    const refunded = prevAfter - prevBal >= lot.highBid - toNano('0.01');
    const asserts = [
        { name: 'SNIPE_BID_LANDED', ok: won, getMethod: 'market.getLot(n).highBidder', detail: `${handle} is high bidder at ${fromNano(after.highBid)}` },
        {
            name: 'ANTI_SNIPE_EXTENDS',
            ok: extended,
            getMethod: 'market.getLot(n).closesAt + getMarketParams().bidExtension',
            detail: `closesAt ${lot.closesAt} -> ${after.closesAt} (+${after.closesAt - lot.closesAt}s; D-8 max(closesAt, now + ${params.bidExtension}))`,
        },
        {
            name: 'DISPLACED_BID_REFUNDED',
            ok: refunded,
            getMethod: 'balance(previous high bidder)',
            detail: `${prevBidder} +${fromNano(prevAfter - prevBal)} GRAM for a displaced ${fromNano(lot.highBid)} bid`,
        },
    ];
    const ok = asserts.every((a) => a.ok);
    record({ phase: '0', op: `anti-snipe-${n}`, ok, asserts });
    for (const a of asserts) console.log(`  ${a.ok ? 'OK  ' : 'FAIL'} ${a.name}  ${a.detail}`);
    if (!ok) process.exit(1);
}

/**
 * D-218 on chain: every prime in [3, upTo] rests where `shared/params.json`'s
 * `resting_ladder` says, and a prime missing from the table rests at MINT_PRICE.
 * Read-only — `getPrimeFloor(p)` answers from `p` alone, before any lot exists.
 */
async function restCheck(client: TonClient, upTo: bigint) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const table: Record<string, number> = require('../../../shared/params.json').trophy_auction.resting_ladder.resting_nanoton_by_prime;
    const m = market(client);
    const bad: string[] = [];
    let checked = 0;
    for (let p = 3n; p <= upTo; p += 2n) {
        if (!isPrimeN(p)) continue;
        const want = BigInt(table[String(p)] ?? 1_000_000_000);
        const got = await retry(() => m.getPrimeFloor(p), `getPrimeFloor(${p})`);
        checked++;
        if (got !== want) bad.push(`${p}: chain ${fromNano(got)} != params ${fromNano(want)}`);
    }
    const ok = bad.length === 0;
    record({
        phase: '1',
        op: 'd218-rest-table',
        ok,
        asserts: [
            {
                name: 'REST_TABLE_MATCHES_PARAMS',
                ok,
                getMethod: 'market.getPrimeFloor(p) vs params.json resting_ladder',
                detail: ok ? `${checked} primes in [3, ${upTo}] rest exactly at the D-218 table (1 GRAM off-table)` : bad.join('; '),
            },
        ],
    });
    console.log(ok ? `OK: ${checked} primes match` : `FAIL:\n${bad.join('\n')}`);
    if (!ok) process.exit(1);
}

async function main() {
    const [cmd, nArg, handle] = process.argv.slice(2);
    const client = makeClient();
    if (!cmd || !nArg) throw new Error('usage: lot.ts <show|close|rest-check> <n> [handle]');
    if (cmd === 'rest-check') return restCheck(client, BigInt(nArg));
    if (cmd === 'snipe') return snipe(client, BigInt(nArg), handle ?? 'C', Number(process.argv[5] ?? 15));
    const n = BigInt(nArg);
    if (cmd === 'show') return show(client, n);
    if (cmd === 'close') return close(client, n, handle ?? 'F');
    if (cmd === 'open') return openAscending(client, n, handle ?? 'K');
    if (cmd === 'open-dutch') return openDutch(client, n, handle ?? 'K');
    if (cmd === 'buy') return buy(client, n, handle ?? 'K');
    throw new Error(`unknown command "${cmd}" — one of: show, close, open, open-dutch, buy`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
