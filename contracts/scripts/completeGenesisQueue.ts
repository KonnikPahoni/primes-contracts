/**
 * TON PRIMES — genesis step 8 retry + post-deploy verification.
 *
 * The 2026-08-16 skew-safe genesis (then deployGenesisSkewSafe.ts; since G55 it is
 * `deployGenesis.ts --skew-safe`) completed every
 * step except the final, RETRYABLE venue-timelock queue: genesisPipeline
 * computes `eta = now + TIMELOCK_DELAY + 60` from the LOCAL clock, which lags
 * chain time by ~113s on this machine, so the contract's `eta >= now + DELAY`
 * assert failed and the queue bounced. This script re-sends the queue with a
 * 600s margin and then reads back the whole deployment's state via public
 * get-methods (§9.1: everything asserted here is reader-verifiable).
 *
 *   npx tsx scripts/completeGenesisQueue.ts [--mainnet]   (network: scriptNetwork, G96)
 *                                              (tsx, NOT ts-node — ts-node fails
 *                                              with ERR_REQUIRE_ESM on shared/)
 */
import fs from 'fs';
import path from 'path';
import { Address, SendMode, TonClient, WalletContractV4, internal, toNano } from '@ton/ton';
import type { Sender, SenderArguments } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { PrimesVenueTimelock } from '../wrappers/PrimesVenueTimelock';
import { PrimesLedger } from '../wrappers/PrimesLedger';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesCollection } from '../wrappers/PrimesCollection';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesMarket } from '../wrappers/PrimesMarket';
import { PrimesRegistrar } from '../wrappers/PrimesRegistrar';
import { PrimesStake } from '../wrappers/PrimesStake';
import { PrimesTreasury } from '../wrappers/PrimesTreasury';
import { PrimesLpSink } from '../wrappers/PrimesLpSink';
import { PrimesVesting } from '../wrappers/PrimesVesting';

import { clockDivisorOf, hydrateProcessEnv, readNetworkConfig, scriptNetwork } from './envFile';
import { requireValue } from '../../shared/networkConfig';

// W10: `tsx` loads no `.env`, and every `process.env.PRIMES_*_ADDRESS` read below
// otherwise falls through to a hardcoded address from a genesis that is months dead
// — silently, because a dead-but-still-answering contract returns plausible numbers
// rather than an error. `hydrateProcessEnv()` is the one reader that ends that; it
// never overwrites a var the shell already set.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
const TIMELOCK_DELAY = 30 * 24 * 3600;

// !!! STALE. These are the 2026-08-17 unified-market genesis addresses
// (subwallet 698983192). W1-W6 changed storage layouts, wire formats and init
// data across the board and added TWO CONTRACTS, so every address below belongs
// to a deployment this source can no longer talk to — see
// docs/testnet-deployment.md's superseded banner. They are kept only as the
// shape of the map; after the W8.3 redeploy, set every PRIMES_<NAME>_ADDRESS
// env var (including the two new ones) rather than editing these defaults, and
// let docs/testnet-deployment.md be the record.
const A = {
    collection: process.env.PRIMES_COLLECTION_ADDRESS ?? 'EQD1g2mFGfwUY3biqIn1snjKzNjJi3swNb6z_uC2UaCHZr9W',
    master: process.env.PRIMES_JETTON_MASTER_ADDRESS ?? 'EQDn54lZDlus8a4yKXiTt8UDexv63u6QiKjb2AWyaRQandHt',
    timelock: process.env.PRIMES_VENUE_TIMELOCK_ADDRESS ?? 'EQCzmTdWRk74LL0Kna0viLg55u29hq79LADwBDX1nBPL60OP',
    ledger: process.env.PRIMES_LEDGER_ADDRESS ?? 'EQDjioqExVB2Ywx3fWanucWfWZrMqHaDGiNXA4hS-yHg9fg1',
    ratchet: process.env.PRIMES_RATCHET_ADDRESS ?? 'EQAhv6F-wLa2yWH9WSA7zbqs24kcAh6tjItxalnPFztoKhwV',
    registrar: process.env.PRIMES_REGISTRAR_ADDRESS ?? 'EQDFZp5uYsKjvVevw_UWBDEX4G6asCj_g4ZN_x4hr2WgRtX-',
    market: process.env.PRIMES_MARKET_ADDRESS ?? 'EQA8CviVF9QPFiDpvx8m3VGid0iEtExJjpW8kLN1STa6NL1S',
    vault: process.env.PRIMES_BOUNTY_VAULT_ADDRESS ?? 'EQCaiuWvX0Q6dnqpVKnrzK7JBj1OEUZF5R9zSdxYGrzY5KsM',
    // W5 — NO DEFAULT ON PURPOSE. These contracts did not exist in the
    // deployment above, so there is no stale address to carry forward and a
    // placeholder would be a lie. The two checks below skip themselves when the
    // env var is absent and say so.
    stake: process.env.PRIMES_STAKE_ADDRESS,
    // D-100 points 4/6/7 — same no-default rule, same reason: these contracts do
    // not exist on any deployment in docs/testnet-deployment.md, so there is no
    // stale address to carry forward and a placeholder would be a lie.
    treasury: process.env.PRIMES_TREASURY_ADDRESS,
    lpSink: process.env.PRIMES_LP_SINK_ADDRESS,
    treasuryVesting: process.env.PRIMES_TREASURY_VESTING_ADDRESS,
};

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
    // The queue must be sent by the timelock's PROPOSER (PRIMES_PROPOSER_ADDR at
    // genesis — the deployer mnemonic's default wallet in the 2026-08-17 deployment, NOT the deploy
    // subwallet). Default walletId = the main wallet; set PRIMES_DEPLOY_SUBWALLET_ID
    // only if the proposer was the subwallet.
    const walletId = process.env.PRIMES_DEPLOY_SUBWALLET_ID
        ? Number(process.env.PRIMES_DEPLOY_SUBWALLET_ID)
        : undefined;
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });
    // GAUNTLET X4 + G96: the configured base for the network this run targets.
    const net = scriptNetwork();
    console.log('network:', net.network);
    const client = new TonClient({ endpoint: net.endpoint, apiKey: net.apiKey });
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

    const timelock = client.open(PrimesVenueTimelock.createFromAddress(Address.parse(A.timelock)));

    const pre = await retry(() => timelock.getQueued(), 'getQueued(pre)');
    console.log('queued before:', pre.hasQueued);
    if (pre.hasQueued !== 1) {
        const cfg = readNetworkConfig(net.network);
        // 600s margin over the 30-day minimum: covers the ~113s local-clock lag
        const eta = Math.floor(Date.now() / 1000) + Math.floor(TIMELOCK_DELAY / clockDivisorOf(cfg)) + 600; // D-139: the divided delay
        await timelock.sendQueue(sender, {
            dedustNativeVault: Address.parse(requireValue(cfg, 'dedust_native_vault', cfg.dedustNativeVault)),
            dedustPool: Address.parse(process.env.PRIMES_DEDUST_POOL_ADDR!),
            primesJettonVault: Address.parse(process.env.PRIMES_DEDUST_JETTON_VAULT_ADDR!),
            eta,
            value: toNano('0.1'),
        });
        await new Promise((r) => setTimeout(r, 10_000));
        const post = await retry(() => timelock.getQueued(), 'getQueued(post)');
        console.log('queued after:', post.hasQueued, 'eta:', post.eta);
        if (post.hasQueued !== 1) throw new Error('queue still not landed');
    }

    // ---- post-deploy verification, every line a public get-method ----
    const ledger = client.open(PrimesLedger.createFromAddress(Address.parse(A.ledger)));
    const master = client.open(PrimesJettonMaster.createFromAddress(Address.parse(A.master)));
    console.log('head:', await retry(() => ledger.getHead(), 'getHead'));
    const jd = await retry(() => master.getJettonData(), 'getJettonData');
    console.log('jetton: supply', jd.totalSupply, 'sealed', jd.genesisSealed, 'ledgerAddr', jd.ledgerAddr.toString());
    // P2.A7 merged the old book into the market; `getLedger` went with the
    // merge — the market publishes its deploy-fixed peers as one call instead.
    const market = client.open(PrimesMarket.createFromAddress(Address.parse(A.market)));
    console.log('market.launched:', await retry(() => market.getLaunched(), 'market.getLaunched'));
    console.log('market.headHint:', await retry(() => market.getHeadHint(), 'market.getHeadHint'));
    console.log('T (floorNum):', await retry(() => ledger.getFloorNum(), 'getFloorNum'));
    console.log('S (floorDen):', await retry(() => ledger.getFloorDen(), 'getFloorDen'));
    const collection = client.open(PrimesCollection.createFromAddress(Address.parse(A.collection)));
    const cd = await retry(() => collection.getCollectionData(), 'getCollectionData');
    console.log('collection.ledgerAddr:', cd.ledgerAddr.toString(), 'nextIndex:', cd.nextIndex);
    const ratchet = client.open(PrimesRatchet.createFromAddress(Address.parse(A.ratchet)));
    console.log('ratchet.pending:', await retry(() => ratchet.getPending(), 'getPending'));
    console.log('ratchet.swapped:', await retry(() => ratchet.getSwapped(), 'getSwapped'));

    // W3 / D-26: `T = seedT + swapped + pending`, and it is THREE get-calls
    // across TWO contracts. Printed together so the operator can close the
    // identity by eye instead of reading a two-term version of it and reporting
    // a permanent false solvency gap (CLAUDE.md's invariant list).
    const seedT = await retry(() => ledger.getSeedT(), 'getSeedT');
    const pending = await retry(() => ratchet.getPending(), 'getPending(identity)');
    const swapped = await retry(() => ratchet.getSwapped(), 'getSwapped(identity)');
    const T = await retry(() => ledger.getFloorNum(), 'getFloorNum(identity)');
    // D-151: the keeper stakes `pending` above the stake minimum within minutes of ignite, so the
    // staked reserve's three terms are part of the identity (assert.ts `tIdentity`). Without them the
    // 20261126 read-back printed a false MISMATCH: pending 10 + staked 40 = T 50.
    const st = await retry(() => ratchet.getStaking(), 'getStaking(identity)');
    const sum = seedT + swapped + pending + st.stakedCost + st.exiting + st.realizedLoss;
    console.log(
        `D-26 identity: seedT ${seedT} + swapped ${swapped} + pending ${pending} + staked ${st.stakedCost} + ` +
            `exiting ${st.exiting} + realizedLoss ${st.realizedLoss} = ${sum} vs T ${T} -> ${sum === T ? 'OK' : 'MISMATCH'}`
    );

    // `minAuctionDistance` is DELETED (D-45) — there is no liveness gate left
    // to read back. `getMarketParams()` still confirms the rest of the shipped
    // auction format.
    await retry(() => market.getMarketParams(), 'getMarketParams');

    // ---- W5: the stake master; D-212: the naming fees ----
    const registrar = client.open(PrimesRegistrar.createFromAddress(Address.parse(A.registrar)));
    console.log('registrar.trophyRenameFee:', await retry(() => registrar.getTrophyRenameFee(), 'getTrophyRenameFee'));

    if (A.stake) {
        const stake = client.open(PrimesStake.createFromAddress(Address.parse(A.stake)));
        const cfg = await retry(() => stake.getStakeConfig(), 'stake.getStakeConfig');
        console.log('stake.walletSet:', cfg.walletSet, 'treasuryAddr:', cfg.treasuryAddr.toString(),
            '(0 = every stake refused with 1100)');
        console.log('stake.solvency (ST-1):', await retry(() => stake.getStakeSolvency(), 'stake.getStakeSolvency'));
    } else {
        console.log('stake: PRIMES_STAKE_ADDRESS unset — skipped (set it after the W8.3 redeploy)');
    }

    // ---- D-100: the treasury, the LP sink and the treasury's vesting lock (D-166 deleted the operator's) ----
    //
    // These are the read-backs that catch the two D-100 bootstraps that fail
    // QUIETLY. `walletsSet`/`walletSet` at 0 does not look like an error from
    // anywhere else: the treasury simply refuses every deposit with 1150 and the
    // LP sink every one with 1170, so LP bounces back to depositors and nothing
    // in this log would otherwise say why.
    if (A.treasury) {
        const treasury = client.open(PrimesTreasury.createFromAddress(Address.parse(A.treasury)));
        const cfg = await retry(() => treasury.getTreasuryConfig(), 'treasury.getTreasuryConfig');
        console.log('treasury.walletsSet:', cfg.walletsSet, '(0 = every deposit refused with 1150)');
        console.log('treasury.sinkAddr:', cfg.sinkAddr.toString(), 'operatorAddr:', cfg.operatorAddr.toString());
        console.log('treasury.balances:', await retry(() => treasury.getTreasuryBalances(), 'treasury.getTreasuryBalances'));
        console.log('treasury.distribution:', await retry(() => treasury.getDistribution(), 'treasury.getDistribution'));
    } else {
        console.log('treasury: PRIMES_TREASURY_ADDRESS unset — skipped (set it after the D-100 redeploy)');
    }
    if (A.lpSink) {
        const lpSink = client.open(PrimesLpSink.createFromAddress(Address.parse(A.lpSink)));
        const cfg = await retry(() => lpSink.getLpSinkConfig(), 'lpSink.getLpSinkConfig');
        console.log('lpSink.walletSet:', cfg.walletSet, 'lpJettonWallet:', cfg.lpJettonWalletAddr.toString());
        // TR-6: compare this against that wallet's own balance rather than
        // trusting it. They are meant to be equal, and the point of publishing
        // both is that an auditor does not have to take either on faith.
        console.log('lpSink.locked:', await retry(() => lpSink.getLocked(), 'lpSink.getLocked'),
            'events:', await retry(() => lpSink.getEvents(), 'lpSink.getEvents'));
    } else {
        console.log('lpSink: PRIMES_LP_SINK_ADDRESS unset — skipped (set it after the D-100 redeploy)');
    }
    for (const [label, addr] of [['treasuryVesting', A.treasuryVesting]] as const) {
        if (!addr) {
            console.log(`${label}: address env var unset — skipped (set it after the D-100 redeploy)`);
            continue;
        }
        const lock = client.open(PrimesVesting.createFromAddress(Address.parse(addr)));
        const v = await retry(() => lock.getVesting(), `${label}.getVesting`);
        console.log(
            `${label}: total=${v.totalAmount} released=${v.releasedAmount} unlocked=${v.unlocked}/${v.tranches} ` +
                `startTime=${v.startTime} beneficiary=${v.beneficiary.toString()}`
        );
        // D-100 point 6: the treasury lock's beneficiary must be the TREASURY
        // CONTRACT. A lock pointed at a wallet is a vest with a key, which is the
        // one property point 7 exists to deny.
        if (label === 'treasuryVesting' && A.treasury && v.beneficiary.toString() !== Address.parse(A.treasury).toString()) {
            console.log('!!! treasuryVesting beneficiary is NOT the treasury contract — abandon this set');
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
