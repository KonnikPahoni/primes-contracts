tolk 1.4

// ============================================================================
// TON PRIMES — Registrar.
//
// CONCEPT §3.4's fourth contract: the era trophies and the paid-annotation
// door. **It holds no protocol GRAM at all** — that is the entire reason it is
// separate, and it is what makes its `getSolvency` the trivial one of the four:
// declared liability is structurally zero, so any balance it carries is its own
// storage rent and nothing else.
//
// ---- What is implemented ----
//
// D-36's era trophy and D-14's trophy transfer, and the trophy's engraving. A
// NUMBER's name lives on its own NFT item (`primes_item.tolk` `naming`) and is
// written through the collection's `name_number` by its current owner (D-212);
// this contract has no part in it. The prime rank is the ledger's
// `getMinterState`.
//
// DECISIONS.md D-202 DELETED THE BUILT NUMBER LINE (§3.2.2, D-102) from this
// contract, and D-212 deleted the burn sink's door (`set_sink`, `sink_annotate`,
// `relay_annotation`). Its only outbound messages are a trophy re-engraving's fee
// to the collection (`naming_paid`) and the payer's change.
//
// ---- D-188 point 6: nothing here grows with the number line ----
//
// Config 43 caps this account at 65,536 cells. What this contract stores:
//   * `trophies` — at most EIGHT rows, one per §7 primorial (`isPrimorial` is
//     asserted on every write).
//   * everything else is a fixed-size scalar.
// ============================================================================

// §7 era boundaries — the eight primorials the game is built around
// (`webapp/src/.../primorial.ts` is canonical for the era list: eight, never six).
// The same list as the D-99 score block's `isPrimorial` in the ledger and the
// market; this contract carries no score, so it carries the list alone.
fun isPrimorial(n: int): bool {
    return n == 6 || n == 30 || n == 210 || n == 2310 || n == 30030
        || n == 510510 || n == 9699690 || n == 223092870;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

struct RegistrarConfig {
    ledgerAddr: address
    genesisScriptAddr: address
    // The MAIN collection, which a trophy re-engraving's fee goes through on its
    // way to the floor (`naming_paid`, D-212). One-shot from `set_collection`.
    collectionAddr: address
    // D-212 (§4.7.1): what a trophy's SECOND and later engravings cost, in GRAM —
    // the same figure as the collection's `renameFee`, from the same genesis input
    // (the pipeline asserts the two match). Deploy data, no setter.
    renameFee: coins
}

// §4.7.1's era-trophy engraving. D-179 / D-212: the FIRST engraving on an ERA
// TROPHY is FREE and is written by whoever holds it; every later one costs
// `renameFee` in GRAM, paid to the ratchet floor through the collection.
//
// The text is an OPAQUE cell. This contract does not parse it and asserts
// nothing about its content: an annotation is a cosmetic, and validating prose
// on chain would be a rule the protocol cannot enforce anyway.
//
// That rationale is about CONTENT, not SIZE, and the two are different
// decisions (GAUNTLET.md B5.2). SIZE is capped: the text is ONE cell with no
// refs (≤1023 bits, the bound `NAME_MAX_CHARS` already keeps the UI inside).
// An uncapped ref tree let ~8 annotations fill config 43's 65,536-cell account
// cap — a protocol limit, not an economic parameter, so it lives here and not
// in params.json. The item enforces the same cap on its own copy.
//
// D-188 point 6: a NUMBER's name lives on its item. What stays here is a
// TROPHY's — its holder, and what stands engraved on it.
struct TrophyRecord {
    holder: address
    count: uint16              // annotations ever written; the first is free
    text: cell                 // the latest one; an empty cell while count == 0
}

struct Storage {
    // key = one of §7's EIGHT primorials, value = that era's trophy (D-36,
    // D-14). BOUND: EIGHT rows — every write asserts `isPrimorial`.
    trophies: map<uint256, Cell<TrophyRecord>>
    cfg: Cell<RegistrarConfig>
    linked: uint8              // 1 once `set_ledger` has run
    collectionSet: uint8       // 1 once `set_collection` has run
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

// inbound, one-shot from the genesis script. Same circular-address problem as
// the ledger's SetSinks and the ratchet's SetLedger.
struct (0xb0000060) SetLedger {
    queryId: uint64
    ledgerAddr: address
}

// inbound, one-shot from the genesis script: the MAIN collection, which a trophy
// re-engraving's fee is forwarded through (D-212). (D-202 dropped the item code and
// the bounty vault this body used to carry with the builds that read them.)
struct (0xb0000067) SetCollection {
    queryId: uint64
    collectionAddr: address
}

// inbound, from primes_ledger.tolk ONLY (D-36 / §4.7, §7: the ERA TROPHY).
//
// The era's single highest recruiter takes permanent naming rights over that
// era's primorial. It writes into `trophies` — at most eight rows, because
// there are eight primorials.
//
// The winner is decided on the LEDGER (that is where §4.6's activation edge
// runs) and delivered here. This contract does not recompute it and does not
// need to: the sender check against the ledger address is the whole
// authentication.
struct (0xb000006b) AwardEraTrophy {
    queryId: uint64
    primorial: uint256
    winner: address
    recruits: uint32       // the winning era count, for the record
}

// inbound, PERMISSIONLESS in shape — but only the current holder of the trophy
// gets past the check. D-14 (§4.7, §11.13 closed 2026-08-16): **the era trophy
// is transferable.**
//
// SCOPE, and it is deliberately narrow: this moves TROPHIES ONLY. `n` must be
// one of §7's eight primorials or the message throws 914. Ordinary prime naming
// rights are "whoever takes it names it forever" (§5.1) and "immediately and
// permanently" fixed (§4.7.1) — D-14's carve-out is for era trophies alone, and
// since D-188 point 6 the two do not even share a contract: a prime's namer is
// written once on its item at Populate, and nothing can move it.
//
// NO GRAM MOVES AND NONE IS HELD. Whatever the trophy sold for was settled off
// this contract, exactly as the naming right itself has no price here.
struct (0xb0000070) TransferTrophy {
    queryId: uint64
    primorial: uint256     // must be one of §7's eight primorials, else throw 914
    newHolder: address     // `address`, not `any_address`: addr_none cannot parse,
                           // so a trophy can never be transferred into the void
}

// inbound, permissionless — but only the holder of an ERA TROPHY gets past the
// checks. A trophy's FIRST engraving is free (§4.7.1, D-179); every later one
// must carry `renameFee` plus `REG_RENAME_GAS` (D-212). Opcode kept from D-179.
struct (0xb000006d) Annotate {
    queryId: uint64
    n: uint256
    text: cell
}

// D-212. outbound, registrar -> collection: a paid re-engraving's fee, which the
// collection forwards to the ledger as a pure floor step. Mirrors
// primes_collection.tolk's `NamingPaid`. (`sink_annotate` 0xb000006e,
// `set_sink` 0xb000006c and `relay_annotation` 0xc0000008 are retired with the
// burn sink; not recycled.)
struct (0xc000000a) NamingPaid {
    queryId: uint64
    n: uint256
    amount: coins
    count: uint16
}

// D-212: the gas a paid re-engraving needs on top of the fee — the fee's trip to
// the ratchet (primes_item.tolk's NAMING_PAID_GAS, 0.03) plus this contract's
// compute and the change send (0.02).
const NAMING_PAID_GAS: coins = 30000000;  // 0.03 GRAM
const REG_RENAME_GAS: coins = 50000000;   // 0.05 GRAM

type AllowedMessage = SetLedger | SetCollection | AwardEraTrophy | TransferTrophy
    | Annotate;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// D-212: a refused engraving goes home whole, less this transaction's gas.
fun refundAll(caller: address) {
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: caller,
        body: beginCell().endCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        AwardEraTrophy => {
            // D-36 (§4.7, §7). One dictionary write, on a contract that holds
            // no GRAM — which is why the trophy survived the review that dropped
            // the era dividend.
            var storage = lazy Storage.load();
            val cfg = storage.cfg.load();
            assert (storage.linked == 1) throw 101;                 // wrong_opcode (no ledger configured)
            assert (in.senderAddress == cfg.ledgerAddr) throw 100;  // wrong_sender
            // The ledger is trusted for WHO won; it is not trusted for WHAT is
            // being named.
            assert (isPrimorial(msg.primorial)) throw 914;          // reg_not_primorial
            // Written once, never overwritten — same rule and same reason as
            // prime naming rights: the claim is "forever". `isPrimorial` above
            // is also the bound on `trophies`: eight keys, ever.
            val existing = storage.trophies.get(msg.primorial);
            if (!existing.isFound) {
                storage.trophies.set(msg.primorial, (TrophyRecord {
                    holder: msg.winner,
                    count: 0,
                    text: beginCell().endCell(),
                }).toCell());
            }
            storage.save();
        }

        TransferTrophy => {
            // D-14 (§4.7). The trophy is transferable; the naming right on a
            // prime is not — that one is written once on the prime's item and
            // no message anywhere can move it.
            var storage = lazy Storage.load();

            // (1) SCOPE. Trophies only.
            assert (isPrimorial(msg.primorial)) throw 914;   // reg_not_primorial

            // (2) HOLDERSHIP. The only authority on this contract. There is no
            // admin arm, no operator override and no ledger arm — the ledger
            // ISSUES a trophy and has no say in where it goes afterwards.
            val look = storage.trophies.get(msg.primorial);
            assert (look.isFound) throw 915;                          // reg_not_namer
            var rec = look.loadValue().load();
            assert (rec.holder == in.senderAddress) throw 915;        // reg_not_namer

            // (3) THE WRITE. One row rewritten in place; what is engraved on the
            // trophy travels with it.
            rec.holder = msg.newHolder;
            storage.trophies.set(msg.primorial, rec.toCell());
            storage.save();
        }

        SetLedger => {
            var storage = lazy Storage.load();
            var cfg = storage.cfg.load();
            assert (in.senderAddress == cfg.genesisScriptAddr) throw 100; // wrong_sender
            assert (storage.linked == 0) throw 104;                       // already_processed
            cfg.ledgerAddr = msg.ledgerAddr;
            storage.cfg = cfg.toCell();
            storage.linked = 1;
            storage.save();
        }

        SetCollection => {
            var storage = lazy Storage.load();
            var cfg = storage.cfg.load();
            assert (in.senderAddress == cfg.genesisScriptAddr) throw 100; // wrong_sender
            assert (storage.collectionSet == 0) throw 104;                // already_processed
            cfg.collectionAddr = msg.collectionAddr;
            storage.cfg = cfg.toCell();
            storage.collectionSet = 1;
            storage.save();
        }

        Annotate => {
            // §4.7.1. Permissionless in shape, but the holder check makes it
            // single-holder in effect. EVERY REFUSAL REFUNDS the whole value
            // rather than throwing (D-212): a re-engraving carries 200 GRAM, and a
            // throw on a non-bounceable send would leave it here for ever.
            var storage = lazy Storage.load();
            val cfg = storage.cfg.load();
            // `trophies` only ever holds primorial keys (every write asserts
            // `isPrimorial`), so a miss covers "not a primorial" too.
            val look = storage.trophies.get(msg.n);
            if (!look.isFound) { refundAll(in.senderAddress); return; }
            var rec = look.loadValue().load();
            val paid = rec.count > 0;
            if (rec.holder != in.senderAddress
                || msg.text.beginParse().remainingRefsCount() != 0 // ONE cell
                || rec.count >= 65535
                || (paid && (storage.collectionSet != 1 || in.valueCoins < cfg.renameFee + REG_RENAME_GAS))) {
                refundAll(in.senderAddress);
                return;
            }
            rec.count = (rec.count + 1) as uint16;
            rec.text = msg.text;
            storage.trophies.set(msg.n, rec.toCell());
            storage.save();
            if (paid) {
                // Keep this contract's own rent; the fee leaves first, the change
                // after it. Declared liability stays zero (§3.4).
                reserveToncoinsOnBalance(contract.getOriginalBalance() - in.valueCoins, RESERVE_MODE_AT_MOST);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: cfg.renameFee + NAMING_PAID_GAS,
                    dest: cfg.collectionAddr,
                    body: (NamingPaid {
                        queryId: msg.queryId,
                        n: msg.n,
                        amount: cfg.renameFee,
                        count: rec.count,
                    }).toCell(),
                }).send(SEND_MODE_REGULAR);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: in.senderAddress,
                    body: beginCell().endCell(),
                }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// Every send here is NoBounce, so nothing can bounce back; the handler exists so a
// bounce could never throw (BounceCoverage.spec.ts's rule for every sender).
fun onBouncedMessage(in: InMessageBounced) {}

// ---------------------------------------------------------------------------
// Get-methods
// ---------------------------------------------------------------------------

// D-14 / §4.7. The era trophy, read as a trophy rather than as a naming right.
//
// Returns `(holder, transferable)`:
//   - `holder`      addr_none when `n` carries no trophy — either the era has
//                   not closed yet, or `n` is not a primorial at all.
//   - `transferable` 1 iff `n` is one of §7's eight primorials, i.e. iff
//                   `transfer_trophy` would accept it. 0 for EVERY other number,
//                   including a prime that is named.
get fun getTrophy(n: int): (slice, int) {
    val storage = lazy Storage.load();
    if (!isPrimorial(n)) {
        return (beginCell().storeUint(0, 2).endCell().beginParse(), 0);
    }
    val look = storage.trophies.get(n);
    if (!look.isFound) {
        return (beginCell().storeUint(0, 2).endCell().beginParse(), 1);
    }
    return (beginCell().storeAddress(look.loadValue().load().holder).endCell().beginParse(), 1);
}

// §3.4's load-bearing property, in ONE get-call: (balance, declared liability,
// delta). This contract custodies no protocol GRAM — every message it accepts
// either moves nothing or forwards the caller's own value — so its declared
// liability is structurally zero and its balance is its own storage rent.
get fun getSolvency(): (int, int, int) {
    val balance = contract.getOriginalBalance();
    val liability = 0;
    return (balance, liability, balance - liability);
}

// §4.7.1 / §5.2 family 1, for an ERA TROPHY. (count, text); count 0 and an
// empty cell when nothing is engraved, or `n` is not a primorial. A prime's
// annotation is item(n).getAnnotation() since D-188 point 6 — named apart so a
// reader cannot ask this contract about a prime and silently read a zero.
get fun getTrophyAnnotation(n: int): (int, cell) {
    val storage = lazy Storage.load();
    val look = storage.trophies.get(n);
    if (!look.isFound) { return (0, beginCell().endCell()); }
    val rec = look.loadValue().load();
    return (rec.count, rec.text);
}

// D-212: what a trophy's next engraving costs once its first is written.
get fun getTrophyRenameFee(): int {
    val storage = lazy Storage.load();
    return storage.cfg.load().renameFee;
}

// (collectionAddr, collectionSet).
get fun getPeers(): (slice, int) {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    return (beginCell().storeAddress(cfg.collectionAddr).endCell().beginParse(), storage.collectionSet);
}
