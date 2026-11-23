tolk 1.4

// ============================================================================
// TON PRIMES — the VESTING LOCK. CONCEPT.md §2 point 4, §3.3, §6 point 3;
// DECISIONS.md D-91, D-100 point 6, D-166.
//
// ONE instance is deployed (D-166): genesis mints 1,000,000 PRIMES here for the
// governed treasury contract (D-100 point 6's half; the operator's instance is
// deleted — the operator buys PRIMES by minting like anyone). It releases in
// FOUR equal tranches (D-91): 25% at `startTime`, then 25% every 90 days, the
// last at day 270. The treasury spends what arrives through `distribute()`
// (D-168: PRIMES staking).
// Opcodes: /shared/opcodes.ts `VESTING`. Wire format: /shared/schemas/vesting.tlb.
//
// THERE IS NO ADMIN SURFACE, AND THAT IS THE ENTIRE POINT.
//   * No owner field. No cancel. No pause. No re-schedule. No beneficiary
//     change. A vest whose schedule can be altered by the party it constrains is
//     theatre, and this contract is greppable proof it is not: the only address
//     any outbound message can name is `beneficiary`, which is fixed at deploy.
//   * `release` is PERMISSIONLESS — the venue timelock's `execute` precedent
//     (primes_venue_timelock.tolk). Anyone may push a matured tranche; it always
//     lands on the same address either way. Nobody can withhold
//     execution of a schedule that is already public, and cannot accelerate it.
//   * THE CONSEQUENCE, STATED RATHER THAN DISCOVERED: if the beneficiary key is
//     lost, the unreleased remainder is unrecoverable forever. That is not a gap
//     in this file, it is what "no admin surface" costs, and the alternative — a
//     recovery path — is the withdraw path §8 forbids everywhere else.
//
// IT TOUCHES NO ECONOMIC STATE. Nothing here mints, burns, or moves GRAM beyond
// the gas riding its own messages. `S` (cumulative emission) counted this
// allocation at genesis and does not move (§3.3); `T` never saw it. So `p_f =
// T/S` is IDENTICAL with and without this contract — the vest changes who can
// sell and when, never anybody's floor. It holds a jetton wallet and ZERO GRAM
// liability, so it does not appear in the §3.4 solvency check at all.
//
// THE CLOCK STARTS AT `set_wallet`, NOT AT DEPLOY. The one-shot wallet bootstrap
// (the D21 family: a TEP-74 wallet is addressed by its owner, so it cannot live
// in its owner's own address-determining init data) is also what stamps
// `startTime`. Two reasons: the clock then starts when the tokens are actually
// in custody rather than at a deploy timestamp that may precede funding, and it
// removes a deploy-data timestamp from a repo that has already been bitten by
// testnet clock skew. Delaying the bootstrap only delays the beneficiary's own
// PRIMES, and `getVesting` reports the stamp, so the choice is on-chain either
// way.
//
// EXACT, WITH NO DUST. Release is computed as a TARGET — `totalAmount ·
// unlocked / VEST_TRANCHES` — and the transfer is the difference against what
// has already gone out, rather than a fixed per-tranche amount. Integer division
// truncates the intermediate targets, but the final one is `totalAmount ·
// 4 / 4 = totalAmount` exactly, so the last tranche absorbs every truncated
// remainder and the contract always empties.
//
// `1,000,000 · 10^9` divides by 4 with no remainder, so no tranche truncates
// at THIS allocation. The target form stays anyway: it is what
// makes catch-up one message (see below) and what keeps the contract exact for
// any `totalAmount` a future deployment declares. A fixed `total / VEST_TRANCHES`
// per-tranche send would be correct today and silently strand dust the first
// time either number changed.
//
// CATCH-UP IS ONE MESSAGE. `unlocked` is derived from the clock, not counted up
// per call, so a caller who ignores the contract for a year releases every
// matured tranche in a single `release` — there is no queue to drain and no way
// to fall behind irrecoverably.
// ============================================================================

// 0.1 GRAM: one jetton-wallet transfer hop plus the destination wallet's deploy,
// exactly as primes_bounty_vault.tolk and primes_stake.tolk size the same send.
const TRANSFER_GAS: coins = 100000000;

// ---------------------------------------------------------------------------
// 0.05 GRAM RIDING THE TRANSFER AS `forwardTonAmount`. D-100 point 6.
//
// WHY IT EXISTS. The beneficiary is `primes_treasury.tolk` — a CONTRACT — and
// `primes_jetton_wallet.tolk` emits a `transfer_notification` only when the
// forwarded amount is POSITIVE. With `forwardTonAmount: 0` a tranche would land
// in the treasury's PRIMES jetton wallet and never reach the treasury's books:
// `getTreasuryBalances().primesBalance` would stay 0, and with it every
// `distribute()` budget (D-168). Nothing re-reads the wallet, so there is no
// reconcile path; the forward is the only way the treasury learns.
//
// WHO PAYS. `release` is PERMISSIONLESS, so the CALLER funds this, not the
// lock — the assert below is what makes an underfunded call a refusal rather
// than a `releasedAmount` advanced against PRIMES that never moved.
//
// EMPTY `forwardPayload` IS CORRECT, VERIFIED NOT ASSUMED. `primes_treasury.tolk`
// `TransferNotification` branches on the SENDER: a notification from its own
// PRIMES wallet is credited with no payload read and no minimum value check
// (the `TREASURY_MIN_FORWARD` assert sits after that branch returns, on the LP
// edge). So there is no tag to carry, and inventing one would be a wire format
// this lane does not own.
//
// WHY 0.05 AND NOT 0.005, MEASURED IN @ton/sandbox ON THE REAL PATH. Released
// tranche 0 into a treasury whose PRIMES wallet does not exist yet — the
// expensive case, because the hop deploys it: the lock's 0.15 arrives at its own
// wallet as 0.1498, reaches the destination wallet as 0.1490 (deploy included),
// and the notification arrives at the treasury carrying 0.04989 against a
// handler that burns 0.000396. That is a ~125x margin, and it is deliberate
// rather than sloppy: the notification is sent NoBounce, so if it ever arrives
// underfunded the PRIMES are credited to the wallet, the treasury never learns,
// and there is no reconcile path — the exact failure this constant exists to
// end, reintroduced by a tighter number. Overpaying 0.05 GRAM four times in the
// life of the protocol is the cheap side of that asymmetry. Shaving it is not.
//
// BOUNCE IS UNCHANGED, AND THAT IS ARITHMETIC NOT ASSERTION. `onBouncedMessage`
// rolls back by `original.amount` — the PRIMES field of the bounced
// `JettonTransfer`, which this change does not touch. The GRAM riding the message
// is not in that arithmetic and never was. The one thing a bigger value does
// change is WHICH failures are possible: the destination wallet must have enough
// left after its own gas to emit the notification, or its transaction fails in
// the action phase and the whole hop bounces. That is why 0.05 sits on top of
// the 0.1 hop rather than being carved out of it — the hop keeps exactly the
// budget it was measured for, and `TreasuryVesting.spec.ts` proves the end-to-end
// path (lock -> wallet -> wallet -> treasury books) at this figure.
// ---------------------------------------------------------------------------
const NOTIFY_GAS: coins = 50000000;

// D-91. FOUR unlocks of 25%: index 0 at `startTime`, index i at
// `startTime + i·90d`, the last at day 270 = 9 months. These are a DISCLOSURE
// SCHEDULE, not economic parameters — nothing in the ratchet, the split or the sim reads
// them (CLAUDE.md rule 3 is not engaged; `shared/params.json` records them for
// the deploy script and the UI, not as a simulation output).
const VEST_TRANCHES: int = 4;
const VEST_INTERVAL: int = 7776000; // 90 days

struct VestingConfigB {
    // This contract's OWN PRIMES wallet. One-shot `set_wallet` from the genesis
    // script; also the moment `startTime` is stamped (see header).
    jettonWalletAddr: address
    walletSet: uint8
}

struct VestingConfig {
    // THE ONLY ADDRESS ANY OUTBOUND MESSAGE HERE CAN EVER NAME. Fixed at deploy;
    // no message in this file carries a destination field, so there is nothing
    // to point somewhere else.
    beneficiary: address
    jettonMasterAddr: address
    genesisScriptAddr: address
    b: Cell<VestingConfigB>
}

struct Storage {
    // The full allocation, declared at deploy. §9.1: a reader checks it against
    // this contract's own jetton wallet balance —
    // `totalAmount − releasedAmount ≈ balance` — costing one get-call and
    // trusting none of this contract's arithmetic, the same shape the bounty
    // vault uses (§3.3).
    totalAmount: coins
    releasedAmount: coins
    // 0 until `set_wallet`. Every schedule read checks this first.
    startTime: uint64
    cfg: Cell<VestingConfig>
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// Inbound, one-shot, genesis script only. Also starts the clock.
struct (0x95000001) SetWallet {
    queryId: uint64
    jettonWalletAddr: address
}

// Inbound, PERMISSIONLESS. Pushes every matured-but-unreleased tranche to the
// fixed beneficiary in one transfer.
struct (0x95000002) Release {
    queryId: uint64
}

// Outbound, to this contract's own jetton wallet — TEP-74 transfer.
// GAUNTLET V4: `customPayload`/`forwardPayload` are `cell?` — see
// `primes_jetton_wallet.tolk`'s header and `primes_bounty_vault.tolk`'s
// identical note; this contract likewise never sends a real payload.
struct (0x0f8a7ea5) JettonTransfer {
    queryId: uint64
    amount: coins
    destination: address
    responseAddr: address
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: cell?
}

type AllowedMessage = SetWallet | Release;

// How many of the 4 unlocks have matured. Index 0 matures at `startTime`
// itself, so a live clock always yields at least 1.
fun unlockedCount(startTime: int): int {
    if (startTime == 0) { return 0; }
    val now = blockchain.now();
    if (now < startTime) { return 0; }
    val n = (now - startTime) / VEST_INTERVAL + 1;
    return n > VEST_TRANCHES ? VEST_TRANCHES : n;
}

// Cumulative entitlement at `unlocked` unlocks. Exact at the terminus by
// construction: `totalAmount · 4 / 4 == totalAmount`.
fun releaseTarget(totalAmount: int, unlocked: int): int {
    return totalAmount * unlocked / VEST_TRANCHES;
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetWallet => {
            var cfg = storage.cfg.load();
            var b = cfg.b.load();
            assert (in.senderAddress == cfg.genesisScriptAddr) throw 100; // wrong_sender
            assert (b.walletSet == 0) throw 104;                          // already_processed
            b.jettonWalletAddr = msg.jettonWalletAddr;
            b.walletSet = 1;
            cfg.b = b.toCell();
            storage.cfg = cfg.toCell();
            // THE CLOCK STARTS HERE, not at deploy. See the header.
            storage.startTime = blockchain.now() as uint64;
            storage.save();
        }

        Release => {
            val cfg = storage.cfg.load();
            val b = cfg.b.load();
            assert (b.walletSet == 1) throw 1140; // vest_wallet_unset

            val unlocked = unlockedCount(storage.startTime);
            val target = releaseTarget(storage.totalAmount, unlocked);
            // Covers both "the clock has not started" and "no new tranche has
            // matured since the last release" — the same fact from a caller's
            // point of view, and neither is an error worth two codes.
            assert (target > storage.releasedAmount) throw 1141; // vest_nothing_due
            // The caller funds the transfer hop AND the notification riding it
            // (see NOTIFY_GAS). Refusing an underfunded release beats advancing
            // `releasedAmount` and failing to pay it out.
            assert (in.valueCoins >= TRANSFER_GAS + NOTIFY_GAS) throw 103; // insufficient_value

            val amount = target - storage.releasedAmount;
            storage.releasedAmount = target;
            storage.save();

            createMessage({
                bounce: BounceMode.RichBounce,
                // The hop plus what the notification carries — primes_jetton_master
                // .tolk's `deployAndCredit` shape (`value: hop + forwardTonAmount`).
                value: TRANSFER_GAS + NOTIFY_GAS,
                dest: b.jettonWalletAddr,
                body: (JettonTransfer {
                    queryId: msg.queryId,
                    amount: amount,
                    // THE ONLY DESTINATION THIS CONTRACT CAN EVER PAY. Fixed at
                    // deploy, unreachable by any message. `release` being
                    // permissionless is therefore harmless: whoever calls it,
                    // the PRIMES go to the same place.
                    destination: cfg.beneficiary,
                    responseAddr: cfg.beneficiary,
                    customPayload: null,
                    // POSITIVE, ALWAYS — this is the whole fix. A contract
                    // beneficiary (the treasury, D-100 point 6) only learns a
                    // tranche arrived through the `transfer_notification` that
                    // primes_jetton_wallet.tolk emits when this is > 0. See
                    // NOTIFY_GAS for why it is not conditional on the
                    // beneficiary's kind and why the payload stays empty.
                    forwardTonAmount: NOTIFY_GAS,
                    forwardPayload: null,
                }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // D-53/B11.1's pattern, as primes_stake.tolk applies it: a bounced
    // `JettonTransfer` means the PRIMES never left our wallet (the wallet
    // restores its own balance on bounce — primes_jetton_wallet.tolk), but
    // `release` already advanced `releasedAmount`. Roll it back so the tranche
    // is releasable again; `amount` is field 2 of `JettonTransfer`, well inside
    // what `BounceMode.RichBounce` preserves.
    //
    // No idempotency guard is needed here where the stake sink needed one: each
    // `release` sends exactly one message and each message bounces at most once,
    // so there is no second bounce carrying the same amount. The `>=` check is
    // an underflow guard on a `coins` field, not a duplicate-bounce guard.
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    val opcode = rich.originalBody.beginParse().loadUint(32);
    if (opcode == 0x0f8a7ea5) {
        val original = lazy JettonTransfer.fromCell(rich.originalBody);
        var storage = lazy Storage.load();
        if (storage.releasedAmount >= original.amount) {
            storage.releasedAmount -= original.amount;
            storage.save();
        }
    }
}

// ---------------------------------------------------------------------------
// Get-methods (§9.1 — every number the UI shows maps to one of these)
// ---------------------------------------------------------------------------

// (beneficiary, startTime, totalAmount, releasedAmount, unlocked, tranches,
//  nextUnlockAt).
//
// `unlocked`/`tranches` is the shape the frontend rule asks for: a bounded
// quantity with a known floor and ceiling, drawn as 4 segments lit in sequence
// rather than printed as a fraction, with `nextUnlockAt` driving the countdown
// arc on the unlit one. `nextUnlockAt` is 0 when the clock has not started and 0
// again once the schedule is complete — two different states that the caller
// separates by `startTime`, deliberately, rather than by a sentinel.
//
// `releasedAmount` is what has been PUSHED OUT, not what has matured: a matured
// tranche nobody has called `release` for is visible as the gap between
// `releaseTarget(unlocked)` and this number, and drawing them as the same thing
// would claim a transfer that has not happened.
get fun getVesting(): (address, int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    val unlocked = unlockedCount(storage.startTime);
    var nextUnlockAt = 0;
    if (storage.startTime != 0 && unlocked < VEST_TRANCHES) {
        nextUnlockAt = storage.startTime + unlocked * VEST_INTERVAL;
    }
    return (
        cfg.beneficiary,
        storage.startTime,
        storage.totalAmount,
        storage.releasedAmount,
        unlocked,
        VEST_TRANCHES,
        nextUnlockAt,
    );
}

// The schedule's declared shape, readable without arithmetic:
// (tranches, intervalSeconds, releasableNow). `releasableNow` is what a
// `release` call would transfer at this instant — 0 when nothing has matured —
// so a UI can show the button's effect from chain state rather than recomputing
// the schedule client-side (§9.1).
get fun getVestingSchedule(): (int, int, int) {
    val storage = lazy Storage.load();
    val unlocked = unlockedCount(storage.startTime);
    val target = releaseTarget(storage.totalAmount, unlocked);
    val releasable = target > storage.releasedAmount ? target - storage.releasedAmount : 0;
    return (VEST_TRANCHES, VEST_INTERVAL, releasable);
}

get fun getVestingConfig(): (address, address, address, int) {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    val b = cfg.b.load();
    return (cfg.beneficiary, cfg.jettonMasterAddr, b.jettonWalletAddr, b.walletSet);
}
