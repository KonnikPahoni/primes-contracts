/**
 * Fund wallets from the deploy subwallet, on testnet.
 *
 * The acceptance pass (`docs/audit/testnet-run-2026-09-14.md`) needs a float in a dozen places:
 * the cast wallets `A`/`B`/`C`/`R1..R6`, and the default keeper wallet that the
 * older prove* scripts send from. Owner TON arrives at ONE address — the deploy
 * subwallet named by `PRIMES_DEPLOY_SUBWALLET_ID` — so everything else is funded
 * from here rather than by asking for another transfer.
 *
 *   npx tsx scripts/fundLive.ts <address> <ton> [<address> <ton> ...]
 *
 * Idempotent by TOP-UP, not by transfer: the amount is a target balance, and a
 * recipient already at or above it is skipped. Re-running after a partial failure
 * therefore finishes the job instead of double-paying.
 */
import fs from 'fs';
import path from 'path';
import { Address, SendMode, TonClient, WalletContractV4, internal, fromNano, toNano } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';

const REPO = path.resolve(__dirname, '..', '..');
const TESTNET_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';

// Left in the funder after a batch, so it can still pay for the next one.
const FUNDER_RESERVE = toNano('0.5');

async function retry<T>(fn: () => Promise<T>, label: string, n = 6): Promise<T> {
    for (let i = 0; i < n - 1; i++) {
        try {
            return await fn();
        } catch (e: any) {
            console.log(`[retry] ${label} attempt ${i + 1}: ${e?.message ?? e}`);
            await new Promise((r) => setTimeout(r, 3000 + i * 2000));
        }
    }
    return fn();
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.length % 2 !== 0) {
        throw new Error('usage: tsx scripts/fundLive.ts <address> <ton> [<address> <ton> ...]');
    }
    const targets = [];
    for (let i = 0; i < args.length; i += 2) {
        targets.push({ address: Address.parse(args[i]), target: toNano(args[i + 1]) });
    }

    // /\r?\n/, not '\n' — \r is a line terminator to JS regex but not to a
    // Windows .env, and a trailing \r poisons every value (see genesisPrep.ts).
    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const env = new Map<string, string>();
    for (const line of envFile.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) env.set(m[1], m[2].trim().replace(/^"|"$/g, ''));
    }

    const keyPair = await mnemonicToPrivateKey(env.get('KEEPER_WALLET_MNEMONIC')!.split(/\s+/));
    const client = new TonClient({
        endpoint: TESTNET_ENDPOINT,
        apiKey: env.get('TONCENTER_API_KEY_TESTNET') || undefined,
    });
    const funder = client.open(
        WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
            walletId: Number(env.get('PRIMES_DEPLOY_SUBWALLET_ID')),
        })
    );

    let funderBal = await retry(() => client.getBalance(funder.address), 'funder-balance');
    console.log(`funder ${funder.address.toString()} ${fromNano(funderBal)} TON\n`);

    for (const t of targets) {
        const have = await retry(() => client.getBalance(t.address), `balance(${t.address})`);
        if (have >= t.target) {
            console.log(`skip  ${t.address.toString()} already ${fromNano(have)} TON (target ${fromNano(t.target)})`);
            continue;
        }
        const amount = t.target - have;
        if (funderBal - amount < FUNDER_RESERVE) {
            throw new Error(
                `funder short: sending ${fromNano(amount)} TON would leave ${fromNano(funderBal - amount)}, ` +
                    `below the ${fromNano(FUNDER_RESERVE)} reserve`
            );
        }

        const seqno = await retry(() => funder.getSeqno(), 'getSeqno');
        await retry(
            () =>
                funder.sendTransfer({
                    seqno,
                    secretKey: keyPair.secretKey,
                    timeout: Math.floor(Date.now() / 1000) + 600,
                    sendMode: SendMode.PAY_GAS_SEPARATELY,
                    // bounce:false — most of the cast are uninitialised wallets, and a
                    // bounceable transfer to one comes straight back.
                    messages: [internal({ to: t.address, value: amount, bounce: false })],
                }),
            'sendTransfer'
        );
        let cur = seqno;
        for (let i = 0; cur === seqno && i < 60; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            cur = await retry(() => funder.getSeqno(), 'poll-getSeqno');
        }
        if (cur === seqno) throw new Error(`external not confirmed funding ${t.address.toString()}`);
        console.log(`sent  ${fromNano(amount)} TON -> ${t.address.toString()} (target ${fromNano(t.target)})`);
        funderBal -= amount;
    }

    console.log(`\nfunder left with ${fromNano(await retry(() => client.getBalance(funder.address), 'final'))} TON`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
