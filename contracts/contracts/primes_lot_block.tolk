tolk 1.4

// ============================================================================
// TON PRIMES — the LOT BLOCK, one per (ledger, 256-number block) that an auction
// has touched AHEAD of the ledger's import frontier. CONCEPT.md §4.4, §8;
// DECISIONS.md D-196 (GAUNTLET.md V30). Opcodes: /shared/opcodes.ts `LOT_BLOCK`.
// Wire format: /shared/schemas/lot_block.tlb. Parent:
// /contracts/contracts/primes_ledger.tolk.
//
// WHY IT EXISTS. A lot may open on any number, however far ahead of the head
// (§4.4, D-88), and its mark is permanent (D-45). Kept on the ledger, a far
// mark is a 256-bit word per block the OPENER picks, and ~30,000 far lots fill
// config 43's 65,536-cell account cap — after which every storage-growing
// ledger transaction fails and the head freezes. So the ledger keeps words only
// for blocks below its import frontier, and a block beyond it keeps its words
// HERE, on an account of its own, until the head's window reaches it.
//
// ITS ADDRESS IS ITS AUTHORITY, BOTH WAYS. The init data is
// `(ledgerAddr, block, 0, 0)`, so the address is a hash of (this code, that
// ledger, this block). The ledger re-derives it to trust `lot_block_words` and
// `lot_block_refused`; this contract compares `ledgerAddr` to trust the ledger.
// `LotBlockInit` in primes_ledger.tolk mirrors this `Storage` byte for byte, and
// `LotBlock.spec.ts` asserts the two derivations agree.
//
// ORDER IS THE WHOLE CONCURRENCY ARGUMENT. Only the ledger writes here, and TON
// delivers the messages of one sender to one receiver in the order they were
// sent. So every mark the ledger routed here before it asked for the words is
// in the words it gets back, and after it asks it routes none here.
//
// `import` HANDS THE WORDS OVER AND KEEPS THEM (mode 128, no destroy): the
// balance — the openers' forwarded gas — rides back to the ledger's gas float,
// but the words stay. The answer is fire-and-forget; were the ledger's arm to
// fail (gas, its cell cap), a deleted block would take the marks with it and
// leave the ledger's `importingBlock` set for ever — the head stops at the
// frontier, so that froze it. Kept, the block answers a re-sent import with the
// same words, and an empty account costs a few cells of rent.
//
// D-198: IT ALSO HOLDS THE BLOCK'S UNSOLD BOOKMARKS once the head has left it.
// The ledger's unsold primes keep a §3.2 dividend bookmark and a §6 point 2
// forfeit counter each until they sell; left on the ledger, a backlog of unsold
// primes would fill its account. `flush_unsold` moves a passed block's rows here
// (`lot_block_bookmarks`); a sale asks for one back (`lot_block_release`), and
// the ledger forwards the answer (`lot_block_bookmark`) to the item. The
// forfeit counter stays here, frozen, readable by `getBookmark`.
//
// This contract holds no player money and pays no one but the ledger: a hop's
// unspent change, above a rent floor, goes back to its gas float. It holds a RECORD.
// ============================================================================

// ---------------------------------------------------------------------------
// Storage — THE FIELD ORDER IS PART OF THE ADDRESS (see the header)
// ---------------------------------------------------------------------------

struct Storage {
    ledgerAddr: address
    // The ledger's bitmap chunk: every n recorded here has (n - 2) >> 8 == block,
    // and its bit is (n - 2) & 255 — the ledger's `bitmapChunkAndBit`, so an
    // imported word lands on its chunk as it is.
    block: uint64
    // Bit set: a lot has opened on n (either kind). Never cleared — D-45's
    // permanence — and a second claim on a set bit is refused.
    claimed: uint256
    // Bit set: prime n was sold ahead of the head. What the ledger's
    // `primeBitmap` records for a prime sold inside its window.
    soldPrime: uint256
    // D-198: unsold primes' bookmarks, keyed by bit `(n - 2) & 255`. BOUND: the
    // primes of one 256-number block; a release marks its row RELEASED and keeps
    // the frozen forfeit counter.
    bookmarks: map<uint8, UnsoldBookmark>
}

struct UnsoldBookmark {
    entry: coins
    forfeited: coins
}

// A released row's entry: primes_ledger.tolk's DIV_ENTRY_UNSTAMPED, 2^120 - 1.
const RELEASED: coins = 0xffffffffffffffffffffffffffffff;

// LOW-4: what a hop from the ledger leaves here once the head has passed the
// block. Such a block is never imported again, so this floor is its rent
// (~0.007 TON/year at 55 rows) until the next `lot_block_release`, which pays the
// debt, tops the floor back up and returns the rest. Everything above the floor
// goes back to the ledger's gas float, which `sweep_ops` pools.
const LOT_BLOCK_RENT_FLOOR: coins = 10000000; // 0.01 TON

// Keep the rent floor, send the rest to the ledger. IGNORE_ERRORS: change too small
// to pay its own forward fee stays here, and never rolls the caller's write back.
fun returnChange(storage: Storage) {
    reserveToncoinsOnBalance(LOT_BLOCK_RENT_FLOOR, RESERVE_MODE_AT_MOST);
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: storage.ledgerAddr,
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// ---- inbound, from the ledger only ----

// A lot opened on `n`. Refused (bit already set) back to the ledger, which
// relays `mark_rejected` to the market.
struct (0x9c000001) LotBlockClaim {
    queryId: uint64
    n: uint256
}

// Prime `n` was sold ahead of the head.
struct (0x9c000002) LotBlockSoldPrime {
    queryId: uint64
    n: uint256
}

// The head's window reached this block: hand the words over and go.
struct (0x9c000003) LotBlockImport {
    queryId: uint64
}

// D-198: the block's unsold rows, moved off the ledger. `queryId` is the block.
struct (0x9c000004) LotBlockBookmarks {
    queryId: uint64
    rows: map<uint8, UnsoldBookmark>
}

// D-198: prime n sold — hand its bookmark back.
struct (0x9c000005) LotBlockRelease {
    queryId: uint64
    n: uint256
}

struct (0xb0000083) LotBlockBookmark {
    queryId: uint64
    n: uint256
    entry: coins
}

// ---- outbound, to the ledger ----

struct (0xb000007f) LotBlockWords {
    queryId: uint64
    block: uint64
    claimed: uint256
    soldPrime: uint256
}

struct (0xb0000080) LotBlockRefused {
    queryId: uint64
    n: uint256
}

type AllowedMessage = LotBlockClaim | LotBlockSoldPrime | LotBlockImport | LotBlockBookmarks | LotBlockRelease;

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        LotBlockClaim => {
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            assert (((msg.n - 2) >> 8) == storage.block) throw 201;     // bad n for this block
            val bit = 1 << ((msg.n - 2) & 255);
            if ((storage.claimed & bit) != 0) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: storage.ledgerAddr,
                    body: (LotBlockRefused { queryId: msg.queryId, n: msg.n }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
                return;
            }
            storage.claimed |= bit;
            storage.save();
        }

        LotBlockSoldPrime => {
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            assert (((msg.n - 2) >> 8) == storage.block) throw 201;     // bad n for this block
            storage.soldPrime |= 1 << ((msg.n - 2) & 255);
            storage.save();
        }

        LotBlockImport => {
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            // Idempotent: the ledger re-sends `import` while its answer has not
            // landed, and ORs whatever arrives, so a second answer is harmless.
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: storage.ledgerAddr,
                body: (LotBlockWords {
                    queryId: msg.queryId,
                    block: storage.block,
                    claimed: storage.claimed,
                    soldPrime: storage.soldPrime,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        LotBlockBookmarks => {
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            var r = msg.rows.findFirst();
            while (r.isFound) {
                storage.bookmarks.set(r.getKey(), r.loadValue());
                r = msg.rows.iterateNext(r);
            }
            storage.save();
            returnChange(storage);
        }

        LotBlockRelease => {
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            assert (((msg.n - 2) >> 8) == storage.block) throw 201;     // bad n for this block
            val key = ((msg.n - 2) & 255) as uint8;
            val look = storage.bookmarks.get(key);
            // Messages from the ledger arrive in order, so a flushed prime's row is
            // here before its release. Absent means released already: nothing to do.
            if (!look.isFound) { returnChange(storage); return; }
            val row = look.loadValue();
            // Released already (a 0 entry is a real bookmark — prime 2's — so the
            // mark is the ledger's own UNSTAMPED sentinel).
            if (row.entry == RELEASED) { returnChange(storage); return; }
            // The ENTRY leaves with the sale; the forfeit counter stays, frozen.
            storage.bookmarks.set(key, UnsoldBookmark { entry: RELEASED, forfeited: row.forfeited });
            storage.save();
            // CARRY_ALL_BALANCE, not CARRY_ALL_REMAINING (LOW-4): the storage phase
            // has already taken the rent debt out of the hop, so the hop's whole
            // remainder may exceed the balance. No IGNORE_ERRORS: an answer that
            // cannot go rolls the release back, so the row is never marked released
            // without its bookmark leaving. The 0.1 hop covers ~0.08 TON of debt, a
            // dozen idle years at 55 rows.
            reserveToncoinsOnBalance(LOT_BLOCK_RENT_FLOOR, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: storage.ledgerAddr,
                body: (LotBlockBookmark { queryId: msg.queryId, n: msg.n, entry: row.entry }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_BALANCE);
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// Every send here is NoBounce; this exists so a stray bounce can never throw.
fun onBouncedMessage(in: InMessageBounced) {
}

// (claimed, soldPrime) — the two words the ledger will import. n's bit is
// (n - 2) & 255.
get fun getWords(): (int, int) {
    val storage = lazy Storage.load();
    return (storage.claimed, storage.soldPrime);
}

// D-198: (found, entry, forfeited) for prime n of this block. `entry` is its §3.2
// bookmark while it is unsold (2^120 - 1 once released to the ledger at its sale);
// `forfeited` is its §6 point 2 counter as of the flush, frozen.
get fun getBookmark(n: int): (int, int, int) {
    val storage = lazy Storage.load();
    if (((n - 2) >> 8) != storage.block) { return (0, 0, 0); } // not this block's n
    val look = storage.bookmarks.get(((n - 2) & 255) as uint8);
    if (!look.isFound) { return (0, 0, 0); }
    val row = look.loadValue();
    return (1, row.entry, row.forfeited);
}

// (ledgerAddr, block) — so the derivation is checkable by inspection.
get fun getLotBlockOwner(): (address, int) {
    val storage = lazy Storage.load();
    return (storage.ledgerAddr, storage.block);
}
