// TON PRIMES — §8: NO ADMIN WITHDRAW PATH ON ANY TON BALANCE, statically, over
// every contract's outbound message set (GAUNTLET.md C9).
//
// WHY A STATIC PASS, WHEN I5 ALREADY EXISTS
//
// `FuzzInvariants.spec.ts`'s I5 fires every opcode from every privileged sender
// at the ledger and asserts nobody ends up richer. That is a good test, and it
// covers ONE contract out of sixteen. GAUNTLET C2 found exactly that gap. A
// dynamic probe can only cover the arms it thinks to fire on the contracts it
// thinks to point at, and §8's claim is about the whole surface — so widening
// I5 to sixteen contracts would still be a spot check, just a bigger one.
//
// The static complement is exact, because the underlying fact is simple: **TON
// only ever leaves a contract through an outbound message.** So the set of ways
// money can move IS the set of `createMessage` sites, and §8 reduces to a
// property of that finite set. `tools/withdraw-surface.mjs` enumerates it and
// classifies each destination; this spec asserts the shape of the result.
//
// WHAT THIS BUYS THAT A COMMENT DOES NOT. A new send to a destination nobody
// classified fails here rather than being assumed benign, and a new send to an
// OPERATOR address fails here even if it is well-intentioned — the three that
// exist are enumerated by name, so a fourth is a deliberate act that has to
// come with a decision, not a diff nobody noticed.
//
// WHAT IT DOES NOT CLAIM. This is a lexical pass, not a verifier. It does not
// prove a handler is reachable, does not evaluate a `value` expression, and does
// not follow an address through a helper parameter — those are reported as
// `via-helper` and resolved by hand below, which is honest precisely because the
// resolution is written out rather than assumed.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = join(__dirname, '..', '..');
const CONTRACTS_DIR = join(REPO, 'contracts', 'contracts');
const SURFACE_DOC = join(REPO, 'docs', 'audit', 'withdraw-surface.md');

type Row = {
    file: string;
    line: number;
    handler: string;
    dest: string;
    cls: string;
    value: string;
};

/** Parse the generated table back out of the audit doc. */
function readSurface(): Row[] {
    const md = readFileSync(SURFACE_DOC, 'utf8');
    const rows: Row[] = [];
    for (const line of md.split('\n')) {
        const m = line.match(/^\| `([^`]+)` \| (\d+) \| (.*?) \| `(.*?)` \| (\S+) \| `(.*?)` \|$/);
        if (m) {
            rows.push({
                file: m[1],
                line: Number(m[2]),
                handler: m[3],
                dest: m[4].replace(/\\\|/g, '|'),
                cls: m[5],
                value: m[6].replace(/\\\|/g, '|'),
            });
        }
    }
    return rows;
}

describe('TON PRIMES — §8: no admin withdraw path, over the whole outbound surface', () => {
    const rows = readSurface();

    it('the generated surface is current — regenerating it changes nothing', () => {
        // A stale table would let a new send hide behind an old classification,
        // which is the one way this whole approach can silently stop working.
        // Cheap to check and it makes the doc trustworthy rather than merely
        // present. `tools/audit-surface.mjs` is kept honest the same way.
        const before = readFileSync(SURFACE_DOC, 'utf8');
        execFileSync(process.execPath, [join(REPO, 'tools', 'withdraw-surface.mjs')], { cwd: REPO });
        const after = readFileSync(SURFACE_DOC, 'utf8');
        expect(after).toBe(before);
    }, 60_000);

    it('covers every contract that can send TON at all', () => {
        // The enumeration is only a proof of anything if it actually read every
        // contract. Any .tolk with a `createMessage` IN CODE must appear in the
        // table; one that does not is a file the pass skipped.
        //
        // COMMENTS ARE STRIPPED FIRST, and D-100 point 4 is why. The generator
        // matches `createMessage(`; this counter used to match the bare word
        // anywhere in the file, which was the same thing until
        // `primes_lp_sink.tolk` arrived — a contract whose entire safety claim
        // is that it has NO outbound message type, and which says so in a
        // comment that names `createMessage`. Counting that mention made the
        // sink's own proof of harmlessness look like a missing table row. The
        // stricter form is also better in the other direction: a send that has
        // been commented OUT no longer demands a row it can never fill.
        const withSends = readdirSync(CONTRACTS_DIR)
            .filter((f) => f.endsWith('.tolk'))
            .filter((f) =>
                readFileSync(join(CONTRACTS_DIR, f), 'utf8')
                    .split('\n')
                    .some((l) => !l.trim().startsWith('//') && l.includes('createMessage('))
            )
            .sort();
        const inTable = [...new Set(rows.map((r) => r.file))].sort();
        expect(inTable).toEqual(withSends);
        expect(rows.length).toBeGreaterThan(50); // non-vacuous
    });

    it('classifies every destination — an unrecognised one is a finding, not a default', () => {
        const unclassified = rows.filter((r) => r.cls === 'UNCLASSIFIED');
        expect(
            unclassified.map((r) => `${r.file}:${r.line} ${r.dest}`)
        ).toEqual([]);
    });

    // ------------------------------------------------------------------ //
    // The claim itself
    // ------------------------------------------------------------------ //

    it('§8: exactly THREE sends (D-117 moved the ops sweep to the pool) in the entire protocol reach an operator address', () => {
        // Enumerated by name and line-independent. Adding a fifth fails here.
        // D-90.2 removed one — the market's 10% release forfeit — with the
        // release right itself, so the market can no longer send TON to an
        // operator address at all and no longer stores one. D-128 added the two
        // royalty legs below; the test after next is the one that says why they
        // are fees rather than withdrawals.
        //
        // D-152 REMOVED ONE, and this count going DOWN is the point of the
        // decision rather than a side effect: §4.1's 5% line used to be the
        // only operator-destined send that ran on EVERY mint, unconditionally.
        // It now pays `feeDests.treasuryAddr`, which `withdraw-surface.mjs`
        // classifies `peer` because it has no key — so the operator's whole
        // remaining exposure on the mint path is a forfeit remainder that is
        // zero whenever every cited factor has an owner.
        const operator = rows
            .filter((r) => r.cls === 'operator')
            .map((r) => `${r.file} · ${r.handler} · ${r.dest} · ${r.value}`)
            .sort();
        expect(operator).toEqual([
            // §6 point 2 / D-20 point 4: tribute cited to a still-unsold prime.
            // Computed from the mint's own factor list. D-100 point 6 splits it
            // 58/42 (D-166); only the operator's remainder is an operator send — the
            // treasury contract's 80% is a send to a keyless peer, and it is
            // counted in the `peer` class below rather than here. Since D-152
            // this is the ONLY send on the mint path that reaches an operator
            // address, and it fires only when a cited prime has no owner.
            // D-117: the forfeit remainder is paid on the collection's
            // `mint_confirmed`, not in the mint transaction. §4.1's gas-&-ops
            // sweep is NOT here any more: since D-117 (owner, 2026-09-22) it
            // returns the surplus to the ratchet pool, a peer send.
            'primes_ledger.tolk · payHeldSplit · feeDests.operatorAddr · operatorDue', // G81: held + this forfeit
            // D-128's royalty leg. The handler column reads `MintItem` because the
            // generator names the last arm it saw before the site and this lives in
            // the catch-all `else`; the line and the destination are what this test
            // pins, and both are exact. (The generators collection's copy went with D-202.)
            'primes_collection.tolk · MintItem → onInternalMessage · aux.royaltyDest · operatorShare',
        ].sort());
    });

    /**
     * D-128 / GAUNTLET W1 — THE ASSERTION THE DECISION WAS MADE CONDITIONAL ON.
     *
     * The brief said: if "this operator-destined outflow is not a withdraw" cannot be
     * expressed as an assertion, the decision is wrong and goes back to DECISIONS.md.
     * It can, and these are the three properties, each read off the source rather than
     * asserted about it:
     *
     *   1. It is triggered ONLY by an inbound transfer — the leg lives in the arm that
     *      handles an incoming message and there is no other caller.
     *   2. It pays a fixed fraction OF THAT TRANSFER — `operatorShare` is `net` times a
     *      deploy-time-constant bps, and `net` is bounded by what arrived.
     *   3. It CANNOT reach anything already resting on the balance, because the arm
     *      reserves `ROYALTY_STORAGE_FLOOR` before either leg is built.
     *
     * Property 3 is the one that makes it structurally not a withdrawal: a withdraw
     * path is one that can move a resting balance, and the reserve is what forbids it.
     */
    it('§8: D-128 royalty legs are fees, not withdrawals — reserve first, fraction of the inbound only', () => {
        for (const file of ['primes_collection.tolk']) {
            const src = readFileSync(join(CONTRACTS_DIR, file), 'utf8');
            // 3. the floor is reserved BEFORE anything is sent...
            const reserveAt = src.indexOf('reserveToncoinsOnBalance(ROYALTY_STORAGE_FLOOR');
            const operatorLegAt = src.indexOf('dest: aux.royaltyDest');
            expect({ file, hasReserve: reserveAt >= 0 }).toEqual({ file, hasReserve: true });
            expect({ file, reserveFirst: reserveAt < operatorLegAt }).toEqual({ file, reserveFirst: true });
            // 2. ...and what is split is bounded by the balance ABOVE that floor, less
            //    the delivery budget — never the balance itself.
            expect(src).toContain('contract.getOriginalBalance() - ROYALTY_STORAGE_FLOOR');
            expect(src).toContain('val operatorShare: coins = net * (BPS_DEN - ROYALTY_RATCHET_BPS) / BPS_DEN;');
            // 1. and there is exactly ONE site that can pay the operator at all.
            expect(src.split('dest: aux.royaltyDest').length - 1).toBe(1);
        }
    });

    it('§8: not one of those three takes its amount from the caller', () => {
        // This is what "no withdraw path" means once the destinations are
        // pinned: an operator line that pays a FORMULA is a fee; one that pays
        // an amount the caller names is a withdrawal. Every value expression
        // below is a constant, a term derived from the mint under way, or a
        // balance-minus-liability residual — never `in.valueCoins` and never a
        // free field of an operator-sendable message.
        const CALLER_CHOSEN = ['in.valueCoins', 'valueCoins', 'msg.amount', 'amount'];
        for (const r of rows.filter((x) => x.cls === 'operator')) {
            expect({ site: `${r.file}:${r.line}`, callerChosen: CALLER_CHOSEN.includes(r.value) }).toEqual({
                site: `${r.file}:${r.line}`,
                callerChosen: false,
            });
        }
    });

    it('§8: the sweep pays only the surplus ABOVE declared liability, to the ratchet pool, and is permissionless', () => {
        // The sweep is the one operator line whose amount is not bounded by a
        // constant, so it gets its own read. Two properties make it a fee rather
        // than a withdrawal, and both are visible in the source: the amount is
        // `balance - liability - SWEEP_GAS`, so it cannot touch a nanoton the
        // contract has declared it owes; and the handler has no sender gate, so
        // it is not an operator capability at all — anyone may trigger it, and
        // the money goes where it was always going to go.
        const src = readFileSync(join(CONTRACTS_DIR, 'primes_ledger.tolk'), 'utf8');
        const start = src.indexOf('fun handleSweepOps');
        expect(start).toBeGreaterThan(0);
        const body = src.slice(start, src.indexOf('\n}', start));
        expect(body).toContain('balance - liability - SWEEP_GAS');
        // D-117 (owner, 2026-09-22): and it pays the POOL, not a wallet — the same
        // `forwardToRatchet` a mint's injection takes, with `T` credited alongside.
        expect(body).toContain('forwardToRatchet(');
        expect(body).toContain('storage.T += sweepable');
        expect(body).not.toMatch(/opsAddr/);
        // No `wrong_sender` assert anywhere in the handler: permissionless by
        // construction, which `FeeLines.spec.ts` also proves dynamically.
        expect(body).not.toMatch(/throw 100/);
    });

    it('§8: the market knows no operator address at all (D-90.2)', () => {
        // The release forfeit used to be the one operator value that arrived in
        // a message rather than being computed in place, and the sender gate on
        // `ShardReleaseDone` was what made it safe. D-90.2 deletes the release,
        // and `treasuryAddr` goes with it — a stronger statement than the gate:
        // there is no expression on this contract that names a treasury at all,
        // so no future handler can accidentally pay one.
        const src = readFileSync(join(CONTRACTS_DIR, 'primes_market.tolk'), 'utf8');
        const code = src
            .split('\n')
            .filter((l) => !l.trim().startsWith('//'))
            .join('\n');
        expect(code).not.toMatch(/treasuryAddr/);
    });

    it('§8: no contract sends to an address a privileged role supplies', () => {
        // The general form, and the one that catches a class rather than a case.
        // Every destination in the table is one of: a peer contract, a derived
        // child address, the counterparty of the message being handled, a
        // deploy, the venue, one of the three operator lines above, or the one
        // `governed` line D-100 point 8 adds. None is a field of an inbound
        // message naming a payee — because that field is what a withdraw path
        // looks like.
        //
        // WHY `governed` IS ON THIS LIST AND IS STILL NOT A WITHDRAW PATH, since
        // it is the one class whose destination genuinely is an arbitrary
        // address. The test's name is precise: *a privileged role supplies*. The
        // treasury's `Execute` send names `prop.dest`, and `prop.dest` was
        // written into storage by a `Propose` from an LP position child, held
        // open for a 1-day vote of the ≥ 30-day tiers, and released only once
        // `yes > no` — then pushed by a permissionless `Execute` anybody may
        // send. `primes_treasury.tolk` has no owner field, no admin opcode, no
        // upgrade and no pause (D-100 point 7), so there is no privileged role
        // to be the supplier. That is a different shape from a withdraw path,
        // not a softer version of one, and the next test pins the difference
        // rather than leaving it to this comment.
        const ALLOWED = new Set(['peer', 'player', 'operator', 'deploy', 'venue', 'via-helper', 'governed']);
        for (const r of rows) {
            expect({ site: `${r.file}:${r.line}`, cls: r.cls, allowed: ALLOWED.has(r.cls) }).toEqual({
                site: `${r.file}:${r.line}`,
                cls: r.cls,
                allowed: true,
            });
        }
        // and no destination is a raw payee field smuggled in through a message.
        const PAYEE_FIELDS = ['msg.dest', 'msg.payee', 'msg.recipient', 'msg.withdrawTo'];
        for (const r of rows) expect(PAYEE_FIELDS).not.toContain(r.dest);
    });

    it('§8: the governed sends are a voted destination, not a role-supplied one (D-100 point 8, D-194)', () => {
        // The distinction §8 must be readable next to. A withdraw path is an
        // address a privileged role names; this is an address a VOTE named. The
        // three facts that make it the second thing are all checkable in source,
        // so they are checked here rather than asserted in prose:
        //
        //   1. there are exactly two such sends, both on the treasury's `Execute`:
        //      the value-moving payout, and D-194's venue confirm (value 0, mode 64 —
        //      it forwards only what the executor attached, and moves nothing);
        //   2. the treasury has no owner, no admin opcode and no pause — there
        //      is no privileged role on the contract to be the supplier; and
        //   3. `prop.dest` is only reachable after the vote closed in favour,
        //      and `Execute` is permissionless, so the executor is not the
        //      author of the destination either.
        const governed = rows
            .filter((r) => r.cls === 'governed')
            .map((r) => `${r.file} · ${r.handler} · ${r.dest}`);
        expect(governed).toEqual([
            'primes_treasury.tolk · Execute → onInternalMessage · prop.dest',
            'primes_treasury.tolk · Execute → onInternalMessage · prop.dest',
        ]);

        const treasury = readFileSync(join(CONTRACTS_DIR, 'primes_treasury.tolk'), 'utf8');
        const code = treasury
            .split('\n')
            .filter((l) => !l.trim().startsWith('//'))
            .join('\n');
        // No owner, no admin, no pause, no upgrade — the same shape of negative
        // assertion the market's `treasuryAddr` test uses above, and stronger
        // than a sender gate because there is nothing to gate.
        expect(code).not.toMatch(/ownerAddr|adminAddr|SetCode|setCode|paused/);

        // The guard chain on the arm that emits it. Each of these is a separate
        // `assert` in `Execute`, and dropping any one of them turns the send
        // into something this class no longer describes.
        const arm = treasury.slice(treasury.indexOf('Execute =>'));
        const body = arm.slice(0, arm.indexOf('prop.dest'));
        expect(body).toContain('prop.yes > prop.no');      // the vote passed
        expect(body).toContain('prop.executed == 0');      // once only
        expect(body).toMatch(/blockchain\.now\(\) >= prop\.closes/); // after close
        // D-194: the FIRST `prop.dest` is the venue confirm, and it moves no value.
        const venue = body.slice(body.indexOf('prop.asset == ASSET_VENUE'));
        expect(venue).toContain('value: 0,');
        const payout = arm.slice(0, arm.indexOf('prop.dest', arm.indexOf('prop.dest') + 1));
        expect(payout).toContain('PROPOSAL_CAP_BPS');      // ≤ 25% of the asset
        // and `Execute` itself has no sender gate: anybody may push a passed
        // proposal, which is what makes the executor not a privileged role.
        expect(arm.slice(0, arm.indexOf('prop.dest'))).not.toMatch(/throw 100/);
    });

    it('resolves the one helper-parameter treasury destination to storage, not to a caller', () => {
        // `primes_lp_position.tolk`'s `forwardToTreasury(treasuryAddr, body)` is
        // a helper parameter, so the lexical pass classified it by NAME (`peer`)
        // rather than by following it. That is only safe while every caller
        // passes the deploy-fixed field, so the caller list is asserted instead
        // of assumed — the same treatment the `via-helper` sites get below, kept
        // here because the parameter's name is specific enough to classify.
        //
        // `storage.treasuryAddr` is written into the init data that DECIDES this
        // contract's own address, so it is not settable after deploy at all: a
        // different treasury address is a different child contract.
        const pos = readFileSync(join(CONTRACTS_DIR, 'primes_lp_position.tolk'), 'utf8');
        const callers = [...pos.matchAll(/(?<!fun )forwardToTreasury\(([^,]+),/g)].map((m) => m[1].trim());
        expect(callers.length).toBeGreaterThan(0);
        expect([...new Set(callers)]).toEqual(['storage.treasuryAddr']);
    });

    it('resolves the two via-helper sites by hand, to player addresses only', () => {
        // The lexical pass cannot follow `dest` through a helper parameter, so
        // it reports them rather than guessing. Resolved here by reading the
        // call sites — and asserted, so a new caller passing an operator address
        // into one of these helpers fails.
        //
        // THREE until D-106. The third was the item's `forward_to_owner`, whose
        // `dest` was a local assigned twice — the owner, or, for an UNCLAIMED
        // number used as a referral key, the Patron who paid for it. Patron mode
        // is deleted, no item is ever ownerless, and the send now names
        // `m.owner` inline: classified `player` by the generator instead of
        // needing a hand resolution at all. The absence is asserted at the foot
        // of this test.
        const viaHelper = rows.filter((r) => r.cls === 'via-helper');
        // D-196 adds the ledger's `replyMarkRejected`, asserted at the foot of this test.
        expect(viaHelper.length).toBe(3);

        const market = readFileSync(join(CONTRACTS_DIR, 'primes_market.tolk'), 'utf8');
        // The negative lookbehind skips the helper's own declaration.
        const marketCallers = [...market.matchAll(/(?<!fun )\bsendRefund\(([^,]+),/g)].map((m) => m[1].trim());
        // GAUNTLET V9: both settle-bounce arms (`MintWonLot`'s
        // composite case and the previously-unhandled `SettlePrimeClearing`
        // case) now read the winner off the lot record the same way
        // `MarkRejected` already did — `val rec = look.loadValue();` then
        // `rec.highBidder` — rather than the composite arm's old inline
        // `look.loadValue().highBidder`. Three `rec.highBidder` sites now:
        // `MarkRejected`, and the two settle-bounce arms. `in.senderAddress` is a
        // Dutch buyer's own change (the margin over the clock's price, audit Low).
        expect(marketCallers.sort()).toEqual([
            'in.senderAddress',
            'prevBidder',
            'rec.highBidder',
            'rec.highBidder',
            'rec.highBidder',
        ]);

        const ledger = readFileSync(join(CONTRACTS_DIR, 'primes_ledger.tolk'), 'utf8');
        const ledgerCallers = [...ledger.matchAll(/(?<!fun )\brefund\(([^,]+),/g)].map((m) => m[1].trim());
        // D-109: `handleCardMint`'s overpayment refund names the PAYER, a player
        // address (D-191 point 1: the minter card attaches it, authenticated by the
        // card's derived address). The lost-race refund no longer goes through this
        // helper: it is a carry-all `card_mint_refunded` to the payer's own card,
        // which passes it on. Never an operator/treasury/ops destination.
        expect(ledgerCallers.sort()).toEqual(['msg.owner', 'payer']);

        // The item's forward carries no value of its own (`value: 0` plus
        // CARRY_ALL_REMAINING_MESSAGE_VALUE — it forwards what arrived), and it
        // goes to exactly one destination: the item's OWNER, a player.
        //
        // D-106 REMOVED THE SECOND ONE. There used to be a `dest` local assigned
        // twice — the owner, or, for an UNCLAIMED number used as a referral key,
        // the Patron who paid for it. With patron mode deleted no item is ever
        // ownerless, so the branch is gone and `dest` is not a local any more.
        // Assert the absence, which is the stronger property: no assignable
        // destination at all means no destination that could be made non-player.
        const item = readFileSync(join(CONTRACTS_DIR, 'primes_item.tolk'), 'utf8');
        const arm = item.slice(item.indexOf('ForwardToOwner =>'));
        const body = arm.slice(0, arm.indexOf('.send('));
        expect([...body.matchAll(/\bdest = ([^;]+);/g)]).toEqual([]);
        expect(body).toMatch(/dest:\s*m\.owner,/);

        // D-196: the ledger's `mark_rejected` reply goes to the MARKET and nowhere
        // else — the authenticated sender of `mark_off_head`, or, relaying a lot
        // block's refusal, the market address fixed by the one-shot `set_peers`.
        // It carries only what arrived (the opener's own open gas), never ledger TON.
        const replyCallers = [...ledger.matchAll(/(?<!fun )\breplyMarkRejected\(([^,]+),/g)].map((m) => m[1].trim());
        expect([...new Set(replyCallers)].sort()).toEqual(['loadConfigD(storage).marketAddr', 'senderAddress']);
    });

    /**
     * §8's other half, and the one `/verify` publishes first: **no contract can be
     * REPLACED or FROZEN after deploy.** The withdraw surface above bounds where
     * money may go given the code that is running; a code-upgrade primitive would
     * make that bound meaningless, because tomorrow's code could send anywhere, and
     * a pause lever would let a role stop `flush()` without ever naming a payee.
     *
     * TVM has exactly one way to swap a running contract's code — the `SETCODE`
     * instruction — which Tolk's stdlib exposes as `contract.setCodePostponed`
     * (`tolk-stdlib/common.tolk:392`, one `asm "SETCODE"` line) and which FunC-era
     * sources spell `set_code`. All three spellings are looked for, plus a raw
     * `asm` escape, because Tolk lets any function drop to the instruction.
     *
     * Asserted over the WHOLE contracts directory rather than per-contract, so a
     * 22nd contract is covered on the day it is added instead of on the day someone
     * remembers. `.tolk.inc` includes count too: an include is compiled into every
     * contract that takes it, so a primitive hidden there would be everywhere at once.
     *
     * NOT widened to `ownerAddr`: an NFT item and a jetton wallet have owners by
     * standard, and that is the player, not a privileged role. The treasury test
     * above keeps its stricter no-owner assertion because the treasury is the one
     * contract whose send names an arbitrary address.
     *
     * Comments are stripped first: several files say "no upgrade" and "not a pause"
     * in prose, which is the opposite of the thing being looked for.
     */
    it('has no upgrade or pause authority in any contract (§8: the code that is deployed is the code)', () => {
        const sources = readdirSync(CONTRACTS_DIR).filter((f) => /\.tolk(\.inc)?$/.test(f));
        // Every contract in the repo layout, plus the shared include.
        expect(sources.length).toBeGreaterThanOrEqual(21);

        const LEVER = /\b(setCodePostponed|set_code|SETCODE|paused|asm)\b/g;
        const offenders: string[] = [];
        for (const file of sources) {
            const code = readFileSync(join(CONTRACTS_DIR, file), 'utf8')
                .split(/\r?\n/)
                .filter((l) => !l.trim().startsWith('//'))
                .join('\n');
            for (const m of code.matchAll(LEVER)) offenders.push(`${file}: ${m[0]}`);
        }
        expect(offenders).toEqual([]);
    });
});
