/**
 * TON PRIMES — the harness's ONE read layer (`TESTNET_MASTER_PLAN.md` §2 `chain.ts`).
 *
 * Two jobs, both of which were copy-pasted four times each across
 * `testnet/*.ts` before this file existed:
 *
 *  1. `env()` / `addr()` / `walletFor()` — the boilerplate every phase repeats.
 *  2. `snapshot()` — ONE read of everything an invariant is asserted against,
 *     returned as a value so two of them can be diffed. `state.ts` printed the
 *     same figures to stdout and returned nothing, so nothing could compare a
 *     before with an after; that is the whole reason `assert.ts` had no
 *     predicates and the seven invariants were never checked on a live chain.
 *
 * Every read goes through `retry()`. An unretried get-call reads a 429 as
 * "absent", which is how the first `txAudit` run silently dropped 16 of 20
 * items (MISTAKES.md 2026-09-17).
 */
import { Address, type OpenedContract } from '@ton/core';
import { TonClient } from '@ton/ton';
import { PrimesLedger } from '../../wrappers/PrimesLedger';
import { PrimesRatchet } from '../../wrappers/PrimesRatchet';
import { PrimesRegistrar } from '../../wrappers/PrimesRegistrar';
import { PrimesMarket } from '../../wrappers/PrimesMarket';
import { PrimesBountyVault } from '../../wrappers/PrimesBountyVault';
import { loadEnvFile, envValue } from '../envFile';
import { makeClient, openDeployWallet, openWallet, retry, type Wallet } from './sender';
import { readCast } from './cast';

export function env(name: string): string {
    const v = envValue(loadEnvFile(), name);
    if (!v) throw new Error(`${name} missing from /.env`);
    return v;
}

export function envOpt(name: string): string | undefined {
    const v = envValue(loadEnvFile(), name);
    return v && v.trim() ? v.trim() : undefined;
}

export function addr(name: string): Address {
    return Address.parse(env(name));
}

/** `K` is the deploy subwallet (the funder); everything else is a cast handle. */
export async function walletFor(client: TonClient, handle: string): Promise<Wallet> {
    if (handle === 'K') return openDeployWallet(client);
    const entry = readCast().find((c) => c.handle === handle);
    if (!entry) throw new Error(`no cast wallet "${handle}" — run "cast.ts new" first`);
    // The version travels with the entry. Absent means v4R2, which is every wallet
    // `cast.ts new` mints; `.owner.json` may say `v5r1` because the human's own wallet app
    // decides that, and the same seed under the wrong contract is a different live account
    // (`sender.ts`'s `WalletVersion`).
    return openWallet(client, entry.mnemonic.split(/\s+/), undefined, entry.version);
}

export type Contracts = {
    client: TonClient;
    ledger: OpenedContract<PrimesLedger>;
    ratchet: OpenedContract<PrimesRatchet>;
    registrar: OpenedContract<PrimesRegistrar>;
    market: OpenedContract<PrimesMarket>;
    vault: OpenedContract<PrimesBountyVault>;
};

export function contracts(client = makeClient()): Contracts {
    return {
        client,
        ledger: client.open(PrimesLedger.createFromAddress(addr('PRIMES_LEDGER_ADDRESS'))),
        ratchet: client.open(PrimesRatchet.createFromAddress(addr('PRIMES_RATCHET_ADDRESS'))),
        registrar: client.open(PrimesRegistrar.createFromAddress(addr('PRIMES_REGISTRAR_ADDRESS'))),
        market: client.open(PrimesMarket.createFromAddress(addr('PRIMES_MARKET_ADDRESS'))),
        vault: client.open(PrimesBountyVault.createFromAddress(addr('PRIMES_BOUNTY_VAULT_ADDRESS'))),
    };
}

/**
 * Everything the seven predicates read, in one pass. Bigints are kept as
 * bigints — a `Number()` on `S` loses precision above 2^53 and `S` passes that
 * within the first few hundred mints.
 */
export type Snapshot = {
    at: string;
    head: number;
    /** `T` — the ledger's floor numerator (CONCEPT §5). */
    T: bigint;
    /** `S` — cumulative emission plus the genesis bounty vault, never decremented. */
    S: bigint;
    /** The founder capital genesis credits straight into `T` (D-26). */
    seedT: bigint;
    pending: bigint;
    swapped: bigint;
    inFlightFlush: bigint;
    ledgerSolvency: { balance: bigint; liability: bigint; delta: bigint };
    ratchetSolvency: { balance: bigint; liability: bigint; delta: bigint };
    registrarSolvency: { balance: bigint; liability: bigint; delta: bigint };
    liability: Awaited<ReturnType<PrimesLedger['getLiabilityBreakdown']>>;
    vaultPayouts: { payoutCount: number; primesPaid: bigint } | null;
    /**
     * §4.3.2's staked reserve (D-151). `null` on a set deployed before it, which
     * is why every consumer must branch rather than assume — the predicates below
     * degrade to the old three-term identity there instead of failing.
     */
    staking: {
        stakedCost: bigint;
        exiting: bigint;
        tstonHeld: bigint;
        realizedLoss: bigint;
        reserveTarget: bigint;
    } | null;
};

export async function snapshot(c: Contracts = contracts()): Promise<Snapshot> {
    const [head, T, S, seedT] = await Promise.all([
        retry(() => c.ledger.getHead(), 'getHead'),
        retry(() => c.ledger.getFloorNum(), 'getFloorNum'),
        retry(() => c.ledger.getFloorDen(), 'getFloorDen'),
        retry(() => c.ledger.getSeedT(), 'getSeedT'),
    ]);
    const [pending, swapped, inFlightFlush] = await Promise.all([
        retry(() => c.ratchet.getPending(), 'getPending'),
        retry(() => c.ratchet.getSwapped(), 'getSwapped'),
        retry(() => c.ratchet.getInFlightFlush(), 'getInFlightFlush'),
    ]);
    const [ledgerSolvency, ratchetSolvency, registrarSolvency, liability] = await Promise.all([
        retry(() => c.ledger.getSolvency(), 'ledger.getSolvency'),
        retry(() => c.ratchet.getSolvency(), 'ratchet.getSolvency'),
        retry(() => c.registrar.getSolvency(), 'registrar.getSolvency'),
        retry(() => c.ledger.getLiabilityBreakdown(), 'getLiabilityBreakdown'),
    ]);
    // The vault is read best-effort: a set whose vault is still un-funded
    // answers fine, but a partially-deployed one should not fail a snapshot.
    let vaultPayouts: Snapshot['vaultPayouts'] = null;
    try {
        // RETRIED like every other get-call in this file. Unwrapped, a toncenter 429
        // lands in the catch below and the whole snapshot reports the vault as ABSENT —
        // a rate limit read as a missing contract, which is the one failure this file's
        // header says it exists to prevent.
        const p = await retry(() => c.vault.getVaultPayouts(), 'getVaultPayouts');
        vaultPayouts = { payoutCount: p.payoutCount, primesPaid: p.paidTotalPrimes };
    } catch {
        /* vault not readable on this set — the predicates that need it say so */
    }
    // §4.3.2 (D-151). Best-effort for the same reason the vault is: a set
    // deployed before the staked reserve answers `exit_code: 11` here, and a
    // snapshot of an older set must still work. `null` means "this set has no
    // staked reserve", which is a different statement from "it holds zero".
    let staking: Snapshot['staking'] = null;
    try {
        // NOT wrapped in `retry` at the top level, unlike every other read here.
        // `exit_code: 11` means the method is not on the deployed bytecode, which
        // is deterministic — retrying it eight times costs ~40 s on every
        // snapshot of a pre-D-151 set. So: one call, and fall back to the retried
        // form for anything that is NOT 11, because a toncenter 429 read as
        // "absent" is the failure this file's header exists to prevent.
        const k = await c.ratchet.getStaking().catch((e: unknown) => {
            if (/exit_code:\s*11\b/.test((e as Error)?.message ?? '')) throw e;
            return retry(() => c.ratchet.getStaking(), 'getStaking');
        });
        staking = {
            stakedCost: k.stakedCost,
            exiting: k.exiting,
            tstonHeld: k.tstonHeld,
            realizedLoss: k.realizedLoss,
            reserveTarget: k.reserveTarget,
        };
    } catch {
        /* pre-D-151 set */
    }
    return {
        staking,
        at: new Date().toISOString(),
        head: Number(head),
        T,
        S,
        seedT,
        pending,
        swapped,
        inFlightFlush,
        ledgerSolvency,
        ratchetSolvency,
        registrarSolvency,
        liability,
        vaultPayouts,
    };
}

/** `p_f = T / S`, as a float, for printing only — never for an assert. */
export function floorPrice(s: Snapshot): number {
    return s.S === 0n ? 0 : Number(s.T) / Number(s.S);
}

const API_BASE = envOpt('VITE_READ_PROXY_URL') ?? 'https://primes.live/api';
export const EVENTS_BASE = envOpt('VITE_EVENT_POLLER_URL') ?? 'https://primes.live/events';

/** A JSON GET against the deployed read-proxy / poller, with the same retry policy. */
export async function api<T = any>(path: string, base = API_BASE): Promise<T> {
    return retry(async () => {
        const res = await fetch(base + path, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`${base}${path} → HTTP ${res.status}`);
        return (await res.json()) as T;
    }, `GET ${path}`);
}
