// TON PRIMES — `.owner.json` MUST BE REFUSED WHEN IT IS NOT A WALLET.
//
// 2026-09-21: the owner's file (handle `P`, the one wallet in the harness that
// is not throwaway) was found holding the JSON of a SPREAD STRING —
// `{"0":"p","1":"u","2":"r",…}`, 135 numeric keys, i.e. the 24 words joined and
// then passed through `{...s}`. `readOwner()` trusted the shape and called
// `.join(' ')` on `undefined`, so every testnet script died with
// `Cannot read properties of undefined (reading 'join')`: `walletFor()` in
// `chain.ts` calls `readCast()`, which reads the owner unconditionally, so one
// bad file bricked ALL TWELVE cast handles and named neither the file nor the
// shape.
//
// The guard is one helper, `readOwnerEntry()`, that every read of the file now
// goes through. This spec drives it at a TEMP path — never the repo's real
// `.owner.json`, which holds a live seed phrase the running harness depends on.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readOwnerEntry } from '../scripts/testnet/cast';

const WORDS = Array.from({ length: 24 }, (_, i) => 'word' + i);
const GOOD = { name: 'P', mnemonic: WORDS, address: '0QAtemp', float: '25', why: 'a test fixture' };

describe('readOwnerEntry', () => {
    let dir: string;
    const at = (name: string, body: string) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, body);
        return f;
    };

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'primes-owner-'));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('returns null when the file has never been written', () => {
        expect(readOwnerEntry(path.join(dir, 'absent.json'))).toBeNull();
    });

    it('reads a well-formed owner entry', () => {
        expect(readOwnerEntry(at('good.json', JSON.stringify(GOOD)))).toEqual(GOOD);
    });

    it('refuses the char-indexed object a spread string produces, and says so', () => {
        // What was found in the real file: one string, spread into an object.
        const spread: Record<number, string> = {};
        const joined = WORDS.join(' ');
        for (let i = 0; i < joined.length; i++) spread[i] = joined[i];
        const file = at('spread.json', JSON.stringify(spread, null, 2));
        let msg = '';
        try {
            readOwnerEntry(file);
        } catch (e: any) {
            msg = e?.message ?? '';
        }
        expect(msg).toContain(file); // names the file
        expect(msg).toContain('SPREAD STRING'); // names the shape it got
        expect(msg).toContain('24 words'); // names the shape it wanted
        expect(msg).toContain('cast.ts owner'); // tells the operator what NOT to do
        // And never quotes the content: the real file is a live seed phrase.
        expect(msg).not.toContain('word0');
    });

    it('refuses a file that is not JSON at all', () => {
        expect(() => readOwnerEntry(at('words.txt.json', WORDS.join('\n')))).toThrow(/not valid JSON/);
    });

    it('refuses a truncated mnemonic rather than deriving the wrong wallet', () => {
        const file = at('short.json', JSON.stringify({ ...GOOD, mnemonic: WORDS.slice(0, 23) }));
        expect(() => readOwnerEntry(file)).toThrow(/is not an owner wallet/);
    });

    // ---- `version`, added 2026-09-21 when the owner's wallet became a W5 ----
    //
    // ONE SEED IS SEVERAL ADDRESSES. The owner's own key derives `0QAhPdCL…` under v4R2 and
    // `0QBdbo8l…` under W5R1 on testnet, and BOTH were live accounts when this was written.
    // So a version this file does not understand cannot fall back to v4: the fallback is a
    // real, fundable, WRONG account, and the harness would drive it while the human watched
    // the other one. Absent is the one safe default, because it is what every wallet
    // `cast.ts new` has ever minted.

    it('accepts an absent version — every generated cast wallet is v4R2', () => {
        const file = at('noversion.json', JSON.stringify(GOOD));
        expect(readOwnerEntry(file)?.version).toBeUndefined();
    });

    it('carries a known version through instead of dropping it', () => {
        for (const version of ['v4r2', 'v5r1'] as const) {
            const file = at(`v-${version}.json`, JSON.stringify({ ...GOOD, version }));
            expect(readOwnerEntry(file)?.version).toBe(version);
        }
    });

    it('refuses an unknown version rather than silently deriving a v4 address', () => {
        const file = at('badversion.json', JSON.stringify({ ...GOOD, version: 'v5beta' }));
        expect(() => readOwnerEntry(file)).toThrow(/unknown wallet version/);
    });
});
