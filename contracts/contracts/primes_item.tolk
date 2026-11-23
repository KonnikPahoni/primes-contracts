tolk 1.4

// D-72 / GAUNTLET T4: `calculateStorageFee` (TVM GETSTORAGEFEE) for `getStorageRunway()`.
// The only stdlib module this contract imports; `common` is implicit.
import "@stdlib/gas-payments"

// ============================================================================
// TON PRIMES — NFT item (TEP-62 item + v1 extensions).
// Phase 3, IMPLEMENTATION_PLAN.md §3 build step 2 / §2.1.
//
// Storage layout & the owed-ledger decision: /docs/engineering-spec.md §2.3, §4.3.
// `owed` is a single Coins scalar — never a dictionary — which is the entire
// point of that decision: this contract's state size never grows with mint
// volume, credit count, or n.
//
// Address-derivation note (a Phase 3 implementation decision needed to make
// engineering-spec.md §3's "sender MUST equal ItemAddress(p), computed from
// the collection's known code/data per prime p's index" checkable without a
// per-item registry on the ledger): this item's *deploy-time* (address-
// determining) data cell is a pure function of `n` alone (plus the fixed
// collection/ledger addresses and item code) — `owner` starts as addr_none,
// `factorization`/`rarityFlags`/`isPrime` start zeroed, `populated = 0`. The
// collection deploys the item with this canonical empty state *and* attaches
// a `Populate` message body in the same transaction; the item sets its real
// fields (owner, is_prime, factorization, rarity_flags) exactly once, then
// flips `populated = 1`. Because the address-determining data never includes
// the mint-time owner, the ledger can compute `ItemAddress(p)` purely from `p`
// at any later time (claim_tribute / credit_tribute sender checks, and the
// referral-payout relay below) without maintaining an O(n) registry.
// ============================================================================

// Split into a small address-determining head + a ref'd mutable tail: the full
// flat struct exceeds TON's 1023-bit single-cell budget (measured: 1093-1213
// bits with 3 addresses + n + owed inline). This split is required by Tolk's
// own overflow check, not a design choice — see primes_collection.tolk /
// primes_ledger.tolk for the duplicated ItemHead/ItemMutable shape both must
// match exactly to keep ItemAddress(p) computation consistent.
struct ItemMutable {
    populated: uint8           // 0 until the deploy-time Populate message lands
    owner: address
    isPrime: uint8
    factorization: cell        // canonical (prime,exponent) list; empty for primes
    rarityFlags: uint16
    owed: coins                 // THE owed-ledger decision: scalar, never a dict
    // CONCEPT §9.8 / §9.1 — the day this number was minted, as DAYS SINCE THE
    // UNIX EPOCH. Written once by the `Populate` handler below and never again.
    //
    // Why it is on chain at all: the artwork prints a mint date, and §9.1's rule
    // is that every number the UI shows maps to a public get-method. An
    // off-chain-only date read out of an indexer would be the one figure on the
    // tile a reader could not check against the chain.
    //
    // Why DAYS and not a Unix timestamp: the image only ever renders a date, and
    // this cell is the one the header describes as already over TVM's 1023-bit
    // budget in its flat form. uint24 covers ~45,000 years of days and costs 24
    // bits where a timestamp would cost 32-64.
    //
    // 0 means "not populated yet", which is exactly the state the canonical
    // deploy-time data is in — see `buildItemInitData`. The address-determining
    // default is 0 for every n, so this field does not enter address derivation.
    mintedDay: uint24
    // CONCEPT §3.2.1 — every `CreditTribute` this item has ever received, the
    // "tribute paid to date" leg of the bond panel on /n/:p. Only ever added to:
    // `owed` is the unclaimed balance and falls to 0 on every claim, so it cannot
    // answer "what has this prime earned". Coins, so it costs bits (free on
    // workchain 0), never a cell. 0 in the address-determining default.
    tributeTotal: coins
    // CONCEPT §9.11 / D-177 (GAUNTLET G89) — every §4.1 referral payout this number's key
    // has relayed to its owner, in nanoGRAM as it ARRIVED here (the ledger's
    // `REFERRAL_AMOUNT` less that hop's forward fee). Only ever added to, in the
    // `ForwardToOwner` arm. Coins, so bits and never a cell. 0 in the
    // address-determining default.
    referralPaidTotal: coins
    // CONCEPT §3.2 / DECISIONS.md D-188 point 4 — the flat prime dividend's
    // bookmark, `entry[p]`: the ledger's `divAcc` as of this prime's last
    // dividend credit. It lives HERE and not on the ledger for the reason `owed`
    // does (§3.2.1): a row per prime on one shared account fills config 43's
    // 65,536-cell cap. Handed over at sale in `Populate.primeInit` (the value the
    // ledger stamped when the head passed this prime), or — for a prime sold
    // AHEAD of the head — by the ledger's first `CreditDividend.base`; until
    // then it holds the ledger's DIV_ENTRY_UNSTAMPED (2^120 − 1), so no claim
    // pays before the real stamp arrives. 0 in the address-determining default
    // and on every composite.
    divEntry: coins
    // §6 point 2's `getForfeited(p)`: the divisor tribute this prime forfeited
    // while it had no owner, handed over at sale in `Populate.primeInit`. Frozen
    // from then on — an owned prime forfeits nothing. 0 in the default.
    forfeitedTotal: coins
    // ---- D-188 point 6: the number's name lives HERE, not on the registrar
    // (whose one-row-per-number map would have filled config 43's 65,536-cell
    // account cap). D-212: null until the CURRENT OWNER first pays to name it —
    // in the address-determining default, on every fresh mint, prime or
    // composite. One ref, so the bit budget of this cell moves by one bit.
    naming: Cell<ItemNaming>?
}

// D-188 point 4 — what the ledger held for this prime while it had no item,
// handed over at sale. Only a prime mint carries one.
struct PrimeInit {
    divEntry: coins
    forfeited: coins
}

// §4.7.1, D-212: whoever OWNS the number holds the pen. The pen follows the NFT —
// a transfer moves `owner`, and the next naming is the new owner's — so no namer
// is stored: who wrote the current text is in the transaction history, not here.
struct ItemNaming {
    count: uint16      // namings ever written; the first costs `nameFee`, every later one `renameFee`
    text: cell         // the latest; ONE cell, no refs
}

struct Storage {
    n: uint256                // TEP-62 index == the number itself
    collectionAddr: address
    ledgerAddr: address
    m: Cell<ItemMutable>
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// ---- messages ----

// V28: the ledger's ORIGINAL `mint_item`, carried whole by the collection.
// Mirrors primes_ledger.tolk's and primes_collection.tolk's struct field for
// field. This item reads what it stores, keeps `mintValue`, and hands
// `heldSplit` back to the ledger; a refused `Populate` bounces the whole cell to
// the collection, which relays it to the ledger's `retry_item` lane.
struct (0xc0000001) MintItem {
    queryId: uint64
    n: uint256
    owner: address
    isPrime: uint8
    factorization: cell
    rarityFlags: uint16
    mintValue: coins
    head: uint64
    heldSplit: cell?
    primeInit: Cell<PrimeInit>?
}

struct (0xc0000002) Populate {
    mint: Cell<MintItem>
}

struct (0xb0000030) CreditTribute {
    queryId: uint64
    creditId: uint64
    amount: coins
    // GAUNTLET V17 point 1 — mirrors `primes_ledger.tolk`'s struct field for
    // field, as this pair must. The item does not READ `p` (it already knows
    // which number it is); it is here so the ledger can recover the routing
    // target from its own bounced body instead of filing the credit under
    // `p = 0` and stranding it. Both structs are edited together or the wire
    // desynchronises.
    p: uint256
}

// D-188 point 4: the flat dividend, settled HERE because the bookmark is here.
// Sent by the ledger's permissionless `claim_dividend`, carrying the claimant's
// value. `base`, when present, is this prime's bookmark as stamped by the head
// walk — sent once, for a prime sold ahead of the head, whose item could not be
// told at the time.
struct (0xb0000036) CreditDividend {
    queryId: uint64
    p: uint256
    divAcc: coins
    base: coins?
}

// Outbound, to the ledger: how much `CreditDividend` just moved into `owed`, so
// the ledger moves the same amount from `divOutstanding` to `tributeOwed`.
struct (0xb000000e) DividendCredited {
    queryId: uint64
    p: uint256
    amount: coins
}

// V28 (amends D-117): outbound to the ledger from `Populate` — "item(n) exists
// now, pay its split". Sent by THIS item, so the ledger can authenticate it from
// `n` alone and pays nothing for an item that does not exist. `n` is `coins`, not
// uint256: `executeMint` bounds it below 2^82, and the held split rides INLINE
// (root bits pay no forward fee), where a uint256 would overflow the 1023-bit
// root at omega = 12. `isPrime` tells the ledger to clear its in-flight row
// (V32); being sent by this item, the receipt lands after any credit the item
// bounced before it was populated.
struct (0xb000007a) MintConfirmed {
    queryId: uint64
    n: coins
    isPrime: uint1
    heldSplit: RemainingBitsAndRefs
}

struct (0xc1000001) ClaimTribute {
    queryId: uint64
}

// TEP-62 transfer, in FULL. The trimmed two-field version this used to carry
// (queryId + newOwner) parsed a wallet's standard body as garbage and threw, so
// no marketplace could take custody of a number: GetGems emulates the transfer
// into its sale contract before it will list, and answered "this NFT can't be
// listed for sale". The three tail fields are not decoration — `forwardAmount`
// + `forwardPayload` are what the sale contract reads out of `ownership_assigned`
// to know which lot it just received, and without that notification the item
// would sit in a sale contract that never activates.
struct (0x5fcc3d14) Transfer {
    queryId: uint64
    newOwner: address
    responseDestination: address?
    customPayload: cell?
    forwardAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

// TEP-62 notification to the new owner, paid out of `forwardAmount`.
struct (0x05138d91) OwnershipAssigned {
    queryId: uint64
    previousOwner: address
    forwardPayload: RemainingBitsAndRefs
}

// TEP-62 change-back to `responseDestination`.
struct (0xd53276db) Excesses {
    queryId: uint64
}

// TEP-62 static-data probe, used by indexers and wallets to confirm an item
// really belongs to the collection it names.
struct (0x2fcb26a2) GetStaticData {
    queryId: uint64
}

struct (0x8b771735) ReportStaticData {
    queryId: uint64
    index: uint256
    collection: address
}

// Deviation from the Phase 2 spec (documented in docs/phase3-report.md):
// CONCEPT.md §3.1/§4.1 requires referral payouts to resolve to "the current
// owner of NFT #key" *on-chain, at mint time*. TVM has no synchronous
// cross-contract read, so the ledger cannot look up an item's `owner` field
// inside the mint transaction. This item-side relay closes that gap: the
// ledger forwards the referral GRAM to `ItemAddress(key)` (computable from the
// key alone, exactly like the tribute claim path) with this opcode, and the
// item — which DOES know its own current owner synchronously — forwards the
// value onward. This opcode does not appear in /shared/schemas/ledger.tlb (a
// Phase 2 deliverable); it is a Phase 3 addition required to make §4.1's
// referral mechanism implementable on real TVM. It IS registered in
// /shared/opcodes.ts as `ITEM.forward_to_owner` (P2.C4).
struct (0xc1000002) ForwardToOwner {
    queryId: uint64
}

// `prove_ownership` / `ownership_proof` (0xb0000063 / 0xb0000064), the build
// input round trip, are DELETED with constellations (DECISIONS.md D-202).

// D-62/D9.1: a composite item is endowed exactly once, at deploy
// (`ITEM_DEPLOY_VALUE`), and never topped up by any other message — a
// composite is never cited as a tribute factor, so it never receives
// `CreditTribute`'s gas either. Measured rent (~0.0025 GRAM/year, D9,
// `StorageRent.spec.ts`) against that one-time endowment gives a runway on
// the order of a decade, after which GRAM freezes the contract for good: no
// `Transfer`, no `get_nft_data`, no claim. The owner's call (D-62) was that
// no item should ever be allowed to reach that cliff.
//
// This message is intentionally almost content-free: TVM already credits an
// incoming message's value to the contract's balance before any code runs,
// which is what actually extends the rent runway — an unrecognized,
// EMPTY-body message already does this by accident (the `else` arm below
// accepts one). What `TopUp` adds is not the mechanism but the NAME: a
// message anyone can send, from anywhere (a wallet, a script, a future
// "keep this number alive" webapp button) that says what it is for, so the
// affordance is discoverable rather than an accident of the fallback arm.
struct (0xc1000006) TopUp {
    queryId: uint64
}

// D-212. inbound, from the COLLECTION only: `payer` asks to name this number and
// sent the fee. The collection relays it because it is the one peer this item can
// authenticate, and it carries both fees from its deploy data so the item stores
// neither. `payer` is checked against `owner` HERE, because this is the only
// contract that knows the owner. (0xc1000007, `item_annotate`, is retired with
// D-179's burn route; not recycled.)
struct (0xc1000008) ItemName {
    queryId: uint64
    payer: address
    text: cell
    nameFee: coins
    renameFee: coins
}

// D-212. outbound, item -> collection: the fee, which the collection forwards to
// the ledger as a pure floor step (`royalty_to_ratchet`: `T` rises, `S` does not).
// `count` is the naming's ordinal, 1 for the first — the collection's meters tell
// a first naming from a rename by it.
struct (0xc000000a) NamingPaid {
    queryId: uint64
    n: uint256
    amount: coins
    count: uint16
}

type AllowedMessage = Populate | CreditTribute | CreditDividend | ClaimTribute | Transfer | ForwardToOwner
    | TopUp | GetStaticData | ItemName

// D-212: the gas the fee carries from this item to the ratchet — the collection's
// relay, the ledger's `royalty_to_ratchet` and its `RATCHET_HOP_GAS` hop. The
// secondary royalty sends its ratchet half with 0.015 GRAM for the last two hops;
// 0.03 adds the collection's. Measured in Naming.spec.ts at exactly this figure.
const NAMING_PAID_GAS: coins = 30000000; // 0.03 GRAM
// D-212: this item's own compute and the change send home. A naming carrying less
// than `fee + NAMING_PAID_GAS + ITEM_NAME_GAS` is refunded whole.
const ITEM_NAME_GAS: coins = 20000000;   // 0.02 GRAM

// GAUNTLET V10 precedent (`primes_ledger.tolk`'s `CLAIM_DIVIDEND_MIN_VALUE`):
// the minimum a caller must fund `ClaimTribute` with. The item is endowed once
// at deploy (`ITEM_DEPLOY_VALUE` + `CREDIT_TRIBUTE_VALUE` per credit) and never
// topped up by a claim itself, so a claim that spends more of that endowment
// than the caller funded walks the item toward the freeze cliff D-62's
// permissionless `TopUp` exists to relieve — one or two unfunded claims used
// to exhaust it outright. Measured on `@ton/sandbox` (`StorageRent.spec.ts`'s
// "GAUNTLET V10" case): attaching 0.03 GRAM left the item's own balance
// ~0.0096 GRAM HIGHER after the claim than before it, i.e. real break-even is
// ~0.0204 GRAM (the claim's own compute — one scalar zero, one `save` — plus
// the `ton("0.02")` forwarded to `LedgerClaimTribute`). Rounded up to the
// same 0.01 GRAM-scale margin `CLAIM_DIVIDEND_MIN_VALUE` uses over ITS
// measured gap.
const CLAIM_TRIBUTE_MIN_VALUE: coins = 30000000; // 0.03 GRAM

// D-72 / GAUNTLET T4, for `getStorageRunway()` below. `BASECHAIN` (workchain 0)
// comes from the stdlib. Items live there for the reason the whole ledger does:
// `mc_cell_price_ps` is 500,000 against the basechain's 135, a 4,200x difference.
//
// 365 days. The unit the runway is MEASURED over before being divided back down
// to seconds — see the get-method's note on truncation.
const SECONDS_PER_YEAR: int = 31536000;
// Slack by orders: config 43 caps a non-masterchain account at 65,536 cells and
// this item's state is a fixed handful. A bound is required by CDATASIZE, which
// aborts rather than walking an unbounded tree.
const RUNWAY_MAX_CELLS: int = 4096;

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        Populate => {
            var storage = lazy Storage.load();
            assert (in.senderAddress == storage.collectionAddr) throw 100; // wrong_sender
            var m = storage.m.load();
            assert (m.populated == 0) throw 104; // already_processed
            val mint = msg.mint.load();
            m.owner = mint.owner;
            m.isPrime = mint.isPrime;
            m.factorization = mint.factorization;
            m.rarityFlags = mint.rarityFlags;
            // §9.8's mint date. Stamped HERE rather than carried on `MintItem`:
            // the ledger's message is already within 1023 bits of the single-cell
            // ceiling (see its `head` field's note), and this transaction is one
            // hop from the mint in the same message chain, so the day is the same
            // day. Written before `populated` flips, and never rewritten — the
            // `populated == 0` assert above is what makes it write-once.
            m.mintedDay = (blockchain.now() / 86400) as uint24;
            val primeInit = mint.primeInit;
            if (primeInit != null) {
                val pi = primeInit.load();
                m.divEntry = pi.divEntry;
                m.forfeitedTotal = pi.forfeited;
            }
            m.populated = 1;
            storage.m = m.toCell();
            storage.save();
            // V28 — THE RECEIPT, from the item itself. Everything the deploy brought
            // above `mintValue` is the held split; it goes home to the ledger, which
            // pays the lines on arrival. The deploy's forward fee is added back so
            // this item keeps what it kept when the collection sent it exactly
            // `mintValue` (the split, not the item's endowment, pays the extra hop).
            // NO `IGNORE_ERRORS`: a receipt that cannot be sent fails the action
            // phase, `Populate` bounces WHOLE, and the ledger parks the mint for
            // `retry_item` instead of paying it. `null` on Unity: nothing to return.
            val heldSplit = mint.heldSplit;
            if (heldSplit != null) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: in.valueCoins - mint.mintValue + in.originalForwardFee,
                    dest: storage.ledgerAddr,
                    body: (MintConfirmed {
                        queryId: mint.queryId,
                        n: storage.n as coins,
                        isPrime: mint.isPrime as uint1,
                        heldSplit: heldSplit.beginParse(),
                    }).toCell(),
                }).send(SEND_MODE_REGULAR);
            }
        }

        ItemName => {
            // D-212 (§4.7.1). The collection is the only sender. EVERY refusal past
            // the sender check REFUNDS the whole value to the payer rather than
            // throwing: the relay is bounceable, but a bounce would land the fee on
            // the collection, whose catch-all arm reads unknown GRAM as a royalty.
            var storage = lazy Storage.load();
            assert (in.senderAddress == storage.collectionAddr) throw 100; // wrong_sender
            var m = storage.m.load();
            val naming = m.naming;
            val count: int = naming == null ? 0 : naming.load().count;
            val fee: coins = count == 0 ? msg.nameFee : msg.renameFee;
            val ok = m.populated == 1
                && msg.payer == m.owner
                && msg.text.beginParse().remainingRefsCount() == 0 // ONE cell (D-188 point 2)
                && count < 65535
                && in.valueCoins >= fee + NAMING_PAID_GAS + ITEM_NAME_GAS;
            if (!ok) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: msg.payer,
                    body: beginCell().endCell(),
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
                return;
            }
            m.naming = (ItemNaming { count: (count + 1) as uint16, text: msg.text }).toCell();
            storage.m = m.toCell();
            storage.save();
            // Keep what this item held before the naming arrived (for a prime that
            // is the owner's unclaimed `owed`); the fee leaves first, the change
            // after it, and neither can touch the reserve.
            reserveToncoinsOnBalance(contract.getOriginalBalance() - in.valueCoins, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                value: fee + NAMING_PAID_GAS,
                dest: storage.collectionAddr,
                body: (NamingPaid {
                    queryId: msg.queryId,
                    n: storage.n,
                    amount: fee,
                    count: (count + 1) as uint16,
                }).toCell(),
            }).send(SEND_MODE_REGULAR);
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: msg.payer,
                body: beginCell().endCell(),
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        CreditTribute => {
            var storage = lazy Storage.load();
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            var m = storage.m.load();
            // Anyone can deploy this item's canonical empty state at ItemAddress(p),
            // so EXISTING is not being OWNED. An unpopulated item refuses the credit;
            // the ledger's bounce arm reads 307 as "no owner" and forfeits (§6 point 2).
            assert (m.populated == 1) throw 307; // item_not_populated
            m.owed += msg.amount;
            m.tributeTotal += msg.amount;
            storage.m = m.toCell();
            storage.save();
        }

        CreditDividend => {
            // §3.2's `claim pays div_acc − entry[p] and re-stamps`, with the
            // stamp on this side of the wire. Messages from the ledger arrive in
            // the order it sent them, and `divAcc` only rises, so two claims in
            // flight settle one after the other and never pay the same span twice.
            var storage = lazy Storage.load();
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            var m = storage.m.load();
            // Same rule as CreditTribute: a squatted empty item must not consume the
            // parked bookmark. The bounce arm puts it back for the real item.
            assert (m.populated == 1) throw 307; // item_not_populated
            val base = msg.base;
            if (base != null) { m.divEntry = base; }
            if (msg.divAcc <= m.divEntry) {
                if (base != null) { storage.m = m.toCell(); storage.save(); }
                return; // nothing accrued since the last stamp — the value stays as rent
            }
            val amount: coins = msg.divAcc - m.divEntry;
            m.divEntry = msg.divAcc;
            m.owed += amount;
            storage.m = m.toCell();
            storage.save();
            // The rest of the claimant's value carries the report home. NoBounce:
            // the ledger's arm is an authenticated two-meter move with nothing to
            // refuse; `CLAIM_DIVIDEND_MIN_VALUE` is sized so it cannot run dry.
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: storage.ledgerAddr,
                body: (DividendCredited { queryId: msg.queryId, p: storage.n, amount: amount }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        ClaimTribute => {
            var storage = lazy Storage.load();
            var m = storage.m.load();
            assert (in.senderAddress == m.owner) throw 300; // item_not_owner
            if (m.owed == 0) {
                // cheap-fail: refund gas, no message onward (engineering-spec §3.2 step 1)
                return;
            }
            // GAUNTLET V10: the only guard between a claim and spending the
            // item's own rent endowment. Placed AFTER the owed==0 cheap-fail
            // so a zero-owed claim needs no extra margin — only a real send
            // does.
            assert (in.valueCoins >= CLAIM_TRIBUTE_MIN_VALUE) throw 103; // insufficient_value
            val amount = m.owed;
            val owner = m.owner;
            m.owed = 0; // zero BEFORE sending — safety-critical, engineering-spec §5 row 3
            storage.m = m.toCell();
            storage.save();

            createMessage({
                bounce: BounceMode.RichBounce,
                value: ton("0.02"),
                dest: storage.ledgerAddr,
                body: (LedgerClaimTribute {
                    queryId: msg.queryId,
                    p: storage.n,
                    amount: amount,
                    owner: owner,
                }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }

        Transfer => {
            var storage = lazy Storage.load();
            var m = storage.m.load();
            assert (in.senderAddress == m.owner) throw 300; // item_not_owner
            val previousOwner = m.owner;
            m.owner = msg.newOwner;
            storage.m = m.toCell();
            storage.save();

            // The item keeps exactly the balance it had before this message —
            // its D-62 rent endowment — and nothing more: reserve that, then let
            // the notification and the change spend only what the transfer
            // attached. (A plain mode-64 excesses cannot be used here: the
            // notification has already claimed part of the inbound value, and
            // the second message would over-claim it and be dropped with 37.)
            reserveToncoinsOnBalance(contract.getOriginalBalance() - in.valueCoins,
                                     RESERVE_MODE_AT_MOST);
            if (msg.forwardAmount > 0) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: msg.forwardAmount,
                    dest: msg.newOwner,
                    body: (OwnershipAssigned {
                        queryId: msg.queryId,
                        previousOwner: previousOwner,
                        forwardPayload: msg.forwardPayload,
                    }).toCell(),
                // TEP-62: `forward_amount` is what the new owner RECEIVES, so the
                // forward fee is paid on top, out of the transfer's attached value
                // (the reserve above keeps it off the rent endowment). Mode 0 took
                // it out of the amount, and a venue checking `msg_value >=
                // forward_amount` refused the deposit (2026-11-08 audit).
                }).send(SEND_MODE_PAY_FEES_SEPARATELY);
            }
            val respondTo = msg.responseDestination;
            if (respondTo != null) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: respondTo,
                    body: (Excesses { queryId: msg.queryId }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        GetStaticData => {
            val storage = lazy Storage.load();
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: in.senderAddress,
                body: (ReportStaticData {
                    queryId: msg.queryId,
                    index: storage.n,
                    collection: storage.collectionAddr,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        ForwardToOwner => {
            var storage = lazy Storage.load();
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            var m = storage.m.load();
            // Anyone can deploy this item's canonical empty state, and the referral
            // can overtake `Populate` (the V32 race), so an unpopulated item's
            // `owner` is the collection placeholder — relaying would pay the
            // collection's royalty split, half to the operator. Refuse: the bounce
            // returns the GRAM to the ledger as surplus, and `sweep_ops` returns it
            // to the pool (§4.1: an unresolvable line falls to the pool).
            assert (m.populated == 1) throw 307; // item_not_populated
            // G89 / D-177: count it BEFORE the relay, so `getReferralPaid()` is the GRAM this
            // key has paid. Recorded as received; the relay below carries it on less gas.
            m.referralPaidTotal += in.valueCoins;
            storage.m = m.toCell();
            storage.save();
            // owner is a real wallet here: `populated` was checked above (D-106
            // deleted the unclaimed, ownerless item and its redirect).
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: m.owner,
                body: beginCell().endCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        // D-62/D9.1: permissionless. The value already landed in the contract's
        // balance before this handler ran (TVM's own accounting, not this
        // contract's) — there is nothing to credit and nothing to store. This
        // arm exists to accept the message rather than throw on it, the same
        // way the empty-body fallback below already does, but under a name.
        TopUp => {}

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// mirrors ledger.tlb's claim_tribute inbound shape (opcode 0xb0000004); reproduced
// here as the outbound struct this item sends.
struct (0xb0000004) LedgerClaimTribute {
    queryId: uint64
    p: uint256
    amount: coins
    owner: address
}

fun onBouncedMessage(in: InMessageBounced) {
    // claim_tribute bounced back from the ledger: restore owed (engineering-spec §5 row 3).
    var storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    val original = lazy LedgerClaimTribute.fromCell(rich.originalBody);
    var m = storage.m.load();
    m.owed += original.amount;
    storage.m = m.toCell();
    storage.save();
}

get fun getNumberData(): (int, address, int) {
    val storage = lazy Storage.load();
    val m = storage.m.load();
    return (storage.n, m.owner, m.isPrime);
}

// CONCEPT §9.8 / §9.1. The mint date, in DAYS SINCE THE UNIX EPOCH — the number
// the NFT artwork prints on its overlay strip, published so a reader can check
// the picture against the chain rather than against an indexer. 0 until
// `Populate` lands, which is the same "not yet" `get_nft_data`'s `init?` reports.
get fun getMintedDay(): int {
    val storage = lazy Storage.load();
    return storage.m.load().mintedDay;
}

get fun getOwed(): int {
    val storage = lazy Storage.load();
    return storage.m.load().owed;
}

// D-188 point 4 / §3.2 / §9.1: the flat dividend's bookmark, `entry[p]`.
get fun getDivEntry(): int {
    val storage = lazy Storage.load();
    return storage.m.load().divEntry;
}

// `div_acc − entry[p]`, clamped at zero, for the `divAcc` the caller read off
// the ledger's `getDivAcc()` — the item cannot read it itself, and a get-method
// that took no argument would have to publish a stale copy.
get fun getClaimableDividend(divAcc: int): int {
    val storage = lazy Storage.load();
    val entry = storage.m.load().divEntry;
    return divAcc > entry ? divAcc - entry : 0;
}

// §6 point 2's per-prime forfeit counter, once the prime has an owner (the
// ledger's `getForfeited(p)` answers while it does not). Frozen at sale.
get fun getForfeited(): int {
    val storage = lazy Storage.load();
    return storage.m.load().forfeitedTotal;
}

// CONCEPT §3.2.1 / §9.1. Cumulative divisor tribute credited to this item, in
// nanoGRAM. Never decremented — a claim moves `owed`, not this. The flat prime
// dividend is not in it: `CreditDividend` adds to `owed` only.
get fun getTributeTotal(): int {
    val storage = lazy Storage.load();
    return storage.m.load().tributeTotal;
}

// CONCEPT §9.11 / D-177 (GAUNTLET G89). Cumulative §4.1 referral GRAM this number's key has
// relayed to its owner, in nanoGRAM, as received from the ledger. Never decremented. The
// referral board ranks keys by it; 0 for a key that has never been cited on a paid mint.
get fun getReferralPaid(): int {
    val storage = lazy Storage.load();
    return storage.m.load().referralPaidTotal;
}

// §4.7.1, D-212. Who holds the pen on this number: its current owner, once
// Populate has landed; addr_none before. Kept as its own get-method so a reader
// asks "who may name this" in the same words for every number.
get fun getNamer(): slice {
    val storage = lazy Storage.load();
    val m = storage.m.load();
    if (m.populated == 0) { return beginCell().storeUint(0, 2).endCell().beginParse(); }
    return beginCell().storeAddress(m.owner).endCell().beginParse();
}

// §4.7.1, D-212. (count, text): count 0 and an empty cell while unnamed. The
// next naming costs `nameFee` when count is 0 and `renameFee` after —
// the collection's `getNaming()`.
get fun getAnnotation(): (int, cell) {
    val storage = lazy Storage.load();
    val naming = storage.m.load().naming;
    if (naming == null) { return (0, beginCell().endCell()); }
    val rec = naming.load();
    return (rec.count, rec.text);
}

// D-72 / GAUNTLET T4 (D9.1). SECONDS UNTIL THIS ITEM FREEZES, at the CURRENT
// config-18 storage price. Returns -1 for "no finite runway" — the basechain
// price being zero, which is not hypothetical: `bit_price_ps` is already 0 on
// workchain 0 and only `cell_price_ps` is charged.
//
// Why this exists. D-62 shipped the permissionless `TopUp` opcode so ANYONE can
// extend a composite item's rent, but nothing reported the runway, so no surface
// could show it and nobody knew when to top up. A composite is endowed once with
// `ITEM_DEPLOY_VALUE` and never paid again — only primes are cited as tribute
// factors, so no `credit_tribute` ever tops a composite up — and when it lapses
// GRAM freezes the account. A frozen item answers NOTHING: no `Transfer`, no
// `get_nft_data`, no `ClaimTribute`, while §3.1 and §4.7.1 both say "permanent".
//
// Owner took the get-method over reading raw account state so §9.1 stays literal:
// every number a surface shows maps to a public get-method, and "years of rent
// left" is a number a surface will want to show.
//
// The price is read LIVE rather than baked: `calculateStorageFee` is TVM's
// GETSTORAGEFEE, which prices against the config-18 in force in this very block,
// so a network fee change is reflected without a redeploy. Measured over a year
// and divided, never over one second — an item's per-second rent is a fraction of
// a nanoton and would truncate to 0, reporting an infinite runway on a contract
// that is in fact dying.
get fun getStorageRunway(): int {
    // code + data is exactly what config 18 charges for, and what config 43's
    // `max_acc_state_cells` bounds. The item's state does not grow with mint
    // volume, credit count or `n` (see this file's header), so this walk is over
    // a fixed, small tree and the bound is slack by orders.
    val (dataCells, dataBits, _) = contract.getData().calculateSizeStrict(RUNWAY_MAX_CELLS);
    val (codeCells, codeBits, _) = contract.getCode().calculateSizeStrict(RUNWAY_MAX_CELLS);
    val feePerYear = calculateStorageFee(BASECHAIN, SECONDS_PER_YEAR, dataBits + codeBits, dataCells + codeCells);
    if (feePerYear <= 0) { return -1; }
    // Rent already accrued and not yet settled is money this balance does not
    // really have; counting it would over-report the runway in exactly the
    // situation the reader cares about most.
    val due = contract.getStorageDuePayment();
    val balance = contract.getOriginalBalance() - due;
    if (balance <= 0) { return 0; }
    return balance * SECONDS_PER_YEAR / feePerYear;
}

// ---- TEP-62 / TEP-66 standard surface ----
//
// The camelCase getters above are this project's own interface and stay as they
// are (the ledger, the read-proxy and the webapp all resolve them by name). The
// getters below exist because method IDs are derived from the EXACT method name
// string: a marketplace, wallet or indexer calls `get_nft_data`, and nothing
// else will do. Without them the item is a well-formed NFT that no venue can
// read — which, since CONCEPT §3.1's secondary royalty is a marketplace
// convention rather than an enforced transfer tax, would make that royalty
// unearnable rather than merely unenforceable.
//
// `individual_content` is returned EMPTY by design: the collection composes the
// full TEP-64 content from `index` in `get_nft_content` (the common-prefix
// pattern), so the item never stores a per-number URI it would otherwise have to
// carry for a million items.
get fun get_nft_data(): (int, int, slice, slice, cell) {
    val storage = lazy Storage.load();
    val m = storage.m.load();
    return (
        m.populated == 1 ? -1 : 0,   // init? — TVM true is -1; 0 until Populate lands
        storage.n,     // index == the number itself
        beginCell().storeAddress(storage.collectionAddr).endCell().beginParse(),
        beginCell().storeAddress(m.owner).endCell().beginParse(),
        beginCell().endCell()
    );
}
