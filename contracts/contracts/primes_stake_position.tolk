tolk 1.4

// ============================================================================
// TON PRIMES — the STAKE POSITION CHILD, one per staking wallet. CONCEPT.md §5.3;
// DECISIONS.md D-168. Opcodes: /shared/opcodes.ts `STAKE`. Wire format:
// /shared/schemas/stake.tlb. Parent: /contracts/contracts/primes_stake.tolk.
//
// WHY IT EXISTS. Config 43's 65,536-cell account ceiling: a positions dictionary
// on the master dies around 20,000 positions, so each wallet's positions live on
// its own child — the `primes_lp_position.tolk` split, for the same reason.
//
// ITS ADDRESS IS ITS AUTHORITY, BOTH WAYS. The init data is `(owner, stakeAddr,
// empty, 0, 0, 0, clockDivisor)`, so the address is a hash of (this code, this
// owner, that master, that divisor). The master re-derives it to trust a
// `settle`; this contract compares `stakeAddr` to trust the master and `owner`
// to trust the owner. `primes_stake.tolk`'s `PositionInit` mirrors the empty
// state byte for byte, and `Staking.spec.ts` asserts the two derivations agree.
//
// WHAT A POSITION IS. PRIMES locked for a term (30 d / 3 m / 6 m / 1 y), a
// `rewardDebt` pinning it to the master's accumulator, the time that debt was
// pinned (`lastSettleTime` — the proration window's start), and `banked`: PRIMES
// an `expire` settled but did not send. It matures at `lockedAt + term` and from
// that instant earns nothing more (D-168 Q14).
//
// THE ROUND TRIP, AND THE FLAG THAT MAKES IT SAFE. The accumulator is on the
// master and TVM has no synchronous read, so every settle is owner → here →
// master → here (+ PRIMES to the owner). `inFlight` is set before the forward
// and cleared ONLY by the master's reply: without it a second claim sent before
// the first reply landed would be computed against a stale debt and paid twice;
// with it, the worst case is a position that cannot be settled. A bounced
// forward clears it here (nothing moved on either side).
//
// NO EARLY EXIT (ST-3). `withdraw` is refused until `maturesAt`; there is no
// other path to the principal, and the master sends it only to `owner`.
// `relock` may never shorten a running term (`newTier ≥ tier || now ≥
// maturesAt`, the LP relock's assert for the LP relock's reason). `expire` is
// the one message with no sender check: it moves no PRIMES — it banks the
// prorated tail here and takes the weight out of the master's `totalWeight`.
//
// This contract holds no PRIMES and no TON beyond its own rent. It holds a RECORD.
// ============================================================================

// 0.05 TON: this contract's own handling of an owner message.
const POSITION_GAS: coins = 50000000;
// MIRRORED from primes_stake.tolk: what the master asserts has ARRIVED for a
// settle that may pay out (a transfer + the reply), and for an expire (the reply
// only). Tolk gives this file no import of those constants.
const MASTER_SETTLE_GAS: coins = 150000000;
const MASTER_EXPIRE_GAS: coins = 50000000;
// The nominal figures a sender must forward. A real sender adds a margin.
const POSITION_MIN_FORWARD: coins = POSITION_GAS + MASTER_SETTLE_GAS;  // 0.20 TON
const EXPIRE_MIN_FORWARD: coins = POSITION_GAS + MASTER_EXPIRE_GAS;    // 0.10 TON

// `staking.tier_term_seconds` — ENFORCED here, divided by the D-139 divisor.
// `staking.tier_weights` — used only by `getClaimable`, a read. Mirrored from
// the master; SimCrossCheck.spec.ts catches the copies drifting.
const TIER_MAX: int = 3;
const TIER_TERM_0: int = 2592000;
const TIER_TERM_1: int = 7776000;
const TIER_TERM_2: int = 15552000;
const TIER_TERM_3: int = 31536000;
const TIER_WEIGHT_0: int = 5;
const TIER_WEIGHT_1: int = 6;
const TIER_WEIGHT_2: int = 7;
const TIER_WEIGHT_3: int = 8;
// `staking.acc_scale` = 2^64.
const ACC_SCALE: int = 18446744073709551616;

const SETTLE_CLAIM: int = 0;
const SETTLE_RELOCK: int = 1;
const SETTLE_WITHDRAW: int = 2;
const SETTLE_EXPIRE: int = 3;

fun tierTerm(tier: int, divisor: int): int {
    if (tier == 0) { return TIER_TERM_0 / divisor; }
    if (tier == 1) { return TIER_TERM_1 / divisor; }
    if (tier == 2) { return TIER_TERM_2 / divisor; }
    return TIER_TERM_3 / divisor;
}

fun tierWeight(tier: int): int {
    if (tier == 0) { return TIER_WEIGHT_0; }
    if (tier == 1) { return TIER_WEIGHT_1; }
    if (tier == 2) { return TIER_WEIGHT_2; }
    if (tier == 3) { return TIER_WEIGHT_3; }
    return 0;
}

// ---------------------------------------------------------------------------
// Storage — THE FIELD ORDER IS PART OF THE ADDRESS (see the header)
// ---------------------------------------------------------------------------

// 124+8+40+40+256+40+8+124+8 = 648 bits.
struct Position {
    amount: coins
    tier: uint8
    lockedAt: uint40
    maturesAt: uint40
    rewardDebt: uint256
    lastSettleTime: uint40
    // 1 once a settle at or past maturity took the weight out of the master's
    // `totalWeight`. An expired position earns nothing; a relock clears it.
    expired: uint8
    // Settled by an `expire`, not yet sent; paid with the next claim, relock or
    // withdraw. Still counted in the master's `unclaimedTotal`.
    banked: coins
    inFlight: uint8
}

struct Storage {
    owner: address
    stakeAddr: address
    positions: map<uint32, Position>
    // Monotonic; ids are never reused, so a client enumerates 0..nextId-1.
    nextId: uint32
    positionCount: uint32
    // Σ principal over this wallet's live positions — the "staked" figure a
    // surface shows for one wallet (§9.1).
    stakedTotal: coins
    // D-139, inherited from the master. LAST because this cell IS the address.
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

// Inbound, from the MASTER only.
struct (0x91000010) StakeCredit {
    queryId: uint64
    amount: coins
    tier: uint8
    rewardDebt: uint256
}

struct (0x91000011) StakeSettled {
    queryId: uint64
    positionId: uint32
    mode: uint8
    newTier: uint8
    rewardDebt: uint256
    expired: uint8
    banked: coins
    settledAt: uint40
}

struct (0x91000012) RestoreStake {
    queryId: uint64
    positionId: uint32
    amount: coins
    tier: uint8
    banked: coins
}

// Inbound, from the OWNER only — except `Expire`, from ANYONE.
struct (0x91000021) Claim {
    queryId: uint64
    positionId: uint32
}

struct (0x91000022) Relock {
    queryId: uint64
    positionId: uint32
    tier: uint8
}

struct (0x91000023) Withdraw {
    queryId: uint64
    positionId: uint32
}

struct (0x91000024) Expire {
    queryId: uint64
    positionId: uint32
}

// Outbound, to the MASTER. Re-declared byte for byte from primes_stake.tolk;
// shared/schemas/stake.tlb is the one place both are specified.
struct (0x91000002) Settle {
    queryId: uint64
    owner: address
    positionId: uint32
    amount: coins
    tier: uint8
    maturesAt: uint40
    rewardDebt: uint256
    lastSettleTime: uint40
    expired: uint8
    banked: coins
    mode: uint8
    newTier: uint8
}

type AllowedMessage = StakeCredit | StakeSettled | RestoreStake
    | Claim | Relock | Withdraw | Expire;

// Validate, mark in flight, forward. The one path every settle takes.
fun forwardSettle(mutate storage: Storage, queryId: int, positionId: int, mode: int,
                  newTier: int) {
    val look = storage.positions.get(positionId as uint32);
    assert (look.isFound) throw 1105;                           // stake_position_missing
    var pos = look.loadValue();
    assert (pos.inFlight == 0) throw 1108;                      // stake_in_flight
    if (mode == SETTLE_WITHDRAW || mode == SETTLE_EXPIRE) {
        assert (blockchain.now() >= pos.maturesAt) throw 1106;  // stake_term_running
    }
    if (mode == SETTLE_RELOCK) {
        assert (newTier <= TIER_MAX) throw 102;                 // malformed_body
        // THE ONE ASSERT THAT MAKES RELOCK SAFE: before maturity the tier may
        // only go up. Once the term is served any tier is allowed.
        assert (newTier >= pos.tier || blockchain.now() >= pos.maturesAt)
            throw 1107;                                         // stake_relock_downgrade
    }
    pos.inFlight = 1;
    storage.positions.set(positionId as uint32, pos);
    storage.save();
    createMessage({
        // RichBounce: a refused settle comes back here and clears `inFlight`.
        bounce: BounceMode.RichBounce,
        value: 0,
        dest: storage.stakeAddr,
        body: (Settle {
            queryId: queryId,
            owner: storage.owner,
            positionId: positionId as uint32,
            amount: pos.amount,
            tier: pos.tier,
            maturesAt: pos.maturesAt,
            rewardDebt: pos.rewardDebt,
            lastSettleTime: pos.lastSettleTime,
            expired: pos.expired,
            banked: pos.banked,
            mode: mode as uint8,
            newTier: newTier as uint8,
        }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        // ---- from the master ----

        StakeCredit => {
            assert (in.senderAddress == storage.stakeAddr) throw 100;  // wrong_sender
            val now = blockchain.now();
            val id = storage.nextId;
            storage.positions.set(id, Position {
                amount: msg.amount,
                tier: msg.tier,
                lockedAt: now as uint40,
                maturesAt: (now + tierTerm(msg.tier, storage.clockDiv())) as uint40,
                rewardDebt: msg.rewardDebt,
                lastSettleTime: now as uint40,
                expired: 0,
                banked: 0,
                inFlight: 0,
            });
            storage.nextId = (id + 1) as uint32;
            storage.positionCount += 1;
            storage.stakedTotal += msg.amount;
            storage.save();
        }

        StakeSettled => {
            assert (in.senderAddress == storage.stakeAddr) throw 100;  // wrong_sender
            val look = storage.positions.get(msg.positionId);
            // A reply for a position already gone is a no-op, not an error.
            if (!look.isFound) { return; }
            var pos = look.loadValue();
            if (msg.mode == SETTLE_WITHDRAW) {
                storage.positions.delete(msg.positionId);
                storage.positionCount -= 1;
                storage.stakedTotal -= pos.amount;
                storage.save();
                return;
            }
            if (msg.mode == SETTLE_RELOCK) {
                // THE TERM RESTARTS HERE, under the tier the master has already
                // re-weighted the position to.
                val now = blockchain.now();
                pos.tier = msg.newTier;
                pos.lockedAt = now as uint40;
                pos.maturesAt = (now + tierTerm(msg.newTier, storage.clockDiv())) as uint40;
            }
            pos.rewardDebt = msg.rewardDebt;
            pos.lastSettleTime = msg.settledAt;
            pos.expired = msg.expired;
            pos.banked = msg.banked;
            pos.inFlight = 0;
            storage.positions.set(msg.positionId, pos);
            storage.save();
        }

        RestoreStake => {
            assert (in.senderAddress == storage.stakeAddr) throw 100;  // wrong_sender
            // Idempotent against a second bounce for the same id.
            if (storage.positions.get(msg.positionId).isFound) { return; }
            // Back MATURED (withdrawable at once), EXPIRED (it left `totalWeight`
            // at the withdraw settle and was never put back) and with the reward
            // BANKED — the owner's retry pays principal and reward again.
            val now = blockchain.now();
            storage.positions.set(msg.positionId, Position {
                amount: msg.amount,
                tier: msg.tier,
                lockedAt: now as uint40,
                maturesAt: now as uint40,
                rewardDebt: 0,
                lastSettleTime: now as uint40,
                expired: 1,
                banked: msg.banked,
                inFlight: 0,
            });
            storage.positionCount += 1;
            storage.stakedTotal += msg.amount;
            storage.save();
        }

        // ---- from the owner ----

        Claim => {
            assert (in.senderAddress == storage.owner) throw 1104;     // stake_position_not_owner
            assert (in.valueCoins >= POSITION_MIN_FORWARD) throw 103;  // insufficient_value
            // No maturity gate: a matured position's tail is still owed to it.
            forwardSettle(mutate storage, msg.queryId, msg.positionId, SETTLE_CLAIM, 0);
        }

        Relock => {
            assert (in.senderAddress == storage.owner) throw 1104;     // stake_position_not_owner
            assert (in.valueCoins >= POSITION_MIN_FORWARD) throw 103;  // insufficient_value
            forwardSettle(mutate storage, msg.queryId, msg.positionId, SETTLE_RELOCK, msg.tier);
        }

        Withdraw => {
            assert (in.senderAddress == storage.owner) throw 1104;     // stake_position_not_owner
            assert (in.valueCoins >= POSITION_MIN_FORWARD) throw 103;  // insufficient_value
            forwardSettle(mutate storage, msg.queryId, msg.positionId, SETTLE_WITHDRAW, 0);
        }

        Expire => {
            // NO SENDER CHECK: it moves no PRIMES and names no destination — it
            // banks the tail here and retires the weight on the master. The party
            // it helps is every other staker, whose share it stops diluting.
            assert (in.valueCoins >= EXPIRE_MIN_FORWARD) throw 103;    // insufficient_value
            val look = storage.positions.get(msg.positionId);
            assert (look.isFound) throw 1105;                          // stake_position_missing
            // Already expired: return, do not throw — a keeper may double-send.
            if (look.loadValue().expired == 1) { return; }
            forwardSettle(mutate storage, msg.queryId, msg.positionId, SETTLE_EXPIRE, 0);
        }

        else => {
            // A plain TON top-up (rent) is accepted; nothing else is.
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // THE MASTER REFUSED A SETTLE: nothing moved on either side. Clear the flag
    // and the owner retries. `positionId` is field 3, after queryId and owner.
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var s = rich.originalBody.beginParse();
    if (s.loadUint(32) != 0x91000002) { return; }
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
// Get-methods (§9.1)
// ---------------------------------------------------------------------------

// (positionCount, nextId, stakedTotal). Enumerate `getPosition(0..nextId-1)`.
get fun getPositions(): (int, int, int) {
    val storage = lazy Storage.load();
    return (storage.positionCount, storage.nextId, storage.stakedTotal);
}

// (amount, tier, lockedAt, maturesAt, rewardDebt, lastSettleTime, expired,
//  banked, inFlight). A missing id returns all zeros (`maturesAt == 0`).
// `lockedAt → maturesAt` is the bounded quantity a term ring fills along.
get fun getPosition(positionId: int): (int, int, int, int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val look = storage.positions.get(positionId as uint32);
    if (!look.isFound) { return (0, 0, 0, 0, 0, 0, 0, 0, 0); }
    val p = look.loadValue();
    return (p.amount, p.tier, p.lockedAt, p.maturesAt, p.rewardDebt,
            p.lastSettleTime, p.expired, p.banked, p.inFlight);
}

// PRIMES a `claim` of this position would pay right now, given the master's
// `getAccNow()`. The master's settle rule, maturity proration included, run as a
// read — so the figure is a chain read, not a client reimplementation. An upper
// bound only by the master's never-pay-more-than-streamed clamp.
get fun getClaimable(positionId: int, acc: int): int {
    val storage = lazy Storage.load();
    val look = storage.positions.get(positionId as uint32);
    if (!look.isFound) { return 0; }
    val p = look.loadValue();
    if (p.expired == 1) { return p.banked; }
    val gross = p.amount * tierWeight(p.tier) * acc / ACC_SCALE;
    val full = gross > p.rewardDebt ? gross - p.rewardDebt : 0;
    val now = blockchain.now();
    if (now < p.maturesAt) { return full + p.banked; }
    var paid = 0;
    if (p.lastSettleTime < p.maturesAt) {
        paid = full * (p.maturesAt - p.lastSettleTime) / (now - p.lastSettleTime);
    }
    return paid + p.banked;
}

// (owner, stakeAddr) — what this contract's address is a hash of.
get fun getPositionOwner(): (address, address) {
    val storage = lazy Storage.load();
    return (storage.owner, storage.stakeAddr);
}

// The four lock terms as this contract ENFORCES them (divided).
get fun getTierTerms(): (int, int, int, int) {
    val storage = lazy Storage.load();
    val d = storage.clockDiv();
    return (TIER_TERM_0 / d, TIER_TERM_1 / d, TIER_TERM_2 / d, TIER_TERM_3 / d);
}

// (ownerMinForward, expireMinForward) — nominal; a real sender adds a margin.
get fun getPositionMinForward(): (int, int) {
    return (POSITION_MIN_FORWARD, EXPIRE_MIN_FORWARD);
}
