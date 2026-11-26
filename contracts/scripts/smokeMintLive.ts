/**
 * TON PRIMES — live TESTNET mint smoke test. **Testnet only, enforced below.**
 *
 * DECISIONS.md **D-95** (owner, 2026-09-02): *"Only mint 4 for testnet deploy —
 * on mainnet do not mint 4."* This script is the smoke mint, and because the
 * sending wallet pays, it is also what makes the deploy subwallet the OWNER of
 * the number it mints. On testnet that is harmless and useful. On mainnet it
 * would leave the genesis operator holding the first number on the sequential
 * line, on a line whose whole premise (§4) is that integers are minted
 * sequentially by whoever gets there first — a fact an auditor reads off the
 * chain in one call. So `assertTestnetOnly()` refuses rather than trusting
 * nobody to type the command, which is D-95's own propagation item.
 *
 * Set PRIMES_LEDGER_ADDRESS / PRIMES_RATCHET_ADDRESS
 * from the current deployment before running; the hardcoded fallbacks below are
 * dead addresses from an abandoned 2026-08-17 set and are kept only so a missing
 * variable fails loudly on a dead address rather than silently on a live one.
 *
 * Drives one real single-message mint of the current head directly through the
 * ledger wrappers (no read-proxy dependency), with the same skew-safe sender as
 * deployGenesis.ts --skew-safe. Message value is MINT_PRICE + margin — the exact
 * price is rejected once forward fees are deducted (docs/testnet-deployment.md).
 *
 *   npx tsx scripts/smokeMintLive.ts   (tsx, NOT ts-node — ts-node fails with
 *                                      ERR_REQUIRE_ESM on shared/)
 */
import fs from 'fs';
import path from 'path';
import { Address, SendMode, TonClient, WalletContractV4, internal } from '@ton/ton';
import { MINT_VALUE_NANOTON, FEE_MARGIN_NANOTON } from '../../shared/values';
import type { Sender, SenderArguments } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';

import { hydrateProcessEnv } from './envFile';

// W10: `tsx` loads no `.env`, and every `process.env.PRIMES_*_ADDRESS` read below
// otherwise falls through to a hardcoded address from a genesis that is months dead
// — silently, because a dead-but-still-answering contract returns plausible numbers
// rather than an error. `hydrateProcessEnv()` is the one reader that ends that; it
// never overwrites a var the shell already set.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');

/** The only endpoint this script may ever talk to. Named, so the guard below has
 *  something to check and a future edit has something to trip over. */
const TESTNET_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';

/**
 * DECISIONS.md D-95 — refuse to smoke-mint anywhere but testnet.
 *
 * Two independent checks, because either alone is defeatable by an ordinary
 * edit: the endpoint must be a testnet one, AND any network variable the
 * environment declares must not say mainnet. A script that only hardcoded the
 * URL would be one search-and-replace away from minting number 4 on mainnet,
 * and that mint is not reversible.
 */
function assertTestnetOnly(endpoint: string): void {
    if (!/(^|[./])testnet\./.test(endpoint)) {
        throw new Error(
            `D-95: smokeMintLive is testnet-only and the endpoint is not a testnet one (${endpoint}). ` +
            'Mainnet genesis does not smoke-mint; see DECISIONS.md D-95.'
        );
    }
    const declared = (process.env.PRIMES_NETWORK ?? process.env.TON_NETWORK ?? '').trim().toLowerCase();
    if (declared === 'mainnet') {
        throw new Error(
            'D-95: smokeMintLive is testnet-only and the environment declares mainnet. ' +
            'Mainnet genesis does not smoke-mint; see DECISIONS.md D-95.'
        );
    }
}

// !!! STALE — these are from the ABANDONED half-collided set of 2026-08-17's first
// attempt (docs/testnet-deployment.md), and they were never the live deployment.
// Genesis moves these on every redeploy, so the env wins over the recorded defaults —
// pointing a smoke test at a stale deployment is exactly the failure it exists to catch.
const LEDGER = process.env.PRIMES_LEDGER_ADDRESS ?? 'EQDV1QaS6r7smod92DJYowQ3C0aKNWtSUi1Ritmj23Zc-bp9';
const RATCHET = process.env.PRIMES_RATCHET_ADDRESS ?? 'EQCJq5HjnSUnptP_l-OK-Hck_ChHjeDz9nMp5ivLgD6FBOGp';

function isPrime(n: bigint): boolean {
    if (n < 2n) return false;
    for (let d = 2n; d * d <= n; d++) if (n % d === 0n) return false;
    return true;
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

async function main() {
    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const mnemonic = envFile
        .match(/^DEPLOYER_MNEMONIC=(.*)$/m)![1]
        .trim()
        .replace(/^"|"$/g, '')
        .split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    // Any funded wallet can mint; PRIMES_DEPLOY_SUBWALLET_ID selects a subwallet
    // of the deployer mnemonic (see deployGenesis.ts --skew-safe).
    const walletId = process.env.PRIMES_DEPLOY_SUBWALLET_ID
        ? Number(process.env.PRIMES_DEPLOY_SUBWALLET_ID)
        : undefined;
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });
    const apiKey = (envFile.match(/^TONCENTER_API_KEY_TESTNET=(.*)$/m)?.[1] ?? '').trim();
    assertTestnetOnly(TESTNET_ENDPOINT);
    const client = new TonClient({
        endpoint: TESTNET_ENDPOINT,
        apiKey: apiKey || undefined,
    });
    const walletContract = client.open(wallet);

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

    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(LEDGER)));
    const ratchet = client.open(PrimesRatchet.createFromAddress(Address.parse(RATCHET)));

    const n = await retry(() => ledger.getHead(), 'getHead');
    const kind = isPrime(n) ? 1 : 0;
    const factors = kind === 0 ? factorize(n) : [];
    console.log(`head n=${n}, kind=${kind}${kind === 0 ? `, factors ${factors.map((f) => `${f.prime}^${f.exponent}`).join('*')}` : ''}`);

    const Tbefore = await retry(() => ledger.getFloorNum(), 'getFloorNum');
    const Sbefore = await retry(() => ledger.getFloorDen(), 'getFloorDen');
    const pendingBefore = await retry(() => ratchet.getPending(), 'getPending');
    console.log(`before: T=${Tbefore} S=${Sbefore} pending=${pendingBefore}`);

    console.log('sending mint (1 GRAM + margin)...');
    await ledger.sendMint(sender, {
        n,
        kind,
        factors,
        referralKey: 0,
        beneficiary: null,
        value: MINT_VALUE_NANOTON + FEE_MARGIN_NANOTON, // G58: shared, never the exact price
    });

    console.log('waiting 20s for internal hops...');
    await new Promise((r) => setTimeout(r, 20_000));

    const headAfter = await retry(() => ledger.getHead(), 'getHead(after)');
    const Tafter = await retry(() => ledger.getFloorNum(), 'getFloorNum(after)');
    const Safter = await retry(() => ledger.getFloorDen(), 'getFloorDen(after)');
    const pendingAfter = await retry(() => ratchet.getPending(), 'getPending(after)');
    console.log(`after:  head=${headAfter} T=${Tafter} S=${Safter} pending=${pendingAfter}`);
    console.log(`floor strictly up: ${Tafter * Sbefore > Tbefore * Safter} (ratchet theorem, §5)`);
    // D-20: the head is defined over composites (and Unity), so after minting n
    // it lands on the NEXT COMPOSITE above n, skipping primes — 4 -> 6, not 5.
    let expected = n + 1n;
    while (isPrime(expected)) expected += 1n;
    if (headAfter !== expected) {
        throw new Error(`mint did not advance the head (head=${headAfter}, expected ${expected})`);
    }
    if (kind === 1) {
        // §4.7.1's prime rank is the ledger's own minterState (D-188 point 6 deleted the registrar mirror).
        const rank = (await retry(() => ledger.getMinterState(wallet.address), 'getMinterState')).primesMinted;
        console.log(`prime rank for minter (ledger.getMinterState): ${rank}`);
    }
    console.log('SMOKE MINT OK');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
