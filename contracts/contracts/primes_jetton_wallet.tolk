tolk 1.4

// ============================================================================
// TON PRIMES — PRIMES jetton wallet (TEP-74, standard shape).
// Phase 3, IMPLEMENTATION_PLAN.md §3 build step 2. Storage:
// docs/engineering-spec.md §4.4 ("Wallet: standard TEP-74, unmodified").
// ============================================================================

struct Storage {
    balance: coins
    owner: address
    jettonMaster: address
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

fun walletInitData(owner: address, jettonMaster: address): cell {
    return (Storage { balance: 0, owner: owner, jettonMaster: jettonMaster }).toCell();
}

fun siblingWalletAddress(ownerAddr: address, jettonMaster: address, walletCode: cell): address {
    return (AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState { code: walletCode, data: walletInitData(ownerAddr, jettonMaster) },
    }).calculateAddress();
}

// GAUNTLET V4: `responseAddr` and `forwardPayload` are internal-only —
// InternalTransfer is wallet-to-wallet, never sent or read by anything outside
// `primes_jetton_wallet.tolk` itself, so both ends of this message are always
// this same code. `Transfer`'s handler NORMALIZES whatever Either-encoded
// `forwardPayload` a real sender attached into a definite ref cell before
// building this struct (see its own comment), so this stays the simple
// always-a-ref shape rather than repeating TEP-74's `Either Cell ^Cell` here —
// the two other contracts this wallet notifies downstream (`TransferNotification`
// below) already assume that ref shape, and preserving it end-to-end is what
// keeps this fix from rippling into every contract that reads a proceeds
// notification. `responseAddr` stays a plain `address`, i.e. non-null, for the
// same reason: `Transfer`'s own handler is the only sender and only forwards
// a null one when there truly is nothing to notify (see below).
struct (0x178d4519) InternalTransfer {
    queryId: uint64
    amount: coins
    from: address
    responseAddr: address?
    forwardTonAmount: coins
    forwardPayload: cell
}

// TEP-74's transfer opcode is 0x0f8a7ea5 — a 32-BIT prefix whose leading nibble
// is zero. Written as `0xf8a7ea5` (7 hex digits) Tolk derives a 28-bit prefix,
// which silently fails to match any standards-compliant wallet/explorer/indexer
// message and only appears to work between two contracts that make the same
// mistake. Found by the genesis rehearsal's LP leg (docs/phase3-report.md).
//
// GAUNTLET V4: `customPayload` and `forwardPayload` used to be plain `cell`,
// where TEP-74 specifies `custom_payload:(Maybe ^Cell)` and
// `forward_payload:(Either Cell ^Cell)` — a standards-compliant sender (a real
// wallet, GetGems-class indexer, or a DEX) writes a `0` bit for "absent"/"inline"
// where this contract expected to load a ref outright, which is a cell
// underflow: exactly the NFT-side bug `primes_item.tolk`'s header already
// documents for `Transfer`, on the jetton side instead. Fixed the same way:
// `cell?` for the Maybe, `RemainingBitsAndRefs` for the Either.
struct (0x0f8a7ea5) Transfer {
    queryId: uint64
    amount: coins
    destination: address
    responseAddr: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

// GAUNTLET V4 AGAIN, on the arm it missed. TEP-74's burn body ends with
// `custom_payload:(Maybe ^Cell)` and this struct parsed three fields and stopped,
// exactly as `Transfer` above used to. The pair was self-consistent — the only
// contract that burns PRIMES is primes_ratchet.tolk, which emitted three fields
// too — so the defect was invisible until D-151 §4.3.2 pointed the same
// `JettonBurn` constructor at somebody else's wallet, whose standards-compliant
// `load_dict()` underflows on the missing Maybe bit and dies in the ACTION phase.
// Parsed and ignored: this wallet has no use for a burn payload, but a
// standards-compliant sender is entitled to write one.
//
// GAUNTLET.md B33 — A THIRD PASS OVER THE SAME ARM, on the field the second one
// missed. `Transfer` above takes `responseAddr: address?`; this took `address`,
// which in Tolk is the NON-NONE type. TEP-74's `response_destination:MsgAddress`
// admits `addr_none`, and it is a real answer — "keep the change", the same
// meaning the transfer leg already honours at `:187-196` by sending no excesses
// at all. Loading it into the non-none type underflows, so a standards-compliant
// burn that declines its change **aborted with exit 9 before the burn happened**:
// not a lost refund, a refused burn.
//
// Found by B28 rather than by reading. Giving the MASTER's `responseAddr` a
// reader made `addr_none` a case worth driving; the spec written for it failed
// one hop upstream, here.
struct (0x595f07bc) Burn {
    queryId: uint64
    amount: coins
    responseAddr: address?
    customPayload: cell?
}

// TEP-74's `transfer_notification`, and the ONE outbound message of this wallet
// that a contract we do not control has to parse. R20.
//
// `forward_payload` is `(Either Cell ^Cell)`: one discriminator bit, then either
// the payload inline or a ref to it. This struct used to declare it as a plain
// `cell`, which serialises as a bare ref with NO bit in front — a shape every
// standard reader misparses, because it loads the discriminator first and there
// is nothing there to load.
//
// Measured on testnet 2026-09-16: DeDust's PRIMES vault received this
// notification carrying a byte-perfect `deposit_liquidity#40e108d6` payload and
// threw **exit 9, cell underflow**, aborting the jetton half of the pool seeding
// while the TON half had already landed. The payload was never the problem; the
// envelope was.
//
// `InternalTransfer` above keeps the simpler always-a-ref shape on purpose —
// both ends of that message are this same code. The distinction is exactly who
// parses it, and this one leaves the family.
struct (0x7362d09c) TransferNotification {
    queryId: uint64
    amount: coins
    sender: address
    // The Either discriminator. Always `true`: this wallet normalised whatever
    // the sender wrote into a definite ref in `Transfer` (see there), so there
    // is always a ref to point at.
    forwardPayloadInRef: bool
    forwardPayload: cell
}

struct (0x7bdd97de) BurnNotification {
    queryId: uint64
    amount: coins
    owner: address
    // B33, the other half: this struct CARRIES the burner's answer to the master,
    // so widening `Burn` without widening this one would just move the underflow
    // one line down. The master's copy was already widened by B28.
    responseAddr: address?
}

// TEP-74's excess-value return, GAUNTLET V4: previously never sent at all, so
// any leftover value above `forwardTonAmount` simply stayed on this wallet's
// own balance forever instead of returning to whoever asked for it back.
struct (0xd53276db) Excesses {
    queryId: uint64
}

// GAUNTLET V4: the reference jetton wallet's `throw_unless(709, ...)` gas
// check, sized for this wallet's own two extra hops (the destination wallet's
// notification, then its own excess return) rather than re-deriving
// `gas_consumption()`/`min_tons_for_storage()` — an engineering constant, the
// same class as `TRANSFER_GAS` elsewhere in this repo, not a sim-derived one.
const FWD_OVERHEAD_GAS: coins = 10000000; // 0.01 TON

type AllowedMessage = InternalTransfer | Transfer | Burn

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        InternalTransfer => {
            // sender must be the jetton master (mint path) or the correctly
            // derived sibling wallet of `from` (peer-to-peer transfer path).
            // Standard TEP-74 identity check, both legs:
            //   - the master (mint path), or
            //   - the sender's OWN wallet of this same jetton, whose address is
            //     recomputed here from `from` + this wallet's code (so a
            //     different jetton's wallet, or a hand-rolled impostor with
            //     different code, cannot credit this wallet).
            // The mint-only restriction the first pass shipped here made the
            // bounty vault's TEP-74 payout leg (D20) impossible; this closes it
            // and makes wallet-to-wallet transfers work as TEP-74 requires.
            val isMaster = in.senderAddress == storage.jettonMaster;
            val isSibling = in.senderAddress == siblingWalletAddress(msg.from, storage.jettonMaster, contract.getCode());
            assert (isMaster || isSibling) throw 100; // wrong_sender
            storage.balance += msg.amount;
            storage.save();

            // TEP-74 excess = attached − forward − fees, never the wallet's own
            // TON. Keep exactly the balance held before this message, then let
            // the notification and the change spend only what was attached. A
            // mode-64 excesses after a REGULAR notification re-sent the whole
            // inbound value, so every forward drained this wallet by
            // `forwardTonAmount` (same fix as primes_item.tolk's Transfer).
            reserveToncoinsOnBalance(contract.getOriginalBalance() - in.valueCoins,
                                     RESERVE_MODE_AT_MOST);
            if (msg.forwardTonAmount > 0) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: msg.forwardTonAmount,
                    dest: storage.owner,
                    body: (TransferNotification {
                        queryId: msg.queryId,
                        amount: msg.amount,
                        sender: msg.from,
                        forwardPayloadInRef: true,
                        forwardPayload: msg.forwardPayload,
                    }).toCell(),
                // IGNORE_ERRORS: a notification that cannot pay its own forward fee
                // (a `-1:` owner prices it at masterchain rates, ~0.011 TON against
                // the ledger's 0.005) must not abort the CREDIT above with it — that
                // bounced every rebate minted to a masterchain wallet, after the
                // ledger had already counted it into `S` (2026-11-08 audit).
                }).send(SEND_MODE_REGULAR | SEND_MODE_IGNORE_ERRORS);
            }
            // GAUNTLET V4: TEP-74's excess-value return — whatever this
            // message carried beyond `forwardTonAmount` goes back to whoever
            // asked for it, or nowhere if nobody did (`responseAddr` absent).
            val respondTo = msg.responseAddr;
            if (respondTo != null) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: respondTo,
                    body: (Excesses { queryId: msg.queryId }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        Transfer => {
            assert (in.senderAddress == storage.owner) throw 100; // wrong_sender
            assert (storage.balance >= msg.amount) throw 103; // insufficient_value
            // GAUNTLET V4: TEP-74's own gas check (the reference jetton
            // wallet's `throw_unless(709, ...)`) — refuse before touching
            // state if this message cannot possibly cover the forward it is
            // asking for, rather than let the destination wallet run out of
            // gas mid-relay with this wallet's balance already debited.
            // Reference `fwd_count`: the InternalTransfer hop, plus the
            // notification when one is asked for.
            val fwdCount = msg.forwardTonAmount > 0 ? 2 : 1;
            assert (in.valueCoins > msg.forwardTonAmount + fwdCount * in.originalForwardFee + FWD_OVERHEAD_GAS) throw 709; // jetton_insufficient_fwd_gas
            storage.balance -= msg.amount;
            storage.save();

            // GAUNTLET V4: `forwardPayload` arrives Either-encoded (a real
            // sender may have written it inline OR as a ref) and is
            // normalized to a definite ref HERE — see `InternalTransfer`'s
            // own header for why the rest of this wallet's outbound protocol
            // stays the simpler always-a-ref shape.
            var fwd = msg.forwardPayload;
            val fwdRef: cell = fwd.remainingBitsCount() >= 1 && fwd.loadBool()
                ? fwd.loadRef()
                : beginCell().storeSlice(fwd).endCell();

            createMessage({
                bounce: BounceMode.RichBounce,
                value: 0,
                dest: AutoDeployAddress {
                    workchain: 0,
                    stateInit: ContractState {
                        code: contract.getCode(),
                        data: walletInitData(msg.destination, storage.jettonMaster),
                    },
                },
                body: (InternalTransfer {
                    queryId: msg.queryId,
                    amount: msg.amount,
                    from: storage.owner,
                    responseAddr: msg.responseAddr,
                    forwardTonAmount: msg.forwardTonAmount,
                    forwardPayload: fwdRef,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        Burn => {
            assert (in.senderAddress == storage.owner) throw 100; // wrong_sender
            assert (storage.balance >= msg.amount) throw 103; // insufficient_value
            storage.balance -= msg.amount;
            storage.save();

            createMessage({
                bounce: BounceMode.RichBounce,
                value: 0,
                dest: storage.jettonMaster,
                body: (BurnNotification {
                    queryId: msg.queryId,
                    amount: msg.amount,
                    owner: storage.owner,
                    responseAddr: msg.responseAddr,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // Transfer/Burn bounced: restore the debited balance (funds/tokens never leave
    // a wallet's accounting on a failed forward).
    var storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    val opcode = rich.originalBody.beginParse().loadUint(32);
    if (opcode == 0x178d4519) {
        val original = lazy InternalTransfer.fromCell(rich.originalBody);
        storage.balance += original.amount;
        storage.save();
    } else if (opcode == 0x7bdd97de) {
        val original = lazy BurnNotification.fromCell(rich.originalBody);
        storage.balance += original.amount;
        storage.save();
    }
}

get fun getWalletData(): (int, address, address, cell) {
    val storage = lazy Storage.load();
    return (storage.balance, storage.owner, storage.jettonMaster, contract.getCode());
}

// ---- TEP-74 standard surface ----
//
// See the block in primes_jetton_master.tolk. `getWalletData` above is this
// project's own interface; `get_wallet_data` is the one every wallet UI, DEX and
// indexer actually calls, and its absence is why a PRIMES balance would render
// nowhere. Returns the same four values, with the addresses as slices per the
// standard's ABI rather than as Tolk `address` values.
get fun get_wallet_data(): (int, slice, slice, cell) {
    val storage = lazy Storage.load();
    return (
        storage.balance,
        beginCell().storeAddress(storage.owner).endCell().beginParse(),
        beginCell().storeAddress(storage.jettonMaster).endCell().beginParse(),
        contract.getCode()
    );
}
