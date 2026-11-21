/**
 * THE OPCODE DECODER IN `contracts/scripts/testnet/txAudit.ts`.
 *
 * `opLabel` inverts `shared/opcodes.ts` by reflection — `import * as`, not a
 * hand-kept list — so it decodes opcodes nobody remembered to tell it about.
 * That is the whole point of it and also the only way it can silently rot: the
 * reflection is filtered by a `>= 0x01000000` floor that separates opcodes from
 * the error codes and limit tables sharing that module, and a future opcode
 * below the floor, or a namespace that stops being a plain object, would drop
 * out of the map with nothing failing.
 *
 * So the load-bearing assertion here is the LAST one: every opcode the registry
 * declares decodes to something. The named cases above it pin the collision
 * policy, which is the part with a judgement call in it.
 */
import { opLabel, sinceBound } from '../scripts/testnet/txAudit';
import * as OPCODES from '../../shared/opcodes';
import { LEDGER, RATCHET, TEP62, COLLECTION, ITEM } from '../../shared/opcodes';

describe('txAudit — opcode decoding', () => {
    it('names an opcode declared once', () => {
        expect(opLabel(LEDGER.mint)).toBe('mint 0xb0000002');
        expect(opLabel(COLLECTION.mint_item)).toBe('mint_item 0xc0000001');
    });

    /**
     * The common collision, and not really a collision: `pool_inject` is ONE
     * message, declared by the ledger that sends it and the ratchet that
     * receives it. Two claimants, one local name, so the label is that name.
     */
    it('collapses a message declared at both ends to its single name', () => {
        expect(LEDGER.pool_inject).toBe(RATCHET.pool_inject);
        expect(opLabel(LEDGER.pool_inject)).toBe('pool_inject 0xb0000050');
        // D-212's naming: the collection -> item relay is declared at both ends.
        expect(COLLECTION.item_name).toBe(ITEM.item_name);
        expect(opLabel(COLLECTION.item_name)).toBe('item_name 0xc1000008');
        expect(opLabel(COLLECTION.name_number)).toBe('name_number 0xc0000009');
    });

    /**
     * The other shape: ONE message whose two ends call it different things. TEP-62's
     * `ownership_assigned` is what the ratchet receives as `payout_ownership_assigned`, so
     * which vocabulary a reader wants depends on the receiving account, the script
     * does not know it at this point, and guessing would print a confident wrong
     * name — so both are printed.
     *
     * THIS TEST USED TO PIN A WORSE CASE and it is worth saying why it no longer
     * can: `STAKE.set_wallet` and `VOUCHER.claim_voucher` were both 0x91000001, two
     * genuinely UNRELATED messages sharing a value across two contracts, and this
     * assertion was the only thing in the repo that noticed. GAUNTLET.md X15 moved
     * the voucher to 0x9a, and `OpcodeRegistryRule.spec.ts` now fails the build on
     * that class outright, so the label below is the strongest collision the
     * registry can still produce.
     *
     * The ratchet receives it from a Tonstakers payout bill when §4.3.2's slow exit
     * mints one (D-151); the registrar's `receive_generator` was a third name until
     * D-202 deleted the generators. Two names, still ONE message — and the reason this assertion is an
     * exact string rather than a `toContain` is that a claimant appearing here is
     * supposed to be noticed. If a future name shows up in this list without a
     * decision behind it, that is the collision the test is for.
     */
    it('prints every claimant when a value is known by two names', () => {
        expect(TEP62.ownership_assigned).toBe(RATCHET.payout_ownership_assigned);
        expect(opLabel(TEP62.ownership_assigned)).toBe(
            'TEP62.ownership_assigned|RATCHET.payout_ownership_assigned 0x05138d91',
        );
    });

    /** A standard op reused by four collections is still one message. */
    it('treats a reused TEP-62 op as one message', () => {
        expect(opLabel(TEP62.transfer)).toBe('transfer 0x5fcc3d14');
    });

    it('falls back to bare hex for an op no contract declares', () => {
        expect(opLabel(0xdeadbeef)).toBe('0xdeadbeef');
    });

    it('decodes every opcode the registry declares', () => {
        const undecoded: string[] = [];
        for (const [ns, val] of Object.entries(OPCODES)) {
            if (!val || typeof val !== 'object') continue;
            // Namespaces hold opcodes; the tables that do not (BUILD_LIMITS, the
            // refusal-reason enums) hold small integers and are skipped by the
            // same floor the decoder uses.
            for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
                if (typeof v !== 'number' || v < 0x01000000) continue;
                if (!opLabel(v).includes(k)) undecoded.push(`${ns}.${k}`);
            }
        }
        expect(undecoded).toEqual([]);
    });
});

/**
 * THE SWEEP'S WINDOW. `run.ts` gates each phase on `txAudit.ts` and used to pass
 * a FIXED `--since 6h`, which is not "the window the phase ran in"
 * (`TESTNET_MASTER_PLAN.md` §2): once one phase went red, every later phase
 * re-reported the SAME transactions and failed for them, so a ten-phase run
 * could not return to green until the fixed window rolled past. Wave 5 hit it.
 * The driver now passes an absolute `--since-utime`; these pin that form, and
 * that the relative one a hand-run still uses is unchanged.
 */
describe('txAudit — the sweep window', () => {
    it('takes an absolute lower bound verbatim', () => {
        expect(sinceBound(['--since-utime', '1758400000'])).toBe(1758400000);
    });

    it('still reads the relative form, now including minutes', () => {
        const now = Math.floor(Date.now() / 1000);
        expect(sinceBound(['--since', '5m'])).toBeGreaterThanOrEqual(now - 301);
        expect(sinceBound(['--since', '12h'])).toBeLessThanOrEqual(now - 12 * 3600);
    });

    it('walks everything when neither is given', () => {
        expect(sinceBound(['--no-items'])).toBe(0);
    });

    /** Neither form may WIDEN the other, so the later instant wins. */
    it('takes the narrower window when both are given', () => {
        const now = Math.floor(Date.now() / 1000);
        expect(sinceBound(['--since', '12h', '--since-utime', `${now}`])).toBe(now);
    });

    it('refuses a bound it cannot read', () => {
        expect(() => sinceBound(['--since', '12w'])).toThrow(/--since takes/);
        expect(() => sinceBound(['--since-utime', 'yesterday'])).toThrow(/unix timestamp/);
    });
});
