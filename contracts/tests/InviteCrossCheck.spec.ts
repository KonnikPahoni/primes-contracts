// TON PRIMES — §4.1's invite line, pinned to ONE definition (DECISIONS.md D-202).
//
// The ledger writes the invite comment itself (`inviteComment(n)` in
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
    });

    it('the two owner-set terms match the contract literals', () => {
        const max = src.match(/^const\s+INVITE_MAX_COUNT\s*:\s*int\s*=\s*(\d+)\s*;/m);
        const value = src.match(/^const\s+INVITE_TRANSFER_VALUE\s*:\s*coins\s*=\s*(\d+)\s*;/m);
        expect(max).not.toBeNull();
        expect(value).not.toBeNull();
        expect(Number(max![1])).toBe(sharedInvites.INVITE_MAX_COUNT);
        expect(BigInt(value![1])).toBe(sharedInvites.INVITE_TRANSFER_VALUE_NANOTON);
        // `inviteCount: uint3` is the field the max is checked against; 3 fits, 4..7 are refused (221).
        expect(/inviteCount:\s*uint3/.test(src)).toBe(true);
    });

    it('the comment text is the words, then the Tolk literals around n, byte for byte (D-211)', () => {
        const body = src.match(/fun\s+inviteComment\(n:\s*int,\s*words:\s*cell\):\s*cell\s*\{([\s\S]*?)\n\}/);
        expect(body).not.toBeNull();
        const literals = [...body![1].matchAll(/"([^"]*)"\.literalSlice\(\)/g)].map((m) => m[1]);
        expect(literals).toEqual([sharedInvites.INVITE_COMMENT_PREFIX, sharedInvites.INVITE_COMMENT_SUFFIX]);
        // op 0 first: a plain text comment.
        expect(/\.storeUint\(0,\s*32\)/.test(body![1])).toBe(true);
        expect(sharedInvites.inviteCommentText(1234n, 'Hi.')).toBe('Hi. primes.live/?ref=1234_tg');
        const cap = src.match(/^const\s+INVITE_TEXT_MAX_BYTES\s*=\s*(\d+)\s*;/m);
        expect(Number(cap![1])).toBe(sharedInvites.INVITE_TEXT_MAX_BYTES);
        // The cap leaves room for 16 digits of n in one 1023-bit cell.
        expect(32 + 8 * (sharedInvites.INVITE_TEXT_MAX_BYTES + sharedInvites.INVITE_COMMENT_PREFIX.length + 16 + sharedInvites.INVITE_COMMENT_SUFFIX.length)).toBeLessThanOrEqual(1023);
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
