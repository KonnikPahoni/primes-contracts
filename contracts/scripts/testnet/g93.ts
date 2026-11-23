/**
 * TON PRIMES — the surfaces `GAUNTLET.md` G93's genesis adds, at a live node
 * (`TESTNET_MASTER_PLAN.md` §3 phase 4b). Each arm READS first and sends only when the
 * read says the send does something (CLAUDE.md's driver-script rule).
 *
 *   npx tsx contracts/scripts/testnet/g93.ts cards <handle...>     # D-191/D-195 minter cards
 *   npx tsx contracts/scripts/testnet/g93.ts confirm-sender [limit] # V28/D-199: mint_confirmed FROM the item
 *   npx tsx contracts/scripts/testnet/g93.ts advance-head [handle]  # D-189
 *   npx tsx contracts/scripts/testnet/g93.ts unsold [handle]        # D-198 flush_unsold, when due
 *   npx tsx contracts/scripts/testnet/g93.ts lot-blocks <n...>      # D-196: a far lot's mark is on its lot block
 *   npx tsx contracts/scripts/testnet/g93.ts retry-lane             # V28: nothing parked, collection at its floor
 */
import { Address, fromNano, toNano } from '@ton/core';
import { PrimesMinterCard } from '../../wrappers/PrimesMinterCard';
import { PrimesLotBlock } from '../../wrappers/PrimesLotBlock';
import { PrimesCollection } from '../../wrappers/PrimesCollection';
import { minterCardAddress } from '../../../shared/minterCard';
import { LEDGER } from '../../../shared/opcodes';
import { retry } from './sender';
import { addr, contracts, walletFor, type Contracts } from './chain';
import * as A from './assert';
import { fromAsserts, record } from './journal';

const SETTLE_MS = 25_000;
const t = (a: Address) => a.toString({ testOnly: true });

function finish(op: string, results: A.AssertResult[], note?: string) {
    record({ phase: '4b', op, ok: results.every((r) => r.ok), asserts: fromAsserts(results), note });
    A.requireAll(results);
}

/** D-191: the card the ledger names is the card the wrapper derives, deployed, owned by the wallet. */
async function cmdCards(c: Contracts, handles: string[]) {
    const results: A.AssertResult[] = [];
    for (const h of handles) {
        const w = await walletFor(c.client, h);
        const me = w.wallet.address;
        const named = await retry(() => c.ledger.getMinterCardAddress(me), `getMinterCardAddress(${h})`);
        const derived = minterCardAddress(c.ledger.address, me);
        const card = c.client.open(PrimesMinterCard.createFromAddress(named));
        const state = await retry(() => c.client.getContractState(named), `state(${h} card)`);
        const active = state.state === 'active';
        const owner = active ? await retry(() => card.getCardOwner(), `getCardOwner(${h})`) : null;
        const ms = await retry(() => card.getMinterState(), `getMinterState(${h})`);
        const win = await retry(() => card.getNewcomerWindow(), `getNewcomerWindow(${h})`);
        const rr = await retry(() => card.getRecruitRank(), `getRecruitRank(${h})`);
        console.log(
            `${h}: card ${t(named)} active=${active} seen=${owner?.seen} primesMinted ${ms.primesMinted} ` +
                `window ${win.left}/${win.total} recruits ${rr.recruits} tier ${rr.tier}`
        );
        results.push({
            ok: named.equals(derived) && active && !!owner && owner.owner.equals(me) && owner.ledger.equals(c.ledger.address),
            name: `CARD_${h}`,
            getMethod: 'ledger.getMinterCardAddress + card.getCardOwner',
            after: `${t(named)} active=${active} seen=${owner?.seen} window ${win.left}/${win.total} recruits ${rr.recruits}`,
            detail: 'the ledger names the derived card, deployed, owned by this wallet against this ledger (D-191)',
        });
    }
    finish(`minter-cards-${handles.join('-')}`, results);
}

/**
 * V28 / D-199: every `mint_confirmed` the ledger received came FROM item(n), not the
 * collection, and its compute phase succeeded. The ledger throws 100 on any other
 * sender, so a collection-sent confirm would be a red transaction here.
 */
async function cmdConfirmSender(c: Contracts, limit: number) {
    const collection = c.client.open(PrimesCollection.createFromAddress(addr('PRIMES_COLLECTION_ADDRESS')));
    // archival first; non-archival when toncenter's testnet archival pool 542s (2026-11-21) —
    // the ledger is a fresh genesis account, so the plain nodes hold all of its history.
    const txs = await retry(
        () =>
            c.client
                .getTransactions(c.ledger.address, { limit, archival: true })
                .catch(() => c.client.getTransactions(c.ledger.address, { limit })),
        'ledger txs'
    );
    let seen = 0;
    let fromItem = 0;
    const bad: string[] = [];
    for (const tx of txs) {
        const m = tx.inMessage;
        if (!m || m.info.type !== 'internal') continue;
        const s = m.body.beginParse();
        if (s.remainingBits < 32 || s.loadUint(32) !== LEDGER.mint_confirmed) continue;
        seen++;
        s.loadUintBig(64);
        const n = s.loadCoins();
        const item = await retry(() => collection.getItemAddress(n), `getItemAddress(${n})`);
        const d = tx.description;
        const green =
            d.type === 'generic' &&
            !d.aborted &&
            d.computePhase.type === 'vm' &&
            (d.computePhase.exitCode === 0 || d.computePhase.exitCode === 1);
        if (m.info.src.equals(item) && green) fromItem++;
        else bad.push(`n=${n} src ${t(m.info.src)} item ${t(item)} green=${green}`);
    }
    console.log(`${seen} mint_confirmed in the ledger's last ${txs.length} txs; ${fromItem} from item(n), green`);
    for (const b of bad) console.log('  !! ' + b);
    finish('mint-confirmed-from-item', [
        {
            ok: seen > 0 && bad.length === 0,
            name: 'MINT_CONFIRMED_FROM_ITEM',
            getMethod: 'ledger transactions (in_msg op 0xb000007a) vs collection.getItemAddress(n)',
            after: `${fromItem}/${seen}`,
            detail: 'V28/D-199: the item, not the collection, confirms a mint, and the ledger accepts it',
        },
    ]);
}

/** D-189: `advance_head` moves a parked walk on, and is a refunded no-op when nothing is parked. */
async function cmdAdvanceHead(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const pending = await retry(() => c.ledger.getWalkPending(), 'getWalkPending');
    const head0 = await retry(() => c.ledger.getHead(), 'getHead');
    const bal0 = await retry(() => c.client.getBalance(w.wallet.address), 'balance');
    console.log(`walkPending ${pending}, head ${head0}; sending advance_head (0.3 GRAM, change rides back)`);
    await c.ledger.sendAdvanceHead(w.sender, { value: toNano('0.3') });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const pending1 = await retry(() => c.ledger.getWalkPending(), 'getWalkPending(after)');
    const head1 = await retry(() => c.ledger.getHead(), 'getHead(after)');
    const bal1 = await retry(() => c.client.getBalance(w.wallet.address), 'balance(after)');
    const cost = bal0 - bal1;
    finish('advance-head', [
        {
            ok: pending ? head1 > head0 || !pending1 : head1 === head0,
            name: 'ADVANCE_HEAD',
            getMethod: 'ledger.getWalkPending + getHead',
            before: `pending ${pending} head ${head0}`,
            after: `pending ${pending1} head ${head1}`,
            detail: pending ? 'a parked walk moved on' : 'nothing parked: the head did not move',
        },
        {
            ok: cost < toNano('0.05'),
            name: 'ADVANCE_HEAD_REFUNDS',
            getMethod: 'caller balance',
            after: `${fromNano(cost)} GRAM spent`,
            detail: 'the 0.3 GRAM rides back less gas (CARRY_ALL_REMAINING)',
        },
    ]);
}

/** D-198: `flush_unsold` only once the head has left block `unsoldFlushed`; otherwise read and say so. */
async function cmdUnsold(c: Contracts, handle: string) {
    const u = await retry(() => c.ledger.getUnsoldFlush(), 'getUnsoldFlush');
    const head = await retry(() => c.ledger.getHead(), 'getHead');
    const end = 2n + 256n * (u.unsoldFlushed + 1n);
    console.log(`unsoldFlushed ${u.unsoldFlushed}, dueNow ${u.dueNow}, head ${head} (block ends at ${end})`);
    if (!u.dueNow) {
        finish(
            'flush-unsold',
            [
                {
                    ok: head < end,
                    name: 'FLUSH_UNSOLD_NOT_DUE',
                    getMethod: 'ledger.getUnsoldFlush',
                    after: `block ${u.unsoldFlushed}, head ${head} < ${end}`,
                    detail: 'the head is still inside the block, so the send would throw 234 — read, not sent',
                },
            ],
            'not due on this run: the head never leaves block 0'
        );
        return;
    }
    const w = await walletFor(c.client, handle);
    await c.ledger.sendFlushUnsold(w.sender, { value: toNano('0.15') });
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const u1 = await retry(() => c.ledger.getUnsoldFlush(), 'getUnsoldFlush(after)');
    finish('flush-unsold', [
        {
            ok: u1.unsoldFlushed > u.unsoldFlushed,
            name: 'FLUSH_UNSOLD_ADVANCES',
            getMethod: 'ledger.getUnsoldFlush',
            before: `${u.unsoldFlushed}`,
            after: `${u1.unsoldFlushed}`,
            detail: 'the passed block’s unsold rows moved to its lot block',
        },
    ]);
}

/** D-196: a lot opened far past the frontier wrote its mark to that block's lot block. */
async function cmdLotBlocks(c: Contracts, ns: bigint[]) {
    const st = await retry(() => c.ledger.getLotBlockState(), 'getLotBlockState');
    console.log(`frontier block ${st.frontierBlock}, window ${st.windowBlocks}, importing ${st.importingBlock}`);
    const results: A.AssertResult[] = [];
    for (const n of ns) {
        const block = (n - 2n) >> 8n;
        const where = await retry(() => c.ledger.getLotBlockAddress(block), `getLotBlockAddress(${block})`);
        const lb = c.client.open(PrimesLotBlock.createFromAddress(where));
        const words = await retry(() => lb.getWordsOrZero(), `getWords(${block})`);
        const bit = ((words.claimed >> ((n - 2n) & 255n)) & 1n) === 1n;
        const resolved = await retry(() => c.ledger.isNumberOffHeadResolved(n), `isNumberOffHeadResolved(${n})`);
        console.log(`n=${n}: block ${block} at ${t(where)} claimed-bit ${bit}, resolved off-head ${resolved}`);
        results.push({
            ok: block >= st.frontierBlock && bit && resolved,
            name: `LOT_BLOCK_MARK_${n}`,
            getMethod: 'ledger.getLotBlockAddress + lotBlock.getWords + ledger.isNumberOffHead',
            after: `block ${block} bit ${bit}`,
            detail: 'the mark of a lot beyond the frontier lives on the block’s child, not the ledger (D-196)',
        });
    }
    finish('lot-block-marks', results);
}

/** V28: on a healthy set nothing is parked for `retry_item`, and the collection holds only its floor. */
async function cmdRetryLane(c: Contracts) {
    const next = await retry(() => c.ledger.getNextUnroutedItem(0n), 'getNextUnroutedItem(0)');
    const collAddr = addr('PRIMES_COLLECTION_ADDRESS');
    const bal = await retry(() => c.client.getBalance(collAddr), 'collection balance');
    console.log(`next parked item ${next}; collection balance ${fromNano(bal)} GRAM`);
    finish('retry-item-lane', [
        {
            ok: next === -1n,
            name: 'NOTHING_PARKED',
            getMethod: 'ledger.getNextUnroutedItem(0)',
            after: `${next}`,
            detail: 'every Populate was accepted; retry_item has nothing to do (V28)',
        },
        {
            ok: bal < toNano('1'),
            name: 'COLLECTION_AT_FLOOR',
            getMethod: 'collection balance',
            after: `${fromNano(bal)} GRAM`,
            detail: 'the item confirms the mint, so no held split rests on the collection',
        },
    ]);
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const c = contracts();
    switch (cmd) {
        case 'cards':
            if (!rest.length) throw new Error('usage: g93.ts cards <handle...>');
            return cmdCards(c, rest);
        case 'confirm-sender':
            return cmdConfirmSender(c, Number(rest[0] ?? '100'));
        case 'advance-head':
            return cmdAdvanceHead(c, rest[0] ?? 'F');
        case 'unsold':
            return cmdUnsold(c, rest[0] ?? 'F');
        case 'lot-blocks':
            if (!rest.length) throw new Error('usage: g93.ts lot-blocks <n...>');
            return cmdLotBlocks(c, rest.map((x) => BigInt(x)));
        case 'retry-lane':
            return cmdRetryLane(c);
        default:
            throw new Error('usage: g93.ts cards|confirm-sender|advance-head|unsold|lot-blocks|retry-lane');
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}

