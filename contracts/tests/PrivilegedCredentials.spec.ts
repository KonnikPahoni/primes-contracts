// TON PRIMES — the disclosure guard for `docs/audit/privileged-credentials.md`
// (GAUNTLET W5). CONCEPT.md §8's "no admin withdraw path" is true and narrow: it is
// a claim about moving TON, and a reviewer who reads it as "no privileged keys at
// all" has been told less than the whole truth. That page lists the three standing
// credentials that do exist. THIS spec is what stops it going stale — a fourth
// credential added to a contract and not disclosed fails here rather than being
// found by an auditor.
//
// Lexical, in the same spirit as `sender-gates.mjs` and for the same reason: it
// cannot prove an address compared against is the RIGHT one, only that the SET of
// privileged credentials is countable and that every member of it is disclosed.
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..');
const CONTRACTS_DIR = join(REPO, 'contracts', 'contracts');
const DOC = join(REPO, 'docs', 'audit', 'privileged-credentials.md');

/**
 * A sender comparison naming one of these is a PEER gate, not a credential: the
 * address is another protocol contract, fixed or derived at deploy, itself bound by
 * these same rules, and its own outbound sends are enumerated in
 * `withdraw-surface.md`. Anything compared against that is NOT in this list is a
 * standing credential and must be disclosed.
 *
 * `genesisScriptAddr` is here for a different reason and the doc says so: it is a
 * bootstrap credential that is SPENT — every arm gated on it is one-shot behind a
 * published flag and refuses a replay with 104.
 */
const PEER_OR_SPENT = [
    // Deploy-fixed peer contracts.
    'ledgerAddr', 'registrarAddr', 'ratchetAddr', 'collectionAddr', 'marketAddr',
    // D-191 point 2: a claim receipt's parent voucher, fixed in its init data (= its address).
    'voucherAddr',
    'treasuryAddr', 'stakeAddr', 'minerAddr', 'sinkAddr', 'vaultAddr', 'itemAddr',
    'jettonMasterAddr', 'jettonMaster', 'jettonWalletAddr', 'lpJettonWalletAddr',
    'generatorsCollectionAddr', 'venueTimelockAddr', 'dedustNativeVault',
    'primesJettonWallet', 'lpJettonWallet',
    // D-151 §4.3.2's SECOND jetton wallet, on the ratchet and on the treasury.
    // Same class as `jettonWalletAddr` above and not a new credential: both are
    // one-shot bootstraps from the genesis script, both are published by a
    // get-method, and the address they hold is this contract's OWN wallet at the
    // tsTON master — an address nobody can hold and no message can re-aim.
    'tstonWalletAddr', 'tstonJettonWallet',
    // D-193: the discovery-bounty relay's two ends — the vault's constellations
    // collection (deploy data) and the collection's vault (one-shot `SetRegistrar`).
    'conCollectionAddr', 'bountyVaultAddr',
    // §4.3.2 leg 1's `withdrawal` sender (2026-09-26). A venue contract, same class
    // as `dedustNativeVault`: ratchet deploy data that no message rewrites (D-194),
    // and the pool is code nobody holds a key to.
    'tonstakersPool',
    // §4.3.2 leg 2's payout sender (2026-11-08 audit): the tsTON pool's own native
    // vault, ratchet deploy data in the same cell as `tonstakersPool`.
    'dedustTstonNativeVault',
    // D-194: the venue timelock's second key is the governed TREASURY contract,
    // fixed in the timelock's init data. A peer, not a holder: it sends
    // `confirm_venue` only on a passed LP vote.
    'governanceAddr',
    // The spent bootstrap credential. Every arm gated on it is one-shot behind a
    // published flag; `privileged-credentials.md` names it rather than omitting it.
    'genesisScriptAddr',
    // DERIVED addresses: the sender must be the exact child contract this contract's
    // own arithmetic computes for the record in hand, so the caller cannot name
    // anyone else's. `sender-gates.md` calls this "sender IS the key"; it is not a
    // weaker gate and it is not a credential — nobody HOLDS it.
    'siblingWalletAddress', 'positionAddress', 'receiptAddress', 'inputItemAddress', 'expected',
    // D-191 point 1: the wallet's minter card, derived from (card code, ledger, owner).
    'cardAddress',
    // D-196: a block's lot block, derived from (lot block code, ledger, block).
    'lotBlockAddress',
    // D-193: the constellation item at the claimed target, derived by its collection.
    'itemAddressOf',
    // The NFT arms, same shape: the record's own owner.
    'owner',
];

const sources = readdirSync(CONTRACTS_DIR)
    .filter((f) => f.endsWith('.tolk'))
    .map((f) => ({ file: f, text: readFileSync(join(CONTRACTS_DIR, f), 'utf8') }));

/** Split an argument list on its TOP-LEVEL commas only. */
function splitTopLevel(args: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of args) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** Strip `//` line comments so a credential named only in prose is not counted. */
const code = (text: string) =>
    text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

describe('W5 — every privileged credential is disclosed', () => {
    it('finds exactly the address credentials the doc names', () => {
        const found = new Set<string>();
        for (const { file, text } of sources) {
            // `[\w.()]` so a `storage.cfg.load().ledgerAddr` chain resolves to its
            // LAST segment rather than stopping at `load`.
            for (const m of code(text).matchAll(/senderAddress\s*==\s*([A-Za-z_][\w.]*(?:\(\))?(?:\.[\w]+)*)/g)) {
                const name = m[1].replace(/\(\)/g, '').split('.').pop()!;
                if (PEER_OR_SPENT.includes(name)) continue;
                found.add(`${file}:${name}`);
            }
        }
        // The venue proposer and (D-211) the operator's invite-words setter, nothing else.
        // A new entry here is a new standing admin credential: disclose it in
        // privileged-credentials.md, then add it.
        expect([...found].sort()).toEqual(['primes_ledger.tolk:operatorAddr', 'primes_venue_timelock.tolk:proposerAddr']);
    });

    it('finds exactly the signing keys the doc names', () => {
        const keys = new Set<string>();
        for (const { file, text } of sources) {
            // `isSignatureValid(hash, sig, KEY)` — the credential is the third
            // argument, and the first two contain nested calls and commas of their
            // own, so the argument list is walked with a paren counter rather than
            // matched with a regex that would stop at the first inner `)`.
            const src = code(text);
            for (const m of src.matchAll(/isSignatureValid\(/g)) {
                let depth = 1;
                let i = m.index! + m[0].length;
                const start = i;
                for (; i < src.length && depth > 0; i++) {
                    if (src[i] === '(') depth++;
                    else if (src[i] === ')') depth--;
                }
                const args = splitTopLevel(src.slice(start, i - 1));
                expect(args).toHaveLength(3);
                keys.add(`${file}:${args[2].replace(/\(\)/g, '').split('.').pop()}`);
            }
        }
        expect([...keys].sort()).toEqual(['primes_voucher.tolk:signerPubkey']);
    });

    /**
     * GAUNTLET X5. The three credentials above are what exists TODAY. Who controls the money
     * in year three is a different question with a different answer — the treasury's
     * governance — and its liveness properties lived only in a source comment.
     *
     * These are the load-bearing facts, and a page that stopped saying any of them would be
     * describing a safer system than the one deployed. Read off `primes_treasury.tolk`'s own
     * header rather than paraphrased: no quorum, who the electorate is, and the bound that
     * makes a thin electorate survivable at all.
     */
    it('X5: the page states the governance rule that decides who controls the money', () => {
        const doc = readFileSync(DOC, 'utf8');
        for (const needle of [
            // The rule itself, in the contract's own words.
            'NO QUORUM',
            // Who may vote, and the multiplier that makes the operator the stated defence.
            '30 days and above',
            // The consequence D-100 point 10 accepts in writing.
            'a single 30-day locker passes',
            // The three defences, each of which is a published number.
            'PROPOSAL_CAP_BPS', 'PROPOSE_MIN_BPS', 'getGov()',
            // ...and the bound that makes a thin electorate a BOUNDED risk. Without this the
            // section would read as a warning rather than as a disclosure.
            '`k`, `K_CEIL` or the five-way',
            'Treasury.spec.ts',
        ]) {
            expect(doc).toContain(needle);
        }
    });

    it('the disclosure page names each one, its get-method and its bounding spec', () => {
        const doc = readFileSync(DOC, 'utf8');
        for (const needle of [
            // the credentials themselves
            'proposerAddr', 'signerPubkey', 'operatorAddr',
            // where the chain publishes each — §9.1 applies to a credential too
            'getQueued()', 'getSignerState()', 'getInviteText()',
            // what bounds each in test
            'PrimesVenueTimelock.spec.ts', 'PrimesVoucher.spec.ts', 'InviteTransfers.spec.ts',
            // and the spent bootstrap class, named rather than omitted
            'genesisScriptAddr',
        ]) {
            expect(doc).toContain(needle);
        }
    });
});
