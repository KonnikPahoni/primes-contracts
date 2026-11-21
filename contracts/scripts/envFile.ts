/**
 * TON PRIMES — the one reader for `/.env`, shared by every deploy-side script.
 *
 * WHY THIS EXISTS. Three scripts in this directory used to read the same two
 * settings two different ways, and the disagreement was silent and expensive:
 *
 *   - `genesisPrep.ts` parsed the `.env` FILE for everything, including
 *     `PRIMES_DEPLOY_SUBWALLET_ID`.
 *   - `deployGenesis.ts --skew-safe` and `dryRunGenesisAddresses.ts` parsed the
 *     file for `KEEPER_WALLET_MNEMONIC` but read `PRIMES_DEPLOY_SUBWALLET_ID`
 *     from `process.env`.
 *
 * `.env` is where that variable is documented to live and `tsx` does not load
 * `.env` into `process.env`, so with the id set only in the file — the normal
 * case — the preflight reported and funded one subwallet and the runner
 * deployed from a different one. Every genesis address derives from that
 * wallet, so the two disagreeing is not a cosmetic drift: `genesisPrep.ts`
 * would green-light a wallet holding 15 TON while `deployGenesis.ts --skew-safe`
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
 * D-139 — THE TEST CLOCK, read as a DURATION and published as a DIVISOR.
 *
 * `PRIMES_AUCTION_SECONDS` is the wall-clock length an ascending auction should
 * run on the set being deployed. Mainnet is `604800` (7 days) and that is the
 * default, so a `.env` without the key deploys exactly what it always did. A
 * testnet run sets `3600` and gets a 1-hour auction — and, because ONE divisor
 * drives every clock in the set, a ~8.5-minute flush cooldown and a
 * ~8.5-minute governance vote with it.
 *
 * It is expressed in seconds rather than as the divisor because that is what
 * the operator actually wants to say; the divisor is derived, and refused if it
 * does not divide evenly, so nobody has to reason about a rounded auction
 * window. The ceiling is `BID_EXTENSION` (4020s): past it the anti-snipe
 * extension would floor to zero and an auction would stop extending at all.
 */
export const MAINNET_AUCTION_SECONDS = 604800;

export function clockDivisorFromEnv(env: Map<string, string>): number {
    const raw = envValue(env, 'PRIMES_AUCTION_SECONDS');
    if (!raw) return 1;
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAINNET_AUCTION_SECONDS) {
        throw new Error(
            `PRIMES_AUCTION_SECONDS must be an integer in 1..${MAINNET_AUCTION_SECONDS} (got ${raw})`
        );
    }
    if (MAINNET_AUCTION_SECONDS % seconds !== 0) {
        throw new Error(
            `PRIMES_AUCTION_SECONDS must divide ${MAINNET_AUCTION_SECONDS} exactly ` +
                `(got ${seconds}; try 604800, 86400, 7200, 3600, 1800 or 600)`
        );
    }
    const divisor = MAINNET_AUCTION_SECONDS / seconds;
    if (divisor > 4020) {
        throw new Error(
            `PRIMES_AUCTION_SECONDS=${seconds} implies a clock divisor of ${divisor}, ` +
                `past the 4020 ceiling (the bid extension would floor to 0 seconds)`
        );
    }
    return divisor;
}

/**
 * D-153 — THE TEST STAKE FLOOR, read as a MINIMUM and published as a DIVISOR.
 *
 * `PRIMES_STAKE_MIN_TON` is the smallest stake §4.3.2's `stake` should accept on
 * the set being deployed. Mainnet is `500` and that is the default, so a `.env`
 * without the key deploys exactly what `shared/params.json`'s
 * `staked_reserve.stake_min_ton` declares.
 *
 * WHY THE KEY EXISTS AT ALL. The liquid reserve is 20% of the ratchet's
 * obligation, so `amount = pending - target = 0.8 * pending` and the FIRST
 * `stake` is illegal until `pending` exceeds **625 TON**. On testnet the only
 * permissionless route into `pending` is `donate_floor`, and §8 guarantees no
 * key ever gets that TON back — so a wave that wanted to prove the staked
 * reserve had to burn ~600 unrecoverable TON, every wave. Same shape as the
 * nine-day wall clock D-139 solved, on the value axis instead of the time axis.
 *
 * Expressed as the MINIMUM rather than as the divisor for the same reason
 * `PRIMES_AUCTION_SECONDS` is a duration: it is what the operator wants to say.
 * Unlike the clock it need NOT divide evenly — `STAKE_MIN / divisor` is integer
 * division over nanotons, where a remainder is dust — so the resolver rounds to
 * the nearest divisor and the caller is expected to print the effective figure
 * (`resolveStakeMin` below returns both).
 */
const MAINNET_STAKE_MIN_TON = 500;

export function resolveStakeMin(env: Map<string, string>): { divisor: number; effectiveTon: number } {
    const raw = envValue(env, 'PRIMES_STAKE_MIN_TON');
    if (!raw) return { divisor: 1, effectiveTon: MAINNET_STAKE_MIN_TON };
    const want = Number(raw);
    if (!Number.isFinite(want) || want <= 0 || want > MAINNET_STAKE_MIN_TON) {
        throw new Error(
            `PRIMES_STAKE_MIN_TON must be a number in (0, ${MAINNET_STAKE_MIN_TON}] ` +
                `(got ${raw}). It is a MINIMUM in TON, not a divisor, and it can only be ` +
                `lowered from the declared figure — never raised.`
        );
    }
    const divisor = Math.max(1, Math.round(MAINNET_STAKE_MIN_TON / want));
    if (divisor > 65535) {
        throw new Error(
            `PRIMES_STAKE_MIN_TON=${want} implies a stake divisor of ${divisor}, past the ` +
                `uint16 ceiling of 65535 (the smallest reachable minimum is ~0.0076 TON)`
        );
    }
    return { divisor, effectiveTon: MAINNET_STAKE_MIN_TON / divisor };
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
