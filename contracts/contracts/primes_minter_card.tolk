tolk 1.4
import "minter_standing"

// ============================================================================
// TON PRIMES — the MINTER CARD, one per (ledger, wallet). CONCEPT.md §4.5, §4.7,
// §4.7.1, §5.1; DECISIONS.md D-191 point 1 (GAUNTLET.md V26.4). Opcodes:
// /shared/opcodes.ts `MINTER_CARD` (and `LEDGER.mint`, which now lands here).
// Wire format: /shared/schemas/minter_card.tlb. Parent:
// /contracts/contracts/primes_ledger.tolk.
//
// WHY IT EXISTS. A wallet's rebate standing — prime rank, the §5.1 prime window,
// the §4.5 newcomer window, §4.7's recruit count and the era's recruit tally —
// used to be two dictionaries on the ledger, one row per wallet, for ever,
// toward config 43's 65,536-cell account cap (D-188's rule). Each wallet's
// standing lives here instead, so the ledger holds no per-wallet map at all.
//
// ITS ADDRESS IS ITS AUTHORITY, BOTH WAYS. The init data is `(ledger, owner,
// zero state)`, so the address is a hash of (this code, that ledger, this
// wallet). The ledger re-derives it to trust a `card_mint`/`card_recruit_counted`;
// this contract compares `ledgerAddr` to trust the ledger. `CardInit` in
// primes_ledger.tolk mirrors this `Storage` in its empty state, byte for byte,
// and `MinterCard.spec.ts` asserts the derivations agree.
//
// THE MINT. payer → THIS CARD (the beneficiary's: a gift is sent to the
// recipient's card) → ledger. The card is the one place a wallet's standing
// changes on a head mint, and it changes it BEFORE the ledger sees the mint:
//
//   1. attach the standing as it was (the ledger prices k off it, exactly as it
//      priced k off its own row before) and whether this card is FRESH;
//   2. spend one unit of each live window (every accepted head mint is a clocked
//      composite: a prime never mints at the head, D-20), and on a recruit edge
//      open the newcomer window — after the spend, so the gift mint neither
//      consumes a unit nor collects the uplift (§4.5);
//   3. forward carry-all to the ledger.
//
// SERIALIZED, NOT OVERWRITTEN. A card processes its messages one at a time, so
// two mints in flight for one wallet each see the other's spend: a window with
// one unit left uplifts exactly one of them. What comes back is a DELTA: a
// refused mint (`card_mint_refunded` for a lost race, a bounce for a throw)
// gives back the units it took, capped at the window's size, and un-opens a
// newcomer window it opened. A window a prime reset in between is therefore
// never pushed past PRIME_WINDOW, and nothing a concurrent accepted mint wrote is
// lost.
//
// FRESH IS THE §4.5 SYBIL GUARD. `seen` is false exactly until this card has
// been part of an accepted event — a mint for its owner, a prime bought for its
// owner, a recruit credited to its owner. A gift to a card that is not `seen`
// is a recruit edge; a second gift finds it seen, so gifting the same wallet
// twice counts once.
//
// A REFUSED FIRST MINT PUTS `seen` BACK ONLY IF NOTHING ELSE GOT THROUGH. The
// ledger reports a refusal and never an acceptance, so `inFlight` counts the
// mints sent since the card was last fresh; a refund takes one off, and the card
// is fresh again only when it reaches 0 — every one of them came back. An
// accepted mint never comes back, so the count never reaches 0 and the card stays
// seen. Resetting on the first mint's refund alone let a gift built to fail
// re-open the newcomer window after the owner had minted on it, for gas, as often
// as it was sent (MISTAKES.md 2026-09-29). An accepted recruit or prime (the two
// acceptances the ledger does report) confirms the card and zeroes the count.
//
// ONE RECRUIT EDGE IN FLIGHT, AND OTHER PAYERS WAIT FOR IT. A second gift sent
// while the edge gift is unresolved goes out NOT fresh, so if the edge then lost
// its race and the second gift was accepted, nobody was credited and the
// newcomer's window closed — a real recruit cancelled, by a lost race or by a
// gift built to fail. So for EDGE_HOLD after an edge is sent, a gift from ANY
// payer is refused (its GRAM bounces home); the edge's refusal clears the hold at
// once, so the next gift is the edge. Never held: the owner's own mints, which
// recruit no one. The edge's own payer is held too (re-audit): their failing
// gift plus an accepted one would still close the newcomer's window unpaid.
//
// This contract holds no GRAM beyond what passes through it and no PRIMES. It
// holds a RECORD.
// ============================================================================

// params.json mint.mint_price_ton — primes_ledger.tolk's MINT_PRICE, pinned to it
// by `SimCrossCheck.spec.ts`'s constant sweep.
const CARD_MIN_VALUE: coins = 1000000000; // 1 GRAM

// How long an unresolved recruit edge holds other payers' gifts off. The edge's
// answer (a refund or a bounce) is two hops away and clears the hold when it
// lands; an accepted edge is never reported, so the hold lapses on the clock.
// ponytail: a fixed bound; a ledger stalled longer than this re-opens the race.
const EDGE_HOLD: int = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Storage — THE FIELD ORDER IS PART OF THE ADDRESS (see the header)
// ---------------------------------------------------------------------------

struct Storage {
    ledgerAddr: address
    owner: address
    state: MinterState
    seen: bool
    // §4.7 / D-36: the era-scoped recruit tally. `eraSeq` is the ledger's
    // ceremony counter the tally was taken under; a recruit credited under a
    // later one starts the count again from zero. The running max stays on the
    // ledger.
    eraSeq: uint8
    eraRecruits: uint32
    // Mints sent since the card was last fresh and not yet refunded; 0 once an
    // accepted event is known. See the header.
    inFlight: uint32
    // When the unresolved recruit edge was sent; 0 when none is. See the header.
    edgeSentAt: uint32
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

// Inbound, from ANY wallet — the payer. Same body the ledger accepted before
// D-191, less `beneficiary`: the card IS the beneficiary's. The card reads only
// the opcode; the ledger parses and judges the rest.
struct (0xb0000002) Mint {
    queryId: uint64
}

// Outbound, to the ledger: the mint, with the standing it is priced off.
struct (0x9b000001) CardMint {
    owner: address
    payer: address
    state: MinterState
    fresh: bool
    mint: cell             // the payer's `mint` body, verbatim
}

// Inbound, from the ledger only: the ledger refunded a lost race; give the
// units back and pass the refund on to the payer.
struct (0x9b000005) CardMintRefunded {
    queryId: uint64
    payer: address
    state: MinterState
    fresh: bool
}

// Inbound, from the ledger only: a gift this wallet paid for recruited a fresh
// wallet. `eraSeq` is the ledger's ceremony counter at the gift.
struct (0x9b000002) CardAddRecruit {
    queryId: uint64
    eraSeq: uint8
}

// Outbound, to the ledger: the era tally after the credit, for its running max.
struct (0x9b000003) CardRecruitCounted {
    queryId: uint64
    owner: address
    eraSeq: uint8
    eraRecruits: uint32
}

// Inbound, from the ledger only: this wallet bought a prime (§5.1 / §4.7.1).
struct (0x9b000004) CardPrimeMinted {
    queryId: uint64
}

type AllowedMessage = Mint | CardMintRefunded | CardAddRecruit | CardPrimeMinted;

// The inverse of the pre-apply in the `Mint` arm, as a delta (see the header).
fun Storage.giveBack(mutate self, pre: MinterState, fresh: bool, payer: address) {
    if (pre.window > 0 && self.state.window < PRIME_WINDOW) {
        self.state.window += 1;
    }
    if (fresh && payer != self.owner) {
        // This refused mint opened the newcomer window: close it again, and let
        // the next gift be the edge.
        self.state.newcomerWindow = 0;
        self.state.newcomerOpened = false;
        self.edgeSentAt = 0;
    } else if (pre.newcomerWindow > 0 && self.state.newcomerOpened && self.state.newcomerWindow < NEWCOMER_WINDOW) {
        // `newcomerOpened`: a window a refused gift closed in between stays closed.
        self.state.newcomerWindow += 1;
    }
    if (self.inFlight > 0) {
        self.inFlight -= 1;
        if (self.inFlight == 0) {
            // Every mint since the card was fresh came back refused: it is fresh again.
            self.seen = false;
            self.state.newcomerWindow = 0;
            self.state.newcomerOpened = false;
        }
    }
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = Storage.load();

    match (msg) {
        Mint => {
            // A mint below the price never touches the standing. Without this a
            // dust "gift" too small to pay for its own bounce would spend a
            // stranger's window units, or open a fresh card's newcomer window
            // for nothing, and never come back to give them back.
            assert (in.valueCoins >= CARD_MIN_VALUE) throw 103; // insufficient_value
            // PERMISSIONLESS: anyone may mint, and anyone may gift. The sender is
            // not checked — it is recorded, as the payer.
            val payer = in.senderAddress;
            assert (payer == storage.owner || storage.edgeSentAt == 0
                    || blockchain.now() - storage.edgeSentAt >= EDGE_HOLD) throw 104; // already_processed: an edge in flight
            // AN UNRESOLVED EDGE IS NOT YET A NEWCOMER WINDOW. The gift opened it
            // below before the ledger judged the gift, and the ledger never reports
            // an accepted one. So while the edge is inside its hold (the assert
            // above means the payer here is the owner), the owner's own mint is
            // priced WITHOUT the window and spends none of it: a gift built to fail
            // otherwise lent a fresh wallet the uplift for up to five mints and then
            // refunded itself (2026-11-08 audit). An accepted edge's window is whole
            // once the hold lapses; a refused one closes it as before.
            val edgeOpen = storage.edgeSentAt != 0 && blockchain.now() - storage.edgeSentAt < EDGE_HOLD;
            var pre = storage.state;
            if (edgeOpen) { pre.newcomerWindow = 0; }
            val fresh = !storage.seen;
            if (storage.state.window > 0) { storage.state.window -= 1; }
            if (storage.state.newcomerWindow > 0 && !edgeOpen) { storage.state.newcomerWindow -= 1; }
            // §4.5 / D-106: THE RECRUIT EDGE. A gift (`payer != owner`) to a card
            // no accepted event has touched. Opened after the spend above.
            if (fresh && payer != storage.owner) {
                storage.state.newcomerWindow = NEWCOMER_WINDOW;
                storage.state.newcomerOpened = true;
                storage.edgeSentAt = blockchain.now() as uint32;
            }
            if (fresh) {
                storage.inFlight = 1;
            } else if (storage.inFlight > 0) {
                storage.inFlight += 1;
            }
            storage.seen = true;
            storage.save();
            createMessage({
                // A ledger refusal (a throw) bounces here and is given back below.
                bounce: BounceMode.RichBounce,
                value: 0,
                dest: storage.ledgerAddr,
                body: (CardMint {
                    owner: storage.owner,
                    payer: payer,
                    state: pre,
                    fresh: fresh,
                    mint: beginCell().storeSlice(in.body).endCell(),
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        CardMintRefunded => {
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            storage.giveBack(msg.state, msg.fresh, msg.payer);
            storage.save();
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: msg.payer,
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        CardAddRecruit => {
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            if (msg.eraSeq != storage.eraSeq) {
                storage.eraSeq = msg.eraSeq;
                storage.eraRecruits = 0;
            }
            storage.state.recruits += 1;
            storage.eraRecruits += 1;
            storage.seen = true;
            storage.inFlight = 0;
            storage.save();
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: storage.ledgerAddr,
                body: (CardRecruitCounted {
                    queryId: msg.queryId,
                    owner: storage.owner,
                    eraSeq: storage.eraSeq,
                    eraRecruits: storage.eraRecruits,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        CardPrimeMinted => {
            assert (in.senderAddress == storage.ledgerAddr) throw 100; // wrong_sender
            // §5.1: a second prime RESETS the window, never stacks it.
            storage.state.primesMinted += 1;
            storage.state.window = PRIME_WINDOW;
            storage.seen = true;
            storage.inFlight = 0;
            storage.save();
            // The hop's small value stays here as the card's storage reserve.
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// A `card_mint` the ledger threw on: give the units back, and the GRAM to the payer.
fun onBouncedMessage(in: InMessageBounced) {
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    val original = rich.originalBody.beginParse();
    if (original.preloadUint(32) != 0x9b000001) { return; }
    val m = CardMint.fromSlice(original);
    val payer = m.payer;
    var storage = Storage.load();
    storage.giveBack(m.state, m.fresh, payer);
    storage.save();
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: payer,
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
}

// ---------------------------------------------------------------------------
// Get-methods (§9.1). A card that was never deployed reads as zero state; the
// ledger's `getMinterCardAddress(wallet)` names where it lives.
// ---------------------------------------------------------------------------

// §4.7.1 / §9.1: (primes minted, ladder tier 0..5, the tier's k_max uplift,
// PRIME_UPLIFT window left). What moved here from the ledger's
// `getMinterState(owner)`, same four values.
get fun getMinterState(): (int, int, int, int) {
    val s = Storage.load().state;
    return (s.primesMinted, primeRankTier(s.primesMinted), primeRankUplift(s.primesMinted), s.window);
}

// §4.7: (lifetime recruits, tier, the tier's k_max uplift, next tier's count).
get fun getRecruitRank(): (int, int, int, int) {
    val s = Storage.load().state;
    val tier = recruitRankTier(s.recruits);
    return (s.recruits, tier, recruitRankUplift(s.recruits), recruitNextTierAt(tier));
}

// §4.5: (raised-ceiling mints left, NEWCOMER_WINDOW, NEWCOMER_UPLIFT, opened).
// G80: `opened` tells "spent all five" from "never gifted".
get fun getNewcomerWindow(): (int, int, int, bool) {
    val s = Storage.load().state;
    return (s.newcomerWindow, NEWCOMER_WINDOW, NEWCOMER_UPLIFT, s.newcomerOpened);
}

// §5 / §9.1: this wallet's uplift line, itemised — (primeRank, primeWindow,
// newcomer, recruitRank, summed). The ledger's `getKMaxFor(n, summed)` turns the
// sum into k_max at n and says whether K_CEIL clamps it.
get fun getUpliftLine(): (int, int, int, int, int) {
    val s = Storage.load().state;
    val pr = primeRankUplift(s.primesMinted);
    val pw = s.window > 0 ? PRIME_UPLIFT : 0;
    val nw = s.newcomerWindow > 0 ? NEWCOMER_UPLIFT : 0;
    val rr = recruitRankUplift(s.recruits);
    return (pr, pw, nw, rr, upliftSumFor(s));
}

// D-36: (eraSeq, eraRecruits) — the era tally and the ceremony counter it was
// taken under. It is THIS era's count only while `eraSeq` equals the third value
// of the ledger's `getEraLeader()`; otherwise this wallet recruited nobody yet
// this era. Distinct from `getRecruitRank`'s lifetime count.
get fun getEraRecruits(): (int, int) {
    val s = Storage.load();
    return (s.eraSeq, s.eraRecruits);
}

// All of the above in ONE call, for a reader that polls (the read-proxy's `/earn`
// and `/ranks` routes spend one upstream request here instead of five):
// (primesMinted, primeTier, primeUplift, window,
//  recruits, recruitTier, recruitUplift, nextTierAt,
//  newcomerLeft, NEWCOMER_WINDOW, NEWCOMER_UPLIFT, newcomerOpened,
//  primeWindowUplift, newcomerUplift, summed, eraSeq, eraRecruits).
get fun getStanding(): (int, int, int, int, int, int, int, int, int, int, int, bool, int, int, int, int, int) {
    val st = Storage.load();
    val s = st.state;
    val rt = recruitRankTier(s.recruits);
    return (
        s.primesMinted, primeRankTier(s.primesMinted), primeRankUplift(s.primesMinted), s.window,
        s.recruits, rt, recruitRankUplift(s.recruits), recruitNextTierAt(rt),
        s.newcomerWindow, NEWCOMER_WINDOW, NEWCOMER_UPLIFT, s.newcomerOpened,
        s.window > 0 ? PRIME_UPLIFT : 0, s.newcomerWindow > 0 ? NEWCOMER_UPLIFT : 0, upliftSumFor(s),
        st.eraSeq, st.eraRecruits,
    );
}

// (ledgerAddr, owner, seen) — the derivation is checkable by inspection.
get fun getCardOwner(): (address, address, bool) {
    val s = Storage.load();
    return (s.ledgerAddr, s.owner, s.seen);
}
