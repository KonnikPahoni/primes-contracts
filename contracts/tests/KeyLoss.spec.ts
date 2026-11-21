// TON PRIMES — the blast-radius disclosure guard (GAUNTLET W6/X6).
//
// `privileged-credentials.md` is the inventory; `key-loss.md` is the failure half — what
// stops working the day each credential is lost, and whether it can be replaced without a
// genesis redeploy. Track X's owner answer (2) put rotation ceremonies out of scope, which
// makes the written blast radius the whole deliverable, and a deliverable that is prose is
// a deliverable that goes stale silently.
//
// So this pins the three things a reader is actually entitled to: that every credential is
// named, that each carries a degrade-or-halt verdict, and that the ones which CANNOT be
// rotated say so in those words. A page that quietly dropped the last of those would be
// describing a more recoverable system than the one deployed, which is the same class of
// lie as an undisclosed credential.
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
const DOC = join(REPO, 'docs', 'audit', 'key-loss.md');
const doc = () => readFileSync(DOC, 'utf8');

describe('X6 — what breaks when a key is lost is written down', () => {
    it('names every credential the inventory names, plus the operator wallet', () => {
        const d = doc();
        for (const credential of [
            // The two standing credentials `privileged-credentials.md` enumerates.
            'proposerAddr',
            'signerPubkey',
            // ...and the fourth thing the item named, which is NOT in that inventory because
            // it is not a protocol credential at all — it is the wallet the keeper and every
            // deploy script run from.
            'KEEPER_WALLET_MNEMONIC',
        ]) {
            expect(d).toContain(credential);
        }
    });

    it('gives each one a DEGRADES-or-HALTS verdict, not just a description', () => {
        // The question a holder asks is not "what is this key for", it is "is the game still
        // playable tomorrow". Every section has to answer it.
        const d = doc();
        expect(d).toContain('degrades or halts');
        expect((d.match(/degrades/gi) ?? []).length).toBeGreaterThanOrEqual(4);
    });

    it('says IN THOSE WORDS where a credential cannot be replaced without a redeploy', () => {
        // The item's own instruction, and the load-bearing one: "note plainly where the
        // honest answer is 'this cannot be replaced without a redeploy', because that is the
        // fact a ten-year holder is entitled to."
        const d = doc();
        expect(d).toContain('Replaceable without a redeploy: NO');
        // The proposer is unrotatable (the voucher signer is "not applicable in v1"; D-202
        // deleted the invite signer); the operator wallet is the one that is replaceable, and
        // it must be distinguishable rather than lumped in with it.
        expect((d.match(/without a redeploy: NO/g) ?? []).length).toBeGreaterThanOrEqual(1);
        expect(d).toContain('move TON to a new wallet');
    });

    it('records the coupling between the gas wallet and the venue proposer', () => {
        // The finding this page exists to surface rather than repeat: `PRIMES_PROPOSER_ADDR`
        // must be a subwallet of `KEEPER_WALLET_MNEMONIC` (`genesisPrep.ts` checks it, and
        // two genesis runs died at the last step when it was not) — so losing the "low
        // stakes" gas wallet also loses the one credential that cannot be replaced.
        const d = doc();
        expect(d).toContain('PRIMES_PROPOSER_ADDR');
        expect(d).toMatch(/subwallet of this same mnemonic/i);
    });

    it('states that a lost key is INDISTINGUISHABLE from an idle one', () => {
        // Part of the blast radius and easy to leave out: there is no surface that reports a
        // credential as lost, and there cannot be. A page that omitted this would imply a
        // monitoring story that does not exist.
        expect(doc()).toMatch(/cannot (tell|distinguish) a lost key from an (idle|unused) one/i);
    });
});
