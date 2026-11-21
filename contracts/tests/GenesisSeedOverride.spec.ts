// TON PRIMES — the testnet-only nominal-seed override (CONCEPT.md §6 point 3).
//
// D-46: the seed is a NOMINAL sizing figure, never deposited — §6 point 3 fixes
// it at `params.genesis.genesis_seed_ton` and sizes the treasury's vested
// allocation and `S0` from it (`S0 = seed·L/2 + V`, D-166); `T` at the genesis seed is
// always `0` regardless (no real deposit at genesis, seed or not).
//
// D-100 point 2 IS WHY THIS FILE MATTERS MORE THAN IT USED TO. The seed (200 TON)
// and the genesis DONATION (132.50 TON, D-154) were the same number by construction until
// the owner unpinned them, so a script that reached for the wrong one was still
// right. It is not any more: `genesis_seed_ton` sizes supply and no TON moves for
// it, while `genesis_donation_ton` is the TON that actually lands in `T` through
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
import params from '../../shared/params.json';

/** Just enough of NetworkProvider for the resolver; `write` collects the banner. */
function fakeProvider(network: string) {
    const lines: string[] = [];
    return {
        provider: {
            network: () => network as ReturnType<import('@ton/blueprint').NetworkProvider['network']>,
            ui: () => ({ write: (m: string) => void lines.push(m) }),
        } as Parameters<typeof resolveSeedTon>[0],
        lines,
    };
}

const SPEC_SEED = toNano(String(params.genesis.genesis_seed_ton));

describe('nominal seed override', () => {
    const saved = process.env.PRIMES_TESTNET_SEED_TON;
    afterEach(() => {
        if (saved === undefined) delete process.env.PRIMES_TESTNET_SEED_TON;
        else process.env.PRIMES_TESTNET_SEED_TON = saved;
    });

    it('returns the CONCEPT §6 seed when the override is absent', () => {
        delete process.env.PRIMES_TESTNET_SEED_TON;
        for (const network of ['mainnet', 'testnet']) {
            const { provider, lines } = fakeProvider(network);
            expect(resolveSeedTon(provider)).toBe(SPEC_SEED);
            // No banner: an un-overridden run must not be noisy, or the loud
            // case stops reading as loud.
            expect(lines).toHaveLength(0);
        }
    });

    it('refuses to override on mainnet', () => {
        process.env.PRIMES_TESTNET_SEED_TON = '10';
        const { provider } = fakeProvider('mainnet');
        expect(() => resolveSeedTon(provider)).toThrow(/only be overridden/i);
    });

    it('refuses to override on any non-testnet network, not just mainnet', () => {
        // `custom` can point at a mainnet endpoint, so allow-listing testnet is
        // the only safe direction; a deny-list of mainnet would let it through.
        process.env.PRIMES_TESTNET_SEED_TON = '10';
        for (const network of ['custom', 'tetra']) {
            const { provider } = fakeProvider(network);
            expect(() => resolveSeedTon(provider)).toThrow(new RegExp(network));
        }
    });

    it('accepts a smaller seed on testnet and shouts about it', () => {
        process.env.PRIMES_TESTNET_SEED_TON = '10';
        const { provider, lines } = fakeProvider('testnet');
        expect(resolveSeedTon(provider)).toBe(toNano('10'));

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
        process.env.PRIMES_TESTNET_SEED_TON = String(params.genesis.genesis_seed_ton + 1);
        const { provider } = fakeProvider('testnet');
        expect(() => resolveSeedTon(provider)).toThrow(/exceeds the specified seed/i);
    });

    it('refuses a zero or negative seed', () => {
        for (const bad of ['0', '-5']) {
            process.env.PRIMES_TESTNET_SEED_TON = bad;
            const { provider } = fakeProvider('testnet');
            expect(() => resolveSeedTon(provider)).toThrow(/must be positive/i);
        }
    });

    it('does not touch the D-100 donation, which is a different number entirely', () => {
        // The confusion this guards against, stated as a test rather than as a
        // comment: an override is an AFFORDABILITY knob on the nominal seed, and
        // the TON that actually moves at genesis is the donation either way. If some
        // future edit routed the donation through `resolveSeedTon`, a testnet
        // rehearsal would donate the override and mainnet the real figure.
        process.env.PRIMES_TESTNET_SEED_TON = '10';
        const { provider } = fakeProvider('testnet');
        expect(resolveSeedTon(provider)).toBe(toNano('10'));
        // Unmoved by the override. D-204 took the donation to 200 TON, which is the
        // nominal seed's figure again (D-154 had it at 132.50, D-100 point 2 at
        // 4.20) — the same number in two fields, and still two fields: the override
        // moves one and not the other.
        expect(params.genesis.genesis_donation_ton).toBe(200);
        expect(resolveSeedTon(provider)).not.toBe(toNano(String(params.genesis.genesis_donation_ton)));
    });

    it('reports the opening floor as materially worse, not proportionally so', () => {
        // The point the banner exists to make. S0 = seed·L/2 + V (D-166) with V fixed at
        // 40 000 PRIMES, so a 20x smaller seed is NOT a 20x smaller floor —
        // it is ~4x. An operator who assumes linearity misreads the deployment.
        process.env.PRIMES_TESTNET_SEED_TON = '10';
        const { provider, lines } = fakeProvider('testnet');
        resolveSeedTon(provider);

        const floors = lines.join('\n').match(/1 TON = ([\d.]+) PRIMES/g);
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
