// TON PRIMES — §3.2's factor dictionary, pinned to ONE definition.
//
// A composite mints for 1 GRAM only if the minter submits its factorization, and
// `primes_ledger.tolk` parses that as `map<uint8, FactorEntry>` with
// `{ primeNumber: uint256, exponent: uint8, s: uint128 }`, checking the submitted
// `s = ⌊√p⌋` with two multiplies (`s² ≤ p < (s+1)²`, error 201) so it never has to
// compute a square root.
//
// Two programs build that dictionary: this test/deploy harness and the WEBAPP that
// puts it in the body the player signs. They each kept a private, byte-identical
// transcription — the webapp's even labelled "mirrors contracts/wrappers/
// PrimesLedger.ts" — which is exactly the arrangement `InviteCrossCheck.spec.ts`
// exists to forbid on the invite line, and for a sharper reason here: every
// `pnpm test:contracts` proof about a factorization ran against the WRAPPER's
// bytes while every real 1 GRAM mint spends through the WEBAPP's. A drifted field
// width ships green and reverts a player's mint.
//
// Both now import `shared/factors.ts`, and this file makes that binding
// LOAD-BEARING rather than incidental. Same shape as `InviteCrossCheck.spec.ts`:
// a static identity check, a no-second-transcription scan, an assertion against
// the Tolk struct itself, and golden cell hashes — plus one sandbox mint, because
// unlike the invite line the live half has no separate suite that would notice.
import * as fs from 'fs';
import * as path from 'path';
import { beginCell, Dictionary, toNano } from '@ton/core';
import '@ton/test-utils';
import { encodeFactors, isqrt, FactorValue, type FactorEntry } from '../wrappers/PrimesLedger';
import * as sharedFactors from '../../shared/factors';
import { compileAll, deployStack, factorize, Stack } from './helpers/stack';

const LEDGER_SRC = path.join(__dirname, '..', 'contracts', 'primes_ledger.tolk');
const MESSAGES_TS = path.join(__dirname, '..', '..', 'webapp', 'src', 'chain', 'messages.ts');

/** `beginCell().storeDict(...)` — the shape the mint body carries the dict in. */
const cellOf = (f: FactorEntry[]) => beginCell().storeDict(encodeFactors(f)).endCell();
const hashOf = (f: FactorEntry[]) => cellOf(f).hash().toString('hex');

/**
 * A line that serializes 256 + 8 + 128 bits in one chain IS the factor value
 * layout, whatever it calls its variables. This is the pattern that must not
 * reappear anywhere but `shared/factors.ts`.
 */
const TRANSCRIPTION = /storeUint\([^)]*,\s*256\)\s*\.storeUint\([^)]*,\s*8\)\s*\.storeUint\([^)]*,\s*128\)/;

const isCodeLine = (line: string) => {
    const t = line.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
};

describe('TON PRIMES — the factor dictionary has exactly one definition', () => {
    it('the wrapper RE-EXPORTS shared/factors.ts — it does not keep a copy', () => {
        // Identity, not equality: a second transcription that happened to agree
        // today would still pass a behavioural test and drift tomorrow.
        expect(encodeFactors).toBe(sharedFactors.encodeFactors);
        expect(isqrt).toBe(sharedFactors.isqrt);
        expect(FactorValue).toBe(sharedFactors.FactorValue);
    });

    it('the WEBAPP imports the same module — its mint body is the one players sign', () => {
        const src = fs.readFileSync(MESSAGES_TS, 'utf-8');
        expect(src).toMatch(/from\s+"@ton-primes\/shared\/factors"/);
        expect(src.split('\n').filter(isCodeLine).filter((l) => TRANSCRIPTION.test(l))).toEqual([]);
        // ...and it still re-exports the names the rest of the webapp imports
        // from `@/chain/messages` (routes/Lot, chain/useMint, scripts/testnet-smoke).
        expect(src).toMatch(/export\s*\{[^}]*encodeFactors[^}]*\}/);
        expect(src).toMatch(/export\s*\{[^}]*FactorEntry[^}]*\}/);
    });

    it('no second transcription exists anywhere under contracts/', () => {
        const roots = ['wrappers', 'tests', 'scripts'].map((d) => path.join(__dirname, '..', d));
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.ts') && p !== __filename) files.push(p);
            }
        };
        roots.forEach(walk);

        const offenders = files.filter((f) =>
            fs
                .readFileSync(f, 'utf-8')
                .split('\n')
                .filter(isCodeLine)
                .some((l) => TRANSCRIPTION.test(l) || /DictionaryValue<\s*FactorEntry\s*>/.test(l))
        );
        expect(offenders.map((f) => path.relative(path.join(__dirname, '..'), f))).toEqual([]);
    });

    it('matches the FactorEntry struct primes_ledger.tolk actually parses', () => {
        const src = fs.readFileSync(LEDGER_SRC, 'utf-8');

        // Field ORDER and field WIDTHS. This is the assertion that fails if `s`
        // is widened, a field is inserted, or the exponent stops being a byte.
        const body = src.match(/struct\s+FactorEntry\s*\{([\s\S]*?)\n\}/);
        expect(body).not.toBeNull();
        const fields = body![1]
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('//'));
        expect(fields).toEqual(['primeNumber: uint256', 'exponent: uint8', 's: uint128']);

        // ...and the KEY width, which is what makes `Dictionary.Keys.Uint(8)` right.
        expect(src).toMatch(/factors:\s*map<uint8,\s*FactorEntry>/);

        // The two multiplies the submitted `s` is checked with — the reason the
        // field is on the wire at all, and the reason a wrong `s` must survive
        // the codec verbatim rather than being silently corrected.
        expect(src).toMatch(/f\.s\s*\*\s*f\.s\s*<=\s*f\.primeNumber/);
        expect(src).toMatch(/f\.primeNumber\s*<\s*\(f\.s\s*\+\s*1\)\s*\*\s*\(f\.s\s*\+\s*1\)/);
    });

    it('builds the frozen bytes — golden cell hashes across the shapes that matter', () => {
        // Measured against the two copies this file replaced (verbatim from HEAD
        // before the merge); all nine agreed to the hash. If only the TypeScript
        // moves, these are what catch it; if the Tolk moves, the struct assertion
        // above names the field.
        expect(hashOf([])).toBe('90aec8965afabb16ebc3cb9b408ebae71b618d78788bc80d09843593cac98da4');
        expect(hashOf([{ prime: 2n, exponent: 2 }])).toBe(
            '7c8bc76bdd7f8738df6ac1a04f5cadaf2a5ac399329031a6b96668db045072c6'
        );
        expect(hashOf(factorize(360n))).toBe('0b9b0b555aa8d7e95dab4e332732b6aefe2feedac5814609ce1706d78b5a7711');
        expect(hashOf([{ prime: 1_000_003n, exponent: 5 }])).toBe(
            '138d8045c3219cc9befe202895e84ff138c7aa3d399d34e3d8e9b837c762f49e'
        );
        // omega = 8, CONCEPT §3.2's ceiling — eight keys, insertion order 0..7.
        expect(hashOf([2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n].map((p, i) => ({ prime: p, exponent: i + 1 })))).toBe(
            'cc3446adfc99eb51f8deb8d13bcdf23fb56e650cc777b14cf08ca84cf3df1b77'
        );
        // Field-width canaries: a prime that fills 128 bits with an exponent that
        // fills its byte, and one that fills 256.
        expect(hashOf([{ prime: (1n << 128n) - 159n, exponent: 255 }])).toBe(
            '419a79ebe8c7e18d45f797e45b7301744ade99f7a9c4b85978f0bf58955254fc'
        );
        expect(hashOf([{ prime: (1n << 256n) - 189n, exponent: 1 }])).toBe(
            '165f4e73963d0bfe57cd5088ec982bd7e166b87211d4413bdee61ded70a348f4'
        );
    });

    it('passes an explicit s through UNTOUCHED, right or wrong', () => {
        // The contract's refusal of a wrong `s` is a tested behaviour (error 201),
        // so the codec must never "correct" a caller. Wrong and right differ.
        expect(hashOf([{ prime: 97n, exponent: 1, s: 1n }])).toBe(
            '91fbdefae4764a6a41dec4466fbffadabd4a6030d9c7a9312a95492bd951cd4e'
        );
        expect(hashOf([{ prime: 97n, exponent: 1, s: 9n }])).toBe(
            'd67e693b0af692430856280a2db0f17c6bf58b13c5cbe75a47111d1bc9ab3b91'
        );
        // ...and omitting it is the same as passing the true floor root.
        expect(hashOf([{ prime: 97n, exponent: 1 }])).toBe(hashOf([{ prime: 97n, exponent: 1, s: isqrt(97n) }]));

        const decoded = beginCell()
            .storeDict(encodeFactors([{ prime: 97n, exponent: 1, s: 1n }]))
            .endCell()
            .beginParse()
            .loadDict(Dictionary.Keys.Uint(8), FactorValue);
        expect(decoded.get(0)).toEqual({ prime: 97n, exponent: 1, s: 1n });
    });

    it('isqrt is the floor square root everywhere the wire can reach', () => {
        const probes: bigint[] = [0n, 1n, 2n, 3n, 4n];
        // Perfect squares and their neighbours at every power-of-two scale, up to
        // the 256-bit ceiling the `primeNumber` field imposes.
        for (let k = 1n; k <= 128n; k++) probes.push(1n << k, (1n << k) - 1n, (1n << k) + 1n, (1n << k) ** 2n);
        probes.push((1n << 128n) - 1n, ((1n << 128n) - 1n) ** 2n, (1n << 256n) - 1n);
        for (const v of probes) {
            const r = isqrt(v);
            expect(r * r <= v).toBe(true);
            expect(v < (r + 1n) * (r + 1n)).toBe(true);
        }
        expect(isqrt(0n)).toBe(0n);
        expect(isqrt(1n)).toBe(1n);
        expect(isqrt(2n)).toBe(1n);
        expect(isqrt(((1n << 128n) - 1n) ** 2n)).toBe((1n << 128n) - 1n);
    });
});

describe('TON PRIMES — the shared encoder mints on chain', () => {
    let s: Stack;

    beforeAll(async () => {
        await compileAll();
    });

    beforeEach(async () => {
        s = await deployStack();
    });

    it('a composite minted with shared/factors.ts bytes is ACCEPTED', async () => {
        // 4 = 2², the first composite, at the head for 1 GRAM. The dictionary in
        // this body is built by the exact function the webapp calls.
        const r = await s.ledger.sendMint(s.alice.getSender(), {
            n: 4n,
            kind: 0,
            factors: factorize(4n),
            referralKey: 0,
            beneficiary: null,
            value: toNano('1'),
        });
        expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
        expect(await s.ledger.getHead()).toBeGreaterThan(4n);
    });

    it('...and the same encoder carrying a WRONG s is refused with 201', async () => {
        // Proves the codec is transparent on the leg that matters: the contract,
        // not the encoder, is what rejects a bad root.
        const r = await s.ledger.sendMint(s.alice.getSender(), {
            n: 4n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 2, s: 2n }], // ⌊√2⌋ is 1, not 2
            referralKey: 0,
            beneficiary: null,
            value: toNano('1'),
        });
        expect(r.transactions).toHaveTransaction({ to: s.ledger.address, exitCode: 201 });
        expect(await s.ledger.getHead()).toBe(4n);
    });

    it('...and an s that is too LOW (p >= (s+1)²) is refused with 201 too', async () => {
        // The case above fails `s² ≤ p`; this one passes it and fails the upper
        // bound `p < (s+1)²` alone: 10 = 2·5 with s = 1 for 5 (1 ≤ 5, but 4 ≤ 5).
        for (const n of [4n, 6n, 8n, 9n]) {
            const r = await s.mint(s.alice, n, 0, factorize(n));
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
        }
        expect(await s.ledger.getHead()).toBe(10n);
        const bad = await s.ledger.sendMint(s.alice.getSender(), {
            n: 10n,
            kind: 0,
            factors: [{ prime: 2n, exponent: 1, s: 1n }, { prime: 5n, exponent: 1, s: 1n }], // ⌊√5⌋ is 2
            referralKey: 0,
            beneficiary: null,
            value: toNano('1'),
        });
        expect(bad.transactions).toHaveTransaction({ to: s.ledger.address, success: false, exitCode: 201 });
        expect(await s.ledger.getHead()).toBe(10n);
        // the control: the same mint with the right root lands
        const good = await s.mint(s.alice, 10n, 0, factorize(10n));
        expect(good.transactions).not.toHaveTransaction({ aborted: true });
        expect(await s.ledger.getHead()).toBeGreaterThan(10n);
    });
});
