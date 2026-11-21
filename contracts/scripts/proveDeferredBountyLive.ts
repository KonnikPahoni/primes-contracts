/**
 * TON PRIMES — GAUNTLET H17: the deferred bounty payout, the whole round trip, on chain.
 *
 * `DECISIONS.md` D-129 option A: when the vault cannot afford the 0.1 TON jetton hop, the
 * payout is **journalled without being sent** — no paid flag, no `paidTotal`, no
 * `payoutCount`, no message — so the already-existing `RetryBountyPayout` can finish it
 * from that row unmodified once the vault is funded again. Before it, three real payouts
 * were lost in silence on 2026-09-14: the action phase failed with result 37, the whole
 * transaction reverted, and the ledger forwards the trigger `NoBounce` on purpose so that a
 * vault failure never unwinds a mint.
 *
 * **WHY THIS DEPLOYS A COPY.** H17 names two ways to starve a vault and only one of them
 * still works. "Triggering payouts until it is short" does not: `GAUNTLET.md` H11 corrected
 * `payOut`'s `responseAddr` to name the vault, so TEP-74's excess comes home and each payout
 * is measured at **+0.0124 TON** — the live vault gains TON with every bounty it pays and
 * can no longer drain itself. So this deploys a second instance of the SAME compiled
 * bytecode with a thin balance, names this wallet as its `ledgerAddr` so the payout can be
 * triggered, and drives the round trip against it. Nothing on the live set is touched: the
 * copy is its own contract, holds its own PRIMES, and the real vault never hears about it.
 *
 * THE ROUND TRIP, and each assertion is one of the four D-129 names:
 *
 *   1. deploy the copy below `TRANSFER_GAS + STORAGE_FLOOR` (0.1 + 0.05 TON);
 *   2. wire its jetton wallet and send it the PRIMES the payout will move;
 *   3. `PayEraBounty` -> **journalled, not sent**: `deferredCount` 1, `payoutCount`
 *      UNMOVED, the era's paid flag CLEAR;
 *   4. top the copy up, then `RetryBountyPayout` (permissionless — no sender check on that
 *      arm) -> `payoutCount` +1, `deferredCount` back to 0, the flag set, and the
 *      beneficiary's PRIMES actually arrived.
 *
 *   npx tsx contracts/scripts/proveDeferredBountyLive.ts
 *
 * Env: `PRIMES_JETTON_MASTER_ADDRESS`, `KEEPER_WALLET_MNEMONIC`; the sender defaults to the
 * deploy subwallet, which is what `donateFloor.ts` leaves holding PRIMES.
 * `PRIMES_H17_PRIMES` (default 100) is how many PRIMES the bounty moves — the era entry
 * prices at `bounty_ton * S / T` capped by `max_primes`, and this script solves for the `t`
 * that yields the target rather than funding the copy with 600,000 PRIMES it does not need.
 */
import fs from 'fs';
import path from 'path';
import { Address, Cell, SendMode, TonClient, WalletContractV4, beginCell, internal, toNano } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesBountyVault, type EraBounty } from '../wrappers/PrimesBountyVault';
import { deploySubwalletId, envValue, hydrateProcessEnv, loadEnvFile } from './envFile';

hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
const BUILD = path.resolve(__dirname, '..', 'build');

/** `primes_bounty_vault.tolk`'s own two constants — the affordability question. */
const TRANSFER_GAS = toNano('0.1');
const STORAGE_FLOOR = toNano('0.05');
/** Deliberately under `TRANSFER_GAS + STORAGE_FLOOR`, which is the whole point. */
const THIN_DEPLOY = toNano('0.08');
const NANO = 1_000_000_000n;

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

function loadCode(name: string): Cell {
    const j = JSON.parse(fs.readFileSync(path.join(BUILD, `${name}.compiled.json`), 'utf8'));
    return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
}

async function walletAddressOf(client: TonClient, master: Address, owner: Address): Promise<Address> {
    const r = await client.runMethod(master, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
    ]);
    return r.stack.readAddress();
}

async function jettonBalanceOf(client: TonClient, wallet: Address): Promise<bigint> {
    try {
        const r = await client.runMethod(wallet, 'get_wallet_data');
        return r.stack.readBigNumber();
    } catch {
        return 0n; // not deployed yet: it holds nothing, which is the honest answer
    }
}

async function main() {
    const env = loadEnvFile();
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: envValue(env, 'TONCENTER_API_KEY_TESTNET') || undefined,
    });
    const fmt = (a: Address) => a.toString({ testOnly: true });

    const masterAddr = Address.parse(req('PRIMES_JETTON_MASTER_ADDRESS'));
    const keyPair = await mnemonicToPrivateKey(req('KEEPER_WALLET_MNEMONIC').split(/\s+/));
    const wallet = client.open(
        WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
            walletId: process.env.PRIMES_FROM_SUBWALLET_ID
                ? Number(process.env.PRIMES_FROM_SUBWALLET_ID)
                : deploySubwalletId(env),
        })
    );
    const sender = wallet.sender(keyPair.secretKey);

    // The schedule is the real one. Only the INSTANCE is a copy.
    const genesisParams = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'params.json'), 'utf8')).genesis;
    // The nesting is real: `genesis.era_bounty_schedule` is the BLOCK, and the array is the
    // like-named key inside it. Mapped exactly as `deployGenesis.ts` does, so
    // the copy's schedule is the deployed one and not a second reading of the same file.
    const schedule: EraBounty[] = genesisParams.era_bounty_schedule.era_bounty_schedule.map((e: any) => ({
        eraBoundary: BigInt(e.era_boundary_n),
        bountyTon: BigInt(Math.round(e.bounty_ton * 1e9)),
        maxPrimes: BigInt(Math.round(e.max_primes * 1e9)),
    }));
    const era = schedule[0];

    const vault = client.open(
        PrimesBountyVault.createFromConfig(
            {
                schedule,
                // THIS WALLET is the copy's ledger, which is what makes the payout
                // triggerable at all — `PayEraBounty` asserts `sender == cfg.ledgerAddr`.
                ledgerAddr: wallet.address,
                jettonMasterAddr: masterAddr,
                genesisScriptAddr: wallet.address,
                // V26.7 — declared at the era's cap; the payout below is solved to
                // at most that and this script funds exactly it.
                fundedPrimes: era.maxPrimes,
            },
            loadCode('PrimesBountyVault')
        )
    );

    console.log('vault COPY: ', fmt(vault.address));
    console.log('jetton master:', fmt(masterAddr));
    console.log('from (its ledger and genesis script):', fmt(wallet.address));
    console.log('');

    // --- the amount, solved for rather than funded around --------------------
    //
    // `raw = bountyTon * s / t`, capped at `maxPrimes`. Era 6 at the genesis floor
    // prices at the cap, 600,000 PRIMES, which is 14x what the donation mints. The
    // mechanism under test is the deferral, not the size, so this solves for the `t`
    // that yields a target this wallet can actually fund and prints both.
    const targetPrimes = BigInt(process.env.PRIMES_H17_PRIMES ?? '100') * NANO;
    const s = 16_600_000n * NANO; // S0 (D-204), the same figure the real ledger reports at genesis
    const t = (era.bountyTon * s) / targetPrimes;
    const amount = era.bountyTon * s / t > era.maxPrimes ? era.maxPrimes : (era.bountyTon * s) / t;
    console.log(`era boundary ${era.eraBoundary}: bounty ${era.bountyTon} nanoton, cap ${era.maxPrimes} nanoPRIMES`);
    console.log(`driving it with (T = ${t}, S = ${s}) -> amount = ${amount} nanoPRIMES`);

    const ourJetton = await walletAddressOf(client, masterAddr, wallet.address);
    const held = await jettonBalanceOf(client, ourJetton);
    console.log(`our PRIMES wallet ${fmt(ourJetton)} holds ${held} nanoPRIMES`);
    if (held < amount) {
        throw new Error(
            `this wallet holds ${held} nanoPRIMES but the payout moves ${amount}. Lower ` +
                'PRIMES_H17_PRIMES, or run donateFloor.ts first (it mints the donor ~1,972,333 PRIMES).'
        );
    }

    // --- 1. deploy the copy, thin -------------------------------------------
    console.log(`\n--- 1. deploying the copy with ${THIN_DEPLOY} nanoton (floor is ${TRANSFER_GAS + STORAGE_FLOOR}) ---`);
    let seqno = await retry(() => wallet.getSeqno(), 'seqno');
    await vault.sendDeploy(sender, THIN_DEPLOY);
    await waitForSeqno(wallet, seqno, 'deploy');
    await sleep(10000);

    // --- 2. wire its wallet and send it the PRIMES ---------------------------
    const vaultJetton = await walletAddressOf(client, masterAddr, vault.address);
    console.log(`\n--- 2. set_wallet -> ${fmt(vaultJetton)} ---`);
    seqno = await retry(() => wallet.getSeqno(), 'seqno');
    await vault.sendSetWallet(sender, { jettonWalletAddr: vaultJetton, value: toNano('0.02') });
    await waitForSeqno(wallet, seqno, 'set_wallet');

    console.log(`--- 2b. sending it ${amount} nanoPRIMES ---`);
    // `forwardTonAmount: 0` on purpose: no `transfer_notification`, so the copy's own TON
    // balance does not move and step 3 still faces the shortfall this test is about.
    seqno = await retry(() => wallet.getSeqno(), 'seqno');
    await wallet.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [
            internal({
                to: ourJetton,
                value: toNano('0.1'),
                bounce: true,
                body: beginCell()
                    .storeUint(0x0f8a7ea5, 32) // TEP-74 transfer
                    .storeUint(0, 64)
                    .storeCoins(amount)
                    .storeAddress(vault.address)
                    .storeAddress(wallet.address) // response_destination — the excess comes home
                    .storeMaybeRef(null)
                    .storeCoins(0) // forward_ton_amount
                    .storeMaybeRef(null)
                    .endCell(),
            }),
        ],
    });
    await waitForSeqno(wallet, seqno, 'PRIMES transfer');
    await sleep(20000);

    const vaultBalanceBefore = await retry(() => client.getBalance(vault.address), 'copy balance');
    console.log(`copy TON balance: ${vaultBalanceBefore} nanoton (needs < ${TRANSFER_GAS + STORAGE_FLOOR} to defer)`);
    if (vaultBalanceBefore >= TRANSFER_GAS + STORAGE_FLOOR) {
        throw new Error(
            `the copy is at ${vaultBalanceBefore} nanoton, at or above the hop floor, so the payout ` +
                'would take the ORDINARY path and prove nothing. Lower THIN_DEPLOY and redeploy a fresh copy.'
        );
    }

    // --- 3. the payout that must be JOURNALLED AND NOT SENT ------------------
    const payoutsBefore = await retry(() => vault.getVaultPayouts(), 'getVaultPayouts(before)');
    const deferredBefore = await retry(() => vault.getDeferredPayouts(), 'getDeferredPayouts(before)');
    const beneficiaryJettonBefore = await jettonBalanceOf(client, ourJetton);
    console.log('\n--- 3. PayEraBounty against a vault that cannot afford the hop ---');
    console.log('before:', payoutsBefore, deferredBefore);

    seqno = await retry(() => wallet.getSeqno(), 'seqno');
    await vault.sendPayEraBounty(sender, {
        eraBoundary: era.eraBoundary,
        beneficiary: wallet.address,
        value: toNano('0.03'),
        t,
        s,
    });
    await waitForSeqno(wallet, seqno, 'PayEraBounty');
    await sleep(20000);

    const payoutsDeferred = await retry(() => vault.getVaultPayouts(), 'getVaultPayouts(deferred)');
    const deferredAfter = await retry(() => vault.getDeferredPayouts(), 'getDeferredPayouts(deferred)');
    const eraAfter = await retry(() => vault.getEraSchedule(era.eraBoundary), 'getEraSchedule(deferred)');
    console.log('after: ', payoutsDeferred, deferredAfter, 'era paid flag =', eraAfter.paid);

    const fail: string[] = [];
    if (deferredAfter.deferredCount !== deferredBefore.deferredCount + 1) {
        fail.push(`deferredCount ${deferredBefore.deferredCount} -> ${deferredAfter.deferredCount}, expected +1`);
    }
    if (payoutsDeferred.payoutCount !== payoutsBefore.payoutCount) {
        fail.push(`payoutCount MOVED (${payoutsBefore.payoutCount} -> ${payoutsDeferred.payoutCount}) — a payout that never left was reported as paid`);
    }
    if (eraAfter.paid !== 0) fail.push('the era paid flag was SET on a payout that was never sent');
    if ((await jettonBalanceOf(client, ourJetton)) !== beneficiaryJettonBefore) {
        fail.push('PRIMES moved on the deferred path — it must send nothing');
    }
    if (fail.length > 0) {
        console.log('\nFAILED at the deferral:');
        for (const f of fail) console.log(`  !! ${f}`);
        process.exit(1);
    }
    console.log('  OK — journalled, flag clear, payoutCount unmoved, nothing sent.');

    // --- 4. fund it, then let anybody finish it ------------------------------
    const journalKey = deferredAfter.journalKey - 1;
    console.log(`\n--- 4. top the copy up, then RetryBountyPayout(queryId = ${journalKey}) ---`);
    seqno = await retry(() => wallet.getSeqno(), 'seqno');
    await wallet.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [internal({ to: vault.address, value: toNano('1'), bounce: false, body: undefined })],
    });
    await waitForSeqno(wallet, seqno, 'top-up');
    await sleep(12000);

    seqno = await retry(() => wallet.getSeqno(), 'seqno');
    await vault.sendRetryBountyPayout(sender, { queryID: journalKey, value: toNano('0.15') });
    await waitForSeqno(wallet, seqno, 'RetryBountyPayout');
    await sleep(25000);

    const payoutsFinal = await retry(() => vault.getVaultPayouts(), 'getVaultPayouts(final)');
    const deferredFinal = await retry(() => vault.getDeferredPayouts(), 'getDeferredPayouts(final)');
    const eraFinal = await retry(() => vault.getEraSchedule(era.eraBoundary), 'getEraSchedule(final)');
    const beneficiaryJettonAfter = await jettonBalanceOf(client, ourJetton);
    console.log('final:', payoutsFinal, deferredFinal, 'era paid flag =', eraFinal.paid);
    console.log(`beneficiary PRIMES: ${beneficiaryJettonBefore} -> ${beneficiaryJettonAfter}`);

    if (payoutsFinal.payoutCount !== payoutsBefore.payoutCount + 1) {
        fail.push(`payoutCount ${payoutsBefore.payoutCount} -> ${payoutsFinal.payoutCount}, expected +1`);
    }
    if (deferredFinal.deferredCount !== deferredBefore.deferredCount) {
        fail.push(`deferredCount did not come back down (${deferredFinal.deferredCount})`);
    }
    if (eraFinal.paid !== 1) fail.push('the era paid flag is still clear after the retry');
    if (beneficiaryJettonAfter <= beneficiaryJettonBefore) fail.push('the PRIMES never arrived');
    if (fail.length > 0) {
        console.log('\nFAILED at the retry:');
        for (const f of fail) console.log(`  !! ${f}`);
        process.exit(1);
    }
    console.log('\nH17 PROVEN: D-129 option A journalled a payout it could not send, and');
    console.log('RetryBountyPayout finished it from that row once the vault could afford the hop.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
