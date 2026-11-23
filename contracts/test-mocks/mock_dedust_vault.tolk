tolk 1.4

// ============================================================================
// TON PRIMES — MOCK DeDust native vault. TEST-ONLY. GAUNTLET.md V2.1.
//
// This is NOT a protocol contract. It is never referenced by genesisPipeline.ts,
// never deployed to testnet or mainnet, has no opcode in shared/opcodes.ts and
// no entry in docs/testnet-deployment.md — it exists solely so
// `MockDedustVaultSwap.spec.ts` can drive `primes_ratchet.tolk`'s `handleFlush`
// against a counterparty that actually PARSES the message the way a real
// DeDust v2 vault would, instead of the plain treasury stand-in every other
// flush-path spec uses (which accepts any payload unconditionally and so proves
// nothing about wire-format correctness).
//
// It implements exactly the two outcomes GAUNTLET V2.1 asked for and nothing
// else:
//
//   1. FILL — the swap's `limit` (the ratchet's floor guard) is met by this
//      mock's configured price, so it replies with a `TransferNotification`
//      (TEP-74 shape, 0x7362d09c) to the swap's `recipient_addr`, exactly the
//      signal `primes_ratchet.tolk`'s own `TransferNotification` handler treats
//      as the fill callback that clears `inFlightFlush` (GAUNTLET B2.1). A real
//      DeDust pool would have its own jetton wallet send this, not the vault
//      itself — collapsed into one contract here because the point under test
//      is "does the ratchet's fill-detection round-trip against a real
//      TransferNotification", not DeDust's own internal wallet topology.
//   2. REJECT — the configured price does not meet `limit`, so this contract
//      PAYS THE GRAM BACK with `payout#474f86cf`, non-bounceable, to the swap's
//      sender. It used to `throw` instead, on the belief that a slippage
//      failure reaches the caller as a TVM bounce. It does not, and this mock
//      asserting that it did is what hid the defect the `DedustPayout` handler
//      in `primes_ratchet.tolk` now fixes: every sandbox test agreed with every
//      other sandbox test, and all of them disagreed with mainnet. See
//      the "A REFUSED DEDUST SWAP DOES NOT BOUNCE" note in `primes_ratchet.tolk` for the traces — the short
//      version is that the slippage check runs in the POOL, one hop past the
//      vault, so the vault's own transaction succeeds and a TON bounce (which
//      travels exactly one hop) has nothing to travel from.
//
//      The BOUNCE path is still exercised, by the three shape checks below
//      (1201 given_out, 1202 multi-hop, 1203 expired): those are the VAULT
//      refusing a message it cannot process, which is the one class of failure
//      that really does bounce, and which `onBouncedMessage` still handles.
//
// Every field of the inbound message is parsed per DeDust v2's own published
// schema (docs.dedust.io/reference/tlb-schemes, fetched 2026-09-09 — the same
// schema `primes_ratchet.tolk`'s `handleFlush` comment and
// `shared/schemas/ratchet.tlb` cite) and a malformed or wrong-shaped message
// throws exactly as an out-of-band parse would, on the same principle: this
// mock does not merely check the opcode, it checks the shape.
// ============================================================================

const DEDUST_SWAP_OP: int = 0xea06185d;

struct Storage {
    owner: address       // may reconfigure the simulated price at any time
    priceNum: coins       // simulated output = amount * priceNum / priceDen
    priceDen: coins
    // GAUNTLET V15's third outcome: ACCEPT the swap and reply with NOTHING.
    // Neither a fill nor a revert, so `inFlightFlush` stays set and the round
    // trip hangs open — the only state in which `handleFlush`'s new
    // `inFlightFlush == 0` guard can fire. A real vault does this by being
    // stuck, congested or buggy; a bounce or a notification would both resolve
    // the round trip, and those are outcomes 1 and 2 above.
    silent: uint1
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// Mirrors DeDust's real swap#ea06185d body — see the header comment.
struct (0xea06185d) DedustSwap {
    queryId: uint64
    amount: coins
    poolAddr: address
    kind: uint1           // given_in$0 only; given_out$1 is not simulated
    limit: coins
    next: uint1            // Maybe ^SwapStep — must be none$0 (no multi-hop here)
    swapParams: cell        // ^SwapParams ref, parsed inline below
}

// Owner-only, repeatable (this is a test double, not a one-shot bootstrap).
struct (0x92000010) SetPrice {
    queryId: uint64
    priceNum: coins
    priceDen: coins
}

// Mirrors primes_ratchet.tolk's own TransferNotification struct exactly —
// same opcode, same field order, same wire format (TEP-74).
struct (0x7362d09c) TransferNotification {
    queryId: uint64
    amount: coins
    sender: address
    forwardPayload: cell
}

// Mirrors DeDust's real payout#474f86cf — query_id echoed from the swap, then
// `payload:(Maybe ^Cell)`, which a real vault fills with the sender's own
// `reject_payload` handed back verbatim. `primes_ratchet.tolk` sends
// `reject_payload = none`, so `null` here is not a shortcut: it is exactly what
// a real vault would echo for every message this mock can ever receive.
struct (0x474f86cf) DedustPayout {
    queryId: uint64
    payload: cell?
}

// Owner-only, repeatable. Separate opcode rather than a field on SetPrice so the
// price-setting wire stays byte-identical to what the fill/reject tests already send.
struct (0x92000011) SetSilent {
    queryId: uint64
    silent: uint1
}

type AllowedMessage = DedustSwap | SetPrice | SetSilent;

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetPrice => {
            assert (in.senderAddress == storage.owner) throw 100; // wrong_sender
            storage.priceNum = msg.priceNum;
            storage.priceDen = msg.priceDen;
            storage.save();
        }

        SetSilent => {
            assert (in.senderAddress == storage.owner) throw 100; // wrong_sender
            storage.silent = msg.silent;
            storage.save();
        }

        DedustSwap => {
            // Shape checks a real vault would make: given_in only, single-hop
            // only. Anything else is a message this mock does not simulate.
            assert (msg.kind == 0) throw 1201; // given_out not implemented (real DeDust behaviour)
            assert (msg.next == 0) throw 1202;  // multi-hop not simulated by this mock

            // swap_params:^SwapParams — deadline:uint32 recipient_addr:MsgAddressInt
            // referral_addr:MsgAddress fulfill_payload:(Maybe ^Cell) reject_payload:(Maybe ^Cell)
            var params = msg.swapParams.beginParse();
            val deadline = params.loadUint(32);
            val recipientAddr = params.loadAddress();
            // `deadline = 0` means DISABLED on real DeDust, and real swaps use it
            // (docs.dedust.io: "Default: 0 (disabled)"). This mock used to assert
            // unconditionally, so it was STRICTER than mainnet and would have
            // rejected a legal message. `primes_ratchet.tolk` always sends
            // `now + DEDUST_SWAP_DEADLINE_WINDOW`, so nothing here changes for it.
            if (deadline != 0) {
                assert (blockchain.now() < deadline) throw 1203; // dedust_expired (real DeDust behaviour)
            }

            // GAUNTLET V15: swallow it. The shape and deadline checks above still
            // run — this models a vault that ACCEPTED a well-formed swap and then
            // never answered, not one that refused it — so the caller sees no
            // notification and no bounce, and its `inFlightFlush` stays open.
            if (storage.silent == 1) { return; }

            val output = storage.priceDen > 0 ? msg.amount * storage.priceNum / storage.priceDen : 0;
            if (output >= msg.limit) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: recipientAddr,
                    body: (TransferNotification {
                        queryId: msg.queryId,
                        amount: output as coins,
                        // The jetton-level sender of a real payout is the PRIMES
                        // jetton vault, which this mock also stands in for — the
                        // ratchet authenticates its fill on exactly this field.
                        sender: contract.getAddress(),
                        forwardPayload: beginCell().endCell(),
                    }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
            } else {
                // Slippage. Hand the GRAM back the way a real vault does: a fresh,
                // NON-bounceable message to the original sender, carrying every
                // remaining nanoton. Not a throw — see outcome 2 in the header.
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: in.senderAddress,
                    body: (DedustPayout {
                        queryId: msg.queryId,
                        payload: null,
                    }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
            }
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // This mock owes nobody anything and holds no position — a bounced
    // TransferNotification (NoBounce, so this never actually fires) or a
    // malformed inbound has nothing to restore.
}

get fun getMockVaultConfig(): (slice, int, int) {
    val storage = lazy Storage.load();
    return (beginCell().storeAddress(storage.owner).endCell().beginParse(), storage.priceNum, storage.priceDen);
}
