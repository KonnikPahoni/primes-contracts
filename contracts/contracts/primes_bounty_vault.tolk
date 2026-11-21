tolk 1.4

// ============================================================================
// TON PRIMES — Bounty vault. Phase 3, IMPLEMENTATION_PLAN.md §3 build step 5.
// Spec: CONCEPT.md §3.3 / §7, /shared/schemas/bounty_vault.tlb,
// /shared/opcodes.ts BOUNTY_VAULT, docs/engineering-spec.md §4.8 / §5 row 6 / §6.
// Params: /shared/params.json genesis.era_bounty_schedule.
//
// The vault HOLDS PRIMES (its own TEP-74 jetton wallet, minted at genesis and
// pre-counted into `S` per CONCEPT §5 so no future bounty can move the floor)
// and pays them out along exactly three routes:
//
//   pay_special_number_rebate — SPECIAL_NUMBERS_PLAN.md Phase 2, LIVE. Sender
//                        must be the ledger's fixed address. The KIND and the
//                        POINTS (never the TON value) are ledger-decided;
//                        `rebateSchedule` is
//                        genesis-fixed and `paidSpecials` makes a retry safe,
//                        same shape as `pay_era_bounty` below.
//   pay_era_bounty     — v1, LIVE. Sender must be the ledger's fixed address. The
//                        era boundary must be in the genesis-fixed schedule and
//                        not already paid (idempotent by `paidEras`, which makes
//                        engineering-spec §5 row 6's retry safe against a
//                        false-negative bounce). DENOMINATION_PLAN P4: the
//                        schedule is TON-denominated and the vault converts to
//                        PRIMES itself — see D22 below.
//   pay_program_bounty — LIVE. Sender must be present in the genesis-fixed
//                        allow-list under its own `programTag`; genesis lists
//                        the three vouchers (quests,
//                        security, prime quests), so every voucher claim pays
//                        through here.
//
// ADMIN SURFACE: none. There is no owner field. The allow-list is part of the
// deploy-time (address-determining) data and NO message type in this contract
// writes to it — adding a v1.1 program requires a fresh deploy, exactly as
// bounty_vault.tlb specifies. There is no withdraw path: PRIMES can leave this
// contract only through the bounty routes above, each of which pays a
// beneficiary named by a fixed peer contract — never an address this contract's
// deployer chooses after the fact. (The constellation discovery claim, D-193, was
// a fourth route until DECISIONS.md D-202 deleted it.)
//
// ---- Documented deviations (continuing docs/phase3-report.md's D1-D19) ----
// D20. bounty_vault.tlb says the vault "sends TEP74.mint for the scheduled
//     amount to `beneficiary`". It cannot: engineering-spec §4.4 and
//     primes_jetton_master.tolk make `mint` ledger-only and `mint_genesis`
//     genesis-script-only-pre-seal, and the seal is irreversible — a vault with
//     mint authority would be a second, standing, non-ledger minting credential,
//     directly contradicting CONCEPT §5's "every PRIMES token minted
//     post-genesis is a mint rebate, nothing else" and inflating `S` outside the
//     ratchet. Implemented instead as CONCEPT §3.3 actually describes it: the
//     vault is *pre-funded* at genesis with a real PRIMES balance and pays
//     bounties by TEP-74 `transfer` from its own jetton wallet. Same effect for
//     the recipient, no new minting authority, and the "pre-counted in S"
//     property becomes literally true rather than aspirational.
// D21. The vault's own jetton wallet address is bootstrapped by a one-shot
//     `SetWallet` (0x90000003, genesis script) rather than being fixed at
//     deploy: the wallet's address derives from the vault's address (TEP-74
//     wallets are addressed by owner), so the vault cannot embed it in its own
//     address-determining data. Same circular-address family as D7/D11/D12,
//     same one-shot resolution.
// D22. DENOMINATION_PLAN P4 — the era schedule is TON-denominated, not
//     PRIMES-denominated. A fixed nominal PRIMES bounty inflates with the floor
//     (`p_f` rises ~45x over year one at baseline demand), so an era ceremony
//     designed to be worth 2 TON at open would be worth ~90 TON at day 365. The
//     schedule therefore stores `(bountyTon, maxPrimes)` per boundary and the
//     vault pays `bountyTon * S / T` — the PRIMES that TON buys at the floor —
//     CAPPED by the genesis-fixed `maxPrimes`.
//
//     Three properties this shape is chosen to keep, and the reason for each:
//       * The vault's own arithmetic stays authoritative. It does not hold
//         `T`/`S`, but its ONLY authorized sender does, so the ledger passes its
//         post-mint snapshot in the message body rather than the vault trusting
//         an oracle or a keeper.
//       * The ledger cannot drain the vault by lying about `(T, S)`. `maxPrimes`
//         is genesis-fixed and address-determining; a hostile or buggy snapshot
//         can only make a payout SMALLER than the nominal cap, never larger, so
//         the vault's total lifetime commitment is still the sum of the caps
//         — exactly what it was before this change.
//       * `paidEras` idempotency is untouched: the era is still one-shot, and
//         the amount is still decided once, at the moment it pays.
//     Second-order and intended: because `S/T` FALLS as the floor rises, the
//     vault drains more slowly over time. Its life extends; its payouts do not
//     inflate.
//
// D23/D24 (the constellation discovery window and its accrued book) are DELETED
// by DECISIONS.md D-202; their PRIMES joined the `puzzles` track, which pays §9.6's score rebates.
// ============================================================================

const TRANSFER_GAS: coins = 100000000;  // 0.1 TON: wallet transfer hop + destination wallet deploy
// A permissionless retry pays the jetton hop plus this contract's own gas.
const RETRY_PAYOUT_VALUE: coins = 150000000;  // 0.15 TON
// H12/D-129. The balance this contract must still hold AFTER paying a hop, so a
// payout never leaves it unable to pay its own rent. Same figure as
// `primes_treasury.tolk`'s `TON_RENT_FLOOR` and for the same reason.
const STORAGE_FLOOR: coins = 50000000;  // 0.05 TON

struct AllowEntry {
    programTag: uint32
    remaining: coins
}

// One entry of the genesis-fixed era schedule (D22). Both halves are
// address-determining deploy data and nothing in this contract ever writes to
// them.
struct EraEntry {
    // The ceremony's VALUE, in nanoTON. This is the number the design fixes.
    bountyTon: coins
    // The nominal PRIMES that `bountyTon` buys at the GENESIS floor, and
    // therefore the largest payout this boundary can ever make. The floor only
    // rises (§5's ratchet theorem), so in normal operation this cap is never
    // reached — it exists so that a wrong `(T, S)` in the message body is
    // bounded, not trusted.
    maxPrimes: coins
}

// SPECIAL_NUMBERS_PLAN.md Phase 2's two new dictionaries, split into their
// own cell and hung off `VaultConfigB` below for the same "Storage can't
// exceed 4 refs" reason `VaultConfigB` is itself split from `VaultConfig`.
// D-99 §1.5 — EXACTLY TWO ENTRIES, and the words discount / free / bonus are
// gone from the contract with the tiers they named. The rebate is not rarity:
// rarity is the score, and the score is the price. Who gets PRIMES back is a
// separate question with a two-line answer.
//
//   0  REBATE_COMPOSITE_PER_POINT — a HEAD-MINTED composite, the 1 TON path.
//      `bountyTon` and `maxPrimes` are PER POINT of D(n); the vault multiplies
//      by the `points` the ledger reports. An auction-won composite gets
//      nothing: the premium is the price of impatience.
//   1  REBATE_PRIME_FAMILY — a prime of D-96's `dirichlet_primes` family
//      (p > 100,000, p ≡ 1 mod 101), by whatever route it minted. Flat, and
//      `points` is ignored.
const REBATE_COMPOSITE_PER_POINT: int = 0;

struct SpecialSchedule {
    // rebate kind -> (TON value, nominal PRIMES cap); genesis-fixed, mirrors
    // `schedule` above. Values trace to shared/params.json
    // `special_numbers.rebate` — the vault, not the ledger, is authoritative on
    // the TON amount, same D22 trust shape as the era schedule.
    // BOUND: two rows (the two rebate kinds, D-99 §1.5), written at deploy and
    // by no handler.
    rebateSchedule: map<uint8, EraEntry>
    // `n >> 8` -> a 256-bit word whose bit `n & 255` is `n`'s paid flag;
    // idempotent by `n` so a retried send after a false-negative bounce cannot
    // double-pay a special number's rebate, same as `paidEras`. A BITMAP, not
    // a row per `n`: nearly every head-minted composite is paid a rebate, and
    // a row each (with the journal row that used to stand beside it) filled
    // config 43's 65,536-cell account cap at n ≈ 18k.
    // BOUND: one 256-bit word per 256-number block holding a paid rebate,
    // ~2 cells a word, so ⌈head/256⌉ words and config 43's cap near n ≈ 8M.
    // ponytail: ~2 cells per 256 numbers still meets the cap near n ≈ 8M.
    paidSpecials: map<uint256, uint256>
}

// Split across two cells for the same 1023-bit reason as the ledger's and
// timelock's storage (4 addresses = 1068 bits inline). SPECIAL_NUMBERS_PLAN.md
// Phase 2's schedule cell rides along here rather than as a fourth top-level
// `Storage` ref, which would exceed the 4-ref-per-cell serialization limit.
// D-53/B12.1: what a bounced `JettonTransfer` cannot tell us on its own —
// which idempotency flag to roll back. `kind` distinguishes the two flag
// tables (0 = `paidEras`, keyed by `key` as an era boundary; 1 =
// `paidSpecials`, keyed by `key` as a special `n`) since they are different
// maps under different cells.
// A PAYOUT REPAIRED ONTO A BOOK, NOT A JOURNAL (GAUNTLET V26.1, D-188 point 3
// extended). A program payout (kind 3) has no paid flag to clear: a bounce is
// repaired by putting the PRIMES back on the program's allow-list `remaining`,
// after which the program simply sends again. It writes no journal row, before
// the send or after it. What the bounce arm needs rides in the transfer's
// queryId and the rich bounce's returned `JettonTransfer`: bit 63 marks the
// route, bit 62 is set, and the low 32 bits are the program's `programTag`.
// (Kind 2, the constellation discovery claim, was deleted by D-202.) Until V26.1
// program payouts journalled before the send and never deleted on success — a
// row per voucher claim, on a map with no bound. The queryId is protocol-built on
// every route; no caller's queryId reaches it (GAUNTLET V5).
const QID_BOOK: int = 0x8000000000000000;

// STORAGE CEILING. A pushed era bounty or special rebate is journalled ONLY if
// it cannot be delivered — deferred by the balance guard, or bounced — never on
// the happy path, where a row per rebate filled the account at n ≈ 18k and was
// never deleted. What makes that possible is this queryId: it carries the
// payout's kind and key, and a rich bounce hands the whole `JettonTransfer`
// back (queryId, amount, destination), so the bounce arm can write the row
// itself. Bit 62 marks it, with bit 63 (`QID_BOOK`) clear.
const PAYOUT_QID: int = 0x4000000000000000;
const PAYOUT_QID_KIND: int = 0x2000000000000000;   // set = kind 1 (special), clear = kind 0 (era)
const PAYOUT_QID_KEY_MAX: int = 0x2000000000000000; // key < 2^61

@inline
fun payoutQid(kind: int, key: int): int {
    return PAYOUT_QID | (kind == 1 ? PAYOUT_QID_KIND : 0) | key;
}

@inline
fun programQid(programTag: int): int {
    return QID_BOOK | PAYOUT_QID | programTag;
}

@inline
fun specialPaid(special: SpecialSchedule, n: int): bool {
    val w = special.paidSpecials.get(n >> 8);
    return w.isFound && ((w.loadValue() >> (n & 255)) & 1) == 1;
}

fun SpecialSchedule.setSpecialPaid(mutate self, n: int, paid: bool) {
    val w = self.paidSpecials.get(n >> 8);
    val word: int = w.isFound ? w.loadValue() : 0;
    val bit = 1 << (n & 255);
    val next = paid ? (word | bit) : (word & ~bit);
    if (next == 0) { self.paidSpecials.delete(n >> 8); }
    else { self.paidSpecials.set(n >> 8, next as uint256); }
}

// A deferred or bounced era/special payout: the one place a kind-0/1 row is
// written. Keyed by `journalKey` so `getDeferredPayouts()` still bounds a scan.
fun Storage.journalUnpaid(mutate self, mutate b: VaultConfigB, kind: int, key: int, to: address, amount: coins) {
    b.retryJournal.set(self.journalKey, RetryEntry { kind: kind, key: key, beneficiary: to, amount: amount });
    self.journalKey += 1;
    self.deferredCount += 1;
}

struct RetryEntry {
    // 0 = `paidEras`, 1 = `special.paidSpecials`. Program payouts are repaired
    // onto their book and never journalled (`QID_BOOK`).
    kind: uint1
    key: uint256
    beneficiary: address
    amount: coins
}

struct VaultConfigB {
    jettonWalletAddr: address
    walletSet: uint8
    genesisScriptAddr: address
    special: Cell<SpecialSchedule>
    // D-53/B12.1: hung off here rather than `Storage` directly — `Storage`
    // is already at its 4-ref cap (schedule, paidEras, allowlist, cfg).
    // BOUND: kinds 0/1 only — one row per era boundary or special `n` whose
    // payout was deferred or bounced and is not yet retried (`journalUnpaid`
    // writes it, `RetryBountyPayout` deletes it). A landed payout and a
    // program payout write none (D-188 point 3, V26.1), so the
    // rows are bounded by payouts that FAILED, never by players or claims:
    // at most the genesis-fixed era schedule (≤ 8 boundaries) plus one row per
    // special rebate the vault could not deliver. An EXHAUSTED vault writes
    // none (V26.7): `canCover` refuses a payout the declared `fundedPrimes -
    // paidTotal` cannot meet before anything is sent, so the wallet's
    // insufficient-balance bounce — one row per head-minted composite — is
    // never provoked. What remains is a transient failure (a TON-short vault,
    // or a wallet holding less than genesis declared), and each such row
    // stays until a PAID permissionless retry (0.15 TON) clears it.
    retryJournal: map<uint64, RetryEntry>
}

struct VaultConfig {
    ledgerAddr: address
    jettonMasterAddr: address
    b: Cell<VaultConfigB>
}

struct Storage {
    // era_boundary -> (TON value, nominal PRIMES cap); genesis-fixed, never written to
    // BOUND: the era schedule's eight rows (`genesis.era_bounty_schedule`).
    schedule: map<uint256, EraEntry>
    // era_boundary -> paid flag; the only mutable state here
    // BOUND: ≤ `schedule`'s eight rows — set only for a boundary `schedule`
    // holds (`PayEraBounty` cheap-fails on any other, the retry replays a
    // journalled one).
    paidEras: map<uint256, uint8>
    // allow-listed program contracts, keyed by address hash; genesis-fixed,
    // one entry per program, each under a distinct `programTag`.
    // BOUND: the genesis list (the vouchers, a handful); handlers
    // only rewrite `remaining` on a row they found.
    allowlist: map<uint256, AllowEntry>
    // V26.7 / D-188 point 3. The PRIMES genesis mints into this vault's wallet
    // (`genesis.bounty_vault_size_primes`), declared in address-determining
    // deploy data beside the schedule and written by nothing. Every PRIMES that
    // leaves is counted in `paidTotal` at send and un-counted on a bounce, and
    // nothing else ever sends from the wallet, so `fundedPrimes - paidTotal` is
    // a floor under the wallet's balance (a stray inbound transfer only adds).
    // It gates the two PUSHED routes and nothing else; the wallet's own
    // balance stays the §9.1 truth (`get_wallet_data`).
    fundedPrimes: coins
    // CONCEPT §3.3 / §11.21: the vault-payout half of the two-number
    // circulating-supply report. A bounty payout moves tokens into circulation
    // without touching `S`; a burn removes them without touching `S`. §11.21
    // asks for the two to be reported separately rather than netted, and §9.1
    // requires the number on screen to come from a get-method — so the vault
    // counts what it has actually sent instead of leaving the dashboard to sum
    // the era schedule and hope it matches.
    //
    // Counted at SEND, and — since D-53/B12.1 — ROLLED BACK on a genuine
    // bounce (see `onBouncedMessage` and `RetryBountyPayout` below), so the
    // two stay reconcilable against `getEraSchedule`/`getRebateSchedule`
    // whether a payout landed on the first try or the retry.
    paidTotal: coins
    payoutCount: uint32
    // H12/D-129. `payoutCount` used to be BOTH the public figure and the
    // journal key. It cannot be both any more: a payout deferred for
    // want of `TRANSFER_GAS` is journalled without being sent, so it must take
    // a key without moving the figure — otherwise §9.1's supply report would
    // count PRIMES that never left. So the key counter separates out here, and
    // it is the ONLY thing that mints journal keys (`journalUnpaid`: a
    // deferred or bounced era/special payout); `payoutCount` now counts sends
    // and nothing else.
    journalKey: uint64
    // How many journal rows are written but UNPAID, from either
    // route: deferred by the balance guard, or rolled back by a bounce.
    // Published by `getDeferredPayouts()` — a payment nobody can see waiting is
    // the same silence this item exists to end.
    deferredCount: uint32
    cfg: Cell<VaultConfig>
}

// V26.7. Can the vault's declared remainder still cover `amount`? A pushed
// era bounty or special rebate that cannot is REFUSED before anything is sent
// or written: no flag, no journal row, no bounce. A program payout that cannot
// THROWS instead, so the voucher's bounce arm restores the claim receipt. It is not deferred, because
// nothing refills the vault (genesis funds it once), so a retry could only
// bounce again. The payout is forfeit and reads unpaid (`getRebateSchedule` /
// `getEraSchedule` `paid = 0`), which is what happened.
@inline
fun Storage.canCover(self, amount: coins): bool {
    return self.paidTotal + amount <= self.fundedPrimes;
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

// 0xb0000031 is RETIRED (see shared/opcodes.ts): it is the pre-P4 body with no
// (T, S), and a stale sender must be rejected rather than mis-parsed.
struct (0xb0000032) PayEraBounty {
    queryId: uint64
    eraBoundary: uint256
    beneficiary: address
    // The ledger's POST-MINT ratchet state, so the vault prices the ceremony at
    // the same floor the mint that triggered it just established. Sent rather
    // than read because the vault has no way to call a get-method on the ledger,
    // and bounded rather than trusted because of `maxPrimes` (D22).
    t: coins
    s: coins
}

// outbound from the ledger only. SPECIAL_NUMBERS_PLAN.md Phase 2 — see
// primes_ledger.tolk's own comment on this struct for the trust shape.
struct (0xb0000072) PaySpecialNumberRebate {
    queryId: uint64
    n: uint256
    // REBATE_COMPOSITE_PER_POINT or REBATE_PRIME_FAMILY.
    kind: uint8
    // D(n), the score. Multiplies the schedule entry on the per-point kind and
    // is ignored on the flat one. Bounded by SCORE_MAX = 87 on the ledger's
    // side, and bounded again here by `maxPrimes · points` never exceeding what
    // the schedule allows — the same "bounded, not trusted" shape as `(t, s)`.
    points: uint16
    beneficiary: address
    t: coins
    s: coins
}

struct (0x90000002) PayProgramBounty {
    queryId: uint64
    programTag: uint32
    beneficiary: address
    amount: coins
}

// D21
struct (0x90000003) SetWallet {
    queryId: uint64
    jettonWalletAddr: address
}

// GAUNTLET V4: `customPayload`/`forwardPayload` are `cell?` (Maybe ^Cell), not
// plain `cell` — see `primes_jetton_wallet.tolk`'s own header for why. This
// contract always sends `null` for both (no custom payload, no forward
// content ever), and a `null` Maybe writes exactly one `0` bit with nothing
// after it — which is ALSO a valid, empty `Either Cell ^Cell` reading (bit 0 =
// inline, zero bits of inline content), so the wallet's Either-parsing logic
// reads it correctly without this contract needing the parse-only
// `RemainingBitsAndRefs` type on the sending side.
struct (0x0f8a7ea5) JettonTransfer {
    queryId: uint64
    amount: coins
    destination: address
    responseAddr: address
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: cell?
}

// D-53/B12.1: permissionless retry for a payout that genuinely bounced.
// Anyone may fire it — it only ever replays what `retryJournal` already
// recorded, at the amount already decided, to the beneficiary already named.
struct (0x90000004) RetryBountyPayout {
    queryId: uint64
}

// inbound, TEP-74's excess return — the other half of the H11 note below.
// `payOut` names this vault as `responseAddr` on every pushed route, so the
// recipient's jetton wallet answers each payout with `excesses#d53276db`, and
// until this arm existed that reply hit `else => assert (in.body.isEmpty())`
// and threw 101 every time.
//
// H11's arithmetic was never wrong: the wallet sends this NoBounce, so the
// remainder was credited in the credit phase and STAYED even though the
// compute phase aborted. What the throw cost was the trace — measured on
// testnet 2026-09-17, trace 8c354845…d724a, where a fully successful 1 TON
// mint reads FAILED in Tonviewer because this one leaf aborted. Accepting it
// is the whole fix; there is nothing to record.
struct (0xd53276db) Excesses {
    queryId: uint64
}

type AllowedMessage = PayEraBounty | PaySpecialNumberRebate | PayProgramBounty | SetWallet
                    | RetryBountyPayout | Excesses;

// H11. `respondTo` is TEP-74's excess return, and it must be WHOEVER PAID THE
// HOP. `TRANSFER_GAS` is drawn from this contract's own balance, so on every
// pushed route (era bounty, special rebate, program bounty, retry) that is the
// VAULT — the unspent remainder comes home. Naming the beneficiary there, as
// the first pass did, gifted them the change: the vault spent 0.1 TON, got
// 0.015 back from the ledger and saw the other ~0.085 land in the recipient's
// pocket, so it bled 0.085 TON per payout against zero TON income and
// eventually failed its own ACTION phase (GAUNTLET H11, found on testnet
// 2026-09-14 after three payouts were silently lost). With the excess returning
// the same payout is +0.0126 TON: the ledger's existing 0.015 TON leg covers
// the round trip and §4.1's gas & ops line needs no re-cut.
fun payOut(cfg: VaultConfig, queryId: int, to: address, amount: coins, respondTo: address) {
    val b = cfg.b.load();
    createMessage({
        bounce: BounceMode.RichBounce,
        value: TRANSFER_GAS,
        dest: b.jettonWalletAddr,
        body: (JettonTransfer {
            queryId: queryId,
            amount: amount,
            destination: to,
            responseAddr: respondTo,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: null,
        }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

// H12/D-129. Can this contract pay the jetton hop out of its OWN balance and
// still hold its rent afterwards? `getOriginalBalance()` is the balance at the
// start of the compute phase and TVM has already credited this message's value
// to it, so the pre-message balance is the difference — the idiom
// `primes_ledger.tolk:3304-3315` documents at length.
//
// Why it has to be asked at all: below `TRANSFER_GAS` the compute phase still
// SUCCEEDS (exit 0) and the ACTION phase fails with result 37, reverting the
// whole transaction. The mint that triggered the payout survives, because the
// ledger's leg is deliberately `BounceMode.NoBounce` — so nothing reports
// anything, `RetryBountyPayout` has no journal entry to replay (it would have
// been written inside the reverted transaction), and `onBouncedMessage` never
// fires because an action-phase failure is not a bounce. Each trigger is
// one-shot, so the payout was permanently forfeit. Three real payouts were lost
// that way on testnet 2026-09-14.
@inline
fun hopAffordable(valueCoins: coins): bool {
    return contract.getOriginalBalance() - valueCoins >= TRANSFER_GAS + STORAGE_FLOOR;
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetWallet => {
            var cfg = storage.cfg.load();
            var b = cfg.b.load();
            assert (in.senderAddress == b.genesisScriptAddr) throw 100; // wrong_sender
            assert (b.walletSet == 0) throw 104; // already_processed
            b.jettonWalletAddr = msg.jettonWalletAddr;
            b.walletSet = 1;
            cfg.b = b.toCell();
            storage.cfg = cfg.toCell();
            storage.save();
        }

        PayEraBounty => {
            var cfg = storage.cfg.load();
            var b = cfg.b.load();
            assert (b.walletSet == 1) throw 101; // wrong_opcode (vault not funded/wired yet)
            assert (in.senderAddress == cfg.ledgerAddr) throw 100; // wrong_sender
            val scheduled = storage.schedule.get(msg.eraBoundary);
            // Not a scheduled boundary: cheap-fail rather than throw, so a mint
            // is never unwound by an unrecognized era (engineering-spec §5 row 6).
            if (!scheduled.isFound) { return; }
            // Idempotent: a retried send after a false-negative bounce cannot
            // double-pay (bounty_vault.tlb's own stated guarantee).
            if (storage.paidEras.get(msg.eraBoundary).isFound) { return; }
            val entry = scheduled.loadValue();
            // D22: PRIMES = TON / p_f = bountyTon * S / T. The multiply happens
            // before the divide, as everywhere else in this codebase, so the
            // fixed-point loss is one ulp of nano-PRIMES rather than of TON.
            // `T == 0` is the pre-first-mint state and cannot coexist with a
            // primorial boundary; falling back to the nominal cap there keeps
            // the branch total instead of leaving a division by zero.
            //
            // The cap is applied to the WIDE intermediate, before anything is
            // narrowed to `coins`. `bountyTon * s` is a 257-bit product and a
            // pathological `s` could push the quotient past VarUInteger 16's
            // range; capping first means the value that becomes a `coins` is
            // always one the schedule already declared.
            var raw: int = entry.maxPrimes;
            if (msg.t > 0) {
                raw = entry.bountyTon * msg.s / msg.t;
                if (raw > entry.maxPrimes) { raw = entry.maxPrimes; }
            }
            val amount: coins = raw;
            // A zero payout would consume the era for nothing. Leave it unpaid
            // and re-armable rather than burning the boundary on a rounding
            // artefact — same cheap-fail discipline as the two checks above.
            if (amount == 0) { return; }
            if (!storage.canCover(amount)) { return; } // V26.7: exhausted, not deferred
            if (!hopAffordable(in.valueCoins)) {
                // H12/D-129: journalled, NOT sent — no flag, no `paidTotal`, no
                // `payoutCount`, no message. That is precisely the state
                // `RetryBountyPayout` was written for (it asserts the flag is
                // clear and sets it itself, because it was built for the bounce
                // path where `onBouncedMessage` clears it first), so it replays
                // this row once the vault is funded again.
                storage.journalUnpaid(mutate b, 0, msg.eraBoundary, msg.beneficiary, amount);
                cfg.b = b.toCell();
                storage.cfg = cfg.toCell();
                storage.save();
                return;
            }
            storage.paidEras.set(msg.eraBoundary, 1);
            storage.paidTotal += amount;
            storage.payoutCount += 1;
            storage.save();
            payOut(cfg, payoutQid(0, msg.eraBoundary), msg.beneficiary, amount, contract.getAddress());
        }

        PaySpecialNumberRebate => {
            var cfg = storage.cfg.load();
            var b = cfg.b.load();
            assert (b.walletSet == 1) throw 101; // wrong_opcode (vault not funded/wired yet)
            assert (in.senderAddress == cfg.ledgerAddr) throw 100; // wrong_sender
            var special = b.special.load();
            val kindEntry = special.rebateSchedule.get(msg.kind);
            // Unrecognized kind: cheap-fail rather than throw, so a mint is
            // never unwound by an unexpected value (same discipline as an
            // unscheduled era boundary above).
            if (!kindEntry.isFound) { return; }
            // Idempotent per special number: a retried send after a
            // false-negative bounce cannot double-pay the same `n`.
            if (specialPaid(special, msg.n)) { return; }
            // The key rides in the payout's queryId (see PAYOUT_QID). No real
            // mint reaches 2^61; cheap-fail rather than unwind one that did.
            if (msg.n >= PAYOUT_QID_KEY_MAX) { return; }
            val entry = kindEntry.loadValue();
            // Per-point on the composite kind, flat on the prime family. A zero
            // score therefore pays nothing at all, which is the correct answer
            // for a number with no category: the rebate is a function of what
            // the number IS.
            val mult: int = msg.kind == REBATE_COMPOSITE_PER_POINT ? msg.points : 1;
            val bounty: coins = entry.bountyTon * mult;
            val cap: coins = entry.maxPrimes * mult;
            var raw: int = cap;
            if (msg.t > 0) {
                raw = bounty * msg.s / msg.t;
                if (raw > cap) { raw = cap; }
            }
            val amount: coins = raw;
            if (amount == 0) { return; }
            if (!storage.canCover(amount)) { return; } // V26.7: exhausted, not deferred
            if (!hopAffordable(in.valueCoins)) {
                // H12/D-129 — journalled, not sent. `special.paidSpecials` is
                // deliberately NOT written here: `RetryBountyPayout` sets it
                // itself and asserts it is clear first.
                storage.journalUnpaid(mutate b, 1, msg.n, msg.beneficiary, amount);
                cfg.b = b.toCell();
                storage.cfg = cfg.toCell();
                storage.save();
                return;
            }
            special.setSpecialPaid(msg.n, true);
            b.special = special.toCell();
            cfg.b = b.toCell();
            storage.cfg = cfg.toCell();
            storage.paidTotal += amount;
            storage.payoutCount += 1;
            storage.save();
            payOut(cfg, payoutQid(1, msg.n), msg.beneficiary, amount, contract.getAddress());
        }

        PayProgramBounty => {
            // Every voucher claim lands here (the vouchers are allow-listed).
            var cfg = storage.cfg.load();
            var b = cfg.b.load();
            assert (b.walletSet == 1) throw 101; // wrong_opcode
            val (keyWc, key) = in.senderAddress.getWorkchainAndHash();
            // The allow-list is keyed on the hash alone: pin the workchain too, so a
            // same-code, same-data copy on the masterchain cannot pass (audit Low).
            assert (keyWc == 0) throw 700; // vault_not_allowlisted
            val look = storage.allowlist.get(key);
            assert (look.isFound) throw 700; // vault_not_allowlisted
            var entry = look.loadValue();
            assert (entry.programTag == msg.programTag) throw 700; // vault_not_allowlisted
            assert (entry.remaining >= msg.amount) throw 701; // vault_insufficient_balance
            // The track is not the wallet: era and special payouts draw the same
            // PRIMES. Refuse here, while the throw still bounces to the voucher and
            // rolls the claim receipt back; past this line a wallet refusal
            // returns to this vault alone and the receipt keeps the mark.
            assert (storage.canCover(msg.amount)) throw 701; // vault_insufficient_balance
            entry.remaining -= msg.amount;
            storage.allowlist.set(key, entry);
            // D-53/B12.1: debited and counted BEFORE the send; a bounce puts
            // it back on this track, found again by the `programTag` in the
            // queryId (QID_BOOK, V26.1). No journal row, landed or bounced.
            storage.paidTotal += msg.amount;
            storage.payoutCount += 1;
            storage.save();
            payOut(cfg, programQid(msg.programTag), msg.beneficiary, msg.amount, contract.getAddress());
        }

        RetryBountyPayout => {
            // The caller funds the replay's jetton hop plus this arm's gas.
            // Without it a vault whose
            // wallet keeps refusing (bounce -> journal -> retry -> bounce) paid
            // TRANSFER_GAS per cycle out of its own balance, for anyone, forever.
            assert (in.valueCoins >= RETRY_PAYOUT_VALUE) throw 103; // insufficient_value
            var cfg = storage.cfg.load();
            var b = cfg.b.load();
            // Era/special rows only: a program payout is repaired onto its
            // book by the bounce arm and never journalled,
            // so there is nothing of theirs here to replay (702).
            val rkey = msg.queryId;
            val journalled = b.retryJournal.get(rkey);
            assert (journalled.isFound) throw 702; // vault_no_retry_journalled
            val entry = journalled.loadValue();
            if (entry.kind == 0) {
                assert (!storage.paidEras.get(entry.key).isFound) throw 703; // vault_already_paid
                storage.paidEras.set(entry.key, 1);
            } else {
                var special = b.special.load();
                assert (!specialPaid(special, entry.key)) throw 703; // vault_already_paid
                special.setSpecialPaid(entry.key, true);
                b.special = special.toCell();
            }
            // Delivered or not, this row has done its job: a bounce of the send
            // below writes a fresh one from the bounced transfer (PAYOUT_QID).
            b.retryJournal.delete(rkey);
            cfg.b = b.toCell();
            storage.cfg = cfg.toCell();
            storage.paidTotal += entry.amount;
            storage.payoutCount += 1;
            // H12/D-129: this row is no longer awaiting anything. The guard is
            // for a row journalled by a build older than `deferredCount` — the
            // counter must never underflow and brick the retry path.
            if (storage.deferredCount > 0) { storage.deferredCount -= 1; }
            storage.save();
            payOut(cfg, payoutQid(entry.kind, entry.key), entry.beneficiary, entry.amount, contract.getAddress());
        }

        Excesses => {
            // Accept and keep. No sender gate for the same reason the jetton
            // master has none: nothing moves, the value is already credited,
            // and the worst an impostor achieves is funding the vault's gas.
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // A bounced jetton transfer means the PRIMES never left the vault's wallet
    // (the wallet restores its own balance on bounce — see
    // primes_jetton_wallet.tolk), so nothing is DESTROYED. But `paidEras` /
    // `special.paidSpecials` are set BEFORE `payOut` is even sent (see
    // `PayEraBounty`/`PaySpecialNumberRebate` above), so without repair a
    // bounce here would leave the boundary/number PERMANENTLY marked paid
    // while the PRIMES sit, unspendable, in this vault's own wallet.
    //
    // Every payout carries what its repair needs in its queryId, and the rich
    // bounce returns the whole transfer, so nothing is journalled on the happy
    // path. Era bounties and special rebates (PAYOUT_QID) get the row
    // `RetryBountyPayout` replays written HERE, from the bounced transfer.
    // Program payouts (QID_BOOK) go straight back on their book and are never
    // journalled at all (V26.1).
    var storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    val opcode = rich.originalBody.beginParse().loadUint(32);
    if (opcode == 0x0f8a7ea5) {
        val original = lazy JettonTransfer.fromCell(rich.originalBody);
        var cfg = storage.cfg.load();
        var b = cfg.b.load();
        val qid = original.queryId;
        if ((qid & QID_BOOK) != 0) {
            // Kind 3, a program payout: the debited PRIMES go back on the track
            // whose `programTag` rode in the queryId, so the program can simply
            // send again. The allow-list is genesis-fixed — a handful of
            // entries with distinct tags (the wrapper refuses a duplicate) — so
            // a walk is the whole lookup.
            val tag = qid & 0xFFFFFFFF;
            var r = storage.allowlist.findFirst();
            var done = false;
            while (r.isFound && !done) {
                var allow = r.loadValue();
                if (allow.programTag == tag) {
                    allow.remaining += original.amount;
                    storage.allowlist.set(r.getKey(), allow);
                    done = true;
                }
                r = storage.allowlist.iterateNext(r);
            }
            storage.paidTotal -= original.amount;
            storage.payoutCount -= 1;
            storage.save();
            return;
        }
        if ((qid & PAYOUT_QID) != 0) {
            val kind = (qid & PAYOUT_QID_KIND) != 0 ? 1 : 0;
            val key = qid & (PAYOUT_QID_KEY_MAX - 1);
            if (kind == 0) {
                storage.paidEras.delete(key);
            } else {
                var special = b.special.load();
                special.setSpecialPaid(key, false);
                b.special = special.toCell();
            }
            // H12/D-129: now awaiting a retry — the same standing as a row the
            // balance guard deferred, and `getDeferredPayouts()` counts both.
            storage.journalUnpaid(mutate b, kind, key, original.destination, original.amount);
            cfg.b = b.toCell();
            storage.cfg = cfg.toCell();
            storage.paidTotal -= original.amount;
            storage.payoutCount -= 1;
            storage.save();
        }
    }
}

// ---------------------------------------------------------------------------
// Get-methods
// ---------------------------------------------------------------------------

// (scheduled, bountyTon, maxPrimes, paid). Two amounts rather than one since
// DENOMINATION_PLAN P4 (D22): the ceremony's fixed VALUE in nanoTON, and the
// nominal PRIMES cap it can never exceed. §9.1 — the dashboard's era figure is
// `bountyTon * S / T` from this get-call and the ledger's, recomputable by any
// reader, never a printed constant.
get fun getEraSchedule(eraBoundary: int): (int, int, int, int) {
    val storage = lazy Storage.load();
    val look = storage.schedule.get(eraBoundary);
    val paid = storage.paidEras.get(eraBoundary).isFound ? 1 : 0;
    if (!look.isFound) { return (0, 0, 0, paid); }
    val entry = look.loadValue();
    return (1, entry.bountyTon, entry.maxPrimes, paid);
}

// CONCEPT §3.3 / §9.1 / §11.21 — the vault-payout half of the circulating
// -supply report: (paidTotal, payoutCount). Both routes are counted, so a v1.1
// program bounty and an era ceremony land in the same total; the era detail
// stays available per boundary in `getEraSchedule`.
//
// This is a *movement* counter, not a balance: the vault's remaining PRIMES
// live on its jetton wallet and are read there (`get_wallet_data`), which is
// also the only place a bounced payout is reflected. Reporting both and letting
// them be compared is the point — `genesis.bounty_vault_size_primes - paidTotal
// ≈ wallet balance` is a one-line check a reader can run without trusting this
// contract's own arithmetic.
// (scheduled, bountyTon, maxPrimes) for a rebate kind (0 = composite per
// point, 1 = prime family) — PER POINT on kind 0, so a caller multiplies,
// and whether special number `n` has already been paid its rebate. Same
// §9.1 shape as `getEraSchedule` — the dashboard's special-number figure is
// recomputable by any reader, never a printed constant.
get fun getRebateSchedule(kind: int, n: int): (int, int, int, int) {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    val special = cfg.b.load().special.load();
    val look = special.rebateSchedule.get(kind);
    val paid = specialPaid(special, n) ? 1 : 0;
    if (!look.isFound) { return (0, 0, 0, paid); }
    val entry = look.loadValue();
    return (1, entry.bountyTon, entry.maxPrimes, paid);
}

get fun getVaultPayouts(): (int, int) {
    val storage = lazy Storage.load();
    return (storage.paidTotal, storage.payoutCount);
}

// V26.7 — the declared genesis funding `canCover` gates the pushed routes on.
// `getVaultFunded() - paidTotal` is the remainder an era bounty or special
// rebate must fit; the wallet's own balance is still the figure §9.1 shows.
get fun getVaultFunded(): int {
    val storage = lazy Storage.load();
    return storage.fundedPrimes;
}

// H12/D-129. How many journal rows are written but UNPAID — a payout this
// contract owes and has not delivered, whether because the balance guard
// deferred it or because its jetton transfer bounced. Deliberately its own
// get-method rather than a third field on `getVaultPayouts()`: that pair is the
// §3.3 supply report and a deferred payout is not supply, it is a liability, so
// netting the two into one call would be the same false reading §3.3 forbids.
// Zero is the normal answer; any other number is a `RetryBountyPayout` waiting
// to be fired by anyone, and §9.1 says a number a reader needs comes off a
// get-method or it does not exist.
//
// The second value is `journalKey`, the NEXT journal key this contract will
// issue, and it is here because without it a deferred row could be counted but
// never fired: a BOUNCED payout announces its own key (the bounced
// `JettonTransfer` carries the queryId verbatim), but a payout the balance
// guard deferred was never sent, so nothing announces anything. Bounding the
// key space is what makes the retry reachable — a caller walks `0 .. journalKey
// - 1`, reads each row with `getRetryEntry`, and fires `RetryBountyPayout` only
// on a `retryable` one (G59). A blind send still cannot double-pay (703/702 fail
// closed), but it is a red transaction nobody needed to send.
get fun getDeferredPayouts(): (int, int) {
    val storage = lazy Storage.load();
    return (storage.deferredCount, storage.journalKey);
}

// GAUNTLET.md G59 — (found, retryable, kind, entryKey, amount) for ONE journal
// row, so a scan decides on the ROW before it sends (CLAUDE.md's driver rule)
// instead of firing `RetryBountyPayout` at every key under `journalKey` and
// letting 702/703 sort them. `retryable` is exactly the retry arm's asserts,
// in the same order: the row exists (702) and its paid flag is not set (703).
// Pure read; a key never written answers zeros.
get fun getRetryEntry(key: int): (int, int, int, int, int) {
    val storage = lazy Storage.load();
    val b = storage.cfg.load().b.load();
    val look = b.retryJournal.get(key);
    if (!look.isFound) { return (0, 0, 0, 0, 0); }
    val entry = look.loadValue();
    val paid = entry.kind == 0 ? storage.paidEras.get(entry.key).isFound : specialPaid(b.special.load(), entry.key);
    val retryable = paid ? 0 : 1;
    return (1, retryable, entry.kind, entry.key, entry.amount);
}

// (ledger, jettonMaster, jettonWallet, walletSet).
get fun getVaultConfig(): (address, address, address, int) {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    val b = cfg.b.load();
    return (cfg.ledgerAddr, cfg.jettonMasterAddr, b.jettonWalletAddr, b.walletSet);
}

// The allow-list is deploy-time-fixed; exposed so that claim
// can be checked by inspection (engineering-spec §6) rather than trusted.
get fun isAllowlisted(addrHash: int): int {
    val storage = lazy Storage.load();
    return storage.allowlist.get(addrHash).isFound ? 1 : 0;
}

// DECISIONS.md D-170 point 4, GAUNTLET.md F79 — (found, addrHash, remaining) for the
// allow-list entry under `programTag`. §9.1: `/verify`'s bug-bounty prize is the `SECU`
// entry's `remaining`, read here, never typed. `addrHash` is the program contract's
// basechain address hash (the map key), so a reader can check WHICH contract may spend it.
// A walk, as in the bounce arm: the list is a handful of genesis-fixed rows with distinct
// tags. Pure read; an unlisted tag answers zeros.
get fun getProgram(programTag: int): (int, int, int) {
    val storage = lazy Storage.load();
    var r = storage.allowlist.findFirst();
    while (r.isFound) {
        val allow = r.loadValue();
        if (allow.programTag == programTag) { return (1, r.getKey(), allow.remaining); }
        r = storage.allowlist.iterateNext(r);
    }
    return (0, 0, 0);
}
