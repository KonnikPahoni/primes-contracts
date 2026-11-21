/**
 * THE PRE-SEND GUARD IN `contracts/scripts/testnet/lpGovernance.ts`.
 *
 * `withdraw L 0` was run twice at a live node. The second run READ
 * `positions { positionCount: 0, nextId: 1, ... }` — position 0 created, then
 * withdrawn, then gone — printed it, and sent the withdrawal anyway, for one
 * bounced row in the sweep and the gas behind it. The position arms were the
 * only ones with no guard: `vote` and `execute` had already been given one, in
 * 5fab88d6 and f4f1fd13, after the same mistake went RED at each of them.
 *
 * The assertion that matters is the first one. A missing position is a DICT
 * MISS, so `getPosition` answers with an all-zero row rather than an error, and
 * ids are never reused — which makes `id < nextId` true for a position that no
 * longer exists. Anything that tests the id against a counter instead of
 * against the row is the bug coming back.
 */
import { idLine, requirePosition, requireMatured } from '../scripts/testnet/lpGovernance';

/** What `PrimesLpPosition.getPosition` returns for a dict miss. */
const ZERO_ROW = { amount: 0n, tier: 0, lockedAt: 0, expired: 0, inFlight: 0, maturesAt: 0, weightSince: 0 };

const live = (o: Partial<typeof ZERO_ROW> = {}) => ({
    ...ZERO_ROW,
    amount: 1_000_000n,
    tier: 1,
    lockedAt: 1,
    maturesAt: 1,
    ...o,
});

/** The live reading that produced the bug: one id ever issued, none of them live. */
const WITHDRAWN = { positionCount: 0, nextId: 1, voteWeight: 0n };

describe('lpGovernance — the position guard', () => {
    it('refuses the withdrawn position an "id < nextId" test would have accepted', () => {
        expect(0 < WITHDRAWN.nextId).toBe(true); // the wrong predicate, stated outright
        expect(() => requirePosition(WITHDRAWN, 0, ZERO_ROW, 'withdraw')).toThrow(/does not exist/);
    });

    it('names the count-vs-id trap in the refusal', () => {
        expect(idLine(WITHDRAWN)).toContain('ids are never reused');
        expect(idLine({ ...WITHDRAWN, nextId: 0 })).toContain('never held a position');
    });

    it('passes a position that is actually there', () => {
        expect(requirePosition(WITHDRAWN, 0, live(), 'withdraw').amount).toBe(1_000_000n);
    });

    it('refuses a position with an LP move already in flight', () => {
        expect(() => requirePosition(WITHDRAWN, 0, live({ inFlight: 1 }), 'relock')).toThrow(/IN FLIGHT/);
    });

    it('refuses a term that is still running, and passes one that is not', () => {
        const soon = Math.floor(Date.now() / 1000) + 3600;
        expect(() => requireMatured(0, live({ maturesAt: soon }), 'withdraw')).toThrow(/has not matured/);
        expect(() => requireMatured(0, live({ maturesAt: 1 }), 'withdraw')).not.toThrow();
    });
});
