/**
 * TON PRIMES — the collection's TEP-66 royalty, read and asked.
 *
 * `proveRoyaltySplitLive.ts` proves the NUMBERS collection's TEP-66 royalty split
 * (D-128: 5% to the COLLECTION, which then splits it). This driver reads the
 * published destination and SENDS the standard `get_royalty_params#693d3950`
 * message, the half a marketplace speaks from a contract. (The constellations and
 * generators collections it also covered were deleted by DECISIONS.md D-202.)
 *
 *   npx tsx contracts/scripts/testnet/collections.ts royalty            # read it
 *   npx tsx contracts/scripts/testnet/collections.ts ask [handle]       # SEND the standard message
 */
import { Address, beginCell, toNano } from '@ton/core';
import { PrimesCollection } from '../../wrappers/PrimesCollection';
import { COLLECTION } from '../../../shared/opcodes';
import { retry } from './sender';
import { addr, contracts, walletFor, type Contracts } from './chain';
import * as A from './assert';
import { fromAsserts, record } from './journal';

/** D-128: the numbers collection publishes ITSELF, because it splits the royalty. */
const COLLECTIONS = [{ name: 'numbers', envVar: 'PRIMES_COLLECTION_ADDRESS', splits: true }] as const;

/** D-128: where a marketplace is told to pay, per collection, and why. */
async function cmdRoyalty(c: Contracts) {
    const results: A.AssertResult[] = [];
    for (const col of COLLECTIONS) {
        const a = addr(col.envVar);
        const open = c.client.open(PrimesCollection.createFromAddress(a));
        const r: { numerator: number; denominator: number; destination: Address } = await retry(
            () => open.getRoyaltyParams(),
            `${col.name}.getRoyaltyParams`
        );
        const dest = r.destination;
        const pct = (Number(r.numerator) / Number(r.denominator)) * 100;
        const expected = col.splits ? a : addr('PRIMES_OPERATOR_ADDR');
        console.log(
            `${col.name.padEnd(15)} ${r.numerator}/${r.denominator} (${pct.toFixed(2)}%) → ` +
                dest.toString({ testOnly: true }) +
                (col.splits ? '  (itself — it splits)' : '  (operator — D-128 pt 3)')
        );
        results.push({
            ok: dest.equals(expected),
            name: `ROYALTY_DEST_${col.name.toUpperCase()}`,
            getMethod: `${col.name} collection royalty_params`,
            before: expected.toString({ testOnly: true }),
            after: dest.toString({ testOnly: true }),
            detail: col.splits
                ? `D-128 pt 1: publishes ITSELF at ${pct.toFixed(2)}%, so a marketplace pays the ` +
                  'contract that knows how to split ratchet/operator'
                : `D-128 pt 3: publishes the OPERATOR at ${pct.toFixed(2)}% — a constellation touches ` +
                  'neither S nor T, so its resale royalty is deliberately not a floor inflow',
        });
    }
    record({ phase: '9', op: 'royalty-params', ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

/**
 * The same question as a MESSAGE, which is the half that has never run. Each
 * collection must answer `report_royalty_params#a8cb00ad` and, crucially, must
 * not abort: a marketplace sends this from a contract, and an aborted reply is
 * how a collection becomes unlistable while every get-method still reads right.
 */
async function cmdAsk(c: Contracts, handle: string) {
    const w = await walletFor(c.client, handle);
    const results: A.AssertResult[] = [];
    for (const col of COLLECTIONS) {
        const a = addr(col.envVar);
        console.log(`asking ${col.name} for its royalty params, from ${handle}...`);
        await w.sender.send({
            to: a,
            value: toNano('0.05'),
            bounce: true,
            body: beginCell().storeUint(COLLECTION.get_royalty_params, 32).storeUint(0, 64).endCell(),
        });
        await new Promise((r) => setTimeout(r, 15_000));
        results.push({
            ok: true,
            name: `ASKED_${col.name.toUpperCase()}`,
            getMethod: `${col.name} collection, op 0x${COLLECTION.get_royalty_params.toString(16)}`,
            detail:
                'sent; the ANSWER is judged by txAudit.ts over this window — an aborted reply is ' +
                'invisible to every balance and get-method check',
        });
    }
    record({ phase: '9', op: 'ask-royalty-params', ok: true, asserts: fromAsserts(results) });
    A.print(results);
    console.log('\nnow run: npx tsx contracts/scripts/testnet/txAudit.ts --since 1h');
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const c = contracts();
    if (!cmd || cmd === 'royalty') return cmdRoyalty(c);
    if (cmd === 'ask') return cmdAsk(c, rest[0] ?? 'F');
    console.log('usage: collections.ts royalty | ask [handle]');
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e?.message ?? e);
        process.exit(1);
    });
}
