/**
 * TON PRIMES — the one reader for `/.env`, shared by every deploy-side script.
 *
 * WHY THIS EXISTS. Three scripts in this directory used to read the same two
 * settings two different ways, and the disagreement was silent and expensive:
 *
 *   - `genesisPrep.ts` parsed the `.env` FILE for everything, including
 *     `PRIMES_DEPLOY_SUBWALLET_ID`.
 *   - `deployGenesis.ts --skew-safe` and `dryRunGenesisAddresses.ts` parsed the
 *     file for `DEPLOYER_MNEMONIC` but read `PRIMES_DEPLOY_SUBWALLET_ID`
 *     from `process.env`.
 *
 * `.env` is where that variable is documented to live and `tsx` does not load
 * `.env` into `process.env`, so with the id set only in the file — the normal
 * case — the preflight reported and funded one subwallet and the runner
 * deployed from a different one. Every genesis address derives from that
 * wallet, so the two disagreeing is not a cosmetic drift: `genesisPrep.ts`
 * would green-light a wallet holding 15 GRAM while `deployGenesis.ts --skew-safe`
 * deployed from an empty default-id wallet, and the DeDust pool precomputed by
 * `dryRunGenesisAddresses.ts` would be keyed on a jetton master no run would
 * ever deploy. That last one is unrecoverable: the pool address lands in the
 * LP sink's and the treasury's ONE-SHOT bootstraps at step 25b (D-100 point 4).
 *
 * `process.env` still WINS where it is set, so an explicit
 * `PRIMES_DEPLOY_SUBWALLET_ID=... npx tsx ...` override keeps working exactly
 * as before; the file is the fallback, not the override.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import params from '../../shared/params.json';
import { toncenterRpcEndpoint } from '../../shared/contracts';
import {
    type Network,
    type NetworkConfig,
    configNetworkFor,
    parseNetworkConfig,
    retiredEnvVarsSet,
    stakeMinOf,
} from '../../shared/networkConfig';

export { clockDivisorOf, MAINNET_AUCTION_SECONDS, type NetworkConfig } from '../../shared/networkConfig';

const REPO = path.resolve(__dirname, '..', '..');

/**
 * Parse `/.env` into a Map.
 *
 * Split on /\r?\n/, not '\n': a CRLF `.env` (this repo is worked on from
 * Windows too) leaves a trailing \r, which JS counts as a line terminator — so
 * `.` cannot match it and a `(.*)$` capture matches NOTHING, parsing zero keys
 * and failing silently.
 */
export function parseEnvFile(text: string): Map<string, string> {
    const env = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) env.set(m[1], m[2].replace(/^"|"$/g, '').trim());
    }
    return env;
}

/**
 * Read and parse `/.env`. A missing file reads as empty (a fresh clone, or the test suite
 * importing a script module); a script that needs a value fails at the read that needs it.
 */
export function loadEnvFile(): Map<string, string> {
    const file = path.join(REPO, '.env');
    if (!fs.existsSync(file)) return new Map();
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
}

/**
 * `process.env` first, then `/.env`. This is the accessor every deploy script
 * should use for a setting that can legitimately come from either.
 */
export function envValue(env: Map<string, string>, key: string): string | undefined {
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
    return env.get(key);
}

/**
 * The deploy subwallet id, resolved the same way everywhere. `undefined` means
 * "wallet v4 default", which is what `WalletContractV4.create` expects.
 */
export function deploySubwalletId(env: Map<string, string>): number | undefined {
    const raw = envValue(env, 'PRIMES_DEPLOY_SUBWALLET_ID');
    return raw ? Number(raw) : undefined;
}

/**
 * The network's deploy facts, `shared/networks/<network>.yaml` (see `shared/networkConfig.ts`).
 *
 * `network` is the network THIS RUN TARGETS — blueprint's `provider.network()` or the
 * skew-safe host's — never `TON_NETWORK`, which is the laptop `.env`'s backend selector and
 * reads `testnet` during a `--mainnet` run. Anything that is not `testnet` gets mainnet's
 * file and mainnet's rules.
 *
 * Refuses while any variable the YAML files replaced is still set, in the shell or in
 * `/.env`: a stale `PRIMES_NAME_FEE_TON=0.5` must not sit beside the file looking like
 * the thing that decides.
 */
export function readNetworkConfig(network: string): NetworkConfig {
    const env = loadEnvFile();
    const stale = retiredEnvVarsSet((k) => envValue(env, k));
    if (stale.length) {
        throw new Error(
            `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} set, but these values now live in ` +
                'shared/networks/{testnet,mainnet}.yaml. Delete them from /.env (and the shell), then re-run.'
        );
    }
    const net = configNetworkFor(network);
    return parseNetworkConfig(fs.readFileSync(path.join(REPO, 'shared', 'networks', `${net}.yaml`), 'utf8'), net);
}

export interface ScriptNetwork {
    network: Network;
    /** `Address.toString({ testOnly })` for every address this run prints. */
    testOnly: boolean;
    endpoint: string;
    apiKey?: string;
}

/**
 * The network a deploy-side tsx script targets (GAUNTLET.md G96). It is the value the deploy
 * itself was given, never a literal in the script: `--mainnet` / `--testnet` on the command
 * line, the same flag blueprint's `deployGenesis` takes, else `PRIMES_NETWORK` from the shell
 * or `/.env` — the one `createDedustPool.ts` reads before genesis and every later step reads
 * after it. Default testnet. Never `TON_NETWORK`: that is the backend's selector (see
 * `readNetworkConfig` above).
 *
 * Refuses a flag that contradicts `PRIMES_NETWORK`, and an endpoint that is not the network's:
 * `TON_RPC_ENDPOINT` overrides `toncenterRpcEndpoint` whatever network it is asked for, so a
 * testnet run with a mainnet override would otherwise send real GRAM.
 */
export function scriptNetwork(env = loadEnvFile(), argv: readonly string[] = process.argv): ScriptNetwork {
    const flagged = (['testnet', 'mainnet'] as const).filter((n) => argv.includes(`--${n}`));
    if (flagged.length > 1) throw new Error('pass one of --testnet / --mainnet, not both');
    const declared = envValue(env, 'PRIMES_NETWORK')?.trim().toLowerCase() || undefined;
    if (declared !== undefined && declared !== 'testnet' && declared !== 'mainnet') {
        throw new Error(`PRIMES_NETWORK must be testnet or mainnet, got "${declared}"`);
    }
    if (flagged[0] && declared && flagged[0] !== declared) {
        throw new Error(`--${flagged[0]} contradicts PRIMES_NETWORK=${declared}`);
    }
    const network: Network = flagged[0] ?? declared ?? 'testnet';
    const testOnly = network === 'testnet';
    const endpoint = toncenterRpcEndpoint(network);
    if (/testnet/i.test(endpoint) !== testOnly) {
        throw new Error(`RPC endpoint ${endpoint} is not a ${network} endpoint (check TON_RPC_ENDPOINT)`);
    }
    const apiKey = (envValue(env, testOnly ? 'TONCENTER_API_KEY_TESTNET' : 'TONCENTER_API_KEY') ?? '').trim();
    return { network, testOnly, endpoint, apiKey: apiKey || undefined };
}

/** D-153's stake divisor for this network: `params.json`'s minimum, lowered only by `testnet.yaml`. */
export function resolveStakeMin(cfg: NetworkConfig): { divisor: number; effectiveTon: number } {
    return stakeMinOf(cfg, params.staked_reserve.stake_min_ton);
}

/**
 * Copy every `/.env` key that `process.env` does not already set into
 * `process.env`, once, at the top of an entry script.
 *
 * WHY. `envValue()` above fixes a setting only where a caller was changed to
 * ask for it. The deploy path is full of plain `process.env.PRIMES_*` reads
 * that were never going to be rewritten one by one — `deployGenesis.ts` alone
 * has ten, and `resolvePresentation()` derives the JETTON MASTER's address
 * from three of them. Since `tsx` loads no `.env` at all, every one of those
 * silently read `undefined` and fell through to a default, which is how a run
 * that had just passed a green preflight died on
 * "PRIMES_INVITE_SIGNER_PUBKEY must be set" (a var D-202 has since deleted).
 *
 * Hydrating is the fix at the root: after this call the file IS the
 * environment, so a `process.env` read and an `envValue()` read cannot
 * disagree again. `process.env` still wins where it is already set, so an
 * inline `FOO=bar npx tsx ...` override behaves exactly as before.
 *
 * Returns the parsed map, so a caller can keep using `envValue`/`deploySubwalletId`.
 */
export function hydrateProcessEnv(): Map<string, string> {
    const env = loadEnvFile();
    for (const [k, v] of env) {
        if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
    }
    return env;
}

/**
 * Refuse to derive an address from a stale `contracts/build/`. A contract's address is a
 * hash of its CODE, so a pool created against yesterday's jetton-master artifact is a pool
 * for a token the genesis will never deploy (`MISTAKES.md` 2026-11-12). Called first by the
 * two scripts that derive the master before genesis: `createDedustPool.ts`, `genesisPrep.ts`.
 */
export function assertBuildFresh(): void {
    try {
        execFileSync(process.execPath, [path.resolve(__dirname, '..', '..', 'tools', 'check-contracts-build-fresh.mjs')], { stdio: 'pipe' });
    } catch (e: any) {
        throw new Error(
            'contracts/build is stale or missing — run `npx blueprint build --all` in contracts/ first.\n' +
                String(e?.stdout ?? '') + String(e?.stderr ?? '')
        );
    }
}
