// TON PRIMES — §4.1's invite line, pinned to ONE definition (DECISIONS.md D-202, D-215).
//
// The ledger writes the invite comment itself (`inviteComment` in
// `primes_ledger.tolk`) and `shared/invites.ts` restates it for the app and the
// keeper (`inviteCommentText`). If the two disagree nothing crashes: the app shows
// a sentence the chain never sends. This is a static cross-check in the shape of
// `SimCrossCheck.spec.ts`'s contract-literal assertions — no sandbox, ~1s. The live
// half (the bytes a real mint emits) is `InviteTransfers.spec.ts`.
import * as fs from 'fs';
import * as path from 'path';
import * as wrapper from '../wrappers/PrimesLedger';
import * as sharedInvites from '../../shared/invites';

const LEDGER_SRC = path.join(__dirname, '..', 'contracts', 'primes_ledger.tolk');

describe('TON PRIMES — the invite line has exactly one definition (D-202)', () => {
    const src = fs.readFileSync(LEDGER_SRC, 'utf-8');

    it('the wrapper RE-EXPORTS shared/invites.ts — it does not keep a copy', () => {
        expect(wrapper.inviteListCell).toBe(sharedInvites.inviteListCell);
        expect(wrapper.inviteAddressDict).toBe(sharedInvites.inviteAddressDict);
        expect(wrapper.inviteCommentText).toBe(sharedInvites.inviteCommentText);
        expect(wrapper.inviteCommentCell).toBe(sharedInvites.inviteCommentCell);
        expect(wrapper.setInviteTermsBody).toBe(sharedInvites.setInviteTermsBody);
    });

    it('the three fixed bounds match the contract literals (D-215)', () => {
        const lit = (name: string, type: string) => src.match(new RegExp(`^const\\s+${name}\\s*:\\s*${type}\\s*=\\s*(\\d+)\\s*;`, 'm'));
        const ceiling = lit('INVITE_COUNT_CEILING', 'int');
        const cap = lit('INVITE_LINE_CAP', 'coins');
        const fee = lit('INVITE_SEND_FEE', 'coins');
        expect(Number(ceiling![1])).toBe(sharedInvites.INVITE_COUNT_CEILING);
        expect(BigInt(cap![1])).toBe(sharedInvites.INVITE_LINE_CAP_NANOTON);
        expect(BigInt(fee![1])).toBe(sharedInvites.INVITE_SEND_FEE_NANOTON);
        // `inviteCount: uint7` holds the ceiling (100); the live count is checked against it (221).
        expect(/inviteCount:\s*uint7/.test(src)).toBe(true);
        expect(sharedInvites.INVITE_COUNT_CEILING).toBeLessThan(128);
        // The genesis terms the wrapper deploys pass the ledger's own bound check (238).
        expect(sharedInvites.inviteTermsValid(sharedInvites.INVITE_GENESIS_COUNT, sharedInvites.INVITE_GENESIS_VALUE_NANOTON)).toBe(true);
    });

    it('the comment text is the words alone, byte for byte: op 0, the words, no link (D-211, D-215)', () => {
        const body = src.match(/fun\s+inviteComment\(words:\s*cell\):\s*cell\s*\{([\s\S]*?)\n\}/);
        expect(body).not.toBeNull();
        // No literal text of the ledger's own: nothing is appended to the operator's words.
        expect([...body![1].matchAll(/"([^"]*)"\.literalSlice\(\)/g)]).toEqual([]);
        // op 0 first: a plain text comment.
        expect(/\.storeUint\(0,\s*32\)/.test(body![1])).toBe(true);
        expect(sharedInvites.inviteCommentText('Hi.')).toBe('Hi.');
        const cap = src.match(/^const\s+INVITE_TEXT_MAX_BYTES\s*=\s*(\d+)\s*;/m);
        expect(Number(cap![1])).toBe(sharedInvites.INVITE_TEXT_MAX_BYTES);
        // op + the capped words fit one 1023-bit cell.
        expect(32 + 8 * sharedInvites.INVITE_TEXT_MAX_BYTES).toBeLessThanOrEqual(1023);
        expect(Buffer.byteLength(sharedInvites.INVITE_TEXT_GENESIS)).toBeLessThanOrEqual(sharedInvites.INVITE_TEXT_MAX_BYTES);
    });

    // The words live on chain (D-211) and in shared/invites.ts; no wrapper or script keeps a copy.
    it('no second transcription of the comment exists in contracts/wrappers or contracts/scripts', () => {
        const roots = ['wrappers', 'scripts'].map((d) => path.join(__dirname, '..', d));
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.ts') && p !== __filename) files.push(p);
            }
        };
        roots.forEach(walk);
        const offenders = files.filter((f) => /own a number forever|primes\.live\/\?ref=/.test(fs.readFileSync(f, 'utf-8')));
        expect(offenders.map((f) => path.relative(path.join(__dirname, '..'), f))).toEqual([]);
    });
});
