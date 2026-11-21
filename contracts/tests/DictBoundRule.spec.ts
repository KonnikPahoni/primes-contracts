// TON PRIMES — THE DICTIONARY BOUND RULE (`DECISIONS.md` D-188, `GAUNTLET.md` V26.5).
//
// Config 43 caps a basechain account's code+data at 65,536 cells, and past it every
// transaction that grows storage fails its action phase and rolls back. D-188's rule:
//
//     "a dictionary on a shared contract either has a bound written next to it,
//      or it is not there."
//
// V26 found five maps that had neither, each reaching the cap at 20-30k players. This is
// the `webapp/src/components/MintArtwork/orbRule.test.ts` mechanism transposed onto
// contract storage: a rule worth writing down is worth failing the build over, and a
// written exception is an ALLOW-LIST, not a comment.
//
// WHAT COUNTS AS STORAGE. Every contract persists exactly one `struct Storage`
// (`Storage.fromCell(contract.getData())`). The scan follows the type graph out of it —
// every struct a field names, through `Cell<…>` and a map's value type, into the files the
// contract imports — so a map in a nested cell (`Aux2`, `VaultConfigB`, `DiscoveryBook`,
// `MarketCounters`, …) is found, and a message body's `factors: map<uint8, FactorEntry>`
// or a get-method argument is not, because nothing persisted names it. A `cell` field
// whose comment says it holds a `map<` is a dictionary by another name and counts too.
//
// WHAT A BOUND IS. A comment containing `BOUND:` on the field's own line or in the
// unbroken `//` block directly above it, saying what stops the map growing and roughly
// where the cap would be reached.
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'contracts');

/**
 * ONE ACCOUNT FOR THE WHOLE GAME — the rule applies. A new contract fails the
 * classification test below until it is put on one of these two lists on purpose.
 */
const SHARED = [
    'primes_bounty_vault.tolk',
    'primes_collection.tolk',
    'primes_jetton_master.tolk',
    'primes_ledger.tolk',
    'primes_lp_sink.tolk',
    'primes_market.tolk',
    'primes_ratchet.tolk',
    'primes_registrar.tolk',
    'primes_stake.tolk',
    'primes_treasury.tolk',
    'primes_venue_timelock.tolk',
    'primes_vesting.tolk',
    'primes_voucher.tolk',
];

/**
 * ONE ACCOUNT PER PLAYER OR PER NUMBER — out of scope, each named with its reason. Their
 * storage is sized by one entity, which is the whole point of D-188 point 4 and D-191:
 * per-number and per-wallet state was MOVED onto these so the shared contracts stop
 * growing with the player count.
 */
const PER_ENTITY: Record<string, string> = {
    'primes_item.tolk': 'one NFT per minted number (§3.2.1 — owed and the dividend bookmark live here)',
    'primes_jetton_wallet.tolk': 'one TEP-74 wallet per PRIMES holder',
    'primes_minter_card.tolk': 'one card per minting wallet (D-191 point 1)',
    'primes_claim_receipt.tolk': 'one receipt per (voucher, claimant) (D-191 point 2)',
    'primes_lot_block.tolk': "one account per 256-number block an auction touched beyond the ledger's import frontier; two fixed words, no map (D-196)",
    'primes_lp_position.tolk': "one account per LP owner; its maps grow only with that owner's own paid deposits and votes",
    'primes_stake_position.tolk': "one account per staker; its map grows only with that staker's own paid stakes",
};

/**
 * THE ALLOW-LIST — a shared-contract map with NO honest bound, each an OPEN DEFECT filed
 * in GAUNTLET.md. An entry here is a debt, not an exemption: the second test fails if a
 * listed map gains a `BOUND:` note or disappears, so the entry has to be deleted when the
 * defect is fixed.
 */
// Empty since V26.8 (D-193): the last entry, the vault's per-beneficiary
// `DiscoveryBook.owed`, moved onto the constellation item as `discoveryOwed`.
const OPEN_DEFECTS: string[] = [];

type Field = { file: string; struct: string; name: string; type: string; isMap: boolean; bounded: boolean };

/** Every `struct` in a file: its fields, whether each is a map, and whether it carries a bound note. */
function structsOf(file: string): Map<string, Field[]> {
    const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split(/\r?\n/);
    const out = new Map<string, Field[]>();
    for (let i = 0; i < lines.length; i++) {
        const head = lines[i].match(/^struct\s*(?:\([^)]*\)\s*)?(\w+)\s*\{/);
        if (!head) continue;
        const fields: Field[] = [];
        for (i++; i < lines.length && !/^\}/.test(lines[i]); i++) {
            const f = lines[i].match(/^\s+(\w+)\s*:\s*([^/]+?)\s*(\/\/.*)?$/);
            if (!f) continue;
            let note = f[3] ?? '';
            for (let j = i - 1; j >= 0 && /^\s*\/\//.test(lines[j]); j--) note += lines[j];
            const isMap = f[2].includes('map<') || (/^cell\b/.test(f[2]) && (f[3] ?? '').includes('map<'));
            fields.push({ file, struct: head[1], name: f[1], type: f[2], isMap, bounded: /\bBOUND(\s*\([^)]*\))?:/.test(note) });
        }
        out.set(head[1], fields);
    }
    return out;
}

/** Every map field reachable from the contract's persisted `struct Storage`. */
function storageMaps(file: string): Field[] {
    const imports = [...fs.readFileSync(path.join(SRC, file), 'utf8').matchAll(/^import "(\w+)"/gm)]
        .map((m) => `${m[1]}.tolk`)
        .filter((f) => fs.existsSync(path.join(SRC, f)));
    const structs = new Map<string, Field[]>();
    for (const f of [...imports, file]) for (const [k, v] of structsOf(f)) structs.set(k, v);
    expect(structs.has('Storage')).toBe(true);
    const seen = new Set<string>();
    const maps: Field[] = [];
    const visit = (name: string) => {
        if (seen.has(name) || !structs.has(name)) return;
        seen.add(name);
        for (const fld of structs.get(name)!) {
            if (fld.isMap) maps.push(fld);
            // every identifier in the declared type: `Cell<Aux2>`, `map<uint64, Lot>`, `EraSeason`
            for (const id of fld.type.match(/\w+/g) ?? []) visit(id);
        }
    };
    visit('Storage');
    return maps;
}

const tag = (m: Field) => `${m.file} :: ${m.struct}.${m.name}`;
const allMaps = () => SHARED.flatMap(storageMaps);

describe('dictionary bound rule (D-188)', () => {
    it('classifies every contract as shared or per-entity', () => {
        const contracts = fs.readdirSync(SRC).filter((f) => /^primes_\w+\.tolk$/.test(f));
        expect(contracts.sort()).toEqual([...SHARED, ...Object.keys(PER_ENTITY)].sort());
    });

    it('finds the storage maps it is meant to guard (the scan is not vacuous)', () => {
        const tags = allMaps().map(tag);
        // one from Storage itself, then one per nested-cell route: `Cell<…>` fields, a
        // map's value struct (`Lot` -> `LotPayload`), and a `cell` holding a map
        for (const t of [
            'primes_market.tolk :: Storage.lots',
            'primes_ledger.tolk :: Aux2.unroutedItems',
            'primes_bounty_vault.tolk :: VaultConfigB.retryJournal',
            'primes_treasury.tolk :: Gov.proposals',
            'primes_market.tolk :: LotPayload.factors',
        ]) expect(tags).toContain(t);
        // the same `factors: map<uint8, FactorEntry>` in a message body is not storage
        expect(tags.filter((t) => t.endsWith('.factors'))).toEqual(['primes_market.tolk :: LotPayload.factors']);
    });

    it('every map on a shared contract carries a BOUND: note, or is a filed open defect', () => {
        const unbounded = allMaps().filter((m) => !m.bounded).map(tag);
        expect(unbounded.sort()).toEqual([...OPEN_DEFECTS].sort());
    });
});
