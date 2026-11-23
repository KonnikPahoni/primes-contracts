/**
 * TON PRIMES — GAUNTLET H16: the TEP-66 royalty split, exercised on chain.
 *
 * `DECISIONS.md` D-128 changed two things about a secondary royalty and neither had
 * ever been exercised outside `@ton/sandbox`:
 *
 *   1. `royalty_params()` publishes **the collection's own address**, not
 *      `aux.royaltyDest`. TEP-66 carries ONE destination, so a two-way split cannot be
 *      declared on the wire — it has to happen at the address that IS declared.
 *   2. The collection's catch-all arm stopped being `assert (in.body.isEmpty()) throw 101`
 *      and became the splitter: `ROYALTY_RATCHET_BPS` (50%) of the net to the LEDGER as
 *      `RoyaltyToRatchet#b0000079` (backing, a pure floor step — a royalty is injection
 *      without emission), the remainder to `aux.royaltyDest`, the operator wallet. **That
 *      arm must accept a body with a TEXT COMMENT**, which is the most ordinary thing a
 *      marketplace attaches to a payout and which the old catch-all bounced back.
 *
 * H16 says: *"a real transfer of a minted item on a testnet marketplace (or a hand-built
 * `GetRoyaltyParams` + a royalty-bearing transfer, which is cheaper and proves the same
 * arms)"*. This is the second, and it proves strictly more of the contract than a
 * marketplace would: a marketplace pays the royalty with whatever body it likes, and the
 * comment case is the one that regressed.
 *
 * WHAT IT DOES, in order:
 *
 *   1. reads `royalty_params()` and asserts the destination is the COLLECTION itself
 *      (D-128 point 1 — the whole reason the split is possible);
 *   2. reads `getRoyaltySplit()` and the ledger's `T` (`getFloorNum`) before;
 *   3. sends `GetRoyaltyParams#693d3950` to the collection, the standard request;
 *   4. sends a royalty-bearing payment **with a text comment**, the way a venue would;
 *   5. re-reads `getRoyaltySplit()` and `T`, and asserts BOTH legs moved — `toRatchet`
 *      and `toOperator` up, `forwards` up by one, and `T` up by exactly the ratchet leg.
 *
 * The collection reserves `ROYALTY_STORAGE_FLOOR` (0.5 GRAM, its genesis endowment) and
 * splits the BALANCE ABOVE it less `ROYALTY_FORWARD_GAS` (0.02 GRAM), so the payment has
 * to clear 0.02 GRAM of delivery to forward anything at all. 1 GRAM is the default and
 * leaves ~0.49 GRAM per leg.
 *
 *   npx tsx contracts/scripts/proveRoyaltySplitLive.ts
 *   PRIMES_ROYALTY_TON=2 npx tsx contracts/scripts/proveRoyaltySplitLive.ts
 *
 * Env: `PRIMES_COLLECTION_ADDRESS`, `PRIMES_LEDGER_ADDRESS`, `PRIMES_OPERATOR_ADDR`,
 * `KEEPER_WALLET_MNEMONIC`; the sender defaults to the deploy subwallet.
 */
import { Address, SendMode, TonClient, WalletContractV4, beginCell, internal, toNano } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { deploySubwalletId, hydrateProcessEnv, envValue, loadEnvFile } from './envFile';

// `tsx` loads no `.env` (W10 — fourteen sibling scripts fell through to month-dead
// address defaults before this call existed).
hydrateProcessEnv();

/** TEP-66's standard request opcode. Standard pair: the reply is `report_royalty_params`. */
const OP_GET_ROYALTY_PARAMS = 0x693d3950;

function req(name: string): string {
    const v = (process.env[name] ?? '').trim();
    if (!v) throw new Error(`missing ${name} — see .env and docs/testnet-deployment.md`);
    return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, label: string, attempts = 8): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e: any) {
            last = e;
            console.log(`[retry] ${label} attempt ${i + 1}: ${e?.message ?? e}`);
            await sleep(3000 + i * 2000);
        }
    }
    throw last;
}

async function waitForSeqno(wallet: { getSeqno(): Promise<number> }, from: number, label: string) {
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        let now: number;
        try {
            now = await wallet.getSeqno();
        } catch {
            continue;
        }
        if (now > from) {
            console.log(`  ${label}: sent (seqno ${from} -> ${now})`);
            return;
        }
    }
    throw new Error(`${label}: seqno never advanced past ${from}`);
}

async function main() {
    const env = loadEnvFile();
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: envValue(env, 'TONCENTER_API_KEY_TESTNET') || undefined,
    });

    const collectionAddr = Address.parse(req('PRIMES_COLLECTION_ADDRESS'));
    const ledgerAddr = Address.parse(req('PRIMES_LEDGER_ADDRESS'));
    const operatorAddr = Address.parse(req('PRIMES_OPERATOR_ADDR'));
    const collection = client.open(PrimesCollection.createFromAddress(collectionAddr));
    const ledger = client.open(PrimesLedger.createFromAddress(ledgerAddr));

    const keyPair = await mnemonicToPrivateKey(req('KEEPER_WALLET_MNEMONIC').split(/\s+/));
    const walletId = process.env.PRIMES_FROM_SUBWALLET_ID
        ? Number(process.env.PRIMES_FROM_SUBWALLET_ID)
        : deploySubwalletId(env);
    const wallet = client.open(WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId }));

    const fmt = (a: Address) => a.toString({ testOnly: true });
    console.log('collection:', fmt(collectionAddr));
    console.log('ledger:    ', fmt(ledgerAddr));
    console.log('operator:  ', fmt(operatorAddr));
    console.log('from:      ', fmt(wallet.address), `(subwallet ${walletId ?? '<default>'})`);
    console.log('');

    // --- 1. D-128 point 1: the declared destination IS the collection ---------
    const params = await retry(() => collection.getRoyaltyParams(), 'royalty_params');
    console.log(`royalty_params() = ${params.numerator}/${params.denominator} -> ${fmt(params.destination)}`);
    if (!params.destination.equals(collectionAddr)) {
        throw new Error(
            `royalty_params() names ${fmt(params.destination)}, not the collection. This set does ` +
                'NOT carry D-128 — a marketplace would pay the operator 100% and the ratchet leg ' +
                'could never fire. Redeploy before re-running H16.'
        );
    }
    console.log('  OK — the destination is the collection itself, so the split can happen at it.');

    // --- 2. before ------------------------------------------------------------
    const splitBefore = await retry(() => collection.getRoyaltySplit(), 'getRoyaltySplit(before)');
    const tBefore = await retry(() => ledger.getFloorNum(), 'getFloorNum(before)');
    const operatorBefore = await retry(() => client.getBalance(operatorAddr), 'operator balance(before)');
    console.log('before:', splitBefore, `T=${tBefore}`, `operator=${operatorBefore}`);

    // --- 3. the standard request ---------------------------------------------
    let seqno = await retry(() => wallet.getSeqno(), 'seqno');
    console.log('\n--- GetRoyaltyParams#693d3950 (TEP-66 request) ---');
    await wallet.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [
            internal({
                to: collectionAddr,
                // Gotcha 9: never the exact figure. The reply rides back out of this.
                value: toNano('0.05'),
                bounce: true,
                body: beginCell().storeUint(OP_GET_ROYALTY_PARAMS, 32).storeUint(0, 64).endCell(),
            }),
        ],
    });
    await waitForSeqno(wallet, seqno, 'GetRoyaltyParams');

    // --- 4. the royalty itself, WITH A TEXT COMMENT --------------------------
    //
    // The comment is the point. Before D-128 the catch-all was
    // `assert (in.body.isEmpty()) throw 101`, so this exact message — a payout with a
    // venue's note on it — bounced straight back at the marketplace.
    const royaltyTon = process.env.PRIMES_ROYALTY_TON ?? '1';
    const comment = `H16: TEP-66 secondary royalty, ${new Date().toISOString()}`;
    seqno = await retry(() => wallet.getSeqno(), 'seqno');
    console.log(`\n--- royalty payment: ${royaltyTon} GRAM, body = text comment ---`);
    console.log(`    "${comment}"`);
    await wallet.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [
            internal({
                to: collectionAddr,
                value: toNano(royaltyTon),
                bounce: true,
                body: beginCell().storeUint(0, 32).storeStringTail(comment).endCell(),
            }),
        ],
    });
    await waitForSeqno(wallet, seqno, 'royalty payment');

    // --- 5. after: both legs, or this did not prove what it claims -----------
    console.log('\nwaiting for the three-hop delivery to settle...');
    await sleep(25000);
    const splitAfter = await retry(() => collection.getRoyaltySplit(), 'getRoyaltySplit(after)');
    const tAfter = await retry(() => ledger.getFloorNum(), 'getFloorNum(after)');
    const operatorAfter = await retry(() => client.getBalance(operatorAddr), 'operator balance(after)');
    console.log('after: ', splitAfter, `T=${tAfter}`, `operator=${operatorAfter}`);

    const dRatchet = splitAfter.toRatchetNanoton - splitBefore.toRatchetNanoton;
    const dOperator = splitAfter.toOperatorNanoton - splitBefore.toOperatorNanoton;
    const dForwards = splitAfter.forwards - splitBefore.forwards;
    const dT = tAfter - tBefore;
    console.log('');
    console.log(`  toRatchet  += ${dRatchet} nanoton`);
    console.log(`  toOperator += ${dOperator} nanoton`);
    console.log(`  forwards   += ${dForwards}`);
    console.log(`  ledger T   += ${dT} nanoton  (the ratchet leg, as backing — a pure floor step)`);
    console.log(`  operator   += ${operatorAfter - operatorBefore} nanoton (gross of that wallet's own rent)`);

    const fail: string[] = [];
    if (dForwards !== 1) fail.push(`forwards moved by ${dForwards}, expected exactly 1`);
    if (dRatchet <= 0n) fail.push('the RATCHET leg did not move — D-128 point 2 is not doing anything');
    if (dOperator <= 0n) fail.push('the OPERATOR leg did not move');
    // D-114: one multiplication and one subtraction, so the two legs sum to the net
    // exactly and the truncated remainder falls to the RATCHET, never to the operator.
    if (dRatchet < dOperator) {
        fail.push(`the remainder fell to the operator (${dOperator}) over the ratchet (${dRatchet}) — D-114 inverted`);
    }
    if (dT !== dRatchet) fail.push(`T moved ${dT} but the ratchet leg was ${dRatchet} — the backing did not land`);

    if (fail.length > 0) {
        console.log('\nFAILED:');
        for (const f of fail) console.log(`  !! ${f}`);
        process.exit(1);
    }
    console.log('\nH16 PROVEN: both D-128 legs fired on chain, from a payment carrying a text comment.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
