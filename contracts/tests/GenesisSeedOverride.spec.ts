// TON PRIMES — the testnet-only nominal-seed override (CONCEPT.md §6 point 3).
//
// D-46: the seed is a NOMINAL sizing figure, never deposited — §6 point 3 fixes
// it at `params.genesis.genesis_seed_ton` and sizes the treasury's vested
// allocation and `S0` from it (`S0 = seed·L/2 + V`, D-166); `T` at the genesis seed is
// always `0` regardless (no real deposit at genesis, seed or not).
//
// D-100 point 2 IS WHY THIS FILE MATTERS MORE THAN IT USED TO. The seed (200 GRAM)
// and the genesis DONATION (132.50 GRAM, D-154) were the same number by construction until
// the owner unpinned them, so a script that reached for the wrong one was still
// right. It is not any more: `genesis_seed_ton` sizes supply and no GRAM moves for
// it, while `genesis_donation_ton` is the GRAM that actually lands in `T` through
// a separate permissionless `donate_floor`. The last test below pins that the
// override touches the first and not the second.
// `PRIMES_TESTNET_SEED_TON` exists only so that a full genesis can be
// rehearsed on a wallet a testnet faucet can fill, and it must therefore be
// fenced hard enough that it can never quietly become the way mainnet is
// deployed.
//
// This file pins the fence, not the arithmetic: refused off testnet, refused
// upward, refused at zero, absent by default.
import { toNano } from '@ton/core';
import { resolveSeedTon, requireMainnetDivisors } from '../scripts/deployGenesis';
import { configNetworkFor, parseNetworkConfig, type Network } from '../../shared/networkConfig';
import params from '../../shared/params.json';

/** A minimal network file; `overrides` is the body of a `test_overrides` block. */
function cfgWith(network: Network, overrides?: string) {
    const text = [
        `network: ${network}`,
        'presentation:',
        '  collection_metadata_uri: https://primes.live/collection.json',
        '  nft_content_prefix: https://primes.live/nft/',
        '  jetton_metadata_uri: https://primes.live/jetton.json',
        ...(overrides === undefined ? [] : ['test_overrides:', `  ${overrides}`]),
    ].join('\n');
    return parseNetworkConfig(text, network);
}

/** Collects the banner `resolveSeedTon` writes. */
function sink() {
    const lines: string[] = [];
    return { ui: { write: (m: string) => void lines.push(m) }, lines };
}

const SPEC_SEED = toNano(String(params.genesis.genesis_seed_ton));

describe('nominal seed override', () => {
    it('returns the CONCEPT §6 seed when the override is absent', () => {
        for (const network of ['mainnet', 'testnet'] as const) {
            const { ui, lines } = sink();
            expect(resolveSeedTon(cfgWith(network), ui)).toBe(SPEC_SEED);
            // No banner: an un-overridden run must not be noisy, or the loud
            // case stops reading as loud.
            expect(lines).toHaveLength(0);
        }
    });

    it('cannot be written into mainnet.yaml at all', () => {
        expect(() => cfgWith('mainnet', 'seed_ton: 10')).toThrow(/test_overrides is testnet-only/);
    });

    it('treats every non-testnet network as mainnet, not just mainnet', () => {
        // `custom` can point at a mainnet endpoint, so allow-listing testnet is
        // the only safe direction; a deny-list of mainnet would let it through.
        for (const network of ['custom', 'tetra', 'mainnet']) expect(configNetworkFor(network)).toBe('mainnet');
        expect(configNetworkFor('testnet')).toBe('testnet');
    });

    it('accepts a smaller seed on testnet and shouts about it', () => {
        const { ui, lines } = sink();
        expect(resolveSeedTon(cfgWith('testnet', 'seed_ton: 10'), ui)).toBe(toNano('10'));

        const banner = lines.join('\n');
        expect(banner).toMatch(/NOT a v5 genesis/i);
        // The banner must name what survives and what does not — an operator
        // reading only this output should not walk away thinking the opening
        // floor observed on testnet is the v5 floor.
        expect(banner).toMatch(/PRESERVED/);
        expect(banner).toMatch(/DISTORTED/);
        expect(banner).toMatch(/opening floor/i);
    });

    it('refuses a seed larger than the specified one', () => {
        // The override is an affordability escape hatch downward. Upward it
        // would just be an unreviewed change to §6 economics.
        const cfg = cfgWith('testnet', `seed_ton: ${params.genesis.genesis_seed_ton + 1}`);
        expect(() => resolveSeedTon(cfg, sink().ui)).toThrow(/exceeds the specified seed/i);
    });

    it('refuses a zero or negative seed', () => {
        for (const bad of ['0', '-5']) {
            expect(() => cfgWith('testnet', `seed_ton: ${bad}`)).toThrow(/must be a positive number/i);
        }
    });

    it('does not touch the D-100 donation, which is a different number entirely', () => {
        // The confusion this guards against, stated as a test rather than as a
        // comment: an override is an AFFORDABILITY knob on the nominal seed, and
        // the GRAM that actually moves at genesis is the donation either way. If some
        // future edit routed the donation through `resolveSeedTon`, a testnet
        // rehearsal would donate the override and mainnet the real figure.
        const cfg = cfgWith('testnet', 'seed_ton: 10');
        expect(resolveSeedTon(cfg, sink().ui)).toBe(toNano('10'));
        // Unmoved by the override. D-220 set the donation to 100 GRAM (D-204 had it
        // at 200, the nominal seed's figure; D-154 at 132.50, D-100 point 2 at 4.20)
        // — two fields that have held the same number and still two fields: the
        // override moves one and not the other.
        expect(params.genesis.genesis_donation_ton).toBe(100);
        expect(resolveSeedTon(cfg, sink().ui)).not.toBe(toNano(String(params.genesis.genesis_donation_ton)));
    });

    it('reports the opening floor as materially worse, not proportionally so', () => {
        // The point the banner exists to make. S0 = seed·L/2 + V (D-166) with V fixed,
        // so a 20x smaller seed is NOT a 20x smaller floor.
        const { ui, lines } = sink();
        resolveSeedTon(cfgWith('testnet', 'seed_ton: 10'), ui);

        const floors = lines.join('\n').match(/1 GRAM = ([\d.]+) PRIMES/g);
        expect(floors).toHaveLength(2); // this run, then spec
        const [run, spec] = floors!.map((l) => Number(l.match(/([\d.]+) PRIMES/)![1]));
        const seedRatio = params.genesis.genesis_seed_ton / 10;
        const floorRatio = run / spec;
        expect(floorRatio).toBeGreaterThan(1); // worse for the buyer
        expect(floorRatio).toBeLessThan(seedRatio); // but sub-linearly so
    });
});

// D-153 "later increase back for production": both test divisors are refused off testnet.
describe('test divisors off testnet', () => {
    it('allows any divisor on testnet and 1/1 anywhere', () => {
        expect(() => requireMainnetDivisors('testnet', 168, 167)).not.toThrow();
        expect(() => requireMainnetDivisors('mainnet', 1, 1)).not.toThrow();
    });
    it.each([
        [168, 1],
        [1, 167],
    ])('refuses clockDivisor=%i stakeDivisor=%i on mainnet', (clock, stake) => {
        expect(() => requireMainnetDivisors('mainnet', clock, stake)).toThrow(/must be 1 off testnet/);
    });
});
