/**
 * TON PRIMES — testnet utility: raise the floor by donating TON to the ledger.
 *
 * CONCEPT §6 point 3 / DECISIONS D-91 point 4, D-100 point 1. Sends
 * `donate_floor#b000000c`: `T` rises by the donation and it is forwarded to the
 * ratchet as `pending` — NOT credited to `seedT`, which is the double-count
 * D-100 point 1 removed. `S` rises by `min(amount * L, amount * S / T)`
 * (L = 10,000 PRIMES/TON) and those PRIMES
 * are minted TO THE SENDER — the pool's PRIMES side, for the sender to pair on
 * DeDust and burn the receipt themselves (D-91 point 6: that leg is manual and
 * not atomic).
 *
 * Permissionless and incremental: run it as often as you like, from any wallet.
 * It prints the floor before and after so the rise is visible, not asserted.
 *
 * THE GENESIS DONATION IS 200 TON (D-204; 132.50 under D-154), and D-100 point 2 turned it from a derived
 * figure into an owner-set one. D-92 declared the opening floor and solved
 * `p_f = X / (S₀ + X·L)` for `X`, which gave 240 TON; the operator will not fund
 * that, so the arrow reverses — the donation is now the input
 * (`genesis.genesis_donation_ton`) and the sim derives
 * `genesis.genesis_floor_price_ton_per_primes` (3.5e-7) from it. This script's
 * default is that figure, read from the file through `genesisDonationTon()` so
 * that it and the sandbox rehearsal cannot disagree about what genesis donates.
 *
 * DO NOT REACH FOR `genesis.genesis_seed_ton` (200) HERE. It sizes `S₀` and the
 * pool depth the sim models; no TON has ever moved for it. The two were equal by
 * construction until D-100 point 2 and are now 48× apart.
 *
 * Env:
 *   PRIMES_DONATE_TON        — amount in TON (default: the genesis donation above).
 *                              D-100 point 3's further outlay, up to 150 TON, comes
 *                              through this same message a tranche at a time.
 *   PRIMES_LEDGER_ADDRESS    — the deployed ledger (docs/testnet-deployment.md)
 *   PRIMES_FROM_SUBWALLET_ID — source subwallet id (default: wallet v4 default)
 *
 *   ../bot/node_modules/.bin/tsx scripts/donateFloor.ts
 */
import fs from 'fs';
import path from 'path';
import { Address, SendMode, TonClient, WalletContractV4, beginCell, internal, toNano } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { LedgerOpcodes } from '../wrappers/PrimesLedger';
// D-100 point 2's owner-set donation lives in the pipeline, next to the step
// that leaves `T = 0` — one definition, so this script and the rehearsal cannot
// disagree.
import { genesisDonationTon } from './genesisPipeline';
import { deploySubwalletId, hydrateProcessEnv, loadEnvFile } from './envFile';

// `tsx` loads no `.env`; every `process.env.PRIMES_*` read below depends on this.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
/** The two hops the ledger asserts on top of the donation itself: 0.005 TON to
 *  the ratchet + 0.02 TON for the jetton mint, plus compute margin. Never send
 *  exactly `amount` — the contract rejects it (the standing testnet rule). */
const HOP_MARGIN = toNano('0.06');

async function floor(client: TonClient, ledger: Address) {
    const t = (await client.runMethod(ledger, 'getFloorNum')).stack.readBigNumber();
    const s = (await client.runMethod(ledger, 'getFloorDen')).stack.readBigNumber();
    const seed = (await client.runMethod(ledger, 'getSeedT')).stack.readBigNumber();
    return { t, s, seed, pf: Number(t) / Number(s) };
}

async function main() {
    const genesis = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'params.json'), 'utf8')).genesis;
    const lpRatio = BigInt(genesis.genesis_lp_ratio_primes_per_ton);
    const amountTon = process.env.PRIMES_DONATE_TON ?? genesisDonationTon(genesis).toFixed(9).replace(/0+$/, '0');
    const amount = toNano(amountTon);
    if (!process.env.PRIMES_DONATE_TON) {
        console.log(
            `PRIMES_DONATE_TON unset — using D-100 point 2's owner-set genesis donation ${amountTon} TON, ` +
                `from which the sim derives p_f = ${genesis.genesis_floor_price_ton_per_primes.toExponential(4)}. ` +
                `It mints you ${genesis.genesis_donation_ton * genesis.genesis_lp_ratio_primes_per_ton} PRIMES ` +
                'at L (the clamp is inactive while T = 0) — that is the PRIMES side of the manual DeDust pair.'
        );
    }

    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const readEnv = (k: string) =>
        (process.env[k] ?? envFile.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim().replace(/^"|"$/g, '');

    const ledger = Address.parse(readEnv('PRIMES_LEDGER_ADDRESS'));
    const mnemonic = readEnv('KEEPER_WALLET_MNEMONIC').split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    // DEFAULT TO THE DEPLOY SUBWALLET, not the base wallet. This donation does two things
    // at once: it moves T (D-100 point 2) and it MINTS the donor ~1,972,333 PRIMES (X·L less D-156's taper; D-204's 200 TON) — which are
    // the PRIMES side `seedDedustLiquidity.ts` then pairs into the pool. That script reads
    // `deploySubwalletId`, so a donation from any other wallet strands the PRIMES where the
    // seeder cannot see them, and the base wallet is not funded for 200 TON anyway.
    // `PRIMES_FROM_SUBWALLET_ID` still overrides, for a donation from somewhere else.
    const walletId = process.env.PRIMES_FROM_SUBWALLET_ID
        ? Number(process.env.PRIMES_FROM_SUBWALLET_ID)
        : deploySubwalletId(loadEnvFile());
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });

    const apiKey = readEnv('TONCENTER_API_KEY_TESTNET');
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: apiKey || undefined,
    });

    const before = await floor(client, ledger);
    console.log('ledger:', ledger.toString({ testOnly: true }));
    console.log('from:  ', wallet.address.toString({ testOnly: true }));
    console.log(`before: T=${before.t} S=${before.s} seedT=${before.seed} p_f=${before.pf.toExponential(4)}`);
    // MISTAKES.md 2026-11-07: run straight after genesis with `.env` still naming the
    // PREVIOUS ledger, this sent 60 TON into a dead set. A genesis donation always meets
    // T = 0, so a non-zero T means either the wrong ledger or a deliberate top-up — say which.
    if (before.t > 0n && readEnv('PRIMES_DONATE_TOP_UP') !== '1') {
        throw new Error(
            `ledger ${ledger.toString({ testOnly: true })} already holds T=${before.t}: not a fresh genesis. ` +
                'If .env still names the previous set, paste the new addresses first (runbook step 6). ' +
                'For a deliberate top-up, set PRIMES_DONATE_TOP_UP=1.',
        );
    }
    // D-100 point 1: above 1/L the donation is not refused, it is REPRICED —
    // the contract emits at the floor rate `amount * S / T` instead of the flat
    // `L`, so the donor gets fewer PRIMES for the same TON and no holder is
    // diluted. (This used to throw client-side to pre-empt the ledger's own 217,
    // which is retired along with the guard that raised it.) Printed rather than
    // thrown, because a late donation is a legitimate thing to do on purpose.
    const flatEmission = amount * lpRatio;
    const atFloor = before.t > 0n && before.s > 0n ? (amount * before.s) / before.t : flatEmission;
    const expectedEmission = atFloor < flatEmission ? atFloor : flatEmission;
    if (expectedEmission < flatEmission) {
        console.log(
            `p_f is above 1/L = 1e-4, so this donation mints at the FLOOR rate, not at L: ` +
                `${expectedEmission} nano-PRIMES instead of ${flatEmission} (D-100 point 1's clamp).`
        );
    }

    const wc = client.open(wallet);
    const seqno = await wc.getSeqno();
    await wc.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        timeout: Math.floor(Date.now() / 1000) + 600, // clock-skew workaround
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [
            internal({
                to: ledger,
                value: amount + HOP_MARGIN,
                bounce: true,
                body: beginCell()
                    .storeUint(LedgerOpcodes.DonateFloor, 32)
                    .storeUint(0, 64)
                    .storeCoins(amount)
                    .endCell(),
            }),
        ],
    });

    let cur = seqno;
    for (let i = 0; cur === seqno && i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        cur = await wc.getSeqno();
    }
    if (cur === seqno) throw new Error('donation not confirmed');

    // The ledger's own state, re-read rather than predicted (§9.1).
    for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const after = await floor(client, ledger);
        if (after.t > before.t) {
            console.log(`after:  T=${after.t} S=${after.s} seedT=${after.seed} p_f=${after.pf.toExponential(4)}`);
            console.log(`floor moved ${before.pf.toExponential(4)} -> ${after.pf.toExponential(4)}`);
            console.log(
                `minted to you: ${after.s - before.s} nano-PRIMES (predicted ${expectedEmission}) — ` +
                    `pair and burn on DeDust yourself.`
            );
            return;
        }
    }
    throw new Error(
        'donation sent but the ledger floor did not move — check the transaction for exit code 103 ' +
            '(the message did not carry `amount` plus both hops of gas, or the clamped emission rounded to zero)'
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
