/**
 * TON PRIMES — GAUNTLET X9: the permissionless item top-up, witnessed on chain.
 *
 * `X3` built the control and its five tests, then closed saying it *"needs no redeploy —
 * the opcode has been live since D-62 — so this is provable on the current testnet set by
 * any iteration that wants it."* The first half is true and the second is not:
 * `top_up#c1000006` and `getStorageRunway()` both run **on an item contract**, and an item
 * is deployed **by a mint**. So the proof waits on an ignited set with a mint on it, which
 * is the only thing X9 is actually blocked by.
 *
 * **The interesting half is the permissionlessness**, so this sends from a wallet that does
 * NOT own the number — a freshly derived mnemonic that has never appeared in this repo,
 * funded with the bare minimum from the keeper. A sender check would fail that call with an
 * authorization error; getting the runway extended instead is the proof.
 *
 * **A COMPOSITE, not a prime.** A prime item is endowed differently at mint (its `owed`
 * dictionary lives on it), so its runway is the wrong subject — X9 says so explicitly. The
 * script refuses a prime rather than reporting a misleading pass.
 *
 *   npx tsx contracts/scripts/proveItemTopUpLive.ts            # defaults to n = 4
 *   PRIMES_TOPUP_N=8 npx tsx contracts/scripts/proveItemTopUpLive.ts
 *
 * Env: `PRIMES_COLLECTION_ADDRESS`, `DEPLOYER_MNEMONIC`; the funder defaults to the
 * deploy subwallet, which is what the D-95 smoke mint leaves holding number 4.
 */
import { Address, SendMode, TonClient, WalletContractV4, internal, toNano } from '@ton/ton';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesItem } from '../wrappers/PrimesItem';
import { deploySubwalletId, envValue, hydrateProcessEnv, loadEnvFile } from './envFile';

hydrateProcessEnv();

/** Enough to cover the stranger's own gas and still leave a visible top-up. */
const FLOAT_TON = '0.3';
const TOPUP_TON = '0.15';

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

    const n = BigInt(process.env.PRIMES_TOPUP_N ?? '4');
    const collection = client.open(PrimesCollection.createFromAddress(Address.parse(req('PRIMES_COLLECTION_ADDRESS'))));
    const itemAddr = await retry(() => collection.getNftAddressByIndex(n), 'get_nft_address_by_index');
    const item = client.open(PrimesItem.createFromAddress(itemAddr));

    const fmt = (a: Address) => a.toString({ testOnly: true });
    console.log(`n = ${n}`);
    console.log('item:', fmt(itemAddr));

    const data = await retry(() => item.getNumberData(), 'getNumberData');
    console.log('getNumberData():', { ...data, owner: fmt(data.owner) });
    if (data.isPrime) {
        throw new Error(
            `n = ${n} is PRIME. A prime item carries its own \`owed\` dictionary and is endowed ` +
                'differently at mint, so its runway is the wrong subject (X9). Pass a composite ' +
                'through PRIMES_TOPUP_N.'
        );
    }

    const runwayBefore = await retry(() => item.getStorageRunway(), 'getStorageRunway(before)');
    const balanceBefore = await retry(() => client.getBalance(itemAddr), 'item balance(before)');
    console.log(`before: runway = ${runwayBefore}s, balance = ${balanceBefore} nanoton`);

    // --- a stranger, generated here and funded with the bare minimum ----------
    const strangerMnemonic = await mnemonicNew();
    const strangerKeys = await mnemonicToPrivateKey(strangerMnemonic);
    const stranger = client.open(WalletContractV4.create({ workchain: 0, publicKey: strangerKeys.publicKey }));
    console.log('\nstranger (fresh mnemonic, holds no role in this deployment):', fmt(stranger.address));
    if (stranger.address.equals(data.owner)) throw new Error('impossible collision with the owner');

    const funderKeys = await mnemonicToPrivateKey(req('DEPLOYER_MNEMONIC').split(/\s+/));
    const funder = client.open(
        WalletContractV4.create({
            workchain: 0,
            publicKey: funderKeys.publicKey,
            walletId: process.env.PRIMES_FROM_SUBWALLET_ID
                ? Number(process.env.PRIMES_FROM_SUBWALLET_ID)
                : deploySubwalletId(env),
        })
    );
    let seqno = await retry(() => funder.getSeqno(), 'funder seqno');
    await funder.sendTransfer({
        seqno,
        secretKey: funderKeys.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to: stranger.address, value: toNano(FLOAT_TON), bounce: false, body: undefined })],
    });
    await waitForSeqno(funder, seqno, `float ${FLOAT_TON} GRAM to the stranger`);
    await sleep(8000);

    // --- the top-up itself, from that stranger -------------------------------
    console.log(`\n--- top_up#c1000006, ${TOPUP_TON} GRAM, from a wallet that owns nothing ---`);
    const strangerSender = stranger.sender(strangerKeys.secretKey);
    seqno = await retry(() => stranger.getSeqno(), 'stranger seqno');
    await item.sendTopUp(strangerSender, { value: toNano(TOPUP_TON) });
    await waitForSeqno(stranger, seqno, 'top_up');

    console.log('\nwaiting for the item to settle...');
    await sleep(20000);
    const runwayAfter = await retry(() => item.getStorageRunway(), 'getStorageRunway(after)');
    const balanceAfter = await retry(() => client.getBalance(itemAddr), 'item balance(after)');
    console.log(`after:  runway = ${runwayAfter}s, balance = ${balanceAfter} nanoton`);
    console.log(`  runway  += ${runwayAfter - runwayBefore}s`);
    console.log(`  balance += ${balanceAfter - balanceBefore} nanoton`);

    const fail: string[] = [];
    if (balanceAfter <= balanceBefore) fail.push('the item did not gain GRAM — the top_up was refused or bounced');
    if (runwayAfter <= runwayBefore) fail.push(`the runway did not rise (${runwayBefore} -> ${runwayAfter})`);
    if (fail.length > 0) {
        console.log('\nFAILED:');
        for (const f of fail) console.log(`  !! ${f}`);
        process.exit(1);
    }
    console.log('\nX9 PROVEN: a wallet that owns nothing extended the item\'s storage runway.');
    console.log(`stranger mnemonic (throwaway, testnet, holds ~${FLOAT_TON} GRAM of dust): ${strangerMnemonic.join(' ')}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
