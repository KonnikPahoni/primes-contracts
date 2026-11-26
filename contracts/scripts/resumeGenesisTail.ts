/**
 * TON PRIMES — resume a genesis run that died AFTER every deploy + bootstrap link landed.
 *
 * `genesisPipeline.ts` steps 1–5 (deploys, wiring, allocation mint, vault fund, sink
 * wallets, vesting tranche 0) are one-shot and cannot be replayed; steps 5-verify..8 are
 * all guarded by a get-method, so they can. This picks up from the treasury tranche-0
 * verification and runs seal → genesis-seed → timelock queue, skipping each one the
 * chain already shows done. Written for the 2026-09-07 run, which the generator timeout killed
 * mid `vesting:treasury-tranche-0` (MISTAKES.md); the runbook in docs/testnet-deployment.md
 * says to run the pipeline under no timeout, but the recovery is cheap enough to keep.
 *
 *   PRIMES_LEDGER_ADDRESS=… PRIMES_JETTON_MASTER_ADDRESS=… PRIMES_TIMELOCK_ADDRESS=…
 *   PRIMES_TREASURY_ADDRESS=… PRIMES_TREASURY_VESTING_ADDRESS=… PRIMES_RATCHET_ADDRESS=…
 *   PRIMES_DEDUST_*_ADDR=…
 *   PRIMES_DEPLOY_SUBWALLET_ID=… npx tsx scripts/resumeGenesisTail.ts [--mainnet]
 *
 * Network: `--mainnet` / `--testnet`, else PRIMES_NETWORK, else testnet (`scriptNetwork`, G96).
 */
import fs from 'fs';
import path from 'path';
import { Address, TonClient, WalletContractV4, SendMode, internal } from '@ton/ton';
import type { Sender, SenderArguments } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { toNano } from '@ton/core';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesTreasury } from '../wrappers/PrimesTreasury';
import { PrimesVesting } from '../wrappers/PrimesVesting';
import { OPENING_HEAD } from './genesisPipeline';
import { throttleClient } from './scriptHost';
import params from '../../shared/params.json';

import { clockDivisorOf, hydrateProcessEnv, readNetworkConfig, scriptNetwork } from './envFile';
import { requireValue } from '../../shared/networkConfig';

// W10: `tsx` loads no `.env`, and every `process.env.PRIMES_*_ADDRESS` read below
// otherwise falls through to a hardcoded address from a genesis that is months dead
// — silently, because a dead-but-still-answering contract returns plausible numbers
// rather than an error. `hydrateProcessEnv()` is the one reader that ends that; it
// never overwrites a var the shell already set.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
const TIMELOCK_DELAY = 2592000; // 30 days, primes_venue_timelock.tolk

const addr = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return Address.parse(v);
};
const settle = (step: string) => {
    console.log(`… ${step}`);
    return new Promise((r) => setTimeout(r, 10_000));
};

async function main() {
    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const mnemonic = envFile
        .match(/^DEPLOYER_MNEMONIC=(.*)$/m)![1]
        .trim()
        .replace(/^"|"$/g, '')
        .split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const walletId = Number(process.env.PRIMES_DEPLOY_SUBWALLET_ID);
    if (!walletId) throw new Error('PRIMES_DEPLOY_SUBWALLET_ID required (the run being resumed)');
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });

    const net = scriptNetwork();
    const client = new TonClient({ endpoint: net.endpoint, apiKey: net.apiKey });
    throttleClient(client);
    const walletContract = client.open(wallet);
    console.log(`network: ${net.network}  wallet: ${wallet.address.toString({ testOnly: net.testOnly })}`);

    const r = await fetch(`${net.endpoint.replace(/\/jsonRPC$/, '')}/getAddressInformation?address=${wallet.address.toString()}`);
    const chainNow = Number(((await r.json()) as any)?.result?.sync_utime);
    if (!chainNow) throw new Error('no sync_utime');
    const clockSkew = chainNow - Math.floor(Date.now() / 1000);
    console.log('clock skew:', clockSkew);

    const sender: Sender = {
        address: wallet.address,
        async send(args: SenderArguments) {
            const seqno = await walletContract.getSeqno();
            await walletContract.sendTransfer({
                seqno,
                secretKey: keyPair.secretKey,
                timeout: Math.floor(Date.now() / 1000) + clockSkew + 600,
                sendMode: args.sendMode ?? SendMode.PAY_GAS_SEPARATELY,
                messages: [
                    internal({
                        to: args.to,
                        value: args.value,
                        bounce: args.bounce ?? undefined,
                        init: args.init ?? undefined,
                        body: args.body ?? undefined,
                    }),
                ],
            });
            let cur = seqno;
            for (let i = 0; cur === seqno && i < 60; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                cur = await walletContract.getSeqno();
            }
            if (cur === seqno) throw new Error(`external not confirmed (seqno stuck at ${seqno})`);
            console.log(`[confirmed] seqno=${cur}`);
        },
    };

    const ledger = client.open(PrimesLedger.createFromAddress(addr('PRIMES_LEDGER_ADDRESS')));
    const master = client.open(PrimesJettonMaster.createFromAddress(addr('PRIMES_JETTON_MASTER_ADDRESS')));
    const timelock = client.open(PrimesVenueTimelock.createFromAddress(addr('PRIMES_TIMELOCK_ADDRESS')));
    const treasury = client.open(PrimesTreasury.createFromAddress(addr('PRIMES_TREASURY_ADDRESS')));
    const trVesting = client.open(PrimesVesting.createFromAddress(addr('PRIMES_TREASURY_VESTING_ADDRESS')));

    // 5-verify (genesisPipeline.ts): tranche 0 landed on the treasury's books.
    const v = await trVesting.getVesting();
    if (v.releasedAmount === 0n) throw new Error("the treasury vesting lock's tranche 0 did not release");
    const trBal = await treasury.getTreasuryBalances();
    if (trBal.primesBalance !== v.releasedAmount) {
        throw new Error(`treasury lock released ${v.releasedAmount} but treasury books show ${trBal.primesBalance}`);
    }
    console.log(`treasury vesting tranche 0 released: ${v.releasedAmount} nanoPRIMES, on the books.`);

    // 6. seal
    if ((await master.getJettonData()).genesisSealed === 1) {
        console.log('jetton authority already sealed');
    } else {
        await master.sendSealAuthority(sender, { value: toNano('0.05') });
        await settle('jetton:seal');
        if ((await master.getJettonData()).genesisSealed !== 1) throw new Error('jetton authority did not seal');
        console.log('jetton authority sealed');
    }

    // 7. genesis seed. S₀ = the treasury vesting lock's allocation (D-166: one lock) + the bounty vault,
    //    exactly what the pipeline computes; both figures are read back from chain
    //    rather than restated: the master's total supply IS everything minted so far.
    const head = await ledger.getHead();
    if (head >= OPENING_HEAD) {
        console.log(`minting already open: head=${head}`);
    } else {
        const seedS = (await master.getJettonData()).totalSupply;
        const expected = BigInt(Math.round(params.genesis.bounty_vault_size_primes * 1e9));
        if (seedS <= expected) throw new Error(`total supply ${seedS} is not vault + allocation`);
        await ledger.sendGenesisSeed(sender, { seedT: 0n, seedS, seedHead: OPENING_HEAD, value: toNano('0.2') });
        await settle('ledger:genesis-seed');
        if ((await ledger.getHead()) !== OPENING_HEAD) throw new Error('genesis seed did not land');
        console.log(`minting open: T=0 S=${seedS} head=${OPENING_HEAD}`);
    }

    // 8. timelock queue
    if ((await timelock.getQueued()).hasQueued === 1) {
        console.log('venue timelock already queued');
    } else {
        const cfg = readNetworkConfig(net.network);
        const eta = Math.floor(Date.now() / 1000) + clockSkew + Math.floor(TIMELOCK_DELAY / clockDivisorOf(cfg)) + 300; // D-139: the divided delay
        await timelock.sendQueue(sender, {
            dedustNativeVault: Address.parse(requireValue(cfg, 'dedust_native_vault', cfg.dedustNativeVault)),
            dedustPool: addr('PRIMES_DEDUST_POOL_ADDR'),
            primesJettonVault: addr('PRIMES_DEDUST_JETTON_VAULT_ADDR'),
            eta,
            value: toNano('0.1'),
        });
        await settle('timelock:queue');
        if ((await timelock.getQueued()).hasQueued !== 1) throw new Error('venue timelock queue did not land');
        console.log(`venue timelock queued, eta=${eta}`);
    }
    console.log('genesis complete');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
