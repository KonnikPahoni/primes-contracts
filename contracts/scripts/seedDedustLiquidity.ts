/**
 * TON PRIMES — seed the PRIMES/TON DeDust pool and lock the LP receipt.
 * RUN THIS AFTER GENESIS AND AFTER `donateFloor.ts`.
 *
 * This is D-100's "MANUAL STEPS AFTER THIS SCRIPT" runbook (step 2 and step 3
 * of `pairingInstructions()`), executed instead of typed. It does not move the
 * pairing INTO the genesis pipeline and does not touch a Tolk contract: D-46
 * point 3 says adding liquidity is the operator's own action against DeDust,
 * and it still is — this script is the operator, not the protocol. Nothing here
 * runs inside `runGenesis`, no contract builds a deposit, and skipping this
 * script leaves a deployment that is exactly as valid as before.
 *
 * ORDER, AND WHY EACH STEP IS WHERE IT IS:
 *
 *   1. `create_vault#21cfe02b` for PRIMES. MUST be after genesis: a new jetton
 *      vault fires TEP-89 `provide_wallet_address` at the jetton master in its
 *      own deploy transaction, so against an undeployed master it silently
 *      never becomes ready. `is_ready` is polled rather than assumed.
 *   2. Both halves of the deposit, FROM THE SAME WALLET. DeDust stages a
 *      two-sided deposit in an LP-account contract whose address is derived
 *      from the depositor, so two different senders make two half-filled
 *      deposits that never settle.
 *   3. Forward the LP receipt to the LP sink. It has to be forwarded rather
 *      than directed, because `deposit_liquidity` has NO recipient field in
 *      either half of its schema (GAUNTLET R13): the LP jetton can only ever go
 *      to the account that sent the deposit.
 *
 * ON AN EMPTY POOL THE DEPOSIT RATIO SETS THE PRICE, AND D-140 SETS IT AT THE
 * FLOOR. Both target balances are taken in full because there is no existing
 * ratio to trim against, so the ratio this script posts IS the opening price:
 * `PRIMES_LP_PRIMES` PRIMES against `PRIMES_LP_PRIMES × p_f` TON, which opens
 * the market at `p_f = T/S` exactly — `market_over_floor_at_open = 1.0`.
 *
 * It used to quote the pair at `L` (10,000 PRIMES/TON), because that is the rate
 * `donate_floor` MINTS at and the donated PRIMES then paired exactly. That was
 * the bug: `L` is D-39's denomination knob and was never a price, and once
 * D-100 point 2 cut the donation from 240 TON to 4.20 the two stopped
 * coinciding — the book opened **286x above the floor**. Read D-140 for the
 * arithmetic; the short version is that a pair quoted at L offers the whole TON
 * side to the first mint's rebate, because that rebate (1,168,800 PRIMES,
 * `docs/audit/genesis-emission-curve.md`) is 28x the pair's entire PRIMES side.
 *
 * WHAT THIS NOW BUYS YOU: a fillable `flush()` from the first mint. The floor
 * guard (§4.3.1) refuses to buy ABOVE `p_f`, and at a 286x open it refused
 * everything — FLOOR_GUARD = 0 bounced 1086 of 1089 attempts in the sim as it
 * then stood (422 of 1317 since D-143 sized the tranche to the venue). At a
 * 1.0x open the ratchet's `pending` is the market's bid instead of dead weight.
 * The REFUSAL path is still exercised (any buy pressure lifts spot above `p_f`
 * within one trade) and the `DedustPayout` handler still catches it.
 *
 *   npx tsx contracts/scripts/seedDedustLiquidity.ts
 *
 * THE FLOOR IS READ FROM THE LEDGER (G67), `getFloorNum/getFloorDen`. It used to be
 * `params.json`'s predicted genesis floor, which is only the live one when the donation
 * was the full genesis figure (200 TON, D-204); two 75-TON sets opened 1.886x above `p_f`. If the two disagree
 * the script refuses until `PRIMES_LP_FLOOR=live|params` says which.
 *
 * Env: PRIMES_LEDGER_ADDRESS, PRIMES_LP_FLOOR (only needed when the floors disagree),
 * PRIMES_LP_PRIMES (default: the ~1,972,333 PRIMES `donate_floor` mints (D-156-tapered), and
 * nothing else since D-166 deleted the operator's vest tranche — see
 * `genesisPairingPrimes`),
 * PRIMES_LP_SINK_ADDRESS, KEEPER_WALLET_MNEMONIC, PRIMES_DEPLOY_SUBWALLET_ID,
 * the toncenter key.
 */
import fs from 'fs';
import path from 'path';
import { Address, Cell, SendMode, TonClient, WalletContractV4, beginCell, fromNano, internal, toNano } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { toncenterRpcEndpoint } from '../../shared/contracts';
import { dryRunGenesisMasterAddress, genesisPairingPrimes } from './genesisPipeline';
import { resolvePresentation } from './deployGenesis';
import { hydrateProcessEnv, deploySubwalletId, envValue, loadEnvFile } from './envFile';
import { PrimesLpSink } from '../wrappers/PrimesLpSink';
import { minReservesForTranche } from '../../shared/dedustQuote';
import {
    CREATE_VAULT_VALUE,
    DEDUST_FACTORY,
    DEDUST_NATIVE_VAULT_MAINNET,
    DEDUST_NATIVE_VAULT_TESTNET,
    DEPOSIT_JETTON_FORWARD,
    DEPOSIT_JETTON_VALUE,
    DEPOSIT_NATIVE_GAS,
    createVaultBody,
    depositJettonForwardPayload,
    depositNativeBody,
    getPoolAddress,
    getVaultAddress,
    jettonAsset,
    jettonTransferBody,
    jettonVaultIsReady,
    openingFloorNanotonPerPrimes,
    type DedustAsset,
} from './dedust';

// `tsx` loads no `.env`; every `process.env.PRIMES_*` read below depends on this.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
const BUILD = path.resolve(__dirname, '..', 'build');

function loadCode(name: string): Cell {
    const j = JSON.parse(fs.readFileSync(path.join(BUILD, `${name}.compiled.json`), 'utf8'));
    return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Toncenter answers 429 under any sustained poll, and this script polls hard: two
 * `is_ready` loops and several balance reads per leg. A previous run died on a 429 AFTER
 * both deposit legs were already sent — the pool was half-seeded and the LP receipt
 * unforwarded, which is the exact state `genesisPrep.ts`'s funding floor exists to avoid.
 *
 * Deliberately a plain wrapper at the call sites rather than a Proxy over the client: a
 * Proxy has to wrap EVERY method, and `client.open()` is synchronous — wrapping it in an
 * async function hands back a Promise instead of an opened contract, which is exactly how
 * the first attempt at this broke with `wc.getSeqno is not a function`. Explicit is
 * cheaper than clever here; there are only six call sites.
 *
 * Re-throws anything that is not a rate limit — a 429 is the only error worth sitting out.
 */
async function retry429<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const is429 = (e: unknown) => {
        const m = String((e as { message?: string })?.message ?? e);
        return m.includes('429') || /too many requests/i.test(m);
    };
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (!is429(e) || attempt >= 6) throw e;
            const wait = Math.min(1000 * 2 ** attempt, 20000);
            console.log(`  ... toncenter 429 on ${label}, retrying in ${wait / 1000}s`);
            await sleep(wait);
        }
    }
}

/** TEP-89: ask a jetton master (or a DeDust pool, which IS one) for an owner's wallet. */
async function walletOf(client: TonClient, master: Address, owner: Address): Promise<Address> {
    const res = await retry429('get_wallet_address', () =>
        client.runMethod(master, 'get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ])
    );
    return res.stack.readAddress();
}

async function jettonBalance(client: TonClient, wallet: Address): Promise<bigint> {
    if (!(await retry429('isContractDeployed', () => client.isContractDeployed(wallet)))) return 0n;
    const res = await retry429('get_wallet_data', () => client.runMethod(wallet, 'get_wallet_data', []));
    return res.stack.readBigNumber();
}

/** Poll `read` until it reports something truthy, or give up. A read that THROWS is not
 *  fatal here — `retryOn429` has already sat out the rate limits, so anything reaching
 *  this point is a transient upstream blip, and "not ready yet" is the honest reading of
 *  it. The last error is carried so the timeout says why rather than just that. */
async function waitFor<T>(label: string, read: () => Promise<T>, ok: (v: T) => boolean, tries = 40): Promise<T> {
    let last: T | undefined;
    let lastErr: unknown;
    const attempt = async () => {
        try {
            last = await read();
            lastErr = undefined;
        } catch (e) {
            lastErr = e;
        }
    };
    await attempt();
    for (let i = 0; i < tries; i++) {
        if (lastErr === undefined && ok(last as T)) return last as T;
        await sleep(3000);
        if (i % 5 === 4) console.log(`  ... still waiting for ${label} (${(i + 1) * 3}s)`);
        await attempt();
    }
    throw new Error(
        `timed out waiting for ${label}` + (lastErr ? ` (last read failed: ${String(lastErr).slice(0, 160)})` : '')
    );
}

/**
 * GAUNTLET.md G38 — WHAT THIS PAIR CAN AND CANNOT SERVE, printed before anything is sent.
 *
 * `flush()` buys a market that is BELOW the floor (§4.3.1) and sizes its tranche from the
 * venue since D-143. This script decides the venue. Nothing connected the two, so the
 * operator posted a pair with no way to know whether a flush would ever fill against it —
 * and on testnet it did not: a 19.733 TON tranche met a pool holding 479,142 PRIMES in
 * total and was refused, correctly, for two months.
 *
 * REPORTING, NOT SIZING. The pair itself is unchanged, D-140's ratio is unchanged, and no
 * figure printed here feeds a decision this script makes — changing the depth means minting
 * more PRIMES for the pair or committing more operator TON, which is an owner input the sim
 * did not produce (CLAUDE.md rule 3) and is parked as a `DECISIONS.md` brief.
 *
 * THE FIRST LINE IS THE ONE THAT MATTERS. At `market_over_floor_at_open = 1.0` the answer
 * is NO DEPTH, at any size: the pool takes its fee off the input, so a buy starting at `p_f`
 * executes above `p_f` before the curve is consulted. That is not a shortfall to seed away,
 * it is the guard's own definition, and the rows below it are what the pool would need once
 * the market has actually fallen.
 */
function reportFlushDepth(lpTon: bigint, lpPrimes: bigint, nanotonPerPrimes: bigint) {
    // `T`/`S` as the ratchet's `getFloorCache` will hold them at genesis: any pair whose
    // ratio is `p_f` states the same floor, so the opening pair itself is the cleanest
    // expression of it and needs no second source.
    const tCache = lpTon;
    const sCache = lpPrimes;
    // DeDust's published trade fee. Read from `get_trade_fee` everywhere it matters at
    // runtime; here the pool may not exist yet, so the venue's own testnet figure is used
    // and named as an assumption rather than passed off as a reading.
    const FEE_NUM = 40n;
    const FEE_DEN = 10_000n;
    // `FLUSH_MIN` (primes_ratchet.tolk) — the smallest tranche the auto path will ever send,
    // so the smallest depth question worth asking. Not a new parameter: it is the contract's.
    const FLUSH_MIN = 5_000_000_000n;

    const atFloor = minReservesForTranche(FLUSH_MIN, 10_000n, tCache, sCache, FEE_NUM, FEE_DEN);
    console.log(
        `flush at the floor:  ${atFloor === null ? 'NEVER FILLS — at any depth. The pool takes its fee off the input, so a buy starting at p_f executes above p_f.' : 'fills'}`
    );
    for (const bps of [9_000n, 7_500n, 5_000n, 2_500n]) {
        const need = minReservesForTranche(FLUSH_MIN, bps, tCache, sCache, FEE_NUM, FEE_DEN);
        if (need === null) continue;
        const short = need.reservePrimesNano > lpPrimes ? `  (${Number(need.reservePrimesNano) / Number(lpPrimes) < 1000 ? (Number(need.reservePrimesNano) / Number(lpPrimes)).toFixed(1) : '>1000'}x this pair)` : '  (this pair already serves it)';
        console.log(
            `  at ${(Number(bps) / 100).toFixed(0)}% of p_f:    ` +
                `${fromNano(need.reserveTonNanoton)} TON + ${need.reservePrimesNano / 1000000000n} PRIMES` +
                short
        );
    }
    void nanotonPerPrimes;
}

async function main() {
    const env = loadEnvFile();
    const testOnly = (envValue(env, 'PRIMES_NETWORK') ?? 'testnet') !== 'mainnet';
    const client = new TonClient({
        // GAUNTLET X4: the shared helper, so `TON_RPC_ENDPOINT` moves this with everything else.
        endpoint: toncenterRpcEndpoint(testOnly ? 'testnet' : 'mainnet'),
        apiKey: envValue(env, testOnly ? 'TONCENTER_API_KEY_TESTNET' : 'TONCENTER_API_KEY') || undefined,
    });
    const fmt = (a: Address) => a.toString({ testOnly });

    const mnemonic = envValue(env, 'KEEPER_WALLET_MNEMONIC');
    if (!mnemonic) throw new Error('KEEPER_WALLET_MNEMONIC not found in /.env');
    const keyPair = await mnemonicToPrivateKey(mnemonic.split(/\s+/));
    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
        walletId: deploySubwalletId(env),
    });
    const me = wallet.address;
    const wc = client.open(wallet);
    const send = async (messages: Parameters<typeof wc.sendTransfer>[0]['messages']) => {
        const seqno = await retry429('getSeqno', () => wc.getSeqno());
        await retry429('sendTransfer', () =>
            wc.sendTransfer({
                seqno,
                secretKey: keyPair.secretKey,
                timeout: Math.floor(Date.now() / 1000) + 600, // clock-skew workaround
                sendMode: SendMode.PAY_GAS_SEPARATELY,
                messages,
            })
        );
    };

    const genesis = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'params.json'), 'utf8')).genesis;
    // D-140 — THE PRIMES SIDE IS THE KNOB AND THE TON SIDE FALLS OUT OF THE FLOOR.
    // That direction is the decision: at `p_f` every PRIMES posted buys only
    // `p_f` TON of depth, so the pair is sized by the PRIMES the operator can
    // actually reach at block one, not by how much TON they feel like risking.
    const lpPrimesStr = envValue(env, 'PRIMES_LP_PRIMES') ?? String(genesisPairingPrimes(genesis));
    const lpPrimes = toNano(lpPrimesStr); // whole PRIMES → nanoPRIMES, same 1e9
    // `p_f` in nanoTON per whole PRIMES. Rounded DOWN, because the chain's
    // granularity has to land on one side and below the floor is the safe one:
    // a book a nanoTON under `p_f` is a book `flush()` fills, and a book a
    // nanoTON over is one it refuses.
    // G67: the LIVE floor, not the one params.json predicts — the two differ whenever the
    // donation was not D-154's figure, and the params one then opens the book above `p_f`.
    const ledgerAddr = envValue(env, 'PRIMES_LEDGER_ADDRESS');
    if (!ledgerAddr) throw new Error('PRIMES_LEDGER_ADDRESS unset — the opening price is read from the ledger.');
    const ledger = Address.parse(ledgerAddr);
    const readFloor = async (m: string) =>
        (await retry429(m, () => client.runMethod(ledger, m))).stack.readBigNumber();
    const { nanotonPerPrimes, source } = openingFloorNanotonPerPrimes(
        { t: await readFloor('getFloorNum'), s: await readFloor('getFloorDen') },
        BigInt(Math.floor(genesis.genesis_floor_price_ton_per_primes * 1e9)),
        envValue(env, 'PRIMES_LP_FLOOR')
    );
    const lpTon = (lpPrimes * nanotonPerPrimes) / 1000000000n;
    const lpTonStr = fromNano(lpTon);
    if (lpTon === 0n) {
        throw new Error(
            `${lpPrimesStr} PRIMES at ${nanotonPerPrimes} nanoTON/PRIMES (${source} floor) ` +
                'rounds to a zero TON side — DeDust would reject the deposit. ' +
                'Raise PRIMES_LP_PRIMES.'
        );
    }

    const master = dryRunGenesisMasterAddress(
        me,
        loadCode('PrimesJettonMaster'),
        loadCode('PrimesJettonWallet'),
        resolvePresentation().jettonMetadataUri
    );
    if (!(await retry429('isContractDeployed', () => client.isContractDeployed(master)))) {
        throw new Error(
            `PRIMES jetton master ${fmt(master)} is not deployed — run genesis first. ` +
                '(If you expected it to be, PRIMES_DEPLOY_SUBWALLET_ID has changed since the run.)'
        );
    }

    const native: DedustAsset = { kind: 'native' };
    const primes = jettonAsset(master);
    const assets: [DedustAsset, DedustAsset] = [native, primes];
    // Canonical order is [native, jetton] — native$0000 sorts before
    // jetton$0001, and both halves of the deposit must agree byte-for-byte.
    const targetBalances: [bigint, bigint] = [lpTon, lpPrimes];

    const nativeVault = testOnly ? DEDUST_NATIVE_VAULT_TESTNET : DEDUST_NATIVE_VAULT_MAINNET;
    const pool = await retry429('getPoolAddress', () => getPoolAddress(client, native, primes));
    const jettonVault = await retry429('getVaultAddress', () => getVaultAddress(client, primes));
    const myPrimesWallet = await retry429('walletOf', () => walletOf(client, master, me));

    console.log(`network:             ${testOnly ? 'testnet' : 'MAINNET'}`);
    console.log(`from:                ${fmt(me)}`);
    console.log(`PRIMES master:       ${fmt(master)}`);
    console.log(`pool:                ${fmt(pool)}`);
    console.log(`native TON vault:    ${fmt(nativeVault)}`);
    console.log(`PRIMES jetton vault: ${fmt(jettonVault)}`);
    console.log(`pairing:             ${lpTonStr} TON + ${lpPrimes / 1000000000n} PRIMES (at the ${source} floor)`);
    reportFlushDepth(lpTon, lpPrimes, nanotonPerPrimes);

    if (!(await retry429('isContractDeployed', () => client.isContractDeployed(pool)))) {
        throw new Error(`pool ${fmt(pool)} is not deployed — run createDedustPool.ts first (before genesis).`);
    }
    const primesHeld = await jettonBalance(client, myPrimesWallet);
    if (primesHeld < lpPrimes) {
        throw new Error(
            `wallet holds ${primesHeld / 1000000000n} PRIMES, needs ${lpPrimes / 1000000000n}. ` +
                'donateFloor.ts mints the default pairing inventory and must have landed first ' +
                '(~1,972,333 PRIMES: X·L at T = 0, less D-156\'s supply taper; ' +
                'D-166: there is no operator vest tranche to add). Or lower PRIMES_LP_PRIMES — the TON side ' +
                'follows it down at the floor rate, so a smaller pair is still priced at p_f.'
        );
    }

    // ---- 1. the PRIMES jetton vault -------------------------------------
    if (!(await retry429('isContractDeployed', () => client.isContractDeployed(jettonVault)))) {
        console.log(`\ncreating the PRIMES jetton vault (${Number(CREATE_VAULT_VALUE) / 1e9} TON) ...`);
        await send([
            internal({ to: DEDUST_FACTORY, value: CREATE_VAULT_VALUE, bounce: true, body: createVaultBody(primes) }),
        ]);
    }
    // `is_ready` is false until TEP-89 has round-tripped to the master; the
    // deposit would be accepted and stranded before then.
    await waitFor(
        'the jetton vault to become ready',
        async () => ((await retry429('isContractDeployed', () => client.isContractDeployed(jettonVault))) ? jettonVaultIsReady(client, jettonVault) : false),
        (v) => v === true
    );
    console.log('jetton vault ready.');

    // ---- 2. both halves of the deposit ----------------------------------
    // Sent as ONE wallet transfer with two messages so they cannot interleave
    // with anything else, and so both originate from this address — the LP
    // account DeDust stages them in is derived from the depositor.
    const myLpWallet = await walletOf(client, pool, me);
    const lpBefore = await jettonBalance(client, myLpWallet);
    console.log('\ndepositing both legs ...');
    await send([
        internal({
            to: nativeVault,
            value: lpTon + DEPOSIT_NATIVE_GAS,
            bounce: true,
            body: depositNativeBody({ amount: lpTon, assets, targetBalances }),
        }),
        internal({
            to: myPrimesWallet,
            value: DEPOSIT_JETTON_VALUE,
            bounce: true,
            body: jettonTransferBody({
                amount: lpPrimes,
                destination: jettonVault,
                responseAddress: me,
                forwardTon: DEPOSIT_JETTON_FORWARD,
                forwardPayload: depositJettonForwardPayload({ assets, targetBalances }),
            }),
        }),
    ]);

    const lpAfter = await waitFor(
        'the LP receipt to arrive',
        () => jettonBalance(client, myLpWallet),
        (v) => v > lpBefore
    );
    const lpMinted = lpAfter - lpBefore;
    console.log(`LP minted: ${lpMinted} units, in ${fmt(myLpWallet)}`);

    // ---- 3. lock the receipt in the LP sink ------------------------------
    const sinkAddr = envValue(env, 'PRIMES_LP_SINK_ADDRESS');
    if (!sinkAddr) {
        console.log('\nPRIMES_LP_SINK_ADDRESS unset — LP left in the deploy wallet, nothing locked.');
        return;
    }
    const sink = client.open(PrimesLpSink.createFromAddress(Address.parse(sinkAddr)));
    const cfg = await sink.getLpSinkConfig();
    if (cfg.walletSet !== 1) {
        throw new Error(`LP sink ${sinkAddr} has walletSet=0 — genesis step 25b did not land; it would refuse (1170).`);
    }
    // The sink refuses any notification that did not come from ITS OWN LP wallet
    // (error 1171), which is what makes `getLocked()` equal that wallet's
    // balance rather than a number anyone can inflate. So this must be the same
    // pool's LP jetton, and the address the sink was bootstrapped with must be
    // the one the pool derives now.
    const sinkLpWallet = await walletOf(client, pool, sink.address);
    if (!sinkLpWallet.equals(cfg.lpJettonWalletAddr)) {
        throw new Error(
            `the pool derives ${fmt(sinkLpWallet)} as the sink's LP wallet but the sink was bootstrapped with ` +
                `${fmt(cfg.lpJettonWalletAddr)} — genesis ran against a DIFFERENT pool. The sink's bootstrap is ` +
                'one-shot (D-100 point 4), so this deployment cannot lock LP from this pool; redeploy genesis.'
        );
    }

    const lockedBefore = await sink.getLocked();
    console.log(`\nforwarding the LP receipt to the sink ${fmt(sink.address)} ...`);
    await send([
        internal({
            to: myLpWallet,
            value: toNano('0.15'),
            bounce: true,
            body: jettonTransferBody({
                amount: lpMinted,
                destination: sink.address,
                responseAddress: me,
                // MUST be > 0: the sink acts on `transfer_notification`, and a
                // zero forward amount means no notification is ever sent, so the
                // LP would land in the sink's wallet uncounted by `getLocked()`.
                forwardTon: toNano('0.05'),
            }),
        }),
    ]);

    const lockedAfter = await waitFor(
        "the sink's locked depth to rise",
        () => sink.getLocked(),
        (v) => v > lockedBefore
    );
    // §3.4's one-get-call check, done as a COMPARISON and not a claim: the
    // tally and the wallet balance are read independently and must agree.
    const sinkWalletBalance = await jettonBalance(client, sinkLpWallet);
    console.log(`sink getLocked()   : ${lockedAfter}`);
    console.log(`sink LP wallet     : ${sinkWalletBalance}`);
    if (lockedAfter !== sinkWalletBalance) {
        throw new Error('getLocked() and the sink LP wallet balance disagree — do not trust either until they do.');
    }
    console.log('\nok  locked depth equals the sink LP wallet balance. Pool seeded, receipt locked forever.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
