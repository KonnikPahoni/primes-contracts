/**
 * TON PRIMES — GAUNTLET H2: composite mint end-to-end, five-way split proof.
 *
 * Verification-only script (no new mechanics, no new get-methods). Reuses
 * `smokeMintLive.ts`'s sender pattern (skew-safe subwallet transfer through
 * the keeper mnemonic in `.env`) and extends it to read every get-method
 * CONCEPT.md §4.1's split touches, before and after one real mint, and
 * reconcile the deltas:
 *
 *   - tribute (10%): to the minted number's prime-factor owners, weighted,
 *     OR forfeited to treasury for any cited factor still unsold
 *     (`isPrimeUnsold` / `getForfeited` — CONCEPT.md §4.1 "Exception 1").
 *   - referral (10%): falls to the pool when no key is set (this run uses
 *     referralKey 0 deliberately, to exercise exactly that path).
 *   - the 5% line (`TREASURY_AMOUNT`): tracked both via the ledger's own
 *     cumulative `getOperatorTotals()` meter and the real GRAM balance of the
 *     recipient. This line has been re-pointed twice — D-100 point 6 moved it
 *     from the treasury to the OPERATOR, and D-152 moved it back to the
 *     GOVERNED TREASURY CONTRACT — so the address it watches is
 *     `PRIMES_TREASURY_ADDRESS`, the contract the genesis pipeline deploys, and
 *     the operator (`operator_addr`) is now only the forfeit remainder's destination.
 *   - gas & ops (10%): not independently observable as a balance line (funds
 *     deploys/forward fees/primality gas/`owed` rent) — noted, not measured.
 *   - pool injection (residual, beta): the ratchet's `pending` should rise by
 *     exactly beta, and T/S should move per the ratchet theorem (§5):
 *     T_after * S_before > T_before * S_after.
 *
 *   npx tsx scripts/proveCompositeSplitLive.ts
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

function need(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing required env var ${name} (see .env)`);
    return v;
}

const LEDGER = need('PRIMES_LEDGER_ADDRESS');
const RATCHET = need('PRIMES_RATCHET_ADDRESS');
// D-152: §4.1's 5% line pays the GOVERNED TREASURY CONTRACT, so this is the
// balance to watch for it. `PRIMES_TREASURY_ADDR` is accepted as the older
// spelling of the same thing on a set deployed before the pipeline settled on
// `PRIMES_TREASURY_ADDRESS`.
const TREASURY = process.env.PRIMES_TREASURY_ADDRESS ?? need('PRIMES_TREASURY_ADDR');

// Split constants mirrored from contracts/contracts/primes_ledger.tolk (read-only
// check here, not redefined behaviour) — §4.1: 1 GRAM all-in, 5% treasury.
const TREASURY_AMOUNT = 50_000_000n; // 5%

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
        .match(/^KEEPER_WALLET_MNEMONIC=(.*)$/m)![1]
        .trim()
        .replace(/^"|"$/g, '')
        .split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const walletId = process.env.PRIMES_DEPLOY_SUBWALLET_ID
        ? Number(process.env.PRIMES_DEPLOY_SUBWALLET_ID)
        : undefined;
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });
    const apiKey = (envFile.match(/^TONCENTER_API_KEY_TESTNET=(.*)$/m)?.[1] ?? '').trim();
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: apiKey || undefined,
    });
    const walletContract = client.open(wallet);

    let lastLt: string | undefined;
    let lastHash: string | undefined;

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
            // Pull the wallet's most recent outgoing transaction for the real hash.
            const txs = await retry(
                () => client.getTransactions(wallet.address, { limit: 3 }),
                'getTransactions'
            );
            const tx = txs[0];
            if (tx) {
                lastLt = tx.lt.toString();
                lastHash = tx.hash().toString('hex');
            }
        },
    };

    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(LEDGER)));
    const ratchet = client.open(PrimesRatchet.createFromAddress(Address.parse(RATCHET)));

    const n = await retry(() => ledger.getHead(), 'getHead');
    const kind = isPrime(n) ? 1 : 0;
    if (kind === 1) {
        throw new Error(`H2 requires a COMPOSITE head; got n=${n} which is prime. Aborting without sending.`);
    }
    const factors = factorize(n);
    console.log(`head n=${n} (composite), factors ${factors.map((f) => `${f.prime}^${f.exponent}`).join('*')}`);

    // --- BEFORE ---
    const Tbefore = await retry(() => ledger.getFloorNum(), 'getFloorNum');
    const Sbefore = await retry(() => ledger.getFloorDen(), 'getFloorDen');
    const pendingBefore = await retry(() => ratchet.getPending(), 'getPending');
    const opTotalsBefore = await retry(() => ledger.getOperatorTotals(), 'getOperatorTotals');
    const treasuryBalBefore = await retry(() => client.getBalance(Address.parse(TREASURY)), 'treasuryBalance');
    // Read the split off the chain rather than restating it here — CLAUDE.md rule 3.
    const { forfeitTreasuryBps } = await retry(() => ledger.getFeeDests(), 'getFeeDests');

    const factorState: { prime: bigint; unsold: boolean; forfeitedBefore: bigint }[] = [];
    for (const f of factors) {
        const unsold = await retry(() => ledger.isPrimeUnsold(f.prime), `isPrimeUnsold(${f.prime})`);
        const forfeitedBefore = await retry(() => ledger.getForfeited(f.prime), `getForfeited(${f.prime})`);
        factorState.push({ prime: f.prime, unsold, forfeitedBefore });
    }

    console.log('--- BEFORE ---');
    console.log(`T=${Tbefore} S=${Sbefore} p_f=${Number(Tbefore) / Number(Sbefore)}`);
    console.log(`ratchet.pending=${pendingBefore}`);
    console.log(
        `operatorTotals: operatorPaidTotal=${opTotalsBefore.operatorPaidTotal} treasuryPaidTotal=${opTotalsBefore.treasuryPaidTotal} opsSweptTotal=${opTotalsBefore.opsSweptTotal}`
    );
    console.log(`treasury contract balance=${treasuryBalBefore}`);
    for (const fs2 of factorState) {
        console.log(`  factor ${fs2.prime}: unsold=${fs2.unsold} forfeitedBefore=${fs2.forfeitedBefore}`);
    }

    // --- MINT ---
    console.log('sending composite mint (1 GRAM + margin, no referral key)...');
    await ledger.sendMint(sender, {
        n,
        kind,
        factors,
        referralKey: 0,
        beneficiary: null,
        value: MINT_VALUE_NANOTON + FEE_MARGIN_NANOTON, // G58: shared, never the exact price
    });

    console.log('waiting 30s for internal hops (tribute credits, treasury forward)...');
    await new Promise((r) => setTimeout(r, 30_000));

    // --- AFTER ---
    const headAfter = await retry(() => ledger.getHead(), 'getHead(after)');
    const Tafter = await retry(() => ledger.getFloorNum(), 'getFloorNum(after)');
    const Safter = await retry(() => ledger.getFloorDen(), 'getFloorDen(after)');
    const pendingAfter = await retry(() => ratchet.getPending(), 'getPending(after)');
    const opTotalsAfter = await retry(() => ledger.getOperatorTotals(), 'getOperatorTotals(after)');
    const treasuryBalAfter = await retry(() => client.getBalance(Address.parse(TREASURY)), 'treasuryBalance(after)');
    const factorStateAfter: { prime: bigint; unsold: boolean; forfeitedAfter: bigint }[] = [];
    for (const f of factors) {
        const unsold = await retry(() => ledger.isPrimeUnsold(f.prime), `isPrimeUnsold(after,${f.prime})`);
        const forfeitedAfter = await retry(() => ledger.getForfeited(f.prime), `getForfeited(after,${f.prime})`);
        factorStateAfter.push({ prime: f.prime, unsold, forfeitedAfter });
    }

    console.log('--- AFTER ---');
    console.log(`head=${headAfter} T=${Tafter} S=${Safter} p_f=${Number(Tafter) / Number(Safter)}`);
    console.log(`ratchet.pending=${pendingAfter}`);
    console.log(
        `operatorTotals: operatorPaidTotal=${opTotalsAfter.operatorPaidTotal} treasuryPaidTotal=${opTotalsAfter.treasuryPaidTotal} opsSweptTotal=${opTotalsAfter.opsSweptTotal}`
    );
    console.log(`treasury contract balance=${treasuryBalAfter}`);
    for (const fs2 of factorStateAfter) {
        console.log(`  factor ${fs2.prime}: unsold=${fs2.unsold} forfeitedAfter=${fs2.forfeitedAfter}`);
    }

    console.log('--- DELTAS / RECONCILIATION (CONCEPT.md §4.1) ---');
    const pendingDelta = pendingAfter - pendingBefore;
    const treasuryMeterDelta = opTotalsAfter.treasuryPaidTotal - opTotalsBefore.treasuryPaidTotal;
    const operatorMeterDelta = opTotalsAfter.operatorPaidTotal - opTotalsBefore.operatorPaidTotal;
    const treasuryBalDelta = treasuryBalAfter - treasuryBalBefore;
    let forfeitTotal = 0n;
    for (let i = 0; i < factors.length; i++) {
        const before = factorState[i];
        const after = factorStateAfter[i];
        const d = after.forfeitedAfter - before.forfeitedBefore;
        if (d !== 0n) console.log(`  factor ${before.prime}: forfeited-to-treasury this mint = ${d}`);
        forfeitTotal += d;
    }
    console.log(`ratchet.pending delta (pool injection beta) = ${pendingDelta}`);
    // D-100 point 6 splits a forfeit between the two meters, and D-152 puts
    // §4.1's 5% line on the TREASURY side of that pair: `treasuryPaidTotal`
    // carries two terms, `operatorPaidTotal` carries the remainder alone. The
    // contract divides once and gives the operator the remainder rather than
    // truncating twice, so mirror that here.
    const forfeitToTreasury = (forfeitTotal * BigInt(forfeitTreasuryBps)) / 10_000n;
    const expectTreasuryMeter = TREASURY_AMOUNT + forfeitToTreasury;
    const expectOperatorMeter = forfeitTotal - forfeitToTreasury;
    console.log(
        `operatorTotals.treasuryPaidTotal delta = ${treasuryMeterDelta} (expect TREASURY_AMOUNT ${TREASURY_AMOUNT} + ${forfeitTreasuryBps}bps of forfeit ${forfeitTotal} = ${expectTreasuryMeter})`
    );
    console.log(
        `operatorTotals.operatorPaidTotal delta = ${operatorMeterDelta} (expect forfeit remainder ${expectOperatorMeter}, and ZERO on a mint whose cited factors all have owners)`
    );
    console.log(`treasury contract GRAM balance delta = ${treasuryBalDelta} (same-tx forward, may lag/differ slightly due to incidental network fees/other loops touching the address)`);
    const ratchetTheoremHolds = Tafter * Sbefore > Tbefore * Safter;
    console.log(`ratchet theorem (T_after*S_before > T_before*S_after): ${ratchetTheoremHolds}`);
    console.log(`floor p_f strictly increased: ${Number(Tafter) / Number(Safter) > Number(Tbefore) / Number(Sbefore)}`);

    let expected = n + 1n;
    while (isPrime(expected)) expected += 1n;
    if (headAfter !== expected) {
        throw new Error(`mint did not advance the head correctly (head=${headAfter}, expected ${expected})`);
    }
    if (!ratchetTheoremHolds) {
        throw new Error('ratchet theorem did NOT hold on this mint — genuine defect, do not paper over');
    }
    // Both meters are ledger get-methods written in the mint transaction itself —
    // no hop to lag behind, so these are exact and a mismatch is a real defect.
    if (treasuryMeterDelta !== expectTreasuryMeter || operatorMeterDelta !== expectOperatorMeter) {
        throw new Error(
            `fee-meter reconciliation MISMATCH — treasuryPaidTotal delta ${treasuryMeterDelta} (expect ${expectTreasuryMeter}), ` +
                `operatorPaidTotal delta ${operatorMeterDelta} (expect ${expectOperatorMeter}). File as a new GAUNTLET item, do not silently accept.`
        );
    }

    console.log(`tx: lt=${lastLt} hash=${lastHash}`);
    console.log('PROOF MINT OK');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
