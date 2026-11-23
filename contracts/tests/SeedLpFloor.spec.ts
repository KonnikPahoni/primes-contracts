/**
 * GAUNTLET G67 — `seedDedustLiquidity.ts` opens an empty pool at the LEDGER's floor.
 *
 * The params figure (then 1.2045e-5, D-154's 132.50 GRAM donation) was posted against a live
 * floor of 6.3867e-6 (a 75 GRAM donation) twice, opening the book 1.886x above `p_f`.
 */
import { openingFloorNanotonPerPrimes } from '../scripts/dedust';

const NANO = 1_000_000_000n;
// 75 GRAM against 11,743,000 PRIMES of S: the `20260928` shape.
const LIVE_75 = { t: 75n * NANO, s: 11_743_000n * NANO };
const PARAMS = 10_761n; // floor(1.0761e-5 * 1e9): 132.50 GRAM over S0 + the donor's mint

describe('openingFloorNanotonPerPrimes', () => {
    it('refuses when the live floor and params disagree and nobody chose', () => {
        expect(() => openingFloorNanotonPerPrimes(LIVE_75, PARAMS)).toThrow(/PRIMES_LP_FLOOR/);
    });

    it('prices at the live floor when told to, rounded down', () => {
        const r = openingFloorNanotonPerPrimes(LIVE_75, PARAMS, 'live');
        expect(r).toEqual({ nanotonPerPrimes: (LIVE_75.t * NANO) / LIVE_75.s, source: 'live' });
        expect(r.nanotonPerPrimes).toBe(6386n);
    });

    it('takes params only when named', () => {
        expect(openingFloorNanotonPerPrimes(LIVE_75, PARAMS, 'params')).toEqual({ nanotonPerPrimes: PARAMS, source: 'params' });
    });

    it('uses the live floor silently when the two agree to a nanoGRAM', () => {
        // The 2026-09-24 testnet genesis read-back: S 11,000,000 + 1,312,854.17 donated.
        const live = { t: 13_250n * NANO / 100n, s: 12_312_854_166_666_666n };
        expect(openingFloorNanotonPerPrimes(live, PARAMS).source).toBe('live');
    });

    it('refuses an undonated ledger and an unknown choice', () => {
        expect(() => openingFloorNanotonPerPrimes({ t: 0n, s: 0n }, PARAMS, 'live')).toThrow(/donateFloor/);
        expect(() => openingFloorNanotonPerPrimes(LIVE_75, PARAMS, 'spot')).toThrow(/expected/);
    });
});
