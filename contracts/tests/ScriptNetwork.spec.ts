/**
 * G96 — the genesis scripts take their network from the value the deploy is given
 * (`--mainnet` / `--testnet`, else PRIMES_NETWORK), never from a literal, and refuse an
 * endpoint that belongs to the other network.
 */
import { scriptNetwork } from '../scripts/envFile';
import { assertTestnetOnly } from '../scripts/testnet/sender';

const env = (o: Record<string, string> = {}) => new Map(Object.entries(o));
const KEYS = ['PRIMES_NETWORK', 'TON_NETWORK', 'TON_RPC_ENDPOINT', 'TONCENTER_API_KEY', 'TONCENTER_API_KEY_TESTNET'];

describe('G96 · scriptNetwork', () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => KEYS.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])));
    afterEach(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

    it('defaults to testnet with the testnet key', () => {
        const n = scriptNetwork(env({ TONCENTER_API_KEY_TESTNET: 't', TONCENTER_API_KEY: 'm' }), []);
        expect(n).toEqual({ network: 'testnet', testOnly: true, endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey: 't' });
    });

    it('follows --mainnet and PRIMES_NETWORK, with the mainnet key', () => {
        const viaFlag = scriptNetwork(env({ TONCENTER_API_KEY: 'm' }), ['--mainnet']);
        expect(viaFlag).toEqual({ network: 'mainnet', testOnly: false, endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: 'm' });
        expect(scriptNetwork(env({ PRIMES_NETWORK: 'mainnet' }), []).network).toBe('mainnet');
    });

    it('ignores TON_NETWORK (the backend selector)', () => {
        expect(scriptNetwork(env({ TON_NETWORK: 'mainnet' }), []).network).toBe('testnet');
    });

    it('refuses contradictions and bad values', () => {
        expect(() => scriptNetwork(env({ PRIMES_NETWORK: 'testnet' }), ['--mainnet'])).toThrow(/contradicts/);
        expect(() => scriptNetwork(env(), ['--mainnet', '--testnet'])).toThrow(/not both/);
        expect(() => scriptNetwork(env({ PRIMES_NETWORK: 'main' }), [])).toThrow(/PRIMES_NETWORK/);
    });

    it("refuses a TON_RPC_ENDPOINT from the other network", () => {
        process.env.TON_RPC_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC';
        expect(() => scriptNetwork(env(), [])).toThrow(/not a testnet endpoint/);
        process.env.TON_RPC_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';
        expect(() => scriptNetwork(env(), ['--mainnet'])).toThrow(/not a mainnet endpoint/);
    });

    it('leaves D-95 intact: the testnet harness still refuses a declared mainnet', () => {
        process.env.PRIMES_NETWORK = 'mainnet';
        expect(() => assertTestnetOnly()).toThrow(/mainnet environment declared/);
    });
});

describe('G96 · genesisPrep funding floor covers the donation and the pool', () => {
    // Imported lazily: genesisPrep hydrates process.env from /.env at load.
    const { seedingTon } = require('../scripts/genesisPrep') as typeof import('../scripts/genesisPrep');
    const params = require('../../shared/params.json');
    const g = params.genesis;

    it('mainnet: the spec donation, and a pairing at or above the sim pair', () => {
        const { donation, pairing } = seedingTon({ testOverrides: {} }, g);
        expect(donation).toBe(g.genesis_donation_ton);
        const simPair = g.genesis_donation_primes * g.genesis_floor_price_ton_per_primes;
        expect(pairing).toBeGreaterThanOrEqual(simPair);
        expect(pairing).toBeLessThan(donation);
    });

    it('testnet: follows test_overrides.donate_ton', () => {
        expect(seedingTon({ testOverrides: { donateTon: 50 } }, g).donation).toBe(50);
    });
});
