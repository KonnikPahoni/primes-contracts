/**
 * TON PRIMES — genesis address dry run (GAUNTLET.md R17).
 *
 * A DeDust v2 pool for the PRIMES/TON pair needs the PRIMES jetton master's address to be
 * created, but the master is not deployed until step 3 of `deployAndWire`/`runGenesis` —
 * and that same run needs the pool's address at step 25b (`lpSink.set_wallet`,
 * `treasury.set_wallets`, D-100 point 4). Circular on any network where the pool cannot be
 * a testnet stand-in (`PRIMES_DEDUST_LP_STANDIN`), i.e. mainnet.
 *
 * This script breaks the cycle: it derives the SAME deploy subwallet a real genesis run
 * would use (mnemonic + optional `PRIMES_DEPLOY_SUBWALLET_ID`, exactly as
 * `deployGenesis.ts --skew-safe` does) and the SAME jetton-master init data
 * (`genesisPipeline.ts`'s `jettonMasterConfig`, the one `deployAndWire` itself calls), and
 * prints the resulting address. **It sends nothing and needs no live network or funded
 * wallet** — a contract's address is a pure function of its code and init data, and every
 * field the master's init data needs (the subwallet address, the compiled jetton codes,
 * the presentation URI) is known before genesis runs.
 *
 * Usage:
 *   1. `npx blueprint build --all` (so build/*.compiled.json exist)
 *   2. `npx tsx scripts/dryRunGenesisAddresses.ts`
 *   3. Create the DeDust PRIMES/TON pool for the printed master address through the
 *      DeDust factory.
 *   4. Only then run genesis for real (`deployGenesis.ts`, blueprint or `--skew-safe`),
 *      pointing `PRIMES_DEDUST_POOL_ADDR` at the pool just created.
 *
 * Reads the SAME env contract as `deployGenesis.ts --skew-safe` (`/.env`'s
 * `KEEPER_WALLET_MNEMONIC`, `PRIMES_DEPLOY_SUBWALLET_ID`, `PRIMES_JETTON_METADATA_URI`) so
 * the address it prints is the one the real run will actually produce, not a
 * hand-recomputed guess that can drift from it.
 */
import fs from 'fs';
import path from 'path';
import { Cell, WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { dryRunGenesisMasterAddress } from './genesisPipeline';
import { hydrateProcessEnv, deploySubwalletId, loadEnvFile } from './envFile';
import { resolvePresentation } from './deployGenesis';

// `tsx` loads no `.env`; every `process.env.PRIMES_*` read below depends on this.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
const BUILD = path.resolve(__dirname, '..', 'build');

// Same loader as scriptHost.ts — kept local rather than shared to avoid
// coupling two independent deploy scripts to a third module for four lines of fs code.
function loadCode(name: string): Cell {
    const j = JSON.parse(fs.readFileSync(path.join(BUILD, `${name}.compiled.json`), 'utf8'));
    return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
}

async function main() {
    const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    const mLine = envFile.match(/^KEEPER_WALLET_MNEMONIC=(.*)$/m);
    if (!mLine) throw new Error('KEEPER_WALLET_MNEMONIC not found in /.env');
    const mnemonic = mLine[1].trim().replace(/^"|"$/g, '').split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(mnemonic);

    // Same subwallet derivation as scriptHost.ts's `skewSafeHost()` — a fresh
    // PRIMES_DEPLOY_SUBWALLET_ID for a redeploy moves every genesis address at once,
    // this one included, so the dry run must read the same env var or it prints a
    // stale address from a subwallet nothing will deploy from.
    // Shared with deployGenesis.ts --skew-safe and genesisPrep.ts. Reading only
    // `process.env` here printed a master address derived from the DEFAULT
    // subwallet whenever the id lived in `.env` (where it is documented to
    // live) and was not also exported — and a DeDust pool created against that
    // address is keyed on a jetton master no genesis run will ever deploy.
    // Unrecoverable, because step 25b bakes the pool's answer into one-shot
    // bootstraps (D-100 point 4). See scripts/envFile.ts.
    const walletId = deploySubwalletId(loadEnvFile());
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });
    const genesisAddress = wallet.address;

    const presentation = resolvePresentation();
    const jettonMasterCode = loadCode('PrimesJettonMaster');
    const jettonWalletCode = loadCode('PrimesJettonWallet');

    const masterAddress = dryRunGenesisMasterAddress(
        genesisAddress,
        jettonMasterCode,
        jettonWalletCode,
        presentation.jettonMetadataUri
    );

    console.log(`deploy subwallet (genesisAddress): ${genesisAddress.toString({ testOnly: true })}`);
    console.log(`  walletId: ${walletId ?? '<default>'}`);
    console.log(`PRIMES jetton master (undeployed):`);
    console.log(`  mainnet: ${masterAddress.toString({ testOnly: false })}`);
    console.log(`  testnet: ${masterAddress.toString({ testOnly: true })}`);
    console.log('');
    console.log(
        'Create the DeDust PRIMES/TON pool against the address above BEFORE running genesis ' +
            '(scripts/createDedustPool.ts).'
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
