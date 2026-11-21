// TON PRIMES — the disclosure guard for the LAST NUMBER (GAUNTLET W6).
//
// `AUCTIONABLE_MAX` is the only hard end the game has: the largest `n` any entry point
// will mint or auction. A reviewer reading the app sees a number line with no visible
// ceiling, and either misses it or finds it in the contract and reports it as
// undisclosed — which is the finding this item came from.
//
// So the figure is stated in `docs/audit/known-limitations.md` §1 and rendered on
// `/verify`, and this spec is what stops those going stale: the doc's figure is compared
// against the contract's own constant, so raising or lowering the cap without saying so
// fails the build. CLAUDE.md rule 3 in its documentation form — a number a reader is
// shown is read from its source, never retyped.
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
const CONTRACT = join(REPO, 'contracts', 'contracts', 'primes_market.tolk');
const DOC = join(REPO, 'docs', 'audit', 'known-limitations.md');

describe('W6 — the number line ends, and the documents say so', () => {
    /** `const AUCTIONABLE_MAX: int = 42949672959999;` — the one definition. */
    const fromContract = (): bigint => {
        const src = readFileSync(CONTRACT, 'utf8');
        const m = src.match(/^const AUCTIONABLE_MAX:\s*int\s*=\s*(\d+)\s*;/m);
        expect(m).not.toBeNull();
        return BigInt(m![1]);
    };

    it('is 10^4 * 2^32 - 1, which is what makes Miller-Rabin overflow-safe here', () => {
        // Not a second copy of the constant: the identity it was DERIVED from. `n` is a
        // uint64-shaped value under 2^46, so `modpow`'s squared residue stays under 2^92
        // — four orders inside int257. A cap changed without re-deriving this breaks the
        // reason the cap exists, so the property is asserted rather than the digits.
        const cap = fromContract();
        expect(cap).toBe(10_000n * 2n ** 32n - 1n);
        expect(cap ** 2n).toBeLessThan(2n ** 92n);
    });

    it('known-limitations.md quotes the contract, not a hand-typed number', () => {
        const doc = readFileSync(DOC, 'utf8');
        const m = doc.match(/AUCTIONABLE_MAX = (\d+)/);
        expect(m).not.toBeNull();
        expect(BigInt(m![1])).toBe(fromContract());
    });

    it('CONCEPT.md §3.2 still derives omega(n) <= 12 from a bound the cap supports', () => {
        // 37# fits under the cap and 41# does not — the whole of why omega is 12 and not
        // 13. Stated as arithmetic so a cap change that invalidates it is caught here
        // rather than in a prose review.
        const primorial = (upTo: number): bigint => {
            let acc = 1n;
            for (let p = 2; p <= upTo; p++) {
                if (Array.from({ length: p - 2 }, (_, i) => i + 2).every((d) => p % d !== 0)) acc *= BigInt(p);
            }
            return acc;
        };
        const cap = fromContract();
        expect(primorial(37)).toBeLessThanOrEqual(cap); // omega = 12 is reachable
        expect(primorial(41)).toBeGreaterThan(cap);     // omega = 13 is not
    });
});
