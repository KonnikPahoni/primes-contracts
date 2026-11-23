tolk 1.4

// ============================================================================
// TON PRIMES — Venue timelock. THE ENTIRE ADMIN SURFACE OF THE PROTOCOL.
// Phase 3, IMPLEMENTATION_PLAN.md §3 build step 6 (docs/phase3-report.md §7
// priority list item 2). Storage/message layouts: docs/engineering-spec.md
// §4.9, §5 row 7, §6; /shared/schemas/venue_timelock.tlb; /shared/opcodes.ts
// VENUE_TIMELOCK.
//
// This contract holds exactly one thing — the three DeDust VENUE ADDRESSES
// primes_ratchet.tolk's `flush()` trades into — behind a 30-day public queue, a
// governance confirmation, and a permissionless execute.
//
// D-194 — TWO KEYS, AND WHY. A venue address is where the ratchet SENDS
// `pending`: every flush tranche (up to `FLUSH_PCT` of `pending` a day) goes to
// `dedustNativeVault`, and a vault is free to ignore the swap's floor-guard
// limit. So whoever can re-point it can, after the delay, route `pending` to
// themselves at 20% a day — an admin withdraw path in all but name, which §8
// forbids "not timelocked, not multisig". The 30 days alone was never a defence:
// `pending` is nobody's, so no one can react by withdrawing it. Since D-194 a
// change needs BOTH
//   1. the proposer key (`queue`), and
//   2. a PASSED vote of the treasury's LP electorate (primes_treasury.tolk's
//      venue-confirm proposal, which sends `confirm_venue` naming this record's
//      `seq`),
// before `execute` will fire. The treasury's rule is `yes > no` with no quorum,
// so a vote nobody casts FAILS — but the proposer's own dust LP lock is a voter,
// so the defence is not the empty electorate, it is the NOTICE (below). The
// confirmation binds the record by `seq`, which a fresh `queue` always moves, AND
// by time, twice:
//   - the vote must have OPENED no earlier than the record was queued
//     (`queuedAt`, 807). `seq` alone is predictable (`queueSeq + 1`), so without
//     this a vote could pass on a record that did not exist yet — nothing for the
//     electorate to read or oppose — and the proposer would fill it in afterwards.
//   - the vote must CLOSE no earlier than `eta` (808), i.e. open no earlier than
//     `eta − voteDuration` (2026-11-19 amendment, audit H1). The treasury counts
//     only weight locked BEFORE a proposal opens (1202), so a vote opened the
//     block after `queue` could be opposed only by positions that already
//     existed: the 30 days gave nobody anything to act on. Opening at the END of
//     the notice gives every holder the whole delay to lock LP and vote no. The
//     treasury sends its own `closes` (= `opens + voteDuration`, scaled by ITS
//     clock divisor), so no vote-duration constant is duplicated here.
//     Since audit R2-H1 the treasury's `opens` is itself `proposed + notice`
//     (its own notice, D-173 as amended 2026-11-19), so the confirm proposal
//     is PROPOSED no earlier than `eta − notice − voteDuration`; both checks
//     here read the VOTE's window and are unchanged. 807 therefore bounds
//     when the vote opened, not when the proposal was written — 808 is the
//     binding one whenever the delay exceeds the vote length.
// A vote on one address set can never execute another.
//
// D-194 also took §4.3.2's staking block (Tonstakers pool, tsTON vault and pool,
// harvest destination) OUT of this contract. D-151 had routed it through here,
// and `stake()` sends `pending - reserve` to the Tonstakers pool in one message,
// so this key could have aimed nearly all of `pending` at an address of its
// choosing in one call. Those four addresses are now ratchet deploy data with
// no message that changes them; a Tonstakers migration stops staking (pending
// stays liquid) and moves nothing.
//
// Neither key touches T, S, owed balances or any compiled-in economic
// parameter. `getQueued()` publishes the pending record, its `seq` and whether
// it is confirmed, for the whole thirty days (§9.1).
//
// ---- Documented deviations (continuing docs/phase3-report.md's D1-D8) ----
// D9. Storage is split into a root cell (proposerAddr, governanceAddr,
//     queueSeq) plus a ref'd `QueuedVenue` sub-cell (the three venue
//     addresses + eta + seq + flags) and, since D-194, a ref'd `Boot` cell
//     (ratchetAddr, ratchetSet, genesisScriptAddr), for the same reason primes_ledger.tolk's storage is split
//     (docs/phase3-report.md's "structural" note): a flat struct with 5
//     `address` fields (proposerAddr, ratchetAddr, 3 venue addresses) measures
//     5*267 = 1335 bits, over Tolk's 1023-bit single-cell limit, before even
//     adding `eta`/flags. Every field named in engineering-spec §4.9 is
//     still present, just relocated across cells.
// D10. `/shared/schemas/venue_timelock.tlb` originally specified only
//     `queue`/`cancel`/`execute` (both bootstrap messages are there now).
//     Engineering-spec §5 row 7 additionally requires a
//     permissionless `retry_update_venue` for the case where `execute`'s
//     outbound `update_venue` send to the ratchet bounces, "so a bounce here
//     must never force restarting the 30-day timelock". Added here as
//     opcode 0xa0000004, following the exact
//     precedent of D2's `ForwardToOwner` and the ledger's own `retry_credit`:
//     a message the engineering spec requires but the original TL-B/opcode
//     tables (written before this contract existed) didn't anticipate.
//     Implementation: `execute` does NOT clear the queued record on send: it
//     only flips a `fired` flag. `retry_update_venue` is permissionless,
//     requires `fired == 1`, and re-sends the identical, already-matured
//     `update_venue` body from the still-stored fields — no new eta, no
//     re-queue, exactly matching the bounce-safety requirement. A fresh
//     `queue()` (which the proposer may still call at any time to propose a
//     *different* change) overwrites the record including `fired`, matching
//     the TL-B comment's documented "overwrites any prior unexecuted queued
//     change" behavior (a fired-but-not-yet-reconfirmed change being
//     abandoned in favor of a new proposal is an accepted, narrow edge case,
//     not silently lossy: the old venue addresses simply never get resent,
//     which is safe: the replacement needs its own 30 days and its own vote).
// D11. `ratchetAddr` is bootstrapped via a one-shot `SetRatchet` message, not fixed
//     at deploy as engineering-spec §4.9's storage table shows. This is the
//     exact same circular-address problem D7 already solved for the
//     collection/jetton-master <-> ledger relationship, discovered again here:
//     the ratchet's own init data embeds `venueTimelockAddr` (so the ratchet's
//     address depends on the timelock's address), while engineering-spec
//     §4.9 has the timelock embedding a fixed `ratchetAddr` in ITS init data
//     (so the timelock's address would depend on the ratchet's address) — an
//     unresolvable mutual dependency if both are naively "fixed at deploy".
//     Resolved identically to D7: deploy with `ratchetAddr` unset + `ratchetSet`
//     flag; `genesisScriptAddr` (the same used-up bootstrap credential
//     pattern as everywhere else in this codebase) sends one-shot `SetRatchet`
//     once both addresses are known. Not a standing admin key — once
//     `ratchetSet = 1`, no message can ever change it again, and it is a
//     DIFFERENT credential from the `proposerAddr` that has ongoing
//     authority here, so it does not expand this contract's actual admin
//     surface (queue/cancel/confirm/execute), only its one-time bootstrap.
// ============================================================================

const TIMELOCK_DELAY: int = 2592000; // 30 days, engineering-spec §4.9 / concept Q1

struct QueuedVenue {
    dedustNativeVault: address
    dedustPool: address
    primesJettonVault: address
    eta: uint64
    // D-194: this record's number, from `Storage.queueSeq`. `confirm_venue`
    // must name it, so a confirmation can only ever apply to the record the
    // electorate voted on.
    seq: uint32
    // The `queue` time. `confirm_venue` carries its vote's `opens`, and only a
    // vote opened no earlier than this confirms — the addresses were public for
    // the whole vote, never filled in behind it. (And its `closes` must reach
    // `eta`, 808 — see the header.)
    queuedAt: uint40
    hasQueued: uint8   // 1 if a record exists (queued and/or fired-awaiting-retry)
    fired: uint8       // 1 once `execute` has sent update_venue at least once for this record
    confirmed: uint8   // D-194: 1 once the treasury's passed vote confirmed THIS `seq`
}

// D-194: the one-shot bootstrap fields, in their own ref so the root has room
// for the governance address. Written at deploy and by `SetRatchet` only.
struct Boot {
    ratchetAddr: address       // set once via SetRatchet (see D11 above), then fixed; the only recipient of update_venue
    ratchetSet: uint8          // D11: one-shot bootstrap flag, same pattern as D7
    genesisScriptAddr: address  // fixed at deploy; the only sender allowed to call SetRatchet, once
}

struct Storage {
    proposerAddr: address   // fixed at deploy; key 1 of 2 — may `queue` and `cancel`, nothing else
    // D-194: primes_treasury.tolk, fixed at deploy; key 2 of 2 — the ONLY sender
    // of `confirm_venue`, which it sends only on a passed LP vote. No circle: the
    // treasury's init data names nothing here, so it deploys first.
    governanceAddr: address
    // D-194: bumped by every `queue`, never reset, so a `seq` is never reused.
    queueSeq: uint32
    q: Cell<QueuedVenue>
    boot: Cell<Boot>
    // D-139 — THE TEST CLOCK, the fifth consumer of the same deploy-time divisor
    // the market, the ratchet, the treasury and the LP position already carry.
    // It divides the ONE wall-clock constant here, `TIMELOCK_DELAY`.
    //
    // WHY IT HAD TO REACH THIS CONTRACT. The venue change is the protocol's only
    // admin surface, and `execute` is its permissionless half: on a 30-day delay
    // no testnet run can ever reach it, so `queue` had been sent live on every
    // set this project ever deployed and `execute` on none of them. At divisor
    // 168 the delay is ~4.3 hours — a run that queues in its first phase executes
    // in its last. 1 IS MAINNET AND THE IDENTITY: the 30 days are untouched
    // there. Deploy-time and unreachable by any message; no path shortens a
    // delay already running, and `getQueued` publishes the absolute `eta` a
    // reader compares against the chain's own clock.
    clockDivisor: uint16
}

// `0` is read as `1`: a config cell written before this field existed runs at
// mainnet speed rather than dividing by zero.
fun Storage.clockDiv(self): int {
    return self.clockDivisor == 0 ? 1 : self.clockDivisor;
}
fun Storage.timelockDelaySec(self): int {
    return TIMELOCK_DELAY / self.clockDiv();
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// `filler` is a harmless placeholder address (never read while `hasQueued ==
// 0` -- every accessor checks that flag first); using the contract's own
// address avoids needing an addr_none literal, which Tolk 1.4's stdlib
// doesn't expose a constructor for.
fun emptyQueued(filler: address): QueuedVenue {
    return QueuedVenue {
        dedustNativeVault: filler,
        dedustPool: filler,
        primesJettonVault: filler,
        eta: 0,
        seq: 0,
        queuedAt: 0,
        hasQueued: 0,
        fired: 0,
        confirmed: 0,
    };
}

struct (0xa0000001) Queue {
    queryId: uint64
    dedustNativeVault: address
    dedustPool: address
    primesJettonVault: address
    eta: uint64
}

struct (0xa0000002) Cancel {
    queryId: uint64
}

struct (0xa0000003) Execute {
    queryId: uint64
}

// D10: see header comment.
struct (0xa0000004) RetryUpdateVenue {
    queryId: uint64
}

// D11: see header comment.
struct (0xa0000005) SetRatchet {
    queryId: uint64
    ratchetAddr: address
}

// D-194: inbound, from `governanceAddr` ONLY — sent by the treasury's `execute`
// of a passed venue-confirm proposal. `seq` must be the queued, unfired record's,
// `voteOpens` (the proposal's `opens`) must not be earlier than its `queuedAt`
// (807), and `voteCloses` (the proposal's `closes`) must not be earlier than its
// `eta` (808, audit H1).
struct (0xa0000006) ConfirmVenue {
    queryId: uint64
    seq: uint32
    voteOpens: uint40
    voteCloses: uint40
}

struct (0xb0000010) UpdateVenue {
    queryId: uint64
    dedustNativeVault: address
    dedustPool: address
    primesJettonVault: address
}

type AllowedMessage = Queue | Cancel | Execute | RetryUpdateVenue | SetRatchet | ConfirmVenue;

const UPDATE_VENUE_GAS: coins = 30000000; // 0.03 GRAM, gas for the ratchet's UpdateVenue handler

// `value`/`mode`: `execute` pays the hop from this balance (one-shot, `fired`);
// `retry_update_venue` is repeatable by anyone, so it carries the caller's own
// value (mode 64) and costs this contract nothing.
fun sendUpdateVenue(ratchetAddr: address, queryId: int, q: QueuedVenue, value: coins, mode: int) {
    createMessage({
        bounce: BounceMode.RichBounce,
        value: value,
        dest: ratchetAddr,
        body: (UpdateVenue {
            queryId: queryId,
            dedustNativeVault: q.dedustNativeVault,
            dedustPool: q.dedustPool,
            primesJettonVault: q.primesJettonVault,
        }).toCell(),
    }).send(mode);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetRatchet => {
            var boot = storage.boot.load();
            assert (in.senderAddress == boot.genesisScriptAddr) throw 100; // wrong_sender
            assert (boot.ratchetSet == 0) throw 104; // already_processed
            boot.ratchetAddr = msg.ratchetAddr;
            boot.ratchetSet = 1;
            storage.boot = boot.toCell();
            storage.save();
        }

        Queue => {
            assert (in.senderAddress == storage.proposerAddr) throw 800; // timelock_not_proposer
            assert (msg.eta >= blockchain.now() + storage.timelockDelaySec()) throw 801; // timelock_not_matured (eta too soon)
            // GAUNTLET.md B30. A PENDING change may not be overwritten. Without this
            // the proposer could replace the contents of an already-public, already-
            // advertised venue change at any moment before its eta, and the advertised
            // delay — the entire product this contract sells — would be worth nothing:
            // watchers would have reviewed one set of addresses and a different set
            // would execute. `Cancel` is how a pending change is withdrawn, and it is
            // visible; this is not. 803 is `timelock_already_queued`.
            //
            // A FIRED record is not pending, so re-queueing over it is allowed — that is
            // how the next change is proposed. Consequence, stated rather than
            // discovered: it also overwrites the record `RetryUpdateVenue` redelivers,
            // so a proposer who queues again abandons an unbounced retry. That is the
            // right ordering (they are deliberately replacing the venue) and it costs a
            // fresh 30-day wait and a fresh vote, so it cannot be used to rush anything.
            val prev = storage.q.load();
            assert (prev.hasQueued == 0 || prev.fired == 1) throw 803; // timelock_already_queued
            // D-194: a new record, a new `seq`, unconfirmed.
            val seq = storage.queueSeq + 1;
            storage.queueSeq = seq as uint32;
            storage.q = (QueuedVenue {
                dedustNativeVault: msg.dedustNativeVault,
                dedustPool: msg.dedustPool,
                primesJettonVault: msg.primesJettonVault,
                eta: msg.eta,
                seq: seq as uint32,
                queuedAt: blockchain.now() as uint40,
                hasQueued: 1,
                fired: 0,
                confirmed: 0,
            }).toCell();
            storage.save();
        }

        Cancel => {
            assert (in.senderAddress == storage.proposerAddr) throw 800; // timelock_not_proposer
            val q = storage.q.load();
            assert (q.hasQueued == 1) throw 802; // timelock_nothing_queued
            storage.q = emptyQueued(contract.getAddress()).toCell();
            storage.save();
        }

        ConfirmVenue => {
            // D-194, key 2. Only the treasury, and only for the record that is
            // queued and not yet fired right now. A stale `seq` (the record was
            // cancelled or replaced after the vote opened) throws 806; the
            // treasury's bounce handler makes its proposal re-executable, which
            // changes nothing, because the seq stays stale. A vote that opened
            // before this record was queued throws 807 the same way: it voted on
            // a number, not on these addresses. A vote that closed before `eta`
            // throws 808 (audit H1): `voteCloses >= eta` is `voteOpens >= eta −
            // voteDuration`, so the vote opened only after holders had the whole
            // notice to lock LP (the treasury's 1202 counts nothing locked later).
            // A real treasury executes only after `closes`, so a confirm always
            // lands at or after `eta`; `execute` below needs nothing earlier.
            assert (in.senderAddress == storage.governanceAddr) throw 805; // timelock_not_governance
            var q = storage.q.load();
            assert (q.hasQueued == 1 && q.fired == 0 && q.seq == msg.seq) throw 806; // timelock_confirm_stale
            assert (msg.voteOpens >= q.queuedAt) throw 807; // timelock_vote_predates_queue
            assert (msg.voteCloses >= q.eta) throw 808; // timelock_vote_before_notice_end
            q.confirmed = 1;
            storage.q = q.toCell();
            storage.save();
        }

        Execute => {
            // PERMISSIONLESS by design (engineering-spec §6 / the tlb's own
            // comment): the proposer cannot selectively withhold execution of
            // an already-public, already-matured, already-confirmed change.
            val q = storage.q.load();
            assert (q.hasQueued == 1) throw 802; // timelock_nothing_queued
            // GAUNTLET.md B30. Execute EXACTLY ONCE. Redelivery of a fired change
            // is `retry_update_venue`, which only resends a decision already made.
            assert (q.fired == 0) throw 802; // timelock_nothing_queued (nothing UNFIRED to execute)
            assert (blockchain.now() >= q.eta) throw 801; // timelock_not_matured
            // D-194: the LP electorate's passed vote. Without it the proposer key
            // alone could re-aim flush — see the header.
            assert (q.confirmed == 1) throw 804; // timelock_not_confirmed
            sendUpdateVenue(storage.boot.load().ratchetAddr, msg.queryId, q, UPDATE_VENUE_GAS, SEND_MODE_REGULAR);
            var q2 = q;
            q2.fired = 1;
            storage.q = q2.toCell();
            storage.save();
        }

        RetryUpdateVenue => {
            // D10: permissionless retry of a bounced update_venue send;
            // engineering-spec §5 row 7. No re-queue, no new 30-day wait --
            // the decision was already finalized by a prior successful
            // `execute`; only delivery is retried.
            val q = storage.q.load();
            assert (q.hasQueued == 1 && q.fired == 1) throw 802; // timelock_nothing_queued (nothing fired yet to retry)
            assert (in.valueCoins >= UPDATE_VENUE_GAS) throw 103; // insufficient_value
            sendUpdateVenue(storage.boot.load().ratchetAddr, msg.queryId, q, 0, SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // update_venue bouncing needs no state change here (D10's
    // retry_update_venue handles redelivery from the still-stored record);
    // nothing else this contract sends carries value that could strand funds.
}

// ---------------------------------------------------------------------------
// Get-methods
// ---------------------------------------------------------------------------

// §9.1 — EVERY address a pending `execute` will write, before its eta, plus the
// two D-194 facts a reader needs to know whether it CAN execute: the record's
// `seq` (what a treasury venue-confirm proposal must name) and `confirmed`, and
// `queuedAt` (a confirming vote must open no earlier). With `eta` it also gives
// the earliest a confirming vote may open: `eta − voteDuration` (808).
get fun getQueued(): (int, int, slice, slice, slice, int, int, int, int) {
    val storage = lazy Storage.load();
    val q = storage.q.load();
    return (
        q.hasQueued,
        q.fired,
        beginCell().storeAddress(q.dedustNativeVault).endCell().beginParse(),
        beginCell().storeAddress(q.dedustPool).endCell().beginParse(),
        beginCell().storeAddress(q.primesJettonVault).endCell().beginParse(),
        q.eta,
        q.seq,
        q.confirmed,
        q.queuedAt,
    );
}

// D-194: the two keys, published so a reader can check who holds each.
get fun getKeys(): (slice, slice) {
    val storage = lazy Storage.load();
    return (
        beginCell().storeAddress(storage.proposerAddr).endCell().beginParse(),
        beginCell().storeAddress(storage.governanceAddr).endCell().beginParse(),
    );
}
