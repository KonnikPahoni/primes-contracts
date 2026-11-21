tolk 1.4

// ============================================================================
// TON PRIMES — NFT collection (TEP-62 collection, minimal relay).
// Phase 3, IMPLEMENTATION_PLAN.md §3 build step 2.
//
// Deliberately thin: per docs/engineering-spec.md §1, folding never applied to
// this contract, but its own job is small — the ledger does all verification
// (factorization, Miller–Rabin) before ever sending `mint_item`; the
// collection's only responsibility is deploying the item with the canonical,
// owner-independent init data (see primes_item.tolk's header comment for why
// that shape matters for ItemAddress(p) being computable by the ledger alone).
// ============================================================================

struct Aux {
    genesisScriptAddr: address
    // CONCEPT §3.1 / §2 principle 4: the secondary royalty. Fixed at deploy,
    // with no message that can change any of the three fields — the same shape
    // as every other parameter here. `royaltyDest` is the OPERATOR wallet
    // (`genesisPipeline.ts`'s `royaltyDest: params.operatorAddr`), not the
    // governed treasury (D-128).
    //
    // This is a TEP-66 DECLARATION, not an enforced transfer tax: `Transfer`
    // (0x5fcc3d14) on the item is the plain TEP-62 one and takes no cut. A
    // wallet-to-wallet transfer pays nothing and a marketplace that ignores the
    // declaration pays nothing. CONCEPT §3.1 says so in the same paragraph that
    // introduces the royalty, because §2's first principle is that every
    // economic claim is contract-verifiable and this one is a convention. A
    // transfer hook that COULD enforce it would be an admin lever over other
    // people's property, which §8 forbids at any price.
    royaltyNum: uint16
    royaltyDen: uint16
    royaltyDest: address
    // TEP-64 offchain content. `collectionContent` is the collection's own
    // metadata cell; `commonContentPrefix` is the base URI that
    // `get_nft_content` completes with the index (see there).
    collectionContent: cell
    commonContentPrefix: cell
    // D-212: the REGISTRAR, the one sender of `naming_paid` besides the items — an
    // era trophy's paid re-engraving (§4.7.1) reaches the floor through here,
    // because the ledger's floor-step door is this contract. Fixed at deploy — the
    // registrar's address depends only on its code and deploy data, never on this
    // contract's, so there is no circular edge to bootstrap.
    registrarAddr: address
}

// D-212 (§4.7.1). The two naming fees, in TON, and what naming has paid the floor.
// `nameFee`/`renameFee` are DEPLOY DATA with no message that changes them (§8,
// D-194: a fee is a price, and this one has a fixed destination — the floor);
// a different fee is a fresh genesis. The three meters change on every
// `naming_paid` and are §9.1's whole story of the line: `toFloor` is every
// nanoton this contract has forwarded to the ledger as a naming's floor step.
struct NamingBook {
    nameFee: coins
    renameFee: coins
    named: uint32      // first namings (an item's count went 0 -> 1)
    renamed: uint32    // every later one, an era trophy's paid re-engraving included
    toFloor: coins
}

// GAUNTLET W7. WHAT THIS COLLECTION HAS ACTUALLY FORWARDED, each way, and how
// many deliveries it took. D-128 divides 50/50, but it divides the NET: the
// balance above the storage floor, LESS `ROYALTY_FORWARD_GAS` for the three-hop
// delivery. On a 1 TON resale at §3.1's 5% rate that skim is 40% of the royalty;
// on a 10 TON one, 4%; above that, negligible. So the split a holder actually
// experiences is not the nominal one, and §9.1 forbids printing a figure a reader
// cannot recompute. Published by `getRoyaltySplit()`.
//
// Its own ref rather than three fields on `Storage`: the (retired) generators collection's root
// cell is already at 582 bits with two addresses in it, and three `coins`/`uint32`
// counters push its serialisation estimate past the 1023-bit ceiling (the compiler
// says so — `struct Storage can exceed 1023 bits`). A ref keeps both collections
// the same shape, which is the property the royalty arm is duplicated to preserve.
// Deliberately NOT inside `Aux`: that struct is address-determining deploy data
// with no message that can change any field, and these three change on every
// forward.
struct RoyaltyMeters {
    toRatchet: coins
    toOperator: coins
    forwards: uint32
}

struct Storage {
    // Mirrors ledger.head, and is TEP-62's `next_item_index`. Informational:
    // kept because the standard requires it and every `mint_item` carries the
    // number that maintains it for free.
    nextIndex: uint256
    itemCode: cell
    ledgerAddr: address
    ledgerSet: uint8         // D7 (see below): one-shot bootstrap flag
    royalty: Cell<RoyaltyMeters>
    aux: Cell<Aux>
    naming: Cell<NamingBook>
}

// D7 (docs/phase3-report.md): the ledger and the collection each need the
// OTHER's address baked into their address-determining init data
// (collection checks `sender == ledgerAddr`; ledger computes item addresses from
// `collectionAddr`) — a genuine circular dependency the Phase 2 spec's
// storage tables don't resolve (they show both as fixed-at-deploy). Resolved
// here the same way primes_item.tolk's owner field is resolved: the
// collection deploys with `ledgerAddr` unset and a `ledgerSet` flag, and the
// genesis script (a used-up bootstrap credential, exactly like the jetton
// master's `genesisScriptAddr` pattern already in the spec for
// `seal_authority`) sends a one-shot `SetLedger` message once the ledger's
// address is known. After `ledgerSet = 1`, no message can ever change it again
// — this is not a standing admin key, it closes the same way `seal_authority`
// does.

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// Must byte-for-byte match primes_item.tolk's `Storage` struct (field order +
// types) — this is the accepted, documented duplication described in
// primes_item.tolk's header.
struct ItemMutable {
    populated: uint8
    owner: address
    isPrime: uint8
    factorization: cell
    rarityFlags: uint16
    owed: coins
    // §9.8's mint date, days since the Unix epoch. Mirrored from
    // primes_item.tolk; 0 in the address-determining default, which is what keeps
    // `ItemAddress(n)` a pure function of `n`.
    mintedDay: uint24
    // CONCEPT §3.2.1 — cumulative credit, mirrored from primes_item.tolk; 0 in the
    // address-determining default.
    tributeTotal: coins
    // D-177 / G89 — cumulative referral relayed, mirrored from primes_item.tolk; 0 in the
    // address-determining default.
    referralPaidTotal: coins
    // D-188 point 4 — the dividend bookmark and the forfeit counter, mirrored
    // from primes_item.tolk; 0 in the address-determining default.
    divEntry: coins
    forfeitedTotal: coins
    // D-188 point 6 / D-212 — the number's name, mirrored from primes_item.tolk
    // (`Cell<ItemNaming>?` there; same bits); null in the default.
    naming: cell?
}

struct ItemStorage {
    n: uint256
    collectionAddr: address
    ledgerAddr: address
    m: Cell<ItemMutable>
}

fun buildItemInitData(n: int, collectionAddr: address, ledgerAddr: address): cell {
    val defaultMutable = (ItemMutable {
        populated: 0,
        owner: collectionAddr, // placeholder, overwritten by Populate in the same tx
        isPrime: 0,
        factorization: beginCell().endCell(),
        rarityFlags: 0,
        owed: 0,
        // 0, always: the mint date arrives with `Populate`, in the same
        // transaction — the item's address must stay a pure function of `n`.
        mintedDay: 0,
        tributeTotal: 0,
        referralPaidTotal: 0,
        divEntry: 0,
        forfeitedTotal: 0,
        naming: null,
    }).toCell();
    return (ItemStorage {
        n: n,
        collectionAddr: collectionAddr,
        ledgerAddr: ledgerAddr,
        m: defaultMutable,
    }).toCell();
}

struct (0xc0000001) MintItem {
    queryId: uint64
    n: uint256
    owner: address
    isPrime: uint8
    factorization: cell
    rarityFlags: uint16
    mintValue: coins   // item-deploy share of gas & ops forwarded as the deploy's attached value
    // §4.6 / §7: the LEDGER's head after this mint. The collection cannot derive
    // it — D-20 walks the head past every prime it crosses and that walk never
    // reaches this contract — so the one contract that knows it says so, on a
    // message that was already being sent.
    //
    // uint64 and not uint256: `MintItem` has no room for a uint256 inside one
    // cell, and a head above 2^64 is unreachable by sequential minting.
    head: uint64
    // D-117 — the ledger's held split, OPAQUE here: this contract never reads
    // it. It rides to the item inside `Populate`, and the item hands it back to
    // the ledger in `mint_confirmed` with the value it rode on (V28). `null` on
    // Unity, which carries no split.
    heldSplit: cell?
    // D-188 point 4 — a prime's dividend bookmark and forfeit counter, handed
    // from the ledger to the new item. Passed through inside `Populate` unread.
    primeInit: cell?
}

// V28: the item's deploy body is the ORIGINAL `MintItem`, as a ref. The item reads
// owner, kind, factorization and `primeInit` from it, keeps `mintValue`, and sends
// the held split back to the ledger as `mint_confirmed` itself — so the receipt
// is sent only by an item that exists. Carried whole so that a refused `Populate`
// bounces back here with everything the ledger needs to park it (`n` included,
// which the bounce's sender address alone cannot give back).
struct (0xc0000002) Populate {
    mint: cell   // the incoming `MintItem` body, byte for byte
}

// V28: a `Populate` the item refused, relayed to the ledger with all the value
// that bounced. The ledger parks `mint` for `retry_item` exactly as it parks a
// `MintItem` this contract refused. Mirrors primes_ledger.tolk's struct.
struct (0xb0000084) MintItemRefused {
    mint: cell
}

// D-128 — the secondary-royalty split, the three figures it needs.
//
// `ROYALTY_RATCHET_BPS` is `shared/params.json` `fees.royalty_ratchet_bps`. It is
// NOT sim-derived and that file says so in words: nothing under `sim/` models
// secondary-market turnover, so there is no volume series for a royalty rate to
// apply to. It is a disclosed policy choice in D-114's idiom, the same class of
// number as the ledger's `PREMIUM_TREASURY_BPS`.
//
// The other two are gas, not economics — the same class as the ledger's
// `RATCHET_HOP_GAS`. `ROYALTY_FORWARD_GAS` is what the whole three-hop delivery
// costs (this transaction's compute, both legs' forward fees, the ledger's
// compute and its onward hop to the ratchet) and is skimmed off the top before
// the split, so the cost is borne by both sides in proportion. It is also the
// threshold: below it nothing is forwarded and the money waits for the next
// royalty, because burning a small payout on three hops would deliver less than
// it cost.
const ROYALTY_RATCHET_BPS: int = 5000;
const BPS_DEN: int = 10000;
const ROYALTY_FORWARD_GAS: coins = 20000000;      // 0.02 TON: the whole delivery
const ROYALTY_LEDGER_HOP_GAS: coins = 15000000;   // 0.015 TON of it rides to the ledger
// The genesis endowment (`genesisPipeline.ts`: `sendDeploy(..., toNano('0.5'))`).
// Reserved on every royalty so this contract's rent is never spent on delivering
// somebody else's money, and so the deploy message itself forwards nothing.
const ROYALTY_STORAGE_FLOOR: coins = 500000000;   // 0.5 TON
// G81: the smallest operator leg worth a message -- the ledger's `RATCHET_HOP_GAS`,
// the measured one-hop budget, not a new figure.
const ROYALTY_MIN_LEG: coins = 1000000;           // 0.001 TON

// D-128: the ratchet's half of a secondary royalty, sent to the LEDGER, which
// does `T += amount` with `S` untouched and forwards the TON to the ratchet as
// `pending`. Declared here rather than imported because these contracts share no
// header; `shared/schemas/ledger.tlb` and `shared/opcodes.ts` are the one
// authority for the opcode and the field order.
struct (0xb0000079) RoyaltyToRatchet {
    queryId: uint64
    amount: coins
}

struct (0xc0000003) SetLedger {
    queryId: uint64
    ledgerAddr: address
}

// TEP-66 royalty request. Standard opcode pair: a marketplace sends
// 0x693d3950 and expects 0xa8cb00ad back carrying (numerator, denominator,
// destination). Some venues read the get-method instead; both are supported
// because which one a given indexer uses is not ours to choose.
struct (0x693d3950) GetRoyaltyParams {
    queryId: uint64
}

// D-212 (§4.7.1). inbound, PERMISSIONLESS: name number `n`, with the fee attached
// (`getNaming()`: `nameFee` the first time, `renameFee` after) plus gas. The
// collection checks nothing but the value floor; item(n) checks the owner and the
// count and refunds the whole value on any refusal. An `n` with no item bounces the
// relay back here, and the bounce arm refunds the sender. (0xc0000008,
// `relay_annotation`, is retired with D-179's burn route; not recycled.)
struct (0xc0000009) NameNumber {
    queryId: uint64
    n: uint256
    text: cell
}

// outbound, collection -> item. Mirrors primes_item.tolk's `ItemName`.
struct (0xc1000008) ItemName {
    queryId: uint64
    payer: address
    text: cell
    nameFee: coins
    renameFee: coins
}

// D-212. inbound, from item(n) — or the registrar, for a trophy's re-engraving —
// only: a naming's fee, forwarded to the ledger as `royalty_to_ratchet`.
struct (0xc000000a) NamingPaid {
    queryId: uint64
    n: uint256
    amount: coins
    count: uint16
}

// D-212: the least a `name_number` may carry — the cheaper fee, plus the relay's
// gas and the item's (`NAMING_PAID_GAS` + `ITEM_NAME_GAS` in primes_item.tolk).
// Below it the message is refused at this door and bounces home; at or above it
// every refusal is the item's, and refunds.
const NAME_RELAY_GAS: coins = 60000000; // 0.06 TON

type AllowedMessage = MintItem | SetLedger | GetRoyaltyParams | NameNumber | NamingPaid

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        SetLedger => {
            var storage = lazy Storage.load();
            val aux = storage.aux.load();
            assert (in.senderAddress == aux.genesisScriptAddr) throw 100; // wrong_sender
            assert (storage.ledgerSet == 0) throw 104; // already_processed
            storage.ledgerAddr = msg.ledgerAddr;
            storage.ledgerSet = 1;
            storage.save();
        }

        NameNumber => {
            // D-212. Pass-through: derive item(n) from `n` alone (the item's
            // address is a pure function of it) and hand it the payer, the text,
            // both fees and the whole value. BOUNCEABLE: an `n` that was never
            // minted has no contract to refund from, so the bounce comes home and
            // `onBouncedMessage` returns it to the sender. No state written here.
            val storage = lazy Storage.load();
            assert (storage.ledgerSet == 1) throw 101;                      // wrong_opcode (not wired)
            val book = storage.naming.load();
            assert (in.valueCoins >= book.nameFee + NAME_RELAY_GAS) throw 103; // insufficient_value
            val initData = buildItemInitData(msg.n, contract.getAddress(), storage.ledgerAddr);
            val itemAddr = (AutoDeployAddress {
                workchain: 0,
                stateInit: ContractState { code: storage.itemCode, data: initData },
            }).calculateAddress();
            createMessage({
                bounce: BounceMode.RichBounce,
                value: 0,
                dest: itemAddr,
                body: (ItemName {
                    queryId: msg.queryId,
                    payer: in.senderAddress,
                    text: msg.text,
                    nameFee: book.nameFee,
                    renameFee: book.renameFee,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        NamingPaid => {
            // D-212. The fee, on its way to the floor. The sender is item(n) —
            // derived, as `name_number` derived it — or the registrar. Forwarded
            // whole as `royalty_to_ratchet`, the ledger's pure floor step: `T +=
            // amount`, `S` untouched (§5). It must NOT fall to the catch-all
            // below, which would pay half of it to the operator as a royalty.
            var storage = lazy Storage.load();
            val aux = storage.aux.load();
            if (in.senderAddress != aux.registrarAddr) {
                val initData = buildItemInitData(msg.n, contract.getAddress(), storage.ledgerAddr);
                val itemAddr = (AutoDeployAddress {
                    workchain: 0,
                    stateInit: ContractState { code: storage.itemCode, data: initData },
                }).calculateAddress();
                assert (in.senderAddress == itemAddr) throw 100;            // wrong_sender
            }
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: storage.ledgerAddr,
                body: (RoyaltyToRatchet { queryId: msg.queryId, amount: msg.amount }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
            var book = storage.naming.load();
            if (msg.count == 1) { book.named += 1; } else { book.renamed += 1; }
            book.toFloor += msg.amount;
            storage.naming = book.toCell();
            storage.save();
        }

        GetRoyaltyParams => {
            // TEP-66 response. Permissionless and read-only: it changes no
            // state, so it needs no sender check. Replies with the remaining
            // value so the caller pays for its own query.
            val storage = lazy Storage.load();
            val aux = storage.aux.load();
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: in.senderAddress,
                body: beginCell()
                    .storeUint(0xa8cb00ad, 32)
                    .storeUint(msg.queryId, 64)
                    .storeUint(aux.royaltyNum, 16)
                    .storeUint(aux.royaltyDen, 16)
                    // D-128: THIS CONTRACT, not `aux.royaltyDest` — the same
                    // change as `royalty_params()` below and for the same reason.
                    // Both surfaces must agree: which one a given venue reads is
                    // not ours to choose, and a split that only half the venues
                    // route through would be a §9.1 claim that is true on Tuesdays.
                    .storeAddress(contract.getAddress())
                    .endCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        MintItem => {
            var storage = lazy Storage.load();
            // One fixed-peer-contract sender, no owner/admin key (D17). D-20
            // deleted the market's own direct `MintItem` send — the ledger is
            // the only sender left; there is no second minting authority.
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender

            val initData = buildItemInitData(msg.n, contract.getAddress(), storage.ledgerAddr);
            createMessage({
                bounce: BounceMode.RichBounce,
                // CARRY, do not re-send from balance. This arm once sent `msg.mintValue`
                // under SEND_MODE_REGULAR, so the collection paid this transaction's gas
                // and the deploy's forward fee (the item's whole code cell rides in
                // `stateInit`) out of its own balance, with no income on any path: it
                // emptied at roughly 900 mints, and every later `MintItem` would bounce.
                //
                // V28: ALL of it — `mintValue` and the held split together. The item keeps
                // `mintValue` and returns the split to the ledger as `mint_confirmed`, so
                // the split is paid only once the item exists (D-117's "paid iff the item
                // exists", now true by construction rather than by `Populate` never
                // failing). This contract keeps nothing and confirms nothing.
                value: 0,
                dest: AutoDeployAddress {
                    workchain: 0,
                    stateInit: ContractState { code: storage.itemCode, data: initData },
                },
                body: (Populate { mint: beginCell().storeSlice(in.body).endCell() }).toCell(),
                // NO `IGNORE_ERRORS`: a deploy that cannot be sent fails this
                // transaction, and the `MintItem` bounces to the ledger's 0xc0000001
                // arm. A `Populate` the item refuses bounces HERE, and
                // `onBouncedMessage` relays it to the same lane.
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);

            // The ledger's head, verbatim. This is TEP-62's `next_item_index`:
            // the next mintable index.
            //
            // It previously stored the last-minted `n`, which was off by one
            // against its own name AND, after D-20, off by pi(n) against the real
            // head, because the head walks past every prime it crosses without
            // any `mint_item` being sent for it. Deriving it here is not possible;
            // taking it from the ledger is exact.
            if (msg.head > storage.nextIndex) {
                storage.nextIndex = msg.head as uint256;
            }
            storage.save();
        }

        else => {
            // ================================================================
            // D-128 — THE SECONDARY ROYALTY ARRIVES HERE, AND IS SPLIT HERE.
            //
            // Until D-128 this arm was `assert (in.body.isEmpty()) throw 101`,
            // which had two consequences and neither was intended. A marketplace
            // forwarding a royalty with a TEXT COMMENT had it BOUNCED BACK — a
            // live defect independent of the split, since a comment is the most
            // ordinary thing a venue attaches to a payout. And the royalty went
            // 100% to the operator, because `royalty_params()` handed out
            // `aux.royaltyDest` directly.
            //
            // Now `royalty_params()` publishes THIS CONTRACT'S OWN ADDRESS (see
            // the getter below), a marketplace pays here, and this arm splits:
            // `ROYALTY_RATCHET_BPS` to the ratchet as backing, the remainder to
            // `aux.royaltyDest` — which is unchanged, unrenamed, and now means
            // *the operator share's destination* rather than *the royalty's*.
            //
            // TEP-66 carries ONE destination, so a two-way split cannot be
            // declared on the wire; it has to happen at the address that is
            // declared. That is why the collection is that address.
            //
            // THIS ARM MUST NEVER THROW. Every refusal below is a `return`, and
            // the value simply stays on this contract's balance. An assert here
            // would bounce a marketplace's royalty back at it, which is the
            // defect the arm was written to end.
            // ================================================================
            var storage = lazy Storage.load();
            val aux = storage.aux.load();

            // Nowhere to send the ratchet half before the one-shot bootstrap has
            // named the ledger. Keep the money rather than refuse it: the floor
            // below means the next royalty after wiring sweeps it.
            if (storage.ledgerSet == 0) { return; }

            // THE FLOOR IS THE GENESIS ENDOWMENT, AND THAT IS WHY IT IS THIS
            // FIGURE. `genesisPipeline.ts` deploys this contract with 0.5 TON and
            // it has income on no other path, so the endowment is the whole of its
            // runway (see `MintItem`'s own comment above about emptying at ~900
            // mints under the pre-CARRY send). Reserving it means a royalty can
            // never eat the contract's rent, and it also means the DEPLOY itself —
            // an empty body carrying exactly 0.5 TON — forwards nothing, with no
            // special case for the genesis sender.
            //
            // Splitting the BALANCE above the floor rather than this message's own
            // value is what makes small royalties work: a payout too small to be
            // worth three hops accumulates instead of being burned on gas, and the
            // next one above the threshold sweeps the lot. Nothing can take it out
            // in the meantime — this contract has no withdraw path, and this arm's
            // only destinations are the ledger and `aux.royaltyDest`.
            reserveToncoinsOnBalance(ROYALTY_STORAGE_FLOOR, RESERVE_MODE_AT_MOST);
            val available: int = contract.getOriginalBalance() - ROYALTY_STORAGE_FLOOR;
            val net: int = available - ROYALTY_FORWARD_GAS;
            if (net <= 0) { return; }

            // D-114's arithmetic: ONE multiplication and ONE subtraction, so the
            // two legs sum to `net` exactly at every amount including dust, and
            // the truncated remainder falls to the RATCHET rather than to the
            // operator — §3.1's rule that an unresolvable share goes to the pool
            // and never to the team, applied to the one nanoton a division can
            // strand.
            val operatorShare: coins = net * (BPS_DEN - ROYALTY_RATCHET_BPS) / BPS_DEN;
            val ratchetShare: coins = net - operatorShare;
            // G81: the operator leg is a bare credit, and one worth less than the
            // basechain `flat_gas_price` lands `skipped (no_gas)`, aborted -- red
            // in an explorer though the value arrives. So below `ROYALTY_MIN_LEG`
            // NEITHER leg goes: the balance keeps both halves, as it keeps
            // everything under `ROYALTY_FORWARD_GAS`, and the next royalty sweeps
            // them. What waits is `balance - ROYALTY_STORAGE_FLOOR`, a chain read.
            if (operatorShare < ROYALTY_MIN_LEG) { return; }

            if (ratchetShare > 0) {
                createMessage({
                    // NoBounce on both legs: a bounce would return the money to a
                    // contract that has already zeroed nothing and would be split
                    // again on arrival. The ledger arm is permissionless within a
                    // two-address door and cannot refuse a well-formed message.
                    bounce: BounceMode.NoBounce,
                    // The hop budget rides ON TOP of the share so the ledger's own
                    // `assert (valueCoins >= amount + RATCHET_HOP_GAS)` holds after
                    // the forward fee is taken out of it — the ledger must receive
                    // the full `ratchetShare` plus its onward hop to the ratchet.
                    value: ratchetShare + ROYALTY_LEDGER_HOP_GAS,
                    dest: storage.ledgerAddr,
                    body: (RoyaltyToRatchet {
                        queryId: 0,
                        amount: ratchetShare,
                    }).toCell(),
                }).send(SEND_MODE_REGULAR);
            }
            if (operatorShare > 0) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: operatorShare,
                    dest: aux.royaltyDest,
                    body: beginCell().endCell(),
                }).send(SEND_MODE_REGULAR);
            }
            // W7: counted at SEND, and `forwards` counts the DELIVERY, not the
            // legs — one arrival above the threshold pays `ROYALTY_FORWARD_GAS`
            // once however many legs it ends up sending, so `forwards *
            // ROYALTY_FORWARD_GAS` is the skim a reader recomputes. This is the
            // only write on this arm, and it happens after `net > 0` has already
            // returned on every path that forwards nothing.
            var meters = storage.royalty.load();
            meters.toRatchet += ratchetShare;
            meters.toOperator += operatorShare;
            meters.forwards += 1;
            storage.royalty = meters.toCell();
            storage.save();
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // V28: the item refused `Populate`. Nothing was paid — the held split rode in
    // the deploy and is in this bounce — so the original `MintItem` and every
    // nanoton that came back go to the ledger, which parks them for `retry_item`.
    // This contract holds no mint TON afterwards. `Populate` and D-212's
    // `item_name` are the only bounceable messages it sends.
    val storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var original = rich.originalBody.beginParse();
    val op = original.loadUint(32);
    if (op == 0xc1000008) {
        // D-212: `item_name` to an `n` with no item. Everything that came back is
        // the payer's; it goes home, so no naming fee ever rests on this contract
        // for the royalty arm to split.
        original.skipBits(64);
        val payer = original.loadAddress();
        createMessage({
            bounce: BounceMode.NoBounce,
            value: 0,
            dest: payer,
            body: beginCell().endCell(),
        }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }
    if (op != 0xc0000002) { return; }
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: storage.ledgerAddr,
        body: (MintItemRefused { mint: original.loadRef() }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// D-212 (§4.7.1, §9.1): (nameFee, renameFee, named, renamed, toFloor). The two
// fees are deploy data; the next naming of an item costs `nameFee` when its
// `getAnnotation()` count is 0 and `renameFee` after.
get fun getNaming(): (int, int, int, int, int) {
    val storage = lazy Storage.load();
    val b = storage.naming.load();
    return (b.nameFee, b.renameFee, b.named, b.renamed, b.toFloor);
}

get fun getCollectionData(): (int, address) {
    val storage = lazy Storage.load();
    return (storage.nextIndex, storage.ledgerAddr);
}

get fun getItemAddress(n: int): slice {
    val storage = lazy Storage.load();
    val initData = buildItemInitData(n, contract.getAddress(), storage.ledgerAddr);
    val addr = (AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState { code: storage.itemCode, data: initData },
    }).calculateAddress();
    return beginCell().storeAddress(addr).endCell().beginParse();
}

// ============================================================================
// TEP-62 / TEP-66 standard surface
//
// Method IDs are derived from the exact method-name string, so `getCollectionData`
// above is invisible to every wallet, indexer and marketplace on TON — they call
// `get_collection_data` and nothing else. The camelCase getters stay (the ledger,
// read-proxy and webapp resolve them by name); these are added alongside.
//
// This is load-bearing for CONCEPT §3.1's secondary royalty rather than cosmetic:
// a royalty honored by marketplaces earns nothing if no marketplace can index the
// collection in the first place.
// ============================================================================

// (next_item_index, collection_content, owner_address).
//
// `owner_address` is the royalty destination — and it confers exactly nothing.
// There is no message in `AllowedMessage` that this contract accepts from it: no
// content edit, no royalty change, no mint, no withdraw. It is declared because
// marketplaces use the field to let a collection be claimed and presented, and
// declaring `addr_none` costs the project its collection page for no security
// gain that §8's actual guarantee — an empty admin surface, greppable in the
// message handler — does not already provide.
get fun get_collection_data(): (int, cell, slice) {
    val storage = lazy Storage.load();
    val aux = storage.aux.load();
    return (
        storage.nextIndex,
        aux.collectionContent,
        beginCell().storeAddress(aux.royaltyDest).endCell().beginParse()
    );
}

get fun get_nft_address_by_index(index: int): slice {
    return getItemAddress(index);
}

// GAUNTLET W7 — THE REALISED SPLIT, so no surface has to quote the nominal one.
// `(toRatchet, toOperator, forwards)`, all cumulative and counted at send.
//
// D-128 divides 50/50, but it divides the NET: the balance above the storage
// floor, less `ROYALTY_FORWARD_GAS` for the three-hop delivery. That skim is a
// large fraction of a small royalty — at §3.1's 5% rate it is 40% of the royalty
// on a 1 TON resale, 4% on a 10 TON one, negligible above — so what a holder
// actually experiences is not the nominal figure, and §9.1 forbids printing a
// number a reader cannot recompute. From these three they can: the realised
// split is `toRatchet / (toRatchet + toOperator)`, and the delivery has cost
// `forwards * ROYALTY_FORWARD_GAS` in total. **The money is not lost either
// way** — a payout too small to be worth three hops accumulates on this contract
// until a later one sweeps it, and this contract has no withdraw path.
get fun getRoyaltySplit(): (int, int, int) {
    val storage = lazy Storage.load();
    val m = storage.royalty.load();
    return (m.toRatchet, m.toOperator, m.forwards);
}


// D-128 — THE DESTINATION IS THIS CONTRACT, not `aux.royaltyDest`.
//
// TEP-66 carries ONE royalty destination, so a split between the operator and
// the ratchet cannot be declared on the wire; it has to happen at the address
// that IS declared. So a marketplace is pointed here, the catch-all arm in
// `onInternalMessage` splits what arrives, and `aux.royaltyDest` narrows to mean
// *the operator share's destination*. The field is neither removed nor renamed —
// it is still deploy-fixed with no message that can change it, and it is still
// where the operator's half lands.
//
// The numerator and denominator are unchanged: the royalty a venue charges is
// still 5%, and how it is divided afterwards is not a marketplace's business.
get fun royalty_params(): (int, int, slice) {
    val storage = lazy Storage.load();
    val aux = storage.aux.load();
    return (
        aux.royaltyNum,
        aux.royaltyDen,
        beginCell().storeAddress(contract.getAddress()).endCell().beginParse()
    );
}

// The offchain-URI common-prefix pattern: content = 0x01 tag, then the base URI,
// then a ref carrying this item's own suffix. Items store no per-number URI —
// there will eventually be millions of them — so the suffix is generated here
// from the index and `individual_content` from the item is ignored.
//
// The digit loop is O(d²) in the digit count (d ≤ 78 for a uint256). That is
// irrelevant: get-methods run off-chain, and this one is never called from the
// mint path.
get fun get_nft_content(index: int, individual_content: cell): cell {
    val storage = lazy Storage.load();
    val aux = storage.aux.load();

    var digits: int = 1;
    var tmp: int = index;
    while (tmp >= 10) { digits += 1; tmp /= 10; }

    var suffix = beginCell();
    var i = digits;
    while (i > 0) {
        var div: int = 1;
        var j = 1;
        while (j < i) { div *= 10; j += 1; }
        suffix = suffix.storeUint(48 + (index / div) % 10, 8);
        i -= 1;
    }
    // ".json"
    suffix = suffix.storeUint(0x2E6A736F6E, 40);

    return beginCell()
        .storeUint(1, 8)                                    // offchain content tag
        .storeSlice(aux.commonContentPrefix.beginParse())
        .storeRef(suffix.endCell())
        .endCell();
}
