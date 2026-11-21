// TON PRIMES — THE OPCODE REGISTRY RULE. `shared/opcodes.ts` opens with the
// claim this file enforces:
//
//     "Every inbound/outbound message opcode used anywhere in the system is
//      declared here, exactly once, and nowhere else."
//
// CLAUDE.md repeats it ("opcodes and error codes in `shared/opcodes.ts`. Add to
// those rather than inlining constants"). It was false for a long time and
// nothing said so: 23 of the 24 wrapper files kept a private
// `export const *Opcodes = { Name: 0x…, … }` table, 155 hex literals for values
// the registry already held, and the copies had begun to drift — `RatchetOpcodes`
// had lost `transfer_notification` and `dedust_burn`, and eight registry exports
// had no importer at all because the wrapper that should have consumed each one
// used its own transcription instead.
//
// A wire value written twice is the same class of bug as an invented economic
// parameter (CLAUDE.md rule 3): one of the two copies is eventually wrong, and
// the one that ships is whichever the message builder happened to read. This is
// the `webapp/src/components/MintArtwork/orbRule.test.ts` mechanism transposed
// onto the wire — a rule that is worth writing down is worth failing the build
// over, and a written exception is an ALLOW-LIST, not a comment.
//
// Two scans, because either alone leaks:
//   1. a table of literals, which is how all 155 got here; and
//   2. a bare literal written straight into a message body, which is how the
//      FIRST one would come back — someone adding a `send*` method in a hurry.
//
// Deliberately narrow. An "opcode" here is a 32-bit-shaped hex value (7-8 digits)
// sitting in an `*Opcodes` table, stored with `storeUint(…, 32)`, or declared as
// a SCREAMING_SNAKE module constant (the `forward_payload` domain separators).
// Gas amounts, addresses, bit masks, the TEP-64 `0x01` content tag and
// `BigInt('0x' + hash)` are all outside it on purpose: a guard that cries wolf
// gets deleted, and then it guards nothing.
import * as fs from 'fs';
import * as path from 'path';
/** The registry as a VALUE, reflected the same way `txAudit.ts` reflects it — this
 *  test is about what a value-keyed decoder built from it sees. */
import * as REGISTRY_NS from '../../shared/opcodes';

const WRAPPER_DIR = path.join(__dirname, '..', 'wrappers');
const REGISTRY = path.join(__dirname, '..', '..', 'shared', 'opcodes.ts');

/** 32-bit-shaped: 7 or 8 hex digits. `0xf8a7ea5` (TEP-74 transfer) is seven. */
const OPCODE = '0x[0-9a-fA-F]{7,8}';

/**
 * Comments are stripped first. Several wrappers name RETIRED values in prose
 * ("0xb0000022 (MarkUnreserved) is DELETED with D-45"), and those paragraphs are
 * provenance — the registry's own tombstones say to keep them. Only code counts.
 */
const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** `File.ts :: Label = 0x…` — the form every allow-list entry and every offence takes. */
function offences(): string[] {
    const found: string[] = [];
    for (const file of fs.readdirSync(WRAPPER_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.compile.ts'))) {
        const src = stripComments(fs.readFileSync(path.join(WRAPPER_DIR, file), 'utf8'));
        // 1. a literal inside an `*Opcodes` table
        for (const table of src.matchAll(/const \w*Opcodes\s*=\s*\{([\s\S]*?)\r?\n\}/g)) {
            for (const e of table[1].matchAll(new RegExp(`(\\w+)\\s*:\\s*(${OPCODE})`, 'g'))) {
                found.push(`${file} :: ${e[1]} = ${e[2].toLowerCase()}`);
            }
        }
        // 2. a literal written straight into a message body
        for (const e of src.matchAll(new RegExp(`storeUint\\(\\s*(${OPCODE})\\s*,\\s*32\\s*\\)`, 'g'))) {
            found.push(`${file} :: storeUint(…, 32) = ${e[1].toLowerCase()}`);
        }
        // 3. a literal as a module constant — the `forward_payload` domain separators
        //    (`STAKE_ACTION_LOCK`, `TREASURY_ACTION_DEPOSIT`, …),
        //    which are wire values by any other name and all live in the registry.
        for (const e of src.matchAll(new RegExp(`^export const ([A-Z][A-Z0-9_]*)\\s*=\\s*(${OPCODE})\\s*;`, 'gm'))) {
            found.push(`${file} :: ${e[1]} = ${e[2].toLowerCase()}`);
        }
    }
    return found.sort();
}

/**
 * THE ALLOW-LIST — six values, named one at a time with the reason.
 *
 * Named INDIVIDUALLY and not as a `Mock*` file exemption, and the difference is
 * the whole point: a file-level pass would let a real protocol opcode be added
 * to a mock wrapper later and sail through. These six are admitted; a seventh
 * value in any of those files is not.
 */
const ALLOWED = [
    // --- sandbox-only harness controls -------------------------------------
    // `mock_dedust_vault.tolk`, `mock_dedust_deposit_vault.tolk` and
    // `mock_tonstakers_pool.tolk` exist only under `@ton/sandbox` and are never
    // deployed to testnet or mainnet. These nine are the knobs the harness turns
    // on them — set a price, go silent, set an LP rate, set a staking rate, set
    // the pool's free-TON buffer, set leg 2's DeDust depth, settle an outstanding
    // payout bill, switch optimistic deposits, settle a deposit bill. (`SetDedustTon` is separate from `SetBuffer` because the case
    // §4.3.2's exit machine exists for is "the pool cannot fill now but the DEX
    // can", which one shared buffer cannot express.) No deployed
    // contract sends one, no `shared/schemas/*.tlb` declares one, and nothing
    // outside the mock's own wrapper reads one. They stay local BECAUSE the
    // registry is the protocol's wire surface: putting a test double's controls
    // in it would make that claim false.
    //
    // (They sit on 0x92, which is the BURN SINK's high byte. Harmless — the two
    // families never share an account — but do not read the prefix as an
    // allocation. Every high byte in 0x90..0x9c is taken, so the two knobs audit H2
    // added stay inside the mock pool's own 0x9200003x run; add none outside it.)
    'MockDedustVault.ts :: SetPrice = 0x92000010',
    'MockDedustVault.ts :: SetSilent = 0x92000011',
    'MockDedustDepositVault.ts :: SetLpRate = 0x92000020',
    'MockTonstakersPool.ts :: SetRate = 0x92000030',
    'MockTonstakersPool.ts :: SetBuffer = 0x92000031',
    'MockTonstakersPool.ts :: SettleBill = 0x92000032',
    'MockTonstakersPool.ts :: SetDedustTon = 0x92000033',
    // Audit H2 (2026-11-19): the pool's `optimistic_deposit` switch and the round
    // end that pays a non-optimistic deposit's bill. Kept in the mock pool's own
    // 0x9200003x run rather than opening another prefix.
    'MockTonstakersPool.ts :: SetOptimistic = 0x92000034',
    'MockTonstakersPool.ts :: SettleDepositBill = 0x92000035',
    // `deposit_liquidity#d55e4686` WAS the one real external opcode exempted
    // here, on the premise that nothing in this repo ever sends one. The webapp's
    // provide-liquidity form ended that: `shared/messages.ts` builds the body a
    // player signs, so the value is `DEDUST.deposit_native` in the registry and
    // `MockDedustDepositVault.ts` reads it from there like every other wrapper.
    // The entry is DELETED rather than kept as a pardon — which is the second
    // assertion below working as designed.
].sort();

describe('opcode registry rule', () => {
    /**
     * The scan. An exact equality rather than a subset check, in both
     * directions on purpose: a NEW literal fails because it is not on the list,
     * and a STALE entry fails because the literal it names is gone. The list
     * cannot rot into a blanket pardon.
     */
    it('declares every wrapper opcode in shared/opcodes.ts, and nowhere else', () => {
        const found = offences();
        const surprises = found.filter((f) => !ALLOWED.includes(f));
        if (surprises.length) {
            throw new Error(
                `Hardcoded opcode literal in contracts/wrappers/:\n` +
                    surprises.map((s) => `  ${s}`).join('\n') +
                    `\n\nDo not write a wire value twice. Declare it in \`shared/opcodes.ts\` under the\n` +
                    `namespace of the contract that owns it, then import that namespace — exactly as\n` +
                    `\`contracts/wrappers/PrimesVesting.ts\` does:\n\n` +
                    `    import { VESTING } from '../../shared/opcodes';\n` +
                    `    export const VestingOpcodes = {\n` +
                    `        SetWallet: VESTING.set_wallet,\n` +
                    `        Release: VESTING.release,\n` +
                    `        JettonTransfer: VESTING.jetton_transfer,\n` +
                    `    };\n\n` +
                    `If the value genuinely does not belong in the registry — a sandbox-only mock\n` +
                    `control, or an external opcode no contract here sends — add it to ALLOWED in\n` +
                    `this file BY VALUE, with the reason, the way the six entries there are.\n` +
                    `A file-level exemption is not available: that would let a real protocol\n` +
                    `opcode into a mock wrapper unnoticed.`
            );
        }
        expect(found).toEqual(ALLOWED);
    });

    /**
     * Each allow-list entry asserted to still be what it claims — the orb rule's
     * "an entry that quietly rounded itself back into an orb is on the wrong
     * list". If one of these is ever added to the registry, the exemption's
     * premise is gone and the wrapper should read it from there instead. That is
     * not hypothetical: it is how `deposit_liquidity#d55e4686` left this list
     * when the webapp's provide-liquidity form started sending it.
     */
    it('keeps the allow-listed values out of the registry', () => {
        const registry = stripComments(fs.readFileSync(REGISTRY, 'utf8'));
        for (const entry of ALLOWED) {
            const value = entry.slice(entry.lastIndexOf('0x'));
            expect(registry.includes(value)).toBe(false);
        }
    });

    /**
     * The positive half. The two scans above are satisfied by a wrapper that
     * declares no opcode at all, so on their own they would pass a file that had
     * quietly stopped building message bodies. This pins the other side: every
     * wrapper reads the registry, and the ONE that does not is named.
     */
    it('has every wrapper reading the registry, bar the one with no wire value of its own', () => {
        const silent = fs
            .readdirSync(WRAPPER_DIR)
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.compile.ts'))
            // G61: a wrapper whose every body now comes from `shared/messages.ts` reads the
            // registry through it (that file imports `shared/opcodes`), which counts.
            .filter((f) => !/from '\.\.\/\.\.\/shared\/(opcodes|messages)'/.test(fs.readFileSync(path.join(WRAPPER_DIR, f), 'utf8')));
        // EVERY wrapper now reads the registry. The DeDust DEPOSIT mock was the one
        // exception, on the strength of both its opcodes being allow-listed (one
        // external, one harness control); `deposit_liquidity` is protocol now that the
        // webapp sends it, so that wrapper imports `DEDUST` like the rest and the
        // exception is gone rather than grandfathered.
        expect(silent.sort()).toEqual([]);
    });

    /**
     * GAUNTLET.md X15 — THE OTHER WAY A WIRE VALUE GETS WRITTEN TWICE, and the one
     * every scan above is blind to: not the same value copied out of the registry
     * into a wrapper, but the same value handed to two DIFFERENT contracts inside
     * the registry itself.
     *
     * It had happened and nothing said so. `STAKE.set_wallet` and
     * `VOUCHER.claim_voucher` were both `0x91000001`, `STAKE.unstake` and
     * `VOUCHER.burn_signer` both `0x91000002`, and the two blocks' headers each
     * claimed the high byte `0x91` was free. Harmless on chain — an opcode space is
     * per-contract and those two never exchange messages — but this file's opening
     * claim is that a value is declared "exactly once", and a value-keyed decoder
     * built from the registry (`contracts/scripts/testnet/txAudit.ts`) cannot honour
     * a numbering scheme the registry does not keep.
     *
     * The allow-list is the SAME MESSAGE under two vocabularies, which is a real and
     * useful thing for this file to hold: a sender and a receiver naming one opcode,
     * or a TEP standard a contract re-exports under its own name. What it must never
     * cover is two unrelated messages, which is what this test exists to refuse.
     */
    const SHARED_VALUES: Record<string, string> = {
        '0x5138d91':
            "TEP-62 `ownership_assigned`. The ratchet receives it as `payout_ownership_assigned` — one message, " +
            'the standard vocabulary and the local one.',
        '0xf8a7ea5':
            'TEP-74 `transfer`. Four contracts hold PRIMES or LP and re-export the standard under their own name; ' +
            'all four send the identical body.',
        '0x595f07bc':
            'TEP-74 `burn`. The ratchet burns swap proceeds and tsTON-leg PRIMES under two local names — one ' +
            'standard op (the burn sink that was a third caller is deleted by D-212).',
        '0xb0000004':
            "The ledger's `claim_tribute` and the item's `claim_tribute_relay`: the item forwards the message it " +
            'was handed, unchanged, so it is one message on two hops.',
        '0xe0000034':
            "The ledger's `launch_open_market` is the market's `launch_open` — the sender's name and the " +
            "receiver's name for §6 point 0's ignition.",
    };

    it('gives no value to two unrelated messages (X15)', () => {
        // Reflected out of the registry, the same way `txAudit.ts` builds its decoder —
        // so this test sees exactly what that decoder sees.
        const OPCODES = REGISTRY_NS as Record<string, unknown>;
        const claims = new Map<number, string[]>();
        const add = (op: unknown, qualified: string) => {
            if (typeof op !== 'number' || !Number.isInteger(op) || op < 0x01000000 || op > 0xffffffff) return;
            claims.set(op, [...(claims.get(op) ?? []), qualified]);
        };
        for (const [ns, val] of Object.entries(OPCODES)) {
            if (typeof val === 'number') add(val, ns);
            else if (val && typeof val === 'object')
                for (const [k, v] of Object.entries(val as Record<string, unknown>)) add(v, `${ns}.${k}`);
        }

        const unexplained: string[] = [];
        for (const [op, names] of claims) {
            // Claimants that agree on the LOCAL name are one message by construction —
            // `LEDGER.pool_inject` and `RATCHET.pool_inject` need no entry.
            const locals = new Set(names.map((n) => n.slice(n.indexOf('.') + 1)));
            if (names.length < 2 || locals.size < 2) continue;
            const key = '0x' + op.toString(16);
            if (SHARED_VALUES[key]) continue;
            unexplained.push(`${key} :: ${[...names].sort().join(' | ')}`);
        }
        if (unexplained.length > 0) {
            const NL = String.fromCharCode(10);
            throw new Error(
                `A wire value is claimed by two contracts under two different names:` +
                    NL + NL +
                    unexplained.map((u) => `    ${u}`).join(NL) +
                    NL + NL +
                    `If they are ONE message (a sender and a receiver, or a TEP standard` +
                    ` re-exported under a local name) add the value to SHARED_VALUES in this` +
                    ` file with that reason. If they are two UNRELATED messages, one of them` +
                    ` must move to a free high byte -- see GAUNTLET.md X15, where the voucher` +
                    ` program moved off the staking sink's 0x91. 0x9b-0x9f are free as of` +
                    ` 2026-09-20.`
            );
        }
        expect(unexplained).toEqual([]);
    });

    /** The allow-list's own upkeep, the same shape the ALLOWED check above has: an entry
     *  whose value stopped being shared is an entry nobody will notice is stale. */
    it('keeps every SHARED_VALUES entry genuinely shared', () => {
        const OPCODES = REGISTRY_NS as Record<string, unknown>;
        for (const key of Object.keys(SHARED_VALUES)) {
            const value = Number(key);
            let claimants = 0;
            for (const val of Object.values(OPCODES)) {
                if (typeof val === 'number' && val === value) claimants++;
                else if (val && typeof val === 'object')
                    for (const v of Object.values(val as Record<string, unknown>)) if (v === value) claimants++;
            }
            // Jest's `expect` takes no message argument (that is vitest); the key is in
            // the loop and a failure names the file, so the assertion carries its own
            // context in the value instead.
            expect(`${key} claimed ${claimants > 1 ? 'more than once' : `${claimants}x`}`).toBe(
                `${key} claimed more than once`,
            );
        }
    });
});
