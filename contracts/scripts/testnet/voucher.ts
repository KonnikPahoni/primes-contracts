/**
 * TON PRIMES — claim a quest voucher on testnet (§9.5, G76/G78, D-171).
 *
 * No webapp route sends `claim_voucher` yet (GAUNTLET G76b), so this is the one driver that
 * redeems what the attribution service signs. It asks the LIVE signer for the wallet's voucher
 * (every figure is derived server-side; the request carries only the wallet and the program),
 * reads `getPaid` BEFORE sending, and sends nothing when there is nothing new to pay.
 *
 *   npx tsx contracts/scripts/testnet/voucher.ts <quests|prime_quests> <handle>
 *
 * Env: PRIMES_ATTRIBUTION_URL (default https://primes.live/attribution).
 */
import { toNano } from '@ton/core';
import { PrimesVoucher } from '../../wrappers/PrimesVoucher';
import { retry } from './sender';
import { addr, contracts, walletFor } from './chain';
import * as A from './assert';
import { fromAsserts, record } from './journal';

async function main() {
    const [program, handle] = process.argv.slice(2);
    if ((program !== 'quests' && program !== 'prime_quests') || !handle) {
        throw new Error('usage: voucher.ts <quests|prime_quests> <handle>');
    }
    const c = contracts();
    const w = await walletFor(c.client, handle);
    const voucherAddr = addr(program === 'prime_quests' ? 'PRIMES_PRIME_QUESTS_VOUCHER_ADDRESS' : 'PRIMES_VOUCHER_ADDRESS');
    const voucher = c.client.open(PrimesVoucher.createFromAddress(voucherAddr));
    const base = (process.env.PRIMES_ATTRIBUTION_URL ?? 'https://primes.live/attribution').replace(/\/+$/, '');

    const res = await fetch(`${base}/voucher`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: w.wallet.address.toString({ testOnly: true }), program }),
    });
    const body = (await res.json()) as { cumulativeTotal?: string; validUntil?: number; signature?: string; error?: string };
    if (!res.ok || !body.cumulativeTotal || !body.signature || !body.validUntil) {
        throw new Error(`signer refused (${res.status}): ${body.error ?? JSON.stringify(body)} — nothing sent`);
    }
    const total = BigInt(body.cumulativeTotal);
    const paidBefore = await retry(() => voucher.getPaid(w.wallet.address), 'getPaid');
    console.log(`${handle} ${program}: signed cumulative ${Number(total) / 1e9} PRIMES, paid so far ${Number(paidBefore) / 1e9}`);
    if (total <= paidBefore) {
        console.log('nothing new to pay — nothing sent');
        return;
    }
    if (body.validUntil <= Math.floor(Date.now() / 1000) + 60) throw new Error('voucher expires within a minute — nothing sent');

    await voucher.sendClaim(w.sender, {
        cumulativeTotal: total,
        validUntil: body.validUntil,
        signature: Buffer.from(body.signature, 'hex'),
        value: toNano('0.15'),
    });
    await new Promise((r) => setTimeout(r, 40_000));
    const paidAfter = await retry(() => voucher.getPaid(w.wallet.address), 'getPaid(after)');
    const results: A.AssertResult[] = [
        {
            ok: paidAfter === total,
            name: 'VOUCHER_PAID_TO_TOTAL',
            getMethod: `voucher(${program}).getPaid`,
            before: String(paidBefore),
            after: String(paidAfter),
            detail: 'the claim pays up to the signed cumulative total and not a nanoton past it (a high-water mark)',
        },
    ];
    record({ phase: 'P', op: `voucher-${program}-${handle}`, ok: results.every((r) => r.ok), asserts: fromAsserts(results) });
    A.requireAll(results);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
