tolk 1.4

// ============================================================================
// TON PRIMES — the GOVERNED TREASURY. CONCEPT.md §5.5 (§2 point 4, §3.4, §8,
// §9.1); DECISIONS.md D-100, as amended by D-147, D-167 and D-168. Opcodes:
// /shared/opcodes.ts `TREASURY`. Wire format: /shared/schemas/treasury.tlb.
// Child: /contracts/contracts/primes_lp_position.tolk.
//
// WHAT THIS CONTRACT IS. The team's money, under holder control. It holds
// PRIMES (its 1,000,000-PRIMES vesting lock, D-100 point 6 / D-166), GRAM (58% of
// the unsold-prime forfeits, §4.1/§6 point 2) and, since D-151 / §4.3.2, tsTON —
// the realized yield on the ratchet's staked `pending`, sent here by `harvest()`.
// It is also the CUSTODY ADDRESS for LP that wants a vote: anyone deposits DeDust
// PRIMES/GRAM LP into one of FOUR lock terms (30 d / 3 m / 6 m / 1 y) and, while
// the term runs, that position is the electorate that governs this contract.
// LP CUSTODY EARNS NO PRIMES (D-168): the miner is deleted, and the treasury's
// PRIMES reach holders instead through `distribute()` to the stake master
// (§5.3), once per epoch, by rule.
//
// WHAT THIS CONTRACT IS NOT, AND THE DISTINCTION IS THE WHOLE OF §8. It holds no
// PROTOCOL GRAM. `pending` is the ratchet's, `owed` is the prime owners', and
// neither is here — the §3.4 decomposition puts each protected pool in its own
// account precisely so a contract that CAN spend can be told apart from one that
// cannot at a glance. Nothing in this file can move `T`, `S`, `pending`, `owed`,
// `k`, `K_CEIL` or the split, and nothing in it mints (TR-4).
// Its one reach outside itself is D-194's venue confirmation: half of a
// two-key change to the ratchet's flush venue, which moves nothing on its own.
//
// ---------------------------------------------------------------------------
// WHY TWO CONTRACTS
// ---------------------------------------------------------------------------
// Config 43 fixes `max_acc_state_cells = 65,536` per non-masterchain account —
// a CONSENSUS-ENFORCED ceiling on code plus data (CLAUDE.md "Measured
// provenance"). A positions dictionary living in this account dies around
// 20,000 positions, so GLOBAL state lives here (the proposal book, the
// balances, the electorate's size) and ONE CHILD PER WALLET holds that wallet's
// positions.
//
// THE CHILD'S ADDRESS IS THE WHOLE AUTHENTICATION. A child is deployed by this
// contract from `cfg.positionCode` with init data `(owner, treasuryAddr, empty,
// 0, 0, 0, clockDivisor)`, so its address is a hash of that code and that owner.
// When a `withdraw_lp`, `relock_vote`, `vote`, `propose` or `expire_vote`
// arrives carrying an `owner` field, this contract RE-DERIVES
// `positionAddress(owner)` and compares it to `in.senderAddress`. If they match,
// the sender is running this repo's position code on behalf of that owner and
// nothing else can be true. Ownership, the lock-term clock and the in-flight
// flag are the child's job and were done before the message was sent.
//
// ---------------------------------------------------------------------------
// THE TWO WAYS AN ASSET LEAVES (TR-2)
// ---------------------------------------------------------------------------
// 1. A PASSED PROPOSAL (`execute`, below) — GRAM, PRIMES or tsTON to a named
//    address, capped at `PROPOSAL_CAP_BPS` of that asset's balance at execute
//    time (TR-3).
// 2. `distribute()` (D-168, §5.5.3) — PRIMES to the stake master and nowhere
//    else, at most once per interval, amount = the formula and never more:
//
//      budget = primesBalance · rateBps · interval / (10000 · 86400)
//
//    BECAUSE THE BUDGET IS A FRACTION OF A BALANCE, THE TREASURY NEVER EMPTIES.
//    That is the property that earns this path its exemption from the vote: a
//    rule that can only ever pay out a fraction of what is left per epoch has no
//    terminal state a governance process would need to protect against. The
//    recipient is deploy data and no message can re-point it.
//
// Depositors' LP leaves only back to its depositor or into the LP sink, which is
// the child's business, not a spend (TR-5). There is no third path.
//
// THE LP MOVE (withdraw / sink-forward) is a round trip with a recovery arm. The
// child marks the position in flight and forwards; this contract sends the LP
// and a `confirm_withdraw` that deletes the position. If the LP transfer
// bounces, `onBouncedMessage` sends `restore_position` back — reconstructing the
// owner from the transfer's `responseAddr` (deliberately the OWNER on both the
// withdraw and the sink-forward, so the sink-forward's owner survives a bounce
// that names the sink as `destination`) and the position id and tier from the
// packed `queryId`. The position comes back MATURED and EXPIRED, and the owner
// retries.
//
// ---------------------------------------------------------------------------
// GOVERNANCE (D-100 points 8, 9, 10)
// ---------------------------------------------------------------------------
// TWO PROPOSAL KINDS. (1) Transfer {GRAM | PRIMES | tsTON} to an address. Plain
// transfers. LP IS NOT A PROPOSABLE ASSET (D-167): every LP token this contract
// holds is a depositor's. Capped at `PROPOSAL_CAP_BPS` of that asset's balance
// AT EXECUTE TIME, not at open time (TR-3). (2) D-194: VENUE CONFIRM
// (`ASSET_VENUE`) — `amount` is the venue timelock's queued-record `seq`, and a
// passed one sends `confirm_venue` to `dest`. It moves no value. The timelock's
// `execute` refuses an unconfirmed record, so the flush venue — the one address
// set that can steer `pending` — changes only with the proposer key AND this
// electorate. A vote nobody casts fails (`yes > no`). The timelock accepts only
// a vote that CLOSES at or after its record's `eta` (808, audit H1), i.e. one
// whose vote opens no earlier than `eta − voteDuration` — PROPOSED no earlier
// than `eta − notice − voteDuration`: since only weight locked before `opens`
// votes (1202), that is what gives every holder the whole 30-day notice to lock
// LP and vote no.
//
// NOTICE, THEN VOTE (D-173 as amended 2026-11-19, audit R2-H1). A proposal is
// PUBLIC for `NOTICE_DURATION` before its vote opens: `opens = proposed +
// notice`, `closes = opens + voteDuration`, and a vote before `opens` is refused
// (1206). Without the notice a vote opened the moment it was proposed, and 1202
// then meant NOBODY who was not already locked could oppose it — a dust locker
// on an empty electorate passed a 25% spend unopposably. With it, LP locked
// during the notice votes; locking during the VOTE WINDOW still does not
// (1202 is unchanged). Since the 2026-11-21 amendment only the NO side may lock
// reactively: a YES needs weight held since the proposal's own second
// (`weightSince <= opens − notice`, also 1202), so the proposer's whole yes is
// public when the notice starts and the defender moves last. A proposal nobody
// votes against still passes.
//
// VOTE: one day, simple majority of votes cast, NO QUORUM. Weight is
// `amount × voteMultiplier` for ONE named position WHOSE TERM IS STILL RUNNING —
// a pure function of (amount, tier, now), with no snapshot, no oracle and no
// `p_f` read (TR-7) — and only a position that has held that weight since
// BEFORE the vote opened votes on it (`weightSince < opens`, 1202). Every
// one of the four terms votes (D-168).
//
// WHO HAS VOTED IS NOT RECORDED HERE (D-188 point 7). A book of one row per
// (proposal, position) filled config 43's cell cap for ~650-900 GRAM of dust
// votes and froze governance. The voter's own child records the vote before it
// sends it and refuses a second (1155); this contract keeps only the totals and
// refuses a vote whose proposal closes after the child's record lapses (1203),
// so the child's record always covers the whole window it guards.
//
// EXECUTE IS PERMISSIONLESS after `closes` and until one more vote duration has
// passed (1204, D-188 point 7) — the vesting lock's `release` precedent. A
// BOUNCED execute resets `executed` and is re-executable inside that window.
//
// A PROPOSAL IS DELETED once nothing can happen to it: a failed one from its
// close, any other from the end of its execute window. `prune(seq)` is
// permissionless, and every `propose` also prunes the two oldest if they are due,
// so the book is O(proposals opened in the last notice + two vote durations).
//
// CONSEQUENCES ACCEPTED IN WRITING (D-100 point 10, CONCEPT §5.5.5): on day one
// the electorate is empty (D-166 removed the operator's position); with no quorum
// a single 30-day locker passes a proposal unless someone with more weight votes
// no, and the defences are the 25% per-asset cap, the notice plus the one-day
// vote window, and the 1% proposer threshold.
//
// ---------------------------------------------------------------------------
// THERE IS NO ADMIN INBOUND (D-100 point 7)
// ---------------------------------------------------------------------------
// No `update_config`. No owner field. No pause. No upgrade. No beneficiary
// change. The only one-shot message is `set_wallets`, the D21-family circular-
// address bootstrap, and it refuses a second call. A mistake in a deployed
// treasury is fixed by a fresh genesis, not by a message.
// ============================================================================

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------

// 0.1 GRAM: one jetton-wallet transfer hop plus the destination wallet's deploy.
const TRANSFER_GAS: coins = 100000000;
// 0.05 GRAM: one hop to a position child, including its deploy on a first
// deposit (the credit carries the child's code as state-init).
const CHILD_GAS: coins = 50000000;
// The single figure a caller must forward, sized for the most expensive outcome
// — a deposit that refunds (a transfer) or credits a child. A real sender adds a
// margin on top (CLAUDE.md); this is the nominal floor.
const TREASURY_MIN_FORWARD: coins = TRANSFER_GAS + CHILD_GAS;
// 0.05 GRAM riding `distribute()`'s transfer as `forward_ton_amount`, so the
// stake master's wallet raises the notification the budget is read from. It
// funds only the master's accrue-and-store — the master sends nothing back.
const DISTRIBUTE_FORWARD_TON: coins = 50000000;
// What a `distribute()` caller must attach: the transfer hop plus the forward.
// The caller funds it (it is permissionless), and the unspent excess returns to
// them as the transfer's `response_destination`.
const DISTRIBUTE_MIN_FORWARD: coins = TRANSFER_GAS + DISTRIBUTE_FORWARD_TON; // 0.15 GRAM
// 0.05 GRAM kept unspendable on this account so a GRAM proposal can never leave
// the treasury unable to pay its own storage rent.
const TON_RENT_FLOOR: coins = 50000000;

// ---------------------------------------------------------------------------
// Parameters — shared/params.json `treasury` and `staking` (DECISIONS.md D-100,
// D-168). NONE OF THESE IS A BARE LITERAL (CLAUDE.md rule 3): each names the key
// it mirrors, and `SimCrossCheck.spec.ts` catches drift. The distribution RATE is
// not here — it is DEPLOY DATA (`Distribution.rateBpsPerDay`, written from
// `staking.distribution_rate_bps_per_day` by the genesis script), fixed at deploy
// and unreachable by any message.
// ---------------------------------------------------------------------------

// FOUR RUNGS since D-168 (the no-lock / 1 d / 7 d rungs only ever mined).
const TIER_MAX: int = 3;

// `treasury.vote_multipliers` = [1, 3, 10, 30]. Live only while the position's
// term is running; the child enforces that against the position's own clock.
const VOTE_MULT_0: int = 1;
const VOTE_MULT_1: int = 3;
const VOTE_MULT_2: int = 10;
const VOTE_MULT_3: int = 30;
// D-214: `treasury.forever_vote_multiplier` — what LP locked forever through a
// position votes with. NOT a tier (no term, no deposit, no relock); MIRRORED in
// primes_lp_position.tolk, and SimCrossCheck binds both to params.json.
const VOTE_MULT_FOREVER: int = 100;

// `treasury.tier_term_seconds` = [2592000, 7776000, 15552000, 31536000]. LOCK
// TERMS measured from the deposit (D-147). Enforced on the CHILD; mirrored here
// so `getTierTerms()` publishes the ladder from one authority (§9.1).
const TIER_TERM_0: int = 2592000;
const TIER_TERM_1: int = 7776000;
const TIER_TERM_2: int = 15552000;
const TIER_TERM_3: int = 31536000;

// `staking.epoch_seconds` = 2592000 — `distribute()`'s interval, divided by the
// D-139 clock divisor like the ratchet's `harvest()` interval.
const DISTRIBUTE_INTERVAL: int = 2592000;
// `distribute()` refuses a budget below this BY NAME (1201) rather than sending a
// jetton transfer that moves nothing. One nano-PRIMES: it refuses the empty
// treasury and nothing else. Deliberately not a PRIMES-denominated "worth the
// gas" figure — that would be an economic parameter no sim has produced, and the
// caller already pays the gas.
const DISTRIBUTE_MIN_BUDGET: int = 1;

// `treasury.proposal_cap_bps` = 2500 — 25% of the named asset's balance at
// execute time (D-100 point 8).
const PROPOSAL_CAP_BPS: int = 2500;
// `treasury.propose_min_bps` = 100 — 1% of `eligibleWeight` to open a proposal.
const PROPOSE_MIN_BPS: int = 100;
// `treasury.vote_duration_seconds` = 86400 — one day (D-100 point 8).
const VOTE_DURATION: int = 86400;
// `treasury.notice_duration_seconds` = 86400 — how long a proposal is public
// before its vote opens (D-173 as amended 2026-11-19, audit R2-H1). OWNER-SET,
// and a SEPARATE parameter from the vote length: that the two are equal today is
// a coincidence of the chosen value, and nothing below may lean on it.
const NOTICE_DURATION: int = 86400;
const BPS_SCALE: int = 10000;
const SECONDS_PER_DAY: int = 86400;

// The three proposable assets, as they appear in `Proposal.asset`, and the
// venue-confirm kind (D-194) after them. LP is not one (D-167): the only LP here
// is the depositors'.
const ASSET_TON: int = 0;
const ASSET_PRIMES: int = 1;
// D-151 / §4.3.2. tsTON from the ratchet's `harvest()`, governed like any asset.
const ASSET_TSTON: int = 2;
// D-194. NOT AN ASSET: a venue-confirm proposal. `amount` carries the venue
// timelock's record `seq` and `dest` the timelock; a passed one sends
// `confirm_venue` and moves no value. The timelock's `execute` refuses without
// it, which is what makes a venue change need the LP electorate as well as the
// proposer key.
const ASSET_VENUE: int = 3;
// D-194: what an `execute` of a venue-confirm proposal must attach — the hop to
// the timelock and its confirm handler, carried on by mode 64, so the treasury's
// own GRAM pays nothing for it.
const VENUE_CONFIRM_GAS: coins = 30000000; // 0.03 GRAM

// The `forwardPayload` tag on an inbound LP transfer, followed by `tier:uint3`.
// The ONLY LP tag: D-167 deleted the donate tag with the treasury's own LP.
const TREASURY_ACTION_DEPOSIT: int = 0x54444550; // "TDEP"
// The tag `distribute()` writes into its transfer's forward payload, and the
// only thing the stake master accepts a budget under. Declared once in
// `shared/opcodes.ts` as `STAKE_ACTION_BUDGET`.
const STAKE_ACTION_BUDGET: int = 0x53424754;     // "SBGT"

// `queryId` purpose tags on outbound transfers, so `onBouncedMessage` can tell
// which arm bounced from the body alone. Packed as `(tag << 56) | …`; every
// component survives a rich bounce because `queryId` is field 1.
const QTAG_EXECUTE: int = 1;     // | seq
const QTAG_DISTRIBUTE: int = 2;  // | the PREVIOUS lastDistributeTime (40 bits)
const QTAG_LP_MOVE: int = 3;     // | (toSink << 40) | (tier << 32) | position id
const QTAG_REFUND: int = 4;

// ---------------------------------------------------------------------------
// Storage — four refs, one per kind of state
// ---------------------------------------------------------------------------

// `distribute()`'s whole state. 267 + 32 + 40 + 124 + 32 = 495 bits.
struct Distribution {
    // The stake master (§5.3) — the ONE address `distribute()` can pay. Deploy
    // data: the master's address does not depend on this contract's (the master
    // learns the treasury through its own one-shot `set_wallet`), so there is no
    // circular dependency to break on this side.
    stakeAddr: address
    // `staking.distribution_rate_bps_per_day` (19). Deploy data; see above.
    rateBpsPerDay: uint32
    // 0 until the first `distribute()`, which is therefore allowed at once —
    // the ratchet's `lastHarvestTime` precedent.
    lastDistributeTime: uint40
    distributedTotal: coins
    distributeEvents: uint32
}

struct Balances {
    // PRIMES this contract holds, TRACKED rather than read: a jetton balance
    // lives on the jetton wallet and TVM cannot read it synchronously.
    // `getTreasuryBalances` publishes it so a reader can reconcile it against
    // the wallet's own `get_wallet_data`.
    primesBalance: coins
    // D-151. tsTON harvested from the ratchet's staked `pending`, tracked the
    // same way.
    tstonBalance: coins
    // Σ `positions[].amount` across every child. TR-5's left-hand side, kept
    // here so the invariant is one get-call rather than a crawl over children.
    lpHeld: coins
    // Cumulative, for §9.1 and for the event decoder.
    primesIn: coins
    depositEvents: uint32
}

// One proposal. Sized to fit a single 1023-bit cell:
// 267 + 8 + 124 + 267 + 40 + 40 + 128 + 128 + 8 = 1010.
struct Proposal {
    proposer: address
    asset: uint8
    amount: coins
    dest: address
    opens: uint40
    closes: uint40
    yes: uint128
    no: uint128
    // Cleared again by `onBouncedMessage` when the send failed — that is what
    // makes a bounced execute retryable rather than a proposal lost forever.
    executed: uint8
}

struct Gov {
    proposalSeq: uint32
    // Σ `amount × voteMultiplier` over live positions. The denominator of the 1%
    // proposal threshold, and nothing else — there is NO quorum.
    //
    // AN UPPER BOUND (D-147). Nobody sends a message when a term matures, so a
    // matured position still counts here until someone sends `expire`. An
    // inflated denominator makes proposing HARDER, and the party it blocks is
    // the party with both the reason and the permission to fix it.
    eligibleWeight: uint128
    // BOUND (D-188 point 7): a row lives from `propose` until `prune` — at most
    // the notice plus two vote durations, and every `propose` prunes the two
    // oldest due rows — so the book holds the proposals of the last notice + two
    // vote durations. One proposer's slot is taken for notice + vote, so at most
    // TWO of one proposer's rows are ever live at once (the notice lengthens the
    // row and the slot alike), each opened on >= 1% of the electorate.
    proposals: map<uint32, Cell<Proposal>>
    // addrKey(proposer) -> the seq of their latest proposal (D-100 point 8).
    // BOUND: deleted with the proposal it names, so never larger than `proposals`.
    openBy: map<uint256, uint32>
}

struct TreasuryWallets {
    // This contract's OWN wallets. Circular-address bootstrap: a TEP-74 wallet
    // is addressed by its owner, so the treasury cannot embed either of its own
    // wallets in its own address-determining data. ALL THREE ARRIVE IN ONE
    // MESSAGE, so there is no half-bootstrapped state to reason about.
    lpJettonWallet: address
    primesJettonWallet: address
    walletsSet: uint8
    genesisScriptAddr: address
}

struct TreasuryConfig {
    // The operator's address. Read by nothing in this contract: recorded only
    // so `getTreasuryConfig` publishes it — NO message grants it any authority.
    operatorAddr: address
    // primes_lp_sink.tolk. The one destination a `to_sink` forward can name.
    sinkAddr: address
    // D-151. This contract's own tsTON wallet — here and not in
    // `TreasuryWallets` only because a fourth address overflows that cell.
    // Written ONLY by the one-shot `SetWallets`.
    tstonJettonWallet: address
    // D-139 — THE TEST CLOCK. 1 IS MAINNET AND THE IDENTITY. Divides the vote
    // window, the tier terms (mirrored from the child, which enforces them) and
    // `distribute()`'s interval. Deploy-time and unreachable by any message.
    clockDivisor: uint16
    // primes_lp_position.tolk's compiled code. Fixed at deploy.
    positionCode: cell
    w: Cell<TreasuryWallets>
}

struct Storage {
    dist: Cell<Distribution>
    bal: Cell<Balances>
    gov: Cell<Gov>
    cfg: Cell<TreasuryConfig>
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

fun addrKey(a: address): int {
    return beginCell().storeAddress(a).endCell().hash();
}

// D-188 point 7. Nothing can happen to a proposal any more: it failed (a tie
// fails) and its vote has closed, or its execute window has lapsed. Both arms
// are measured from `closes`, so a proposal in its notice or its vote is never
// prunable, whatever the notice length.
fun Proposal.prunable(self, now: int, window: int): bool {
    return now >= self.closes + window || (now >= self.closes && self.yes <= self.no);
}

// Delete a proposal, and its proposer's slot if the slot still names it — D13's
// rule: a later proposal the same proposer opened keeps its own throttle.
fun Gov.dropProposal(mutate self, seq: int, prop: Proposal) {
    self.proposals.delete(seq as uint32);
    val pk = addrKey(prop.proposer);
    val slot = self.openBy.get(pk);
    if (slot.isFound && slot.loadValue() == seq) {
        self.openBy.delete(pk);
    }
}

// Delete the oldest proposal if it is due. `propose` calls it twice, so the book
// cannot keep growing while nobody sends `prune`.
fun Gov.pruneOldest(mutate self, now: int, window: int) {
    val first = self.proposals.findFirst();
    if (first.isFound) {
        val prop = first.loadValue().load();
        if (prop.prunable(now, window)) {
            self.dropProposal(first.getKey(), prop);
        }
    }
}

// Four fixed steps (D-10's precedent: a ladder that can be edited is a
// governance lever). An out-of-range tier resolves to 0, unreachable because
// every entry point clamps the tier at parse time.
fun voteMultiplier(tier: int): int {
    if (tier == 0) { return VOTE_MULT_0; }
    if (tier == 1) { return VOTE_MULT_1; }
    if (tier == 2) { return VOTE_MULT_2; }
    if (tier == 3) { return VOTE_MULT_3; }
    return 0;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Inbound, one-shot, genesis script only. See `TreasuryWallets`.
struct (0x96000001) SetWallets {
    queryId: uint64
    lpJettonWallet: address
    primesJettonWallet: address
    // D-151. A THIRD-PARTY jetton's wallet (Tonstakers'), so an input to genesis.
    tstonJettonWallet: address
}

// Inbound, from one of this contract's own jetton wallets.
struct (0x7362d09c) TransferNotification {
    queryId: uint64
    amount: coins
    sender: address
    // TEP-74 `forward_payload:(Either Cell ^Cell)`, R20: parsed as a raw tail and
    // normalised at the read site, because a real TEP-74 wallet writes the
    // Either bit first.
    forwardPayload: RemainingBitsAndRefs
}

// Inbound, from the sender's OWN position child: a D-147 relock moved one
// position between tiers. `eligibleWeight` follows and nothing else moves —
// with the miner gone (D-168) a relock pays nothing and needs no reply.
struct (0x96000002) RelockVote {
    queryId: uint64
    owner: address
    positionId: uint32
    amount: coins
    tier: uint8
    newTier: uint8
    // 1 if an `expire` already took the OLD term's vote weight out, so it is not
    // taken out twice.
    expired: uint8
}

struct (0x96000003) WithdrawLp {
    queryId: uint64
    owner: address
    positionId: uint32
    amount: coins
    tier: uint8
    toSink: uint8
    // 1 if an `ExpireVote` already took this position's vote weight out of
    // `eligibleWeight`, so the exit does not decrement it a second time.
    expired: uint8
}

struct (0x96000004) Vote {
    queryId: uint64
    owner: address
    seq: uint32
    weight: uint128
    support: uint8
    positionId: uint32
    // Since when the position has held this weight unbroken (see the child).
    weightSince: uint40
    // D-188 point 7: when the child forgets this vote. Must not precede `closes`.
    recordUntil: uint40
}

struct (0x96000005) Propose {
    queryId: uint64
    owner: address
    weight: uint128
    asset: uint8
    amount: coins
    dest: address
}

// Inbound, PERMISSIONLESS — the vesting lock's `release` precedent.
struct (0x96000006) Execute {
    queryId: uint64
    seq: uint32
}

// D-147. Inbound, from the sender's OWN child, forwarded from the permissionless
// `expire`. `eligibleWeight` falls and nothing else moves.
struct (0x96000007) ExpireVote {
    queryId: uint64
    owner: address
    positionId: uint32
    amount: coins
    tier: uint8
}

// D-188 point 7. Inbound, PERMISSIONLESS: delete a proposal nothing can happen
// to any more (`Proposal.prunable`). Moves no asset.
struct (0x96000009) Prune {
    queryId: uint64
    seq: uint32
}

// D-168. Inbound, PERMISSIONLESS. No field names a destination or an amount —
// both are fixed (the stake master is deploy data, the budget is the formula),
// so who calls it cannot matter.
struct (0x96000008) Distribute {
    queryId: uint64
}

// Outbound, to the owner's child. Deploys it on a first deposit.
struct (0x96000010) LpCredit {
    queryId: uint64
    amount: coins
    tier: uint8
}

struct (0x96000012) ConfirmWithdraw {
    queryId: uint64
    positionId: uint32
}

// Outbound, BOUNCE RECOVERY ONLY. See the header's LP-move paragraph.
struct (0x96000013) RestorePosition {
    queryId: uint64
    positionId: uint32
    amount: coins
    tier: uint8
    // D-214: 1 for a bounced sink-forward — the child un-credits its forever total.
    fromSink: uint8
}

// Outbound, GRAM, on `execute` of an asset-0 proposal. It carries a body for one
// reason: the bounce handler needs the proposal sequence back.
struct (0x96000014) TonPayout {
    queryId: uint64
    seq: uint32
}

// Outbound, D-194, on `execute` of a venue-confirm proposal: to the venue
// timelock (primes_venue_timelock.tolk `ConfirmVenue`). `queryId` carries the
// proposal seq so a bounce can reset `executed`. `voteOpens` is the proposal's
// `opens`: the timelock refuses a vote that opened before its record was queued
// (807). `voteCloses` is its `closes`: the timelock refuses a vote that closed
// before its record's `eta` (808, audit H1) — the vote must open at the END of
// the notice, so the holders who locked during it are the ones who vote.
struct (0xa0000006) ConfirmVenue {
    queryId: uint64
    seq: uint32
    voteOpens: uint40
    voteCloses: uint40
}

// Outbound, to one of this contract's own jetton wallets — TEP-74 transfer.
struct (0x0f8a7ea5) JettonTransfer {
    queryId: uint64
    amount: coins
    destination: address
    responseAddr: address
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: cell?
}

// TEP-74's excess return, coming HOME. `Execute`'s jetton branch names this
// contract as the `responseAddr` of the payout (a proposal's excess belongs to
// the treasury that funded it), so the destination's wallet answers
// `excesses#d53276db` — non-bounceable. Without this arm the reply aborted and
// the TRACE read FAILED in an explorer while the money looked right: the class
// `CLAUDE.md` records for every contract that names itself as a
// `response_destination`.
struct (0xd53276db) Excesses {
    queryId: uint64
}

type AllowedMessage = SetWallets | TransferNotification | RelockVote | WithdrawLp
    | Vote | Propose | ExpireVote | Execute | Distribute | Prune | Excesses;

// ---------------------------------------------------------------------------
// The child address — the whole authentication (see the header)
//
// `PositionInit` must match primes_lp_position.tolk's `Storage` byte for byte in
// the empty state this function builds. `Treasury.spec.ts` asserts that
// `getPositionAddress(owner)` equals the wrapper's derivation, so a field
// reordered on either side fails the gate. `positions` is `cell?` here because
// an empty HashmapE and a null `cell?` both serialise to one zero bit.
// ---------------------------------------------------------------------------

struct PositionInit {
    owner: address
    treasuryAddr: address
    positions: cell?
    nextId: uint32
    positionCount: uint32
    voteWeight: uint120
    voted: cell?
    foreverAmount: coins
    foreverSince: uint40
    // D-139 — LAST, because this cell IS the child's address.
    clockDivisor: uint16
}

// `0` is read as `1` (D-139), so a config cell written without the field runs at
// mainnet speed rather than dividing by zero.
fun TreasuryConfig.clockDiv(self): int {
    return self.clockDivisor == 0 ? 1 : self.clockDivisor;
}
fun TreasuryConfig.voteDurationSec(self): int {
    return VOTE_DURATION / self.clockDiv();
}
fun TreasuryConfig.noticeDurationSec(self): int {
    return NOTICE_DURATION / self.clockDiv();
}
fun TreasuryConfig.distributeIntervalSec(self): int {
    return DISTRIBUTE_INTERVAL / self.clockDiv();
}

fun positionStateInit(cfg: TreasuryConfig, owner: address): AutoDeployAddress {
    return AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState {
            code: cfg.positionCode,
            data: (PositionInit {
                owner: owner,
                treasuryAddr: contract.getAddress(),
                positions: null,
                nextId: 0,
                positionCount: 0,
                voteWeight: 0,
                voted: null,
                foreverAmount: 0,
                foreverSince: 0,
                clockDivisor: cfg.clockDivisor,
            }).toCell(),
        },
    };
}

fun positionAddress(cfg: TreasuryConfig, owner: address): address {
    return positionStateInit(cfg, owner).calculateAddress();
}

// The budget `distribute()` would send right now. One expression, used by the
// handler and by `getDistribution`, so the published estimate and the enforced
// amount are the same arithmetic. `primesBalance < 2^120`, the rate is a uint32
// and the interval a timestamp difference, so the product stays under 2^200.
fun distributeBudget(primesBalance: int, rateBps: int, interval: int): int {
    return primesBalance * rateBps * interval / (BPS_SCALE * SECONDS_PER_DAY);
}

fun packQueryId(tag: int, tier: int, id: int): int {
    return (tag << 56) | ((tier & 0xff) << 32) | (id & 0xffffffff);
}

// ---------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------

fun sendJetton(walletAddr: address, queryId: int, amount: coins, to: address,
               responseTo: address, fwdTon: coins, gas: coins) {
    createMessage({
        // RichBounce: the bounce body is how a failed payout is recovered.
        bounce: BounceMode.RichBounce,
        value: gas,
        dest: walletAddr,
        body: (JettonTransfer {
            queryId: queryId,
            amount: amount,
            destination: to,
            // THE OWNER, not this contract, on every position move: a
            // sink-forward names the SINK as `destination`, so `responseAddr` is
            // the only field left that can carry the owner through a bounce.
            responseAddr: responseTo,
            customPayload: null,
            forwardTonAmount: fwdTon,
            forwardPayload: null,
        }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

fun sendToChild(cfg: TreasuryConfig, owner: address, body: cell, gas: coins) {
    // A plain address: every message on this path answers something the child
    // just sent, so the child provably exists.
    createMessage({
        bounce: BounceMode.NoBounce,
        value: gas,
        dest: positionAddress(cfg, owner),
        body: body,
    }).send(SEND_MODE_REGULAR);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetWallets => {
            var cfg = storage.cfg.load();
            var w = cfg.w.load();
            assert (in.senderAddress == w.genesisScriptAddr) throw 100; // wrong_sender
            assert (w.walletsSet == 0) throw 104;                       // already_processed
            w.lpJettonWallet = msg.lpJettonWallet;
            w.primesJettonWallet = msg.primesJettonWallet;
            cfg.tstonJettonWallet = msg.tstonJettonWallet;
            w.walletsSet = 1;
            cfg.w = w.toCell();
            storage.cfg = cfg.toCell();
            storage.save();
        }

        TransferNotification => {
            val cfg = storage.cfg.load();
            val w = cfg.w.load();
            // THE SENDER CHECK IS THE WHOLE AUTHENTICATION on this edge: this
            // contract RECORDS A LIABILITY when LP arrives, so a forged
            // notification would mint a position out of nothing.
            assert (w.walletsSet == 1) throw 1150; // treasury_wallets_unset
            var bal = storage.bal.load();

            if (in.senderAddress == w.primesJettonWallet) {
                // PRIMES IN — the vest (D-100 point 6, D-166) or a donation. No
                // payload is read: this contract has one thing it can do with
                // PRIMES, which is hold them for a proposal or `distribute()`.
                bal.primesBalance += msg.amount;
                bal.primesIn += msg.amount;
                storage.bal = bal.toCell();
                storage.save();
                return;
            }

            if (in.senderAddress == cfg.tstonJettonWallet) {
                // tsTON IN — D-151 / §4.3.2's `harvest()`, or a donation. No tag:
                // tsTON has exactly one meaning here, so there is nothing a tag
                // could select between.
                bal.tstonBalance += msg.amount;
                storage.bal = bal.toCell();
                storage.save();
                return;
            }

            assert (in.senderAddress == w.lpJettonWallet) throw 1151; // treasury_wrong_wallet
            // Refuse before recording or crediting anything we cannot pay to
            // finish — the burn sink's outcome 3, and for the same reason.
            assert (in.valueCoins >= TREASURY_MIN_FORWARD) throw 103; // insufficient_value

            var fwd = msg.forwardPayload;
            var p = fwd.remainingBitsCount() >= 1 && fwd.loadBool() ? fwd.loadRef().beginParse() : fwd;
            val action = p.remainingBitsCount() >= 32 ? p.loadUint(32) : 0;

            if (action == TREASURY_ACTION_DEPOSIT && p.remainingBitsCount() >= 3) {
                val tier = p.loadUint(3);
                if (tier <= TIER_MAX) {
                    bal.lpHeld += msg.amount;
                    bal.depositEvents += 1;
                    var gov = storage.gov.load();
                    gov.eligibleWeight = (gov.eligibleWeight
                        + msg.amount * voteMultiplier(tier)) as uint128;
                    storage.bal = bal.toCell();
                    storage.gov = gov.toCell();
                    storage.save();

                    createMessage({
                        // NoBounce: the child's `LpCredit` handler checks the
                        // sender and nothing else, and the deploy is funded by
                        // the depositor's own forwarded value.
                        bounce: BounceMode.NoBounce,
                        value: 0,
                        dest: positionStateInit(cfg, msg.sender),
                        body: (LpCredit {
                            queryId: msg.queryId,
                            amount: msg.amount,
                            tier: tier as uint8,
                        }).toCell(),
                    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
                    return;
                }
            }

            // AN UNRECOGNISED OR MALFORMED PAYLOAD REFUNDS, it is not silently
            // kept — the retired donate tag and an out-of-range tier included.
            // primes_sink.tolk's outcome 2: keeping a stranger's LP on a typo is
            // not a right this contract was granted.
            sendJetton(w.lpJettonWallet, packQueryId(QTAG_REFUND, 0, 0),
                       msg.amount, msg.sender, msg.sender, 0, TRANSFER_GAS);
        }

        RelockVote => {
            // D-147 / D-168. The child restarted a term under `newTier` and has
            // already applied the no-downgrade rule; this side moves the vote
            // weight between tiers in `eligibleWeight` and nothing else.
            val cfg = storage.cfg.load();
            assert (in.senderAddress == positionAddress(cfg, msg.owner)) throw 1152; // treasury_not_position
            assert (msg.newTier <= TIER_MAX) throw 102;                              // malformed_body
            var gov = storage.gov.load();
            val dropVote = msg.expired == 1 ? 0 : msg.amount * voteMultiplier(msg.tier);
            val addVote = msg.amount * voteMultiplier(msg.newTier);
            gov.eligibleWeight = (gov.eligibleWeight > dropVote
                ? gov.eligibleWeight - dropVote + addVote
                : addVote) as uint128;
            storage.gov = gov.toCell();
            storage.save();
        }

        WithdrawLp => {
            val cfg = storage.cfg.load();
            val w = cfg.w.load();
            assert (w.walletsSet == 1) throw 1150; // treasury_wallets_unset
            assert (in.senderAddress == positionAddress(cfg, msg.owner)) throw 1152; // treasury_not_position
            assert (in.valueCoins >= TRANSFER_GAS + CHILD_GAS) throw 103;           // insufficient_value

            var gov = storage.gov.load();
            // Zero if an `ExpireVote` already took it out; decrementing twice
            // would quietly shrink the proposal-threshold denominator.
            val dropVote = msg.expired == 1 ? 0 : msg.amount * voteMultiplier(msg.tier);
            // D-214: a sink-forward does not leave the electorate — its LP votes
            // on as the child's forever total, so its forever weight comes in as
            // the term's goes out. The bounce arm takes it back out.
            val addVote = msg.toSink == 1 ? msg.amount * VOTE_MULT_FOREVER : 0;
            gov.eligibleWeight = (gov.eligibleWeight > dropVote
                ? gov.eligibleWeight - dropVote + addVote : addVote) as uint128;
            var bal = storage.bal.load();
            bal.lpHeld = (bal.lpHeld > msg.amount ? bal.lpHeld - msg.amount : 0) as coins;
            storage.gov = gov.toCell();
            storage.bal = bal.toCell();
            storage.save();

            val dest = msg.toSink == 1 ? cfg.sinkAddr : msg.owner;
            // A sink-forward MUST forward GRAM with the transfer: the sink counts
            // locked depth from the notification its own wallet raises, and a
            // transfer with `forwardTonAmount = 0` raises none.
            val fwd: coins = (msg.toSink == 1 ? 20000000 : 0) as coins;
            sendJetton(w.lpJettonWallet,
                       packQueryId(QTAG_LP_MOVE, msg.tier, msg.positionId) | (msg.toSink << 40),
                       msg.amount, dest,
                       // The OWNER, always — see `sendJetton`.
                       msg.owner, fwd, TRANSFER_GAS);
            sendToChild(cfg, msg.owner, (ConfirmWithdraw {
                queryId: msg.queryId,
                positionId: msg.positionId,
            }).toCell(), CHILD_GAS);
        }

        ExpireVote => {
            // D-147. `eligibleWeight` is maintained by messages, so a term that
            // matured without one still counts. This is the message that
            // corrects it, permissionless all the way down: the child takes no
            // sender, and this side authenticates only that the child IS the
            // child. IT CHANGES NO RULE — a matured position cannot vote whether
            // or not this has run, because the child checks its own clock.
            val cfg = storage.cfg.load();
            assert (in.senderAddress == positionAddress(cfg, msg.owner)) throw 1152; // treasury_not_position
            var gov = storage.gov.load();
            val dropVote = msg.amount * voteMultiplier(msg.tier);
            gov.eligibleWeight = (gov.eligibleWeight > dropVote
                ? gov.eligibleWeight - dropVote : 0) as uint128;
            storage.gov = gov.toCell();
            storage.save();
        }

        Vote => {
            val cfg = storage.cfg.load();
            assert (in.senderAddress == positionAddress(cfg, msg.owner)) throw 1152; // treasury_not_position
            var gov = storage.gov.load();
            val look = gov.proposals.get(msg.seq);
            assert (look.isFound) throw 1153;                       // treasury_no_proposal
            var prop = look.loadValue().load();
            assert (blockchain.now() < prop.closes) throw 1154;     // treasury_vote_closed
            // D-173 as amended 2026-11-19 (audit R2-H1): the proposal is in its
            // NOTICE. The refusal bounces and the child forgets its record, so
            // the same position votes once `opens` arrives. It is also what
            // keeps 1203 sound: a vote at or after `opens` has `recordUntil =
            // now + voteDuration >= closes`, whatever the notice length.
            assert (blockchain.now() >= prop.opens) throw 1206;     // treasury_vote_not_open
            // CONCEPT §5.5.5: only weight held since BEFORE the VOTE opened
            // votes on it — LP locked during the notice does (NO only), LP locked or
            // upgraded during the vote window does not.
            assert (msg.weightSince < prop.opens) throw 1202;     // treasury_vote_locked_late
            // D-173 as amended 2026-11-21: a YES needs weight held since the
            // proposal's own second (`opens − notice`, no stored field needed —
            // the notice is a constant over the deploy's divisor). The proposer
            // can no longer top up during the notice after reading the defenders'
            // locks; a NO keeps the whole notice, so the defender moves last.
            if (msg.support == 1) {
                assert (msg.weightSince <= prop.opens - cfg.noticeDurationSec()) throw 1202;
            }
            // D-188 point 7: the child refused a second vote from this position
            // (1155) against its own record; this makes that record provably
            // outlive the vote. A proposal that opened after the child wrote it
            // closes too late, and the refusal bounces the record away.
            assert (prop.closes <= msg.recordUntil) throw 1203;   // treasury_vote_record_short
            // The child computes the weight because the positions are on the
            // child; this contract tallies. A zero-weight vote is refused by the
            // child (`position_no_vote_weight`) rather than tallied as a
            // no-op, so a proposal's `yes + no` is always a real weight — and
            // under D-147 that refusal is also what keeps a MATURED term out of
            // the tally, checked against the position's own clock rather than
            // against `eligibleWeight`, which may not have caught up yet.
            if (msg.support == 1) {
                prop.yes = (prop.yes + msg.weight) as uint128;
            } else {
                prop.no = (prop.no + msg.weight) as uint128;
            }
            gov.proposals.set(msg.seq, prop.toCell());
            storage.gov = gov.toCell();
            storage.save();
        }

        Propose => {
            val cfg = storage.cfg.load();
            assert (in.senderAddress == positionAddress(cfg, msg.owner)) throw 1152; // treasury_not_position
            assert (msg.asset <= ASSET_VENUE) throw 102;                             // malformed_body
            var gov = storage.gov.load();
            // ≥ 1% of the electorate, as a FRACTION and never as a token count
            // (D-100 point 8 / "options not taken"). Multiplied out rather than
            // divided, so a small electorate does not round the threshold to
            // zero.
            assert (msg.weight * BPS_SCALE >= gov.eligibleWeight * PROPOSE_MIN_BPS)
                throw 1156; // treasury_propose_below_threshold

            // D-188 point 7: the proposer pays to keep the book bounded.
            val window = cfg.voteDurationSec();
            gov.pruneOldest(blockchain.now(), window);
            gov.pruneOldest(blockchain.now(), window);

            val pk = addrKey(msg.owner);
            val open = gov.openBy.get(pk);
            if (open.isFound) {
                val openSeq = open.loadValue();
                val prior = gov.proposals.get(openSeq);
                // "One OPEN proposal per proposer" means one whose vote is still
                // running. A proposal whose day has passed is settled business
                // either way — executed, or failed and unexecutable — so it no
                // longer occupies the slot.
                if (prior.isFound) {
                    val p = prior.loadValue().load();
                    assert (blockchain.now() >= p.closes) throw 1157; // treasury_proposal_open
                }
            }

            val seq = gov.proposalSeq;
            // The vote opens only after the notice (audit R2-H1).
            val opens = blockchain.now() + cfg.noticeDurationSec();
            gov.proposals.set(seq, (Proposal {
                proposer: msg.owner,
                asset: msg.asset,
                amount: msg.amount,
                dest: msg.dest,
                opens: opens as uint40,
                closes: (opens + cfg.voteDurationSec()) as uint40,   // D-139
                yes: 0,
                no: 0,
                executed: 0,
            }).toCell());
            gov.openBy.set(pk, seq);
            gov.proposalSeq = (seq + 1) as uint32;
            storage.gov = gov.toCell();
            storage.save();
        }

        Execute => {
            val cfg = storage.cfg.load();
            val w = cfg.w.load();
            assert (w.walletsSet == 1) throw 1150; // treasury_wallets_unset
            // PERMISSIONLESS. No sender check, and none is possible to want: the
            // destination and the amount were fixed when the proposal opened, and
            // no field on this message names either. The vesting lock's
            // `release` makes the same argument.
            var gov = storage.gov.load();
            val look = gov.proposals.get(msg.seq);
            assert (look.isFound) throw 1153;                        // treasury_no_proposal
            var prop = look.loadValue().load();
            assert (blockchain.now() >= prop.closes) throw 1158;     // treasury_not_closed
            assert (prop.executed == 0) throw 1159;                  // treasury_already_executed
            // Simple majority of votes cast, no quorum (D-100 point 8). A TIE
            // FAILS: the incumbent state keeps the money, the same "strictly
            // greater" tiebreak primes_sink.tolk's ceremony lot uses.
            assert (prop.yes > prop.no) throw 1160;                  // treasury_vote_failed
            // D-188 point 7: executable for one more vote duration, then prunable.
            assert (blockchain.now() < prop.closes + cfg.voteDurationSec())
                throw 1204;                                          // treasury_execute_lapsed

            // D-194: a venue confirmation moves no value, so there is no cap to
            // check. The executor pays the hop; the timelock checks the seq.
            if (prop.asset == ASSET_VENUE) {
                assert (in.valueCoins >= VENUE_CONFIRM_GAS) throw 103;   // insufficient_value
                prop.executed = 1;
                gov.proposals.set(msg.seq, prop.toCell());
                storage.gov = gov.toCell();
                storage.save();
                createMessage({
                    bounce: BounceMode.RichBounce,
                    value: 0,
                    dest: prop.dest,
                    body: (ConfirmVenue {
                        queryId: packQueryId(QTAG_EXECUTE, ASSET_VENUE, msg.seq),
                        seq: prop.amount as uint32,
                        voteOpens: prop.opens,
                        voteCloses: prop.closes,
                    }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
                return;
            }

            // The EXECUTOR pays the payout's hop: the jetton branch sends
            // TRANSFER_GAS and the GRAM branch pays its forward fee separately,
            // both out of this balance. Without the floor a passed proposal whose
            // `dest` bounces (which resets `executed`) could be re-executed for
            // compute alone, the treasury paying the hop every time (audit Low).
            // The clients already attach this figure (`TREASURY_MIN_FORWARD_NANOTON`).
            assert (in.valueCoins >= TREASURY_MIN_FORWARD) throw 103;    // insufficient_value

            var bal = storage.bal.load();

            // TR-3: the cap is measured NOW, not when the proposal opened.
            var available: int = 0;
            if (prop.asset == ASSET_TON) {
                // The balance BEFORE this message's own value, less the rent
                // floor — so a caller cannot inflate the cap by over-funding the
                // execute, and the account can always pay its own storage.
                val bare = contract.getOriginalBalance() - in.valueCoins - TON_RENT_FLOOR;
                available = bare > 0 ? bare : 0;
            } else if (prop.asset == ASSET_PRIMES) {
                // The WHOLE PRIMES balance: nothing accrues inside the treasury
                // since D-168 (TR-1 is deleted with the miner), so nobody else
                // has a claim on any of it.
                available = bal.primesBalance;
            } else {
                available = bal.tstonBalance;
            }
            assert (prop.amount <= available) throw 1162;                   // treasury_insufficient_asset
            assert (prop.amount * BPS_SCALE <= available * PROPOSAL_CAP_BPS)
                throw 1161;                                                 // treasury_cap_exceeded

            prop.executed = 1;
            gov.proposals.set(msg.seq, prop.toCell());
            // The proposer's slot is left alone: `Propose` already treats a
            // closed proposal as settled, and `dropProposal` clears the slot at
            // prune time — only if it still names this proposal (D13).
            storage.gov = gov.toCell();

            if (prop.asset == ASSET_PRIMES) {
                bal.primesBalance -= prop.amount;
            } else if (prop.asset == ASSET_TSTON) {
                bal.tstonBalance -= prop.amount;
            }
            storage.bal = bal.toCell();
            storage.save();

            // The ASSET rides the queryId so a bounce can restore the balance
            // even if the proposal was pruned in between (D-188 point 7).
            val qid = packQueryId(QTAG_EXECUTE, prop.asset, msg.seq);
            if (prop.asset == ASSET_TON) {
                createMessage({
                    // RichBounce: the bounce body is how `executed` gets reset.
                    bounce: BounceMode.RichBounce,
                    value: prop.amount,
                    dest: prop.dest,
                    body: (TonPayout { queryId: qid, seq: msg.seq }).toCell(),
                    // PAY_FEES_SEPARATELY so the destination receives EXACTLY the
                    // amount the proposal named. Under the default mode the
                    // forward fee comes out of the transfer, and a proposal for
                    // 10 GRAM that delivers 9.99992 would make the get-method and
                    // the payment two different numbers (§9.1). The fee is paid
                    // from the executor's own forwarded value, which is the right
                    // party: they chose to push it.
                }).send(SEND_MODE_PAY_FEES_SEPARATELY);
            } else {
                val wallet = prop.asset == ASSET_PRIMES
                    ? w.primesJettonWallet : cfg.tstonJettonWallet;
                sendJetton(wallet, qid, prop.amount, prop.dest,
                           // The treasury, not the destination: a proposal's
                           // excess belongs to the treasury that funded it.
                           contract.getAddress(), 0, TRANSFER_GAS);
            }
        }


        Distribute => {
            // D-168 / §5.5.3 — TR-2's second exit. PERMISSIONLESS: the recipient
            // is deploy data and the amount is the formula, so who calls it
            // cannot matter. The caller funds the hop and gets the change back.
            val cfg = storage.cfg.load();
            val w = cfg.w.load();
            assert (w.walletsSet == 1) throw 1150;                        // treasury_wallets_unset
            assert (in.valueCoins >= DISTRIBUTE_MIN_FORWARD) throw 103;   // insufficient_value
            var dist = storage.dist.load();
            val interval = cfg.distributeIntervalSec();
            val now = blockchain.now();
            // AT MOST ONCE PER INTERVAL.
            assert (now - dist.lastDistributeTime >= interval) throw 1200; // treasury_distribute_early
            var bal = storage.bal.load();
            // AMOUNT = THE FORMULA, NEVER MORE.
            val budget = distributeBudget(bal.primesBalance, dist.rateBpsPerDay, interval);
            assert (budget >= DISTRIBUTE_MIN_BUDGET) throw 1201;           // treasury_distribute_dust

            val prevTime = dist.lastDistributeTime;
            bal.primesBalance -= budget;
            dist.lastDistributeTime = now as uint40;
            dist.distributedTotal += budget;
            dist.distributeEvents += 1;
            storage.bal = bal.toCell();
            storage.dist = dist.toCell();
            storage.save();

            createMessage({
                // RichBounce: a bounce restores `primesBalance` AND the previous
                // `lastDistributeTime`, so a failed send is retryable at once.
                bounce: BounceMode.RichBounce,
                value: 0,
                dest: w.primesJettonWallet,
                body: (JettonTransfer {
                    queryId: (QTAG_DISTRIBUTE << 56) | prevTime,
                    amount: budget as coins,
                    destination: dist.stakeAddr,
                    // The caller funded the hop, so the excess is theirs — and
                    // this contract is not named, so no `excesses` comes home.
                    responseAddr: in.senderAddress,
                    customPayload: null,
                    // > 0, or the master's wallet raises no notification and the
                    // budget arrives as an untracked surplus instead of a stream.
                    forwardTonAmount: DISTRIBUTE_FORWARD_TON,
                    forwardPayload: beginCell().storeUint(STAKE_ACTION_BUDGET, 32).endCell(),
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        Prune => {
            // D-188 point 7. PERMISSIONLESS, and nothing to authorise: it deletes
            // only a row nothing can happen to any more, and moves no asset.
            val cfg = storage.cfg.load();
            var gov = storage.gov.load();
            val look = gov.proposals.get(msg.seq);
            assert (look.isFound) throw 1153;                        // treasury_no_proposal
            val prop = look.loadValue().load();
            assert (prop.prunable(blockchain.now(), cfg.voteDurationSec()))
                throw 1205;                                          // treasury_not_prunable
            gov.dropProposal(msg.seq, prop);
            storage.gov = gov.toCell();
            storage.save();
        }

        Excesses => {
            // Accept and keep, exactly as the bounty vault and the jetton master
            // do. No sender gate: nothing moves, the value is already credited,
            // and the worst an impostor achieves is funding the treasury's gas.
        }

        else => {
            // PLAIN GRAM IN — the 58% forfeit share (§4.1, §6 point 2, D-100
            // point 6, D-166) and any other bare value transfer. It simply
            // accumulates; the balance IS the counter.
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// ---------------------------------------------------------------------------
// Bounces — one arm per outbound family; the `queryId` tag tells them apart
// ---------------------------------------------------------------------------

fun onBouncedMessage(in: InMessageBounced) {
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var s = rich.originalBody.beginParse();
    val opcode = s.loadUint(32);
    val qid = s.loadUint(64);
    val tag = qid >> 56;

    if (opcode == 0x96000014 || opcode == 0xa0000006) {
        // A GRAM PAYOUT BOUNCED, or (D-194) a venue confirmation the timelock
        // refused. The value came back with the bounce — reset
        // `executed` and the proposal is re-executable by anyone.
        var storage = lazy Storage.load();
        var gov = storage.gov.load();
        val seq = qid & 0xffffffff;
        val look = gov.proposals.get(seq as uint32);
        if (look.isFound) {
            var prop = look.loadValue().load();
            prop.executed = 0;
            gov.proposals.set(seq as uint32, prop.toCell());
            storage.gov = gov.toCell();
            storage.save();
        }
        return;
    }

    if (opcode != 0x0f8a7ea5) { return; }
    val original = lazy JettonTransfer.fromCell(rich.originalBody);
    var storage = lazy Storage.load();

    if (tag == QTAG_EXECUTE) {
        // A JETTON PAYOUT BOUNCED. The wallet restores its own balance on bounce,
        // so the tokens are still ours: put the book back and reset `executed`.
        // The asset is read off the queryId, so the balance comes back even if
        // the proposal was pruned in between (D-188 point 7).
        val asset = (qid >> 32) & 0xff;
        var bal = storage.bal.load();
        if (asset == ASSET_PRIMES) {
            bal.primesBalance += original.amount;
        } else if (asset == ASSET_TSTON) {
            bal.tstonBalance += original.amount;
        }
        storage.bal = bal.toCell();
        var gov = storage.gov.load();
        val seq = qid & 0xffffffff;
        val look = gov.proposals.get(seq as uint32);
        if (look.isFound) {
            var prop = look.loadValue().load();
            prop.executed = 0;
            gov.proposals.set(seq as uint32, prop.toCell());
            storage.gov = gov.toCell();
        }
        storage.save();
        return;
    }

    if (tag == QTAG_DISTRIBUTE) {
        // A BUDGET BOUNCED. The PRIMES never left our wallet: restore the
        // balance, the cumulative figures and the PREVIOUS `lastDistributeTime`
        // (packed into the queryId), so `distribute()` is retryable at once
        // rather than locked out for an interval it never paid.
        var bal = storage.bal.load();
        var dist = storage.dist.load();
        bal.primesBalance += original.amount;
        dist.distributedTotal -= original.amount;
        dist.distributeEvents -= 1;
        dist.lastDistributeTime = (qid & 0xffffffffff) as uint40;
        storage.bal = bal.toCell();
        storage.dist = dist.toCell();
        storage.save();
        return;
    }

    if (tag == QTAG_LP_MOVE) {
        // A WITHDRAWAL OR SINK-FORWARD BOUNCED. The LP is still in our wallet and
        // `ConfirmWithdraw` already deleted the position on the child, so put it
        // back and let the owner retry. The owner is `responseAddr` (see
        // `sendJetton`). Its vote weight left `eligibleWeight` on the way out and
        // is not restored, so the child restores it EXPIRED.
        var bal = storage.bal.load();
        bal.lpHeld += original.amount;
        storage.bal = bal.toCell();
        // D-214: a bounced SINK-forward credited forever weight on the way out;
        // the LP never reached the sink, so that weight leaves `eligibleWeight`
        // here and the child's forever total via `fromSink`.
        val fromSink = (qid >> 40) & 1;
        if (fromSink == 1) {
            var gov = storage.gov.load();
            val v = original.amount * VOTE_MULT_FOREVER;
            gov.eligibleWeight = (gov.eligibleWeight > v ? gov.eligibleWeight - v : 0) as uint128;
            storage.gov = gov.toCell();
        }
        storage.save();
        sendToChild(storage.cfg.load(), original.responseAddr, (RestorePosition {
            queryId: qid,
            positionId: (qid & 0xffffffff) as uint32,
            amount: original.amount,
            tier: ((qid >> 32) & 0xff) as uint8,
            fromSink: fromSink as uint8,
        }).toCell(), CHILD_GAS);
        return;
    }

    // QTAG_REFUND, and anything else: a refund that bounced leaves the LP in our
    // wallet with nothing recorded against it — the documented limitation every
    // refunding sink in this repo carries.
}

// ---------------------------------------------------------------------------
// Get-methods (§9.1 — every number the UI shows maps to one of these)
// ---------------------------------------------------------------------------

// D-168. (lastDistributeTime, interval, rateBps, nextBudgetEstimate,
//  distributedTotal, stakeAddr). `interval` is DIVIDED (what this deploy
// enforces), so the next `distribute()` is due at `lastDistributeTime +
// interval`. `nextBudgetEstimate` is the SAME function the handler runs, over
// today's balance — exact if nothing moves the balance before the call.
get fun getDistribution(): (int, int, int, int, int, address) {
    val storage = lazy Storage.load();
    val dist = storage.dist.load();
    val bal = storage.bal.load();
    val interval = storage.cfg.load().distributeIntervalSec();
    return (dist.lastDistributeTime, interval, dist.rateBpsPerDay,
            distributeBudget(bal.primesBalance, dist.rateBpsPerDay, interval),
            dist.distributedTotal, dist.stakeAddr);
}

// (tonBalance, primesBalance, lpHeld, primesIn, tstonBalance).
//
// `tonBalance` is this account's real balance less the rent floor — the figure a
// GRAM proposal's cap is measured against. `lpHeld` is the depositors' LP, all of
// the LP this contract holds, and never proposable (TR-5, D-167).
get fun getTreasuryBalances(): (int, int, int, int, int) {
    val storage = lazy Storage.load();
    val bal = storage.bal.load();
    val ton = contract.getOriginalBalance() - TON_RENT_FLOOR;
    return (ton > 0 ? ton : 0, bal.primesBalance, bal.lpHeld, bal.primesIn,
            bal.tstonBalance);
}

// (proposalSeq, eligibleWeight, proposalCapBps, proposeMinBps, voteDuration,
//  noticeDuration). `proposalSeq` is the NEXT id, so it doubles as the count of
// proposals ever opened.
get fun getGov(): (int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val gov = storage.gov.load();
    val cfg = storage.cfg.load();
    // D-139: fields 5 and 6 are the DIVIDED vote window and notice — what this
    // deploy enforces. A proposal was proposed at `opens − noticeDuration`.
    return (gov.proposalSeq, gov.eligibleWeight, PROPOSAL_CAP_BPS,
            PROPOSE_MIN_BPS, cfg.voteDurationSec(), cfg.noticeDurationSec());
}

// (proposer, asset, amount, dest, opens, closes, yes, no, executed). `opens` is
// when the VOTE opens — the end of the notice, not the moment it was proposed.
// A missing proposal — never opened, or pruned (D-188 point 7) — returns a zero
// row with `opens = 0`.
get fun getProposal(seq: int): (slice, int, int, slice, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val gov = storage.gov.load();
    val look = gov.proposals.get(seq as uint32);
    val empty = beginCell().storeUint(0, 2).endCell().beginParse();
    if (!look.isFound) {
        return (empty, 0, 0, empty, 0, 0, 0, 0, 0);
    }
    val p = look.loadValue().load();
    return (
        beginCell().storeAddress(p.proposer).endCell().beginParse(),
        p.asset, p.amount,
        beginCell().storeAddress(p.dest).endCell().beginParse(),
        p.opens, p.closes, p.yes, p.no, p.executed
    );
}

// Would `execute(seq)` succeed right now, and at what ceiling?
// (executable, reason, cap, available). `reason` is the error code the call
// WOULD throw, or 0 — so a UI can disable the button and say why without
// provoking the throw. Exact for every asset: nothing accrues inside the
// treasury since D-168, so no balance moves between this read and the call.
get fun getExecutable(seq: int): (int, int, int, int) {
    val storage = lazy Storage.load();
    val gov = storage.gov.load();
    val bal = storage.bal.load();
    val look = gov.proposals.get(seq as uint32);
    if (!look.isFound) { return (0, 1153, 0, 0); }
    val p = look.loadValue().load();
    var available: int = 0;
    if (p.asset == ASSET_VENUE) {
        // D-194: moves no value — only the vote and the window decide.
        if (blockchain.now() < p.closes) { return (0, 1158, 0, 0); }
        if (p.executed != 0) { return (0, 1159, 0, 0); }
        if (p.yes <= p.no) { return (0, 1160, 0, 0); }
        if (blockchain.now() >= p.closes + storage.cfg.load().voteDurationSec()) {
            return (0, 1204, 0, 0);
        }
        return (1, 0, 0, 0);
    }
    if (p.asset == ASSET_TON) {
        val bare = contract.getOriginalBalance() - TON_RENT_FLOOR;
        available = bare > 0 ? bare : 0;
    } else if (p.asset == ASSET_PRIMES) {
        available = bal.primesBalance;
    } else {
        available = bal.tstonBalance;
    }
    val cap = available * PROPOSAL_CAP_BPS / BPS_SCALE;
    if (blockchain.now() < p.closes) { return (0, 1158, cap, available); }
    if (p.executed != 0) { return (0, 1159, cap, available); }
    if (p.yes <= p.no) { return (0, 1160, cap, available); }
    if (blockchain.now() >= p.closes + storage.cfg.load().voteDurationSec()) {
        return (0, 1204, cap, available);
    }
    if (p.amount > available) { return (0, 1162, cap, available); }
    if (p.amount > cap) { return (0, 1161, cap, available); }
    return (1, 0, cap, available);
}

// Would the CLOCK accept a `vote` on `seq` right now? (votable, reason). `reason` is
// the code `vote` WOULD throw — 1153 no such proposal, 1206 still in its notice,
// 1154 closed — or 0. It exists because `opens` alone is not enough: the caller's
// clock is not the block's, and this compares against the block's (CLAUDE.md: every
// precondition a handler asserts has a get-method that answers it). The position's
// own refusals (1202 against `getPosition(id).weightSince`, 1155, 1169) are the
// child's to answer.
get fun getVotable(seq: int): (int, int) {
    val storage = lazy Storage.load();
    val look = storage.gov.load().proposals.get(seq as uint32);
    if (!look.isFound) { return (0, 1153); }
    val p = look.loadValue().load();
    if (blockchain.now() >= p.closes) { return (0, 1154); }
    if (blockchain.now() < p.opens) { return (0, 1206); }
    return (1, 0);
}

// Would `prune(seq)` succeed right now? 1 or 0 (a missing row is 0). Who has
// voted is not here since D-188 point 7: ask the voter's child, `getHasVoted`.
get fun getPrunable(seq: int): int {
    val storage = lazy Storage.load();
    val look = storage.gov.load().proposals.get(seq as uint32);
    if (!look.isFound) { return 0; }
    val window = storage.cfg.load().voteDurationSec();
    return look.loadValue().load().prunable(blockchain.now(), window) ? 1 : 0;
}

// (depositEvents, distributeEvents) — an indexer reconciles its decoded event
// stream against these (the burn sink's `getSinkCounts()` precedent).
get fun getTreasuryCounts(): (int, int) {
    val storage = lazy Storage.load();
    return (storage.bal.load().depositEvents, storage.dist.load().distributeEvents);
}

// The four VOTE multipliers, `treasury.vote_multipliers`. Live only while the
// position's term runs (D-147).
get fun getVoteMultipliers(): (int, int, int, int) {
    return (VOTE_MULT_0, VOTE_MULT_1, VOTE_MULT_2, VOTE_MULT_3);
}

// D-214. What LP locked forever through a position votes with,
// `treasury.forever_vote_multiplier`. Not a tier, so not in the ladder above.
get fun getForeverVoteMultiplier(): int {
    return VOTE_MULT_FOREVER;
}

// The four lock terms in seconds, `treasury.tier_term_seconds`, DIVIDED by the
// D-139 divisor exactly as the child divides the term it enforces.
get fun getTierTerms(): (int, int, int, int) {
    val storage = lazy Storage.load();
    val d = storage.cfg.load().clockDiv();
    return (TIER_TERM_0 / d, TIER_TERM_1 / d, TIER_TERM_2 / d, TIER_TERM_3 / d);
}

// The address of `owner`'s position child, whether or not it is deployed yet —
// the same derivation that authenticates every child message.
get fun getPositionAddress(owner: address): address {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    return positionAddress(cfg, owner);
}

// The permanent `forwardPayload` deposit tag.
get fun getTreasuryActions(): int {
    return TREASURY_ACTION_DEPOSIT;
}

// (treasuryMinForward, distributeMinForward) — the nominal GRAM a deposit/child
// message and a `distribute()` must carry. A real sender adds a margin.
get fun getTreasuryMinForward(): (int, int) {
    return (TREASURY_MIN_FORWARD, DISTRIBUTE_MIN_FORWARD);
}

// (lpJettonWallet, primesJettonWallet, operatorAddr, sinkAddr, walletsSet,
//  tstonJettonWallet). Published because the sender check is the WHOLE
// authentication on every jetton notification.
get fun getTreasuryConfig(): (address, address, address, address, int, address) {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    val w = cfg.w.load();
    return (w.lpJettonWallet, w.primesJettonWallet, cfg.operatorAddr,
            cfg.sinkAddr, w.walletsSet, cfg.tstonJettonWallet);
}
