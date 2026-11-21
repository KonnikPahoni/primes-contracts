tolk 1.4

// ============================================================================
// TON PRIMES — the LP SINK. LOCKED DEPTH, AND NOTHING ELSE.
// CONCEPT.md §3.4, §5, §6 point 3, §8; DECISIONS.md D-100 points 4 and 9
// (amends D-46 point 4). Opcodes: /shared/opcodes.ts `LP_SINK`. Wire format:
// /shared/schemas/lp_sink.tlb. Invariant TR-6.
//
// WHAT IT IS. DeDust PRIMES/TON LP receipts — the jettons the pair mints to a
// liquidity provider — are transferred to this contract's own LP jetton wallet
// and are never seen again. That is the entire contract. There is one inbound
// message that does work (`transfer_notification` from that one wallet), one
// one-shot bootstrap that names the wallet, and two counters. Liquidity that
// arrives here has left the market's supply of withdrawable depth permanently:
// nobody — not the depositor, not the operator, not a passed proposal, not this
// file's author — can pull it back out. D-100 point 4 calls the resulting
// balance LOCKED DEPTH and that is the name every surface must use for it.
//
// THE PROPERTY, AND WHY IT IS STRONGER THAN "NO WITHDRAW PATH". §8 forbids an
// admin withdraw path on any TON balance, and every other contract in this repo
// satisfies it by argument: you read its outbound sends and check that each
// destination is either the payer, a child, or a peer. That is a real audit and
// it takes real reading. This file makes the argument unnecessary:
//
//     THIS CONTRACT DECLARES NO OUTBOUND MESSAGE TYPE AT ALL.
//
// There is no `createMessage` below, no struct with an outbound comment on it,
// and — because the compiler emits `SENDRAWMSG` only where a send exists —
// nothing in the compiled code cell that could enqueue an action.
// `LpSink.spec.ts` asserts exactly that against the built bytecode, which is the
// cheapest possible proof of permanence: not "the withdraw path is guarded" but
// "there is no send to guard". Anything that ever moves LP out of here is a new
// deployment at a new address, visible as such, holding none of this one's
// balance.
//
// The corollary, stated rather than discovered: **TON sent to this address is
// also gone.** It is not a liability and nobody is owed it — the contract
// declares no TON liability, appears in no §3.4 reconciliation row, and has
// nothing to pay anyone with. Send it storage rent and nothing else.
//
// THE ONE-LINE AUDIT (TR-6). `getLocked()` is monotone non-decreasing — the only
// statement that writes it adds a non-negative amount — and it equals this
// contract's LP jetton wallet balance, because deposits are the only way that
// balance moves and the sender check makes them the only way this counter moves.
// One get-call against one wallet balance is the whole reconciliation. There is
// no `getSolvency` here for the same reason `primes_sink.tolk` has none: the
// declared TON liability is not zero-valued, it is ABSENT, and publishing a zero
// row would invite somebody to start summing it into the §3.4 aggregate.
//
// LOCKED DEPTH IS NEVER SUMMED INTO `T`. THIS IS A COPY CONSTRAINT, NOT A
// COMMENT (D-100 point 4). An LP receipt is a claim on a pool whose TON/PRIMES
// composition moves with every trade, so any figure derived from it is
// non-monotonic — it falls when the pool is bought through. `T` is the ratchet's
// TON side and §5's theorem is that `p_f = T/S` only ever rises; adding a term
// that can fall would void the proof outright, not weaken it. So:
//
//   * the FLOOR (`p_f = T/S`, monotone, a redemption ratio) and
//   * LIQUIDITY (locked forever here / committed ≥ 30 d in custody /
//     withdrawable in custody)
//
// are TWO guarantees on TWO panels, and no surface — UI copy, doc string, API
// field name or comment — may present locked depth as backing for the floor, as
// collateral, or as part of `T`. It is a market guarantee: this much of the pair
// can never be pulled. That is worth saying plainly and worth nothing at all to
// `p_f`.
//
// WHY A SINK AND NOT A TEP-74 `Burn` OF THE LP RECEIPT (D-100, "options not
// taken"). Burning the receipt would also make the liquidity unrecoverable, and
// it was the first idea. It was not taken because a burn is not READABLE: the LP
// jetton's total supply drops, and to turn that into "how much depth is locked
// forever" a reader needs a baseline somebody maintains off-chain and an
// argument that no other burner exists. A sink needs neither. The locked depth
// IS this account's wallet balance, at any block, with no bookkeeping and no
// trusted counter — and the same one-shot bootstrap that names the wallet is
// what makes that sentence checkable. Readability beat symbolism.
//
// LOCKING IS A ONE-WAY DOOR OUT OF THE ELECTORATE (D-100 points 4 and 9). LP
// forwarded here from `primes_treasury.tolk` custody stops being a position: it
// carries no vote weight, because the vote is computed over custody positions
// and this contract holds none (D-168 deleted the LP miner, so the vote is all a
// position ever bought). A depositor who locks forever is choosing the strongest
// possible statement about the pair over their say in the treasury. Nothing here
// enforces or advertises that trade — it is a consequence of there being no
// position — but a surface offering the button must say it.
//
// WHAT IT IS NOT. It is not the burn sink (`primes_sink.tolk`, §5.2), which
// destroys PRIMES to buy rights and holds a PRIMES wallet whose balance at rest
// is zero. It is not the stake master (`primes_stake.tolk`, §5.3), which
// CUSTODIES PRIMES and owes them back. This one holds a third token — a DeDust
// LP receipt, minted by a contract this repo does not control — accepts it from
// exactly one wallet, and owes nobody anything. `S` (§3.3) and the five-way split
// (§4.1) are untouched by every line below; there is no opcode here the ledger,
// the ratchet or the splitter recognises, and none of them knows this address.
// ============================================================================

// ---------------------------------------------------------------------------
// Storage
//
// Five fields in the root cell (~700 bits, no ref): there is no dictionary here
// and there will not be one. Who deposited is NOT recorded, deliberately — a
// per-depositor tally would be a claim ledger for a claim that can never be
// made, and it would grow against config 43's 65,536-cell account ceiling
// (CLAUDE.md "Measured provenance") for no reader's benefit. The depositor is
// on chain in the transfer that brought the tokens; the indexer reads it there.
// ---------------------------------------------------------------------------

struct Storage {
    // TR-6. Cumulative LP received, in the LP jetton's own units. Written by
    // exactly one statement, which adds a non-negative amount — that is the
    // monotonicity, and it is meant to be greppable rather than argued.
    locked: coins
    // How many deposits made it up. §9.1: the liquidity panel's "N locks"
    // figure maps here and nowhere else.
    events: uint32
    // This contract's OWN DeDust LP jetton wallet. Circular-address bootstrap,
    // the D21 family exactly as `primes_sink.tolk`, `primes_stake.tolk`,
    // `primes_vesting.tolk` and the ratchet do it: a TEP-74 wallet is addressed
    // by its owner, so the owner cannot embed it in its own address-determining
    // init data. One-shot `set_wallet` from the genesis script.
    lpJettonWalletAddr: address
    walletSet: uint8
    // The only address this contract will accept a `set_wallet` from, fixed at
    // deploy. It is not an owner: it can name the wallet once, before any
    // deposit is countable, and after that it has no privilege here at all —
    // there is no message it can send that does anything.
    genesisScriptAddr: address
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// ---------------------------------------------------------------------------
// Messages — INBOUND ONLY. The absence of an outbound struct in this section is
// the contract's whole safety argument; do not add one.
// ---------------------------------------------------------------------------

// One-shot, genesis script only: this contract's own LP jetton wallet.
struct (0x97000001) SetWallet {
    queryId: uint64
    lpJettonWalletAddr: address
}

// From that wallet, and only from it: LP arriving, forever.
//
// `forwardPayload` IS DECLARED AS A REMAINDER AND IS NEVER READ, and the
// difference from `primes_sink.tolk`'s `forwardPayload: cell` is not cosmetic.
// That sink is notified by OUR OWN jetton wallet (`primes_jetton_wallet.tolk`),
// which always writes the payload as a ref, so it can name the type exactly.
// This one is notified by a DEDUST-ISSUED wallet carrying a payload a stranger
// composed, and TEP-74 encodes `forward_payload` as `(Either Cell ^Cell)` — a
// short payload rides INLINE. Declaring it as a `cell` would make a deposit with
// an inline payload fail to parse and throw, which for a contract whose only job
// is to accept LP would be a self-inflicted denial of service. So the tail is
// consumed as an opaque remainder and no branch reads it: this contract has
// exactly one thing it can do with a deposit, so there is nothing for a payload
// to select.
struct (0x7362d09c) TransferNotification {
    queryId: uint64
    amount: coins
    sender: address
    forwardPayload: RemainingBitsAndRefs
}

type AllowedMessage = SetWallet | TransferNotification;

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetWallet => {
            assert (in.senderAddress == storage.genesisScriptAddr) throw 100; // wrong_sender
            assert (storage.walletSet == 0) throw 104;                        // already_processed
            storage.lpJettonWalletAddr = msg.lpJettonWalletAddr;
            storage.walletSet = 1;
            storage.save();
        }

        TransferNotification => {
            // THE SENDER CHECK IS WHAT MAKES `getLocked()` EQUAL THE WALLET
            // BALANCE, and it is the only reason it is here. Nothing is at risk
            // without it — a forged notification cannot extract anything from a
            // contract that cannot send — but the number would stop being an
            // audit: any address could inflate a figure a public panel presents
            // as locked depth. Same reasoning as the ratchet's `BurnStats`
            // bootstrap (`primes_ratchet.tolk`), where behaviour is likewise
            // indifferent to a forgery and only the TALLY discriminates.
            assert (storage.walletSet == 1) throw 1170;                        // lp_sink_wallet_unset
            assert (in.senderAddress == storage.lpJettonWalletAddr) throw 1171; // lp_sink_wrong_wallet

            // The whole contract. TR-6's monotonicity is this one `+=`, and
            // there is no matching `-=` anywhere in the file.
            storage.locked += msg.amount;
            storage.events += 1;
            storage.save();
            // No outbound message, no forwarded gas, no acknowledgement. The
            // remaining value stays as this account's TON balance and pays its
            // storage rent; there is no `responseAddr` hop to make because
            // there is nothing to report and no send to make it with.
        }

        else => {
            // A plain TON transfer with an empty body is allowed: it is how this
            // contract is deployed and how anyone tops up its storage rent, and
            // it can no more leave than the LP can. Anything else — an opcode
            // this file does not implement, or a bounce, which cannot happen
            // because nothing is ever sent — is refused rather than ignored, so
            // a client aimed at the wrong address learns it immediately.
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// There is deliberately no `onBouncedMessage`. A bounce is a reply to an
// outbound message and this contract sends none, so the handler would be
// unreachable by construction — and an unreachable handler in the one file whose
// claim is "nothing leaves" is exactly the sort of thing an auditor should have
// to ask about. Nothing to ask.

// ---------------------------------------------------------------------------
// Get-methods (§9.1 — every number the UI shows maps to one of these)
//
// The liquidity panel's "locked forever" segment reads `getLocked()`. It may not
// read it into any figure described as backing, collateral, or part of `T` — see
// the copy constraint in the header.
// ---------------------------------------------------------------------------

// TR-6: monotone non-decreasing, and equal to this contract's LP jetton wallet
// balance. The one-line audit of this file is that those two numbers match.
get fun getLocked(): int {
    val storage = lazy Storage.load();
    return storage.locked;
}

// How many separate locks make up `getLocked()`.
get fun getEvents(): int {
    val storage = lazy Storage.load();
    return storage.events;
}

// (lpJettonWalletAddr, walletSet, genesisScriptAddr) — the bootstrap, published
// so `getLocked()`'s claim is checkable: a reader needs to know WHICH wallet's
// balance to compare against, and whether the one-shot has fired at all.
get fun getLpSinkConfig(): (address, int, address) {
    val storage = lazy Storage.load();
    return (storage.lpJettonWalletAddr, storage.walletSet, storage.genesisScriptAddr);
}
