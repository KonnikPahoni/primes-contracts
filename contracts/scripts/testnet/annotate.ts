/**
 * TON PRIMES — naming, both halves (§4.7.1, D-212).
 *
 * `name` — the CURRENT OWNER of a minted number names it through the collection's
 * `name_number`, paying `nameFee` the first time and `renameFee` after, in GRAM; the fee
 * goes to the ratchet floor (`T` rises by exactly the fee, `S` does not). Any refusal
 * refunds the whole value.
 *
 * `free` / `paid` — an ERA TROPHY's engraving on the registrar: the first free, every
 * later one `renameFee`.
 *
 * The script decides on its read BEFORE it sends (CLAUDE.md): the owner, the count and
 * the fee are read first, and a send the contract would only refund is not made.
 *
 *   npx tsx contracts/scripts/testnet/annotate.ts who <handle>
 *   npx tsx contracts/scripts/testnet/annotate.ts name <n> <handle> "<text>"
 *   npx tsx contracts/scripts/testnet/annotate.ts free <trophy> <handle> "<text>"
 *   npx tsx contracts/scripts/testnet/annotate.ts paid <trophy> <handle> "<text>"
 */
import { Address, beginCell, toNano } from '@ton/core';
import { PrimesItem } from '../../wrappers/PrimesItem';
import { PrimesCollection } from '../../wrappers/PrimesCollection';
import { NAME_RELAY_GAS_NANOTON, REG_RENAME_GAS_NANOTON } from '../../../shared/messages';
import { retry } from './sender';
import { addr, contracts, walletFor, type Contracts } from './chain';
import * as A from './assert';
import { fromAsserts, record } from './journal';

const ton = (v: bigint) => (Number(v) / 1e9).toFixed(4) + ' GRAM';

function collectionOf(c: Contracts) {
    return c.client.open(PrimesCollection.createFromAddress(addr('PRIMES_COLLECTION_ADDRESS')));
}

const textCell = (s: string) => beginCell().storeStringTail(s).endCell();

/**
 * WHERE the pen lives. An era trophy's is the registrar's (`getTrophy` /
 * `getTrophyAnnotation`, eight rows at most); a number's own name is its item's
 * (`getNamer()` = the current owner, `getAnnotation()`). An unminted number has neither.
 */
async function namerOf(c: Contracts, n: bigint): Promise<Address | null> {
    if (PRIMORIALS.has(n)) return (await retry(() => c.registrar.getTrophy(n), `getTrophy(${n})`)).holder;
    const item = await itemOf(c, n);
    return item ? retry(() => item.getNamer(), `item(${n}).getNamer`) : null;
}

async function annotationOf(c: Contracts, n: bigint): Promise<{ count: number }> {
    if (PRIMORIALS.has(n)) return retry(() => c.registrar.getTrophyAnnotation(n), `getTrophyAnnotation(${n})`);
    const item = await itemOf(c, n);
    return item ? retry(() => item.getAnnotation(), `item(${n}).getAnnotation`) : { count: 0 };
}

async function itemOf(c: Contracts, n: bigint) {
    const a = await retry(() => c.ledger.getItemAddress(n), `getItemAddress(${n})`);
    if (!(await retry(() => c.client.isContractDeployed(a), `deployed(${n})`))) return null;
    return c.client.open(PrimesItem.createFromAddress(a));
}

const whereAnnotated = (n: bigint) =>
    PRIMORIALS.has(n) ? `registrar.getTrophyAnnotation(${n})` : `item(${n}).getAnnotation()`;

/** Which numbers is this handle the namer of? The gate on both arms. */
async function cmdWho(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const head = await retry(() => c.ledger.getHead(), 'getHead');
    console.log(`${handle} = ${w.wallet.address.toString({ testOnly: true })}`);
    const owned: bigint[] = [];
    for (let n = 2n; n < head; n++) {
        const namer = await namerOf(c, n);
        if (namer && namer.equals(w.wallet.address)) {
            const a = await annotationOf(c, n);
            console.log(`  names ${n}  annotation count ${a.count}`);
            owned.push(n);
        }
    }
    if (owned.length === 0) {
        console.log(
            `  names nothing IN 2..${head} — but that walk is the SEQUENTIAL LINE ONLY, and an auction ` +
                'mints OFF-HEAD (D-45/D-90), so a prime won from a lot can never appear here. The market ' +
                'publishes no lot enumeration — `getLot` is keyed by `n` — so there is nothing to walk. ' +
                'If this handle won a prime lot, pass that `n` to `free`/`paid` explicitly rather than `-`.'
        );
    }
    return owned;
}

/** §7's eight era trophies — the only numbers the registrar's free arm will name (914 otherwise). */
const PRIMORIALS = new Set([6n, 30n, 210n, 2310n, 30030n, 510510n, 9699690n, 223092870n]);

async function cmdFree(c: Contracts, n: bigint, handle: string, text: string) {
    if (!PRIMORIALS.has(n)) {
        throw new Error(
            `${n} is not an era trophy. D-179: only a primorial's first engraving is free; the registrar ` +
                'refunds anything else. Name a number you own with `name`.'
        );
    }
    const w = await walletFor(c.client, handle);
    const namer = await namerOf(c, n);
    if (!namer || !namer.equals(w.wallet.address)) {
        throw new Error(
            `${handle} is not the namer of ${n} (getNamer = ${namer?.toString({ testOnly: true }) ?? 'none'}) — ` +
                'the registrar would only refund it.'
        );
    }
    const before = await annotationOf(c, n);
    await c.registrar.sendAnnotate(w.sender, { n, text: textCell(text), value: toNano('0.15') });
    await new Promise((r) => setTimeout(r, 25_000));
    const after = await annotationOf(c, n);
    const results: A.AssertResult[] = [
        {
            ok: after.count === 1,
            name: 'ANNOTATION_FREE_FIRST',
            getMethod: whereAnnotated(n),
            before: `count ${before.count}`,
            after: `count ${after.count}`,
            detail: '§4.7.1 / D-179: an era trophy\'s first engraving costs nothing and sets count to 1',
        },
    ];
    record({ phase: '4', op: `annotate-free-${n}`, ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** D-212: name number `n` you own, through the collection, for the fee `getNaming()` names. */
async function cmdName(c: Contracts, n: bigint, handle: string, text: string) {
    const w = await walletFor(c.client, handle);
    const item = await itemOf(c, n);
    if (!item) throw new Error(`${n} has no item (never minted) — the collection would bounce and refund. Nothing is sent.`);
    const owner = await retry(() => item.getNamer(), `item(${n}).getNamer`);
    if (!owner || !owner.equals(w.wallet.address)) {
        throw new Error(`${handle} does not own ${n} — the item would refund. Nothing is sent.`);
    }
    const collection = collectionOf(c);
    const book = await retry(() => collection.getNaming(), 'getNaming');
    const before = await retry(() => item.getAnnotation(), `item(${n}).getAnnotation`);
    const fee = before.count === 0 ? book.nameFee : book.renameFee;
    const T0 = await retry(() => c.ledger.getFloorNum(), 'getFloorNum');
    console.log(`${handle} naming ${n} for ${ton(fee)} (${before.count === 0 ? 'first naming' : 'rename'})`);
    // CLAUDE.md: nominal plus a margin, never the exact figure. The change comes home.
    await collection.sendNameNumber(w.sender, { n, text: textCell(text), value: fee + NAME_RELAY_GAS_NANOTON + toNano('0.05') });
    await new Promise((r) => setTimeout(r, 45_000));
    const after = await retry(() => item.getAnnotation(), `item(${n}).getAnnotation`);
    const T1 = await retry(() => c.ledger.getFloorNum(), 'getFloorNum');
    const results: A.AssertResult[] = [
        {
            ok: after.count === before.count + 1,
            name: 'NAMING_LANDED',
            getMethod: `item(${n}).getAnnotation()`,
            before: `count ${before.count}`,
            after: `count ${after.count}`,
            detail: 'D-212: the owner names; the count moves by one',
        },
        {
            ok: T1 - T0 >= fee,
            name: 'NAMING_FEE_TO_FLOOR',
            getMethod: 'ledger.getFloorNum()',
            before: ton(T0),
            after: ton(T1),
            detail: `D-212: T rises by the fee (${ton(fee)}); other mints may add more in the same window`,
        },
    ];
    record({ phase: '4', op: `name-${n}`, ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/** D-212: an era trophy's PAID re-engraving on the registrar, for `renameFee`. */
async function cmdPaid(c: Contracts, n: bigint, handle: string, text: string) {
    if (!PRIMORIALS.has(n)) throw new Error(`${n} is not an era trophy — name a number with \`name\`.`);
    const w = await walletFor(c.client, handle);
    const holder = await namerOf(c, n);
    if (!holder || !holder.equals(w.wallet.address)) {
        throw new Error(`${handle} does not hold trophy ${n} — the registrar would refund. Nothing is sent.`);
    }
    const before = await annotationOf(c, n);
    if (before.count === 0) throw new Error(`trophy ${n} has no engraving yet — the first is free: use \`free\`.`);
    const fee = await retry(() => c.registrar.getTrophyRenameFee(), 'getTrophyRenameFee');
    await c.registrar.sendAnnotate(w.sender, { n, text: textCell(text), value: fee + REG_RENAME_GAS_NANOTON + toNano('0.05') });
    await new Promise((r) => setTimeout(r, 45_000));
    const after = await annotationOf(c, n);
    const results: A.AssertResult[] = [
        {
            ok: after.count === before.count + 1,
            name: 'TROPHY_REENGRAVED',
            getMethod: whereAnnotated(n),
            before: `count ${before.count}`,
            after: `count ${after.count}`,
            detail: `D-212: a re-engraving costs ${ton(fee)}, paid to the floor`,
        },
    ];
    record({ phase: '4', op: `annotate-paid-${n}`, ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const c = contracts();
    if (cmd === 'who') return void (await cmdWho(c, rest[0] ?? 'A'));
    if (cmd === 'free' || cmd === 'paid' || cmd === 'name') {
        if (!rest[0] || !rest[1]) throw new Error(`usage: annotate.ts ${cmd} <n|-> <handle> "<text>"`);
        const handle = rest[1];
        // `-` means "whatever this handle actually names ON THE SEQUENTIAL LINE". `cmdWho`
        // walks 2..head, and that is the only domain any get-method makes walkable: the market
        // keys `getLot` by `n` and enumerates nothing. A prime won from a LOT is minted
        // OFF-HEAD (D-45/D-90) and is therefore invisible to `-` by construction — name it
        // explicitly. Phase 7 does, with the same literal it passes to `lot.ts close`.
        const n = rest[0] === '-' ? (await cmdWho(c, handle))[0] : BigInt(rest[0]);
        if (n === undefined) {
            throw new Error(
                `${handle} names no number, so there is nothing to annotate. §4.7.1's naming right ` +
                    'is granted by a PRIME mint — close the prime lot (phase 7) or buy one from the ' +
                    'descending lane (proveDutchBuyLive.ts) first.'
            );
        }
        const text = rest[2] ?? `annotated by ${handle} on the gauntlet run`;
        if (cmd === 'name') return cmdName(c, n, handle, text);
        return cmd === 'free' ? cmdFree(c, n, handle, text) : cmdPaid(c, n, handle, text);
    }
    console.log('usage: annotate.ts who <handle> | name <n|-> <handle> "<text>" | free <trophy> <handle> "<text>" | paid <trophy> <handle> "<text>"');
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
