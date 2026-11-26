/**
 * TON PRIMES — live TESTNET mint with §4.1's SEVENTH LINE ON. **Testnet only, enforced.**
 *
 * DECISIONS.md D-202, D-215: mint the head with `inviteCount = <number of addresses>` (1..the
 * live count) and confirm each named address receives one transfer of the live value, whole, from the LEDGER carrying
 * the comment (`shared/invites.ts` `inviteCommentText(words)`, words read off the ledger — D-211). There is no signed list any
 * more: the minter names the recipients.
 *
 *   npx tsx scripts/proveInviteMintLive.ts <addr1> [addr2 ...]
 *
 * Same testnet guard, sender and env handling as smokeMintLive.ts, which this is otherwise
 * a copy of; see it for D-95 and for why the message carries the price PLUS a margin.
 */
import fs from 'fs';
import path from 'path';
import { Address, SendMode, TonClient, WalletContractV4, internal } from '@ton/ton';
import { MINT_VALUE_NANOTON, FEE_MARGIN_NANOTON } from '../../shared/values';
import type { Sender, SenderArguments } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesLedger, isqrt, inviteCommentText } from '../wrappers/PrimesLedger';

import { hydrateProcessEnv } from './envFile';

// W10: `tsx` loads no `.env`, and every `process.env.PRIMES_*_ADDRESS` read below
// otherwise falls through to a hardcoded address from a genesis that is months dead
// — silently, because a dead-but-still-answering contract returns plausible numbers
// rather than an error. `hydrateProcessEnv()` is the one reader that ends that; it
// never overwrites a var the shell already set.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
const TESTNET_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';

/** D-95, as in smokeMintLive.ts: two independent checks, either alone defeatable by an edit. */
function assertTestnetOnly(endpoint: string): void {
    if (!/(^|[./])testnet\./.test(endpoint)) {
        throw new Error(`D-95: this script is testnet-only and ${endpoint} is not a testnet endpoint.`);
    }
    const declared = (process.env.PRIMES_NETWORK ?? process.env.TON_NETWORK ?? '').trim().toLowerCase();
    if (declared === 'mainnet') throw new Error('D-95: PRIMES_NETWORK/TON_NETWORK says mainnet.');
}

function factorize(n: bigint): { prime: bigint; exponent: number }[] {
    const out: { prime: bigint; exponent: number }[] = [];
    let rem = n;
    for (let d = 2n; d * d <= rem; d++) {
        if (rem % d === 0n) {
            let e = 0;
            while (rem % d === 0n) {
                rem /= d;
                e++;
            }
            out.push({ prime: d, exponent: e });
        }
    }
    if (rem > 1n) out.push({ prime: rem, exponent: 1 });
    return out;
}

async function retry<T>(fn: () => Promise<T>, label: string, attempts = 8): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e: any) {
            console.log(`[retry] ${label} attempt ${i + 1}: ${e?.message ?? e}`);
            await new Promise((r) => setTimeout(r, 3000 + i * 2000));
        }
    }
    return fn();
}

function fromEnvFile(envFile: string, key: string): string | undefined {
    return envFile.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim();
}

async function main() {
    const recipients = process.argv.slice(2);
    if (recipients.length < 1) {
        throw new Error('usage: tsx scripts/proveInviteMintLive.ts <addr1> [addr2 ...]');
    }
    const addresses = new Map(recipients.map((a, i) => [i + 1, Address.parse(a)]));

    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const mnemonic = fromEnvFile(envFile, 'DEPLOYER_MNEMONIC')!.replace(/^"|"$/g, '').split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const subwallet = process.env.PRIMES_DEPLOY_SUBWALLET_ID ?? fromEnvFile(envFile, 'PRIMES_DEPLOY_SUBWALLET_ID');
    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
        walletId: subwallet ? Number(subwallet) : undefined,
    });
    const apiKey = fromEnvFile(envFile, 'TONCENTER_API_KEY_TESTNET') ?? '';
    const ledgerAddr = process.env.PRIMES_LEDGER_ADDRESS ?? fromEnvFile(envFile, 'PRIMES_LEDGER_ADDRESS')!;

    assertTestnetOnly(TESTNET_ENDPOINT);
    const client = new TonClient({ endpoint: TESTNET_ENDPOINT, apiKey: apiKey || undefined });
    const walletContract = client.open(wallet);
    const balance = await retry(() => walletContract.getBalance(), 'getBalance');
    console.log(`wallet ${wallet.address.toString()} balance ${balance}`);

    const sender: Sender = {
        address: wallet.address,
        async send(args: SenderArguments) {
            const seqno = await retry(() => walletContract.getSeqno(), 'getSeqno');
            await retry(
                () =>
                    walletContract.sendTransfer({
                        seqno,
                        secretKey: keyPair.secretKey,
                        timeout: Math.floor(Date.now() / 1000) + 600,
                        sendMode: SendMode.PAY_GAS_SEPARATELY,
                        messages: [
                            internal({
                                to: args.to,
                                value: args.value,
                                bounce: args.bounce ?? undefined,
                                body: args.body ?? undefined,
                                init: args.init ?? undefined, // D-191: a first mint deploys the minter card
                            }),
                        ],
                    }),
                'sendTransfer'
            );
            let cur = seqno;
            for (let i = 0; cur === seqno && i < 60; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                cur = await retry(() => walletContract.getSeqno(), 'poll-getSeqno');
            }
            if (cur === seqno) throw new Error(
                    'external not confirmed after ~5 minutes of seqno polling. The usual cause is a ' +
                        'wallet that cannot afford the value this message attaches — an unaffordable send ' +
                        'fails in the action phase (or is dropped) and never advances the seqno. Check the ' +
                        'balance first, then clock skew. (MISTAKES.md 2026-09-17.)'
                );
            console.log(`[confirmed] seqno=${cur}`);
        },
    };

    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(ledgerAddr)));
    const terms = await retry(() => ledger.getInviteTerms(), 'getInviteTerms');
    console.log(`invite terms: up to ${terms.count} x ${terms.value} nanoGRAM (fee allowance ${terms.sendFee} each)`);
    // Decide on the read before sending (CLAUDE.md): over the live count the ledger throws 221.
    if (recipients.length > terms.count) {
        throw new Error(`the ledger's live invite count is ${terms.count}; ${recipients.length} recipients would be refused (221). Nothing sent.`);
    }

    const n = await retry(() => ledger.getHead(), 'getHead');
    const factors = factorize(n).map((f) => ({ ...f, s: isqrt(f.prime) }));
    console.log(`minting head n=${n} (${factors.map((f) => `${f.prime}^${f.exponent}`).join(' * ')}) with inviteCount=${addresses.size}`);
    addresses.forEach((a, slot) => console.log(`  slot ${slot}: ${a.toString()}`));
    // D-211: the words are on chain, so the expected comment is read, not assumed.
    const words = await retry(() => ledger.getInviteText(), 'getInviteText');
    console.log(`comment: "${inviteCommentText(words)}"`);

    console.log('before:', await retry(() => ledger.getInviteSpend(), 'getInviteSpend'));

    await ledger.sendMint(sender, {
        n,
        kind: 0,
        factors,
        referralKey: 0,
        beneficiary: null,
        invites: { count: addresses.size, addresses },
        // G58: the shared mint value, the same one the webapp's invite mint sends. The invite
        // transfers are paid out of the all-in price (§4.1's invite line, `count × (value + fee)`), not
        // on top of it, and the ledger keeps up to MINT_MARGIN of any excess.
        value: MINT_VALUE_NANOTON + FEE_MARGIN_NANOTON,
    });

    console.log('waiting 30s for the transfers...');
    await new Promise((r) => setTimeout(r, 30_000));
    console.log('after: ', await retry(() => ledger.getInviteSpend(), 'getInviteSpend(after)'));
    console.log('head:  ', await retry(() => ledger.getHead(), 'getHead(after)'));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
