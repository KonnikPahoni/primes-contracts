/**
 * TON PRIMES — testnet utility: move GRAM between subwallets of the keeper
 * mnemonic (skew-safe signing, same pattern as scriptHost.ts).
 * Used to fund a fresh deploy subwallet per genesis cycle — see the walletId
 * note in scriptHost.ts for why each cycle wants a fresh one.
 *
 * Env:
 *   PRIMES_TRANSFER_TO_SUBWALLET_ID — destination subwallet id (required)
 *   PRIMES_TRANSFER_TON             — amount in GRAM (required)
 *   PRIMES_FROM_SUBWALLET_ID        — source subwallet id (default: wallet v4 default)
 *
 *   ../bot/node_modules/.bin/tsx scripts/transferTon.ts
 */
import fs from 'fs';
import path from 'path';
import { SendMode, TonClient, WalletContractV4, internal, toNano } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';

const REPO = path.resolve(__dirname, '..', '..');

async function main() {
    const toId = Number(process.env.PRIMES_TRANSFER_TO_SUBWALLET_ID);
    const amountTon = process.env.PRIMES_TRANSFER_TON;
    if (!toId || !amountTon) throw new Error('PRIMES_TRANSFER_TO_SUBWALLET_ID and PRIMES_TRANSFER_TON are required');

    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const mnemonic = envFile
        .match(/^DEPLOYER_MNEMONIC=(.*)$/m)![1]
        .trim()
        .replace(/^"|"$/g, '')
        .split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const fromId = process.env.PRIMES_FROM_SUBWALLET_ID ? Number(process.env.PRIMES_FROM_SUBWALLET_ID) : undefined;
    const from = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId: fromId });
    const to = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId: toId });

    const apiKey = (envFile.match(/^TONCENTER_API_KEY_TESTNET=(.*)$/m)?.[1] ?? '').trim();
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: apiKey || undefined,
    });
    const wc = client.open(from);
    console.log('from:', from.address.toString({ testOnly: true }));
    console.log('to:  ', to.address.toString({ testOnly: true }), `(subwallet ${toId})`);

    // 2026-09-17 (MISTAKES.md): a transfer this wallet cannot afford fails in the ACTION
    // phase, silently — the external is accepted, the seqno increments, and the poll below
    // therefore reports success for a transfer that moved nothing. The seqno is not a
    // receipt. Check the balance before signing, since it is the one thing that makes the
    // difference visible; PAY_GAS_SEPARATELY means the fee is on top of `amountTon`.
    const balance = await client.getBalance(from.address);
    if (balance < toNano(amountTon) + toNano('0.05')) {
        throw new Error(
            `${from.address.toString({ testOnly: true })} holds ${Number(balance) / 1e9} GRAM, ` +
                `short of ${amountTon} GRAM plus fees. A transfer it cannot afford fails in the ` +
                `action phase while the seqno still advances, so this would report success.`
        );
    }

    const seqno = await wc.getSeqno();
    await wc.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        timeout: Math.floor(Date.now() / 1000) + 600, // clock-skew workaround
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        // bounce=false: the destination subwallet is uninitialized until its own
        // first outgoing transfer deploys it — a bounceable transfer comes back.
        messages: [internal({ to: to.address, value: toNano(amountTon), bounce: false })],
    });
    let cur = seqno;
    for (let i = 0; cur === seqno && i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        cur = await wc.getSeqno();
    }
    if (cur === seqno) throw new Error('transfer not confirmed');
    console.log(`sent ${amountTon} GRAM, seqno ${seqno} -> ${cur}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
