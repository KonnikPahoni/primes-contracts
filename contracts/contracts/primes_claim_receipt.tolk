tolk 1.4

// ============================================================================
// TON PRIMES — the CLAIM RECEIPT, one per (voucher, claimant). CONCEPT.md §9.5;
// DECISIONS.md D-191 point 2 (GAUNTLET.md V26.3). Opcodes: /shared/opcodes.ts
// `VOUCHER`. Wire format: /shared/schemas/voucher.tlb. Parent:
// /contracts/contracts/primes_voucher.tolk.
//
// WHY IT EXISTS. The voucher's replay protection is a per-claimant high-water
// mark. Kept as a dictionary on the voucher it grew one row per claimant, for
// ever, toward config 43's 65,536-cell account cap (D-188's rule). Here each
// claimant's mark lives on its own child, so the voucher holds no map at all.
//
// ITS ADDRESS IS ITS AUTHORITY, BOTH WAYS. The init data is
// `(voucherAddr, claimant, 0)`, so the address is a hash of (this code, that
// voucher, this claimant). The voucher re-derives it to trust a `receipt_delta`;
// this contract compares `voucherAddr` to trust the voucher. `ReceiptInit` in
// primes_voucher.tolk mirrors this `Storage` byte for byte, and
// `PrimesVoucher.spec.ts` asserts the two derivations agree.
//
// THE ROUND TRIP. claimant → voucher (signature, deadline, validUntil) →
// here (`receipt_advance`, deploy-if-absent) → voucher (`receipt_delta`) →
// vault. The mark moves HERE, before the vault is asked, and a vault refusal
// comes back as `receipt_restore`, which lowers the mark by what was not paid.
// Subtracting (rather than "restore to the old value") is what keeps two claims
// in flight at once honest: the mark is always the sum of the deltas the vault
// accepted.
//
// This contract holds no PRIMES and no GRAM beyond its own rent. It holds a RECORD.
// ============================================================================

// Kept on this account when it forwards or refunds, so the receipt never runs
// into storage debt. A gas constant (rent on ~1 data cell + code for decades at
// config 18's basechain price), not an economic parameter.
const RECEIPT_STORAGE_RESERVE: coins = 10000000; // 0.01 GRAM

// ---------------------------------------------------------------------------
// Storage — THE FIELD ORDER IS PART OF THE ADDRESS (see the header)
// ---------------------------------------------------------------------------

struct Storage {
    voucherAddr: address
    claimant: address
    // Cumulative nano-PRIMES the voucher has paid (or is paying) this claimant.
    paid: coins
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// Inbound, from the voucher only: "the claimant's signed total is now this".
struct (0x9a000004) ReceiptAdvance {
    queryId: uint64
    cumulativeTotal: coins
}

// Outbound, to the voucher: pay `delta` to `claimant`.
struct (0x9a000005) ReceiptDelta {
    queryId: uint64
    claimant: address
    delta: coins
}

// Inbound, from the voucher only: the vault refused `amount`; take it back off.
struct (0x9a000006) ReceiptRestore {
    queryId: uint64
    amount: coins
}

type AllowedMessage = ReceiptAdvance | ReceiptRestore;

// What a no-op leaves behind is the claimant's GRAM, so it goes back to them.
fun refundExcess(storage: Storage) {
    reserveToncoinsOnBalance(RECEIPT_STORAGE_RESERVE, RESERVE_MODE_AT_MOST);
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: storage.claimant,
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        ReceiptAdvance => {
            assert (in.senderAddress == storage.voucherAddr) throw 100; // wrong_sender
            // THE REPLAY RULE (§9.5): a stale or duplicate voucher has a total at
            // or below the mark, so there is nothing to pay. Quiet, not an error.
            if (msg.cumulativeTotal <= storage.paid) {
                refundExcess(storage);
                return;
            }
            val delta: coins = msg.cumulativeTotal - storage.paid;
            storage.paid = msg.cumulativeTotal;
            storage.save();
            reserveToncoinsOnBalance(RECEIPT_STORAGE_RESERVE, RESERVE_MODE_AT_MOST);
            createMessage({
                // The voucher accepts a delta from the derived address and does
                // nothing else that can throw before its own send.
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: storage.voucherAddr,
                body: (ReceiptDelta {
                    queryId: msg.queryId,
                    claimant: storage.claimant,
                    delta: delta,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        ReceiptRestore => {
            assert (in.senderAddress == storage.voucherAddr) throw 100; // wrong_sender
            // Defensive: never underflow.
            storage.paid = storage.paid > msg.amount ? storage.paid - msg.amount : 0 as coins;
            storage.save();
            refundExcess(storage);
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// Every send here is NoBounce; this exists so a stray bounce can never throw.
fun onBouncedMessage(in: InMessageBounced) {
}

// Cumulative nano-PRIMES the voucher has PAID this claimant. Deliberately not a
// "claimable" figure (§9.1): only the backend knows what was earned.
get fun getPaid(): int {
    val storage = lazy Storage.load();
    return storage.paid;
}

// (voucherAddr, claimant) — so the derivation is checkable by inspection.
get fun getReceiptOwner(): (address, address) {
    val storage = lazy Storage.load();
    return (storage.voucherAddr, storage.claimant);
}
