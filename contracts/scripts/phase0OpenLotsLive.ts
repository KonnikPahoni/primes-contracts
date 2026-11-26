/**
 * TON PRIMES — docs/audit/testnet-run-2026-09-14.md Phase 0, against the 2026-09-14 genesis.
 *
 * Opens the two ascending lots the acceptance plan needs on day 1, because both are
 * 7-day `AUCTION_WINDOW` waits and everything downstream of them is gated on that clock:
 *
 *   0a  n = 123456792 = 2^3 * 3 * 59 * 87187, score 0 so `p0` sits exactly on D-113's
 *       `LOT_FLOOR` 1.07 GRAM — the cheapest thing on the board. Opened by the FUNDER
 *       (deploy subwallet `PRIMES_DEPLOY_SUBWALLET_ID`); the open IS the first bid.
 *       Then raised by cast wallet `C`, a genuinely different sender, so the outbid
 *       refund path is exercised for real rather than by the opener re-bidding itself.
 *       Closes in Phase 5 and is what finally closes GAUNTLET H4.
 *
 *   0b  n = 899809363, prime, score 15, `p0` 2.828 GRAM. Opened by cast wallet `A`.
 *       Ahead of the head, so this is the ASCENDING lane with `kind = 1` and no
 *       factorization: the contract Miller-Rabins it itself at settlement. Small primes
 *       are NOT the cheap option here — `NPV(p)` prices the dividend stream, so n=11
 *       opens at 415 GRAM and n=2 at 1303 GRAM. This is the affordable end of the lane,
 *       and winning it gives `A` the prime rank + `PRIME_WINDOW` uplifts Phase 2 reads.
 *
 * EVERY STAGE IS INDEPENDENTLY GUARDED AND IDEMPOTENT — on chain state first ("is this
 * lot already open / already raised"), then on balance. A stage that cannot afford itself
 * prints the exact shortfall and is SKIPPED, not failed, so this script is re-run as
 * funding arrives and finishes whatever it can each time. That is deliberate: the funding
 * for this plan lands in tranches and the 7-day clock should not wait for the last one.
 *
 *   npx tsx scripts/phase0OpenLotsLive.ts <path-to-cast.json>
 *
 * `cast.json` is the scratchpad-only wallet file from docs/audit/testnet-run-2026-09-14.md §2. It holds
 * live mnemonics and is never committed.
 */
import fs from 'fs';
import path from 'path';
import { Address, SendMode, TonClient, WalletContractV4, internal, toNano } from '@ton/ton';
import type { Sender, SenderArguments } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { PrimesLedger } from '../wrappers/PrimesLedger';

import { hydrateProcessEnv } from './envFile';
import { normaliseCast, readCast } from './testnet/cast';

// W10: these scripts carry their own inline `.env` line-loop inside main(), which runs
// too late for any module-scope `process.env.PRIMES_*_ADDRESS` read and is a second
// copy of a reader that already exists. The shared hydrator runs at import time and
// never overwrites a var the shell set, so the inline loop below becomes a no-op.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');

/** 0a — score 0, so p0 == LOT_FLOOR. Factors cited in full; 59 and 87187 are ahead of the
 *  head, so their divisor share forfeits to the treasury at settlement (§6 point 2). */
const N_COMPOSITE = 123_456_792n;
const COMPOSITE_FACTORS = [
    { prime: 2n, exponent: 3 },
    { prime: 3n, exponent: 1 },
    { prime: 59n, exponent: 1 },
    { prime: 87_187n, exponent: 1 },
];

/** 0b — prime, kind 1, no factors. */
const N_PRIME = 899_809_363n;

/** Nominal price + margin on every send — never the exact price (CLAUDE.md). */
const MARGIN = toNano('0.05');
/** Left in a sender after a send so it can still pay its own gas and rent. */
const GAS_FLOOR = toNano('0.05');

type CastEntry = { handle: string; role: string; address: string; mnemonic: string };

function need(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing required env var ${name} (see .env)`);
    return v;
}

function fmt(nano: bigint): string {
    return `${(Number(nano) / 1e9).toFixed(9)} GRAM`;
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

function makeSender(
    client: TonClient,
    keyPair: { publicKey: Buffer; secretKey: Buffer },
    walletId?: number
): { sender: Sender; wallet: WalletContractV4 } {
    const wallet =
        walletId === undefined
            ? WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })
            : WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });
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
            console.log(`  [confirmed] ${wallet.address.toString()} seqno=${cur}`);
        },
    };
    return { sender, wallet };
}

async function balanceOf(client: TonClient, addr: Address): Promise<bigint> {
    return retry(() => client.getBalance(addr), `getBalance(${addr.toString()})`);
}

async function main() {
    // The cast now has ONE generator (`scripts/testnet/cast.ts`) and one file,
    // `.cast.json` at the repo root. A path argument still works, for a cast file
    // kept somewhere else, but the default is the shared one — two files full of
    // live mnemonics is one more than this plan should ever have.
    const castPath = process.argv[2];

    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    for (const line of envFile.split(/\r?\n/)) { // /\r?\n/, not '\n' — see genesisPrep.ts
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    const MARKET = need('PRIMES_MARKET_ADDRESS');
    const LEDGER = need('PRIMES_LEDGER_ADDRESS');
    const FUNDER_SUBWALLET = Number(need('PRIMES_DEPLOY_SUBWALLET_ID'));

    const keeperMnemonic = envFile
        .match(/^DEPLOYER_MNEMONIC=(.*)$/m)![1]
        .trim()
        .replace(/^"|"$/g, '')
        .split(/\s+/);
    const keeperKp = await mnemonicToPrivateKey(keeperMnemonic);

    // An explicit path went through `JSON.parse` directly and produced the WRONG SHAPE:
    // `cast.ts` writes `{createdAt, subwalletId, wallets:[{name, why, address, mnemonic:
    // string[]}]}`, and every reader here wants `{handle, role, address, mnemonic: string}`.
    // `readCast()` is the normaliser and the no-argument branch has always used it, so the
    // defect only ever fired for a caller that passed the path the usage line documents
    // (`cast.find is not a function`). Both branches normalise now.
    const cast: CastEntry[] = castPath ? normaliseCast(JSON.parse(fs.readFileSync(castPath, 'utf8'))) : readCast();
    const castOf = (handle: string) => {
        const e = cast.find((c) => c.handle === handle);
        if (!e) throw new Error(`cast.json has no wallet "${handle}"`);
        return e;
    };

    // The key matters here in a way it did not for the single-shot prove* scripts: this
    // script makes dozens of get-calls across its guards, and keyless TonCenter 429s well
    // before the end of them. `retry` still covers a transient one.
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY_TESTNET || undefined,
    });
    const market = client.open(PrimesMarket.createFromAddress(Address.parse(MARKET)));
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(LEDGER)));

    const funder = makeSender(client, keeperKp, FUNDER_SUBWALLET);
    const kpA = await mnemonicToPrivateKey(castOf('A').mnemonic.split(/\s+/));
    const kpC = await mnemonicToPrivateKey(castOf('C').mnemonic.split(/\s+/));
    const A = makeSender(client, kpA);
    const C = makeSender(client, kpC);

    const head = await retry(() => ledger.getHead(), 'getHead');
    const headHint = await retry(() => market.getHeadHint(), 'getHeadHint');
    console.log(`head=${head} headHint=${headHint}`);
    for (const n of [N_COMPOSITE, N_PRIME]) {
        if (n <= headHint) throw new Error(`n=${n} is not ahead of headHint=${headHint} — aborting`);
    }

    let funderBal = await balanceOf(client, funder.wallet.address);
    console.log(`\nfunder  ${funder.wallet.address.toString()} (subwallet ${FUNDER_SUBWALLET})  ${fmt(funderBal)}`);
    console.log(`A       ${A.wallet.address.toString()}  ${fmt(await balanceOf(client, A.wallet.address))}`);
    console.log(`C       ${C.wallet.address.toString()}  ${fmt(await balanceOf(client, C.wallet.address))}`);

    const skipped: string[] = [];

    // ---- stage 1: open 0a, the composite lot (the H4 clock) --------------------------
    let compositeLot = await retry(() => market.getLot(N_COMPOSITE), 'getLot(composite)');
    if (compositeLot.found) {
        console.log(`\n[0a open] already open — highBid=${fmt(compositeLot.highBid)} closesAt=${compositeLot.closesAt}`);
    } else {
        // getLotPriceFrom, NOT getLotPrice: the latter is a documented LOWER BOUND —
        // bits 33..38 (semiprime, prime power, square-free, 7-smooth, abundant/deficient)
        // are the categories `n` alone cannot decide and it returns them clear. 123456792
        // is 2^3-divisible so not square-free, and its abundance is only knowable from the
        // factorization. Paying the lower bound is how an open gets rejected.
        const price = await retry(
            () => market.getLotPriceFrom(N_COMPOSITE, COMPOSITE_FACTORS),
            'getLotPriceFrom(composite)'
        );
        const value = price.p0 + MARGIN;
        funderBal = await balanceOf(client, funder.wallet.address);
        if (funderBal < value + GAS_FLOOR) {
            skipped.push(`0a open: funder has ${fmt(funderBal)}, needs ${fmt(value + GAS_FLOOR)}`);
        } else {
            console.log(`\n[0a open] n=${N_COMPOSITE} kind=0 p0=${fmt(price.p0)} value=${fmt(value)}`);
            await market.sendOpenLot(funder.sender, {
                n: N_COMPOSITE,
                kind: 0,
                factors: COMPOSITE_FACTORS,
                beneficiary: null,
                referralKey: 0,
                value,
            });
            await new Promise((r) => setTimeout(r, 20_000));
            compositeLot = await retry(() => market.getLot(N_COMPOSITE), 'getLot(afterOpen)');
            if (!compositeLot.found) throw new Error('0a open did not land');
            console.log(`[0a open] landed — closesAt=${compositeLot.closesAt} (${new Date(Number(compositeLot.closesAt) * 1000).toISOString()})`);
        }
    }

    // ---- stage 2: raise 0a from C, a genuinely different sender -----------------------
    if (!compositeLot.found) {
        skipped.push('0a raise: lot not open yet');
    } else if (C.wallet.address.equals(compositeLot.highBidder)) {
        console.log('\n[0a raise] C is already the high bidder — outbid path already proven');
    } else {
        const raiseValue = compositeLot.minPayment + MARGIN;
        const need = raiseValue + GAS_FLOOR;
        let cBal = await balanceOf(client, C.wallet.address);
        if (cBal < need) {
            // top C up from the funder if the funder can spare it
            const topUp = need - cBal + GAS_FLOOR;
            funderBal = await balanceOf(client, funder.wallet.address);
            if (funderBal >= topUp + GAS_FLOOR) {
                console.log(`\n[fund C] ${fmt(topUp)} from the funder`);
                await funder.sender.send({ to: C.wallet.address, value: topUp, bounce: false });
                await new Promise((r) => setTimeout(r, 15_000));
                cBal = await balanceOf(client, C.wallet.address);
            }
        }
        if (cBal < need) {
            skipped.push(`0a raise: C has ${fmt(cBal)}, needs ${fmt(need)} (funder ${fmt(funderBal)})`);
        } else {
            console.log(`\n[0a raise] minPayment=${fmt(compositeLot.minPayment)} value=${fmt(raiseValue)} from C`);
            await market.sendBid(C.sender, { n: N_COMPOSITE, beneficiary: null, referralKey: 0, value: raiseValue });
            await new Promise((r) => setTimeout(r, 20_000));
            compositeLot = await retry(() => market.getLot(N_COMPOSITE), 'getLot(afterRaise)');
            console.log(`[0a raise] highBid=${fmt(compositeLot.highBid)} highBidder=${compositeLot.highBidder.toString()}`);
        }
    }

    // ---- stage 3: open 0b, the prime lot, from A -------------------------------------
    let primeLot = await retry(() => market.getLot(N_PRIME), 'getLot(prime)');
    if (primeLot.found) {
        console.log(`\n[0b open] already open — highBid=${fmt(primeLot.highBid)} closesAt=${primeLot.closesAt}`);
    } else {
        const price = await retry(() => market.getLotPrice(N_PRIME), 'getLotPrice(prime)');
        const value = price.p0 + MARGIN;
        const need = value + GAS_FLOOR;
        let aBal = await balanceOf(client, A.wallet.address);
        if (aBal < need) {
            const topUp = need - aBal + GAS_FLOOR;
            funderBal = await balanceOf(client, funder.wallet.address);
            if (funderBal >= topUp + GAS_FLOOR) {
                console.log(`\n[fund A] ${fmt(topUp)} from the funder`);
                await funder.sender.send({ to: A.wallet.address, value: topUp, bounce: false });
                await new Promise((r) => setTimeout(r, 15_000));
                aBal = await balanceOf(client, A.wallet.address);
            }
        }
        if (aBal < need) {
            skipped.push(`0b open: A has ${fmt(aBal)}, needs ${fmt(need)} (p0=${fmt(price.p0)}, funder ${fmt(funderBal)})`);
        } else {
            console.log(`\n[0b open] n=${N_PRIME} kind=1 p0=${fmt(price.p0)} value=${fmt(value)} from A`);
            await market.sendOpenLot(A.sender, {
                n: N_PRIME,
                kind: 1,
                factors: [],
                beneficiary: null,
                referralKey: 0,
                value,
            });
            await new Promise((r) => setTimeout(r, 20_000));
            primeLot = await retry(() => market.getLot(N_PRIME), 'getLot(afterPrimeOpen)');
            if (!primeLot.found) throw new Error('0b open did not land');
            console.log(`[0b open] landed — closesAt=${primeLot.closesAt} (${new Date(Number(primeLot.closesAt) * 1000).toISOString()})`);
        }
    }

    // ---- read-back -------------------------------------------------------------------
    console.log('\n=== Phase 0 read-back ===');
    console.log('lot 0a:', await retry(() => market.getLot(N_COMPOSITE), 'getLot(final-composite)'));
    console.log('lot 0b:', await retry(() => market.getLot(N_PRIME), 'getLot(final-prime)'));
    console.log('market:', await retry(() => market.getMarketStats(), 'getMarketStats'));
    console.log(`funder ${fmt(await balanceOf(client, funder.wallet.address))}`);

    if (skipped.length > 0) {
        console.log('\n=== SKIPPED, funding-blocked — re-run this script once funded ===');
        for (const s of skipped) console.log(`  - ${s}`);
    } else {
        console.log('\nPhase 0 complete — both clocks running.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
