tolk 1.4

// ============================================================================
// TON PRIMES — the LP POSITION CHILD, one per depositing wallet. CONCEPT.md
// §5.5.3; DECISIONS.md D-100 points 4 and 9, D-147, D-168. Opcodes:
// /shared/opcodes.ts `TREASURY`. Wire format: /shared/schemas/treasury.tlb.
// Parent: /contracts/contracts/primes_treasury.tolk.
//
// WHY THIS CONTRACT EXISTS AT ALL. Config 43 fixes `max_acc_state_cells =
// 65,536` per non-masterchain account — a consensus-enforced ceiling on code
// plus data (CLAUDE.md "Measured provenance"). A positions dictionary living in
// the treasury's own account dies around 20,000 positions, so the treasury holds
// GLOBAL state and this contract, one per depositing wallet, holds that wallet's
// positions — the same per-owner sharding `owed` uses (§3.2.1/§3.4).
//
// ITS ADDRESS IS ITS AUTHORITY, IN BOTH DIRECTIONS. The init data is
// `(owner, treasuryAddr, empty positions, 0, 0, 0, empty votes, clockDivisor)`, so the address
// is a hash of (this code, this owner, that treasury). The treasury
// authenticates every message from here by re-deriving `positionAddress(owner)`;
// this contract authenticates the treasury by `treasuryAddr` and the owner by
// `owner`. `primes_treasury.tolk`'s `PositionInit` mirrors the empty state byte
// for byte, and `Treasury.spec.ts` asserts the two derivations agree.
//
// ---------------------------------------------------------------------------
// WHAT A POSITION IS, AND WHAT IT BUYS
// ---------------------------------------------------------------------------
// An amount of DeDust PRIMES/TON LP, a TIER (30 d / 3 m / 6 m / 1 y), and the
// timestamp the term started. It matures at `lockedAt + tierTerm(tier)` and from
// that instant is withdrawable in one message (D-147). While the term runs it
// VOTES with `amount × voteMultiplier(tier)` — on proposals that opened after it
// took that weight (`weightSince`, CONCEPT §5.5.5) — and at maturity the vote
// stops. That is
// the whole of what custody buys: D-168 deleted the LP miner, so a position
// earns no PRIMES — its LP keeps earning the pool's own trading fee, which is the
// depositor's and never passes through here.
//
// RELOCK restarts the term at `now` under a new tier and refuses a DOWNGRADE
// before maturity (`newTier >= tier || now >= maturesAt`): a position that could
// drop tiers at will would hold the 1-year vote weight on the 30-day clock. It
// is applied HERE and reported to the treasury as `relock_vote`, which moves the
// weight in `eligibleWeight`; nothing is paid, so no reply is awaited.
//
// ONE VOTE PER POSITION PER PROPOSAL IS ENFORCED HERE (D-188 point 7). The
// treasury keeps only per-proposal totals, so "already voted" lives on the
// voter's own account: `voted[(seq << 32) | positionId] = recordUntil`, written
// BEFORE the vote is forwarded, where `recordUntil = now + voteDuration`. The
// treasury refuses a vote before the proposal's `opens` (1206, the notice — D-173
// as amended 2026-11-19), so an accepted vote has `now >= opens` and therefore
// `recordUntil >= opens + voteDuration = closes` WHATEVER the notice length: the
// record needs no notice term. The
// treasury refuses a vote whose proposal closes after `recordUntil` (1203), so a
// record provably outlives the vote window it guards and can be forgotten once
// `now >= recordUntil` — every `PositionVote` first prunes the lapsed ones. A vote
// the treasury refuses bounces back here and its record is deleted (only if it is
// still the SAME record), so a refusal never blocks a later valid vote.
// BOUND: one row per (position, proposal) voted on in the last `voteDuration` —
// this owner's own account, grown only by this owner's own votes.
//
// EXPIRE IS PERMISSIONLESS, AND IT IS BOOKKEEPING ONLY. It takes a matured
// position's vote weight out of the two published aggregates (the local
// `voteWeight` and the treasury's `eligibleWeight`). It changes NO rule — a
// matured position cannot vote whether or not anyone expired it, because
// `PositionVote` checks the position's own clock.
//
// A SINK-FORWARD NEEDS NO MATURITY (D-100 point 4). Giving LP up to
// `primes_lp_sink.tolk` forever is not the thing the term exists to slow down.
//
// ---------------------------------------------------------------------------
// THE LP MOVE, AND THE ONE FLAG THAT MAKES IT SAFE
// ---------------------------------------------------------------------------
// A withdrawal or sink-forward is a round trip: owner → here (validate, set
// `inFlight = 1`) → treasury (send the LP, reply `confirm_withdraw`) → here
// (delete). `inFlight` stops a second move of the same position before the first
// reply lands. A bounced forward clears it (nothing moved); a bounced LP transfer
// comes back as `restore_position` — MATURED and EXPIRED, because its vote weight
// already left `eligibleWeight` — and the owner retries.
//
// NO ADMIN SURFACE. This contract holds a RECORD — never LP, PRIMES or TON beyond
// its own rent. The only destinations any of its messages can cause are the
// owner's own address and the LP sink, and neither is a field the owner supplies.
// ============================================================================

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------

// 0.05 TON: this contract's own handling of an owner message.
const POSITION_GAS: coins = 50000000;
// MIRRORED from primes_treasury.tolk's `TREASURY_MIN_FORWARD` (= its
// `TRANSFER_GAS + CHILD_GAS`): what the treasury asserts has ARRIVED for a move.
const TREASURY_MIN_FORWARD: coins = 150000000;
// The nominal figure an owner must forward. A real sender adds a margin.
const POSITION_MIN_FORWARD: coins = POSITION_GAS + TREASURY_MIN_FORWARD;  // 0.20 TON

// ---------------------------------------------------------------------------
// The tier ladders — MIRRORED from primes_treasury.tolk
// `treasury.vote_multipliers` and `treasury.tier_term_seconds` (D-100 point 9,
// D-147, D-168); SimCrossCheck.spec.ts catches the copies drifting apart.
// ---------------------------------------------------------------------------

const TIER_MAX: int = 3;

const VOTE_MULT_0: int = 1;
const VOTE_MULT_1: int = 3;
const VOTE_MULT_2: int = 10;
const VOTE_MULT_3: int = 30;

// LOCK TERMS, not withdrawal delays (D-147). Measured from `Position.lockedAt`.
const TIER_TERM_0: int = 2592000;
const TIER_TERM_1: int = 7776000;
const TIER_TERM_2: int = 15552000;
const TIER_TERM_3: int = 31536000;

// `treasury.vote_duration_seconds` = 86400, MIRRORED from primes_treasury.tolk's
// `VOTE_DURATION` (SimCrossCheck binds both). How long a vote record is kept:
// the treasury refuses a vote whose proposal closes after the record lapses, so a
// copy that drifted SHORT fails closed (votes refused), never open.
const VOTE_DURATION: int = 86400;

fun voteMultiplier(tier: int): int {
    if (tier == 0) { return VOTE_MULT_0; }
    if (tier == 1) { return VOTE_MULT_1; }
    if (tier == 2) { return VOTE_MULT_2; }
    if (tier == 3) { return VOTE_MULT_3; }
    return 0;
}

// D-139: `divisor` is the deploy-time clock divisor off `Storage`, 1 on mainnet.
fun tierTerm(tier: int, divisor: int): int {
    if (tier == 0) { return TIER_TERM_0 / divisor; }
    if (tier == 1) { return TIER_TERM_1 / divisor; }
    if (tier == 2) { return TIER_TERM_2 / divisor; }
    return TIER_TERM_3 / divisor;
}

// ---------------------------------------------------------------------------
// Storage — THE FIELD ORDER IS PART OF THE ADDRESS (see the header)
// ---------------------------------------------------------------------------

struct Position {
    amount: coins
    // Editable ONLY by `Relock`, and only upward before maturity.
    tier: uint8
    // WHEN THE TERM STARTED. Restamped to `now` by a relock, so `maturesAt` is
    // always `lockedAt + tierTerm(tier)`.
    lockedAt: uint40
    // SINCE WHEN THIS POSITION HAS HELD ITS CURRENT VOTE WEIGHT, unbroken. Sent
    // with every `Vote`: the treasury counts a position only if this is BEFORE
    // the proposal opened (CONCEPT §5.5.5, 1202), so weight that appears after a
    // proposal is visible — a new deposit, a tier upgrade, a matured term
    // revived — cannot swing it. A relock at the SAME tier before maturity only
    // extends the term and keeps it, so extending mid-vote never costs the voter
    // the proposal; every other relock restamps it to `now`.
    weightSince: uint40
    // 1 while an LP move is in flight to the treasury.
    inFlight: uint8
    // 1 once this position's vote weight has left BOTH aggregates — by `Expire`,
    // or because a bounced move restored it without it. Not the vote rule (the
    // rule is the clock); the flag that stops the same decrement twice.
    expired: uint8
}

struct Storage {
    owner: address
    treasuryAddr: address
    positions: map<uint32, Position>
    // Monotonic. Ids are never reused, so a restore puts a position back under
    // the id it always had and a client enumerates 0..nextId-1.
    nextId: uint32
    positionCount: uint32
    // Σ amount · voteMultiplier(tier), less expired. Maintained, never scanned;
    // an UPPER BOUND between a term's maturity and its `Expire`.
    voteWeight: uint120
    // D-188 point 7. `(seq << 32) | positionId` -> the instant this record may be
    // forgotten (`now + voteDuration` when the vote was cast). See the header;
    // bounded by the votes this owner cast in the last `voteDuration`.
    voted: map<uint64, uint40>
    // D-139 — the treasury's clock divisor, inherited. LAST, because this cell IS
    // this contract's address.
    clockDivisor: uint16
}

fun Storage.clockDiv(self): int {
    return self.clockDivisor == 0 ? 1 : self.clockDivisor;
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Inbound, from the TREASURY only.
struct (0x96000010) LpCredit {
    queryId: uint64
    amount: coins
    tier: uint8
}

struct (0x96000012) ConfirmWithdraw {
    queryId: uint64
    positionId: uint32
}

struct (0x96000013) RestorePosition {
    queryId: uint64
    positionId: uint32
    amount: coins
    tier: uint8
}

// Inbound, from the OWNER only — except `Expire`, which is from ANYONE.
struct (0x96000021) Withdraw {
    queryId: uint64
    positionId: uint32
}

struct (0x96000023) ToSink {
    queryId: uint64
    positionId: uint32
}

// D-147: A VOTE NAMES ITS POSITION, weighed against its own clock.
struct (0x96000024) PositionVote {
    queryId: uint64
    seq: uint32
    support: uint8
    positionId: uint32
}

struct (0x96000025) PositionPropose {
    queryId: uint64
    asset: uint8
    amount: coins
    dest: address
    positionId: uint32
}

// D-147. Restart the term at `now` under `tier`. Refused as a DOWNGRADE before
// maturity.
struct (0x96000026) Relock {
    queryId: uint64
    positionId: uint32
    tier: uint8
}

// D-147, and THE ONE MESSAGE HERE WITH NO SENDER CHECK. It moves no asset and
// changes no rule.
struct (0x96000027) Expire {
    queryId: uint64
    positionId: uint32
}

// Outbound, to the TREASURY. Re-declared byte for byte from primes_treasury.tolk;
// `shared/schemas/treasury.tlb` is the single place both are specified.
struct (0x96000002) RelockVote {
    queryId: uint64
    owner: address
    positionId: uint32
    amount: coins
    tier: uint8
    newTier: uint8
    expired: uint8
}

struct (0x96000003) WithdrawLp {
    queryId: uint64
    owner: address
    positionId: uint32
    amount: coins
    tier: uint8
    toSink: uint8
    expired: uint8
}

struct (0x96000004) Vote {
    queryId: uint64
    owner: address
    seq: uint32
    weight: uint128
    support: uint8
    positionId: uint32
    weightSince: uint40
    // D-188 point 7: when this child forgets the vote. The treasury refuses a
    // proposal that closes after it (1203).
    recordUntil: uint40
}

struct (0x96000005) Propose {
    queryId: uint64
    owner: address
    weight: uint128
    asset: uint8
    amount: coins
    dest: address
}

struct (0x96000007) ExpireVote {
    queryId: uint64
    owner: address
    positionId: uint32
    amount: coins
    tier: uint8
}

type AllowedMessage = LpCredit | ConfirmWithdraw | RestorePosition
    | Withdraw | ToSink | PositionVote | PositionPropose | Relock | Expire;

// D-147. The instant a term ends: withdrawable from here, not a voter from here.
fun maturesAt(pos: Position, divisor: int): int {
    return pos.lockedAt + tierTerm(pos.tier, divisor);
}

// What ONE named position may vote with, right now: its full weight while its
// term runs, nothing from the instant it matures — computed from the position,
// never read off an aggregate that catches up only when somebody sends `Expire`.
fun liveVoteWeight(storage: Storage, positionId: uint32): int {
    val look = storage.positions.get(positionId);
    if (!look.isFound) { return 0; }
    val pos = look.loadValue();
    if (blockchain.now() >= maturesAt(pos, storage.clockDiv())) { return 0; }
    return pos.amount * voteMultiplier(pos.tier);
}

fun dropVote(mutate storage: Storage, pos: Position) {
    // An `Expire` (or a restore) already took it out; taking it out twice would
    // shrink the published electorate by twice what left it.
    val v = pos.expired == 1 ? 0 : pos.amount * voteMultiplier(pos.tier);
    storage.voteWeight = (storage.voteWeight > v ? storage.voteWeight - v : 0) as uint120;
}

fun voteKey(seq: int, positionId: int): uint64 {
    return ((seq << 32) | positionId) as uint64;
}

// Forget every vote record whose proposal has certainly closed. A full walk,
// paid for by the owner casting the vote, over the owner's own records.
fun pruneVotes(mutate voted: map<uint64, uint40>) {
    val now = blockchain.now();
    var r = voted.findFirst();
    while (r.isFound) {
        val key = r.getKey();
        val until = r.loadValue();
        r = voted.iterateNext(r);
        if (until <= now) { voted.delete(key); }
    }
}

fun forwardToTreasury(treasuryAddr: address, body: cell) {
    createMessage({
        // RichBounce: a refused LP move comes back here and clears `inFlight`.
        bounce: BounceMode.RichBounce,
        value: 0,
        dest: treasuryAddr,
        body: body,
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// The guard every move and relock shares.
// The owner check stays INLINE in each arm (tools/sender-gates.mjs reads it there).
fun ownedIdle(storage: Storage, valueCoins: int, positionId: uint32): Position {
    assert (valueCoins >= POSITION_MIN_FORWARD) throw 103;      // insufficient_value
    val look = storage.positions.get(positionId);
    assert (look.isFound) throw 1165;                           // position_no_position
    val pos = look.loadValue();
    assert (pos.inFlight == 0) throw 1168;                      // position_in_flight
    return pos;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        // ---- from the treasury ----

        LpCredit => {
            assert (in.senderAddress == storage.treasuryAddr) throw 100; // wrong_sender
            val id = storage.nextId;
            storage.positions.set(id, Position {
                amount: msg.amount,
                tier: msg.tier,
                lockedAt: blockchain.now() as uint40,
                weightSince: blockchain.now() as uint40,
                inFlight: 0,
                expired: 0,
            });
            storage.nextId = (id + 1) as uint32;
            storage.positionCount += 1;
            storage.voteWeight = (storage.voteWeight
                + msg.amount * voteMultiplier(msg.tier)) as uint120;
            storage.save();
        }

        ConfirmWithdraw => {
            assert (in.senderAddress == storage.treasuryAddr) throw 100; // wrong_sender
            val look = storage.positions.get(msg.positionId);
            if (!look.isFound) { return; }
            dropVote(mutate storage, look.loadValue());
            storage.positions.delete(msg.positionId);
            storage.positionCount -= 1;
            storage.save();
        }

        RestorePosition => {
            assert (in.senderAddress == storage.treasuryAddr) throw 100; // wrong_sender
            // Idempotent against a second bounce for the same id.
            if (storage.positions.get(msg.positionId).isFound) { return; }
            // Back MATURED (`lockedAt = 1`, 1970, so every term is served and the
            // owner can retry at once) and EXPIRED: its vote weight left the
            // treasury's `eligibleWeight` on the way out and is not put back, so
            // it is not in the local sum either. `Relock` is the way back in.
            storage.positions.set(msg.positionId, Position {
                amount: msg.amount,
                tier: msg.tier,
                lockedAt: 1,
                // Matured, so it holds no weight; the `Relock` that revives it
                // restamps this.
                weightSince: blockchain.now() as uint40,
                inFlight: 0,
                expired: 1,
            });
            storage.positionCount += 1;
            storage.save();
        }

        // ---- from the owner ----

        Withdraw => {
            assert (in.senderAddress == storage.owner) throw 1164;      // position_not_owner
            var pos = ownedIdle(storage, in.valueCoins, msg.positionId);
            // D-147: THE TERM IS THE WHOLE GATE. `getPosition` reports
            // `maturesAt`, so a UI never has to provoke the throw to find out.
            assert (blockchain.now() >= maturesAt(pos, storage.clockDiv()))
                throw 1166;                                             // position_term_running
            pos.inFlight = 1;
            storage.positions.set(msg.positionId, pos);
            storage.save();
            forwardToTreasury(storage.treasuryAddr, (WithdrawLp {
                queryId: msg.queryId,
                owner: storage.owner,
                positionId: msg.positionId,
                amount: pos.amount,
                tier: pos.tier,
                toSink: 0,
                expired: pos.expired,
            }).toCell());
        }

        ToSink => {
            assert (in.senderAddress == storage.owner) throw 1164;      // position_not_owner
            var pos = ownedIdle(storage, in.valueCoins, msg.positionId);
            // NO MATURITY GATE (D-100 point 4).
            pos.inFlight = 1;
            storage.positions.set(msg.positionId, pos);
            storage.save();
            forwardToTreasury(storage.treasuryAddr, (WithdrawLp {
                queryId: msg.queryId,
                owner: storage.owner,
                positionId: msg.positionId,
                amount: pos.amount,
                tier: pos.tier,
                toSink: 1,
                expired: pos.expired,
            }).toCell());
        }

        PositionVote => {
            assert (in.senderAddress == storage.owner) throw 1164;      // position_not_owner
            // TR-7: a pure function of (amount, tier, now). Zero is refused here
            // rather than tallied, so a proposal's `yes + no` is always real.
            val w = liveVoteWeight(storage, msg.positionId);
            assert (w > 0) throw 1169;                                  // position_no_vote_weight
            // D-188 point 7: the record is HERE, written before the send.
            pruneVotes(mutate storage.voted);
            val key = voteKey(msg.seq, msg.positionId);
            assert (!storage.voted.exists(key)) throw 1155;             // position_already_voted
            val until = blockchain.now() + VOTE_DURATION / storage.clockDiv();
            storage.voted.set(key, until as uint40);
            storage.save();
            forwardToTreasury(storage.treasuryAddr, (Vote {
                queryId: msg.queryId,
                owner: storage.owner,
                seq: msg.seq,
                weight: w as uint128,
                support: msg.support,
                positionId: msg.positionId,
                weightSince: storage.positions.get(msg.positionId).loadValue().weightSince,
                recordUntil: until as uint40,
            }).toCell());
        }

        PositionPropose => {
            assert (in.senderAddress == storage.owner) throw 1164;      // position_not_owner
            val w = liveVoteWeight(storage, msg.positionId);
            assert (w > 0) throw 1169;                                  // position_no_vote_weight
            forwardToTreasury(storage.treasuryAddr, (Propose {
                queryId: msg.queryId,
                owner: storage.owner,
                weight: w as uint128,
                asset: msg.asset,
                amount: msg.amount,
                dest: msg.dest,
            }).toCell());
        }

        Relock => {
            assert (in.senderAddress == storage.owner) throw 1164;      // position_not_owner
            var pos = ownedIdle(storage, in.valueCoins, msg.positionId);
            assert (msg.tier <= TIER_MAX) throw 102;                    // malformed_body
            // THE ONE ASSERT THAT MAKES RELOCK SAFE (D-147): before maturity the
            // tier may only go UP. Once the term is served any tier is allowed.
            assert (msg.tier >= pos.tier
                    || blockchain.now() >= maturesAt(pos, storage.clockDiv()))
                throw 1167;                                             // position_relock_downgrade
            val wasExpired = pos.expired;
            val oldTier = pos.tier;
            // CONCEPT §5.5.5: the weight is unbroken only if the term is still
            // running AND the multiplier is unchanged. An upgrade (more weight)
            // or a revived matured term (weight from zero) is NEW weight, and new
            // weight votes only on proposals opened after it.
            if (msg.tier != pos.tier
                || blockchain.now() >= maturesAt(pos, storage.clockDiv())) {
                pos.weightSince = blockchain.now() as uint40;
            }
            dropVote(mutate storage, pos);
            pos.tier = msg.tier;
            pos.lockedAt = blockchain.now() as uint40;
            pos.expired = 0;
            storage.voteWeight = (storage.voteWeight
                + pos.amount * voteMultiplier(pos.tier)) as uint120;
            storage.positions.set(msg.positionId, pos);
            storage.save();
            forwardToTreasury(storage.treasuryAddr, (RelockVote {
                queryId: msg.queryId,
                owner: storage.owner,
                positionId: msg.positionId,
                amount: pos.amount,
                tier: oldTier,
                newTier: msg.tier,
                expired: wasExpired,
            }).toCell());
        }

        Expire => {
            // NO SENDER CHECK — see the header. It moves nothing and gates
            // nothing; it makes two published aggregates catch up with a
            // timestamp that has already passed.
            assert (in.valueCoins >= POSITION_MIN_FORWARD) throw 103;   // insufficient_value
            val look = storage.positions.get(msg.positionId);
            assert (look.isFound) throw 1165;                           // position_no_position
            var pos = look.loadValue();
            // Already expired: RETURN, do not throw — a keeper may double-send.
            if (pos.expired == 1) { return; }
            // In flight: RETURN as well. The `WithdrawLp` already on its way carries
            // `expired == 0`, so the treasury takes this weight out of `eligibleWeight`
            // when it lands; an `ExpireVote` now would take it out a second time and the
            // electorate the 1% opening bar is measured against would ratchet toward 0
            // (2026-11-08 audit). A refused withdraw restores the position with
            // `inFlight == 0`, and the next poke expires it then.
            if (pos.inFlight == 1) { return; }
            assert (blockchain.now() >= maturesAt(pos, storage.clockDiv()))
                throw 1166;                                             // position_term_running
            dropVote(mutate storage, pos);
            pos.expired = 1;
            storage.positions.set(msg.positionId, pos);
            storage.save();
            forwardToTreasury(storage.treasuryAddr, (ExpireVote {
                queryId: msg.queryId,
                owner: storage.owner,
                positionId: msg.positionId,
                amount: pos.amount,
                tier: pos.tier,
            }).toCell());
        }

        else => {
            // Plain TON top-ups (rent) are accepted. Nothing else is.
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // AN LP MOVE BOUNCED OFF THE TREASURY — it threw, so nothing moved on either
    // side and the only damage is this contract's `inFlight`. Clear it and the
    // owner retries. A REFUSED VOTE comes back too, and its record is forgotten
    // so it cannot block a later valid vote. `Propose`, `RelockVote` and
    // `ExpireVote` set nothing, so their bounces need nothing.
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var s = rich.originalBody.beginParse();
    val op = s.loadUint(32);
    if (op == 0x96000004) {
        val vote = Vote.fromCell(rich.originalBody);
        var st = lazy Storage.load();
        val key = voteKey(vote.seq, vote.positionId);
        val look = st.voted.get(key);
        // Only the SAME record: a later vote's record is not this bounce's to drop.
        if (look.isFound && look.loadValue() == vote.recordUntil) {
            st.voted.delete(key);
            st.save();
        }
        return;
    }
    if (op != 0x96000003) { return; }
    s.loadUint(64);      // queryId
    s.loadAddress();     // owner
    val positionId = s.loadUint(32);
    var storage = lazy Storage.load();
    val look = storage.positions.get(positionId as uint32);
    if (!look.isFound) { return; }
    var pos = look.loadValue();
    pos.inFlight = 0;
    storage.positions.set(positionId as uint32, pos);
    storage.save();
}

// ---------------------------------------------------------------------------
// Get-methods (§9.1 — every number the UI shows maps to one of these)
// ---------------------------------------------------------------------------

// (positionCount, nextId, voteWeight). Enumerate `getPosition(0..nextId-1)`.
// `voteWeight` carries `getVoteWeight()`'s upper-bound caveat.
get fun getPositions(): (int, int, int) {
    val storage = lazy Storage.load();
    return (storage.positionCount, storage.nextId, storage.voteWeight);
}

// (amount, tier, lockedAt, expired, inFlight, maturesAt, weightSince).
// `maturesAt` is the instant `withdraw` stops throwing and `vote` starts
// throwing — the bounded quantity a term ring fills toward (§9.1).
// `weightSince` against a proposal's `opens` answers whether the treasury will
// count this position's vote on it (1202) without provoking the throw.
get fun getPosition(positionId: int): (int, int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val look = storage.positions.get(positionId as uint32);
    if (!look.isFound) { return (0, 0, 0, 0, 0, 0, 0); }
    val p = look.loadValue();
    return (p.amount, p.tier, p.lockedAt, p.expired, p.inFlight,
            maturesAt(p, storage.clockDiv()), p.weightSince);
}

// D-188 point 7. 1 while this position holds a vote record on proposal `seq` —
// from the vote until the proposal has certainly closed; 0 before, and again
// once the record is pruned. The treasury no longer knows who voted.
get fun getHasVoted(seq: int, positionId: int): int {
    val storage = lazy Storage.load();
    return storage.voted.exists(voteKey(seq, positionId)) ? 1 : 0;
}

// How many of this wallet's positions hold a vote record on `seq` — "has this
// wallet voted" for a reader that does not name a position.
get fun getVotedCount(seq: int): int {
    val storage = lazy Storage.load();
    var n = 0;
    var r = storage.voted.findKeyGreaterOrEqual((seq << 32) as uint64);
    var more = r.isFound;
    while (more) {
        if ((r.getKey() >> 32) == seq) {
            n += 1;
            r = storage.voted.iterateNext(r);
            more = r.isFound;
        } else {
            more = false;
        }
    }
    return n;
}

// Σ `amount × voteMultiplier(tier)` over this wallet's positions, less the ones
// an `Expire` has retired. AN UPPER BOUND between a maturity and its `Expire`
// (D-147); the rule itself is exact, because `PositionVote` weighs the named
// position against its own clock.
get fun getVoteWeight(): int {
    val storage = lazy Storage.load();
    return storage.voteWeight;
}

// (owner, treasuryAddr) — what this contract's address is a hash of.
get fun getPositionOwner(): (address, address) {
    val storage = lazy Storage.load();
    return (storage.owner, storage.treasuryAddr);
}

// The four LOCK TERMS as this contract enforces them (divided).
get fun getTierTerms(): (int, int, int, int) {
    val storage = lazy Storage.load();
    val d = storage.clockDiv();
    return (TIER_TERM_0 / d, TIER_TERM_1 / d, TIER_TERM_2 / d, TIER_TERM_3 / d);
}

// The nominal TON an owner message must forward: this hop plus the treasury's.
get fun getPositionMinForward(): int {
    return POSITION_MIN_FORWARD;
}
