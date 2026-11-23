tolk 1.4

// ============================================================================
// TON PRIMES — the STAKE MASTER. CONCEPT.md §5.3; DECISIONS.md D-168.
// Opcodes: /shared/opcodes.ts `STAKE`. Wire format: /shared/schemas/stake.tlb.
// Child: /contracts/contracts/primes_stake_position.tolk (one per staking wallet).
// Parameters: /shared/params.json `staking`.
//
// WHAT THIS CONTRACT IS. A wallet locks PRIMES for a fixed term (30 d / 3 m /
// 6 m / 1 y) and earns PRIMES while the term runs. The rewards are PRIMES the
// governed treasury already holds — its vest — sent here once per epoch by the
// treasury's permissionless `distribute()` (§5.5.3) and STREAMED to stakers over
// the following epoch through an accumulator, pro rata to `amount × tierWeight`.
// Its purpose is a SUPPLY LOCK (D-168 Q1), not a rebate: nothing here touches
// `k`, `S`, `T`, the split or any GRAM pool.
//
// WHY TWO CONTRACTS. Config 43's 65,536-cell account ceiling kills a positions
// dictionary on one account around 20,000 positions — the finding that put
// `owed` on the per-prime items and LP positions on `primes_lp_position.tolk`.
// So this contract holds GLOBAL state (the stream, the accumulator, the totals)
// and one child per wallet holds that wallet's positions. The child's address is
// a hash of (its code, owner, this contract, clockDivisor): when a `settle`
// arrives carrying `owner`, this contract re-derives `positionAddress(owner)` and
// compares. That is the whole authentication, exactly as on the treasury.
//
// ---------------------------------------------------------------------------
// THE STREAM (§5.3)
// ---------------------------------------------------------------------------
//   end  = min(now, streamEnd);  dt = end − lastAccrualTime
//   amt  = min(streamRate · dt, streamRemaining)            (totalWeight > 0)
//   rewardPerWeightAcc += amt · ACC_SCALE / totalWeight
//   streamRemaining −= amt;  unclaimedTotal += amt
//
// A budget arriving from the treasury accrues first, then re-rates the stream:
// `streamRemaining += budget; streamRate = streamRemaining / interval;
// streamEnd = now + interval`. WITH NO STAKERS NOTHING ACCRUES (D-168 Q16): the
// budget stays in `streamRemaining` and rolls into the next epoch's rate.
// Truncation (the rate, the accumulator step, each position's share) always
// rounds DOWN, so the remainder stays in `streamRemaining` or `unclaimedTotal`
// and nothing is ever over-promised.
//
// ---------------------------------------------------------------------------
// EARNING STOPS AT `maturesAt` — and nobody sends a message at maturity
// ---------------------------------------------------------------------------
// `totalWeight` still counts a matured position until something touches it. The
// one settle function below prorates: on the first settle at or past
// `maturesAt`, the position keeps `full × (maturesAt − lastSettleTime) /
// (now − lastSettleTime)` of what the accumulator says, the EXCESS RETURNS TO
// `streamRemaining` (so conservation stays exact — it goes back to the stream,
// not to anybody), and its weight leaves `totalWeight`. `expire(id)` is the
// permissionless poke that makes that window minutes rather than days.
//
// ---------------------------------------------------------------------------
// THE SETTLE HANDSHAKE — copied from the treasury's claim handshake, bias and all
// ---------------------------------------------------------------------------
//   owner → child      validates owner, position, clock; sets `inFlight = 1`;
//                      forwards `settle{…, mode}`.
//   child → here       re-derive the child, accrue, settle, then TWO messages:
//                      (a) `stake_settled` back to the child — new debt, new
//                          settle time, expiry, banked, and the clearing of
//                          `inFlight` (or the deletion, on a withdraw);
//                      (b) the PRIMES to the owner, if any.
//
// WHAT A BOUNCE COSTS AT EACH HOP:
//   * `settle` bounces (this contract threw): nothing moved; the child's bounce
//     handler clears `inFlight` and the owner retries.
//   * `stake_settled` bounces (the child threw): the PRIMES went out and the
//     child's debt did not advance. `inFlight` stays set, so the position is
//     permanently unsettleable rather than doubly paid. That is the direction
//     this handshake is deliberately biased in.
//   * a REWARD transfer bounces: the child's debt already advanced; the PRIMES
//     go back to `streamRemaining` and are re-streamed to every staker. The
//     claimer loses that claim; nobody is paid twice. Reachable only if 0.1 GRAM
//     cannot deploy the owner's jetton wallet.
//   * a WITHDRAW transfer bounces: principal and reward come home; the forward
//     payload carries (positionId, tier, principal) so `restore_stake` puts the
//     position back MATURED and EXPIRED with the reward BANKED separately, and
//     the owner retries.
//
// ---------------------------------------------------------------------------
// NO ADMIN, NO OWNER, NO GRAM LIABILITY (§3.4, §8)
// ---------------------------------------------------------------------------
// PRIMES leave this contract by three routes and no fourth: (a) a position's own
// reward to its own owner, (b) a matured position's principal to its own owner
// (ST-3), (c) a refund of an unrecognised deposit to whoever sent it. No message
// names a recipient. The only one-shot is `set_wallet`, the D21-family
// bootstrap. It holds no GRAM anybody is owed; the only GRAM here is the gas
// riding the message that asked it to act.
//
// Every figure a UI shows maps to a get-method below (§9.1). ST-1 is
// `getStakeSolvency()` against the wallet's `get_wallet_data`.
// ============================================================================

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------

// 0.1 GRAM: one jetton-wallet transfer hop plus the destination wallet's deploy,
// the figure every jetton-custody contract in this repo sizes the same send at.
const TRANSFER_GAS: coins = 100000000;
// 0.05 GRAM: one hop to a position child, including its deploy on a first stake
// (the credit carries the child's code as state-init).
const CHILD_GAS: coins = 50000000;
// What a STAKE's notification must carry: the worst of its outcomes — a credit
// that deploys the child, or a refund transfer — published as one figure, the
// `TREASURY_MIN_FORWARD` precedent. A real sender adds a margin (CLAUDE.md).
const STAKE_MIN_FORWARD: coins = TRANSFER_GAS + CHILD_GAS;   // 0.15 GRAM

// ---------------------------------------------------------------------------
// Parameters — shared/params.json `staking` (DECISIONS.md D-168)
// Each names the key it mirrors; SimCrossCheck.spec.ts catches drift.
// ---------------------------------------------------------------------------

// `staking.acc_scale` = 2^64.
const ACC_SCALE: int = 18446744073709551616;
// `staking.epoch_seconds` = 2592000 (30 days). The stream's length; divided by
// the D-139 clock divisor like every wall clock here.
const EPOCH_SECONDS: int = 2592000;
// `staking.tier_weights` = [5, 6, 7, 8]. Share = `amount × weight / totalWeight`.
const TIER_WEIGHT_0: int = 5;   // 30 days
const TIER_WEIGHT_1: int = 6;   // 3 months
const TIER_WEIGHT_2: int = 7;   // 6 months
const TIER_WEIGHT_3: int = 8;   // 1 year
// `staking.tier_term_seconds`. ENFORCED on the child (it holds the clock);
// mirrored here so `getTierTerms()` publishes the ladder from the master too.
const TIER_TERM_0: int = 2592000;
const TIER_TERM_1: int = 7776000;
const TIER_TERM_2: int = 15552000;
const TIER_TERM_3: int = 31536000;
const TIER_MAX: int = 3;

// 2^120 — the treasury's and the ratchet's overflow bound, for the same reason:
// products must stay under 2^256 on a 257-bit signed VM.
const MUL_OPERAND_BOUND: int = 1329227995784915872903807060280344576;

// The two `forwardPayload` tags this contract reads. Declared once in
// `shared/opcodes.ts` (`STAKE_ACTION_LOCK`, `STAKE_ACTION_BUDGET`); four ASCII
// bytes each so a raw body dump reads.
const STAKE_ACTION_LOCK: int = 0x53544b4c;    // "STKL" + tier:uint8
const STAKE_ACTION_BUDGET: int = 0x53424754;  // "SBGT", from the treasury only

// `settle` modes.
const SETTLE_RELOCK: int = 1;
const SETTLE_WITHDRAW: int = 2;
const SETTLE_EXPIRE: int = 3;

// `queryId` purpose tags on outbound transfers, `(tag << 56) | id`, so
// `onBouncedMessage` can tell the arms apart from the body alone.
const QTAG_REWARD: int = 1;
const QTAG_WITHDRAW: int = 2;
const QTAG_REFUND: int = 3;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// 128+128+40+124+128+40+124+124 = 836 bits.
struct Stream {
    // Σ `amount × tierWeight` over positions that are still EARNING — a matured
    // position leaves it at its first settle past `maturesAt`.
    totalWeight: uint128
    // Σ `amt · ACC_SCALE / totalWeight`. Monotone non-decreasing.
    rewardPerWeightAcc: uint128
    lastAccrualTime: uint40
    // PRIMES received as budget and not yet streamed.
    streamRemaining: coins
    // nano-PRIMES per second, `streamRemaining / interval` at the last budget.
    streamRate: uint128
    streamEnd: uint40
    // Σ principal in custody. ST-1's first term.
    lockedTotal: coins
    // Streamed to positions and not yet paid out (banked included).
    unclaimedTotal: coins
}

// Cumulative, for §9.1 and for an indexer to reconcile against.
struct Totals {
    budgetsIn: coins
    claimedTotal: coins
    livePositions: uint32
    stakeEvents: uint32
    budgetEvents: uint32
}

struct StakeWallets {
    // This contract's OWN PRIMES wallet — D21-family circular bootstrap.
    jettonWalletAddr: address
    // THE TREASURY, the one sender whose `SBGT` budget is accepted. Bootstrapped
    // rather than deploy data because the treasury's own deploy data names THIS
    // contract (`distribute()`'s recipient), so one side of the pair has to be
    // set after both addresses exist — and it is this one.
    treasuryAddr: address
    walletSet: uint8
    genesisScriptAddr: address
}

struct StakeConfig {
    jettonMasterAddr: address
    // D-139 — the test clock. 1 is mainnet. Inherited by every child (it is part
    // of the child's address).
    clockDivisor: uint16
    // primes_stake_position.tolk's code. Fixed at deploy; no message replaces it.
    positionCode: cell
    w: Cell<StakeWallets>
}

struct Storage {
    stream: Cell<Stream>
    totals: Cell<Totals>
    cfg: Cell<StakeConfig>
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

fun StakeConfig.clockDiv(self): int {
    return self.clockDivisor == 0 ? 1 : self.clockDivisor;
}

fun StakeConfig.intervalSec(self): int {
    return EPOCH_SECONDS / self.clockDiv();
}

fun tierWeight(tier: int): int {
    if (tier == 0) { return TIER_WEIGHT_0; }
    if (tier == 1) { return TIER_WEIGHT_1; }
    if (tier == 2) { return TIER_WEIGHT_2; }
    if (tier == 3) { return TIER_WEIGHT_3; }
    return 0;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Inbound, one-shot, genesis script only.
struct (0x91000001) SetWallet {
    queryId: uint64
    jettonWalletAddr: address
    treasuryAddr: address
}

// Inbound, from this contract's own PRIMES wallet: a stake, a budget, or a
// stray to refund.
struct (0x7362d09c) TransferNotification {
    queryId: uint64
    amount: coins
    sender: address
    // TEP-74 `Either Cell ^Cell`, read as a raw tail and normalised at the read
    // site (R20) — this contract is notified by wallets it does not control.
    forwardPayload: RemainingBitsAndRefs
}

// Inbound, from the owner's OWN child. 32+64+267+32+124+8+40+256+40+8+124+8+8 =
// 1011 bits.
struct (0x91000002) Settle {
    queryId: uint64
    owner: address
    positionId: uint32
    amount: coins
    tier: uint8
    maturesAt: uint40
    // uint256, not coins: `weight · acc / ACC_SCALE` counts the accumulator's
    // whole history under this position's weight, which is not bounded by any
    // PRIMES balance when an early epoch's `totalWeight` was tiny.
    rewardDebt: uint256
    lastSettleTime: uint40
    expired: uint8
    banked: coins
    mode: uint8
    // SETTLE_RELOCK only; the child has already applied the downgrade rule.
    newTier: uint8
}

// Outbound, to the child. Deploys it on a first stake.
struct (0x91000010) StakeCredit {
    queryId: uint64
    amount: coins
    tier: uint8
    // Pinned to the accumulator AFTER this message's accrue: a zero debt would
    // claim the accumulator's whole history.
    rewardDebt: uint256
}

// Outbound, to the child: the reply half of `settle`. Clears `inFlight`, or
// deletes the position when `mode == SETTLE_WITHDRAW`.
struct (0x91000011) StakeSettled {
    queryId: uint64
    positionId: uint32
    mode: uint8
    newTier: uint8
    rewardDebt: uint256
    expired: uint8
    banked: coins
    // The instant `rewardDebt` was pinned at — the next settle's proration
    // window opens here, not at whenever the reply happens to land.
    settledAt: uint40
}

// Outbound, to the child, BOUNCE RECOVERY ONLY: a withdraw transfer bounced.
struct (0x91000012) RestoreStake {
    queryId: uint64
    positionId: uint32
    amount: coins
    tier: uint8
    banked: coins
}

// Outbound, to this contract's own jetton wallet — TEP-74 transfer.
struct (0x0f8a7ea5) JettonTransfer {
    queryId: uint64
    amount: coins
    destination: address
    responseAddr: address
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: cell?
}

type AllowedMessage = SetWallet | TransferNotification | Settle;

// ---------------------------------------------------------------------------
// The child address — the whole authentication
//
// `PositionInit` mirrors the FIRST fields of primes_stake_position.tolk's
// `Storage` in its empty state, byte for byte (the treasury ↔ LP-child
// precedent). `Staking.spec.ts` asserts `getStakePositionAddress(owner)` equals
// the wrapper's derivation, so a field reordered on either side fails the gate.
// ---------------------------------------------------------------------------

struct PositionInit {
    owner: address
    stakeAddr: address
    positions: cell?
    nextId: uint32
    positionCount: uint32
    stakedTotal: coins
    clockDivisor: uint16
}

fun positionStateInit(cfg: StakeConfig, owner: address): AutoDeployAddress {
    return AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState {
            code: cfg.positionCode,
            data: (PositionInit {
                owner: owner,
                stakeAddr: contract.getAddress(),
                positions: null,
                nextId: 0,
                positionCount: 0,
                stakedTotal: 0,
                clockDivisor: cfg.clockDivisor,
            }).toCell(),
        },
    };
}

fun positionAddress(cfg: StakeConfig, owner: address): address {
    return positionStateInit(cfg, owner).calculateAddress();
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

// Brings the accumulator current. Runs first on every state-touching message.
fun accrue(mutate st: Stream) {
    val now = blockchain.now();
    val end: int = now < st.streamEnd ? now : st.streamEnd as int;
    val dt = end - st.lastAccrualTime;
    if (dt > 0 && st.totalWeight > 0 && st.streamRemaining > 0) {
        var amt = st.streamRate * dt;
        if (amt > st.streamRemaining) { amt = st.streamRemaining; }
        // Protects `amt · ACC_SCALE`: 2^120 · 2^64 = 2^184.
        assert (amt < MUL_OPERAND_BOUND) throw 1103;              // stake_overflow
        val nextAcc = st.rewardPerWeightAcc + amt * ACC_SCALE / st.totalWeight;
        // Protects every later `weight · acc`: weight < 2^123, so < 2^243.
        // SKIP, never throw: every message runs this first, so a throw here would
        // lock every principal for good. Only a dust `totalWeight` gets near the
        // bound (a lone 1-nano stake needs ~360M PRIMES streamed); the slice stays
        // in `streamRemaining` exactly as in a no-stakers period (Q16), and real
        // weight joining shrinks the step again.
        if (nextAcc < MUL_OPERAND_BOUND) {
            st.rewardPerWeightAcc = nextAcc as uint128;
            st.streamRemaining -= amt;
            st.unclaimedTotal += amt;
        }
    }
    // D-168 Q16: with no weight the clock still advances and nothing moves — the
    // budget for the quiet period stays in `streamRemaining`.
    if (now > st.lastAccrualTime) { st.lastAccrualTime = now as uint40; }
}

fun debtAt(weight: int, acc: int): int {
    return weight * acc / ACC_SCALE;
}

// THE ONE SETTLE FUNCTION (STAKING_PLAN §3.1 steps 1-3). Returns
// `(paid, nowExpired)` and moves the excess of a matured position back into the
// stream. `st` must already be accrued.
fun settlePosition(mutate st: Stream, amount: int, tier: int, maturesAt: int,
                   rewardDebt: int, lastSettleTime: int, expired: int): (int, int) {
    // An expired position left `totalWeight` at its expiry settle and has earned
    // nothing since; whatever it earned before is in `banked`.
    if (expired == 1) { return (0, 1); }
    val weight = amount * tierWeight(tier);
    val gross = debtAt(weight, st.rewardPerWeightAcc);
    var full = gross > rewardDebt ? gross - rewardDebt : 0;
    // Belt to the in-flight flag's braces: never pay more than has streamed.
    if (full > st.unclaimedTotal) { full = st.unclaimedTotal; }
    val now = blockchain.now();
    if (now < maturesAt) { return (full, 0); }
    // `>=`, not `>`: at `now == maturesAt` the ratio is exactly 1 and the weight
    // must still leave, or a withdraw at that instant would strand it.
    // ponytail: time-prorated tail, exact per-epoch acc checkpoints if disputed
    var paid = 0;
    if (lastSettleTime < maturesAt) {
        paid = full * (maturesAt - lastSettleTime) / (now - lastSettleTime);
    }
    val excess = full - paid;
    st.streamRemaining += excess;
    st.unclaimedTotal -= excess;
    st.totalWeight = (st.totalWeight > weight ? st.totalWeight - weight : 0) as uint128;
    return (paid, 1);
}

// ---------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------

fun sendJetton(walletAddr: address, queryId: int, amount: int, to: address,
               note: cell?) {
    createMessage({
        bounce: BounceMode.RichBounce,
        value: TRANSFER_GAS,
        dest: walletAddr,
        body: (JettonTransfer {
            queryId: queryId,
            amount: amount as coins,
            destination: to,
            // The recipient funded the hop, so the excess is theirs — and this
            // contract never names itself, so no `excesses` reply comes home.
            responseAddr: to,
            customPayload: null,
            forwardTonAmount: 0,
            // Bounce-recovery note on a withdraw only (see the header). With
            // `forwardTonAmount = 0` no notification is raised, so the recipient
            // never reads it.
            forwardPayload: note,
        }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

fun sendToChild(cfg: StakeConfig, owner: address, body: cell) {
    // A plain address: every message on this path answers one the child just
    // sent, so the child exists.
    createMessage({
        bounce: BounceMode.NoBounce,
        value: CHILD_GAS,
        dest: positionAddress(cfg, owner),
        body: body,
    }).send(SEND_MODE_REGULAR);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetWallet => {
            var cfg = storage.cfg.load();
            var w = cfg.w.load();
            assert (in.senderAddress == w.genesisScriptAddr) throw 100; // wrong_sender
            assert (w.walletSet == 0) throw 104;                        // already_processed
            w.jettonWalletAddr = msg.jettonWalletAddr;
            w.treasuryAddr = msg.treasuryAddr;
            w.walletSet = 1;
            cfg.w = w.toCell();
            storage.cfg = cfg.toCell();
            storage.save();
        }

        TransferNotification => {
            val cfg = storage.cfg.load();
            val w = cfg.w.load();
            // THE SENDER CHECK IS THE WHOLE AUTHENTICATION on this edge: a forged
            // notification would record a liability out of nothing.
            assert (w.walletSet == 1) throw 1100;                       // stake_wallet_unset
            assert (in.senderAddress == w.jettonWalletAddr) throw 1102; // stake_wrong_wallet

            var fwd = msg.forwardPayload;
            var p = fwd.remainingBitsCount() >= 1 && fwd.loadBool() ? fwd.loadRef().beginParse() : fwd;
            val action = p.remainingBitsCount() >= 32 ? p.loadUint(32) : 0;

            if (msg.sender == w.treasuryAddr && action == STAKE_ACTION_BUDGET) {
                // A BUDGET (§5.5.3's `distribute()`). Accrue first so the arriving
                // PRIMES cannot be streamed over time that has already passed.
                var st = storage.stream.load();
                accrue(mutate st);
                st.streamRemaining += msg.amount;
                val interval = cfg.intervalSec();
                st.streamRate = (st.streamRemaining / interval) as uint128;
                st.streamEnd = (blockchain.now() + interval) as uint40;
                var t = storage.totals.load();
                t.budgetsIn += msg.amount;
                t.budgetEvents += 1;
                storage.stream = st.toCell();
                storage.totals = t.toCell();
                storage.save();
                return;
            }

            // Refuse before recording or refunding anything we cannot pay to finish.
            assert (in.valueCoins >= STAKE_MIN_FORWARD) throw 103;      // insufficient_value

            // A STAKE: the tag, then `tier:uint8`, from anyone but the treasury
            // (the treasury has no term to serve and nothing to stake).
            if (msg.sender != w.treasuryAddr && action == STAKE_ACTION_LOCK
                && p.remainingBitsCount() >= 8) {
                val tier = p.loadUint(8);
                if (tier <= TIER_MAX) {
                    var st = storage.stream.load();
                    accrue(mutate st);
                    val weight = msg.amount * tierWeight(tier);
                    val nextTotal = st.totalWeight + weight;
                    assert (nextTotal < MUL_OPERAND_BOUND) throw 1103;  // stake_overflow
                    st.totalWeight = nextTotal as uint128;
                    st.lockedTotal += msg.amount;
                    var t = storage.totals.load();
                    t.livePositions += 1;
                    t.stakeEvents += 1;
                    storage.stream = st.toCell();
                    storage.totals = t.toCell();
                    storage.save();
                    createMessage({
                        // NoBounce: the child's credit handler checks the sender
                        // and nothing else, and the deploy is the staker's value.
                        bounce: BounceMode.NoBounce,
                        value: 0,
                        dest: positionStateInit(cfg, msg.sender),
                        body: (StakeCredit {
                            queryId: msg.queryId,
                            amount: msg.amount,
                            tier: tier as uint8,
                            rewardDebt: debtAt(weight, st.rewardPerWeightAcc),
                        }).toCell(),
                    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
                    return;
                }
            }

            // AN UNRECOGNISED PAYLOAD REFUNDS (D-168): a stake with no tier has no
            // term, and keeping a stranger's PRIMES on a typo is not a right this
            // contract was granted. Nothing is recorded, because nothing happened.
            sendJetton(w.jettonWalletAddr, QTAG_REFUND << 56, msg.amount, msg.sender, null);
        }

        Settle => {
            val cfg = storage.cfg.load();
            val w = cfg.w.load();
            assert (w.walletSet == 1) throw 1100;                                  // stake_wallet_unset
            assert (in.senderAddress == positionAddress(cfg, msg.owner)) throw 1101; // stake_not_position
            // An expire moves no PRIMES, so it only has to fund the reply —
            // that is what keeps the keeper's poke cheap.
            val need = msg.mode == SETTLE_EXPIRE ? CHILD_GAS : TRANSFER_GAS + CHILD_GAS;
            assert (in.valueCoins >= need) throw 103;                              // insufficient_value
            assert (msg.mode <= SETTLE_EXPIRE) throw 102;                          // malformed_body

            var st = storage.stream.load();
            accrue(mutate st);
            val (paid, nowExpired) = settlePosition(mutate st, msg.amount, msg.tier,
                msg.maturesAt, msg.rewardDebt, msg.lastSettleTime, msg.expired);

            var t = storage.totals.load();
            var banked = msg.banked + paid;
            var newTier = msg.tier;
            var expired = nowExpired;
            var payout = 0;
            var principal = 0;

            // An EXPIRE banks `paid` on the child (still counted in
            // `unclaimedTotal`); every other mode pays it out with the banked.
            if (msg.mode != SETTLE_EXPIRE) {
                payout = banked;
                banked = 0;
                if (msg.mode == SETTLE_RELOCK) {
                    assert (msg.newTier <= TIER_MAX) throw 102;                    // malformed_body
                    newTier = msg.newTier;
                    // Re-weight: the old weight is still in `totalWeight` unless
                    // the settle above (or an earlier expire) took it out.
                    if (nowExpired == 0) {
                        val oldW = msg.amount * tierWeight(msg.tier);
                        st.totalWeight = (st.totalWeight > oldW ? st.totalWeight - oldW : 0) as uint128;
                    }
                    val newW = msg.amount * tierWeight(newTier);
                    val nextTotal = st.totalWeight + newW;
                    assert (nextTotal < MUL_OPERAND_BOUND) throw 1103;             // stake_overflow
                    st.totalWeight = nextTotal as uint128;
                    expired = 0;
                } else if (msg.mode == SETTLE_WITHDRAW) {
                    // The child asserted maturity, so `settlePosition` expired it
                    // and its weight is already out.
                    principal = msg.amount;
                    st.lockedTotal -= principal;
                    t.livePositions -= 1;
                }
                st.unclaimedTotal -= payout;
                t.claimedTotal += payout;
            }
            val debt = debtAt(msg.amount * tierWeight(newTier), st.rewardPerWeightAcc);
            storage.stream = st.toCell();
            storage.totals = t.toCell();
            storage.save();

            // (a) the reply — FIRST, and the flag it clears is what makes a double
            // settle impossible even if (b) fails.
            sendToChild(cfg, msg.owner, (StakeSettled {
                queryId: msg.queryId,
                positionId: msg.positionId,
                mode: msg.mode,
                newTier: newTier as uint8,
                rewardDebt: debt,
                expired: expired as uint8,
                banked: banked as coins,
                settledAt: blockchain.now() as uint40,
            }).toCell());

            // (b) the PRIMES — ONE transfer, principal and reward together.
            if (principal > 0 || payout > 0) {
                if (msg.mode == SETTLE_WITHDRAW) {
                    sendJetton(w.jettonWalletAddr, (QTAG_WITHDRAW << 56) | msg.positionId,
                               principal + payout, msg.owner,
                               beginCell().storeUint(msg.positionId, 32).storeUint(msg.tier, 8)
                                   .storeCoins(principal).endCell());
                } else {
                    sendJetton(w.jettonWalletAddr, QTAG_REWARD << 56, payout, msg.owner, null);
                }
            }
        }

        else => {
            // A bare top-up (rent) is accepted; nothing else is.
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// ---------------------------------------------------------------------------
// Bounces — the two paid arms; see the header for what each costs
// ---------------------------------------------------------------------------

fun onBouncedMessage(in: InMessageBounced) {
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var s = rich.originalBody.beginParse();
    if (s.loadUint(32) != 0x0f8a7ea5) { return; }
    val original = lazy JettonTransfer.fromCell(rich.originalBody);
    val tag = original.queryId >> 56;
    var storage = lazy Storage.load();

    if (tag == QTAG_REWARD) {
        // The child's debt already advanced; the reward goes back to the stream
        // and is re-streamed to every staker. ST-2 stays exact.
        var st = storage.stream.load();
        var t = storage.totals.load();
        st.streamRemaining += original.amount;
        t.claimedTotal -= original.amount;
        storage.stream = st.toCell();
        storage.totals = t.toCell();
        storage.save();
        return;
    }

    if (tag == QTAG_WITHDRAW) {
        // The child already deleted the position. Put principal back in custody
        // and the reward back in `unclaimedTotal`, and restore the position on
        // the child MATURED, EXPIRED, with the reward BANKED — so the owner's
        // retry pays both again, separately accounted.
        var note = original.forwardPayload!.beginParse();
        val positionId = note.loadUint(32);
        val tier = note.loadUint(8);
        val principal = note.loadCoins();
        val reward = original.amount - principal;
        var st = storage.stream.load();
        var t = storage.totals.load();
        st.lockedTotal += principal;
        st.unclaimedTotal += reward;
        t.claimedTotal -= reward;
        t.livePositions += 1;
        storage.stream = st.toCell();
        storage.totals = t.toCell();
        storage.save();
        sendToChild(storage.cfg.load(), original.destination, (RestoreStake {
            queryId: original.queryId,
            positionId: positionId as uint32,
            amount: principal as coins,
            tier: tier as uint8,
            banked: reward as coins,
        }).toCell());
        return;
    }

    // QTAG_REFUND: the PRIMES stay in our wallet with nothing recorded against
    // them — a surplus over ST-1's right-hand side, never a deficit. The same
    // documented limitation every refunding sink in this repo carries.
}

// ---------------------------------------------------------------------------
// Get-methods (§9.1 — every number the UI shows maps to one of these)
// ---------------------------------------------------------------------------

// ST-1 IN ONE GET-CALL: (lockedTotal, streamRemaining, unclaimedTotal). The
// wallet's `get_wallet_data` balance must be at least their sum.
get fun getStakeSolvency(): (int, int, int) {
    val storage = lazy Storage.load();
    val st = storage.stream.load();
    return (st.lockedTotal, st.streamRemaining, st.unclaimedTotal);
}

// (streamRate, streamRemaining, streamEnd, lastAccrualTime, rewardPerWeightAcc,
//  totalWeight, accScale) — as of the last state-touching message.
get fun getStakeStream(): (int, int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val st = storage.stream.load();
    return (st.streamRate, st.streamRemaining, st.streamEnd, st.lastAccrualTime,
            st.rewardPerWeightAcc, st.totalWeight, ACC_SCALE);
}

// The accumulator as the NEXT message would see it, without writing it. Feed it
// to the child's `getClaimable(id, acc)` — that is how a client shows claimable
// PRIMES from chain state without reimplementing the stream.
get fun getAccNow(): int {
    val storage = lazy Storage.load();
    var st = storage.stream.load();
    accrue(mutate st);
    return st.rewardPerWeightAcc;
}

// (budgetsIn, claimedTotal, lockedTotal, livePositions, stakeEvents,
//  budgetEvents). ST-2: budgetsIn == claimedTotal + unclaimedTotal +
//  streamRemaining.
get fun getStakeTotals(): (int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val st = storage.stream.load();
    val t = storage.totals.load();
    return (t.budgetsIn, t.claimedTotal, st.lockedTotal, t.livePositions,
            t.stakeEvents, t.budgetEvents);
}

// The four lock terms, DIVIDED by the clock divisor — what the child enforces.
get fun getTierTerms(): (int, int, int, int) {
    val storage = lazy Storage.load();
    val d = storage.cfg.load().clockDiv();
    return (TIER_TERM_0 / d, TIER_TERM_1 / d, TIER_TERM_2 / d, TIER_TERM_3 / d);
}

get fun getTierWeights(): (int, int, int, int) {
    return (TIER_WEIGHT_0, TIER_WEIGHT_1, TIER_WEIGHT_2, TIER_WEIGHT_3);
}

get fun getStakePositionAddress(owner: address): address {
    val storage = lazy Storage.load();
    return positionAddress(storage.cfg.load(), owner);
}

// The nominal GRAM a stake's notification must carry (`forward_ton_amount`).
get fun getStakeMinForward(): int {
    return STAKE_MIN_FORWARD;
}

// (jettonMasterAddr, jettonWalletAddr, treasuryAddr, walletSet, clockDivisor,
//  interval).
get fun getStakeConfig(): (address, address, address, int, int, int) {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    val w = cfg.w.load();
    return (cfg.jettonMasterAddr, w.jettonWalletAddr, w.treasuryAddr, w.walletSet,
            cfg.clockDiv(), cfg.intervalSec());
}
