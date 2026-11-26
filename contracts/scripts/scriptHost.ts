/**
 * TON PRIMES — the ONE sender seam for `deployGenesis.ts` and `ignite.ts` (GAUNTLET.md G55).
 *
 * Each of those scripts used to exist twice: a blueprint entry point and a "SkewSafe" fork
 * that differed only in how it signed and sent. The forks drifted — the blueprint copy still
 * described prime lots as decaying "to MINT_PRICE and resting there forever" long after D-88
 * made the rest `max(NPV(n)/2, MINT_PRICE)`. Now each script is one body over a `ScriptHost`,
 * and the sender is chosen at the command line:
 *
 *   npx blueprint run deployGenesis --testnet --mnemonic      # blueprint's sender
 *   npx tsx scripts/deployGenesis.ts --skew-safe [--mainnet]   # the skew-safe sender
 *
 * WHY THE SKEW-SAFE SENDER EXISTS (docs/testnet-deployment.md, "this sandbox's clock lags real
 * time by ~113 seconds"): blueprint signs every external with the library-default
 * `timeout = now + 60` from the LOCAL clock and exposes no override, so on a lagging machine
 * every message is already expired (exit code 36) when it reaches the network.
 *
 * The sender is `testnet/sender.ts`'s `openWallet` — the ONE skew-safe sender (+600s expiry,
 * retried, confirmed by seqno advance, balance-checked) — so this file adds only what a
 * genesis needs on top: the throttled client, the chain clock offset, and code loaded from
 * `contracts/build/` (`npx blueprint build --all` first; the skew-safe path does not compile).
 *
 * Key custody (skew-safe only): DEPLOYER_MNEMONIC from /.env, subwallet
 * `PRIMES_DEPLOY_SUBWALLET_ID`. Network: `--mainnet` / `--testnet`, else PRIMES_NETWORK, else
 * testnet (`envFile.ts`'s `scriptNetwork`, G96); a testnet run also passes `assertTestnetOnly`.
 *
 * USE `tsx`, NOT `ts-node`. ts-node chokes on this repo's ESM/TS config and the failure looks
 * like a compile error in the pipeline rather than a runner problem.
 */
import fs from 'fs';
import path from 'path';
import { Address, Cell, TonClient } from '@ton/ton';
import type { Contract, OpenedContract, Sender, TupleItem, TupleReader } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { deploySubwalletId, loadEnvFile, scriptNetwork } from './envFile';
import { assertTestnetOnly, keeperMnemonic, openWallet, retry } from './testnet/sender';

export interface ScriptHost {
    network: string;
    sender: Sender;
    address: Address;
    /** `PRIMES_DEPLOY_SUBWALLET_ID` when the skew-safe sender derived the wallet from it. */
    walletId?: number;
    open<T extends Contract>(c: T): OpenedContract<T>;
    write(m: string): void;
    now(): number;
    balance(): Promise<bigint>;
    runGet(addr: Address, method: string, args: TupleItem[]): Promise<TupleReader>;
    code(name: string): Promise<Cell>;
    /** Wraps one RPC in the host's retry policy. Identity under blueprint. */
    retry<T>(fn: () => Promise<T>, label: string): Promise<T>;
}

/** `--skew-safe` on the command line selects `skewSafeHost()` over blueprint. */
const SKEW_SAFE_FLAG = '--skew-safe';

export function hostFromProvider(provider: NetworkProvider): ScriptHost {
    const address = provider.sender().address!;
    return {
        network: provider.network(),
        sender: provider.sender(),
        address,
        open: (c) => provider.open(c),
        write: (m) => provider.ui().write(m),
        now: () => Math.floor(Date.now() / 1000),
        balance: async () => (await provider.provider(address).getState()).balance,
        runGet: async (addr, method, args) => (await provider.provider(addr).get(method, args)).stack,
        code: (name) => compile(name),
        retry: (fn) => fn(),
    };
}

/**
 * Serialize and back off EVERY RPC this process makes, not just the script's own.
 *
 * `retry()` only covers the calls a script makes itself. But `open()` hands the wrappers the
 * raw `TonClient`, so every `isContractDeployed` / get-method call they make went straight to
 * TonCenter with no retry — and on the 2026-09-01 run that is exactly what killed the
 * pipeline: seven contracts deployed, then `PrimesMarket.sendDeploy`'s internal
 * `isContractDeployed` took a 429 and the whole genesis aborted mid-flight with the one-shot
 * wiring still unspent (MISTAKES.md).
 *
 * `HttpApi.doCall` is the single choke point every TonCenter request passes through, so
 * patching it once covers the wrappers, the provider and the script alike: a minimum interval
 * between calls, and a bounded backoff on 429 specifically. Patch `doCall` and nothing above
 * it: `TonClient.getBalance` calls its own `getContractState`, so throttling both ends would
 * make the outer call wait on a queue slot the inner call can never reach.
 */
export function throttleClient(client: TonClient, minIntervalMs = 1100, maxRetries = 8): void {
    const api: any = (client as any).api;
    if (!api?.doCall) throw new Error('throttleClient: could not reach HttpApi.doCall');
    const orig = api.doCall.bind(api);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let queue: Promise<unknown> = Promise.resolve();

    api.doCall = (...args: any[]) => {
        const run = queue.then(async () => {
            for (let i = 0; ; i++) {
                try {
                    return await orig(...args);
                } catch (e: any) {
                    const status = e?.response?.status ?? e?.status;
                    if (status !== 429 || i >= maxRetries) throw e;
                    const wait = 2000 * (i + 1);
                    console.log(`[throttle] 429 on ${args[0]}, backing off ${wait}ms (attempt ${i + 1})`);
                    await sleep(wait);
                }
            }
        });
        // Keep the queue alive whether or not this call succeeded, so one hard failure
        // does not wedge every later RPC behind a rejected promise.
        queue = run.then(
            () => sleep(minIntervalMs),
            () => sleep(minIntervalMs)
        );
        return run;
    };
}

const BUILD = path.resolve(__dirname, '..', 'build');

export async function skewSafeHost(): Promise<ScriptHost> {
    // G96: the network is the one this deploy was given (`--mainnet` / PRIMES_NETWORK), and
    // `scriptNetwork` refuses an endpoint that is not that network's. A testnet run still
    // carries D-95's testnet-only guard on top.
    const { network, testOnly, endpoint, apiKey } = scriptNetwork();
    if (testOnly) assertTestnetOnly(endpoint);
    const client = new TonClient({ endpoint, apiKey });
    throttleClient(client);
    // Every genesis contract's init embeds `genesisScriptAddr`, so REUSING a deploy wallet
    // re-derives the addresses of any contract whose other init fields are unchanged — the
    // 2026-08-17 run landed three contracts on their previous addresses, where the OLD
    // instances silently rejected every wire from the new set. Each cycle deploys from a
    // FRESH SUBWALLET, and ignite must use the same one (the ledger only accepts ignite from
    // `genesisScriptAddr`).
    const walletId = deploySubwalletId(loadEnvFile());
    const { wallet, sender } = await openWallet(client, keeperMnemonic(), walletId);
    console.log(`network: ${network}  wallet: ${wallet.address.toString({ testOnly })}`);

    // This machine's clock lags chain time (113s in 2026-08-16, 134s in 2026-08-27). The
    // signing timeout carries a 600s window for that, but `now()` must too: genesisPipeline
    // derives the venue-timelock eta as `now() + TIMELOCK_DELAY + 60`, and a 60s cushion is
    // smaller than the skew, so the timelock threw 801 and the 2026-08-27 genesis stopped on
    // step 8. Read the offset off the chain rather than calibrating a constant that drifts.
    const chainNow = await retry(async () => {
        const r = await fetch(
            `${endpoint.replace(/\/jsonRPC$/, '')}/getAddressInformation?address=${wallet.address.toString()}`
        );
        const j: any = await r.json();
        const t = Number(j?.result?.sync_utime);
        if (!t) throw new Error('no sync_utime in getAddressInformation');
        return t;
    }, 'sync_utime');
    const clockSkew = chainNow - Math.floor(Date.now() / 1000);
    console.log(`clock skew vs chain: ${clockSkew}s (now() is offset by this)`);

    return {
        network,
        sender,
        address: wallet.address,
        walletId,
        open: <T extends Contract>(c: T) => client.open(c) as OpenedContract<T>,
        write: (m) => console.log(m),
        now: () => Math.floor(Date.now() / 1000) + clockSkew,
        balance: () => retry(() => client.getBalance(wallet.address), 'getBalance'),
        runGet: async (addr, method, args) =>
            (await retry(() => client.runMethod(addr, method, args), `runGet:${method}`)).stack,
        code: async (name) => {
            const j = JSON.parse(fs.readFileSync(path.join(BUILD, `${name}.compiled.json`), 'utf8'));
            return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
        },
        retry,
    };
}

/** The tsx entry point both scripts share: refuse to run without the flag, so a direct
 *  `tsx` run can never be mistaken for blueprint's sender. */
export function runSkewSafe(script: string, body: (host: ScriptHost) => Promise<void>): void {
    if (!process.argv.includes(SKEW_SAFE_FLAG)) {
        console.error(
            `Run ${script} through blueprint (npx blueprint run ${script} --testnet --mnemonic), ` +
                `or directly with ${SKEW_SAFE_FLAG}: npx tsx scripts/${script}.ts ${SKEW_SAFE_FLAG}`
        );
        process.exit(2);
    }
    skewSafeHost()
        .then(body)
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}
