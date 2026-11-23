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
 *
 * The three writes (G54) each decide on the read BEFORE they send: the lot's state,
 * the quoted price, the sender's balance. Every value is the quote plus MARGIN.
 *
 * `close` is PERMISSIONLESS — the default sender is `F`, the cast wallet that
 * has done nothing else, so the permissionlessness is what is being shown and
 * not merely assumed.
 */
import { Address, fromNano, toNano } from '@ton/core';
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
    const hint = await retry(() => m.getHeadHint(), 'getHeadHint');
    if (n >= hint) throw new Error(`${n} is not behind the market's head hint ${hint} yet — nothing sent`);
    const w = await walletFor(client, handle);
    await guardBalance(client, handle, w.wallet.address, OPEN_DUTCH_GAS);
    console.log(`${handle} opens the descending lot on ${n} (gas only, no bid)`);
    await m.sendOpenHeadLot(w.sender, { n, value: OPEN_DUTCH_GAS });
    await new Promise((r) => setTimeout(r, 25_000));
    const after = await retry(() => m.getLot(n), 'getLot(after)');
    if (!after.found) throw new Error(`open-dutch of ${n} did not land`);
    console.log(`landed: mode ${after.mode} p0 ${fromNano(after.p0)} standing ${fromNano(after.standingPrice)} minPayment ${fromNano(after.minPayment)}`);
}

async function buy(client: TonClient, n: bigint, handle: string) {
    const m = market(client);
    const lot = await retry(() => m.getLot(n), 'getLot');
    if (!lot.found || lot.closed) throw new Error(`lot ${n} is not open — nothing sent`);
    const value = lot.minPayment + MARGIN;
    const w = await walletFor(client, handle);
    await guardBalance(client, handle, w.wallet.address, value);
    console.log(`${handle} buys lot ${n} at minPayment ${fromNano(lot.minPayment)} GRAM, value ${fromNano(value)}`);
    await m.sendBid(w.sender, { n, beneficiary: null, referralKey: 0, value });
    await new Promise((r) => setTimeout(r, 25_000));
    const after = await retry(() => m.getLot(n), 'getLot(after)');
    console.log(`after: closed=${after.closed} highBidder ${after.highBidder}`);
}

async function main() {
    const [cmd, nArg, handle] = process.argv.slice(2);
    const client = makeClient();
    if (!cmd || !nArg) throw new Error('usage: lot.ts <show|close> <n> [handle]');
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
