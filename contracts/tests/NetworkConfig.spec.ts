// TON PRIMES — shared/networks/{testnet,mainnet}.yaml, the per-network deploy facts.
//
// The files replaced ~17 env vars that a testnet `.env` carried straight into a mainnet
// genesis (a 0.5 GRAM naming fee, a 2 GRAM rename, a 1-hour auction clock — all deploy data
// with no setter). This pins what makes the replacement safer than what it replaced:
// mainnet's file cannot hold a test knob, an address carries its network's flag, and a
// stale env var is refused rather than silently shadowed.
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
    RETIRED_ENV_VARS,
    clockDivisorOf,
    parseNetworkConfig,
    requireGenesisReady,
    retiredEnvVarsSet,
    stakeMinOf,
    type Network,
} from '../../shared/networkConfig';
import params from '../../shared/params.json';

const text = (network: Network) =>
    readFileSync(resolve(__dirname, `../../shared/networks/${network}.yaml`), 'utf8');
const load = (network: Network) => parseNetworkConfig(text(network), network);

describe('the two network files', () => {
    it.each(['mainnet', 'testnet'] as const)('%s.yaml parses', (network) => {
        expect(load(network).network).toBe(network);
    });

    it('mainnet has no test overrides, so every clock and the stake floor are the spec figures', () => {
        const m = load('mainnet');
        expect(m.testOverrides).toEqual({});
        expect(clockDivisorOf(m)).toBe(1);
        expect(stakeMinOf(m, params.staked_reserve.stake_min_ton)).toEqual({
            divisor: 1,
            effectiveTon: params.staked_reserve.stake_min_ton,
        });
    });

    // The public primes-contracts mirror ships no DECISIONS.md; the check runs where it exists.
    const decisionsPath = resolve(__dirname, '../../DECISIONS.md');
    (existsSync(decisionsPath) ? it : it.skip)("mainnet's operator is the owner-signed production wallet", () => {
        // DECISIONS.md, D-209's 2026-11-21 amendment: permanent deploy data.
        const decisions = readFileSync(decisionsPath, 'utf8');
        const op = load('mainnet').operatorAddr!;
        expect(decisions).toContain(op);
    });

    it('testnet is genesis-ready, with the D-139 clock and D-153 floor it rehearses on', () => {
        const t = load('testnet');
        expect(() => requireGenesisReady(t)).not.toThrow();
        expect(t.stakingVenue).toBeNull(); // the mock Tonstakers pool stands in (D-151)
        expect(clockDivisorOf(t)).toBe(168);
    });
});

describe('the loader refuses', () => {
    const swap = (network: Network, from: string, to: string) => {
        const t = text(network);
        expect(t).toContain(from);
        return t.replace(from, to);
    };

    it('test_overrides in mainnet.yaml', () => {
        const t = text('mainnet') + '\ntest_overrides:\n  rename_fee_ton: 2\n';
        expect(() => parseNetworkConfig(t, 'mainnet')).toThrow(/test_overrides is testnet-only/);
    });

    it('a testnet-flagged address in mainnet.yaml', () => {
        // `kQ…` parses on any network; only the flag catches the paste.
        const t = swap(
            'mainnet',
            'operator_addr: UQA6VjkuaK3eQJMvgA7BSnYXywuwGfpP1W5_N6iJdNzOYU_c',
            'operator_addr: kQAhPdCL9V9m2ZXJXTig4smnDrOwoMBjga92XJQERr1A76Of'
        );
        expect(() => parseNetworkConfig(t, 'mainnet')).toThrow(/testnet-flagged address in mainnet\.yaml/);
    });

    it('a mainnet-flagged address in testnet.yaml', () => {
        const t = swap(
            'testnet',
            'dedust_native_vault: kQDa4VOnTYlLvDJ0gZjNYm5PXfSmmtL6Vs6A_CZEtXCNIJE1',
            'dedust_native_vault: EQDa4VOnTYlLvDJ0gZjNYm5PXfSmmtL6Vs6A_CZEtXCNICq_'
        );
        expect(() => parseNetworkConfig(t, 'testnet')).toThrow(/mainnet-flagged address in testnet\.yaml/);
    });

    it('a staking venue in testnet.yaml', () => {
        const t = text('testnet') + '\nstaking_venue:\n  tonstakers_pool: null\n';
        expect(() => parseNetworkConfig(t, 'testnet')).toThrow(/staking_venue is mainnet-only/);
    });

    it('an unknown key, so a typo cannot fall back to a default', () => {
        expect(() => parseNetworkConfig(text('testnet') + '\nname_fee: 1\n', 'testnet')).toThrow(/unknown key/);
    });

    it("a file read for the wrong network", () => {
        expect(() => parseNetworkConfig(text('testnet'), 'mainnet')).toThrow(/expected mainnet/);
    });

    it('a stake floor above the spec, and an auction clock that does not divide a week', () => {
        const t = swap('testnet', 'stake_min_ton: 3', `stake_min_ton: ${params.staked_reserve.stake_min_ton + 1}`);
        expect(() => stakeMinOf(parseNetworkConfig(t, 'testnet'), params.staked_reserve.stake_min_ton)).toThrow(
            /can only lower/
        );
        const c = swap('testnet', 'auction_seconds: 3600', 'auction_seconds: 3601');
        expect(() => clockDivisorOf(parseNetworkConfig(c, 'testnet'))).toThrow(/must divide 604800/);
    });

    it('a genesis on mainnet until the genesis-day name fee is written in', () => {
        // Launch gate M5: null until the GRAM/EUR rate is read on the day.
        const m = load('mainnet');
        if (m.nameFeeTon === null) expect(() => requireGenesisReady(m)).toThrow(/name_fee_ton/);
    });
});

describe('retired env vars', () => {
    it('are reported when set, and an empty compose-style value counts as unset', () => {
        const env: Record<string, string> = { PRIMES_NAME_FEE_TON: '0.5', KEEPER_FLUSH_COOLDOWN_SECONDS: '' };
        expect(retiredEnvVarsSet((k) => env[k])).toEqual(['PRIMES_NAME_FEE_TON']);
    });

    it('cover every override the files carry', () => {
        for (const k of ['PRIMES_RENAME_FEE_TON', 'PRIMES_DONATE_TON', 'PRIMES_AUCTION_SECONDS', 'PRIMES_STAKE_MIN_TON']) {
            expect(RETIRED_ENV_VARS).toContain(k);
        }
    });
});
