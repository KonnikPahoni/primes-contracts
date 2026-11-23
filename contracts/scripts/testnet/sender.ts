/**
 * TON PRIMES — the ONE skew-safe sender, extracted.
 *
 * `makeSender` was copy-pasted into six `*Live.ts` scripts, identically, and the
 * copies had already begun to drift in their retry counts and their poll
 * timeouts. This is that function, once, plus the two guards every copy carried
 * around it. `TESTNET_MASTER_PLAN.md` §2 — the harness the gauntlet runs on.
 *
 * WHAT "SKEW-SAFE" MEANS HERE, because it is the reason this shape exists and
 * not a simpler one: a TON external message carries an expiry, and the deploy
 * host's clock has drifted far enough from the network's, more than once, that
 * every external was rejected as already-expired while the script cheerfully
 * reported success. So: the timeout is generous (600s), the send is retried,
 * and — the part that actually catches it — the sender POLLS seqno until it
 * moves and throws `external not confirmed` if it never does. A send that is
 * not confirmed is a failure, not a warning.
 */
import fs from 'fs';
import path from 'path';
import { SendMode, TonClient, WalletContractV4, WalletContractV5R1, internal } from '@ton/ton';
import type { Sender, SenderArguments } from '@ton/core';
import { KeyPair, mnemonicToPrivateKey } from '@ton/crypto';
import { hydrateProcessEnv, loadEnvFile, envValue, deploySubwalletId } from '../envFile';

hydrateProcessEnv();

export const REPO = path.resolve(__dirname, '..', '..', '..');
export const TESTNET_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';

/**
 * The same two independent checks `smokeMintLive.ts` carries (D-95): the
 * endpoint must be a testnet one AND the environment must not declare mainnet.
 * Either alone is one search-and-replace away from being defeated, and nothing
 * this harness does is reversible on mainnet.
 */
export function assertTestnetOnly(endpoint = TESTNET_ENDPOINT): void {
    if (!/(^|[./])testnet\./.test(endpoint)) {
        throw new Error(`testnet-only harness pointed at a non-testnet endpoint (${endpoint})`);
    }
    const declared = (process.env.PRIMES_NETWORK ?? process.env.TON_NETWORK ?? '').trim().toLowerCase();
    if (declared === 'mainnet') {
        throw new Error('testnet-only harness run with a mainnet environment declared');
    }
}

export function makeClient(): TonClient {
    assertTestnetOnly();
    const env = loadEnvFile();
    const apiKey = (envValue(env, 'TONCENTER_API_KEY_TESTNET') ?? '').trim();
    return new TonClient({ endpoint: TESTNET_ENDPOINT, apiKey: apiKey || undefined });
}

export async function retry<T>(fn: () => Promise<T>, label: string, attempts = 8): Promise<T> {
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

/** The keeper mnemonic out of `/.env` — the deploy key, NOT `seed.txt` (gotcha 1). */
export function keeperMnemonic(): string[] {
    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const m = envFile.match(/^KEEPER_WALLET_MNEMONIC=(.*)$/m);
    if (!m) throw new Error('KEEPER_WALLET_MNEMONIC missing from /.env');
    return m[1].trim().replace(/^"|"$/g, '').split(/\s+/);
}

export type Wallet = {
    keyPair: KeyPair;
    contract: ReturnType<TonClient['open']>;
    wallet: WalletContractV4 | WalletContractV5R1;
    sender: Sender;
};

/**
 * Which contract a seed phrase is opened as.
 *
 * ONE KEY IS THREE ADDRESSES, and that is the whole reason this exists. The same 24 words
 * derive a different account under v4R2 than under W5R1, and W5R1 folds the NETWORK into
 * its wallet id — so a W5 wallet's testnet address is not its mainnet one either. Measured
 * on the owner's own seed: v4R2 `0QAhPdCL…`, W5R1 mainnet-context `0QCkQWLa…`, W5R1
 * testnet-context `0QBdbo8l…`. Three distinct accounts, and two of the three were live.
 *
 * Everything here used to be v4R2 unconditionally, so a `.cast.json`/`.owner.json` entry
 * holding a W5 seed would be DRIVEN AT THE WRONG ADDRESS: the harness funds and sends from
 * the v4 account while the human, connected through their wallet app, watches the W5 one
 * and sees nothing happen. Silent on both sides — both are real accounts and both accept
 * GRAM — which is why the version travels with the entry instead of being inferred.
 */
export type WalletVersion = 'v4r2' | 'v5r1';

/**
 * Testnet's `global_id`, which W5R1 mixes into its wallet id (`WalletIdV5R1`). Hardcoded
 * for the same reason the endpoint above is: `assertTestnetOnly()` refuses to let this
 * module reach anything else, so there is no second case to serve.
 */
const TESTNET_GLOBAL_ID = -3;

/**
 * Open a wallet from a mnemonic and wrap it in the skew-safe sender.
 *
 * `walletId` selects a v4 SUBWALLET; omit it for the v4 default. It is ignored under
 * `v5r1`, which has no subwallet in the v4 sense — its wallet id is the network/workchain
 * context above, and the deploy subwallet convention (a fresh id per genesis) is a
 * property of `K`, which is always v4.
 */
export async function openWallet(
    client: TonClient,
    mnemonic: string[],
    walletId?: number,
    version: WalletVersion = 'v4r2'
): Promise<Wallet> {
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const wallet =
        version === 'v5r1'
            ? WalletContractV5R1.create({
                  workchain: 0,
                  publicKey: keyPair.publicKey,
                  walletId: { networkGlobalId: TESTNET_GLOBAL_ID },
              })
            : WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });
    const contract = client.open(wallet);

    const sender: Sender = {
        address: wallet.address,
        async send(args: SenderArguments) {
            // A SEND THIS WALLET CANNOT AFFORD IS A BALANCE PROBLEM, AND IT MUST SAY SO.
            // Without this, an underfunded wallet fails in the action phase (or has its
            // external dropped), the seqno poll below times out, and the operator is told
            // `external not confirmed` — a clock-skew/network symptom — for five minutes of
            // waiting. That misdiagnosis cost a run this session (MISTAKES.md 2026-09-17)
            // twice: once on `transferTon.ts`, once on `proveReferralLive.ts`, whose
            // sender wallet held 0.32 GRAM against a 1.05 GRAM mint.
            const balance = await retry(() => client.getBalance(wallet.address), 'getBalance');
            if (balance < args.value + 50_000_000n) {
                throw new Error(
                    `${wallet.address.toString({ testOnly: true })} holds ${Number(balance) / 1e9} GRAM, ` +
                        `short of the ${Number(args.value) / 1e9} GRAM this send attaches plus fees. ` +
                        `Fund it (contracts/scripts/fundLive.ts <address> <ton>) and re-run.`
                );
            }
            const seqno = await retry(() => (contract as any).getSeqno(), 'getSeqno');
            // A 500 from toncenter does not mean the external was refused: on the G93
            // genesis (2026-10-04) attempt 1 LANDED behind a 500, every retry re-signed the
            // same seqno, the wallet threw 33 on each, and the one-shot pipeline stranded.
            // So a retry first asks whether the seqno already moved, and stops if it has.
            let attempt = 0;
            await retry(
                async () => {
                    if (attempt++ > 0 && (await (contract as any).getSeqno()) !== seqno) return;
                    return (contract as any).sendTransfer({
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
                                // A DEPLOY IS A SEND WITH A STATE INIT, and this sender used to
                                // drop it silently: `SenderArguments` carries `init`, nothing
                                // read it, and a script deploying a third-party contract (the
                                // GetGems sale contract, `proveResaleLive.ts`) got an ordinary
                                // transfer to an address with no code.
                                init: args.init ?? undefined,
                            }),
                        ],
                    });
                },
                'sendTransfer'
            );
            let cur = seqno;
            for (let i = 0; cur === seqno && i < 60; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                cur = await retry(() => (contract as any).getSeqno(), 'poll-getSeqno');
            }
            if (cur === seqno) throw new Error(
                    'external not confirmed after ~5 minutes of seqno polling. The usual cause is a ' +
                        'wallet that cannot afford the value this message attaches — an unaffordable send ' +
                        'fails in the action phase (or is dropped) and never advances the seqno. Check the ' +
                        'balance first, then clock skew. (MISTAKES.md 2026-09-17.)'
                );
        },
    };
    return { keyPair, contract, wallet, sender };
}

/** The genesis deploy subwallet — the cast's funder, `K` in the plan. */
export async function openDeployWallet(client: TonClient): Promise<Wallet> {
    return openWallet(client, keeperMnemonic(), deploySubwalletId(loadEnvFile()));
}
