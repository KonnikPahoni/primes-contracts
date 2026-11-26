/**
 * TON PRIMES — create the PRIMES/GRAM DeDust v2 pool. RUN THIS BEFORE GENESIS.
 *
 * WHY BEFORE. Genesis step 25b (`lpSink.set_wallet`, `treasury.set_wallets`,
 * D-100 point 4) calls `get_wallet_address` ON THE POOL — a DeDust pool IS the
 * LP jetton master — and bakes the answer into one-shot bootstraps that cannot
 * be repaired. So the pool has to exist first.
 *
 * WHY THAT IS POSSIBLE AT ALL. It looks circular: the pool is keyed on the
 * PRIMES jetton master, and the master is deployed BY genesis. It is not
 * circular, because a DeDust `Asset` for a jetton is a 44-bit IDENTIFIER (tag +
 * workchain + the master's hash), not a pointer the factory dereferences.
 * Verified on a mainnet trace: `create_volatile_pool` sends exactly one message,
 * the pool's own deploy, and touches no jetton master. So the master's address
 * — a pure function of its code and init data — is enough, and
 * `dryRunGenesisAddresses.ts` computes it offline.
 *
 * (The JETTON VAULT is the opposite case and is deliberately NOT created here:
 * a new jetton vault fires TEP-89 `provide_wallet_address` at the master in its
 * own deploy transaction, so against an undeployed master it silently never
 * becomes ready. `seedDedustLiquidity.ts` creates it AFTER genesis.)
 *
 * Idempotent: if the pool is already deployed it verifies and prints, sending
 * nothing. Safe to re-run.
 *
 *   npx tsx contracts/scripts/createDedustPool.ts
 *
 * Reads `/.env` for DEPLOYER_MNEMONIC, PRIMES_DEPLOY_SUBWALLET_ID (through
 * the SHARED accessor in envFile.ts, so it cannot disagree with what
 * deployGenesis.ts --skew-safe will actually deploy from) and the toncenter key.
 */
import fs from 'fs';
import path from 'path';
import { Address, Cell, SendMode, TonClient, WalletContractV4, beginCell, internal, toNano } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { dryRunGenesisMasterAddress } from './genesisPipeline';
import { resolvePresentation } from './deployGenesis';
import { assertBuildFresh, hydrateProcessEnv, deploySubwalletId, envValue, loadEnvFile, readNetworkConfig, scriptNetwork } from './envFile';
import {
    CREATE_POOL_VALUE,
    DEDUST_FACTORY,
    createVolatilePoolBody,
    getPoolAddress,
    getVaultAddress,
    jettonAsset,
    type DedustAsset,
} from './dedust';

// `tsx` loads no `.env`; every `process.env.PRIMES_*` read below depends on this.
hydrateProcessEnv();

const BUILD = path.resolve(__dirname, '..', 'build');

function loadCode(name: string): Cell {
    const j = JSON.parse(fs.readFileSync(path.join(BUILD, `${name}.compiled.json`), 'utf8'));
    return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `addr` is deployed, or give up. Returns whether it landed. */
async function waitDeployed(client: TonClient, addr: Address, label: string, tries = 30): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
        await sleep(3000);
        if (await client.isContractDeployed(addr)) return true;
        if (i % 5 === 4) console.log(`  ... still waiting for ${label} (${(i + 1) * 3}s)`);
    }
    return false;
}

async function main() {
    assertBuildFresh();
    const env = loadEnvFile();
    // GAUNTLET X4 + G96: `TON_RPC_ENDPOINT` switches this script's provider with every
    // service's, and the network is the one the genesis is given (`scriptNetwork`).
    const { testOnly, endpoint, apiKey } = scriptNetwork(env);
    const client = new TonClient({ endpoint, apiKey });

    const mnemonic = envValue(env, 'DEPLOYER_MNEMONIC');
    if (!mnemonic) throw new Error('DEPLOYER_MNEMONIC not found in /.env');
    const keyPair = await mnemonicToPrivateKey(mnemonic.split(/\s+/));
    const walletId = deploySubwalletId(env);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });

    // The SAME derivation genesis itself will use — same subwallet, same jetton
    // codes, same presentation URI — so the pool cannot end up keyed on a master
    // no run will deploy. That failure is unrecoverable (see envFile.ts).
    const presentation = resolvePresentation(readNetworkConfig(testOnly ? 'testnet' : 'mainnet'));
    const master = dryRunGenesisMasterAddress(
        wallet.address,
        loadCode('PrimesJettonMaster'),
        loadCode('PrimesJettonWallet'),
        presentation.jettonMetadataUri
    );

    const native: DedustAsset = { kind: 'native' };
    const primes = jettonAsset(master);
    const pool = await getPoolAddress(client, native, primes);
    const jettonVault = await getVaultAddress(client, primes);

    const fmt = (a: Address) => a.toString({ testOnly });
    console.log(`network:              ${testOnly ? 'testnet' : 'MAINNET'}`);
    console.log(`deploy subwallet:     ${fmt(wallet.address)}  (id ${walletId ?? '<default>'})`);
    console.log(`PRIMES jetton master: ${fmt(master)}  (undeployed until genesis)`);
    console.log(`DeDust factory:       ${fmt(DEDUST_FACTORY)}`);
    console.log(`PRIMES/GRAM pool:      ${fmt(pool)}`);
    console.log(`PRIMES jetton vault:  ${fmt(jettonVault)}  (created later, by seedDedustLiquidity.ts)`);

    if (await client.isContractDeployed(pool)) {
        console.log('\npool already deployed — nothing sent.');
    } else {
        const balance = Number(await client.getBalance(wallet.address)) / 1e9;
        if (balance < 0.5) {
            throw new Error(
                `deploy subwallet holds ${balance} GRAM; creating the pool costs ` +
                    `${Number(CREATE_POOL_VALUE) / 1e9} GRAM. Fund ${fmt(wallet.address)} first.`
            );
        }
        console.log(`\nsending create_volatile_pool#97d51f2f (${Number(CREATE_POOL_VALUE) / 1e9} GRAM) ...`);
        const wc = client.open(wallet);
        await wc.sendTransfer({
            seqno: await wc.getSeqno(),
            secretKey: keyPair.secretKey,
            // Clock-skew workaround, same as every other live script here.
            timeout: Math.floor(Date.now() / 1000) + 600,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [
                internal({
                    to: DEDUST_FACTORY,
                    value: CREATE_POOL_VALUE,
                    bounce: true,
                    body: createVolatilePoolBody(native, primes),
                }),
            ],
        });
        if (!(await waitDeployed(client, pool, 'the pool'))) {
            throw new Error(`pool ${fmt(pool)} did not deploy within 90s — check the factory transaction.`);
        }
        console.log('pool deployed.');
    }

    // THE GATE. This is the exact call genesis step 25b makes, so if it does not
    // answer here it will not answer there either — and there it would bake a
    // wrong address into bootstraps that cannot be redone. An EMPTY pool (no
    // reserves yet) still answers: it is the LP jetton master from the moment it
    // is deployed, and holding no liquidity is not the same as not existing.
    const probe = await client.runMethod(pool, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(wallet.address).endCell() },
    ]);
    console.log(`\nok  pool answers get_wallet_address -> ${fmt(probe.stack.readAddress())}`);

    console.log('\n--- paste into /.env, then run genesisPrep.ts ---');
    // DeDust's native vault is a per-network constant (shared/networks/<network>.yaml), so
    // only this run's pool and jetton vault are printed.
    console.log('PRIMES_DEDUST_LP_STANDIN=0');
    console.log(`PRIMES_DEDUST_POOL_ADDR=${fmt(pool)}`);
    console.log(`PRIMES_DEDUST_JETTON_VAULT_ADDR=${fmt(jettonVault)}`);
    console.log(
        '\nNext: genesisPrep.ts -> deployGenesis.ts --skew-safe -> seedDedustLiquidity.ts. ' +
            'Do NOT change PRIMES_DEPLOY_SUBWALLET_ID after this point — it would move the ' +
            'jetton master and orphan the pool just created.'
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
