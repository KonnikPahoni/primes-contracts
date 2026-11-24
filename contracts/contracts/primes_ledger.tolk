tolk 1.4
import "@stdlib/gas-payments"
import "minter_standing"

// ============================================================================
// TON PRIMES — Splitter + Ledger. The core contract.
//
// v5 / UPGRADE_PLAN_V5.md §4 B1: this file is the successor of the retired
// `primes_bank.tolk`. CONCEPT.md v5 §3.4 retires the word "bank" and splits the
// monolith into components, each of which must satisfy
// `balance ~= its own declared liability` in ONE get-call (`getSolvency` here):
//
//   primes_ledger.tolk    (this file) — T, S, p_f, div_acc, head, the five-way
//                                       split. Splitter and ledger are FUSED:
//                                       same state, same transaction, so a hop
//                                       between them would buy nothing (§3.4).
//   primes_ratchet.tolk               — pending, flush(), the DeDust leg, burn.
//                                       Separate so "no admin withdraw path" is
//                                       verifiable by reading ONE contract's
//                                       outbound set.
//   primes_registrar.tolk             — era trophies and the paid-annotation door.
//                                       Holds no protocol GRAM at all.
//
// Two pools of GRAM, no third: `pending` on the ratchet and `owed` on the prime
// items. D-90 deleted the escrow (and its shard) — a won lot mints in the
// transaction that closes it.
//
// The ledger no longer holds `pending`. Every GRAM that used to accumulate here
// as pool backing is forwarded to the ratchet in the same transaction via
// `PoolInject` (0xb0000050), which also carries the (T, S) snapshot the ratchet
// needs for §4.3.1's floor guard — TVM has no synchronous cross-contract read,
// so the floor the guard prices against is a pushed cache, not a pull. `T` and
// `S` remain authoritative HERE; the ratchet's copies are read-only mirrors.
//
// Phase 3, IMPLEMENTATION_PLAN.md §3 build step 3, built on the Phase 0 spikes
// (spike_mr.tolk's Miller-Rabin, spike_solvency_bank.tolk's owed-write shape).
// Storage / message layouts: docs/engineering-spec.md §4.1, /shared/schemas/ledger.tlb,
// /shared/opcodes.ts LEDGER. Parameters: /shared/params.json (Phase 1 sim output).
//
// ---- Documented deviations from the Phase 2 spec (see docs/phase3-report.md) ----
// D1. Prime-lookup structure: implemented as a *chunked* bitmap
//     (map<uint32,uint256>, 256 bits/chunk) rather than engineering-spec §2.4's
//     literal single contiguous-cell bitmap. Tolk's map<K,V> is the only
//     ergonomic O(log n)-lookup structure exposed by the stdlib; a truly
//     contiguous bit-addressed cell chain would need either a full sequential
//     walk from the root on every mint (unacceptable gas at large head) or a
//     hand-rolled tree the spec doesn't specify. The chunked map keeps the same
//     *asymptotic* property the spec cares about (state size does not scale
//     with the number of PRIMES, only with head/256, i.e. ~256x fewer entries
//     than a naive one-bit-per-dict-entry design) while staying inside what
//     Tolk 1.4's stdlib actually offers. Ceiling pushed out to roughly
//     256 * 32,768 ~= 8.4M (vs. the spec's ~6.7e7 for a true flat bitmap) —
//     smaller than the spec's target but still ~21x further than the sparse
//     per-prime dict Phase 0 measured, and unreachable by any horizon Phase 1
//     simulated.
// D2. Referral payout: TVM has no synchronous cross-contract read, so the ledger
//     cannot resolve "current owner of NFT #key" inside the mint transaction as
//     CONCEPT.md §3.1 literally describes. This contract instead forwards the
//     referral GRAM to the deterministic ItemAddress(key) with a new
//     `ForwardToOwner` opcode (0xc1000002, not in /shared/opcodes.ts) — the item
//     DOES know its own owner synchronously and relays the value onward. See
//     primes_item.tolk's header comment.
// D3. Prime-mint tribute recipient count: CONCEPT.md/engineering-spec never state
//     what happens to the 10% tribute line when the *minted number itself* is
//     prime (it has no smaller prime factors, hence zero tribute recipients by
//     §3.2's own rule). Resolved here as: zero recipients -> the tribute line
//     folds into the pool injection, matching the project's stated preference
//     for unattributed value to back the floor rather than being paid to
//     nobody or trapped (CONCEPT.md §3.1's identical treatment of orphan
//     referrals).
// D4. Lot settlement (`mint_won_lot`) and era bounties (`pay_era_bounty`) are
//     wired to fixed sender/destination checks against `ConfigD.marketAddr` and
//     `ConfigD.bountyVaultAddr`; both paths stay off until `set_peers` (D12)
//     sets `peersSet`.
// D8. THE MINT IS ONE MESSAGE. `mint` (0xb0000002) carries the number, its class,
//     its factorization, the referral key and the beneficiary, and mints against
//     `head` in the transaction that receives it, so `k(t)` is read at execution.
//     CONCEPT §8 accepts the resulting MEV exposure rather than mitigating it:
//     what a snipe wins is bounded by `k_max · β · P`, and §4.4's ascending
//     auction ahead of the head is the answer to "I want number n specifically".
//     The losing-race path below
//     (n != head) refunds in full, so losing a race costs gas and never principal.
// D12 (D-45). `mint` cannot ask the market "is n under a lot?" — TVM has no
//     synchronous cross-contract read — so the ledger keeps its OWN off-head
//     bitmap (same chunked shape as D1's prime bitmap). The bit is PERMANENT:
//     once a composite is opened for auction it is off the sequential line
//     forever, exactly like a prime. Three messages:
//       - `mark_off_head`   (0xb0000021, market -> ledger) sets the bit, SENT AT
//                            OPEN, not at close, so the head skips the number
//                            for the whole life of the lot. Refused only when
//                            `n` was never marked AND `n <= head` — a race
//                            against a direct mint that already landed. Refusal
//                            replies `mark_rejected` (0xe0000032), which cancels
//                            the just-opened lot and refunds the opener in full.
//       - `sync_head`       (0xb0000023, PERMISSIONLESS) pushes the ledger's real
//                            head to the market's lagging `headHint` cache
//                            (engineering-spec §2.5's "known lag, accepted").
//       - `set_peers`       (0xb0000041, genesis script, one-shot) supplies
//                            `marketAddr` / `bountyVaultAddr`, which cannot be
//                            fixed at deploy: each peer's init data embeds the
//                            ledger address — the same circular-address problem
//                            as D7/D11, resolved the same one-shot way.
// D13. A prime sold by the market (`settle_prime_clearing`) is NOT re-run
//     through Miller-Rabin here: the market ran the identical verifier when the
//     lot opened (CONCEPT §4.4), so the ledger trusts the market's fixed address
//     for the primality claim only. Composites ARE re-verified here (product ==
//     n, every factor a marked prime or proved by MR), since the bitmap is
//     ledger-local ground truth.
// D14. `GenesisSeed` carries `seedHead`, and the ledger marks every prime below
//     it in its own bitmap by running Miller-Rabin locally rather than trusting
//     a supplied list. Under D-20 the head opens at the first composite, 4, so
//     the walk records 2 and 3 as verified (and unsold) primes.
// D6. DeDust flush: cooldown/pct/min guards and the T/pending/swapped
//     bookkeeping are implemented and tested. The actual DeDust vault swap
//     payload is written against the *documented* native-vault swap shape
//     (best-effort; DeDust's real wire format could not be verified — Phase 0
//     Spike 3 was blocked for the identical reason) and is therefore NOT
//     exercised against a real or stub DeDust contract in this test suite;
//     only the guard logic and pending/T/swapped accounting are tested.
// ============================================================================

// ---------------------------------------------------------------------------
// Params (compile-time constants, /shared/params.json — NOT runtime-mutable;
// no message type in this contract writes to any of these).
// ---------------------------------------------------------------------------

const MINT_PRICE: coins = 1000000000; // 1 GRAM
// D-191 point 1: the value on the two ledger -> minter-card hops. A recruit
// credit's value comes back with the card's `card_recruit_counted` reply (less
// the card's deploy and compute); a prime credit's stays on the card as its
// storage reserve. Both are paid by §4.1's gas & ops line and measured in
// `GasRegression.spec.ts`'s worst case.
const CARD_RECRUIT_GAS: coins = 20000000; // 0.02 GRAM
const CARD_PRIME_GAS: coins = 5000000;    // 0.005 GRAM
// The most of a mint's 1 GRAM the payer -> card -> ledger hop may consume before
// the ledger refuses it (`handleCardMint`). The heaviest honest body (ω = 12 factors
// and a full invite list) costs 0.0012 GRAM, measured in `GasRegression.spec.ts`,
// which also asserts that the heaviest mint with its hop replaced by this whole
// allowance — a body padded to make the forward dear — still fits §4.1's line.
const CARD_HOP_ALLOWANCE: coins = 3000000; // 0.003 GRAM
// D-109: a wire constant of RES_GAS's kind (shared/opcodes.ts LEDGER.MINT_MARGIN_NANOTON),
// not a params.json economic parameter. `handleMint` keeps up to MINT_PRICE + MINT_MARGIN
// and refunds the rest, so a fat-fingered send funds nobody. 0.5 GRAM, not a tighter figure,
// because the webapp pads its own send to MINT_PRICE + 0.01 GRAM
// (`webapp/src/chain/values.ts` FEE_MARGIN_NANOTON) and `smokeMintLive.ts` to +0.05 GRAM —
// a tight ceiling would partial-refund an intentionally padded send, which is a worse
// failure than the one this closes.
const MINT_MARGIN: coins = 500000000; // 0.5 GRAM
// D-188 point 4: the bookmark a prime sold ahead of the head is born with
// (see `executeMint`). Above any `divAcc` the ledger can reach, so
// `div_acc − entry[p]` is never positive until `CreditDividend.base` lands.
const DIV_ENTRY_UNSTAMPED: coins = 0xffffffffffffffffffffffffffffff; // 2^120 − 1, the coins max
const TRIBUTE_AMOUNT: coins = 100000000;   // 10%
const REFERRAL_AMOUNT: coins = 100000000;  // 10%
const TREASURY_AMOUNT: coins = 50000000;   // 5% — D-152: paid to the governed TREASURY contract (reverses D-100 point 6)
// D-117 (signed 2026-09-22): 20%, DERIVED by the sim (`sim/primes_sim/gas.py`
// `gas_ops_line`) from the heaviest mint this contract can perform, measured on
// its own balance by GasRegression.spec.ts — an omega = 12 composite with every
// leg firing drains 0.186 GRAM (0.184 before D-180's factored rebate) — rounded up to the owner-set 5% step. What a mint
// does not spend, `sweep_ops` returns to the ratchet pool (no emission). It was a fixed
// 10% reconciled against a hand-kept hop list that missed the special-number
// rebate, the era trophy, the ratchet hop and the fee legs' forward fees; the
// ledger really spent 0.110 GRAM on the omega = 3 primorial. SimCrossCheck pins
// this constant to `shared/params.json` `mint.gas_ops_pct`.
const GAS_OPS_AMOUNT: coins = 200000000;   // 20%

// D-100 point 6 / §6 point 2: an unsold prime's forfeited tribute share is split
// between the governed treasury contract and the operator. This is the treasury
// side, in basis points; the operator takes the REMAINDER (`total - share`,
// never a second multiplication — see the send site, and RoundingDust.spec.ts
// for why that is the house rule).
//
// The figure is `shared/params.json` `genesis.forfeit_split_bps`, stated in
// D-166 as 58% treasury / 42% operator (D-100 point 6's 80/20 before it). It is
// a compile-time constant here for the same reason every other split rate in
// this block is: no message in this contract writes it, and
// `SimCrossCheck.spec.ts` is what holds the contract and params.json to the same
// number.
const FORFEIT_TREASURY_BPS: int = 5800;
// D-114 (amends D-7): an auction lot's premium above `MINT_PRICE + RES_GAS`
// (CONCEPT §4.4) splits between the ratchet and this same governed treasury
// contract, in basis points of the premium — the ratchet takes the
// remainder. `shared/params.json` `genesis.premium_treasury_bps`; owner-set,
// same idiom as `FORFEIT_TREASURY_BPS` above, not a sim output.
const PREMIUM_TREASURY_BPS: int = 5000;
const BPS_DEN: int = 10000;
// pool injection = MINT_PRICE - TRIBUTE - TREASURY - GAS_OPS - (REFERRAL if valid)
//                = 550_000_000 (referred) or 650_000_000 (unreferred), CONCEPT §4.1

// §3.2: the tribute line's internal 80/20 split (params.json
// tribute.divisor_line_share = 0.8, tribute.flat_dividend_f = 0.2).
// 80% goes down the e·√p-weighted divisor line to the cited factors' items;
// 20% accrues to `div_acc` as the flat prime dividend, split equally across
// all π(n) minted primes. Rounding remainders on BOTH halves fold into the
// pool (the documented no-dust-leak rule), never to the team.
const TRIBUTE_DIVISOR_AMOUNT: coins = 80000000; // 0.08 GRAM per composite mint
const TRIBUTE_FLAT_AMOUNT: coins = 20000000;    // 0.02 GRAM per composite mint

// GAUNTLET V3: CONCEPT.md §3.2's bound on ω(n), the count of DISTINCT prime
// factors — "sizing work must use ω ≤ 12; ω ≤ 8 is a statement about what the
// sequential head will actually reach, not about what an adversary can
// present" (§3.2, D-11/D-18's AUCTIONABLE_MAX derivation: the smallest number
// with 13 distinct prime factors is 41# ≈ 3.04e14, seven times
// AUCTIONABLE_MAX, so ω = 13 is unreachable by construction; 37# ≈ 7.42e12
// sits under the cap, so ω = 12 is the bound any check must admit). This is
// the ENTRY COUNT cap, paired with the distinctness check below — neither
// alone closes the gap: a count cap alone still admits `AUCTIONABLE_MAX`-sized
// duplicate padding (many entries citing the same prime) under this ceiling,
// and a distinctness check alone still admits an unbounded loop before V3.
const OMEGA_MAX: int = 12;

// GAUNTLET V17 point 3. The exactness bound of `isPrimeMR`'s 13-base witness
// set {2, 3, 5, ..., 41}: deterministic for every n BELOW this value
// (CONCEPT.md §3.1). Asserted once per mint in `executeMint`, which is what
// makes the guarantee LOCAL to this contract rather than inherited from
// `primes_market.tolk`'s AUCTIONABLE_MAX. Slack is enormous and deliberate —
// the largest argument any caller reaches is ~2n+1 at AUCTIONABLE_MAX
// (4.29e13), about 8.6e13, eleven orders below this — so the assert costs one
// comparison and refuses nothing a player can legitimately mint.
const MR_DETERMINISTIC_MAX: int = 3317044064679887385961981;

const K_SCALE: int = 1000000000; // fixed-point scale for k(t)/k_max/log10, 1.0 == 1e9
const K_MIN: int = 200000000;     // 0.2
const K_MAX_CAP: int = 900000000; // 0.9
// §5 ratchet theorem: `k < 1` holds because every k_max uplift is SUMMED first
// and clamped ONCE at K_CEIL — never clamped per-term, so no stack of bonuses
// can slip past the ceiling. The uplift terms (prime rank, PRIME_UPLIFT window,
// newcomer window, recruit rank) are all live and all summed by
// `kMaxEffective`, so any future uplift can only ever land inside this clamp.
const K_CEIL: int = 950000000;         // 0.95 (params.json rebate.K_CEIL)
// D-156 / §5: the LOGISTIC SUPPLY CAP. `S` was unbounded — §5's emission is
// multiplicative (`ΔS/S = k·β/T`), so `S` is bounded iff `k` is integrable in
// `u = ln n`, and `2.7/log₁₀(n)` is not. Worse, K_MIN above flattens the curve
// entirely past n ≈ 3·10¹³, making the tail a power law. D-156 does NOT replace
// that curve — it multiplies emission by `(S_MAX − S)/S_MAX`, which bounds `S`
// while leaving the sim-calibrated shape untouched where the game lives.
//
// Applied at each `storage.S +=` site AFTER the K_MIN clamp, deliberately: that
// ordering is what stops the floor defeating the cap, and it is why K_MIN and
// math-note.md §3 need no change. `k` only ever shrinks, so the single K_CEIL
// clamp still governs and the ratchet theorem strengthens rather than needing
// rework (math-note.md §2 is agnostic to WHY k < 1).
const S_MAX: int = 1200000000000000000;  // 1.2e9 PRIMES in nano (params.json rebate.S_MAX_nanoprimes, D-156)

// D-106 deleted patron mode and its split line; recruiting pays no GRAM. The
// recruit ladder and the era trophy survive, driven by §4.5 gift mints — see
// `recruitRankTier` and the recruit edge in `executeMint`.
// §5 / D-98: k(t) climbs LINEARLY from K_MIN and reaches k_max exactly here,
// then holds. This was the time constant of an exponential until D-98, which is
// why the name changed with the shape: `tau` names a curve that only covers 63%
// of the band in its first multiple and never attains the ceiling at all.
// params.json rebate.ramp_seconds.
const RAMP_SECONDS: int = 3600;
const N0_ANCHOR: int = 1000;
// GAUNTLET.md B32. `log10(N0_ANCHOR)`, which Tolk cannot compute at compile time and
// which nothing else in this file was stating. It exists so that K_MAX_NUMERATOR below
// is a DERIVATION rather than a transcription: the pair carries the invariant
// `N0_ANCHOR == 10^N0_LOG10`, and `kMaxOf` is continuous at the anchor only while it
// holds. KMaxCurve.spec.ts's B32 handover test is what fails if it stops holding.
const N0_LOG10: int = 3;

// §5's `k_max(n) = 2.7 / log10(n)`, and the 2.7 is NOT a parameter — it is
// `k_max_cap * log10(n0_anchor)` = 0.9 * 3, the numerator that makes the curve pass
// through exactly `K_MAX_CAP` at `n = N0_ANCHOR`, which is where the `n <= N0_ANCHOR`
// branch of `kMaxOf` hands over to it. Both factors are `shared/params.json`
// (`rebate.k_max_cap`, `rebate.n0_anchor`) and neither is invented here (CLAUDE.md
// rule 3).
//
// It was the bare literal `2700000000` inside `kMaxOf`, in the one file where every
// other constant is a named `const` read from params. Moving `k_max_cap` in the sim
// would have desynced it silently, and the only thing that would have noticed is a
// SimCrossCheck equality checking the wrong side of the relation to say why.
//
// K_SCALE^2 / K_SCALE: the numerator is scaled twice (0.9 and 3 are both fixed-point
// here only in the first factor), so `kMaxOf` divides by a once-scaled `log10n`.
const K_MAX_NUMERATOR: int = K_MAX_CAP * N0_LOG10;

// FLUSH_PCT / FLUSH_COOLDOWN / FLUSH_MIN moved to primes_ratchet.tolk together
// with `pending` and the DeDust leg (§3.4 decomposition).

// `SETTLE_GAS` (primes_market.tolk), the 0.025 GRAM slice of the market's
// `RES_GAS`, rides here with the lot CLOSE (D-90: the win mints in the closing
// transaction). It pays for the confirmation `handleSettle` sends back, and it
// is why §4.1's gas & ops line carries no lot-close cost.

// Config 43's `max_msg_cells`: no message, so no parked body, is larger. A protocol
// limit, not an economic parameter (V24's `retryItemMinValue`).
const MAX_MSG_CELLS = 8192;
const ITEM_DEPLOY_VALUE: coins = 25000000;   // 0.025 GRAM, right-sized per docs/phase0-report.md §5 verdict

// §4.1's SEVENTH SPLIT LINE (D-101 as DECISIONS.md D-202 rewrote it, and D-215
// made its terms operator-set). The minter may fund 0..`Config.inviteCount` plain
// transfers of `Config.inviteValue` each, to addresses THE MINTER names in the
// mint body -- no operator signature. Each carries the operator's words (D-211)
// as a text comment, so a Telegram wallet shows it as a message from this contract.
//
// D-215: the operator (`FeeDests.operatorAddr`) sets count, value and words with
// `set_invite_terms`, inside three numbers this file fixes and no message moves.
// They are carried by the sim as params.json `invites.count_ceiling`,
// `invites.line_cap_ton` and `invites.send_fee_allowance_ton`, and pinned against
// this file by SimCrossCheck.spec.ts:
//   INVITE_COUNT_CEILING -- at most 100 transfers per mint. TON caps one
//                           transaction at 255 out actions, and a mint sends its own.
//   INVITE_LINE_CAP      -- sent * (value + INVITE_SEND_FEE) <= 0.31 GRAM, checked at
//                           the setter AND at every invite mint, so whatever the
//                           operator writes, the residual beta never drops below the
//                           sim's worst case (0.24 on a referred composite).
//   INVITE_SEND_FEE      -- the per-transfer allowance the line pays for its own
//                           forward fee and this loop's compute. The transfer is sent
//                           PAY_FEES_SEPARATELY so `value` arrives whole (a Telegram
//                           wallet pushes for 0.1 GRAM received, not for 0.0999 --
//                           measured on mainnet 2026-11-22). Measured in
//                           GasRegression.spec.ts; whatever it overstates stays on this
//                           balance, outside every liability, so `sweep_ops` carries
//                           it to the ratchet pool.
//
// UNSPENT SLOTS FALL TO BETA and to nothing else. The deduction below is
// computed from the transfers ACTUALLY SENT, never from the declared count, so a
// slot with no address is simply never subtracted -- there is no refund term, no
// credit, no carry-forward, and no path by which an unspent slot reaches the
// team. The split stays closed at 100%.
const INVITE_COUNT_CEILING: int = 100;
const INVITE_LINE_CAP: coins = 310000000;   // 0.31 GRAM
const INVITE_SEND_FEE: coins = 1000000;     // 0.001 GRAM

// CONCEPT §6 point 0. Number 1 — neither prime nor composite, and therefore
// outside every rule in §3 through §5 that classifies a number.
const UNITY_N: int = 1;
// Bit 0 of the item's `rarityFlags`. The only bit the protocol assigns; every
// ordinary mint still writes 0 (rarity classes are deferred past v1, §3.1).
const RARITY_UNITY: int = 0x0001;
// One `launch_open` hop, to the market, whose handler does one storage write —
// the same shape and size as HEAD_SYNC_GAS below. Spent once by `ignite` (and
// again only by a `sync_launch` repair).
const LAUNCH_HOP_GAS: coins = 10000000;      // 0.01 GRAM
const CREDIT_TRIBUTE_VALUE: coins = 8000000;  // 0.008 GRAM per credit_tribute send
// GAUNTLET B1.1: the minimum a caller must fund `claim_dividend`/`retry_credit`
// with. Both are permissionless and both do real local compute (dict writes,
// two `save*` calls) on top of forwarding `CREDIT_TRIBUTE_VALUE` onward, so the
// guard cannot be `CREDIT_TRIBUTE_VALUE` alone — measured on `@ton/sandbox`,
// attaching 0.004 GRAM drained ~0.00509 GRAM of the ledger's own balance, i.e. the
// real break-even is ~0.0091 GRAM, not 0.008. Rounded up to the same 0.01 GRAM
// scale every other single-hop gas guard in this file uses (`HEAD_SYNC_GAS`,
// `SWEEP_GAS`), which comfortably covers the measured gap. D-188 point 4 made
// `claim_dividend` a round trip carried on the claimant's value (ledger ->
// item `credit_dividend` -> ledger `dividend_credited`): measured at ~0.0017 GRAM
// of fees for all three legs, so the same 0.01 still covers it
// (`PrimesGenesisMint.spec.ts` "GAUNTLET B1.1" claims at exactly this value).
const CLAIM_DIVIDEND_MIN_VALUE: coins = 10000000;  // 0.01 GRAM
// What a permissionless, caller-funded arm must ALSO bring for its own compute
// and forward fees, on top of what it sends on: `donate_floor` sent out exactly
// what it required, and `retry_credit` required less than its hop, so each call
// was paid from the float `sweep_ops` would otherwise pool (audit Low).
const CALLER_COMPUTE_GAS: coins = 10000000;  // 0.01 GRAM

// §3.4 decomposition hop costs, both drawn from the GAS_OPS_AMOUNT line (§4.1's
// 20%, D-117), NOT from the pool injection — the ratchet credits `pending` by the
// NOMINAL `amount` field and keeps the surplus as its own gas buffer, so the
// forwarded message value is deliberately `amount + hop gas` and never exactly
// `amount` (a contract that is sent exactly its nominal price rejects the
// message once its own compute phase is charged).
// CONCEPT §4.1: the standing float the ops sweep may never dip into. It funds
// the ledger's DEFERRED obligations — the ones a mint cannot pay at mint time:
// `owed` storage rent and lot-close (`mint_won_lot`) gas. (Amortized flush gas was
// a third until D-146: every permissionless ratchet leg is caller-paid now, so
// the sim's re-derivation dropped the term — it was ~0.000002 GRAM a mint and
// did not move the rounded reserve.)
//
// DERIVED, not chosen — `params.json fees.ops_reserve_ton`, and the whole
// derivation is in `fees.ops_reserve_derivation` beside it: one horizon of
// 10,000 mints of deferred draw, priced off `contracts/gas-baseline.json` (this
// repo's only real TVM gas measurement) at the basechain gas and storage config.
// The horizon is the single judgment in it. Do not edit this line on its own —
// re-run `sim/scripts/run_phase1.py` and take what it emits.
// D-90 moved it 58 -> 60: the settlement leg is measured across a lot CLOSE
// plus this contract's `mint_won_lot`. This is a FLOAT, not a price: nothing a
// player pays moved (D-90.4).
// D-99 raises this from 60 to 92 GRAM, and it is the score's bill.
// `fees.ops_reserve_ton` is DERIVED from the measured per-mint gas draw, and
// that draw went 0.0668 -> 0.0699 GRAM when `scoreOf` joined the mint path
// (GasRegression: composite mint 70918 -> 102669 units). The reserve is the
// balance the ops sweep may never dip below, so a mint that costs more to
// execute has to leave more behind. Re-derived by the sim, not chosen here.
// GAUNTLET V8c (2026-09-12): `contracts/gas-baseline.json` had gone stale
// against this file (last regenerated 2026-09-09, before the 2026-09-10
// `47580fc7` edit here), so `SimCrossCheck.spec.ts`'s OPS_RESERVE binding was
// comparing this constant to a derivation priced off an old
// `mint_won_lot` gas figure. Regenerated the baseline
// (`GAS_BASELINE_UPDATE=1 pnpm --filter ton-primes-contracts test -- GasRegression`)
// and re-ran `sim/scripts/run_phase1.py`: the fresh derivation is 90 GRAM, down
// from 91 (settlement gas per mint 0.008591 -> 0.008439 GRAM). Moved here to
// match, per this item's own resolution rule (move the contract to the fresh
// figure, don't hand-edit the baseline).
// D-146 re-run (2026-09-22): 90 -> 96. NOT D-146's own effect -- dropping the
// amortized-flush term moved the derivation by 0.02 GRAM. The re-run also picked up
// `ledger.mint_won_lot` at the gas the committed baseline already
// recorded (125,440, not the 115,818 the last params.json was priced on), which is
// settlement 0.00846 -> 0.00910 GRAM a mint and 89.35 -> 95.75 GRAM over the horizon.
// (GAUNTLET T15 found the same 90 -> 96 staleness independently, 2026-09-22.)
// D-117 re-run (2026-09-22): 96 -> 90. The held split moved the split sends out of
// `executeMint` into `mint_confirmed`, so `ledger.mint_won_lot` fell
// 125,440 -> 115,669 gas (settlement 0.00910 -> 0.00845 GRAM a mint); the moved
// compute is now on the gas & ops line, where GasRegression measures it.
// Merge with main (D-166/D-167/D-168) re-run, 2026-09-23: 90 -> 88 from the regenerated
// derivation (settlement gas and `owed` rent over the horizon; see params.json).
// D-20 baseline migration + C15 re-run (D-180), 2026-09-24: 88 -> 94. The baseline now
// counts `owed` entries for primes bought off the Dutch lane as well as at the head.
// Re-run 2026-09-26: 94 -> 96. The sim picked up `ledger.mint_won_lot` = 122,019 gas from
// the committed baseline (fd96c77e): settlement 91.16 + `owed` rent 4.70 = 95.86 GRAM, rounded up.
// V24 re-run (2026-09-26): 96 -> 98. The verified factor map costs `mint_won_lot`
// 122,019 -> 125,104 gas: settlement 93.21 + `owed` rent 4.70 = 97.91 GRAM, rounded up.
// V26.4 re-run (2026-09-26, D-191 point 1): 98 -> 99. The minter card's code in ConfigA and
// the card-derived sends cost `mint_won_lot` 125,104 -> 125,529 gas: settlement 93.50 +
// `owed` rent 4.70 = 98.20 GRAM, rounded up.
const OPS_RESERVE: coins = 99000000000;      // 99 GRAM
// Left behind on the sweep message so the sweep itself never eats into the
// reserve it is protecting.
const SWEEP_GAS: coins = 10000000;            // 0.01 GRAM

// ledger -> ratchet, every mint. D-146 (signed 2026-09-22) cut it 0.005 -> 0.001.
// The old figure was not the hop's cost: ~0.0006 of it paid the hop (PoolInject's
// forward fee, ~0.0004, and the ratchet's ~2,900-gas compute) and the rest piled
// up as the ratchet's gas buffer, which is what paid DeDust and Tonstakers for
// every flush, stake, exit and harvest. Caller-pays moved those bills to the
// caller, so the buffer now funds only the ratchet's own storage rent and this
// hop need carry only itself plus that rent — 0.0004 GRAM of margin per mint
// against a rent measured in thousandths of a GRAM a year. The 0.004 GRAM a mint
// this frees on §4.1's gas & ops line is what D-117's held split hop is paid from
// (the owner's budget rule, same session). `GasRegression.spec.ts` asserts the
// ratchet's buffer does not fall across a mint, which is the property this
// figure has to keep.
const RATCHET_HOP_GAS: coins = 1000000;     // 0.001 GRAM
// D-91 point 4: the floor-donation op's emission rate, `params.json
// genesis.genesis_lp_ratio_primes_per_ton` (D-29's L = 10,000 PRIMES/GRAM).
// Both sides are nano-denominated with the same 9 decimals, so `X * L` in
// nanotons IS the nano-PRIMES figure — no scale conversion.
const LP_RATIO_PRIMES_PER_TON: int = 10000;
// 0.02 GRAM, the same wallet-deploy + forward budget the rebate mint carries
// on this contract's only other JettonMint send.
const DONATE_MINT_GAS: coins = 20000000;
// TEP-74 `forward_ton_amount` on EVERY JettonMint this contract sends, and the
// reason it is not zero: with zero, `primes_jetton_wallet.tolk`'s notification
// branch never fires, the recipient's address appears NOWHERE in the mint's
// message tree (the excess returns to the master, not to them), and TonAPI —
// which is what Tonkeeper renders — attaches no action to the recipient's
// account at all. The PRIMES arrive and the player cannot see them arrive.
// Reported 2026-09-19 against testnet mint n=26: 102,921.54 PRIMES credited,
// the wallet showed only the bounty vault's 524.31 PRIMES, because THAT leg is
// a `JettonTransfer` and TonAPI attributes those to the recipient regardless.
//
// PAID FROM THE MASTER'S OWN SLACK, so §4.1's gas & ops line does not move:
// `primes_jetton_master.tolk`'s `deployAndCredit` attaches
// `ton("0.012") + forwardTonAmount`, and the 0.02 GRAM hop above already leaves
// the master ~0.0183 GRAM per mint (0.0073 retained + 0.0109 returned as
// `excesses`). At 0.005 that becomes ~0.0130 — still positive, still one
// message, and the ledger's outgoing value is unchanged.
//
// NOT SMALLER: the notification is sent in mode 0, so its forward fee (~0.0006
// GRAM, measured) comes out of this value and an amount below it fails the
// recipient wallet's action phase — which is exactly the bounce that made the
// first non-zero attempt here delivery no PRIMES at all. 0.005 is ~8x that fee.
const MINT_NOTIFY_TON: coins = 5000000;     // 0.005 GRAM
// The rebate mint's hop to the jetton master, named and shaved from 0.02 in the
// same change that added the notification above. The master's `deployAndCredit`
// spends `ton("0.010") + forwardTonAmount` = 0.015 of it and pays ~0.0006 in
// fees, so 0.018 leaves ~0.0023 of margin BEFORE the recipient wallet's
// `excesses` comes home — and the master was previously retaining ~0.0183 of
// the 0.02 per mint, GRAM that piles up on that contract and is swept by
// nothing. §4.1's gas & ops line is what pays this hop and it is measured
// against `GasRegression.spec.ts`'s reconciliation, which the notification's
// own ~0.00038 of fees pushed 0.166% over until this came down.
const REBATE_MINT_GAS: coins = 18000000;    // 0.018 GRAM
const REGISTRAR_HOP_GAS: coins = 6000000;   // 0.006 GRAM, ledger -> registrar (the era trophy award, primorial mints only)
// One `head_update` hop, to the market. NOT on the mint path — spent only by the
// permissionless `sync_head`, whose caller must attach at least this much.
const HEAD_SYNC_GAS: coins = 10000000;      // 0.01 GRAM
// D-189: the head-advance walk stops at the first unwalked position once the
// transaction has consumed this much gas (GASCONSUMED, not a step count: a
// prime near AUCTIONABLE_MAX costs ~18x an auctioned composite). Sized against
// the 1,000,000-gas basechain cap (config 20): the check runs BEFORE a step, so
// the walk ends at most one step (~0.2M at 4e13: Miller-Rabin plus bookkeeping)
// past this, and the head mint's post-walk tail (tribute sends at omega 12, item
// deploy, rebate) still has to fit after it. `HeadWalk.spec.ts` pins both ends.
const WALK_GAS_STOP: int = 450000;
// D-189: the least a caller attaches to `advance_head`. Its gas limit is
// value / gas price (400 nanoton per gas, config 21), and a walk can end at
// WALK_GAS_STOP plus one step; 0.3 GRAM buys 750k. Whatever it does not burn
// goes back to the caller.
const ADVANCE_HEAD_VALUE: coins = 300000000; // 0.3 GRAM
// D-196: THE IMPORT WINDOW, in 256-number blocks. Marks for a block below the
// frontier (`LOT_BLOCK_WINDOW_BLOCKS + Aux.lotBlocksImported`) live here; marks
// for one beyond it live on that block's `primes_lot_block.tolk` child until
// `import_lot_block` pulls them in, which it may once the block starts below
// `head + LOT_BLOCK_WINDOW_BLOCKS * 256`. `shared/params.json`
// `off_head.import_window.blocks`, bound by `SimCrossCheck.spec.ts`.
const LOT_BLOCK_WINDOW_BLOCKS: int = 26;
// D-196: the least a caller attaches to `import_lot_block`. It carries the child
// deploy (for a block no lot touched) and both legs of the round trip; what the
// round trip does not burn stays in this contract's gas float. A gas constant.
const IMPORT_LOT_BLOCK_VALUE: coins = 50000000; // 0.05 GRAM
// D-196: the value of the ledger's own `lot_block_sold_prime` hop, sent when a
// prime beyond the frontier sells. Prime settles only (no tribute fan-out), so it
// never touches the heaviest mint §4.1's gas & ops line is sized against.
const LOT_BLOCK_HOP_VALUE: coins = 10000000; // 0.01 GRAM
// LOW-4: the value of the ledger's `lot_block_release` hop. A flushed block keeps
// only a 0.01 GRAM rent floor, so this hop pays the rent accrued since the block was
// last touched (~0.007 GRAM/year at its densest), refills the floor and still sends
// the answer; the lot block returns the rest with the bookmark. 0.1 matches config
// 21's basechain freeze_due_limit (0.1 GRAM): a debt past it has frozen the block.
const LOT_BLOCK_RELEASE_VALUE: coins = 100000000; // 0.1 GRAM
// D-198: what `flush_unsold` must carry — one batch of at most FLUSH_MAX_ROWS rows
// on this account, plus the hop. Measured (LotBlock.spec.ts, a full 26-block window
// of 857 rows, every one with a forfeit row): the worst batch is 268,726 gas
// = 0.018 GRAM, so with the 0.06 hop and its forward fee a call spends ~0.079.
// The ~1.9x margin absorbs a config 21 gas price rise; the surplus stays in this
// contract's gas float, which `sweep_ops` returns to the pool.
const FLUSH_UNSOLD_VALUE: coins = 150000000; // 0.15 GRAM
// The hop's FIXED value: the lot block's merge of one batch (<= 59k gas, measured), sized
// on the merge because a merge out of gas has nothing left to bounce. A refusal bounces
// ~0.058 back; the restore of 16 rows on a full window costs 0.018 (LOW-5, measured).
// Fixed rather than carry-remaining (re-audit): if this account's walk ever ate into it,
// the action phase would fail and the WHOLE flush roll back here, instead of a starved
// lot block losing the rows in a transaction too poor to bounce. What the lot block does
// not burn above its LOT_BLOCK_RENT_FLOOR comes back here as an empty-body top-up (LOW-4).
const LOT_BLOCK_BOOKMARKS_VALUE: coins = 60000000; // 0.06 GRAM
// Rows one `flush_unsold` moves at most. A block holds up to 55 unsold primes and
// each row costs ~13-17k gas on a dictionary of up to ~27 blocks' rows (measured,
// with forfeit rows), so the densest block in one call would cost ~0.85-0.95M of
// the 1M-gas cap — and a flush that cannot fit would stall the head for good.
// 16 rows measure 268,726 gas (27% of the cap). So a dense block takes a few
// calls; the cursor moves only once the block is empty.
const FLUSH_MAX_ROWS: int = 16;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

struct UnroutedCredit {
    p: uint256
    amount: coins
}

// Storage is split across several ref'd sub-structs purely to satisfy Tolk's
// per-cell 1023-bit AND 4-ref limits — a flat struct with all fields inline
// measured 3165-3765 bits (10 `address` fields at 267 bits each dominate) and
// exceeded 4 refs once the dict fields were added back. This is a Phase 3
// implementability deviation, not a spec change: every field named in
// docs/engineering-spec.md §4.1 is still present, just relocated across
// cells (never more than 3 addresses inline per cell keeps each well under
// budget). The market and bounty-vault peer addresses live in their own ref'd
// sub-struct, `ConfigD` (D4/D12).
// `swapped` / `inFlightFlush` moved to primes_ratchet.tolk. What replaces them
// here is the ledger's OWN declared liability (§3.4's one-get-call solvency
// property): the GRAM this contract legitimately holds after a transaction
// settles is (a) §3.2's accrued tribute, credited to items as `owed` but
// CUSTODIED HERE, (b) tribute credits that bounced and are owed to a retry and
// (c) accrued flat dividends not yet claimed. Everything else is forwarded in
// the same transaction that receives it. (Commit deposits used to be a fourth
// line here; D8 removed the commit phase, so the ledger holds no deposits.)
//
// B-1: (a) used to be missing from this list AND from both consumers of it,
// which is the whole bug — `credit_tribute` moves a NUMBER to the item and
// leaves the GRAM here, so every composite mint parked 0.08 GRAM of player money
// outside the declared liability, where `sweep_ops` was entitled to pay it to
// the operator. The three lines below are the complete set; a fourth kind of
// retained GRAM is a solvency break, not a feature.
struct Meters {
    // §3.2 / §3.4: tribute credited to items as `owed` and not yet claimed —
    // the exact GRAM `claim_tribute` will pay out of this contract's balance.
    // Maintained O(1) against `sum_p item.owed` so getSolvency stays one call.
    //
    // The five transitions, in full, because an unpaired one silently re-opens
    // B-1 somewhere new:
    //   +  a mint credits a cited factor           (executeMint)
    //   +  ClaimDividend converts accrued -> owed  (handleClaimDividend)
    //   +  RetryCredit re-sends a bounced credit   (handleRetryCredit)
    //   -  that credit bounces back unrouted       (onBouncedMessage)
    //   -  ClaimTribute pays the owner             (handleClaimTribute)
    // The bounce/retry pair is the one that matters: a bounced credit is NOT
    // owed on any item (the item never ran), so it moves wholesale into
    // `unroutedHeld` and back, and is never counted in both at once.
    tributeOwed: coins
    // Sum of live UnroutedCredit.amount PLUS, since D-117, the held split of every
    // `MintItem` parked in `Aux2.unroutedItems` — both are GRAM held for a
    // permissionless retry of a send that bounced, owed to nobody until then.
    unroutedHeld: coins
    // D-52 — PRIMES, NOT GRAM, and therefore not a fourth kind of retained GRAM:
    // the header's "three lines" claim above is about this contract's GRAM
    // liability and is untouched by this field.
    //
    // `S` is incremented BEFORE the `JettonMint` that pays it out (`executeMint`
    // and `handleDonateFloor`), so a bounced mint leaves `S` counting PRIMES no
    // wallet holds. Rolling `S` back is forbidden — it is never decremented
    // (§3.3, §5, math-note §2's conservatism corollary: `p_f = T/S` must always
    // UNDERSTATE backing) — so the emission is parked here instead, and the
    // identity a reader can now close from get-methods alone is
    //
    //     S - unmintedHeld == jetton master totalSupply + cumulative sink burns
    //
    // Incremented when a `JettonMint` bounces (`onBouncedMessage`), decremented
    // when `retry_mint` re-sends it (`handleRetryMint`) — the same two-legged
    // shape as `unroutedHeld`, so the amount is in exactly one lane at a time.
    unmintedHeld: coins
    // §3.2: flat-dividend GRAM accrued but not yet converted into item `owed`
    // via ClaimDividend — Σ_p (div_acc − entry[p]) maintained O(1) so
    // getSolvency stays a single get-call (§3.4). Incremented by the accrued
    // total on each composite mint, decremented by the claimed amount when a
    // ClaimDividend credits the item.
    divOutstanding: coins
    nextCreditId: uint64
    genesisSeeded: uint8
    // CONCEPT §6 point 0: THE LAUNCH FLAG. 0 from deploy until `ignite` mints
    // Unity — number 1 — to the founder, and 1 forever after. One-shot: there is
    // no message that clears it, so this is a starting gun and not a pause
    // switch. `mint`, `mint_won_lot` and `settle_prime_clearing` throw 212
    // while it is 0, and the market holds its own copy, set by the one
    // `launch_open` that `ignite` sends.
    //
    // It lives in Meters rather than in a Config cell because every mint already
    // loads Meters, so the gate costs no extra cell load on the hot path.
    launched: uint8
    // D-20 + D-188 point 4-5: the primes the head has passed that have NO
    // OWNER yet, keyed by the prime, valued by its §3.2 dividend bookmark — the
    // `divAcc` at the moment the walk crossed it. The row IS the unsold flag
    // and the bookmark in one: an unsold prime has no item to hold its
    // bookmark, so the ledger holds it until the sale, deletes the row in the
    // sale's own transaction and hands the value to the new item
    // (`MintItem.primeInit`). While present, that prime's divisor-line share is
    // FORFEITED (§6 point 2) and `claim_dividend` refuses (219).
    //
    // BOUND (D-198): rows only for blocks in [Aux.unsoldFlushed, head], and the
    // walk stops LOT_BLOCK_WINDOW_BLOCKS past `unsoldFlushed`, so at most ~27
    // blocks' unsold primes whatever the backlog of open Dutch lots. Older blocks'
    // rows live on their lot blocks (`flush_unsold`). A sold prime leaves no row
    // here; its stamp goes to its item (straight from the release's answer for a
    // flushed one), and only an item that refuses it parks it in
    // `Aux2.soldAheadEntry`. "Unsold" itself is `primeBitmap`'s unsold bit,
    // which never leaves.
    unsoldPrimes: map<uint256, coins>
    // §6 point 2's `get_forfeited(p)` while `p` has no owner (unsold, or ahead
    // of the head and cited by a composite won there). Deleted at the sale and
    // handed to the item with the bookmark (`PrimeInit.forfeited`), where it
    // stays frozen: an owned prime forfeits nothing, so the counter is still
    // monotonic, it just moves house. BOUND: rows only for primes with no
    // owner that a mint has cited, and (D-196) only below the import frontier —
    // a factor beyond it is credited, and forfeits into `forfeitedBeyondWindow`
    // if the credit bounces — and (D-198) only at or above `Aux.unsoldFlushed`:
    // `flush_unsold` moves a block's rows to its lot block with its bookmarks, and
    // a later forfeit there joins `forfeitedBeyondWindow`. So at most the primes
    // of the ~27 + window blocks between the flush cursor and the frontier.
    forfeited: map<uint256, coins>
    // D-20: `getLaunch()`'s item count can no longer be derived from `head`
    // alone, because `head` now skips every prime rather than walking over
    // every integer — the gap between two composites is no longer exactly 1.
    // These two counters are the honest replacement: composites minted via the
    // sequential head, and primes actually sold (owned) via the market's
    // Dutch lane. `primesCount` (below, on Storage) stays a DIFFERENT number —
    // it is π(n), the flat-dividend divisor, stamped the moment a prime is
    // marked/citable rather than the moment it is sold, unchanged from before.
    compositesMinted: uint32
    primesSoldCount: uint32
    // ---- D-36 (§4.7, §7): the era trophy's tally ------------------------
    //
    // The era DIVIDEND is dropped from the design; the era TROPHY is built.
    // What the trophy needs, and all it needs, is an answer to "who recruited
    // the most this era" that is available AT THE CEREMONY — inside the
    // transaction that mints the primorial — with no scan and no keeper.
    //
    // `recruits` on MinterState is LIFETIME and is never reset. The era-scoped
    // counter §4.7 says rank keeps is on each wallet's MINTER CARD (D-191 point
    // 1: `eraRecruits`, taken under `eraSeq`); what stays here is the running
    // max over them:
    //
    //   leader      the running max's argmax; addr_none while the era has seen
    //               no recruit at all.
    //   leaderCount the running max itself, and the "is there a leader"
    //               sentinel: 0 means the era's primorial goes unnamed.
    //   eraSeq      ceremonies passed. A card's tally counts toward this era
    //               only when it was taken under this seq.
    //
    // A RUNNING MAX, not a scan. A ceremony-time scan over the recruiters is
    // unbounded work inside a mint, which is how a mint becomes un-mintable at
    // some head nobody predicted. The max is maintained on the card's reply to a
    // recruit credit instead — two comparisons, on a path that runs at most once
    // per recruit in that recruit's whole life.
    //
    // THE TIE-BREAK IS THE COMPARISON. `>` and not `>=`: a later wallet that
    // merely EQUALS the leading count does not take the lead, so the trophy
    // goes to the wallet that reached the winning count FIRST. That is
    // deterministic, needs no timestamp field, and rewards the recruiter who
    // got there earlier rather than the one whose activation happened to land
    // in a later block.
    //
    // D-106: the event counted is the RECRUIT EDGE — a §4.5 gift mint to a
    // wallet whose minter card is FRESH (D-191 point 1). That test is the whole
    // sybil guard: repeat gifts to the same wallet count once, so a recruit
    // costs a fresh address AND a full 1 GRAM mint, which is the same price
    // §8.1 already argued a fake recruit has to pay.
    // In its own ref'd cell for the usual reason (Meters is within 50 bits of
    // the 1023-bit ceiling with these inline), and at no cost on the hot path:
    // both readers are rare — the recruit edge and its card's reply, which run
    // at most once per recruited address ever, and the primorial ceremony, which runs eight
    // times in the life of the game.
    eraSeason: Cell<EraSeason>
    // P2.D1 (D-19's neighbourhood, §9.1): CUMULATIVE operator-funding counters,
    // never decremented. `getOpsSweep`/`getSolvency` already expose the
    // CURRENT sweepable balance and liability, but neither answers "how much
    // has the operator actually been paid, lifetime" — and §9.1 forbids a
    // dashboard from showing that number until a get-method backs it. In its
    // own ref'd cell for the same reason `eraSeason` is: Meters is already
    // close to the 1023-bit ceiling with these inline, and both readers here
    // are cold paths relative to the mint hot path (one extra cell load/store
    // on mint, one on sweep — not on every meters touch).
    operatorMeters: Cell<OperatorMeters>
}

// D-36: see the block comment above `Meters.eraSeason`.
struct EraSeason {
    // D-191 point 1 DELETED the per-recruiter `recruits` map: each wallet's era
    // tally lives on its minter card, taken under `eraSeq`, and reaches this
    // running max as a `card_recruit_counted` reply. `eraSeq` counts ceremonies;
    // a reply taken under an earlier one is dropped (see the handler).
    leader: any_address
    leaderCount: uint32
    eraSeq: uint8
}

// P2.D1: see the block comment above `Meters.operatorMeters`.
//
// D-100 point 6 SPLITS THIS INTO TWO COUNTERS, and the reason is the whole of
// why the old one was honest and no longer is. It read:
//
//     treasuryPaidTotal — every `TREASURY_AMOUNT` send plus every D-20 point 2
//                         forfeit-to-treasury send, lifetime. Both land in the
//                         same wallet for the same reason (§6 point 2), so one
//                         counter is honest; splitting them would invite a
//                         reader to sum two numbers that were never meant to be
//                         read apart.
//
// After D-100 they do NOT land in the same wallet: each forfeit pays
// FORFEIT_TREASURY_BPS to the governed treasury contract and the remainder to
// the operator. One counter over two destinations would be the thing that
// invites the misreading — a §9.1 dashboard row "paid to the treasury" that is
// partly not the treasury's money. So there are two, each counting exactly one
// recipient, and a reader who wants the old figure adds them (which is a sum
// that IS meaningful: total fee revenue out of the split, excluding the ops
// sweep).
//
// D-152 MOVED `TREASURY_AMOUNT` FROM THE FIRST COUNTER TO THE SECOND, because
// it moved the send. The two-counter shape is unchanged and is the reason the
// move is legible at all: the numbers did not blur, one term crossed between
// them, and `getOperatorTotals` publishes both so the crossing is checkable
// from outside.
//
//   operatorPaidTotal — the operator remainder of every forfeit, lifetime, and
//                       NOTHING else. Zero on a mint that cites no unsold
//                       prime — an ordinary mint now pays the operator nothing.
//   treasuryPaidTotal — every `TREASURY_AMOUNT` send (§4.1's 5% line, D-152)
//                       plus the treasury contract's `FORFEIT_TREASURY_BPS`
//                       share of every §6 point 2 forfeit, lifetime.
//   opsSweptTotal     — every `sweep_ops` return to the ratchet pool, lifetime (D-117).
//                       `getOpsSweep` reports what sweep_ops WOULD pay right
//                       now; this reports what it HAS paid, ever.
//   premiumTreasuryPaidTotal — D-114: the treasury contract's
//                       `PREMIUM_TREASURY_BPS` share of every auction
//                       clearing's premium, lifetime, and NOTHING else. Kept
//                       apart from `treasuryPaidTotal` for the same reason
//                       D-100 point 6 split that one off `operatorPaidTotal`
//                       in the first place — a forfeit and a premium are two
//                       different revenue events, and folding them into one
//                       counter would let a reader sum two things that were
//                       never meant to be read together. Zero until the first
//                       auction lot with a premium clears.
// D-215: seven `coins` (124 bits each at their declared maximum) and three uint64
// are 1060 bits on paper, past the 1023 ceiling, so the bound check is suppressed.
// In fact every `coins` here is a lifetime GRAM total well under 2^64 nanoGRAM, so
// each serializes to at most 68 bits and the cell stays under ~670.
@overflow1023_policy("suppress")
struct OperatorMeters {
    operatorPaidTotal: coins
    treasuryPaidTotal: coins
    opsSweptTotal: coins
    premiumTreasuryPaidTotal: coins
    // §4.1's invite line / §9.1 (D-101). CUMULATIVE, never decremented, and
    // they ride this cell rather than `Meters` because `Meters` is within ~50
    // bits of the 1023-bit ceiling and this cell is already loaded and stored
    // once per mint by the fee-line counters above -- so the two counters cost
    // no extra cell touch on the hot path.
    //
    //   inviteSlotsFunded    -- every slot a minter DECLARED, lifetime.
    //   inviteTransfersSent  -- every invite transfer actually SENT, lifetime (D-202).
    //
    // Their difference is the slots that fell to beta, which is the one number
    // that makes "unspent slots go to the pool" checkable from outside rather
    // than asserted. `getInviteSpend` publishes all of it.
    inviteSlotsFunded: uint64
    inviteTransfersSent: uint64
    //   inviteValuePaid      -- the GRAM those transfers DELIVERED, lifetime (D-215:
    //                           the value is operator-set, so it is summed, not
    //                           multiplied back out). uint64 nanoGRAM, not `coins`:
    //                           this cell has seven `coins` and a 124-bit eighth would
    //                           break its 1023-bit bound; 2^64 nanoGRAM is ~1.8e10 GRAM.
    inviteValuePaid: uint64
    // G81: fee legs too small to send, HELD until they are not. A message worth
    // less than the basechain `flat_gas_price` buys its receiver no compute and
    // lands `skipped (no_gas)`, aborted -- red in every explorer, though the value
    // is credited. So a leg below `RATCHET_HOP_GAS` is added here instead of
    // sent, and the next leg to the same recipient carries it. At most one
    // `RATCHET_HOP_GAS` per recipient waits; it is in `getLiabilityBreakdown`
    // and outside `sweep_ops`, so nothing else can take it.
    //   treasuryHeld -- D-114 premium halves below the threshold. The next
    //                   mint's 5% send carries them, and counts them as premium.
    //   operatorHeld -- D-166 forfeit remainders (the 42%) below the threshold.
    treasuryHeld: coins
    operatorHeld: coins
    // D-196: §6 point 2's forfeit for a cited prime BEYOND the import frontier,
    // summed. Such a factor is credited to its item as if owned (its sold mark
    // may be on a lot block); when the credit bounces off a missing item it
    // forfeits here instead of in a per-prime row, which would be a word the
    // buyer of a far lot chooses — the storage-fill D-196 closes. The money is
    // paid exactly as every forfeit is (58/42, D-166); only its per-prime
    // attribution is lost, and this counter keeps the total checkable. CUMULATIVE.
    forfeitedBeyondWindow: coins
}

// D-100 point 6: THE TWO FEE-LINE DESTINATIONS, and they are no longer the same
// address. Until D-100 the ledger knew one `treasuryAddr` and paid both §4.1's
// 5% line and §6 point 2's unsold-prime forfeits into it, because both were the
// operator's own wallet. D-100 splits the two ideas apart:
//
//   treasuryAddr — the TREASURY CONTRACT (`primes_treasury.tolk`): governed, no
//                  key, no admin, spends only by a passed proposal (D-168
//                  deleted the miner). Since D-152 it takes §4.1's whole 5% line AND
//                  FORFEIT_TREASURY_BPS of each forfeit.
//   operatorAddr — the operator's wallet. Since D-152 its only claim on a mint
//                  is the remainder of each forfeit.
//
// WHY THEY ARE IN A REF AND NOT INLINE. ConfigA already carries three addresses
// (801 bits at the worst-case 267-bit MsgAddress) and a fourth overflows 1023 —
// the same cell pressure that produced ConfigD and, before it, the retired
// ConfigE. The usual answer here is a new top-level config cell, but `Config`
// was at its four-ref ceiling (a/b/d/s; D-202 has since freed `s`), so the fourth address went one level
// down instead. Pairing THESE two in the sub-cell rather than any other two is
// deliberate: they are read together, exactly once, in the split's send phase,
// so the extra cell load costs one load per mint and the two destinations a
// reader has to compare are stored side by side.
//
// Both are fixed at DEPLOY (§4.1 / §8) and no message in
// this contract can change either. Neither needs the one-shot `SetPeers`/
// `SetSinks` bootstrap the sink addresses need: neither the treasury contract
// nor the operator wallet embeds the ledger's address in its own init data, so
// there is no circular dependency to break — the genesis pipeline computes the
// treasury address and passes it into the ledger's init data.
struct FeeDests {
    treasuryAddr: address
    operatorAddr: address
}

struct ConfigA {
    collectionAddr: address
    jettonMasterAddr: address
    feeDests: Cell<FeeDests>
    itemCode: cell
    // D-191 point 1: the minter card's code. A card's address is derived from it,
    // this ledger and the wallet, and that derivation is how a `card_mint` or a
    // `card_recruit_counted` is authenticated. Fixed at deploy, like `itemCode`.
    cardCode: cell
    // D-196: the lot block's code. A block's address is derived from it, this
    // ledger and the block number; that derivation authenticates
    // `lot_block_words` and `lot_block_refused`. Fixed at deploy.
    lotBlockCode: cell
}

// The venue (dedustNativeVault / dedustPool / primesJettonVault) and the venue
// timelock's authority over it moved wholesale to primes_ratchet.tolk — the
// ledger has no DeDust leg and therefore no venue to update. What replaces them
// is the pair of §3.4 sink addresses. Like the market and bounty vault
// (D12), these cannot be fixed at deploy: the ratchet's and registrar's own init
// data embed the ledger's address, so a one-shot `SetSinks` bootstrap is the only
// way to break the circular dependency.
struct ConfigB {
    genesisScriptAddr: address     // one-shot genesis seeding authority
    ratchetAddr: address
    registrarAddr: address
    sinksSet: uint8
}

// D12: peer addresses that cannot be fixed at deploy (circular address
// dependency — the market's and bounty vault's own init data embed the
// ledger's address). One-shot `SetPeers` bootstrap, same pattern as D7/D11.
struct ConfigD {
    // P2.A7: `primes_market.tolk` is the one auction contract, so `launch_open`
    // and `head_update` are one send each and every market-only arm
    // (`mark_off_head`, `mint_won_lot`, `settle_prime_clearing`,
    // `clearing_cleared`) authenticates against this one address.
    marketAddr: address
    bountyVaultAddr: address
    peersSet: uint8
    // D-117 (owner, 2026-09-22) DELETED `opsAddr`: `sweep_ops` no longer pays an
    // operations address — it returns the gas & ops surplus to the ratchet pool.
}

struct Config {
    a: Cell<ConfigA>
    b: Cell<ConfigB>
    d: Cell<ConfigD>
    // D-215: §4.1's invite terms -- how many transfers a mint may fund and what
    // each delivers. Written at deploy and by `set_invite_terms` from
    // `FeeDests.operatorAddr`, nothing else, always inside INVITE_COUNT_CEILING
    // and INVITE_LINE_CAP. Read only by a mint that funds an invite.
    inviteCount: uint7
    inviteValue: coins
    // D-211: the words of §4.1's invite comment — bytes only, no op, no refs, at
    // most INVITE_TEXT_MAX_BYTES. `inviteComment` sends it after op 0 and adds
    // nothing (D-215: no link). Same writers as the terms above.
    inviteText: cell
}

struct Aux {
    meters: Cell<Meters>
    config: Cell<Config>
    // D12/D-45: composites taken off the sequential line by an auction,
    // chunked bitmap (same shape as D1's prime bitmap). D-45 makes the bit
    // PERMANENT — set on mark_off_head (at OPEN, not close) and never
    // cleared — so this is a second, composite-flavoured instance of exactly
    // what `primeBitmap` already is: a record of positions the head-advance
    // walk must skip forever. D-196: it holds words only for blocks below the
    // import frontier; a mark beyond it lives on that block's lot-block child
    // until the import ORs it in. BOUND: ⌈(head + window)/256⌉ words — the
    // frontier moves only as far as `head + LOT_BLOCK_WINDOW_BLOCKS·256`.
    offHeadBitmap: map<uint64, uint256>
    // WS2: Aux hit TVM's four-reference ceiling exactly as Storage did, so the
    // per-wallet dictionaries land in a second nested cell.
    aux2: Cell<Aux2>
    // D-196: blocks imported past the initial window. The frontier — the first
    // block whose marks are NOT here — is `LOT_BLOCK_WINDOW_BLOCKS` plus this.
    lotBlocksImported: uint64
    // D-196: the block an `import_lot_block` round trip is fetching, 0 when none
    // (block 0 is inside the initial window, so it is never imported). While set,
    // a claim on it is refused rather than guessed at.
    importingBlock: uint64
    // D-196: forfeit decided by a bounced `credit_tribute` — a factor beyond the
    // frontier was credited as if owned, and it had no item. Still declared in
    // `tributeOwed`; the next `mint_confirmed` pays it out as §6 point 2's forfeit
    // (58/42) and zeroes this. Almost always 0.
    forfeitHeld: coins
    // D-198: the first block whose unsold rows are still HERE. Every block below
    // it has had its unsold primes' bookmarks and forfeit counters moved to its
    // lot block by `flush_unsold`, so `Meters.unsoldPrimes`/`forfeited` hold rows
    // only for blocks in [unsoldFlushed, head]. The walk stops LOT_BLOCK_WINDOW_
    // BLOCKS past it (`walkLimitN`), so that span — and the rows — is bounded no
    // matter how many primes go unsold.
    unsoldFlushed: uint64
}

// D-196: the first block whose marks live on a lot-block child, not here. A
// BLOCK is the bitmaps' own chunk — `bitmapChunkAndBit(n)`, index `n - 2` — so an
// imported word lands on its chunk as it is, with no re-alignment.
fun Aux.lotFrontier(self): int {
    return LOT_BLOCK_WINDOW_BLOCKS + self.lotBlocksImported;
}

// D-196: the smallest n in block `block` (the inverse of `bitmapChunkAndBit`).
fun lotBlockFirstN(block: int): int {
    return block * 256 + 2;
}

// Where the head-advance walk must stop: at the import frontier (D-196), and
// D-198's mirror of it — LOT_BLOCK_WINDOW_BLOCKS past the oldest block whose
// unsold rows have not been flushed. A late flush stalls the head exactly as a
// late import does (head mints refund until `flush_unsold` and `advance_head`).
fun Aux.walkLimitN(self): int {
    val importLimit = lotBlockFirstN(self.lotFrontier());
    val flushLimit = lotBlockFirstN(self.unsoldFlushed + LOT_BLOCK_WINDOW_BLOCKS);
    return importLimit < flushLimit ? importLimit : flushLimit;
}

struct Aux2 {
    // D-188 point 4: `entry[p]` lives on the prime's ITEM (`divEntry`), beside
    // `owed`, as §3.2 says. The one case the item cannot be told in time is a
    // prime SOLD AHEAD of the head: its item exists before the walk stamps it,
    // and a send from the walk would put a hop on the mint path. So the walk
    // parks that stamp here and the first `claim_dividend` for it hands it over
    // (`CreditDividend.base`) and deletes the row. The other inflows are
    // refusals: a flushed prime's stamp whose item was not populated yet when
    // `lot_block_bookmark` forwarded it, and a sold prime in a refused
    // `lot_block_bookmarks` batch. BOUND (LOW-3): nothing here waits on the
    // owner — `claim_dividend` is permissionless and the keeper walks this map
    // (`getNextSoldAhead`) and claims every row, so a row lives one keeper cycle,
    // and each one was a paid lot.
    soldAheadEntry: map<uint256, coins>
    // D-191 point 1 (GAUNTLET V26.4) DELETED `minterState`, and `EraSeason`'s
    // per-recruiter map with it: a wallet's rebate standing and its era tally
    // live on its own minter card (`primes_minter_card.tolk`), so nothing on
    // this contract grows with the number of wallets.
    // D-117: the retry lane for a bounced `MintItem`, keyed by n, holding the
    // ORIGINAL message body (held split included). `retry_item` re-sends it; the
    // held split's GRAM is declared in `Meters.unroutedHeld` while it waits here.
    // Empty on every mint that deploys its item, so it costs one bit. BOUND: one
    // row per item deploy the collection REFUSED, deleted by the permissionless
    // `retry_item`; bodies are rebuilt from checked keys (D-188 point 1).
    unroutedItems: map<uint256, cell>
    // V32: a PRIME whose `mint_item` has left this ledger and whose item has not
    // yet sent `mint_confirmed` (nor the mint come back refused). Until then
    // "no item" means "item on its way", not "unsold", and a bounced
    // `credit_tribute` for it goes to the retry lane instead of the forfeit.
    // The receipt comes from the ITEM (V28): TON orders messages only per
    // sender→receiver pair, so only the item's own receipt is guaranteed to land
    // AFTER a credit it bounced before it existed.
    // BOUND: one row per prime deploy in flight — deleted by the receipt or the
    // bounce, whichever arrives.
    deployingPrimes: map<uint256, bool>
}

struct Storage {
    head: uint256                 // next number to mint; starts at 2
    // D1: chunked bitmap, 256 bits/chunk. BOUND: ⌈head/256⌉ words, and the head
    // moves only by paid mints. About two cells a word (leaf plus fork) puts the
    // cap near head ≈ 8M — the ceiling D-188 point 3 names for the vault's
    // same-shaped `paidSpecials` bitmap. D-198: each leaf carries TWO words, the
    // prime marks and the UNSOLD bits (still one cell: 512 bits), so "is p
    // unsold" is answered here even after p's bookmark row has been flushed to
    // its lot block.
    primeBitmap: map<uint64, PrimeWords>
    // D-45 GAS FIX: 1 the first time `mark_off_head` is ever accepted, never
    // cleared. A single bit on `Storage` itself — no cell load, unlike
    // `Aux.offHeadBitmap` — so `executeMint`'s advance-head walk can check
    // "has anything ever been auctioned" for free before it ever pays for the
    // real dict lookup. Skipping that lookup when this is 0 is what keeps the
    // walk's cost identical to pre-D-45 for every mint before the first
    // auction ever opens — measured at +29% on the tightest row in the gas &
    // ops reconciliation (`GasRegression.spec.ts`'s composite-omega3 row)
    // before this fix, 0% after.
    anyOffHead: uint1
    // D-189: 1 while the head-advance walk is unfinished. The walk stops once
    // this transaction has burnt WALK_GAS_STOP, so a long run of auctioned
    // composites cannot push one mint past the 1M-gas transaction cap and
    // freeze the head for good. While it is 1, `head` sits on the first
    // position NOT yet walked (a prime or an auctioned composite, never a
    // mintable number), head mints refund as a lost race, and the
    // permissionless `advance_head` walks on.
    walkPending: uint1
    T: coins
    // D-26 (signed 2026-08-19, §5): the THIRD TERM of the backing identity.
    //
    // §5 states `T = seeded + swapped + pending`. `swapped` and `pending` live
    // on the ratchet; `seeded` is the founder capital CONCEPT §6 point 3 credits
    // straight into `T` at genesis. That GRAM is real and it backs `S` — it sits
    // in the DeDust LP — but it never passes through the ratchet's `pending`, so
    // a two-term reading of the identity reports a permanent, false solvency gap
    // (the live testnet reported exactly 1.000000000 GRAM of it).
    //
    // Written at genesis by `handleGenesisSeed` and again by every
    // `DonateFloor` (D-91 point 4 — the donated GRAM is seeded backing by the
    // same definition: it goes to the LP, not through the ratchet's
    // `pending`). D-91 point 5 retires the earlier claim that this field is
    // immutable for the life of the deployment; what is one-shot is GENESIS,
    // not `seedT`. Keeping it as its own field rather than inferring it is the
    // whole fix: the reader must be able to close the identity from get-methods
    // alone, and D-26 explicitly forbids closing it on the reader's side.
    seedT: coins
    S: coins
    // §3.2: the flat prime-dividend accumulator. `executeMint` adds
    // `TRIBUTE_FLAT_AMOUNT / π(n)` per mint (the 20% flat share of the tribute
    // line); each prime's item claims `divAcc − entry[p]` against the stamp
    // it took when the head crossed it. Never decremented.
    divAcc: coins
    // §3.2 / §9.1: π(n) — the count of minted (marked) primes, maintained so
    // the flat dividend's `/ π(n)` divisor and the dashboard's prime counter
    // are both a get-call, not an off-chain recount of the bitmap.
    primesCount: uint32
    lastMintTime: uint64
    // BOUND: one row per `credit_tribute` that BOUNCED, deleted by the
    // permissionless `retry_credit`; its GRAM is declared in `unroutedHeld`.
    unroutedCredits: map<uint64, UnroutedCredit>
    // D-52: bounced `JettonMint` emissions, keyed by `addrKey(to)` and summed
    // per recipient — a second bounce for the same wallet adds to the entry
    // rather than replacing it. The recipient address is NOT stored: `retry_mint`
    // carries it and the key is recomputed from it, so a caller cannot name a
    // wallet that is not the one the bounce recorded. BOUND: one row per wallet
    // whose rebate mint BOUNCED at the jetton master, deleted by `retry_mint`.
    unmintedMints: map<uint256, coins>
    aux: Cell<Aux>                 // meters + config, see Aux/Config above
}

// Convenience accessors, so call sites read `loadConfigA(storage)` etc.
// instead of chaining `.aux.load().config.load().a.load()` everywhere.
fun loadMeters(storage: Storage): Meters {
    return storage.aux.load().meters.load();
}

fun loadConfigA(storage: Storage): ConfigA {
    return storage.aux.load().config.load().a.load();
}

fun loadConfigB(storage: Storage): ConfigB {
    return storage.aux.load().config.load().b.load();
}

fun loadConfigD(storage: Storage): ConfigD {
    return storage.aux.load().config.load().d.load();
}

fun loadInviteConfig(storage: Storage): Config {
    return storage.aux.load().config.load();
}

fun saveConfigD(mutate storage: Storage, d: ConfigD) {
    var aux = storage.aux.load();
    var config = aux.config.load();
    config.d = d.toCell();
    aux.config = config.toCell();
    storage.aux = aux.toCell();
}

// D12/D-45: off-sequence composite bitmap accessors (chunked, same shape as
// D1). Set-only: D-45 never clears a bit.
// `isOffHeadIn` takes the bitmap directly rather than `storage`, so a caller that already
// holds `storage.aux.load()` (executeMint's head-advance walk, chiefly) reads
// `offHeadBitmap` from ITS copy instead of paying for a second `aux` cell
// parse per position checked. `isOffHead` below is the storage-holding
// convenience wrapper for every other caller.
fun isOffHeadIn(bitmap: map<uint64, uint256>, n: int): bool {
    if (n < 2) { return false; }
    val (chunk, bit) = bitmapChunkAndBit(n);
    val look = bitmap.get(chunk);
    if (!look.isFound) { return false; }
    return (((look.loadValue()) >> bit) & 1) == 1;
}

fun isOffHead(storage: Storage, n: int): bool {
    return isOffHeadIn(storage.aux.load().offHeadBitmap, n);
}

fun loadAux2(storage: Storage): Aux2 {
    return storage.aux.load().aux2.load();
}

fun saveAux2(mutate storage: Storage, aux2: Aux2) {
    var aux = storage.aux.load();
    aux.aux2 = aux2.toCell();
    storage.aux = aux.toCell();
}

// Same key derivation as the registrar's — the two dictionaries mirror each
// other (ledger authoritative for economics, registrar for naming/FE).
fun addrKey(a: address): int {
    return beginCell().storeAddress(a).endCell().hash();
}

fun saveMeters(mutate storage: Storage, meters: Meters) {
    var aux = storage.aux.load();
    aux.meters = meters.toCell();
    storage.aux = aux.toCell();
}

fun saveConfigB(mutate storage: Storage, b: ConfigB) {
    var aux = storage.aux.load();
    var config = aux.config.load();
    config.b = b.toCell();
    aux.config = config.toCell();
    storage.aux = aux.toCell();
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// Must match primes_item.tolk's Storage layout exactly — documented duplication,
// see primes_item.tolk / primes_collection.tolk header comments.
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
    // D-188 point 6 — a prime's naming right, mirrored from primes_item.tolk
    // (`Cell<ItemNaming>?` there; same bits); null in the default.
    naming: cell?
}

struct ItemStorage {
    n: uint256
    collectionAddr: address
    ledgerAddr: address
    m: Cell<ItemMutable>
}

// The address-determining `ItemMutable` is a function of `configA` alone, so a
// caller that resolves several item addresses in one transaction (the tribute
// fan-out below is up to omega(n) of them) builds it ONCE here and passes it to
// `itemAddressWith`. `itemAddress` keeps the single-shot signature.
fun itemDefaultMutable(configA: ConfigA): Cell<ItemMutable> {
    return (ItemMutable {
        populated: 0,
        owner: configA.collectionAddr,
        isPrime: 0,
        factorization: beginCell().endCell(),
        rarityFlags: 0,
        owed: 0,
        // 0, always: `itemAddress(n)` must stay a function of `n` alone, so
        // nothing the mint learns may appear in the address-determining data.
        // §9.8's date arrives with `Populate`.
        mintedDay: 0,
        tributeTotal: 0,
        referralPaidTotal: 0,
        divEntry: 0,
        forfeitedTotal: 0,
        naming: null,
    }).toCell();
}

fun itemAddressWith(configA: ConfigA, defaultMutable: Cell<ItemMutable>, n: int): address {
    val initData = (ItemStorage {
        n: n,
        collectionAddr: configA.collectionAddr,
        ledgerAddr: contract.getAddress(),
        m: defaultMutable,
    }).toCell();
    return (AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState { code: configA.itemCode, data: initData },
    }).calculateAddress();
}

fun itemAddress(configA: ConfigA, n: int): address {
    return itemAddressWith(configA, itemDefaultMutable(configA), n);
}

// ---------------------------------------------------------------------------
// Prime bitmap (D1)
// ---------------------------------------------------------------------------

// The chunk key is uint64, not uint32: `n / 256` for n up to AUCTIONABLE_MAX
// (~4.29e13) is ~1.7e11, past 2^32. With a uint32 key every bitmap WRITE for
// n >= 2^40 (~1.1e12) threw exit 5 — `mark_off_head` refused every lot there and
// a prime sold ahead there could not be marked (D-189, found with the walk fix).
fun bitmapChunkAndBit(n: int): (int, int) {
    val idx = n - 2;
    return (idx / 256, idx % 256);
}

// D-198: one `primeBitmap` leaf. `marks` is D1's word; `unsold` has n's bit set
// from the moment the walk crosses an unsold prime until it sells. Unsold is the
// ledger's synchronous answer wherever it used to read an `unsoldPrimes` row.
struct PrimeWords {
    marks: uint256
    unsold: uint256
}

const NO_PRIME_WORDS = PrimeWords { marks: 0, unsold: 0 };

fun primeWordsAt(storage: Storage, chunk: int): PrimeWords {
    val look = storage.primeBitmap.get(chunk);
    return look.isFound ? look.loadValue() : NO_PRIME_WORDS;
}

// (marked, unsold) in ONE lookup — the mint path asks both about a factor.
fun primeBits(storage: Storage, n: int): (bool, bool) {
    if (n < 2) { return (false, false); }
    val (chunk, bit) = bitmapChunkAndBit(n);
    val w = primeWordsAt(storage, chunk);
    return (((w.marks >> bit) & 1) == 1, ((w.unsold >> bit) & 1) == 1);
}

fun isMarkedPrime(storage: Storage, n: int): bool {
    val (marked, _unsold) = primeBits(storage, n);
    return marked;
}

fun isUnsoldPrime(storage: Storage, n: int): bool {
    val (_marked, unsold) = primeBits(storage, n);
    return unsold;
}

fun markPrime(mutate storage: Storage, n: int) {
    val (chunk, bit) = bitmapChunkAndBit(n);
    var w = primeWordsAt(storage, chunk);
    w.marks |= (1 << bit);
    storage.primeBitmap.set(chunk, w);
}

// The walk crossing a prime nobody owns: marked, and unsold until it sells.
fun markUnsoldPrime(mutate storage: Storage, n: int) {
    val (chunk, bit) = bitmapChunkAndBit(n);
    var w = primeWordsAt(storage, chunk);
    w.marks |= (1 << bit);
    w.unsold |= (1 << bit);
    storage.primeBitmap.set(chunk, w);
}

// The sale: the prime has an owner from this transaction on.
fun clearUnsold(mutate storage: Storage, n: int) {
    val (chunk, bit) = bitmapChunkAndBit(n);
    var w = primeWordsAt(storage, chunk);
    w.unsold &= ~(1 << bit);
    storage.primeBitmap.set(chunk, w);
}

// ---------------------------------------------------------------------------
// Miller-Rabin (from spike_mr.tolk, unchanged algorithm)
// ---------------------------------------------------------------------------

// ===== PRIME MR BLOCK BEGIN — generated by tools/sync-score-block.mjs, do not edit here =====
// ============================================================================
// DETERMINISTIC MILLER-RABIN — the shared copy (GAUNTLET.md B29).
//
// CONCEPT.md §3.1's primality claim is reached from an ordinary player
// transaction on TWO contracts: the ledger (a prime mint) and the market (an
// off-head prime lot settling). (The generators collection was a third until
// D-165, and the registrar until D-202 deleted the constellation builds it
// classified.) Neither may call the other synchronously to agree, so the
// algorithm is duplicated on purpose -- exactly like D-99's score block, and for
// the same reason.
//
// What was NOT on purpose is that the copies had drifted. This file is
// written into both between the PRIME MR markers by
// tools/sync-score-block.mjs, and `pnpm check:score-block` (a leg of
// gate:contracts:drift) fails if any copy no longer matches.
//
// 13 deterministic bases {2..41}, exact for n < 3.317e24 (§3.1). Tolk's native
// 257-bit integers, no split precision.
// ============================================================================
fun modpow(base: int, exp: int, mod: int): int {
    var result = 1;
    var b = base % mod;
    var e = exp;
    while (e > 0) {
        if (e % 2 == 1) { result = (result * b) % mod; }
        e = e / 2;
        b = (b * b) % mod;
    }
    return result;
}

fun millerTest(a: int, d: int, r: int, n: int): bool {
    var x = modpow(a, d, n);
    if (x == 1 || x == n - 1) { return true; }
    var i = 0;
    while (i < r - 1) {
        x = (x * x) % n;
        if (x == n - 1) { return true; }
        i += 1;
    }
    return false;
}

fun isPrimeMR(n: int): bool {
    if (n < 2) { return false; }
    if (n == 2 || n == 3) { return true; }
    if (n % 2 == 0) { return false; }
    var d = n - 1;
    var r = 0;
    while (d % 2 == 0) { d = d / 2; r += 1; }
    // The witness set is unchanged: the first 13 primes, deterministic for every
    // n < 3.3e24. It used to live in `mrBaseAt`, a 13-arm if-chain walked once
    // per base — 13 chain walks per call, ~7.4k gas on the omega=3 mint path for
    // nothing but picking a constant. A tuple literal is built once and indexed
    // in O(1), and it is the same idiom `log10Fp` already uses for its log table.
    val bases = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41];
    var i = 0;
    while (i < 13) {
        val a = bases.get(i);
        // The bases ascend, so the first `a >= n` means every remaining base is
        // >= n too. The old loop kept spinning and skipping them via `if (a < n)`;
        // returning here tests exactly the same set of witnesses.
        if (a >= n) { return true; }
        if (!millerTest(a, d, r, n)) { return false; }
        i += 1;
        // GAUNTLET V34: the first seven bases {2..17} are already exact below
        // ψ₇ = 341,550,071,728,321 (Jaeschke 1993). Every argument the market
        // and the ledger's auction path reach is below it (the largest is
        // ~2n+1 ≈ 8.6e13 at AUCTIONABLE_MAX), and the six bases skipped are what
        // pushed a cap prime's open past config 21's 1,000,000-gas ceiling.
        // Above ψ₇ all 13 still run.
        if (i == 7 && n < 341550071728321) { return true; }
    }
    return true;
}
// ===== PRIME MR BLOCK END =====

// ===== D-99 SCORE BLOCK BEGIN — generated by tools/sync-score-block.mjs, do not edit here =====
// ---------------------------------------------------------------------------
// D-99 — ONE ADDITIVE SCORE PRICES EVERY NUMBER.
//
// Spec: PRICING_MODEL_PLAN.md §1.1/§1.3, CONCEPT.md §9.6. `scoreOf(n)` returns
// `(score, flags)` — the clamped sum of the weights of every category `n`
// belongs to, and the bitmask of those categories.
//
// THIS BLOCK IS DUPLICATED BYTE-FOR-BYTE into `primes_market.tolk` (which
// prices a lot off `score`) and `primes_ledger.tolk` (which pays the bounty
// vault's per-point rebate off it), for the reason the tier block it replaces
// was duplicated: a settled lot's price and the ledger's rebate must agree
// without either contract calling the other synchronously. The canonical copy
// is `contracts/contracts/score_block.tolk.inc`; `node tools/sync-score-block.mjs`
// writes it into both files between the BEGIN/END markers and `--check` fails
// if either has drifted. `SpecialNumbers.spec.ts` additionally asserts the two
// deployed copies answer identically over a sweep of `n`.
//
// WHAT REPLACES WHAT. `desirabilityScore` (a 0..120 four-layer score in which
// primality weighed 0), `specialNumberTier` / `SPECIAL_TIER_*`,
// `specialPriceMaxOf` / `specialPriceMinOf`, `PRIME_P0_MIN`, `isCuratedYear`
// and `isCuratedNumber` are all deleted. `isCuratedConstantOrTaxicab` survives
// as POSITION bit 32. D-96's `DIRICHLET_*` constants survive as the PRIME
// REBATE FAMILY only (§1.5) — they score no points, set no bit and lift no
// price.
//
// THE FACTOR CATEGORIES (bits 33..38 from phase 3, N6's bit 39, D-162's 48..51).
// Five of the six proposed categories are computable from the factor list a
// composite ALREADY submits at `open_lot` and at head mint; the sixth
// (Ruth-Aaron) needs the neighbour's factorization and is out of scope, as §4
// itself says. They exist for owner answer 6 — "a number with no category at
// all should be rare" — and they are the only part of the score `n` alone
// cannot decide, which is why `scoreOfFrom(n, factors)` is a SECOND entry
// point and not a change to `scoreOf(n)`. N6 appended a seventh at bit 39,
// `carmichael`: Korselt's criterion needs every prime factor, so it belongs to
// this group in everything but its number.
//
// `scoreOf(n)` IS STILL EXACT ABOUT WHAT IT KNOWS AND IS A LOWER BOUND ON THE
// PRICE. It returns the from-`n` score with bits 33..39 and 48..51 clear. That is not a
// rounding error to be papered over in the UI: a caller holding the
// factorization gets a strictly larger score from `scoreOfFrom`, and the two
// answers differ by construction rather than by drift. `getScoreBreakdown` and
// `getLotPrice` take the factors as an argument so a reader can obtain either
// one deliberately.
//
// ABUNDANT AND DEFICIENT PARTITION EVERY NON-PERFECT NUMBER, so this pair adds
// one point to essentially every composite priced with its factors — a
// near-constant offset, not a discriminator. That is deliberate under answer 6
// (it is the "density filler" §4 names itself), and it is stated here because
// a reader comparing a factored price against an unfactored one will see the
// point and should see why. Perfect numbers earn neither: they already carry
// `BIT_PERFECT` at 40.
//
// THE CAP IS THE CEILING. `SCORE_MAX = 87` because
// `MINT_PRICE · 2^(87/10) = 415.87 GRAM` — the highest price this game can ask
// for anything, and it lands just under owner answer 9's 420 GRAM ceiling. (The
// plan's §1.1 says 420.4; that is 2^8.716, and the arithmetic is wrong. The
// conclusion is not: 87 is the largest clamp whose ladder stays under 420, and
// 88 would reach 445.7.) There is no other ceiling anywhere — the same
// one-clamp-over-the-sum discipline §5 gives `K_CEIL`.
// ---------------------------------------------------------------------------

const SCORE_MAX: int = 87;

// ---- LEN: continuous, no bit, no satellite (§8.3) ----
const LEN_REF: int = 9;               // scarcity decays to zero at 9 digits
const LEN_W: int = 2;                 // points per digit under LEN_REF

// ---- category bits. Mirrored in `shared/opcodes.ts` SCORE_BITS and, through
// it, in the webapp's fixed satellite angles (§8.2: angle = 7.5° · bit), so a
// bit number is a PERMANENT identifier — never renumber one, only append. ----
const BIT_REPDIGIT: int = 0;
const BIT_POW10: int = 1;
const BIT_PALINDROME: int = 2;
const BIT_RUN: int = 3;
const BIT_ABAB: int = 4;
const BIT_TRAILING_ZEROS: int = 5;
const BIT_YYYYMMDD: int = 6;
const BIT_DMY8: int = 7;
const BIT_YEAR: int = 8;
const BIT_YYMMDD: int = 9;
const BIT_MMDD: int = 10;
const BIT_MERSENNE: int = 11;
const BIT_FERMAT: int = 12;
const BIT_PERFECT: int = 13;
const BIT_PRIMORIAL: int = 14;
const BIT_FACTORIAL: int = 15;
const BIT_PRIME: int = 16;
const BIT_POW2: int = 17;
const BIT_FIBONACCI: int = 18;
const BIT_CUBE: int = 19;
const BIT_TWIN: int = 20;
const BIT_SOPHIE_GERMAIN: int = 21;
const BIT_SAFE_PRIME: int = 22;
const BIT_EMIRP: int = 23;
const BIT_SQUARE: int = 24;
const BIT_TRIANGULAR: int = 25;
const BIT_HARSHAD: int = 26;
const BIT_HAPPY: int = 27;
const BIT_DIGITSUM_PRIME: int = 28;
const BIT_ICONIC: int = 29;
const BIT_LISTED: int = 30;
const BIT_LANDMARK: int = 31;
const BIT_CONSTANT: int = 32;

// ---- FACTOR bits (§4). Set only by `scoreOfFrom`, never by `scoreOf`. ----
const BIT_SEMIPRIME: int = 33;
const BIT_PRIME_POWER: int = 34;
const BIT_SQUAREFREE: int = 35;
const BIT_SMOOTH: int = 36;
const BIT_ABUNDANT: int = 37;
const BIT_DEFICIENT: int = 38;

// ---- N6's nine, filling 39..47 — the last nine of the original 48-slot
// ring (D-162 below re-pitched it to 54). Composite-first by design: `shared/prime_tags.json` already names 78
// prime families, and the core loop mints COMPOSITES, which had no taxonomy of
// their own. Only `carmichael` needs the factor list; the other eight are
// decided from `n` alone and therefore run on the mint path. ----
const BIT_CARMICHAEL: int = 39;
const BIT_PANDIGITAL: int = 40;
const BIT_NARCISSISTIC: int = 41;
const BIT_AUTOMORPHIC: int = 42;
const BIT_SQUARE_TRIANGULAR: int = 43;
const BIT_KAPREKAR: int = 44;
const BIT_HIGHLY_COMPOSITE: int = 45;
const BIT_KEITH: int = 46;
const BIT_CATALAN: int = 47;

// ---- D-162's six, 48..53 (numbersaplenty.com's families, picked for being
// cheap on chain). The ring re-pitched from 48 slots at 7.5° to 54 at 6.67°,
// so every angle moved once — pre-launch, nothing minted wears one yet.
// SMITH, SPHENIC, POWERFUL and ACHILLES need the factor list, which puts them
// with 33..39: set only by `scoreOfFrom`, so they cost the head mint nothing.
// LUCAS and PRONIC are decided from `n` and ride square roots the from-`n`
// walk already takes (see `fibLucasOf` and the SQUARE line). ----
const BIT_SMITH: int = 48;
const BIT_SPHENIC: int = 49;
const BIT_POWERFUL: int = 50;
const BIT_ACHILLES: int = 51;
const BIT_LUCAS: int = 52;
const BIT_PRONIC: int = 53;

// ---- the weight table (§1.3). OWNER-DECLARED, not sim-derived: it is the
// game designer's demand guess, signed as D-99, and it lives in
// `shared/params.json` under `_provenance: "owner-declared (D-99)"` exactly
// as the tier prices it replaces did. 10 points = 2× price. ----
const W_REPDIGIT: int = 40;
const W_POW10: int = 40;
const W_PALINDROME: int = 25;
const W_RUN: int = 25;
const W_ABAB: int = 12;
const W_TRAILING_ZEROS: int = 8;      // PER zero, capped at TZ_CAP zeros
const TZ_CAP: int = 3;
const W_YYYYMMDD: int = 30;
const W_DMY8: int = 25;
const W_YEAR: int = 25;
const W_YYMMDD: int = 12;
const W_MMDD: int = 5;
const W_MERSENNE: int = 40;
const W_FERMAT: int = 40;
const W_PERFECT: int = 40;
const W_PRIMORIAL: int = 30;
const W_FACTORIAL: int = 25;
const W_PRIME: int = 15;
const W_POW2: int = 15;
const W_FIBONACCI: int = 15;
const W_CUBE: int = 8;
const W_TWIN: int = 6;
const W_SOPHIE_GERMAIN: int = 6;
const W_SAFE_PRIME: int = 6;
const W_EMIRP: int = 5;
const W_SQUARE: int = 4;
const W_TRIANGULAR: int = 2;
const W_HARSHAD: int = 2;
const W_HAPPY: int = 2;
const W_DIGITSUM_PRIME: int = 2;
const W_ICONIC: int = 30;
const W_LISTED: int = 20;
const W_LANDMARK: int = 30;
const W_CONSTANT: int = 20;

// ---- FACTOR weights (§4's table, owner-declared with the rest of §1.3) ----
const W_SEMIPRIME: int = 3;
const W_PRIME_POWER: int = 5;
const W_SQUAREFREE: int = 2;
const W_SMOOTH: int = 3;
const W_ABUNDANT: int = 1;
const W_DEFICIENT: int = 1;

// ---- N6 weights (owner-declared with the rest of §1.3, D-99's scale:
// 10 points = 2x price) ----
const W_CARMICHAEL: int = 30;
const W_PANDIGITAL: int = 40;
const W_NARCISSISTIC: int = 30;
const W_AUTOMORPHIC: int = 25;
const W_SQUARE_TRIANGULAR: int = 25;
const W_KAPREKAR: int = 20;
const W_HIGHLY_COMPOSITE: int = 20;
const W_KEITH: int = 20;
const W_CATALAN: int = 15;

// ---- D-162 weights (owner-declared, same scale). Density sets them: LUCAS
// is as rare as Fibonacci; PRONIC (~√n members) sits between triangular and
// square; POWERFUL (~2.2√n) with square; ACHILLES (powerful minus the perfect
// powers) above it; SMITH (~4% of composites) with harshad's neighbours;
// SPHENIC (~15%) with squarefree. ----
const W_SMITH: int = 3;
const W_SPHENIC: int = 2;
const W_POWERFUL: int = 4;
const W_ACHILLES: int = 6;
const W_LUCAS: int = 15;
const W_PRONIC: int = 3;

// "smooth" is 7-smooth: every prime factor <= 7. §4 fixes the bound at 7 and
// it is not a tuning knob — 7-smooth is the standard humming-distance the
// table means, and moving it would change which numbers are special without
// changing anything a reader can check.
const SMOOTH_BOUND: int = 7;

const YEAR_LO: int = 1900;
const YEAR_HI: int = 2100;

// D-96's two constants, and the only two the family has. Both are OWNER-
// DECLARED. D-99 NARROWS D-96: the `dirichlet_primes` class is now the PRIME
// REBATE FAMILY and nothing else — it scores no points, sets no bit, lifts no
// price and wears no badge. It survives for the reason D-96 gave (a rebate
// that keeps paying along the whole line, never exhausted, 1 in 100 primes at
// every depth by Dirichlet's theorem) and for that reason only. §1.5.
const DIRICHLET_MIN_N: int = 100000;
const DIRICHLET_MOD: int = 101;

// ---------------------------------------------------------------------------
// Integer roots. Tolk has no native sqrt/cbrt, and the FORM group needs both
// exactly (a "nearly square" is not a square). Newton, seeded from a
// bit-length halving so the iteration count is bounded by construction: the
// largest argument any caller passes is `5n² + 4` at n = AUCTIONABLE_MAX,
// ≈ 9.2·10²⁷, which converges in under 60 steps from the seed below.
// ---------------------------------------------------------------------------

fun isPerfectSquare(x: int): bool {
    if (x < 0) { return false; }
    val r = isqrt(x);
    return r * r == x;
}

fun isPerfectCube(x: int): bool {
    if (x < 1) { return false; }
    if (x < 8) { return x == 1; }
    var r = 1;
    var t = x;
    while (t > 0) { t >>= 3; r <<= 1; }
    var i = 0;
    var settled = false;
    while (i < 200 && !settled) {
        val rr = r * r;
        val nr = (2 * r + x / rr) / 3;
        if (nr >= r) { settled = true; } else { r = nr; }
        i += 1;
    }
    // Newton lands on floor(cbrt) or one either side; check the neighbourhood.
    var c = r - 1;
    while (c <= r + 1) {
        if (c > 0 && c * c * c == x) { return true; }
        c += 1;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Calendar validity (§1.3, owner answer 11). REAL Gregorian validity — month
// 1..12, day 1..days-in-month, the 4/100/400 leap rule — because a birthday
// that never happened must not be priced as one.
// ---------------------------------------------------------------------------

fun daysInMonth(y: int, m: int): int {
    if (m == 1 || m == 3 || m == 5 || m == 7 || m == 8 || m == 10 || m == 12) { return 31; }
    if (m == 4 || m == 6 || m == 9 || m == 11) { return 30; }
    if (m != 2) { return 0; }
    val leap = (y % 4 == 0) && ((y % 100 != 0) || (y % 400 == 0));
    return leap ? 29 : 28;
}

fun isValidDate(y: int, m: int, dd: int): bool {
    if (m < 1 || m > 12) { return false; }
    if (dd < 1) { return false; }
    return dd <= daysInMonth(y, m);
}

// ---------------------------------------------------------------------------
// FORM predicates. Everything here is O(digits) or a table; the only
// Miller-Rabin calls are the five inside the `isPrime` branch of `scoreOf`, so
// a composite pays for exactly one MR pass (§2).
// ---------------------------------------------------------------------------

// 2^p − 1 form. Combined with primality by the caller — an unprimed 2^p − 1 is
// not a Mersenne PRIME and scores nothing.
fun isMersenneForm(n: int): bool {
    if (n < 3) { return false; }
    val np1 = n + 1;
    return (np1 & (np1 - 1)) == 0;
}

// The five known Fermat primes. F5 = 4294967297 is composite (641 · 6700417),
// and no larger Fermat number is known to be prime, so this list is the
// complete one — a table, not a truncation.
fun isFermatPrime(n: int): bool {
    return n == 3 || n == 5 || n == 17 || n == 257 || n == 65537;
}

// The six perfect numbers below AUCTIONABLE_MAX. The seventh, 137438691328,
// is 1.37·10¹¹ — inside the cap, so it is here too; the eighth is 2.3·10¹⁸ and
// is not.
fun isPerfectNumber(n: int): bool {
    return n == 6 || n == 28 || n == 496 || n == 8128
        || n == 33550336 || n == 8589869056 || n == 137438691328;
}

// §7 era boundaries — the eight primorials the game is built around
// (`webapp/src/.../primorial.ts` is canonical for the era list: eight, never
// six). A primorial is on NEITHER auction lane at any price and mints only at
// the head; it still SCORES, because the score is also what the ledger's
// rebate and the orb's satellites read.
fun isPrimorial(n: int): bool {
    return n == 6 || n == 30 || n == 210 || n == 2310 || n == 30030
        || n == 510510 || n == 9699690 || n == 223092870;
}

// k! for k = 1..16. 17! = 3.56·10¹⁴ is above AUCTIONABLE_MAX, so the list is
// complete for every number this game can sell.
fun isFactorialN(n: int): bool {
    return n == 1 || n == 2 || n == 6 || n == 24 || n == 120 || n == 720
        || n == 5040 || n == 40320 || n == 362880 || n == 3628800
        || n == 39916800 || n == 479001600 || n == 6227020800
        || n == 87178291200 || n == 1307674368000 || n == 20922789888000;
}

// FIBONACCI AND LUCAS FROM ONE SQUARE ROOT. n is Fibonacci iff 5n² ± 4 is a
// square, and Lucas iff 5n² ± 20 is. For n >= 5 every one of those four roots
// lies within one of s = isqrt(5n²) (the ±20 offset moves √(5n²) by at most
// 20 / (2·√125) < 0.9), so three squarings decide both families — where the
// Fibonacci test alone used to take two Newton roots. n <= 4 is answered
// directly: 1, 2, 3 are Fibonacci, and 1, 2, 3, 4 are Lucas (L₀ = 2).
// `sim/tests/test_desirability.py` checks the window against the four-root
// definition.
//
// A 65-entry TABLE was tried for Fibonacci and is MEASURABLY WORSE: 65
// comparisons against 257-bit literals cost more in TVM than the roots, and
// pushed the primorial mint from 0.0998 to 0.1000 GRAM, over §4.1's gas & ops
// line.
fun fibLucasOf(n: int): (bool, bool) {
    if (n < 1) { return (false, false); }
    if (n <= 4) { return (n <= 3, true); }
    val f = 5 * n * n;
    val s = isqrt(f);
    var fib = false;
    var luc = false;
    var r = s - 1;
    while (r <= s + 1) {
        val gap = r * r - f;
        if (gap == 4 || gap == -4) { fib = true; }
        if (gap == 20 || gap == -20) { luc = true; }
        r += 1;
    }
    return (fib, luc);
}
// Happy: iterate the sum of the squares of the digits. Base 10 has exactly one
// non-trivial cycle and 4 is on it, so reaching 4 is a proof of unhappiness —
// the loop is bounded without a visited set. The bound below is a belt on top
// of that.
fun isHappyN(n: int): bool {
    if (n < 1) { return false; }
    var x = n;
    var i = 0;
    while (i < 100) {
        if (x == 1) { return true; }
        if (x == 4) { return false; }
        var s = 0;
        var t = x;
        while (t > 0) {
            val dg = t % 10;
            s += dg * dg;
            t /= 10;
        }
        x = s;
        i += 1;
    }
    return false;
}

// ---------------------------------------------------------------------------
// CULTURE (§3.1) — the two owner-signed lists. The qualifying rule, for any
// future addition: a reader who is not a mathematician recognises the number
// WITHOUT explanation. Anything needing a footnote is not culture, it is
// FORM or POSITION.
// ---------------------------------------------------------------------------

fun isIconicNumber(n: int): bool {
    return n == 2 || n == 42 || n == 69 || n == 420 || n == 666
        || n == 777 || n == 1337 || n == 1729 || n == 8008;
}

fun isListedNumber(n: int): bool {
    return n == 7 || n == 13 || n == 23 || n == 47 || n == 88 || n == 99
        || n == 101 || n == 108 || n == 404 || n == 418 || n == 451
        || n == 495 || n == 911 || n == 1234 || n == 1984 || n == 2001
        || n == 2049 || n == 4096 || n == 6174 || n == 8086 || n == 9000
        || n == 9001 || n == 24601 || n == 31337 || n == 65536 || n == 80085
        || n == 90210 || n == 142857 || n == 5318008 || n == 8675309;
}

// ---------------------------------------------------------------------------
// POSITION (§3.2) — where a number sits on the line, rather than what shape it
// has. `isCuratedConstantOrTaxicab` is the ONE survivor of the old curated
// list (its year half, 1918..2030, is deleted: LIFE prices years now, and
// properly).
// ---------------------------------------------------------------------------

fun isCuratedConstantOrTaxicab(n: int): bool {
    return n == 3141 || n == 31415 || n == 314159
        || n == 2718 || n == 27182 || n == 271828
        || n == 1618 || n == 16180 || n == 161803
        || n == 1414 || n == 14142 || n == 141421
        || n == 1729;
}

// The landmark table (§3.2): the largest prime below and smallest prime above
// each 10^k for k = 1..14, the m-th prime for m = 10..10^8 by decades, and the
// largest prime below each of the eight primorial era boundaries. SIEVED, not
// estimated — `sim/scripts/landmark_primes.py` generates this function body
// and is the provenance of every constant in it. Do not hand-edit; re-run the
// script.
// LANDMARK TABLE BEGIN
fun isLandmarkPrime(n: int): bool {
    return n == 5 || n == 7 || n == 11
        || n == 29 || n == 97 || n == 101
        || n == 199 || n == 541 || n == 997
        || n == 1009 || n == 2309 || n == 7919
        || n == 9973 || n == 10007 || n == 30029
        || n == 99991 || n == 100003 || n == 104729
        || n == 510481 || n == 999983 || n == 1000003
        || n == 1299709 || n == 9699667 || n == 9999991
        || n == 10000019 || n == 15485863 || n == 99999989
        || n == 100000007 || n == 179424673 || n == 223092827
        || n == 999999937 || n == 1000000007 || n == 2038074743
        || n == 9999999967 || n == 10000000019 || n == 99999999977
        || n == 100000000003 || n == 999999999989 || n == 1000000000039
        || n == 9999999999971 || n == 10000000000037 || n == 99999999999973
        || n == 100000000000031;
}
// LANDMARK TABLE END

// ---------------------------------------------------------------------------
// N6's predicates. Every one of these runs on the MINT path (`scoreOf(n)`), so
// each is written for the shape TVM is cheap at: an early exit on a bound that
// the sequence itself proves, and a membership table bucketed on the digit
// count `d` the caller already walked rather than a flat `||` chain. That last
// point is not a style note — measured, the two tables below cost 1,311,067
// nanoton more as flat chains, 61% of this whole batch's bill against §4.1's
// gas & ops line (0.10 GRAM when measured; 0.20 since D-117).
// ---------------------------------------------------------------------------

// Sum of each digit raised to the digit COUNT. Early-exits the moment the
// running sum passes `n`, which bounds the cost well under d*d multiplies on
// every number that is not narcissistic.
fun isNarcissistic(n: int, d: int): bool {
    if (d < 2) { return false; }
    var s = 0;
    var t = n;
    while (t > 0) {
        val dg = t % 10;
        var p = 1;
        var i = 0;
        while (i < d) { p *= dg; i += 1; }
        s += p;
        if (s > n) { return false; }
        t /= 10;
    }
    return s == n;
}

// Keith: the d-term recurrence seeded by the digits of `n`, reaching `n`. The
// window is a d-slot ring buffer over `array<int>` and the running sum is
// carried, so a step is one add, one subtract and one store rather than a
// re-walk. Terms ascend, so passing `n` is a proof of failure.
fun isKeithNumber(n: int, d: int, digitSum: int): bool {
    if (d < 2) { return false; }
    var w: array<int> = [];
    var t = n;
    while (t > 0) { w.push(t % 10); t /= 10; }
    var pos = d - 1;          // the oldest term: the leading digit
    var sum = digitSum;
    var steps = 0;
    while (steps < 200) {
        if (sum == n) { return true; }
        if (sum > n) { return false; }
        val next = sum;
        sum = sum - w.get(pos) + next;
        w.set(next, pos);
        pos -= 1;
        if (pos < 0) { pos = d - 1; }
        steps += 1;
    }
    return false;
}

// The Catalan numbers to AUCTIONABLE_MAX, bucketed by digit count for the same
// reason as the table above.
fun isCatalanNumber(n: int, d: int): bool {
    if (d < 1 || d > 14) { return false; }
    if (d == 1) { return n == 2 || n == 5; }
    if (d == 2) { return n == 14 || n == 42; }
    if (d == 3) { return n == 132 || n == 429; }
    if (d == 4) { return n == 1430 || n == 4862; }
    if (d == 5) { return n == 16796 || n == 58786; }
    if (d == 6) { return n == 208012 || n == 742900; }
    if (d == 7) { return n == 2674440 || n == 9694845; }
    if (d == 8) { return n == 35357670; }
    if (d == 9) { return n == 129644790 || n == 477638700; }
    if (d == 10) { return n == 1767263190 || n == 6564120420; }
    if (d == 11) { return n == 24466267020 || n == 91482563640; }
    if (d == 12) { return n == 343059613650; }
    if (d == 13) { return n == 1289904147324 || n == 4861946401452; }
    if (d == 14) { return n == 18367353072152; }
    return false;
}

// The complete list of highly composite numbers to AUCTIONABLE_MAX: d(n)
// strictly beats every smaller n. A record is only testable as a table, and a
// 110-entry `||` chain is the wrong shape for one — `d` is already in hand from
// the digit walk, so it selects the bucket and at most 14 comparisons run.
fun isHighlyComposite(n: int, d: int): bool {
    if (d < 1 || d > 14) { return false; }
    if (d == 1) { return n == 2 || n == 4 || n == 6; }
    if (d == 2) { return n == 12 || n == 24 || n == 36
            || n == 48 || n == 60; }
    if (d == 3) { return n == 120 || n == 180 || n == 240
            || n == 360 || n == 720 || n == 840; }
    if (d == 4) { return n == 1260 || n == 1680 || n == 2520
            || n == 5040 || n == 7560; }
    if (d == 5) { return n == 10080 || n == 15120 || n == 20160
            || n == 25200 || n == 27720 || n == 45360
            || n == 50400 || n == 55440 || n == 83160; }
    if (d == 6) { return n == 110880 || n == 166320 || n == 221760
            || n == 277200 || n == 332640 || n == 498960
            || n == 554400 || n == 665280 || n == 720720; }
    if (d == 7) { return n == 1081080 || n == 1441440 || n == 2162160
            || n == 2882880 || n == 3603600 || n == 4324320
            || n == 6486480 || n == 7207200 || n == 8648640; }
    if (d == 8) { return n == 10810800 || n == 14414400 || n == 17297280
            || n == 21621600 || n == 32432400 || n == 36756720
            || n == 43243200 || n == 61261200 || n == 73513440; }
    if (d == 9) { return n == 110270160 || n == 122522400 || n == 147026880
            || n == 183783600 || n == 245044800 || n == 294053760
            || n == 367567200 || n == 551350800 || n == 698377680
            || n == 735134400; }
    if (d == 10) { return n == 1102701600 || n == 1396755360 || n == 2095133040
            || n == 2205403200 || n == 2327925600 || n == 2793510720
            || n == 3491888400 || n == 4655851200 || n == 5587021440
            || n == 6983776800; }
    if (d == 11) { return n == 10475665200 || n == 13967553600 || n == 20951330400
            || n == 27935107200 || n == 41902660800 || n == 48886437600
            || n == 64250746560 || n == 73329656400 || n == 80313433200
            || n == 97772875200; }
    if (d == 12) { return n == 128501493120 || n == 146659312800 || n == 160626866400
            || n == 240940299600 || n == 293318625600 || n == 321253732800
            || n == 481880599200 || n == 642507465600 || n == 963761198400; }
    if (d == 13) { return n == 1124388064800 || n == 1606268664000 || n == 1686582097200
            || n == 1927522396800 || n == 2248776129600 || n == 3212537328000
            || n == 3373164194400 || n == 4497552259200 || n == 6746328388800
            || n == 8995104518400 || n == 9316358251200; }
    if (d == 14) { return n == 13492656777600 || n == 18632716502400 || n == 26985313555200
            || n == 27949074753600 || n == 32607253879200; }
    return false;
}

// ---------------------------------------------------------------------------
// THE SCORE.
//
// `score` is the clamped sum; `flags` is the bitmask of the categories that
// contributed to it, and the two CANNOT disagree because every point added
// here is added on the same line that sets its bit. That is what makes
// `getScoreBreakdown(n)` an audit (§9.1) rather than a second opinion: a
// reader recomputes the sum from `flags` and the published weight table and
// must land on `score`.
//
// DIGIT TAKES A MAX, EVERYTHING ELSE SUMS (§1.1). The six digit-shape
// predicates imply one another — 1111 is a repdigit AND a palindrome AND an
// abab — so summing them compounds one visual property into a runaway score
// and makes the clamp do all the work. Exactly ONE digit bit is ever set: the
// best reason the number looks nice, once. Ties go to the lower bit.
// ---------------------------------------------------------------------------

/**
 * BIT_PRIME out of a flags word.
 *
 * `scoreOf` already ran Miller-Rabin — 13 witnesses, the most expensive thing on the
 * mint and open paths — so a caller that holds the score must never pay for a second
 * pass to ask the same question. Every call site that needs BOTH the score and the
 * class reads the class from here; only a caller that needs the class ALONE
 * (`getLotLane`) calls `isPrimeMR` directly, because for that one the score is the
 * more expensive answer.
 */
fun isPrimeFromFlags(flags: int): bool {
    return ((flags >> BIT_PRIME) & 1) == 1;
}

fun scoreOfUnclamped(n: int): (int, int) {
    if (n <= 0) { return (0, 0); }

    // ---- one least-significant-digit walk: length, trailing zeros, the four
    // shape predicates, the digit sum and the full reversal (for the emirp
    // check). ----
    var d = 0;
    var tz = 0;
    var countingTz = true;
    var allSame = true;
    var ascending = true;      // digits ascend by 1 read most-significant-first
    var descending = true;
    var abab = true;           // digit[i] == digit[i-2] for every i
    var digitSum = 0;
    var dmask = 0;
    var p10 = 1;
    var rev = 0;
    var m = n;
    var prev = -1;
    var prev2 = -1;
    while (m > 0) {
        val dig = m % 10;
        if (countingTz) {
            if (dig == 0) { tz += 1; } else { countingTz = false; }
        }
        if (prev >= 0) {
            if (dig != prev) { allSame = false; }
            // Walking down from the top, the digit AFTER `dig` is `prev`, so
            // "ascending" (1234) means prev == dig + 1.
            if (prev != dig + 1) { ascending = false; }
            if (prev != dig - 1) { descending = false; }
        }
        if (prev2 >= 0 && dig != prev2) { abab = false; }
        prev2 = prev;
        prev = dig;
        digitSum += dig;
        dmask |= (1 << dig);
        p10 *= 10;
        rev = rev * 10 + dig;
        m = m / 10;
        d += 1;
    }
    val topDigit = prev;

    var flags = 0;
    var score = 0;

    // ---- LEN. Continuous, so it has no bit and no satellite (§8.3): a scale
    // is not a category. ----
    if (d < LEN_REF) { score += LEN_W * (LEN_REF - d); }

    // ---- DIGIT (max of six) ----
    var pali = false;
    if (d >= 2) {
        val half = d / 2;
        var rv = 0;
        var rest = n;
        var i = 0;
        while (i < half) {
            rv = rv * 10 + rest % 10;
            rest = rest / 10;
            i += 1;
        }
        if (d % 2 == 1) { rest = rest / 10; }   // drop the middle digit
        pali = (rest == rv);
    }
    val tzCapped = tz < TZ_CAP ? tz : TZ_CAP;
    var abRepeat = (d >= 4 && d % 2 == 0 && abab);
    if (!abRepeat && d == 4) {
        // aabb, which the abab walk does not see
        val e0 = n % 10;
        val e1 = (n / 10) % 10;
        val e2 = (n / 100) % 10;
        val e3 = (n / 1000) % 10;
        abRepeat = (e3 == e2 && e1 == e0 && e3 != e1);
    }
    var digBit = -1;
    var digPts = 0;
    if (d >= 2 && allSame) {
        digBit = BIT_REPDIGIT; digPts = W_REPDIGIT;
    }
    if (d >= 2 && topDigit == 1 && tz == d - 1 && W_POW10 > digPts) {
        digBit = BIT_POW10; digPts = W_POW10;
    }
    if (d >= 2 && pali && W_PALINDROME > digPts) {
        digBit = BIT_PALINDROME; digPts = W_PALINDROME;
    }
    if (d >= 3 && (ascending || descending) && W_RUN > digPts) {
        digBit = BIT_RUN; digPts = W_RUN;
    }
    if (abRepeat && W_ABAB > digPts) {
        digBit = BIT_ABAB; digPts = W_ABAB;
    }
    if (tzCapped > 0 && W_TRAILING_ZEROS * tzCapped > digPts) {
        digBit = BIT_TRAILING_ZEROS; digPts = W_TRAILING_ZEROS * tzCapped;
    }
    if (digBit >= 0) {
        flags |= (1 << digBit);
        score += digPts;
    }

    // ---- LIFE (owner answer 11). A human-life date is a tier of its own.
    //
    // NO DOUBLE COUNT INSIDE THE 8-DIGIT FORMS: an n whose leading four digits
    // are a year in 1900..2100, read instead as DDMMYYYY or MMDDYYYY, has a
    // month of 19, 20 or 21 and fails; the converse fails the same way. The
    // `else` below states that rather than relying on it.
    //
    // NO LEADING ZERO EXISTS. An integer cannot carry one, so `09091972` is
    // not a number this game can sell and the DDMMYYYY/MMDDYYYY forms are
    // reachable only when the leading field is >= 10 — which having exactly 8
    // digits already guarantees. The webapp's date finder is what tells a
    // buyer which of their date's forms are unrepresentable.
    if (d == 8) {
        val y8 = n / 10000;
        val md = n % 10000;
        if (y8 >= YEAR_LO && y8 <= YEAR_HI && isValidDate(y8, md / 100, md % 100)) {
            flags |= (1 << BIT_YYYYMMDD); score += W_YYYYMMDD;
        } else {
            val yTail = n % 10000;
            val f1 = n / 1000000;          // leading pair: day, or month
            val f2 = (n / 10000) % 100;    // second pair: month, or day
            if (yTail >= YEAR_LO && yTail <= YEAR_HI
                && (isValidDate(yTail, f2, f1) || isValidDate(yTail, f1, f2))) {
                flags |= (1 << BIT_DMY8); score += W_DMY8;
            }
        }
    }
    // YYMMDD carries no century, so the leap day is accepted: 000229 is a real
    // 29 February in every century divisible by 400 and the form cannot say
    // which one it means. Validated against 2000 for exactly that reason.
    if (d == 6) {
        val mm6 = (n / 100) % 100;
        val dd6 = n % 100;
        if (isValidDate(2000, mm6, dd6)) {
            flags |= (1 << BIT_YYMMDD); score += W_YYMMDD;
        }
    }
    if (d == 4) {
        if (n >= YEAR_LO && n <= YEAR_HI) {
            flags |= (1 << BIT_YEAR); score += W_YEAR;
        }
        val p1 = n / 100;
        val p2 = n % 100;
        if (isValidDate(2000, p1, p2) || isValidDate(2000, p2, p1)) {
            flags |= (1 << BIT_MMDD); score += W_MMDD;
        }
    }

    // ---- FORM (sum). One Miller-Rabin pass for a composite; five more only
    // inside the prime branch (§2). ----
    val prime = isPrimeMR(n);
    if (prime) {
        flags |= (1 << BIT_PRIME); score += W_PRIME;
        if (isMersenneForm(n)) { flags |= (1 << BIT_MERSENNE); score += W_MERSENNE; }
        if (isFermatPrime(n)) { flags |= (1 << BIT_FERMAT); score += W_FERMAT; }
        if (isPrimeMR(n - 2) || isPrimeMR(n + 2)) {
            flags |= (1 << BIT_TWIN); score += W_TWIN;
        }
        if (isPrimeMR(2 * n + 1)) {
            flags |= (1 << BIT_SOPHIE_GERMAIN); score += W_SOPHIE_GERMAIN;
        }
        if (n > 2 && (n - 1) % 2 == 0 && isPrimeMR((n - 1) / 2)) {
            flags |= (1 << BIT_SAFE_PRIME); score += W_SAFE_PRIME;
        }
        // "a DIFFERENT prime" — a palindromic prime is not an emirp, it
        // already carries BIT_PALINDROME.
        if (rev != n && isPrimeMR(rev)) {
            flags |= (1 << BIT_EMIRP); score += W_EMIRP;
        }
    }
    if (isPerfectNumber(n)) { flags |= (1 << BIT_PERFECT); score += W_PERFECT; }
    if (isPrimorial(n)) { flags |= (1 << BIT_PRIMORIAL); score += W_PRIMORIAL; }
    if (isFactorialN(n)) { flags |= (1 << BIT_FACTORIAL); score += W_FACTORIAL; }
    if (n >= 2 && (n & (n - 1)) == 0) { flags |= (1 << BIT_POW2); score += W_POW2; }
    val (fib, luc) = fibLucasOf(n);
    if (fib) { flags |= (1 << BIT_FIBONACCI); score += W_FIBONACCI; }
    if (luc) { flags |= (1 << BIT_LUCAS); score += W_LUCAS; }
    if (isPerfectCube(n)) { flags |= (1 << BIT_CUBE); score += W_CUBE; }
    // ONE root, two categories: n = r² is SQUARE, n = r(r+1) is PRONIC, and
    // both r are ⌊√n⌋.
    val rn = isqrt(n);
    if (rn * rn == n) { flags |= (1 << BIT_SQUARE); score += W_SQUARE; }
    if (rn * (rn + 1) == n) { flags |= (1 << BIT_PRONIC); score += W_PRONIC; }
    if (isPerfectSquare(8 * n + 1)) { flags |= (1 << BIT_TRIANGULAR); score += W_TRIANGULAR; }
    if (digitSum > 0 && n % digitSum == 0) { flags |= (1 << BIT_HARSHAD); score += W_HARSHAD; }
    if (isHappyN(n)) { flags |= (1 << BIT_HAPPY); score += W_HAPPY; }
    if (isPrimeMR(digitSum)) { flags |= (1 << BIT_DIGITSUM_PRIME); score += W_DIGITSUM_PRIME; }

    // ---- N6's eight from-`n` categories. SUMMED, not folded into DIGIT's
    // max-of-six: none of these is implied by a repdigit or a palindrome, and
    // a number that is both earns both. ----
    if (d == 10 && dmask == 0x3FF) { flags |= (1 << BIT_PANDIGITAL); score += W_PANDIGITAL; }
    if (isNarcissistic(n, d)) { flags |= (1 << BIT_NARCISSISTIC); score += W_NARCISSISTIC; }
    val nsq = n * n;
    val kLow = nsq % p10;
    if (kLow == n) { flags |= (1 << BIT_AUTOMORPHIC); score += W_AUTOMORPHIC; }
    if (kLow > 0 && kLow + nsq / p10 == n) { flags |= (1 << BIT_KAPREKAR); score += W_KAPREKAR; }
    if (((flags >> BIT_SQUARE) & 1) == 1 && ((flags >> BIT_TRIANGULAR) & 1) == 1) {
        flags |= (1 << BIT_SQUARE_TRIANGULAR); score += W_SQUARE_TRIANGULAR;
    }
    if (isHighlyComposite(n, d)) { flags |= (1 << BIT_HIGHLY_COMPOSITE); score += W_HIGHLY_COMPOSITE; }
    if (isKeithNumber(n, d, digitSum)) { flags |= (1 << BIT_KEITH); score += W_KEITH; }
    if (isCatalanNumber(n, d)) { flags |= (1 << BIT_CATALAN); score += W_CATALAN; }

    // ---- CULTURE. The two lists are disjoint by construction. ----
    if (isIconicNumber(n)) { flags |= (1 << BIT_ICONIC); score += W_ICONIC; }
    if (isListedNumber(n)) { flags |= (1 << BIT_LISTED); score += W_LISTED; }

    // ---- POSITION ----
    if (prime && isLandmarkPrime(n)) { flags |= (1 << BIT_LANDMARK); score += W_LANDMARK; }
    if (isCuratedConstantOrTaxicab(n)) { flags |= (1 << BIT_CONSTANT); score += W_CONSTANT; }

    // NO CLAMP HERE. `clampScore` is applied by the two entry points below,
    // ONCE, over the whole sum — including the factor points when there are
    // any. Clamping in this function instead would make
    // `scoreOfFrom(n, factors)` clamp twice and silently drop a factor
    // category on any number already at the ceiling.
    return (score, flags);
}

// THE ONE CLAMP. `flags` is NOT clamped: a number that earned nine categories
// wears nine satellites even when the ninth bought it no points, because the
// orb draws what is true of the number and the price draws what the game will
// charge for it.
@inline
fun clampScore(score: int): int {
    return score > SCORE_MAX ? SCORE_MAX : score;
}

// `1 + p + p^2 + ... + p^e`, the sigma-factor of one prime power. Summed as a
// series rather than as `(p^(e+1) - 1) / (p - 1)` so there is no division and
// no intermediate that overflows for a `p` near the uint256 ceiling: the loop
// runs `e` times and `e` is bounded by the factorization the caller already
// verified against `n`.
@inline
fun sigmaTerm(p: int, e: int): int {
    var term = 1;
    var power = 1;
    var i = 0;
    while (i < e) {
        power *= p;
        term += power;
        i += 1;
    }
    return term;
}

// The five §4 categories, from the aggregates of a VERIFIED factorization.
//
// The caller proves `product == n` before calling — this function trusts that
// and computes nothing about primality. `omega` is Omega(n), the factor count
// WITH multiplicity; `distinct` is the number of entries in the list.
// `(0, 0)` for an unfactored call, which is what keeps `scoreOf` a lower bound
// rather than a different answer.
@inline
fun factorScoreOf(n: int, omega: int, distinct: int, maxExponent: int, minExponent: int,
                  expGcd: int, maxPrime: int, sigma: int, korselt: int,
                  factorDigitSum: int): (int, int) {
    if (distinct <= 0) { return (0, 0); }

    var score = 0;
    var flags = 0;

    // Semiprime is Omega(n) == 2, the standard definition, so `p^2` is one:
    // it therefore carries BOTH this bit and PRIME_POWER, exactly as 64
    // already carries both SQUARE and CUBE. The model is additive and its
    // categories were never a partition.
    if (omega == 2) { flags |= (1 << BIT_SEMIPRIME); score += W_SEMIPRIME; }
    if (distinct == 1 && omega >= 2) {
        flags |= (1 << BIT_PRIME_POWER); score += W_PRIME_POWER;
    }
    if (maxExponent == 1) { flags |= (1 << BIT_SQUAREFREE); score += W_SQUAREFREE; }
    // CARMICHAEL, by Korselt's criterion: squarefree, at least three prime
    // factors, and (p-1) | (n-1) for every one of them. The squarefree half is
    // free — `maxExponent` is already in hand — and `korselt` is one modulo per
    // factor inside the walk `factorSummaryOf` was already making. The first clause is `maxExponent`,
    // which this function already has; the third is accumulated in the same
    // walk that builds sigma.
    if (korselt == 1 && maxExponent == 1 && distinct >= 3) {
        flags |= (1 << BIT_CARMICHAEL); score += W_CARMICHAEL;
    }
    if (maxPrime <= SMOOTH_BOUND) { flags |= (1 << BIT_SMOOTH); score += W_SMOOTH; }

    // ---- D-162's four. SPHENIC: three distinct primes, each once.
    if (omega == 3 && distinct == 3) { flags |= (1 << BIT_SPHENIC); score += W_SPHENIC; }
    // POWERFUL: every prime factor at least squared. ACHILLES: powerful and
    // NOT a perfect power, which is exactly "the exponents share no common
    // factor" — so p^k is powerful and never Achilles.
    if (minExponent >= 2) {
        flags |= (1 << BIT_POWERFUL); score += W_POWERFUL;
        if (expGcd == 1) { flags |= (1 << BIT_ACHILLES); score += W_ACHILLES; }
    }
    // SMITH: a composite whose digit sum equals the digit sums of its prime
    // factors, counted with multiplicity. `omega >= 2` is the composite test.
    if (omega >= 2) {
        var ds = 0;
        var t = n;
        while (t > 0) { ds += t % 10; t /= 10; }
        if (ds == factorDigitSum) { flags |= (1 << BIT_SMITH); score += W_SMITH; }
    }

    // Perfect numbers earn neither, and are already worth 40 as BIT_PERFECT.
    val twiceN = 2 * n;
    if (sigma > twiceN) { flags |= (1 << BIT_ABUNDANT); score += W_ABUNDANT; }
    if (sigma < twiceN) { flags |= (1 << BIT_DEFICIENT); score += W_DEFICIENT; }

    return (score, flags);
}

// Walk a submitted factor list into the aggregates `factorScoreOf` needs:
// `(omega, distinct, maxExponent, minExponent, expGcd, maxPrime, sigma,
// korselt, factorDigitSum)`. Entries are read from
// index 0 up and the walk stops at the first gap, which is how every other
// reader of this dictionary in both contracts walks it.
//
// THIS FUNCTION VERIFIES NOTHING. It is called on a list the contract has
// already checked against `n` (`open_lot`'s product check, the mint's own),
// and on nothing else — a get-method reader who passes a list that does not
// multiply to `n` gets a score for a number that is not theirs, which costs
// them the read and no one else anything.
fun factorSummaryOf(n: int, factors: map<uint8, FactorEntry>): (int, int, int, int, int, int, int, int, int) {
    val n1 = n - 1;
    var omega = 0;
    var distinct = 0;
    var maxExponent = 0;
    var minExponent = 0;
    var expGcd = 0;
    var factorDigitSum = 0;
    var maxPrime = 0;
    var sigma = 1;
    var korselt = 1;
    var idx = 0;
    var more = true;
    while (more) {
        val look = factors.get(idx);
        if (!look.isFound) {
            more = false;
        } else {
            val f = look.loadValue();
            distinct += 1;
            omega += f.exponent;
            if (f.exponent > maxExponent) { maxExponent = f.exponent; }
            if (distinct == 1 || f.exponent < minExponent) { minExponent = f.exponent; }
            // gcd(expGcd, e) by Euclid; gcd(0, e) = e seeds it.
            var ga = expGcd;
            var gb = f.exponent;
            while (gb != 0) { val gr = ga % gb; ga = gb; gb = gr; }
            expGcd = ga;
            var pt = f.primeNumber;
            while (pt > 0) { factorDigitSum += (pt % 10) * f.exponent; pt /= 10; }
            if (f.primeNumber > maxPrime) { maxPrime = f.primeNumber; }
            sigma *= sigmaTerm(f.primeNumber, f.exponent);
            if (f.primeNumber < 2 || (n1 % (f.primeNumber - 1)) != 0) { korselt = 0; }
            idx += 1;
        }
    }
    if (distinct == 0) { return (0, 0, 0, 0, 0, 0, 0, 0, 0); }
    return (omega, distinct, maxExponent, minExponent, expGcd, maxPrime, sigma, korselt, factorDigitSum);
}

// THE FULL SCORE, from aggregates the caller already has.
//
// THIS IS THE ENTRY POINT THE MINT USES, AND THE REASON IT EXISTS IS GAS.
// `primes_ledger.tolk` verifies the factorization on the mint path — it walks
// every entry to check `product == n` and to sum the divisor weights — so it
// can accumulate these five numbers in that same loop for a couple of multiplies
// per exponent step. Calling `scoreOfFrom` there instead would walk the
// dictionary a SECOND time, which measured at ~1,300 gas on the worst-case mint
// and was not affordable when measured: §4.1's gas & ops line was a fixed 0.10
// GRAM with the invite fan-out (D-101) at 99.79 of it. D-117 (2026-09-22) resized
// the line to the measured worst case (0.20 GRAM), which is what this walk must
// still fit inside; the headroom there is ~0.014 GRAM, not a budget for a second walk.
@inline
fun scoreOfWithSummary(n: int, omega: int, distinct: int, maxExponent: int, minExponent: int,
                       expGcd: int, maxPrime: int, sigma: int, korselt: int,
                       factorDigitSum: int): (int, int) {
    if (n <= 0) { return (0, 0); }
    var (score, flags) = scoreOfUnclamped(n);
    val (fScore, fFlags) = factorScoreOf(n, omega, distinct, maxExponent, minExponent, expGcd,
                                         maxPrime, sigma, korselt, factorDigitSum);
    score += fScore;
    flags |= fFlags;
    return (clampScore(score), flags);
}
// ===== D-99 SCORE BLOCK END =====

// THE FULL SCORE from the list itself, for a caller that has not walked it —
// the two get-methods, and `open_lot`, which is not on the gas & ops line. An
// empty list returns exactly `scoreOf(n)`, so a caller with no factorization to
// hand loses no information by calling this instead.
fun scoreOfFrom(n: int, factors: map<uint8, FactorEntry>): (int, int) {
    if (n <= 0) { return (0, 0); }
    val (omega, distinct, maxExponent, minExponent, expGcd, maxPrime, sigma, korselt,
         factorDigitSum) = factorSummaryOf(n, factors);
    return scoreOfWithSummary(n, omega, distinct, maxExponent, minExponent, expGcd, maxPrime,
                              sigma, korselt, factorDigitSum);
}

// ===== ISQRT BLOCK BEGIN — generated by tools/sync-score-block.mjs, do not edit here =====
// ============================================================================
// INTEGER SQUARE ROOT — the shared copy (GAUNTLET.md B29).
//
// Newton, seeded from a bit-length halving so the iteration count is bounded by
// construction rather than by hope: the largest argument any caller passes is
// `5n^2 + 4` at n = AUCTIONABLE_MAX, ~9.2e27, which converges in under 60 steps.
//
// B29 found the four copies were NOT the same function. Three contracts had
// this one; primes_generators_collection.tolk had a naive Newton seeded from
// `n` itself, with no negative guard and no iteration bound -- same answer for
// every argument its caller passes, reached in ~128 halvings instead of ~60
// Newton steps. Unified here, with this one canonical because it is the version
// whose bound is an argument rather than an assumption.
//
// Written into the ledger and the market (the generators collection left with D-165, the registrar with D-202) by tools/sync-score-block.mjs; see the MR block above.
// ============================================================================
fun isqrt(x: int): int {
    if (x < 0) { return -1; }
    if (x < 2) { return x; }
    // seed: the smallest power of two whose square is >= x
    var g = 1;
    var t = x;
    while (t > 0) { t >>= 2; g <<= 1; }
    var r = g;
    var i = 0;
    while (i < 200) {
        val nr = (r + x / r) / 2;
        if (nr >= r) { return r; }
        r = nr;
        i += 1;
    }
    return r;
}
// ===== ISQRT BLOCK END =====

// ---------------------------------------------------------------------------
// k(t) / k_max(n) fixed-point math (math-note.md §2/§3)
// ---------------------------------------------------------------------------

fun log10Fp(n: int): int {
    // digit count
    var d = 0;
    var t = n;
    while (t > 0) { d += 1; t /= 10; }
    var pow10 = 1;
    var i = 1;
    while (i < d) { pow10 *= 10; i += 1; }
    // frac in [1e9, 10e9)
    val frac = n * K_SCALE / pow10;
    val lowIdx = frac / K_SCALE; // 1..9
    val within = frac - lowIdx * K_SCALE; // 0..1e9
    // table[i] = log10(i + 1) scaled by K_SCALE, so log10 of the leading digit
    // `lowIdx` (1..9) is table[lowIdx - 1] and the next decade point is
    // table[lowIdx]. Reading table[lowIdx] as the LOW end was an off-by-one that
    // added log10(m+1) in place of log10(m): at n = 10^4 it returned 4.301
    // instead of 4.0, so k_max came out 2.7/4.301 = 0.6278 against §5's
    // published 0.675 — every k_max above the n0 anchor understated by ~7%,
    // silently and in the protocol's favour. Caught by SimCrossCheck.spec.ts,
    // which is exactly the failure that harness exists for; the doc, the sim and
    // params.json all agreed with each other and only the contract dissented.
    val table = [0, 301029995, 477121255, 602059991, 698970004, 778151250, 845098040, 903089987, 954242509, 1000000000];
    val logLow = table.get(lowIdx - 1);
    val logHigh = table.get(lowIdx);
    val interpolated = logLow + (logHigh - logLow) * within / K_SCALE;
    return (d - 1) * K_SCALE + interpolated;
}

fun kMaxOf(n: int): int {
    if (n <= N0_ANCHOR) { return K_MAX_CAP; }
    val log10n = log10Fp(n);
    if (log10n == 0) { return K_MAX_CAP; }
    var kmax = K_MAX_NUMERATOR * K_SCALE / log10n; // (K_MAX_CAP * N0_LOG10) * K_SCALE / log10_fp
    if (kmax > K_MAX_CAP) { kmax = K_MAX_CAP; }
    if (kmax < K_MIN) { kmax = K_MIN; } // clamp, math-note.md §3
    return kmax;
}

// §5: effective k_max under uplifts — the terms are summed and the SUM is
// clamped once at K_CEIL. `upliftSum` is the caller-assembled uplift line
// (see upliftSumFor above).
fun kMaxEffective(n: int, upliftSum: int): int {
    var kmax = kMaxOf(n) + upliftSum;
    if (kmax > K_CEIL) { kmax = K_CEIL; }
    if (kmax < K_MIN) { kmax = K_MIN; }
    return kmax;
}

// §5 / D-98: the LINEAR rebate ramp. `k` leaves K_MIN the instant after a mint
// and arrives at k_max after RAMP_SECONDS, exactly, where it parks until the
// next mint resets the clock. No fixed-point exp is involved any more, so the
// only approximation left anywhere on this curve is kMaxOf's log10 table.
fun kOfT(n: int, t: int, upliftSum: int): int {
    val kmax = kMaxEffective(n, upliftSum);
    if (t <= 0) { return K_MIN; }
    val progressFp = t >= RAMP_SECONDS ? K_SCALE : t * K_SCALE / RAMP_SECONDS;
    return K_MIN + (kmax - K_MIN) * progressFp / K_SCALE;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

struct FactorEntry {
    primeNumber: uint256
    exponent: uint8
    // §3.2: the minter-submitted `s = ⌊√p⌋`. Verified with two multiplies
    // (`s² ≤ p < (s+1)²`) so the contract never computes a square root; the
    // divisor line is then weighted by `e · s`.
    s: uint128
}

// THE mint message (D8): one signature, one transaction, 1 GRAM attached.
//
// Suppressed: the compiler's worst-case estimate treats `factors`
// (map<uint8,FactorEntry>, at most 8 entries per CONCEPT §3.2's omega(n)<=8
// theorem) pessimistically; in practice a HashmapE serializes as a single
// Maybe^Cell (~1 bit + a ref when non-empty), and the fixed fields
// (n,beneficiary,referralKey,kind,queryId) alone total ~620 bits, safely under
// 1023. Verified empirically by the mint round-trip tests exercising the
// maximum omega=8 case (docs/phase3-report.md).
// §4.1's invite line (D-202). Up to `Config.inviteCount` addresses THE MINTER names,
// keyed BY SLOT 1..inviteCount; holes allowed. A slot with no address funds
// nothing and its share stays in the residual. No signature: the comment the
// transfer carries is fixed in this contract, so a minter-chosen recipient can be
// sent nothing but the game's own text and `Config.inviteValue` (D-202, D-215).
//
// In a ref and not inline: three worst-case 267-bit addresses is 801 bits on
// its own, and as a Maybe-ref it costs ONE BIT on an uninvited mint. A dict of
// up to 100 addresses spills into child cells, which the minter's message pays
// to forward.
struct InviteList {
    addresses: map<uint7, address>
}

// D-191 point 1: a player sends this to the BENEFICIARY'S MINTER CARD, never to
// the ledger — the card forwards it here verbatim inside `card_mint`, beside the
// standing it is priced off. So there is no `beneficiary` field: the card IS
// the beneficiary's (a gift is sent to the recipient's card), and the payer is
// whoever sent it to the card.
@overflow1023_policy("suppress")
struct (0xb0000002) Mint {
    queryId: uint64
    n: uint256
    kind: uint1              // 0 = composite, 1 = prime
    factors: map<uint8, FactorEntry>
    referralKey: uint32
    // §4.1's invite line. 0..`Config.inviteCount`, SET BY THE MINTER within the
    // operator's terms (D-215). uint7 holds INVITE_COUNT_CEILING (100); the
    // `invite_count_over_max` check below refuses anything over the live count.
    inviteCount: uint7
    invites: Cell<InviteList>?      // null on an uninvited mint
}

struct (0xb0000004) LedgerClaimTribute {
    queryId: uint64
    p: uint256
    amount: coins
    owner: address
}

struct (0xb0000005) RetryCredit {
    queryId: uint64
    creditId: uint64
}

// D-52: permissionless re-send of a bounced `JettonMint`, the emission-side
// twin of `RetryCredit`. Anyone may call it for anyone — the PRIMES go to the
// wallet the bounce recorded and nowhere else, so there is no sender to gate.
// Cheap-fails on an unknown or already-retried recipient, exactly as
// `handleRetryCredit` does, because a retry lane that throws on a race is a
// worse lane.
struct (0xb000000d) RetryMint {
    queryId: uint64
    to: address
}

// D-117: permissionless re-send of a bounced `MintItem`, the item-side twin of
// `RetryCredit`/`RetryMint`. The body, owner and held split are the ones the bounce
// recorded, so a caller can name only WHICH number to retry, never where it goes.
struct (0xb000007b) RetryItem {
    queryId: uint64
    n: uint256
}

// §3.2: convert prime p's accrued flat dividend (`div_acc − entry[p]`) into
// its item's `owed`. Deliberately PERMISSIONLESS: it only ever moves p's own
// entitlement toward p's own item, so a third-party call is a favor, not a
// grief. Zero claimable is a cheap no-op on the item, not an error.
struct (0xb0000008) ClaimDividend {
    queryId: uint64
    p: uint256
}

// Outbound, to item(p) — mirrors primes_item.tolk's struct. `base` is present
// only when the walk parked this prime's bookmark in `soldAheadEntry`.
struct (0xb0000036) CreditDividend {
    queryId: uint64
    p: uint256
    divAcc: coins
    base: coins?
}

// Inbound, from item(p) only: the amount its `CreditDividend` moved into `owed`.
struct (0xb000000e) DividendCredited {
    queryId: uint64
    p: uint256
    amount: coins
}

// V28: inbound, from the collection only — a `Populate` item(n) refused, relayed
// with every nanoton that bounced. `mint` is this ledger's ORIGINAL `MintItem`
// body, parked for `retry_item` exactly as a `MintItem` the collection refused.
struct (0xb0000084) MintItemRefused {
    mint: cell
}

// D-188 point 4 — what an unsold prime's row held, handed to its item at sale.
// Mirrors primes_item.tolk's struct.
struct PrimeInit {
    divEntry: coins
    forfeited: coins
}

// CONCEPT §4.1 / §8: sweep the gas-&-ops SURPLUS to the ratchet pool (D-117).
//
// Read the three properties that make this not the withdraw path §8 forbids,
// because a reader who greps for "sweep" lands here first and is right to be
// suspicious:
//
//   1. NO AMOUNT ARGUMENT. The body carries a queryId and nothing else. What
//      leaves is `balance - declaredLiability(...) - OPS_RESERVE`, computed
//      here, or nothing at all.
//   2. NO SENDER CHECK, ONE FIXED DESTINATION. Anybody may call it; since
//      D-117 (owner, 2026-09-22) it always pays the RATCHET POOL, through the
//      same `forwardToRatchet` every mint's injection takes, and credits `T` by
//      the same amount. It emits nothing (k = 0, `S` untouched), so it is a pure
//      floor raise, and `T = seeded + swapped + pending` stays exact. No wallet
//      — the operator's included — is paid by it at all.
//   3. IT CANNOT REACH THE PROTECTED POOLS. `pending` is on the ratchet and
//      `owed` is on the items — two pools since D-90 deleted the escrow, and
//      neither of them is on this contract. That is exactly what the §3.4
//      decomposition was for, and it is what turns this from an argument into
//      a grep.
//
// The money being swept is the protocol's own unspent gas budget: the §4.1 20%
// gas & ops line (D-117) minus what the mint path actually spent on deploys, credits and hops.
struct (0xb0000007) SweepOps {
    queryId: uint64
}

// `Flush` (0xb0000006) and `UpdateVenue` (0xb0000010) are NOT accepted here.
// Both moved to primes_ratchet.tolk with `pending` and the DeDust leg. The
// absence is the point: the ledger's entire outbound set is the §4.1 split
// plus the two decomposition hops, and none of it is admin-authenticated.

struct (0xb0000040) GenesisSeed {
    queryId: uint64
    seedT: coins
    seedS: coins
    // D-20: opens the sequential head at the FIRST COMPOSITE (n = 4) — the
    // head is defined over composites (and Unity) only, so genesis seeding no
    // longer walks past a fixed auctioned set K. Every prime the walk below
    // crosses (2, 3) is marked unsold automatically; there is no separate
    // mask to pass, because "was walked and found prime" and "starts life
    // forfeiting" are now the same fact.
    seedHead: uint256
}

// CONCEPT §6 point 0 — THE LAUNCH. One-shot, from the genesis script only.
//
// WHY THE GAME NEEDS A STARTING GUN AT ALL. Genesis is not one transaction. It
// deploys thirteen contracts, seeds the LP, funds the bounty vault, seals the
// jetton authority and seeds T/S — a sequence that takes minutes on a real
// network and can fail halfway. Under the previous ordering the head opened
// inside that sequence, so "the game is live" was a property of a script having
// got far enough, observable only by reading five contracts and reasoning about
// which messages had landed. This message replaces that with a fact: one bit,
// on one contract, flipped by one transaction the founder signs.
//
// WHAT IT MINTS. Number 1, to `owner`, as an ordinary transferable TEP-62 item
// carrying `RARITY_UNITY`. Unity is the founder's artifact and it is
// economically INERT — not by a special case in the split, but because nothing
// in the split can reach it:
//
//   - it is never marked in the prime bitmap, so `isMarkedPrime(1)` is false and
//     a factorization citing it fails 201;
//   - it is not counted in `primesCount`, so it takes no share of the flat
//     dividend, and no dividend bookmark is stamped for it;
//   - `referralKey >= 2` already excludes it, so it can never earn a referral;
//   - it moves neither `T` nor `S` nor `head`, so it is not in the floor, not in
//     the supply, and does not shift anyone's `k`.
//
// It is an NFT and a fact about who started the game. That is the whole of it.
//
// WHAT IT COSTS. Nothing but gas. Unity is not a mint: no 1 GRAM, no five-way
// split, no ratchet injection, no PRIMES emitted. Charging for it would put
// founder capital through the split at `n = 1`, where `k_max(n) = 2.7/log₁₀(n)`
// is undefined — which is the arithmetic saying the same thing this comment does.
struct (0xb000000a) Ignite {
    queryId: uint64
    // The founder's address. Passed explicitly rather than taken from the
    // sender because the genesis script's sending wallet is a deploy credential
    // that gets retired, and Unity is permanent — they should not be forced to
    // be the same key.
    owner: address
}

// PERMISSIONLESS repair for `ignite`'s fan-out — see the handler for why a
// system with no admin key needs one. Carries no arguments because it has no
// decisions to make: it re-sends the ONE `launch_open` message `ignite` sent, and
// the receiver's handler is one-shot. (P2.A7: it used to re-send three.)
struct (0xb000000b) SyncLaunch {
    queryId: uint64
}

// P2.A7: the one `launch_open`, ledger -> market. It keeps the 0xe0 page (not
// the market's own 0xf2) because the market inherited that page's opcodes
// verbatim from the retired reservation book.
struct (0xe0000034) LaunchOpenMarket {
    queryId: uint64
}

// D12: one-shot peer bootstrap. P2.A7: two addresses, not four — the market and
// the bounty vault. Both still need the one-shot rather than deploy-time init for
// the original circular-address reason: each embeds the ledger's address in its
// own init data, so the ledger must exist first.
//
// The `SetPeersExtra` ref is DELETED with the fields that forced it. Four
// addresses plus the opcode and queryId was 1164 bits, over the cell ceiling, so
// the fourth lived in a ref; two addresses is 630 bits, comfortably inline.
struct (0xb0000041) SetPeers {
    queryId: uint64
    marketAddr: address
    bountyVaultAddr: address
}

// CONCEPT §6, D-7 and D-20. ONE sender — `ConfigD.marketAddr`. A sale itself is
// reported by `MintWonLot` / `SettlePrimeClearing` (the ordinary split on the
// nominal MINT_PRICE); this message carries only the PREMIUM above MINT_PRICE,
// on both lot modes alike:
//
//   `amount` is added to `T` and forwarded to the ratchet as `pending`. `S`
//   does not move, so every premium is a pure floor step — the reason §11.17
//   is closed. This is NOT a mint: nothing is emitted, nobody is credited, and
//   the only observable effect is that `p_f = T/S` rises.
// D-211 + D-215: §4.1's invite terms, from `FeeDests.operatorAddr` only, all three
// at once. `text` is the whole invite comment after op 0 (`inviteComment`): no
// refs, whole bytes, at most INVITE_TEXT_MAX_BYTES, else invite_text_bad (237).
// `count`/`value` must satisfy 1 <= value, count <= INVITE_COUNT_CEILING and
// count * (value + INVITE_SEND_FEE) <= INVITE_LINE_CAP, else invite_terms_bad
// (238); count 0 switches the line off. Takes effect on the next invite mint;
// `getInviteTerms()` and `getInviteText()` publish the live terms.
struct (0xb0000086) SetInviteTerms {
    queryId: uint64
    count: uint7
    value: coins
    text: cell
}

struct (0xb0000009) ClearingCleared {
    queryId: uint64
    prime: uint256
    amount: coins
}

// D-128: a secondary royalty's RATCHET HALF, from the two royalty-bearing
// collections only. `clearing_cleared`'s two effects with the market's door
// swapped for the collections' — `T += amount`, `S` untouched, the GRAM forwarded
// to the ratchet as `pending` — so a royalty is a pure floor step exactly as a
// clearing is. It is deliberately NOT `DonateFloor`, which also mints PRIMES to
// its sender and raises `S`: on this path that would emit supply to a collection
// contract for money that is not a subscription to the floor.
// D-212: a NAMING FEE (§4.7.1) arrives on this same arm, forwarded whole by the
// collection, and is the same pure floor step; the collection's `getNaming()`
// tells the two apart for §9.1.
struct (0xb0000079) RoyaltyToRatchet {
    queryId: uint64
    amount: coins
}

// D-91 point 4: the permissionless floor donation. GRAM in, PRIMES out, nothing
// ever out but PRIMES — §8's no-admin-withdraw rule is untouched because there
// is no withdraw here to gate. `amount` is the donation; the message must carry
// it plus the two hops' gas, exactly as `clearing_cleared` must.
struct (0xb000000c) DonateFloor {
    queryId: uint64
    amount: coins
}

// D-212 deleted D-179's `quote_floor` (0xb0000047) and its `floor_quote` reply with the
// burn sink that asked; neither opcode is recycled.

// D-117: the item-side retry lane. A bounced `MintItem` parked its original
// body in `Aux2.unroutedItems` and its held split in `unroutedHeld`; this re-sends
// that body — same n, same owner, same held split — with the held split's GRAM and a
// fresh `ITEM_DEPLOY_VALUE` the CALLER pays, so the number is minted to the
// owner it was sold to and every split line is paid exactly once, on the
// `mint_confirmed` that follows. Permissionless and cheap-failing, the same
// shape as `handleRetryMint`: if it bounces again it re-enters the lane.
fun handleRetryItem(valueCoins: coins, msg: RetryItem) {
    assert (valueCoins >= ITEM_DEPLOY_VALUE + CLAIM_DIVIDEND_MIN_VALUE) throw 103; // insufficient_value
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    var aux2 = loadAux2(storage);
    val look = aux2.unroutedItems.get(msg.n);
    if (!look.isFound) { return; } // cheap-fail: already retried, or never bounced
    val body = look.loadValue();
    // V24: the CALLER funds every leg a failed retry burns. Those legs are paid out
    // of GRAM the bounce arm then re-declares in full as `unroutedHeld`, so any fee
    // the caller did not cover was a draw on the ledger's own balance, once per
    // round, for as long as the deploy keeps bouncing.
    assert (valueCoins >= retryItemMinValue(body)) throw 103; // insufficient_value
    var item = MintItem.fromCell(body);
    aux2.unroutedItems.delete(msg.n);
    // V32: out of the parked lane and straight into the in-flight one, with no
    // gap between them — a credit that bounces now is re-parked, not forfeited.
    if (item.isPrime == 1) {
        aux2.deployingPrimes.set(msg.n, true);
    }
    saveAux2(mutate storage, aux2);
    val heldSplit = item.heldSplit;
    val held: coins = heldSplit == null ? 0 : heldSplitTotal(heldSplit);
    var meters = loadMeters(storage);
    meters.unroutedHeld -= held;
    saveMeters(mutate storage, meters);
    // The collection publishes `head` as TEP-62's `next_item_index`; the parked
    // body carries the head of its own day, so it is refreshed, never replayed.
    item.head = storage.head as uint64;
    storage.save();
    createMessage({
        bounce: BounceMode.RichBounce,
        value: item.mintValue + held, // ITEM_DEPLOY_VALUE, plus the receipt on a prime (V32)
        dest: configA.collectionAddr,
        body: item.toCell(),
    }).send(SEND_MODE_REGULAR);
}

// §3.4 B1: one-shot bootstrap of the ratchet + registrar addresses. Same
// circular-address problem and same resolution as SetPeers/D12.
struct (0xb0000042) SetSinks {
    queryId: uint64
    ratchetAddr: address
    registrarAddr: address
}

// D12/D-45: market -> ledger, sent from `open_lot` on a composite (not from
// the close) — see the file header's D12 note. D-45 never clears the bit, so
// `MarkUnreserved` (0xb0000022) is deleted and its opcode left unassigned.
struct (0xb0000021) MarkOffHead {
    queryId: uint64
    n: uint256
}

struct (0xb0000023) SyncHead {
    queryId: uint64
}

// D-189: PERMISSIONLESS. Continues a head-advance walk a mint left unfinished.
struct (0xb000007c) AdvanceHead {
    queryId: uint64
}

// D-196: PERMISSIONLESS, caller-funded. Pulls the frontier block's marks in
// from its lot-block child once the head's window has reached it.
struct (0xb000007e) ImportLotBlock {
    queryId: uint64
}

// D-196: lot block -> ledger, the import's answer. The child keeps its words,
// so a re-sent import gets the same answer.
struct (0xb000007f) LotBlockWords {
    queryId: uint64
    block: uint64
    claimed: uint256
    soldPrime: uint256
}

// D-196: lot block -> ledger, a claim on a bit already set. Relayed to the market
// as `mark_rejected`, which cancels the lot and refunds its bid.
struct (0xb0000080) LotBlockRefused {
    queryId: uint64
    n: uint256
}

// D-196: ledger -> lot block. Deploy-if-absent on every send.
struct (0x9c000001) LotBlockClaim {
    queryId: uint64
    n: uint256
}

struct (0x9c000002) LotBlockSoldPrime {
    queryId: uint64
    n: uint256
}

struct (0x9c000003) LotBlockImport {
    queryId: uint64
}

// D-198: PERMISSIONLESS, caller-funded (FLUSH_UNSOLD_VALUE). Moves the oldest
// unflushed block's unsold rows — each prime's §3.2 bookmark and §6 point 2
// forfeit counter — to that block's lot block, once the head has left it.
struct (0xb0000082) FlushUnsold {
    queryId: uint64
}

// One unsold prime's two numbers, as they leave this account.
struct UnsoldBookmark {
    entry: coins
    forfeited: coins
}

// ledger -> lot block: a block's unsold rows, keyed by bit `(n - 2) & 255`.
struct (0x9c000004) LotBlockBookmarks {
    queryId: uint64
    rows: map<uint8, UnsoldBookmark>
}

// ledger -> lot block: prime n sold; hand its bookmark back.
struct (0x9c000005) LotBlockRelease {
    queryId: uint64
    n: uint256
}

// lot block -> ledger: the bookmark of a flushed prime that has just sold.
struct (0xb0000083) LotBlockBookmark {
    queryId: uint64
    n: uint256
    entry: coins
}

// D-90: market -> ledger when an ascending COMPOSITE lot closes; the win mints
// here, in the closing transaction (`handleSettle`). Every prime sale, either
// lot mode, comes as `SettlePrimeClearing` instead, so `kind` is 0 in practice.
@overflow1023_policy("suppress")
struct (0xb0000020) MintWonLot {
    queryId: uint64
    n: uint256
    beneficiary: address
    referralKey: uint32
    kind: uint1
    factors: map<uint8, FactorEntry>
    // G70: `resPremium` is DELETED. Since D-90 the market's close sends the
    // premium above MINT_PRICE as `ClearingCleared`, so it was always 0.
}

// D-20 — inbound, from the market only, on a DESCENDING prime lot's sale (the
// lot a prime opens at its turn, D-88). A DIRECT, off-head mint: it runs the ordinary §4.1 five-way
// split on the nominal MINT_PRICE (CONCEPT §6 point 1's "the nominal 1 GRAM
// runs through the ordinary split like any composite mint") and, in the same
// transaction, deletes `n`'s `unsoldPrimes` and `forfeited` rows and hands both
// values to the new item (D-188) — the one place that forfeiture stops. The premium above MINT_PRICE is NOT carried here; the
// market sends it separately as an ordinary `ClearingCleared`, exactly as it
// does for an ascending lot (D-7).
struct (0xb0000024) SettlePrimeClearing {
    queryId: uint64
    n: uint256
    beneficiary: address
    referralKey: uint32
}

// D-88 point 2 deleted `SettleSpecialComposite` (0xb0000073) with the SS3 lane;
// opcode left UNASSIGNED on both sides of the wire.

// outbound, ledger -> market: the ONE head_update. `headHint` picks the lot mode
// for `n` — ascending when `n > headHint`, the descending prime lot when
// `n < headHint`. A STALE-LOW hint only delays a due prime lot; an ascending
// open on a number the real head already minted is caught here by
// `mark_off_head`'s refusal. Sent only by `sync_head` (permissionless,
// caller-funded), never on the mint path, so the cache costs the hot path
// nothing — engineering-spec §2.5's accepted lag.
struct (0xe0000031) HeadUpdate {
    queryId: uint64
    head: uint256
}

struct (0xe0000033) SettleConfirmed {
    queryId: uint64
    n: uint256
}

struct (0xe0000032) MarkRejected {
    queryId: uint64
    n: uint256
    head: uint256   // the market's `headHint` learns it from the refusal
}

// outbound, ledger -> bounty vault (CONCEPT §7 primorial era ceremony).
// DENOMINATION_PLAN P4: the vault's schedule is GRAM-denominated, so the body
// carries this mint's POST-MINT (T, S) and the vault converts at the floor the
// mint just set. Opcode moved 0xb0000031 -> 0xb0000032 so a stale sender is
// rejected rather than mis-parsed (primes_bounty_vault.tolk D22).
struct (0xb0000032) PayEraBounty {
    queryId: uint64
    eraBoundary: uint256
    beneficiary: address
    t: coins
    s: coins
}

// outbound, ledger -> bounty vault. D-99 §1.5. Every special number pays its
// rebate at most once, on whichever acquisition route first assigns it an owner. `kind` is REBATE_COMPOSITE_PER_POINT (0) or REBATE_PRIME_FAMILY
// (1); `points` is D(n) on the first and ignored on the second. The vault's own
// genesis-fixed `rebateSchedule` decides the GRAM value — the ledger decides
// ELIGIBILITY and SIZE-IN-POINTS only, the same D22 trust shape `PayEraBounty`
// uses. `n` doubles as the vault's idempotency key (`paidSpecials`).
const REBATE_COMPOSITE_PER_POINT: int = 0;
const REBATE_PRIME_FAMILY: int = 1;

struct (0xb0000072) PaySpecialNumberRebate {
    queryId: uint64
    n: uint256
    kind: uint8
    points: uint16
    beneficiary: address
    t: coins
    s: coins
}

// outbound, ledger -> registrar (D-36 / §4.7, §7: the ERA TROPHY).
//
// Sent on a primorial mint, in the same transaction as `PayEraBounty` and
// beside it rather than out of it: the bounty still pays 100% to the
// primorial's MINTER, and this awards permanent naming rights over that same
// primorial to the era's top RECRUITER. Two different people, two different
// rewards, no arithmetic shared between them.
//
// `recruits` is carried for the record only — the registrar authenticates on
// the sender and does not recompute the winner, because it has no recruit
// state and D-36 puts the tally on the ledger where the activation edge is.
struct (0xb000006b) AwardEraTrophy {
    queryId: uint64
    primorial: uint256
    winner: address
    recruits: uint32
}

struct (0xc0000001) MintItem {
    queryId: uint64
    n: uint256
    owner: address
    isPrime: uint8
    factorization: cell
    rarityFlags: uint16
    mintValue: coins
    // §4.6 / §7: the ledger's head AFTER this mint, so the collection holds an
    // authoritative copy of it. The collection needs a head to answer §4.6's
    // claim-window question, and it cannot derive one: D-20 walks the head past
    // every prime it crosses, and that walk is invisible from the collection's
    // side — counting `mint_item`s undercounts by pi(n). Carried on a message
    // that already exists rather than as a `head_update` hop, so the mint path
    // gains no send (EARN_PLAN risk 3 — the gas & ops line has 0.021 GRAM of
    // headroom and this spends none of it).
    //
    // uint64, not uint256: `MintItem` is within 1023 bits of the single-cell
    // ceiling — a uint256 here does not fit and would force the whole message
    // into a ref for no gain. A head above 2^64 is not reachable by sequential
    // minting under any physics.
    head: uint64
    // D-117 (signed 2026-09-22) — THE HELD SPLIT. The lines this mint owes
    // third parties (the divisor-line tribute, credited or forfeited; the
    // referral relay; the 5% treasury line) are not sent beside this message any
    // more: they RIDE on it, as value, with this cell saying where each goes.
    // The collection hands both back in `MintConfirmed` once it has accepted the
    // deploy, and only then does this contract pay them. A `MintItem` that
    // bounces brings them back in the bounce instead, and nothing was paid — see
    // `onBouncedMessage`. `null` on the one send with no lines (Unity, ignite).
    // Layout, written by `executeMint` and read by `payHeldSplit`:
    //   hasReferral:uint1 [referralKey:uint32]  count:uint4
    //   count x { forfeit:uint1  p:Coins  share:Coins }
    heldSplit: cell?
    // D-188 point 4 — a PRIME's dividend bookmark and forfeit counter, taken off
    // its `unsoldPrimes`/`forfeited` rows in this transaction and handed to the
    // new item. `null` on every composite and on Unity. A ref, because
    // `MintItem` has no 248 bits left inline.
    primeInit: Cell<PrimeInit>?
}

// D-117, V28 — item(n)'s receipt, sent from its `Populate`, carrying the held
// split back with the value it rode on. Sender-derived: `n` names the one item
// that could have sent it, so the split is paid only by an item that exists.
// The held split rides INLINE in this root cell, not as a ref: a message's root
// bits are free of forward fee and a ref cell is not, and the difference
// (~0.00014 GRAM a mint, measured) is what keeps the worst-case mint inside
// §4.1's gas & ops line. The held split is at most ~710 bits (omega = 12, the
// factors' bits summing to log2(n) < 82), and `n` is `coins` (n < 2^82,
// `executeMint`'s MR bound) rather than uint256 so the root stays under 1023.
// `isPrime` drives V32's in-flight row.
struct (0xb000007a) MintConfirmed {
    queryId: uint64
    n: coins
    isPrime: uint1
    heldSplit: RemainingBitsAndRefs
}

struct (0xc1000002) ForwardToOwner {
    queryId: uint64
}

struct (0xb0000030) CreditTribute {
    queryId: uint64
    creditId: uint64
    amount: coins
    // GAUNTLET V17 point 1. THE PRIME THIS CREDIT IS FOR.
    //
    // It used to be absent, and its absence was a permanent money-loss path
    // rather than an untidiness: when a `credit_tribute` bounced, the ledger had
    // no way to recover which item it had been for, so `onBouncedMessage` filed
    // the amount under `p = 0`. `handleRetryCredit` then re-sent it to
    // `itemAddress(0)` forever — a contract that is not an item and cannot
    // accept it — so the GRAM sat in `unroutedHeld` for good while
    // `getLiabilityBreakdown` went on reporting it as owed. A published solvency
    // figure that overstates what is recoverable is exactly the failure §3.4's
    // "balance ~ declared liability, checkable in one get-call" exists to
    // prevent.
    //
    // The destination address is already a pure function of `p`
    // (`itemAddress`), so carrying `p` costs 256 bits and closes the loop with
    // no side index and no keeper. The struct is ~508 bits, well inside TVM's
    // 1023-bit single-cell budget.
    p: uint256
}

struct (0xd0000001) JettonMint {
    queryId: uint64
    to: address
    amount: coins
    forwardTonAmount: coins
}

// outbound, ledger -> ratchet. Carries the pool backing itself (as message
// value: `amount + RATCHET_HOP_GAS`) plus the authoritative (T, S) snapshot
// AFTER this mint's effects, which is the floor the ratchet's §4.3.1 guard
// prices its next flush against.
struct (0xb0000050) PoolInject {
    queryId: uint64
    amount: coins
    tSnapshot: coins
    sSnapshot: coins
}


// ---------------------------------------------------------------------------
// D-191 point 1 (GAUNTLET V26.4) — THE MINTER CARD. A wallet's rebate standing
// lives on its own child, `primes_minter_card.tolk`, whose address is derived
// from (card code, this ledger, the wallet). `CardInit` mirrors the card's
// `Storage` in its EMPTY state, byte for byte; `MinterCard.spec.ts` asserts
// `getMinterCardAddress(wallet)` equals the wrapper's derivation.
// ---------------------------------------------------------------------------
struct CardInit {
    ledgerAddr: address
    owner: address
    state: MinterState
    seen: bool
    eraSeq: uint8
    eraRecruits: uint32
    inFlight: uint32
    edgeSentAt: uint32
}

// What the market paths pass for a standing they never read (k_min / k = 0).
const NO_STANDING = MinterState { primesMinted: 0, window: 0, newcomerWindow: 0, recruits: 0, newcomerOpened: false };

fun cardStateInit(cardCode: cell, owner: address): AutoDeployAddress {
    return AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState {
            code: cardCode,
            data: (CardInit {
                ledgerAddr: contract.getAddress(),
                owner: owner,
                state: NO_STANDING,
                seen: false,
                eraSeq: 0,
                eraRecruits: 0,
                inFlight: 0,
                edgeSentAt: 0,
            }).toCell(),
        },
    };
}

fun cardAddress(cardCode: cell, owner: address): address {
    return cardStateInit(cardCode, owner).calculateAddress();
}

// ---------------------------------------------------------------------------
// D-196 (GAUNTLET V30) — THE LOT BLOCK. Marks for a block beyond the import
// frontier live on `primes_lot_block.tolk`, at an address derived from (its
// code, this ledger, the block). `LotBlockInit` mirrors its `Storage` in the
// EMPTY state, byte for byte; `LotBlock.spec.ts` asserts the derivations agree.
// ---------------------------------------------------------------------------
struct LotBlockInit {
    ledgerAddr: address
    block: uint64
    claimed: uint256
    soldPrime: uint256
    bookmarks: map<uint8, UnsoldBookmark>   // D-198
}

fun lotBlockStateInit(lotBlockCode: cell, block: int): AutoDeployAddress {
    return AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState {
            code: lotBlockCode,
            data: (LotBlockInit {
                ledgerAddr: contract.getAddress(),
                block: block,
                claimed: 0,
                soldPrime: 0,
                bookmarks: createEmptyMap<uint8, UnsoldBookmark>(),
            }).toCell(),
        },
    };
}

fun lotBlockAddress(lotBlockCode: cell, block: int): address {
    return lotBlockStateInit(lotBlockCode, block).calculateAddress();
}

// card -> ledger: a head mint, and the standing it is priced off. `state` is the
// standing BEFORE this mint (the card has already spent this mint's window units
// and, on a recruit edge, opened the newcomer window); `fresh` is the §4.5 sybil
// guard — no accepted event had touched the card before this mint.
struct (0x9b000001) CardMint {
    owner: address
    payer: address
    state: MinterState
    fresh: bool
    mint: Cell<Mint>
}

// ledger -> card: a lost race. The refund rides through the card, which gives
// the mint's window units back before passing the GRAM on to `payer`.
struct (0x9b000005) CardMintRefunded {
    queryId: uint64
    payer: address
    state: MinterState
    fresh: bool
}

// ledger -> the PAYER's card, on a recruit edge: +1 lifetime recruit, and +1 to
// the era tally taken under `eraSeq`. Deploys the card if absent.
struct (0x9b000002) CardAddRecruit {
    queryId: uint64
    eraSeq: uint8
}

// card -> ledger: the payer's era tally after that credit, for the running max.
struct (0x9b000003) CardRecruitCounted {
    queryId: uint64
    owner: address
    eraSeq: uint8
    eraRecruits: uint32
}

// ledger -> the beneficiary's card, on every prime sale: +1 prime rank and a
// fresh PRIME_WINDOW (§5.1: reset, never stacked). Deploys the card if absent.
struct (0x9b000004) CardPrimeMinted {
    queryId: uint64
}

type AllowedMessage =
    CardMint | CardRecruitCounted | LedgerClaimTribute | RetryCredit | RetryMint | ClaimDividend | DividendCredited
    | Ignite | SyncLaunch | GenesisSeed | SetPeers | SetSinks | MarkOffHead
    | SyncHead | MintWonLot | SweepOps | ClearingCleared
    | SettlePrimeClearing
    | DonateFloor | RoyaltyToRatchet | MintConfirmed | RetryItem
    | AdvanceHead
    | ImportLotBlock | LotBlockWords | LotBlockRefused | MintItemRefused
    | FlushUnsold | LotBlockBookmark | SetInviteTerms;

// `isPrimorial` lives in the D-99 score block above (bit 14) — one list, one copy.

// §4.1's invite line (D-202, D-211, D-215): THE ONE TEXT an invite transfer
// carries. A plain text comment (op 0, then the operator-set words,
// `Config.inviteText`) and nothing else. Nothing in it is minter-written, which
// is why the minter may name any recipient: the worst a minter can send a
// stranger from this contract is the operator's words and the live value.
// There is NO link: D-215 point 4, closed by the owner 2026-11-23 -- a mainnet
// probe of the genesis words with ` primes.live/?ref=<n>_tg` after them got no
// Telegram Wallet push, the words alone did. So the comment does not depend on n.
//
// One cell: 4 + words (<= INVITE_TEXT_MAX_BYTES = 86) bytes <= 127.
const INVITE_TEXT_MAX_BYTES = 86;

fun inviteComment(words: cell): cell {
    return beginCell().storeUint(0, 32).storeSlice(words.beginParse()).endCell();
}

fun refund(dest: address, amount: coins, queryId: int) {
    if (amount <= 0) { return; }
    createMessage({
        bounce: BounceMode.NoBounce,
        value: amount,
        dest: dest,
        body: beginCell().storeUint(0, 32).storeUint(queryId, 64).endCell(),
    // IGNORE_ERRORS (2026-11-20, audit R2-L1's sibling): the forward fee comes out
    // of `amount`, and an amount too small to pay it failed the ACTION phase (40)
    // — aborted, no bounce. From `handleCardMint` that was a mint sent 1 nanoGRAM
    // over MINT_PRICE + MINT_MARGIN: the ledger kept the whole value and the card
    // never got its standing back. Dust that cannot be sent is dropped instead and
    // stays on this balance, which `sweep_ops` carries to the pool. Both callers
    // check what they need BEFORE this (216 covers the balance for a claim).
    }).send(SEND_MODE_REGULAR | SEND_MODE_IGNORE_ERRORS);
}

// ---------------------------------------------------------------------------
// MESSAGE HANDLERS
//
// One function per accepted message, so `onInternalMessage` below reads as the
// list of what this contract accepts rather than as a 470-line match. Each
// handler takes what it needs from `InMessage` explicitly — nothing reads
// ambient state — and nothing else moved: the bodies are the same code, in the
// same order, with the same comments.
//
// `@inline` is not decoration here. These are single-call-site functions, so
// inlining duplicates no code, and it is what keeps the extraction gas-neutral:
// measured against the pre-refactor bytecode it puts the composite-mint path
// 25 gas BELOW where it was, where extracting without it cost +175. See the
// SettlePrimeClearing arm for the one place where even that was not enough.
// ---------------------------------------------------------------------------

// §3.2 tribute claim, relayed by the item that holds it: the item has
// already debited itself, so all that is left here is to authenticate the
// sender against the deterministic item address and pay the owner.
@inline
fun handleClaimTribute(senderAddress: address, msg: LedgerClaimTribute) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    val expected = itemAddress(configA, msg.p);
    assert (senderAddress == expected) throw 100; // wrong_sender
    // B-1: this is where the custodied tribute actually leaves, so this is
    // where the declared liability has to fall. The balance check is not
    // belt-and-braces for its own sake: without it an under-funded ledger fails
    // in the ACTION phase with TVM's generic "not enough GRAM" (37), which reads
    // as a gas problem rather than as insolvency — and, the part this comment
    // had wrong until 2026-11-20, does NOT bounce: only a compute-phase throw
    // does. So the assert is what lets the item restore `owed` (see
    // primes_item.tolk's onBouncedMessage); past it, `refund` drops a payout too
    // small to carry its own forward fee rather than abort, and the liability
    // still falls.
    var meters = loadMeters(storage);
    assert (contract.getOriginalBalance() >= msg.amount) throw 216; // ledger_tribute_insolvent
    meters.tributeOwed -= msg.amount;
    saveMeters(mutate storage, meters);
    storage.save();
    refund(msg.owner, msg.amount, msg.queryId);
}

// §3.2's flat per-prime dividend. PERMISSIONLESS: it only ever moves p's own
// entitlement into p's own item's `owed`. D-188 point 4 puts the bookmark
// `entry[p]` on the item, so the subtraction happens there: this sends the
// current `divAcc` (and, once, a bookmark parked for a prime sold ahead of the
// head), the item credits `divAcc − entry[p]` and re-stamps, and its
// `DividendCredited` moves the same amount from `divOutstanding` to
// `tributeOwed` here. The claimant's value carries both hops.
@inline
fun handleClaimDividend(valueCoins: coins, msg: ClaimDividend) {
    assert (valueCoins >= CLAIM_DIVIDEND_MIN_VALUE) throw 103; // insufficient_value
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    val meters = loadMeters(storage);
    // Eligible = marked AND crossed by the head. A prime sold AHEAD of the head
    // is marked but not yet counted into π(n): it has accrued nothing, and its
    // bookmark does not exist until the walk reaches it.
    assert (isMarkedPrime(storage, msg.p) && msg.p < storage.head) throw 201; // ledger_bad_factorization: not an eligible prime
    // D-20 + D-90: an unsold prime is accruing with no item to receive the
    // credit — the eventual buyer's item is handed the bookmark at sale, and
    // claims all of it then. Not §6 point 2's forfeit: the flat line is
    // attributed to nothing and is merely deferred.
    assert (!isUnsoldPrime(storage, msg.p)) throw 219; // ledger_dividend_prime_unsold
    var base: coins? = null;
    var aux2 = loadAux2(storage);
    val parked = aux2.soldAheadEntry.get(msg.p);
    if (parked.isFound) {
        base = parked.loadValue();
        aux2.soldAheadEntry.delete(msg.p);
        saveAux2(mutate storage, aux2);
        storage.save();
    }
    createMessage({
        // A bounce (the item is not deployed yet — its `MintItem` is parked for
        // `retry_item`) changes nothing here but the parked bookmark, which the
        // bounce arm puts back.
        bounce: BounceMode.RichBounce,
        value: 0,
        dest: itemAddress(configA, msg.p),
        body: (CreditDividend { queryId: msg.queryId, p: msg.p, divAcc: storage.divAcc, base: base }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// The item's report for `CreditDividend`. B-1: a TRANSFER between two liability
// lines, not a discharge — the GRAM stays custodied here, now owed as tribute.
@inline
fun handleDividendCredited(senderAddress: address, msg: DividendCredited) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    val expected = itemAddress(configA, msg.p); // derived: the sender IS the key
    assert (senderAddress == expected) throw 100; // wrong_sender
    var meters = loadMeters(storage);
    meters.divOutstanding -= msg.amount;
    meters.tributeOwed += msg.amount;
    saveMeters(mutate storage, meters);
    storage.save();
}

// V28: the item refused `Populate`, so nothing was paid and the held split is in
// this message's value. Parked through the same code as a `MintItem` the
// collection itself refused (`onBouncedMessage`'s 0xc0000001 arm).
@inline
fun handleMintItemRefused(senderAddress: address, msg: MintItemRefused) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    assert (senderAddress == configA.collectionAddr) throw 100; // wrong_sender
    parkRefusedMintItem(mutate storage, msg.mint);
    storage.save();
}

// The retry lane for a `CreditTribute` that bounced back unrouted (see
// `UnroutedCredit`). Permissionless and cheap-failing: a credit id that is
// no longer held has already been retried or expired.
@inline
fun handleRetryCredit(valueCoins: coins, msg: RetryCredit) {
    assert (valueCoins >= CREDIT_TRIBUTE_VALUE + CALLER_COMPUTE_GAS) throw 103; // insufficient_value
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    var meters = loadMeters(storage);
    val look = storage.unroutedCredits.get(msg.creditId);
    if (!look.isFound) { return; } // cheap-fail, already retried/expired
    val credit = look.loadValue();
    storage.unroutedCredits.delete(msg.creditId);
    // B-1: the credit leaves the retry lane and re-enters the owed lane. Both
    // legs are always written together so the amount is in exactly one of them.
    meters.unroutedHeld -= credit.amount;
    meters.tributeOwed += credit.amount;
    saveMeters(mutate storage, meters);
    storage.save();
    createMessage({
        bounce: BounceMode.RichBounce,
        value: CREDIT_TRIBUTE_VALUE,
        dest: itemAddress(configA, credit.p),
        body: (CreditTribute { queryId: msg.queryId, creditId: msg.creditId, amount: credit.amount, p: credit.p }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

// D-52: the emission-side twin of `handleRetryCredit`, and deliberately the
// same shape. Permissionless — the PRIMES can only go to the wallet the bounce
// recorded, so there is nothing a sender could steer.
//
// The caller supplies `to` and the key is recomputed from it, so the book is
// keyed on a hash without ever having to store an address it might disagree
// with. `RichBounce`, because a retry that fails again must come back and
// re-enter the lane rather than vanish — the pair is self-correcting, and each
// attempt is paid for by whoever made it, so there is no drain.
fun handleRetryMint(valueCoins: coins, msg: RetryMint) {
    // The retry carries its own mint gas. Paying it out of this contract's
    // balance would be spending player money on an operator's mistake.
    assert (valueCoins >= DONATE_MINT_GAS + CLAIM_DIVIDEND_MIN_VALUE) throw 103; // insufficient_value
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    val mKey = addrKey(msg.to);
    val look = storage.unmintedMints.get(mKey);
    if (!look.isFound) { return; } // cheap-fail: already retried, or never bounced
    val amount = look.loadValue();
    storage.unmintedMints.delete(mKey);
    var meters = loadMeters(storage);
    // The emission leaves the held lane. If the send below bounces,
    // `onBouncedMessage` puts it straight back — counted in exactly one place
    // at every point in between, exactly as `unroutedHeld` is.
    meters.unmintedHeld -= amount;
    saveMeters(mutate storage, meters);
    storage.save();
    createMessage({
        bounce: BounceMode.RichBounce,
        value: DONATE_MINT_GAS,
        dest: configA.jettonMasterAddr,
        body: (JettonMint { queryId: msg.queryId, to: msg.to, amount: amount, forwardTonAmount: MINT_NOTIFY_TON }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

// §3.4 B1: one-shot bootstrap of the ratchet + registrar addresses.
@inline
fun handleSetSinks(senderAddress: address, msg: SetSinks) {
    var storage = lazy Storage.load();
    var b = loadConfigB(storage);
    assert (senderAddress == b.genesisScriptAddr) throw 100; // wrong_sender
    assert (b.sinksSet == 0) throw 104; // already_processed
    b.ratchetAddr = msg.ratchetAddr;
    b.registrarAddr = msg.registrarAddr;
    b.sinksSet = 1;
    saveConfigB(mutate storage, b);
    storage.save();
}

// CONCEPT §6 point 0. See the struct header for what Unity is and
// why it is free. This handler is the whole launch.
@inline
fun handleIgnite(senderAddress: address, valueCoins: coins, msg: Ignite) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    val b = loadConfigB(storage);
    val d = loadConfigD(storage);
    var meters = loadMeters(storage);
    assert (senderAddress == b.genesisScriptAddr) throw 100; // wrong_sender
    assert (meters.launched == 0) throw 104;                // already_processed
    // A HALF-WIRED GENESIS MUST NOT LAUNCH — for the three conditions that
    // are about THIS contract's own mint path. Without `sinksSet` a mint
    // cannot reach the ratchet; without `genesisSeeded` there is no `S` to
    // price against. Either way the very first player's transaction fails, so
    // this fails first and loudly instead.
    assert (b.sinksSet == 1) throw 233;           // ledger_sinks_unset
    assert (meters.genesisSeeded == 1) throw 233; // ledger_sinks_unset
    // ...and the floor must actually be BACKED, which `genesisSeeded` does not
    // give it: the seed writes `T = 0` (D-46 point 2 — no founder GRAM is
    // deposited) and D-92's `donate_floor` is what creates the floor, as a
    // separate permissionless call. Opening minting in between is not a
    // cosmetic ordering slip. The rebate is `R = k*I*S/T`, unbounded as
    // `T -> 0`: the mint after the first one emits ~20% of the genesis supply
    // for 1 GRAM, against 0.28% once the donation has landed — measured in
    // `contracts/tests/UnbackedFloorLaunch.spec.ts`. So the launch order is
    // seed -> donate -> ignite, and it is structural rather than a step in a
    // runbook. `> 0` and not a target floor on purpose: the donation is
    // incremental by construction, so one tranche or ten, and a small testnet
    // donation as readily as the full 240, all pass.
    assert (storage.T > 0) throw 218;             // ledger_floor_unbacked
    // `peersSet` is deliberately NOT asserted, and the fan-out below is
    // conditional on it instead. The peers are separate contracts; if
    // they were never bootstrapped they are not part of this deployment,
    // and the honest result is that they stay closed while the ledger's
    // own mint path opens. Asserting here would instead make the ledger's
    // launch depend on contracts it does not own, and gate a mint on a
    // market nobody deployed. What is NOT possible either way is the
    // market opening without the ledger: it has no other sender.
    // Funded from this message: the item deploy plus the `launch_open`
    // hop. The `3 *` is left over from the three-peer fan-out P2.A7
    // retired; the two unspent hops stay on this balance.
    // Refusing under-funded ignition beats a launch that flips the
    // ledger's flag and leaves the market closed.
    assert (valueCoins >= ITEM_DEPLOY_VALUE + 3 * LAUNCH_HOP_GAS) throw 103; // insufficient_value

    meters.launched = 1;
    saveMeters(mutate storage, meters);
    storage.save();

    // 1. Unity. Note what is NOT here: no markPrime, no primesCount, no
    //    dividend stamp, no T/S movement, no `head += 1`, no split, no
    //    rebate. `isPrime: 0` and an empty factorization are what the
    //    item already stores for a number with no factors to cite, and
    //    RARITY_UNITY is what distinguishes 1 from a composite whose
    //    factorization failed to arrive.
    createMessage({
        bounce: BounceMode.RichBounce,
        value: ITEM_DEPLOY_VALUE,
        dest: configA.collectionAddr,
        body: (MintItem {
            queryId: msg.queryId,
            n: UNITY_N,
            owner: msg.owner,
            isPrime: 0,
            factorization: beginCell().endCell(),
            rarityFlags: RARITY_UNITY,
            mintValue: ITEM_DEPLOY_VALUE,
            head: storage.head as uint64,
            heldSplit: null, // D-117: Unity pays no split, so nothing rides on it
            primeInit: null,
        }).toCell(),
    }).send(SEND_MODE_REGULAR);

    // 2. Open the market, if this deployment has one — ONE send, one
    //    `launched` flag (P2.A7). NoBounce: the handler is a single one-shot
    //    storage write with no way to fail that a retry would fix, and a
    //    bounced launch that silently re-closed the ledger is not a state
    //    this contract can represent anyway — the flag above is already
    //    committed. If it ever does fail to land, the fix is the
    //    permissionless `sync_launch` from anyone, not a rollback.
    if (d.peersSet == 0) { return; }
    createMessage({
        bounce: BounceMode.NoBounce,
        value: LAUNCH_HOP_GAS,
        dest: d.marketAddr,
        body: (LaunchOpenMarket { queryId: msg.queryId }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

// PERMISSIONLESS, and the counterpart to `sync_head`. `ignite`'s
// launch send is NoBounce; if it is lost to a peer that was out of gas
// or not yet deployed, the market stays closed while the ledger is
// open, and no admin key exists to fix it. This re-sends it. It is
// idempotent by construction — the receiver's handler is one-shot —
// and it can only ever OPEN something, never close it, because
// `launched` is asserted set before anything is sent. Same shape, same
// argument, same permissionlessness as `sync_head` above.
//
// P2.A7: one send, so the funding assert drops from 3× to 1× the hop.
//
// The send CARRIES the caller's value (mode 64) rather than paying the hop
// from this balance: a caller who attached exactly `LAUNCH_HOP_GAS` used to
// leave the ledger paying this handler's compute, and anyone could repeat that
// for ever. Now the caller pays the compute and the hop, the ledger nothing.
@inline
fun handleSyncLaunch(valueCoins: coins, msg: SyncLaunch) {
    var storage = lazy Storage.load();
    val d = loadConfigD(storage);
    val meters = loadMeters(storage);
    assert (meters.launched == 1) throw 212;  // ledger_not_launched
    assert (d.peersSet == 1) throw 233;       // ledger_sinks_unset
    assert (valueCoins >= LAUNCH_HOP_GAS) throw 103; // insufficient_value
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: d.marketAddr,
        body: (LaunchOpenMarket { queryId: msg.queryId }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// CONCEPT §6 point 3: founder capital seeds `T`/`S` and D-20 opens the
// line at the first composite. One-shot, and only ever legal on a virgin
// ledger — see the assertions below for why that is a throw and not a
// merge.
@inline
fun handleGenesisSeed(senderAddress: address, msg: GenesisSeed) {
    var storage = lazy Storage.load();
    val b = loadConfigB(storage);
    var meters = loadMeters(storage);
    assert (senderAddress == b.genesisScriptAddr) throw 100; // wrong_sender
    assert (meters.genesisSeeded == 0) throw 104; // already_processed
    // THE TWO BELOW ACCUMULATE. They used to be assignments guarded by
    // `assert (storage.T == 0 && storage.S == 0)`, on the reasoning that an
    // assignment onto accrued backing would silently ERASE it, so a virgin
    // ledger should be required and a mis-ordered genesis should fail loudly.
    //
    // It failed loudly at the wrong thing. `T` does not need a mint to become
    // non-zero: `handleRoyaltyToRatchet` raises it on any TEP-66 royalty, and
    // the collection sweeps GRAM that merely ARRIVES at it. So any stranger
    // who sends the numbers collection a fraction of a GRAM
    // between its deploy and this message makes the seed throw 104 and the
    // genesis unrecoverable — the assert can never be satisfied again, on a
    // ledger that cannot be re-deployed to the same address. On testnet a
    // faucet-spam bot did exactly that, unprompted, within four minutes
    // (2026-09-19, genesis `20260923`); on mainnet it is a one-shot griefing
    // vector against genesis itself, for the price of one message.
    //
    // Accumulation removes the hazard the assert was protecting against
    // instead of detecting it: early backing is ADDED TO, never overwritten.
    // The one-shot guarantee is unaffected because it never came from these
    // values — `meters.genesisSeeded` above is the flag, it is set at the end
    // of this handler, and it is what makes a second seed throw 104.
    storage.T += msg.seedT;
    // D-26: the same number, kept as its own term so `T = seedT + swapped +
    // pending` is checkable from get-methods alone. The assert above makes
    // THIS handler one-shot on a virgin ledger; `seedT` itself keeps moving,
    // because D-91 point 4's donation op adds to it every time it is called.
    // `seedT` is an ASSIGNMENT and stays one: it is the founder-capital TERM of
    // D-26's `T = seedT + swapped + pending`, not a running total of `T`. A
    // royalty that arrived early is already counted in `pending` — the ledger
    // forwarded it to the ratchet when it credited `T` — so adding it here too
    // would double-count it and break the identity this term exists to make
    // checkable.
    storage.seedT = msg.seedT;
    storage.S += msg.seedS;
    assert (storage.S <= S_MAX) throw 102; // malformed_body — D-156: genesis may not seed past the cap
    // D-20: open the line at the FIRST COMPOSITE (n = 4), recording
    // every prime below it in the bitmap — verified locally by MR, not
    // trusted from a supplied list — and marking each one unsold, since
    // nothing has sold yet. At genesis this walk crosses exactly 2 and
    // 3, matching CONCEPT §6 point 1: "after Unity, 2 and 3 both open
    // at once... 4 is the next number available to build."
    if (msg.seedHead > storage.head) {
        var i = storage.head;
        while (i < msg.seedHead) {
            if (isPrimeMR(i)) {
                markUnsoldPrime(mutate storage, i);
                storage.primesCount += 1; // §3.2: an eligible prime shares the flat dividend too
                // §3.2's `entry[p] = div_acc`, held on its unsold row (D-188).
                meters.unsoldPrimes.set(i as uint256, storage.divAcc);
            }
            i += 1;
        }
        storage.head = msg.seedHead;
    }
    meters.genesisSeeded = 1;
    saveMeters(mutate storage, meters);
    storage.save();
}

// D-20: this message now carries ONLY the premium above MINT_PRICE
// — see the struct header. D-114 (amends D-7): the premium is no longer a
// pure floor step in full. It splits `PREMIUM_TREASURY_BPS` / remainder
// between the governed treasury contract and the ratchet — only the ratchet
// half raises `T`; the treasury half leaves `T = seeded + swapped + pending`
// entirely, the same way a forfeit's treasury share already does. `S` is
// untouched by either half: nobody is minted or credited.
@inline
fun handleClearingCleared(senderAddress: address, valueCoins: coins, msg: ClearingCleared) {
    var storage = lazy Storage.load();
    val d = loadConfigD(storage);
    assert (d.peersSet == 1) throw 233; // ledger_sinks_unset
    // P2.A7: ONE sender, fixed by the one-shot SetPeers and not changeable
    // afterwards. §4.2 and D-7/D-114: an auction premium takes the same route
    // and the same handler wherever it comes from, so there is no second
    // injection path — only the split at the end differs from a pure floor
    // step now.
    assert (senderAddress == d.marketAddr) throw 100; // wrong_sender
    // The clearing must arrive WITH its money, covering BOTH legs this
    // handler is about to send (the ratchet hop's gas margin plus the
    // treasury share). Crediting `T` against a message that did not carry
    // the GRAM would inflate the floor with backing the ratchet never
    // receives — the one way this handler could break the §5 ratchet
    // theorem, so it is an assert and not a clamp.
    assert (valueCoins >= msg.amount + RATCHET_HOP_GAS) throw 103; // insufficient_value

    // D-114: `treasuryShare` is SUBTRACTED to get `ratchetShare`, never a
    // second multiplication — the same no-dust-leak rule the forfeit split
    // uses below, so the two legs sum to `msg.amount` exactly for every
    // value.
    val treasuryShare: coins = msg.amount * PREMIUM_TREASURY_BPS / BPS_DEN;
    val ratchetShare: coins = msg.amount - treasuryShare;

    // `S` is deliberately untouched: a clearing is backing without
    // emission, which is exactly what makes it a pure floor step. Only the
    // ratchet's half is backing at all.
    storage.T += ratchetShare;
    storage.save();

    if (treasuryShare > 0) {
        val feeDests = loadConfigA(storage).feeDests.load();
        var meters = loadMeters(storage);
        var opMeters = meters.operatorMeters.load();
        // G81: a half below `RATCHET_HOP_GAS` is HELD, not sent -- it would land
        // `skipped (no_gas)`. The next mint's 5% send carries it (and counts it
        // into `premiumTreasuryPaidTotal` then), or the next premium that clears
        // the threshold does, whichever comes first.
        val treasuryDue: coins = opMeters.treasuryHeld + treasuryShare;
        val sendNow = treasuryDue >= RATCHET_HOP_GAS;
        if (sendNow) {
            opMeters.premiumTreasuryPaidTotal += treasuryDue;
            opMeters.treasuryHeld = 0;
        } else {
            opMeters.treasuryHeld = treasuryDue;
        }
        meters.operatorMeters = opMeters.toCell();
        saveMeters(mutate storage, meters);
        storage.save();
        // V18: PAY_FEES_SEPARATELY so the treasury receives EXACTLY
        // `treasuryShare` — under the default mode the forward fee comes out
        // of the value itself, so this leg landed 93935 nanoton short of the
        // 50/50 split D-114 promises (proved by FeeLines.spec.ts's
        // "D-114" case and PrimesMarket.spec.ts's RetryPremiumForward case,
        // both against `assert (valueCoins >= msg.amount + RATCHET_HOP_GAS)`
        // above, which already reserves the margin this fee is paid from).
        // Same fix, same reasoning as `primes_treasury.tolk`'s TonPayout send.
        if (sendNow) {
            createMessage({
                bounce: BounceMode.NoBounce,
                value: treasuryDue,
                dest: feeDests.treasuryAddr,
                body: beginCell().endCell(),
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        }
    }
    forwardToRatchet(storage, loadConfigB(storage), msg.queryId, ratchetShare);
}

// D-128 — the ratchet half of a TEP-66 secondary royalty.
//
// `handleClearingCleared`'s body without the market's door, and that is the whole
// design: a royalty is backing without emission, which makes it a pure floor step
// (§5). The split itself happens on the COLLECTION, which is what `royalty_params()`
// now points a marketplace at; this contract only receives the half that was
// already decided there and never sees the operator's half at all.
//
// WHY NOT `handleDonateFloor`. It credits `T` *and* mints PRIMES to its sender and
// raises `S`. Routed here that would emit supply to a collection contract against
// money nobody subscribed to the floor with — it would also make a royalty dilute
// rather than back. The two are one line apart in effect and opposite in meaning,
// so they are separate ops.
//
// THE DOOR IS ONE ADDRESS THIS CONTRACT ALREADY KNOWS, and it cannot be
// rotated: `ConfigA.collectionAddr`, deploy data. (The generators collection was
// a second door until DECISIONS.md D-202 deleted it.)
//
// Permissionless within that door: no key, no amount anyone else can
// name, and nothing leaves. §8 is untouched — this handler has no send but the
// ratchet hop every injection in this system already takes.
@inline
fun handleRoyaltyToRatchet(senderAddress: address, valueCoins: coins, msg: RoyaltyToRatchet) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    assert (senderAddress == configA.collectionAddr) throw 100;  // wrong_sender
    // The royalty must arrive WITH its money, for `handleClearingCleared`'s reason
    // exactly: crediting `T` against a message that did not carry the GRAM inflates
    // the floor with backing the ratchet never receives, which is the one way this
    // handler could break the §5 ratchet theorem. An assert, not a clamp.
    assert (valueCoins >= msg.amount + RATCHET_HOP_GAS) throw 103;  // insufficient_value
    assert (msg.amount > 0) throw 103;                             // insufficient_value

    // `S` is deliberately untouched. That is what a pure floor step is.
    storage.T += msg.amount;
    storage.save();
    forwardToRatchet(storage, loadConfigB(storage), msg.queryId, msg.amount);
}

// D-91 point 4: the pool's PRIMES side is minted HERE, not at genesis. Anyone
// may call it. `X` GRAM in; `T += X`, `S`
// rises by the emission computed below, and those PRIMES are minted to the
// sender, who pairs and burns on DeDust themselves (D-91 point 6 names that
// gap: the pair-and-burn is not atomic and cannot be, until a DeDust deposit
// wire format is verified — deviation D6).
//
// D-100 point 1 — `seedT` IS NOT TOUCHED HERE, AND THAT IS A BUG FIX, NOT A
// SIMPLIFICATION. D-91 point 4 specified two contradictory halves: a `seedT +=
// X` credit "so `T = seeded + swapped + pending` still closes", AND that the
// shape is `handleClearingCleared`'s — which forwards `X` to the ratchet, where
// `PoolInject` does `pending += X`. This contract implemented both, so every
// donation raised the identity's right-hand side by `2X` against `X` on the
// left, and the live testnet ratchet panel reported `beyond T 4.000 GRAM`
// against `seedT = 4.000 GRAM`: the alarm was right and the books were wrong.
//
// A donation lands in `pending`. `seedT` therefore means exactly what D-26 said
// and nothing else — capital credited STRAIGHT into `T` that never passes
// through the ratchet — which after D-100 is only the one-shot `genesis_seed`
// assignment. Anything that adds to `seedT` here is that double-count again.
//
// Incremental by construction, unlike `handleGenesisSeed`'s virgin-ledger
// assert: send 1 GRAM, verify, then send the rest. It takes money in and never
// out.
@inline
fun handleDonateFloor(senderAddress: address, valueCoins: coins, msg: DonateFloor) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    // No sender assert. That is the whole point of the op and it is D-91 point
    // 4's word: a stranger who calls this is donating backing to every holder.
    //
    // The donation must arrive WITH its money, for `handleClearingCleared`'s
    // reason exactly: crediting `T` against a message that did not carry the
    // GRAM inflates the floor with backing the ratchet never receives, which is
    // the one way this handler could break the §5 ratchet theorem.
    assert (valueCoins >= msg.amount + RATCHET_HOP_GAS + DONATE_MINT_GAS + CALLER_COMPUTE_GAS) throw 103; // insufficient_value
    assert (msg.amount > 0) throw 103; // insufficient_value

    // D-100 point 1: THE RATE IS CLAMPED TO THE FLOOR, and error 217 is gone.
    //
    //     emitted = min(X·L, X·S/T)          (X·L when T = 0)
    //
    // §5: `p_f = T/S` must not fall. A donation moves it from `T/S` to
    // `(T+X)/(S+E)`, which is a RISE only while `S·X >= T·E` — i.e. while
    // `p_f <= 1/L`. The old code THREW (217, `ledger_donation_would_dilute`)
    // once the floor passed `1/L`, on the ground that clamping would be this
    // contract inventing a rate (CLAUDE.md rule 3). D-91's own closing note
    // pre-approved the clamp as "the one-line change" if late donations were
    // ever wanted, and D-100 point 1 takes it: `X·S/T` is not an invented rate,
    // it is THE floor — a donation at the floor buys exactly what a redemption
    // at the floor would return, which is the only rate that neither dilutes
    // the holders nor overpays the donor. The 217 guard is deleted because the
    // clamp makes dilution unreachable by construction: there is no state in
    // which this handler can lower `p_f`, so there is nothing left to throw.
    // (Error 217 stays retired and unassigned — see `shared/opcodes.ts`.)
    //
    // ROUNDING IS DOWN, AND THAT DIRECTION IS LOAD-BEARING. `X·S/T` truncates,
    // so the floor after the donation is `(T+X)/(S+⌊X·S/T⌋) >= T/S` — equal
    // only when the division is exact, and above it otherwise. Rounding UP
    // would emit PRIMES the donation did not back, which is the one way this
    // handler could break the §5 ratchet theorem.
    //
    // ORDER AND OVERFLOW: multiply before dividing, exactly as the ratchet's
    // `computeMinOut` does and for the same reason — `(X/T)·S` truncates to
    // zero for any donation small against `T`, which would silently emit
    // nothing for a real donation. The largest intermediate is `X·S`, and
    // unlike `computeMinOut` this needs no operand assert to bound it: both
    // operands are `coins`, i.e. TL-B `VarUInteger 16`, so each is below
    // `2^120` BY ITS TYPE and the product is below `2^240` — two orders of
    // binary magnitude clear of the 257-bit signed ceiling. (`computeMinOut`
    // asserts because it multiplies CACHED copies of `T`/`S` that arrived in a
    // message; these are this contract's own storage fields.)
    var emitted = msg.amount * LP_RATIO_PRIMES_PER_TON;
    if (storage.T > 0 && storage.S > 0) {
        val atFloor = msg.amount * storage.S / storage.T;  // multiply first, divide once
        if (atFloor < emitted) {
            emitted = atFloor;
        }
    }
    // D-156: the logistic cap applies HERE TOO. This op is permissionless, so a
    // cap that skipped it would not be a cap at all — anyone could mint past
    // `S_MAX` through the donation door.
    emitted = storage.S < S_MAX ? emitted * (S_MAX - storage.S) / S_MAX : 0;
    // The taper alone does NOT bound `S`: `e·(S_MAX − S)/S_MAX <= S_MAX − S`
    // only while `e <= S_MAX`, and `e` grows with the donation, uncapped — a
    // donation past `max(S_MAX/L, p_f·S_MAX)` (120,000 GRAM at L) would carry
    // `S` over the cap. So the headroom itself is the last clamp. Emitting less
    // only raises `(T+X)/(S+E)`, so §5's floor guarantee is untouched.
    if (emitted > S_MAX - storage.S) {
        emitted = S_MAX - storage.S;
    }

    // A donation so small that the floor rate rounds it to nothing is refused
    // rather than silently taking the GRAM for zero PRIMES.
    //
    // D-156 CONSEQUENCE, STATED RATHER THAN DISCOVERED: once `S` reaches `S_MAX`
    // the taper drives `emitted` to zero and this op refuses PERMANENTLY. That
    // is correct — it exists to mint PRIMES against a donation, and past the cap
    // there are no PRIMES left to mint — but be clear about what it costs:
    // `handleRoyaltyToRatchet` is the only pure floor step in this contract and
    // it is NOT a fallback door, because it asserts its sender is one of two
    // fixed collection addresses (throw 100). So past the cap there is no
    // permissionless way to donate to the floor at all.
    //
    // D-156 ACCEPTS THAT rather than adding an op for it. Nobody loses money —
    // the assert throws, the message bounces, the GRAM goes home — and the cap
    // binds at a head around 4·10⁹, so an op built for it now would be built on
    // no information. If that day comes it is a new decision with real data,
    // not a speculative handler carried until then.
    assert (emitted > 0) throw 103; // insufficient_value

    storage.T += msg.amount;
    storage.S += emitted;
    storage.save();

    createMessage({
        bounce: BounceMode.RichBounce,
        value: DONATE_MINT_GAS,
        dest: configA.jettonMasterAddr,
        body: (JettonMint { queryId: msg.queryId, to: senderAddress, amount: emitted, forwardTonAmount: MINT_NOTIFY_TON }).toCell(),
    }).send(SEND_MODE_REGULAR);

    forwardToRatchet(storage, loadConfigB(storage), msg.queryId, msg.amount);
}

// D12: one-shot bootstrap of the market / bounty-vault addresses
// (circular address dependency, same as D7/D11). P2.A7: two writes
// and one cell, down from four writes across two cells.
@inline
fun handleSetPeers(senderAddress: address, msg: SetPeers) {
    var storage = lazy Storage.load();
    val b = loadConfigB(storage);
    var d = loadConfigD(storage);
    assert (senderAddress == b.genesisScriptAddr) throw 100; // wrong_sender
    assert (d.peersSet == 0) throw 104; // already_processed
    d.marketAddr = msg.marketAddr;
    d.bountyVaultAddr = msg.bountyVaultAddr;
    d.peersSet = 1;
    saveConfigD(mutate storage, d);
    storage.save();
}

// D-211 + D-215: the operator rewrites §4.1's invite terms. Moves no value; the
// only split term it touches is the invite line, and only inside INVITE_LINE_CAP.
// The comment is these words alone (`inviteComment`, D-215: no link).
@inline
fun handleSetInviteTerms(senderAddress: address, msg: SetInviteTerms) {
    var storage = lazy Storage.load();
    val feeDests = loadConfigA(storage).feeDests.load();
    assert (senderAddress == feeDests.operatorAddr) throw 100; // wrong_sender
    val s = msg.text.beginParse();
    val bits = s.remainingBitsCount();
    assert (s.remainingRefsCount() == 0 && bits % 8 == 0 && bits <= INVITE_TEXT_MAX_BYTES * 8) throw 237; // invite_text_bad
    assert (msg.value >= 1 && msg.count <= INVITE_COUNT_CEILING
            && msg.count * (msg.value + INVITE_SEND_FEE) <= INVITE_LINE_CAP) throw 238; // invite_terms_bad
    var aux = storage.aux.load();
    var config = aux.config.load();
    config.inviteCount = msg.count;
    config.inviteValue = msg.value;
    config.inviteText = msg.text;
    aux.config = config.toCell();
    storage.aux = aux.toCell();
    storage.save();
}

// CONCEPT §4.1 / §8. See the struct's header for why this is not a
// withdraw path. Permissionless: no sender check, deliberately.
@inline
fun handleSweepOps(valueCoins: coins, msg: SweepOps) {
    var storage = lazy Storage.load();
    var meters = loadMeters(storage);

    // P3.7: `getOriginalBalance()` is the balance at the START OF THE
    // COMPUTE PHASE, per the Tolk stdlib's own doc comment — and TVM
    // credits an inbound message's value to the account BEFORE compute
    // phase begins, so `getOriginalBalance()` already INCLUDES this
    // message's own `valueCoins`. It is "before gas is deducted", not
    // "before this message was credited" — the two were conflated here.
    // Left as written, the swept amount grew by however much margin the
    // permissionless caller happened to attach, handing their own gas
    // to the sweep (since D-117 it pays the ratchet pool, not the operator).
    // Subtracting `valueCoins` recovers the true
    // pre-message balance the comment always intended to sweep against.
    val liability = meters.tributeOwed + meters.unroutedHeld + meters.divOutstanding + feeHeld(meters) + OPS_RESERVE;
    val balance = contract.getOriginalBalance() - valueCoins;

    // Nothing to sweep is a no-op, NOT an error: a permissionless
    // function that throws when it has no work invites a caller to
    // treat the throw as a failure of the contract rather than as the
    // ordinary state. The reserve is not yet met far more often than
    // it is, especially early.
    if (balance > liability + SWEEP_GAS + RATCHET_HOP_GAS) {
        // D-117 (owner, 2026-09-22): the surplus goes to the POOL. `T` rises by
        // exactly what `pending` will, `S` does not move (no emission), and the
        // hop's own RATCHET_HOP_GAS is left out of the amount so the ratchet's gas
        // buffer pays for nothing it did not receive.
        val sweepable: coins = balance - liability - SWEEP_GAS - RATCHET_HOP_GAS;
        storage.T += sweepable;
        forwardToRatchet(storage, loadConfigB(storage), msg.queryId, sweepable);
        // Cumulative, lifetime: the gas & ops surplus returned to the pool.
        var opMeters = meters.operatorMeters.load();
        opMeters.opsSweptTotal += sweepable;
        meters.operatorMeters = opMeters.toCell();
        saveMeters(mutate storage, meters);
        storage.save();
    }
}

// D-45 / D-196: the market reports a lot OPENED on `n` (sent from `open_lot`
// for either kind, and from `open_head_lot`). This contract is the one record of
// which numbers a lot has ever claimed, so it is also the uniqueness check:
//   - `n <= head`: the head has passed `n`. Only an UNSOLD PRIME may be listed
//     there — its descending lot at its turn, or an ascending prime lot the head
//     overtook before this mark landed. Anything else (a composite the head
//     minted in the race window, a prime already owned) is refused.
//   - `n > head`, block below the frontier: refused if already claimed, else
//     the bit is set here.
//   - `n > head`, the block being imported: refused. Its words are in flight,
//     so "already claimed?" has no answer this transaction; the opener retries.
//   - `n > head`, block beyond the frontier: forwarded to that block's lot-block
//     child, which sets the bit or answers `lot_block_refused`.
// A refusal replies `mark_rejected`, which cancels the just-opened lot and
// refunds its bid less the failed open's gas, and carries `head`.
fun replyMarkRejected(dest: address, queryId: int, n: int, head: int) {
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: dest,
        body: (MarkRejected { queryId: queryId, n: n, head: head }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

@inline
fun handleMarkOffHead(senderAddress: address, msg: MarkOffHead) {
    var storage = lazy Storage.load();
    val d = loadConfigD(storage);
    assert (d.peersSet == 1) throw 101;               // wrong_opcode (no market configured)
    assert (senderAddress == d.marketAddr) throw 100; // wrong_sender
    if (msg.n <= storage.head) {
        if (!isUnsoldPrime(storage, msg.n)) {
            replyMarkRejected(senderAddress, msg.queryId, msg.n, storage.head);
        }
        return;
    }
    var aux = storage.aux.load();
    val (block, _bit) = bitmapChunkAndBit(msg.n);
    if (block < aux.lotFrontier()) {
        if (isOffHeadIn(aux.offHeadBitmap, msg.n)) {
            replyMarkRejected(senderAddress, msg.queryId, msg.n, storage.head);
            return;
        }
        val (chunk, bit) = bitmapChunkAndBit(msg.n);
        val look = aux.offHeadBitmap.get(chunk);
        val word: uint256 = look.isFound ? look.loadValue() : 0;
        aux.offHeadBitmap.set(chunk, word | (1 << bit));
        storage.aux = aux.toCell();
        storage.anyOffHead = 1; // D-45 gas fix — see the field's own comment on `Storage`
        storage.save();
        return;
    }
    if (block == aux.importingBlock) {
        replyMarkRejected(senderAddress, msg.queryId, msg.n, storage.head);
        return;
    }
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: lotBlockStateInit(loadConfigA(storage).lotBlockCode, block),
        body: (LotBlockClaim { queryId: msg.queryId, n: msg.n }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// D-198, PERMISSIONLESS and caller-funded: moves up to FLUSH_MAX_ROWS of block
// `unsoldFlushed`'s unsold rows to its lot block once the head has left the
// block, and advances the cursor when none of the block's rows is left. Every unsold prime's §3.2 bookmark and §6 point 2 counter moves EXACT:
// nothing is recomputed, so the buyer's entitlement and `divOutstanding` are
// untouched. A block with no unsold prime (every prime in it sold) sends nothing.
@inline
fun handleFlushUnsold(valueCoins: coins, msg: FlushUnsold) {
    var storage = lazy Storage.load();
    assert (valueCoins >= FLUSH_UNSOLD_VALUE) throw 103; // insufficient_value
    var aux = storage.aux.load();
    val block = aux.unsoldFlushed;
    val firstN = lotBlockFirstN(block);
    val endN = lotBlockFirstN(block + 1);
    assert (endN <= storage.head) throw 234; // ledger_lot_block_not_due: the head is still in it
    var meters = aux.meters.load();
    var rows = createEmptyMap<uint8, UnsoldBookmark>();
    var any = false;
    var moved = 0;
    var r = meters.unsoldPrimes.findKeyGreaterOrEqual(firstN as uint256);
    while (r.isFound && (r.getKey() as int) < endN && moved < FLUSH_MAX_ROWS) {
        val p = r.getKey() as int;
        val f = meters.forfeited.get(p as uint256);
        val forfeitedSoFar: coins = f.isFound ? f.loadValue() : 0;
        rows.set(((p - 2) & 255) as uint8, UnsoldBookmark { entry: r.loadValue(), forfeited: forfeitedSoFar });
        any = true;
        r = meters.unsoldPrimes.findKeyGreater(p as uint256);
        meters.unsoldPrimes.delete(p as uint256);
        if (f.isFound) { meters.forfeited.delete(p as uint256); }
        moved += 1;
    }
    // Done with the block only when no row of it is left; else the next call
    // continues it (the lot block merges each batch).
    val blockDone = !r.isFound || (r.getKey() as int) >= endN;
    if (blockDone) { aux.unsoldFlushed = block + 1; }
    aux.meters = meters.toCell();
    storage.aux = aux.toCell();
    storage.save();
    if (any) {
        createMessage({
            // A refusal returns the rows (`onBouncedMessage` puts them back here,
            // where the sale finds them first).
            bounce: BounceMode.RichBounce,
            value: LOT_BLOCK_BOOKMARKS_VALUE,
            dest: lotBlockStateInit(loadConfigA(storage).lotBlockCode, block),
            // queryId = the BLOCK: the rows carry only n's bit, and a bounce needs the base.
            body: (LotBlockBookmarks { queryId: block, rows: rows }).toCell(),
        }).send(SEND_MODE_REGULAR);
    }
}

// D-198: the lot block's answer to `lot_block_release` — a flushed prime sold,
// and this is its bookmark. Sent straight on to the item as the first
// `claim_dividend` would send it (LOW-3): parking it in `soldAheadEntry` until a
// claim nobody is obliged to send gave that map an inflow per sold flushed prime.
// Only a refusal parks it (the item not populated yet — its `MintItem` raced this
// round trip, or bounced into `retry_item`'s lane): the `CreditDividend` bounce arm.
// The reply carries the release hop's change, so the 0.01 comes out of the value
// LOT_BLOCK_RELEASE_VALUE took from this contract's float.
@inline
fun handleLotBlockBookmark(senderAddress: address, msg: LotBlockBookmark) {
    val storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    val (block, _bit) = bitmapChunkAndBit(msg.n);
    assert (senderAddress == lotBlockAddress(configA.lotBlockCode, block)) throw 100; // wrong_sender
    createMessage({
        bounce: BounceMode.RichBounce,
        value: CLAIM_DIVIDEND_MIN_VALUE,
        dest: itemAddress(configA, msg.n),
        body: (CreditDividend { queryId: msg.queryId, p: msg.n, divAcc: storage.divAcc, base: msg.entry }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

// D-196, PERMISSIONLESS and caller-funded: pulls the frontier block's marks in
// from its lot-block child, once the block starts below `head + window`. One
// round trip at a time. The request carries the child's state init, so a block
// no lot ever touched is deployed empty and answers like any other — an answer
// is never inferred from a bounce. A real bounce (the child refused) only clears
// `importingBlock`, so the import can be retried. While one is in flight, a call
// RE-SENDS it to the same block: the child keeps its words and answers again, so
// an answer the ledger failed to process (gas, the cell cap) is not a freeze.
@inline
fun handleImportLotBlock(valueCoins: coins, msg: ImportLotBlock) {
    var storage = lazy Storage.load();
    assert (valueCoins >= IMPORT_LOT_BLOCK_VALUE) throw 103; // insufficient_value
    var aux = storage.aux.load();
    val block = aux.lotFrontier();
    if (aux.importingBlock == 0) {
        assert (lotBlockFirstN(block) < storage.head + LOT_BLOCK_WINDOW_BLOCKS * 256) throw 234; // ledger_lot_block_not_due
        aux.importingBlock = block;
        storage.aux = aux.toCell();
        storage.save();
    }
    createMessage({
        bounce: BounceMode.RichBounce,
        value: 0,
        dest: lotBlockStateInit(loadConfigA(storage).lotBlockCode, block),
        body: (LotBlockImport { queryId: msg.queryId }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// D-196: the import's answer. The child keeps its words, so a failure here is
// recovered by re-sending `import_lot_block`; a duplicate answer throws 104. The claim word
// joins `offHeadBitmap`, the sold-prime word `primeBitmap` — exactly the bits the
// same lots would have set had the block been local. What the answer carried
// stays in the gas float (`sweep_ops` returns any surplus to the pool).
@inline
fun handleLotBlockWords(senderAddress: address, msg: LotBlockWords) {
    var storage = lazy Storage.load();
    assert (senderAddress == lotBlockAddress(loadConfigA(storage).lotBlockCode, msg.block)) throw 100; // wrong_sender
    var aux = storage.aux.load();
    assert (msg.block == aux.importingBlock) throw 104; // already_processed
    if (msg.claimed != 0) {
        val look = aux.offHeadBitmap.get(msg.block);
        val word: uint256 = look.isFound ? look.loadValue() : 0;
        aux.offHeadBitmap.set(msg.block, word | msg.claimed);
        storage.anyOffHead = 1;
    }
    if (msg.soldPrime != 0) {
        var w = primeWordsAt(storage, msg.block);
        w.marks |= msg.soldPrime;
        storage.primeBitmap.set(msg.block, w);
    }
    aux.importingBlock = 0;
    aux.lotBlocksImported += 1;
    storage.aux = aux.toCell();
    storage.save();
}

// D-196: a lot block refused a claim (the bit was already set). Relayed to the
// market as `mark_rejected` with the real head, exactly as a local refusal is.
@inline
fun handleLotBlockRefused(senderAddress: address, msg: LotBlockRefused) {
    val storage = lazy Storage.load();
    val (block, _bit) = bitmapChunkAndBit(msg.n);
    assert (senderAddress == lotBlockAddress(loadConfigA(storage).lotBlockCode, block)) throw 100; // wrong_sender
    replyMarkRejected(loadConfigD(storage).marketAddr, msg.queryId, msg.n, storage.head);
}

// PERMISSIONLESS (engineering-spec §2.5): pushes the ledger's real head
// into the market's lagging `headHint`, the one head cache that exists.
// Cannot change any ledger state — it only reads `head` and forwards it,
// and the recipient can do nothing with it but raise its own cache. The
// send carries all remaining value, so a caller who overpays funds the market.
@inline
fun handleSyncHead(valueCoins: coins, msg: SyncHead) {
    val storage = lazy Storage.load();
    val d = loadConfigD(storage);
    assert (d.peersSet == 1) throw 101; // wrong_opcode
    assert (valueCoins >= HEAD_SYNC_GAS) throw 103; // insufficient_value
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: d.marketAddr,
        body: (HeadUpdate { queryId: msg.queryId, head: storage.head }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

// D-189, PERMISSIONLESS: finishes a head-advance walk a mint left unfinished
// (`walkPending`), one gas-bounded stretch per call. A no-op when nothing is
// pending, so a keeper racing a mint loses only gas. Whatever the walk does not
// burn rides back to the caller. Moves no GRAM and mints nothing: it does
// exactly the bookkeeping the mint that stopped would have done.
@inline
fun handleAdvanceHead(senderAddress: address, valueCoins: coins, msg: AdvanceHead) {
    var storage = lazy Storage.load();
    assert (valueCoins >= ADVANCE_HEAD_VALUE) throw 103; // insufficient_value
    if (storage.walkPending == 1) {
        var aux = storage.aux.load();
        var meters = aux.meters.load();
        var aux2 = aux.aux2.load();
        if (walkHead(mutate storage, mutate meters, mutate aux2, aux.offHeadBitmap,
                     aux.walkLimitN(), storage.head)) {
            aux.aux2 = aux2.toCell();
        }
        aux.meters = meters.toCell();
        storage.aux = aux.toCell();
        storage.save();
    }
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: senderAddress,
        body: beginCell().storeUint(0, 32).storeUint(msg.queryId, 64).endCell(),
    }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);

    match (msg) {
        CardMint => { handleCardMint(in.senderAddress, in.valueCoins, msg); }
        CardRecruitCounted => { handleCardRecruitCounted(in.senderAddress, msg); }
        LedgerClaimTribute => { handleClaimTribute(in.senderAddress, msg); }
        ClaimDividend => { handleClaimDividend(in.valueCoins, msg); }
        DividendCredited => { handleDividendCredited(in.senderAddress, msg); }
        MintItemRefused => { handleMintItemRefused(in.senderAddress, msg); }
        RetryCredit => { handleRetryCredit(in.valueCoins, msg); }
        RetryMint => { handleRetryMint(in.valueCoins, msg); }
        SetSinks => { handleSetSinks(in.senderAddress, msg); }
        Ignite => { handleIgnite(in.senderAddress, in.valueCoins, msg); }
        SyncLaunch => { handleSyncLaunch(in.valueCoins, msg); }
        GenesisSeed => { handleGenesisSeed(in.senderAddress, msg); }
        ClearingCleared => { handleClearingCleared(in.senderAddress, in.valueCoins, msg); }
        RoyaltyToRatchet => { handleRoyaltyToRatchet(in.senderAddress, in.valueCoins, msg); }
        DonateFloor => { handleDonateFloor(in.senderAddress, in.valueCoins, msg); }
        // THE ONE ARM THAT STAYS INLINE, and it is a measurement, not an
        // oversight. Extracted like its neighbours this path costs ~1000 more
        // gas (34182 -> 35333 on `ledger.settle_prime_clearing`, +3.4%) because
        // the `executeMint` call below is reached through one more frame;
        // inline it lands at +161, in line with every other row. D-20's prime
        // purchase is a real player path, so the readability of one arm loses
        // to the gas on it. Everything else about it is unchanged.
        SettlePrimeClearing => {
            // D-20: a descending prime lot's sale, reported directly by the
            // market. An unconditional, off-head mint that runs the ordinary §4.1
            // split on the nominal MINT_PRICE (CONCEPT §6 point 1). The
            // seventh, invite line (D-101) is zero here and on every settle
            // path: an invite is something a MINTER funds out of their own
            // 1 GRAM, and this message carries no list to fund one with.
            var storage = lazy Storage.load();
            val configA = loadConfigA(storage);
            val d = loadConfigD(storage);
            var meters = loadMeters(storage);
            assert (d.peersSet == 1) throw 101;                  // wrong_opcode (no market configured)
            assert (meters.launched == 1) throw 212;             // ledger_not_launched
            assert (in.senderAddress == d.marketAddr) throw 100; // wrong_sender
            assert (in.valueCoins >= MINT_PRICE) throw 103;      // insufficient_value

            executeMint(mutate storage, mutate meters, configA, msg.queryId, msg.n, 1,
                        createEmptyMap<uint8, FactorEntry>(), msg.referralKey,
                        msg.beneficiary, msg.beneficiary, false, false, false, false, 0,
                        NO_STANDING, false);

            // §6 point 2: the prime is no longer unsold — `executeMint` deleted
            // its row and handed the bookmark and forfeit counter to the item.
            meters.primesSoldCount += 1;
            saveMeters(mutate storage, meters);
            storage.save();

            // GAUNTLET V9: the SAME ack `handleSettle` already sends on the
            // composite path, now sent here too. Reusing `SettleConfirmed`
            // rather than a new message — its shape (`queryId`, `n`) already
            // fits a prime clearing exactly. Before this, a prime sale never
            // acknowledged success at all, and the market's `closeLot` sent
            // the sale's premium unconditionally, in the same transaction as
            // this settle — so a settle that bounced (out of gas, `launched`
            // somehow false) had already lost the premium to the ratchet with
            // no way back. The market now withholds the premium until this
            // ack arrives, so this send is what makes it safe to release.
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 15000000, // 0.015 GRAM, same figure `handleSettle` uses
                dest: in.senderAddress,
                body: (SettleConfirmed { queryId: msg.queryId, n: msg.n }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }
        SetPeers => { handleSetPeers(in.senderAddress, msg); }
        SweepOps => { handleSweepOps(in.valueCoins, msg); }
        MarkOffHead => { handleMarkOffHead(in.senderAddress, msg); }
        SyncHead => { handleSyncHead(in.valueCoins, msg); }
        AdvanceHead => { handleAdvanceHead(in.senderAddress, in.valueCoins, msg); }
        ImportLotBlock => { handleImportLotBlock(in.valueCoins, msg); }
        LotBlockWords => { handleLotBlockWords(in.senderAddress, msg); }
        LotBlockRefused => { handleLotBlockRefused(in.senderAddress, msg); }
        FlushUnsold => { handleFlushUnsold(in.valueCoins, msg); }
        LotBlockBookmark => { handleLotBlockBookmark(in.senderAddress, msg); }
        MintWonLot => { handleSettle(in.senderAddress, in.valueCoins, msg); }
        MintConfirmed => { handleMintConfirmed(in.senderAddress, msg); }
        RetryItem => { handleRetryItem(in.valueCoins, msg); }
        SetInviteTerms => { handleSetInviteTerms(in.senderAddress, msg); }
        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

// D8: the whole mint, in one message. The `n != head` branch is the surviving
// half of CONCEPT §8's race guarantee — two mints for the same head land in some
// order, the second one refunds in full, so losing a race costs gas and never
// principal.
//
// D-191 point 1: the mint arrives FROM THE BENEFICIARY'S MINTER CARD, never from
// a wallet. The card is authenticated by its derived address, which is what
// makes its `owner`, `payer`, standing and `fresh` flag trustworthy.
fun handleCardMint(senderAddress: address, valueCoins: coins, card: CardMint) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    assert (senderAddress == cardAddress(configA.cardCode, card.owner)) throw 100; // wrong_sender
    val msg = card.mint.load();
    val payer = card.payer;
    var meters = loadMeters(storage);

    // CONCEPT §6 point 0: the game has not started. Checked BEFORE the head
    // race below, because a mint that arrives pre-launch is not a lost race and
    // must not be answered with the race's silent refund — it is a wrong-state
    // error and the sender should see it as one.
    assert (meters.launched == 1) throw 212; // ledger_not_launched

    // D-189: while a walk is pending, `head` is a position the walk has not
    // crossed yet (a prime or an auctioned number) — not mintable. Same refund.
    if (msg.n != storage.head || storage.walkPending == 1) {
        // lost the race for this number: cheap-fail, refund the attached mint
        // value minus gas, never burned or kept.
        //
        // D-191 point 1: the refund rides back THROUGH THE CARD, which gives the
        // window units this mint took back before passing the GRAM on to the payer.
        // Carry-all, so this transaction's gas comes out of the refunded value and
        // a lost race costs the ledger's balance nothing (GAUNTLET V6's rule; the
        // fixed LOST_RACE_GAS deduction that enforced it is deleted — the mode
        // charges the real gas instead of an estimate of it).
        createMessage({
            bounce: BounceMode.NoBounce,
            value: 0,
            dest: senderAddress,
            body: (CardMintRefunded { queryId: msg.queryId, payer: payer, state: card.state, fresh: card.fresh }).toCell(),
        }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        return;
    }

    // D-191 point 1: the card refused anything under MINT_PRICE before forwarding,
    // and its own compute and forward fee come out of that — the 1 GRAM is all-in,
    // so the hop is paid by §4.1's gas & ops line, like every other hop of a mint.
    // CARD_HOP_ALLOWANCE bounds how much: a body padded to make the forward dear
    // arrives short and is refused here, and the card gives the standing back.
    assert (valueCoins + CARD_HOP_ALLOWANCE >= MINT_PRICE) throw 103; // insufficient_value
    // D12/D-45: a number an auction took off the line mints only through its
    // lot's close (`mint_won_lot`), never through a direct mint (error 209).
    assert (!isOffHead(storage, msg.n)) throw 209; // ledger_number_off_head

    // D-109: refund a mint's overpayment above the declared margin. The split
    // below always runs on the nominal MINT_PRICE, never on `valueCoins`, so
    // anything sent beyond MINT_PRICE + MINT_MARGIN was never going anywhere
    // but the gas-&-ops sweep (to the pool since D-117) — indistinguishable on chain from a
    // normal padded send. A send within the margin (the webapp's own padding,
    // or `smokeMintLive.ts`'s) is untouched.
    if (valueCoins > MINT_PRICE + MINT_MARGIN) {
        refund(payer, valueCoins - MINT_PRICE - MINT_MARGIN, msg.queryId);
    }

    // §4.1's SEVENTH LINE (D-202), and the only path that can fund it: an
    // invite is something a MINTER buys with their own 1 GRAM, so no settlement
    // or clearing path carries one. The minter names the recipients; there is
    // no signature to check, because nothing in the transfer is minter-written
    // but the destination -- the comment is `inviteComment`: the operator's
    // words (D-211) and nothing else (D-215).
    // A mint with inviteCount == 0 pays nothing and never loads the terms.
    var inviteSpend: coins = 0;
    val listRef = msg.invites;
    if (msg.inviteCount > 0) {
        val terms = loadInviteConfig(storage);
        assert (msg.inviteCount <= terms.inviteCount) throw 221; // invite_count_over_max
        if (listRef != null) {
            val addresses = listRef!.load().addresses;
            // Built once: every slot of this mint carries the same text.
            val comment = inviteComment(terms.inviteText);

            // One plain transfer per FUNDED slot; a slot the dictionary has no
            // address for is skipped, and its share is simply never deducted
            // below -- that is the whole of "unspent slots fall to beta",
            // implemented by subtraction that does not happen rather than by a
            // refund that would have to be routed somewhere.
            //
            // NoBounce, so a Telegram wallet that is not deployed yet still receives
            // it (an uninit account keeps the value of a non-bounceable message).
            // PAY_FEES_SEPARATELY (D-215): the forward fee comes off this balance, so
            // the invitee receives `inviteValue` whole. The line pays for it out of
            // its own INVITE_SEND_FEE per transfer, deducted below with the value, so
            // the gas & ops line carries none of it.
            //
            // Sent from here rather than from `executeMint` because it is a
            // mint-message-only line: a throw anywhere later in this transaction
            // discards these messages along with every other effect.
            var slot = 1;
            var sent = 0;
            while (slot <= msg.inviteCount) {
                val look = addresses.get(slot as uint7);
                if (look.isFound) {
                    val invitee = look.loadValue();
                    // Audit R2-L1 (2026-11-19): BASECHAIN ONLY, refused HERE. A send to a
                    // workchain that does not exist fails in the ACTION phase (code 36):
                    // the transaction aborts with no bounce, the ledger keeps the payer's
                    // 1 GRAM and the card never gets its standing back. A compute-phase
                    // throw bounces to the card, which gives back and refunds. It also
                    // discards the transfers already queued above, so checking in the
                    // loop is checking every slot before anything is kept. Masterchain is
                    // refused by choice, not need: a -1 invitee was delivered before this.
                    assert (invitee.getWorkchain() == BASECHAIN) throw 236; // invite_bad_workchain
                    createMessage({
                        bounce: BounceMode.NoBounce,
                        value: terms.inviteValue,
                        dest: invitee,
                        body: comment,
                    }).send(SEND_MODE_REGULAR | SEND_MODE_PAY_FEES_SEPARATELY);
                    sent += 1;
                }
                slot += 1;
            }
            // Exact integer multiple of nanoGRAM figures -- no division, so unlike
            // the tribute lines this one leaves no remainder to fold into the pool.
            inviteSpend = sent * (terms.inviteValue + INVITE_SEND_FEE);
            // INVITE_LINE_CAP holds here too, not only at the setter: the bound is a
            // property of every mint, whatever terms a deploy wrote.
            assert (inviteSpend <= INVITE_LINE_CAP) throw 238; // invite_terms_bad

            var opMeters = meters.operatorMeters.load();
            opMeters.inviteSlotsFunded += msg.inviteCount;
            opMeters.inviteTransfersSent += sent;
            opMeters.inviteValuePaid += sent * terms.inviteValue;
            meters.operatorMeters = opMeters.toCell();
        }
    }

    executeMint(mutate storage, mutate meters, configA, msg.queryId, msg.n, msg.kind,
                msg.factors, msg.referralKey, card.owner,
                payer, true, true, false, true, inviteSpend, card.state, card.fresh);

    saveMeters(mutate storage, meters);
    storage.save();
}

// D-191 point 1: a payer's card reports its era tally after a recruit credit.
// The running max is kept HERE, on a STRICT `>` (the first wallet to reach the
// winning count keeps the lead). A tally taken under an earlier `eraSeq` is
// dropped: the ceremony that ended that era has already awarded it, and the
// recruit it carries belongs to that era, not to this one (CONCEPT §4.7). What
// the reply carries stays on this balance — it is what was left of the hop.
fun handleCardRecruitCounted(senderAddress: address, msg: CardRecruitCounted) {
    var storage = lazy Storage.load();
    assert (senderAddress == cardAddress(loadConfigA(storage).cardCode, msg.owner)) throw 100; // wrong_sender
    var meters = loadMeters(storage);
    var season = meters.eraSeason.load();
    if (msg.eraSeq != season.eraSeq || msg.eraRecruits <= season.leaderCount) { return; }
    season.leaderCount = msg.eraRecruits;
    season.leader = msg.owner as any_address;
    meters.eraSeason = season.toCell();
    saveMeters(mutate storage, meters);
    storage.save();
}

// D12/D-45/D-90: an ascending composite lot's close MINTS the number here, in
// the closing transaction. Sender must be the market's fixed address; the mint
// executes at k = k_min (CONCEPT §4.4 point 3). OFF-HEAD, like
// `SettlePrimeClearing`: `advanceHead` is `false`, because the head's own walk
// already skips an off-head composite whenever it reaches it. `n` must carry
// its `isOffHead` bit (set at `open_lot`, never cleared).
fun handleSettle(senderAddress: address, valueCoins: coins, msg: MintWonLot) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    val d = loadConfigD(storage);
    var meters = loadMeters(storage);
    assert (d.peersSet == 1) throw 101; // wrong_opcode (no market configured)
    // §6 point 0. Unreachable in practice — the market refuses to open a lot
    // before launch (509) — and asserted anyway, because "the ledger
    // cannot mint before launch" should be a property of the ledger's own code
    // rather than of a peer's.
    assert (meters.launched == 1) throw 212;                   // ledger_not_launched
    assert (senderAddress == d.marketAddr) throw 100; // wrong_sender
    // D-196: checkable only below the import frontier. Beyond it the claim is on
    // a lot-block child, and the market's authenticated sender is the check — as
    // D13 already trusts it for primality.
    val settleAux = storage.aux.load();
    if (bitmapChunkAndBit(msg.n).0 < settleAux.lotFrontier()) {
        assert (isOffHeadIn(settleAux.offHeadBitmap, msg.n)) throw 200; // ledger_not_auctioned
    }
    assert (valueCoins >= MINT_PRICE) throw 103; // insufficient_value

    executeMint(mutate storage, mutate meters, configA, msg.queryId, msg.n, msg.kind,
                msg.factors, msg.referralKey, msg.beneficiary, msg.beneficiary, false, false, true,
                false, 0, NO_STANDING, false);
    // `getLaunch()`'s item count: a lot's close mints an NFT exactly as the head
    // does, and was counted by neither meter (2026-11-08 audit). Kind 1 is a prime.
    if (msg.kind == 1) {
        meters.primesSoldCount += 1;
    } else {
        meters.compositesMinted += 1;
    }
    saveMeters(mutate storage, meters);
    storage.save();

    // Confirm back to the market, which releases the lot's premium on it
    // (GAUNTLET V9). No `HeadUpdate` follows (D-45): this path does not move
    // `head`, so there is nothing new to announce.
    createMessage({
        bounce: BounceMode.NoBounce,
        // 0.015 GRAM, sized when the confirmation was two hops (market + the
        // shard D-90 deleted). Shrinking it is a gas-budget question for
        // `GasRegression.spec.ts`, not a comment fix.
        value: 15000000,
        dest: senderAddress,
        body: (SettleConfirmed { queryId: msg.queryId, n: msg.n }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

// §3.4 B1: the ONE place GRAM leaves the ledger as pool backing. Every caller
// routes through here, so "what can move the pool" is a single grep. The value
// carried is `amount + RATCHET_HOP_GAS`; the ratchet credits `pending` by the
// nominal `amount` field only and keeps the surplus as its own gas buffer.
fun forwardToRatchet(storage: Storage, b: ConfigB, queryId: int, amount: coins) {
    if (amount <= 0) { return; }
    assert (b.sinksSet == 1) throw 233; // ledger_sinks_unset
    createMessage({
        bounce: BounceMode.NoBounce,
        value: amount + RATCHET_HOP_GAS,
        dest: b.ratchetAddr,
        body: (PoolInject {
            queryId: queryId,
            amount: amount,
            tSnapshot: storage.T,
            sSnapshot: storage.S,
        }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

// D-117 — THE CONFIRMATION. Item(n) is populated, so the held split is paid
// now, from the value that rode back with this message. Everything below used
// to run inside `executeMint`, in the same transaction as the deploy, where a
// later bounce could not un-send it (GAUNTLET V17 point 2). V28: the ITEM sends
// it, from its own `Populate` — it used to be the collection, in the same
// transaction as the deploy, so a `Populate` that then threw left the split paid
// and no item. Now the split is paid iff the item exists, by construction.
fun handleMintConfirmed(senderAddress: address, msg: MintConfirmed) {
    var storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    val itemDefault = itemDefaultMutable(configA);
    val expected = itemAddressWith(configA, itemDefault, msg.n); // derived: the sender IS the key
    assert (senderAddress == expected) throw 100; // wrong_sender
    var aux = storage.aux.load();
    // V32: item(n) is populated, so a prime is no longer in flight.
    if (msg.isPrime == 1) {
        var aux2 = aux.aux2.load();
        aux2.deployingPrimes.delete(msg.n as uint256);
        aux.aux2 = aux2.toCell();
    }
    var meters = aux.meters.load();
    payHeldSplit(mutate meters, configA, itemDefault, msg.queryId, msg.heldSplit, aux.forfeitHeld, aux.unsoldFlushed);
    aux.forfeitHeld = 0;
    aux.meters = meters.toCell();
    storage.aux = aux.toCell();
    storage.save();
}

fun payHeldSplit(mutate meters: Meters, configA: ConfigA, itemDefault: Cell<ItemMutable>,
                 queryId: int, heldSplit: slice, heldForfeit: coins, unsoldFlushed: int) {
    var e = heldSplit;
    val referralKey = e.loadUint(1) == 1 ? e.loadUint(32) : 0;
    var count = e.loadUint(4);
    // Every item address this pays — up to omega(n) tribute credits and the
    // referral relay — shares the one address-determining `ItemMutable` the
    // caller already built to authenticate the receipt.

    // 2. tribute credits (CONCEPT §3.2.1). D-20 point 4: forfeited tribute (an
    // unsold prime's cited share) is ACCUMULATED and paid out below — never to
    // the ratchet pool, never to any NFT holder. D-100 point 6 makes that payout
    // TWO sends (`FORFEIT_TREASURY_BPS` to the governed treasury contract, the
    // remainder to the operator), which is why it is a total.
    //
    // D-196: `heldForfeit` is the forfeit a bounced credit decided since the last
    // confirmation (`Aux.forfeitHeld`) — a far factor with no item. It was still
    // declared in `tributeOwed`; it leaves that lane here and rides this forfeit.
    var forfeitTotal: coins = heldForfeit;
    // D-198: a forfeit on a prime whose block has been flushed has no per-prime
    // row here any more; it joins the unattributed aggregate (`getForfeited(p)`'s
    // per-prime figure for it stays frozen on its lot block).
    var forfeitUnattributed: coins = 0;
    meters.tributeOwed -= heldForfeit;
    while (count > 0) {
        val forfeits = e.loadUint(1) == 1;
        val p = e.loadCoins() as uint256; // p < n < 2^82, well inside Coins' 2^120
        val share = e.loadCoins();
        if (forfeits) {
            // CONCEPT §6 point 2 (D-20): while a prime is unsold — or, D-90.1,
            // not yet crossed by the head — its tribute is FORFEITED, never
            // accrued on the (nonexistent) item.
            forfeitTotal += share;
            // The cursor block flushes in batches: a row moved by an earlier
            // batch is gone from `unsoldPrimes` while the cursor still names it.
            val chunk = bitmapChunkAndBit(p).0;
            if (chunk < unsoldFlushed || (chunk == unsoldFlushed && !meters.unsoldPrimes.get(p).isFound)) {
                forfeitUnattributed += share;
            } else {
                val prior = meters.forfeited.get(p);
                val had: coins = prior.isFound ? prior.loadValue() : 0 as coins;
                meters.forfeited.set(p, had + share);
            }
        } else if (share > 0) {
            // D-60: a share that rounds to 0 is skipped rather than paying
            // CREDIT_TRIBUTE_VALUE gas to credit nothing. B-1: the message
            // carries gas and `share` as a NUMBER — the GRAM stays here until the
            // owner claims it, and declaring it is what stops `sweep_ops` from
            // treating it as surplus.
            val creditId = meters.nextCreditId;
            meters.nextCreditId += 1;
            meters.tributeOwed += share;
            createMessage({
                bounce: BounceMode.RichBounce,
                value: CREDIT_TRIBUTE_VALUE,
                dest: itemAddressWith(configA, itemDefault, p),
                body: (CreditTribute { queryId: queryId, creditId: creditId, amount: share, p: p }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }
        count -= 1;
    }

    // 3. referral relay (D2). `executeMint` wrote no key for an invalid one,
    // whose 10% it already folded into the pool. NO RELAY GAS TERM: the value is
    // exactly `REFERRAL_AMOUNT`, and the item's `ForwardToOwner` passes it on.
    // BOUNCEABLE, unlike the fee legs: a key below the head can still name an
    // item that is undeployed (parked for `retry_item`) or unpopulated (squatted
    // empty state, or overtaken by this relay — 307). Either way the bounce
    // brings the GRAM back here, `onBouncedMessage` has no arm for it, and it sits
    // as surplus until `sweep_ops` returns it to the pool — never on an address
    // that is not the owner's.
    if (referralKey != 0) {
        createMessage({
            bounce: BounceMode.RichBounce,
            value: REFERRAL_AMOUNT,
            dest: itemAddressWith(configA, itemDefault, referralKey),
            body: (ForwardToOwner { queryId: queryId }).toCell(),
        }).send(SEND_MODE_REGULAR);
    }

    val feeDests = configA.feeDests.load();

    // 4. §4.1's 5% line — TO THE GOVERNED TREASURY CONTRACT (D-152). Until D-100
    // it paid `treasuryAddr` when that WAS the operator's wallet; D-100 point 6
    // made `treasuryAddr` the governed treasury contract and kept the 5% on the
    // operator; D-152 reversed that, so the line is protocol revenue paid to the
    // contract with no key, and the operator's only claim on a mint is §6 point
    // 2's 42% forfeit remainder below (D-166). NoBounce on every value-bearing fee leg:
    // GRAM credited to an uninitialised address accumulates as its balance rather
    // than vanishing. (NoBounce, and this is the reason EVERY value-bearing fee
    // leg in this file uses it: the destination may not be initialised yet, and
    // GRAM credited to an uninitialised address accumulates as its balance rather
    // than vanishing. A bounce would be the wrong reversal — nothing here is a
    // state change to roll back; the legs that DO need one, the item deploy and
    // the tribute credit, are RichBounce.) The send is below, in one message with
    // the forfeit's treasury share (G81).

    // 4b. the forfeit. THE REMAINDER IS SUBTRACTED, NEVER MULTIPLIED A SECOND
    // TIME: two truncations would leave up to a nanoGRAM here with nothing
    // declaring it (RoundingDust.spec.ts).
    val forfeitToTreasury: coins = forfeitTotal * FORFEIT_TREASURY_BPS / BPS_DEN;
    val forfeitToOperator: coins = forfeitTotal - forfeitToTreasury;
    var opMeters = meters.operatorMeters.load();
    opMeters.forfeitedBeyondWindow += forfeitUnattributed;

    // G81: the 5% line, the forfeit's treasury share and any premium half held
    // for the treasury go in ONE message. A forfeit of a few thousand nanoGRAM (a
    // tiny unsold prime cited beside a huge one) is never a leg of its own that
    // cannot pay its receiver's gas. V18a: PAY_FEES_SEPARATELY, so the recipient
    // receives the declared amount and not the amount less its forward fee.
    createMessage({
        bounce: BounceMode.NoBounce,
        value: TREASURY_AMOUNT + forfeitToTreasury + opMeters.treasuryHeld,
        dest: feeDests.treasuryAddr,
        body: beginCell().endCell(),
    }).send(SEND_MODE_PAY_FEES_SEPARATELY);

    // G81: the operator is its own recipient, so its remainder is HELD below
    // `RATCHET_HOP_GAS` and sent, with everything held, once it clears it.
    val operatorDue: coins = opMeters.operatorHeld + forfeitToOperator;
    var operatorSent: coins = 0;
    if (operatorDue >= RATCHET_HOP_GAS) {
        createMessage({
            bounce: BounceMode.NoBounce,
            value: operatorDue,
            dest: feeDests.operatorAddr,
            body: beginCell().endCell(),
        }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        operatorSent = operatorDue;
    }

    // P2.D1: declared once, after the sends. One counter PER RECIPIENT (D-100
    // point 6). Since D-117 these count only lines that were really paid -- a
    // bounced deploy never reaches this function -- and since G81 only value that
    // actually left: a held leg is counted when it is sent, not when it accrues.
    opMeters.operatorPaidTotal += operatorSent;
    opMeters.operatorHeld = operatorDue - operatorSent;
    opMeters.treasuryPaidTotal += TREASURY_AMOUNT + forfeitToTreasury;
    opMeters.premiumTreasuryPaidTotal += opMeters.treasuryHeld;
    opMeters.treasuryHeld = 0;
    meters.operatorMeters = opMeters.toCell();
}

// D-117 — what a bounced `MintItem` owes back: the held lines, summed from
// the same cell `payHeldSplit` would have read.
fun heldSplitTotal(heldSplit: cell): coins {
    var e = heldSplit.beginParse();
    val referralKey = e.loadUint(1) == 1 ? e.loadUint(32) : 0;
    var count = e.loadUint(4);
    var total: coins = TREASURY_AMOUNT;
    if (referralKey != 0) { total += REFERRAL_AMOUNT; }
    while (count > 0) {
        e.skipBits(1);
        e.loadCoins();
        total += e.loadCoins();
        count -= 1;
    }
    return total;
}

// D-117, V28 — a mint whose item was not deployed: the collection refused the
// `MintItem` (a bounce) or the item refused its `Populate` (relayed by the
// collection). Nothing was paid. The ORIGINAL body is parked under `n` for the
// permissionless `retry_item`, and its held split declared in `unroutedHeld`.
fun parkRefusedMintItem(mutate storage: Storage, body: cell) {
    val original = MintItem.fromCell(body);
    val heldSplit = original.heldSplit;
    var aux2 = loadAux2(storage);
    aux2.unroutedItems.set(original.n, body);
    aux2.deployingPrimes.delete(original.n); // V32: parked now, not in flight
    saveAux2(mutate storage, aux2);
    if (heldSplit != null) {
        var meters = loadMeters(storage);
        meters.unroutedHeld += heldSplitTotal(heldSplit);
        saveMeters(mutate storage, meters);
    }
}

// D-20/D-45: the head-advance walk. Starting at `from` (a position not yet
// walked), keep walking past every position that is not directly mintable — a
// prime (marking it, counting it into π(n), stamping its dividend entry,
// opening its forfeit clock) OR a composite an auction has claimed (D-45:
// `isOffHead`, permanent once set) — until the next composite that is neither.
// That composite, and only that composite, becomes the new head.
//
// D-189: the walk is RESUMABLE. It stops before a step once the transaction has
// consumed WALK_GAS_STOP, parks `head` on the first unwalked position and sets
// `walkPending`; `advance_head` calls this again from there. Unbounded, a run of
// ~55 auctioned composites (~60 GRAM of lots) pushed the one mint that crossed it
// past the 1M-gas cap, every retry walked the same run, and the head was frozen
// for good. Returns whether `aux2` was written.
//
// D-196: the walk also stops at `frontierN`, the first number whose block's
// marks are still on a lot-block child. `import_lot_block` moves the frontier;
// `advance_head` then walks on. A late import stalls the head (head mints
// refund); it can never let the head mint a number a lot has claimed.
//
// `isPrime` and `isSkippedReserved` are each computed ONCE per position and
// reused — Miller-Rabin is not cheap (13 witnesses), and re-running it to decide
// both whether to loop and whether to mark doubled it for nothing (see
// `Storage.anyOffHead`'s comment for the other half of that gas fix). D-99
// deleted SS3's special-composite skip: a composite the head reaches mints at
// 1 GRAM, whatever its score.
fun walkHead(mutate storage: Storage, mutate meters: Meters, mutate aux2: Aux2,
             offHeadBitmap: map<uint64, uint256>, frontierN: int, from: int): bool {
    var aux2Dirty = false;
    var newHead = from;
    var isPrime = isPrimeMR(newHead);
    var isSkippedReserved = storage.anyOffHead == 1 && isOffHeadIn(offHeadBitmap, newHead);
    while (newHead < frontierN && (isPrime || isSkippedReserved) && getGasConsumedAtTheMoment() < WALK_GAS_STOP) {
        if (isPrime) {
            // Already marked = sold ahead of the head through a lot
            // (`executeMint` marks it at sale). It is counted like any prime,
            // but must not be re-listed as unsold: it has an owner.
            val soldAhead = isMarkedPrime(storage, newHead);
            storage.primesCount += 1; // §3.2: an eligible prime shares the flat dividend too
            // §3.2's `entry[p] = div_acc` stamp (D-188 point 4). An unsold
            // prime's row holds it until the sale hands it to the item; a
            // prime sold ahead already HAS an item, which the first
            // `claim_dividend` tells (`soldAheadEntry`) — a send from here
            // would put a hop on the mint path.
            if (soldAhead) {
                // Already marked at its sale; nothing to write in the bitmap.
                aux2.soldAheadEntry.set(newHead, storage.divAcc);
                aux2Dirty = true;
            } else {
                markUnsoldPrime(mutate storage, newHead);
                meters.unsoldPrimes.set(newHead as uint256, storage.divAcc);
            }
        }
        // An auctioned composite needs no bookkeeping here beyond the skip
        // itself: `offHeadBitmap` was already set at `open_lot` time, and
        // it is what makes this branch fire. Nothing new to stamp — the
        // auction owns this number's story from here.
        newHead += 1;
        isPrime = isPrimeMR(newHead);
        isSkippedReserved = storage.anyOffHead == 1 && isOffHeadIn(offHeadBitmap, newHead);
    }
    storage.head = newHead;
    // D-196: a head that reached the import frontier is unwalked too — the marks
    // that decide whether it may be minted are still on a lot-block child.
    storage.walkPending = (newHead >= frontierN || isPrime || isSkippedReserved) ? 1 : 0;
    return aux2Dirty;
}

// The shared mint-effects path, called by both `mint` and
// `mint_won_lot` so the split arithmetic, the ratchet counters, and
// the outbound message set are computed by exactly one piece of code (the two
// paths differ only in `verifyPrimality` and `atKMin`).
fun executeMint(
    mutate storage: Storage,
    mutate meters: Meters,
    configA: ConfigA,
    queryId: int,
    n: int,
    kind: int,
    factors: map<uint8, FactorEntry>,
    referralKey: int,
    beneficiary: address,
    // §4.5 / D-106: the RECRUITER identity — the wallet spending the GRAM,
    // distinct from the beneficiary the NFT, rebate and rank follow. When the
    // two differ this mint is a gift, and the recruit edge below may credit the
    // payer with a recruit.
    //
    // On the direct-mint path this is the mint sender; on the market's two
    // paths (`mint_won_lot`, `settle_prime_clearing`) the winner is not
    // forwarded, so the beneficiary stands in: `payer == beneficiary`, a lot
    // win is never a gift and never credits a recruit. It can only under-count.
    payer: address,
    // D-99 §1.5 — TRUE only on the sequential head mint, the 1 GRAM path. The
    // per-point composite rebate pays on that route and on no other: an
    // auction-won composite gets nothing, because the premium it paid IS the
    // price of not waiting. Passed explicitly rather than inferred from
    // `verifyPrimality` (which happens to agree today) so that a future change
    // to either one cannot silently move the rebate population.
    headMint: bool,
    verifyPrimality: bool,
    atKMin: bool,
    // G70: the `premium` parameter is DELETED — every caller passed 0 since D-90
    // moved the auction premium onto `ClearingCleared`.
    // D-20/D-45: true on ONLY the direct head mint (`handleMint`), the sole
    // path that advances the sequential head. Both market paths
    // (`handleSettle`, `SettlePrimeClearing`) pass `false`.
    advanceHead: bool,
    // §4.1's SEVENTH LINE (D-101). ALREADY SPENT by the time this function
    // runs: `handleMint` sent the deploys and counted them, and passes the GRAM
    // those sends actually carried. Zero on every other path.
    //
    // Passed as a settled figure rather than as (count, addresses) so that this
    // function has exactly one thing to do with it — subtract it from β below —
    // and so "unspent slots fall to β" is a property of the caller's counting
    // rather than a rule this arithmetic has to restate.
    inviteSpend: coins,
    // D-191 point 1: the beneficiary's standing BEFORE this mint, as its minter
    // card attached it (the market paths pass NO_STANDING: they price at k_min or
    // k = 0 and never read it), and whether that card was FRESH.
    minter: MinterState,
    fresh: bool,
) {
    // GAUNTLET V17 point 3 — MAKE MILLER-RABIN'S DETERMINISM BOUND LOCAL.
    //
    // `isPrimeMR`'s 13-base witness set {2..41} is exact only below 3.317e24
    // (CONCEPT.md §3.1). Until this assert the ledger enforced no bound of its
    // own: correctness was inherited from `primes_market.tolk`'s AUCTIONABLE_MAX
    // and from `product == n` keeping the factor arguments small. Both are true,
    // and both are properties of a PEER — §8 asks for guarantees checkable by
    // reading one contract, so this contract now states its own.
    //
    // ONE assert, here, rather than one inside `isPrimeMR`. Every Miller-Rabin
    // argument reachable from a mint is a bounded function of `n`: the factors
    // (each < n, by `product == n`), `n` itself, the score's derived probes
    // (largest is `2n + 1`), the digit reversal and digit sum (both < 10·n), and
    // the head walk's own candidates, which start at `n` and step forward by a
    // bounded walk. Bounding `n` here bounds all of them with eleven orders to
    // spare — the largest argument at AUCTIONABLE_MAX (4.29e13) is ~8.6e13
    // against 3.317e24. `isPrimeMR` runs 5-8 times on a single mint, so asserting
    // inside it would cost ~200 gas against the ~529 §4.1's gas & ops line has
    // left (CONCEPT.md §9.6); asserting once costs ~30 and says the same thing.
    //
    // This is `executeMint`, so it covers EVERY mint path — the direct head
    // mint, the ascending lot close and prime clearing all route through here.
    assert (n < MR_DETERMINISTIC_MAX) throw 224; // ledger_mr_bound_exceeded

    // `factors` IS the tribute-recipient list. The verification loop below walks
    // its contiguous prefix from key 0 and every later pass walks the same prefix
    // the same way, so the copy this function used to keep (`tributeRecipients`)
    // held byte-identical entries under identical keys — three `DICTUSETB` of a
    // full `FactorEntry` (~3.8k gas at omega = 3) to reproduce a dictionary the
    // handler was already holding.
    var sumWeights = 0;
    // D-117: how many factor entries the held split will carry — `idx` below, kept.
    var omega = 0;
    // D-188 point 4: set on a prime mint only (below).
    var primeInit: Cell<PrimeInit>? = null;
    // D-188 point 1 (GAUNTLET V24): THE FACTORIZATION THE ITEM RECEIVES IS
    // REBUILT from the entries the loop below checked — never `factors` itself.
    // A key lookup walks only its own path, so a minter's map can carry up to
    // max_msg_cells of unread cells past the first missing key, or hung off the
    // forks the lookups do walk. Forwarded, that padding priced the item deploy
    // out of the collection's reach; the bounce parked the whole body in
    // `unroutedItems`, and every `retry_item` burned the ledger's balance on its
    // forward fee — a drain, and ~50-250 mints to the 65,536-cell account cap.
    // A prime forwards an empty map. ~1.3k gas per entry, inside §4.1's line.
    var verified = createEmptyMap<uint8, FactorEntry>();

    if (kind == 0) {
        // composite: verify factor product == n and every factor is a marked prime
        var product = 1;
        var idx = 0;
        var more = true;
        while (more) {
            val look2 = factors.get(idx);
            if (!look2.isFound) {
                more = false;
            } else {
                // GAUNTLET V3: the entry-count half of the ω(n) ≤ 12 bound
                // (CONCEPT.md §3.2). Checked BEFORE reading the entry so the
                // 13th entry is refused outright rather than parsed and then
                // discarded — the attacker-controlled cost this guards is the
                // PARSE plus the distinctness scan below, not just the
                // eventual credit_tribute fan-out.
                assert (idx < OMEGA_MAX) throw 201; // ledger_bad_factorization
                val f = look2.loadValue();
                // GAUNTLET V3: the distinctness half. `product == n` alone
                // does not forbid citing the same prime as several separate
                // entries (e.g. {2,1,1} × 45 for n = 2^45) — mathematically
                // redundant with a single entry of the summed exponent, and
                // exactly the padding this loop must refuse: each entry costs
                // a full credit_tribute send below regardless of whether the
                // prime it names has already been paid. O(ω²) rescans, ω ≤ 12
                // by the check above, so at most 66 extra map lookups.
                var dupIdx = 0;
                while (dupIdx < idx) {
                    val prior = factors.get(dupIdx).loadValue();
                    assert (prior.primeNumber != f.primeNumber) throw 201; // ledger_bad_factorization
                    dupIdx += 1;
                }
                // D-90.1: a factor at or below the head is marked, and the bitmap
                // lookup is the hot path. A composite won ahead of the head can cite
                // a factor the head has not crossed yet — that one is proved by
                // Miller-Rabin here instead of being looked up.
                // A factor of n is below n. Checked BEFORE Miller-Rabin: a cited
                // 2^200+1 overflowed MR's mulmod into TVM exit 4 instead of 201.
                assert (f.primeNumber >= 2 && f.primeNumber < n) throw 201; // ledger_bad_factorization
                if (!isMarkedPrime(storage, f.primeNumber)) {
                    assert (isPrimeMR(f.primeNumber)) throw 201; // ledger_bad_factorization
                }
                // §3.2: verify the submitted s = ⌊√p⌋ with two multiplies.
                assert (f.s > 0 && f.s * f.s <= f.primeNumber) throw 201; // ledger_bad_factorization
                assert (f.primeNumber < (f.s + 1) * (f.s + 1)) throw 201; // ledger_bad_factorization
                // D-60: a zero exponent contributes p^0 = 1 to product, letting a mint pad
                // its factor list with entries that still cost a full credit_tribute fan-out.
                assert (f.exponent > 0) throw 201; // ledger_bad_factorization
                var e = 0;
                // product <= n and p < n before each multiply, so product * p < n²:
                // a uint8 exponent can no longer overflow 257 bits (exit 4) before
                // the `product == n` check below names it 201.
                while (e < f.exponent) { product *= f.primeNumber; assert (product <= n) throw 201; e += 1; }
                // §3.2: divisor-line weight w(p) = e · √p = e · s.
                sumWeights += f.exponent * f.s;
                verified.set(idx, f);
                idx += 1;
            }
        }
        assert (product == n) throw 201; // ledger_bad_factorization
        assert (idx > 0) throw 201; // must have at least one factor
        omega = idx;
    } else {
        // D13: a market sale trusts the market's open-time MR proof and skips
        // re-running Miller-Rabin (CONCEPT §4.4).
        if (verifyPrimality) {
            assert (isPrimeMR(n)) throw 202; // ledger_bad_primality_claim
        }
        // D-20: `markPrime` / `primesCount` / the dividend stamp are NOT repeated
        // here. Under D-20 every prime is marked, counted into π(n) and
        // div-stamped the moment it becomes ELIGIBLE (the head-advance walk
        // below, or the genesis walk) — not the moment it SELLS, which can be
        // arbitrarily later. Re-running them here would double-count. This
        // mark is a no-op for a prime the head has passed; for one sold AHEAD
        // of the head it is what tells the walk, later, that it already sold.
        //
        // D-196: a prime beyond the import frontier is marked on its lot block
        // instead — the word would otherwise be one a far lot's buyer chose — and
        // the import ORs it into `primeBitmap` before the walk can reach it. The
        // hop is this contract's (LOT_BLOCK_HOP_VALUE); a prime settle has no
        // tribute fan-out, so it is nowhere near the heaviest mint.
        val (primeBlock, _primeBit) = bitmapChunkAndBit(n);
        val primeAux = storage.aux.load();
        if (primeBlock < primeAux.lotFrontier() || primeBlock == primeAux.importingBlock) {
            markPrime(mutate storage, n);
        } else {
            createMessage({
                bounce: BounceMode.NoBounce,
                value: LOT_BLOCK_HOP_VALUE,
                dest: lotBlockStateInit(configA.lotBlockCode, primeBlock),
                body: (LotBlockSoldPrime { queryId: queryId, n: n }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }
        // D-188 points 4-5: THE HANDOVER. The prime has an owner from this
        // transaction on, so the two things the ledger held for it while it had
        // none — the dividend bookmark the walk stamped (absent for a prime sold
        // ahead of the head: the walk has not reached it) and the forfeit
        // counter — leave this account and ride to the new item.
        // D-196: behind the head a prime is for sale only while it is UNSOLD
        // (D-198: the bitmap's unsold bit, which outlives a flushed row). The
        // market no longer keeps a sold bit for a prime sold AHEAD of the head, so
        // this is the check that it cannot be sold a second time once the head has
        // passed it (`mark_off_head` already refuses its listing; this is the same
        // rule where the money lands).
        val wasUnsold = isUnsoldPrime(storage, n);
        assert (n >= storage.head || wasUnsold) throw 235; // ledger_prime_already_owned
        if (wasUnsold) { clearUnsold(mutate storage, n); }
        val unsoldRow = meters.unsoldPrimes.get(n);
        // Sold AHEAD of the head: no stamp exists yet, so the item starts
        // UNSTAMPED, not at 0. A 0 would read as "accrued since genesis" to
        // any `CreditDividend` that reaches it without `base` — possible when
        // the first claim's `base` bounced off a not-yet-deployed item and
        // `retry_item` deployed it before the bounce put the row back. Only
        // `base` overwrites this; a claim without it pays nothing.
        var entry: coins = DIV_ENTRY_UNSTAMPED;
        if (unsoldRow.isFound) {
            entry = unsoldRow.loadValue();
            meters.unsoldPrimes.delete(n);
        }
        val forfeitRow = meters.forfeited.get(n);
        var forfeitedSoFar: coins = 0;
        if (forfeitRow.isFound) {
            forfeitedSoFar = forfeitRow.loadValue();
            meters.forfeited.delete(n);
        }
        // D-198: an unsold prime whose block was FLUSHED has its bookmark on the
        // lot block. The item starts UNSTAMPED, exactly as a prime sold ahead
        // does; the lot block answers `lot_block_bookmark` and the ledger sends
        // the stamp on to the item (LOW-3). Its pre-flush forfeit counter stays
        // readable on the lot block.
        if (wasUnsold && !unsoldRow.isFound) {
            createMessage({
                bounce: BounceMode.NoBounce,
                value: LOT_BLOCK_RELEASE_VALUE,
                dest: lotBlockStateInit(configA.lotBlockCode, primeBlock),
                body: (LotBlockRelease { queryId: queryId, n: n }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }
        primeInit = (PrimeInit { divEntry: entry, forfeited: forfeitedSoFar }).toCell();
    }

    // referral resolution: key must reference an already-minted number (D2).
    //
    // GAUNTLET V7: `referralKey < storage.head` alone proves only that the
    // head-advance walk has PASSED that position, and since D-20 the walk
    // passes every prime and every auctioned composite WITHOUT ever
    // deploying an item there — primes are never minted at the head at all,
    // and an auctioned composite is skipped unconditionally, whether or not
    // its lot has closed yet (its bit is set the moment `open_lot` marks it,
    // D-45, often before the head reaches it). Citing either as a referral key sent this contract's own 10%
    // straight to an uninitialised item address, where it accumulates as an
    // unrecoverable balance the moment the item ever deploys (§3.1/§4.1:
    // "unresolvable falls to the pool, never to the team" — this was neither).
    //
    // Fixed by excluding both classes outright: an unsold prime (still in
    // `unsoldPrimes` — once sold it is removed and stays eligible) and ANY
    // auctioned composite, minted or not. The second is conservative — a
    // WON auction composite does have a real item and a real owner who
    // would otherwise qualify — but the ledger has no cheaper way to tell a
    // closed lot from an open one (D-45's own bit is permanent and
    // does not distinguish them), and folding an eligible-but-unprovable case
    // into the pool is exactly what §3.1 already prescribes for an
    // unresolvable one: never worse than the everyday case of an invalid key,
    // and never the fund-loss this replaces.
    //
    // D-196: a prime's lot now claims its off-head bit too, so the auctioned-
    // composite exclusion applies to composites only; a prime is judged by its
    // unsold row alone, as before.
    val (referralIsPrime, referralUnsoldPrime) = primeBits(storage, referralKey);
    val referralValid = referralKey != 0 && referralKey >= 2 && referralKey < storage.head
        && !referralUnsoldPrime && (referralIsPrime || !isOffHead(storage, referralKey));
    val referralAmount: coins = referralValid ? REFERRAL_AMOUNT : 0;

    // WS2: the per-wallet dictionaries.
    //
    // ONE `storage.aux.load()` for both `aux2` and `offHeadBitmap` (D-45):
    // the advance-head walk below checks `offHeadBitmap` on every position it
    // crosses, and calling `isOffHead(storage, ...)` there would re-parse the
    // whole `aux` cell per check — measured at +29% on the tightest row in the
    // gas & ops reconciliation (`GasRegression.spec.ts`'s composite-omega3
    // row). Reading it once here, alongside the `aux2` load this function
    // already paid for, and passing the plain dict to `isOffHeadIn` inside
    // the loop is the fix: same information, one cell parse instead of two.
    val auxSnapshot = storage.aux.load();
    var aux2 = auxSnapshot.aux2.load();
    var aux2Dirty = false;
    // Read-only here: the walk below only checks it (D-99 deleted SS3's
    // auto-reserve, the one writer this function had).
    val offHeadBitmap = auxSnapshot.offHeadBitmap;

    // §4.5 / §4.7 / D-106: THE RECRUIT EDGE. A gift mint — `payer != beneficiary`
    // — whose beneficiary's minter card was FRESH credits the payer with one
    // recruit and opens the beneficiary's newcomer window (the card has already
    // opened it, D-191 point 1).
    //
    // `fresh` IS THE WHOLE SYBIL GUARD: no accepted event — a mint for that
    // wallet, a prime bought for it, a recruit credited to it — had touched the
    // card. Gifting the same wallet twice counts once, so a recruit costs a FRESH
    // ADDRESS plus a full 1 GRAM mint — the price §8.1 already argued a fake
    // recruit has to pay.
    //
    // NOTE WHAT IS NOT HERE: no GRAM. D-106 deleted §4.1's patron line, so the
    // split does not know this edge exists — same tribute, same referral, same
    // treasury, same gas, same injection, same ratchet step. A recruit is paid
    // in k_max uplift (`recruitRankUplift`) and in nothing else.
    //
    // The credit is a message to the PAYER's card, which replies with its era
    // tally for the running max (`handleCardRecruitCounted`). The recruit uplift
    // applies to the payer's FUTURE mints, so the hop costs the rebate nothing.
    // `eraSeq` is read here, BEFORE this mint's own ceremony (below) can move it:
    // a gift that mints the era's primorial counts toward the era it closes, and
    // its reply is then dropped as late — the trophy is already awarded.
    val isRecruit = payer != beneficiary && fresh;
    if (isRecruit) {
        createMessage({
            bounce: BounceMode.NoBounce,
            value: CARD_RECRUIT_GAS,
            dest: cardStateInit(configA.cardCode, payer),
            body: (CardAddRecruit { queryId: queryId, eraSeq: meters.eraSeason.load().eraSeq }).toCell(),
        }).send(SEND_MODE_REGULAR);
    }

    // §4.1's SEVENTH LINE (D-101) is deducted HERE, in the same one expression
    // as every other line, and BEFORE the prime-mint tribute fold-back below —
    // after it, a prime mint would be charged differently from a composite one.
    //
    // WHAT THIS DOES TO THE RATCHET, and it is intended: β shrinks, so the §5
    // injection shrinks and the rebate computed from β shrinks WITH it, in the
    // same proportion. `k` is not a term in this expression and does not move,
    // so `k < 1` and the K_CEIL clamp are untouched — the sim modelled exactly
    // this at a 1.0 opt-in (params.json invites._horizon_simulated).
    //
    // IT CANNOT DRIVE β NEGATIVE. D-106 removed the patron line, so the worst
    // case is now a referred composite with a full invite fan-out:
    // 1.0 − 0.1 − 0.05 − 0.1 − 0.1 − 0.125 = 0.525.
    // (params.json invites.beta_table publishes the whole grid.)
    val poolInjection: coins = MINT_PRICE - TRIBUTE_AMOUNT - TREASURY_AMOUNT - GAS_OPS_AMOUNT - referralAmount - inviteSpend;

    // D3: prime mints have zero tribute recipients; the line folds into the pool.
    val hasTributeRecipients = kind == 0 && sumWeights > 0;
    val poolInjectionFinal: coins = hasTributeRecipients ? poolInjection : poolInjection + TRIBUTE_AMOUNT;

    val t = storage.lastMintTime == 0 ? RAMP_SECONDS : blockchain.now() - storage.lastMintTime;
    val tClamped = t < 0 ? 0 : t;
    // §5.1: primes emit NOTHING — k = 0 unconditionally on prime mints: no
    // rebate, no S increment, and (via the `rebate > 0` guard below) no
    // jetton-wallet deploy. Primes sold by the market mint at k = 0 too, not k_min.
    // CONCEPT §4.4 point 3: a composite won ahead of the head mints at k = k_min.
    //
    // WS2: the beneficiary's uplift line (prime-rank tier + live PRIME_UPLIFT
    // window) enters through kOfT's kMaxEffective clamp — summed with k_max(n),
    // clamped ONCE at K_CEIL (§5). The k_min settlement path never consults
    // k_max, so no uplift applies (and no window is spent) there.
    val upliftSum = (kind == 0 && !atKMin) ? upliftSumFor(minter) : 0;
    val k = kind != 0 ? 0 : (atKMin ? K_MIN : kOfT(n, tClamped, upliftSum));

    // §5.1 / §4.7.1: a prime sale is +1 lifetime rank and a fresh credit window —
    // RESET, never stacked — on the beneficiary's minter card (D-191 point 1).
    // Everything else the mint path does to a standing (spending a window unit,
    // opening the newcomer window) the card did itself before forwarding the
    // mint: every accepted head mint is a clocked composite, so the rule needs
    // nothing the card does not know. Primes sell only through the market, so this
    // hop is on the prime-sale path and never on a head mint.
    if (kind != 0) {
        createMessage({
            bounce: BounceMode.NoBounce,
            value: CARD_PRIME_GAS,
            dest: cardStateInit(configA.cardCode, beneficiary),
            body: (CardPrimeMinted { queryId: queryId }).toCell(),
        }).send(SEND_MODE_REGULAR);
    }

    // D-156: the logistic cap, applied to `k` BEFORE the rebate product rather
    // than after it. Order is an overflow decision, not a style one: tapering
    // first keeps `kEff <= k <= K_SCALE`, so the product below is no larger than
    // it was; tapering the product instead would scale an already-large
    // intermediate and would need its own operand assert. The taper's own
    // intermediate is `k·(S_MAX − S) <= 1e9 · 1.2e18 = 1.2e27`, two orders of
    // binary magnitude clear of the 257-bit ceiling.
    val kEff = storage.S < S_MAX ? k * (S_MAX - storage.S) / S_MAX : 0;
    var rebate: coins = 0;
    if (storage.T > 0 && storage.S > 0) {
        // R = k * I * S / (T * K_SCALE) — math-note.md §2's rebate rule,
        // multiplied out before dividing to minimize fixed-point rounding loss.
        rebate = kEff * poolInjectionFinal * storage.S / storage.T / K_SCALE;
    }
    // The headroom is the last clamp, as in `handleDonateFloor`. The taper keeps
    // `rebate` under `S_MAX − S` only while `I <= p_f·S_MAX`, and nothing on this
    // path enforces that: `ignite` asks only `T > 0`, so a launch on a dust
    // donation (p_f·S_MAX < 0.65 GRAM) let the first mint carry `S` past the cap
    // (2026-11-08 audit). Emitting less only raises the floor (§5).
    if (rebate > S_MAX - storage.S) {
        rebate = S_MAX - storage.S;
    }

    // §3.4: `pending` no longer lives here. Accumulate what this mint owes the
    // ratchet and send it once, at the end of the mint, so the (T, S) snapshot
    // the guard prices against is this mint's FINAL floor rather than a
    // mid-transaction one.
    var poolToRatchet: coins = poolInjectionFinal;

    storage.T += poolInjectionFinal;
    storage.S += rebate;
    storage.lastMintTime = blockchain.now();

    // §3.2: 20% flat prime dividend — `div_acc += f · 0.10 / π(n)`, where π(n)
    // counts the primes BELOW n. G79: this runs BEFORE the head-advance walk
    // below, never after it — a prime the walk crosses (17 on mint 16) is
    // stamped at the divAcc this accrual produces and counted into π after it,
    // so it takes no share of a mint below it. Accruing after the walk divided
    // by π(n+…) and handed that prime a share it has no claim to (sim/ does it
    // in this order too; SimCrossCheck compares divAcc per mint).
    // `primesCount > 0` always holds here (a composite's factors require a
    // minted prime), but the guard keeps the accrual total-safe anyway;
    // whatever integer division leaves behind folds into the pool.
    if (hasTributeRecipients) {
        var flatToPool: coins = TRIBUTE_FLAT_AMOUNT;
        if (storage.primesCount > 0) {
            val perPrime: coins = TRIBUTE_FLAT_AMOUNT / storage.primesCount;
            if (perPrime > 0) {
                storage.divAcc += perPrime;
                val accrued: coins = perPrime * storage.primesCount;
                meters.divOutstanding += accrued;
                flatToPool = TRIBUTE_FLAT_AMOUNT - accrued;
            }
        }
        if (flatToPool > 0) {
            storage.T += flatToPool;
            poolToRatchet += flatToPool;
        }
    }

    if (advanceHead) {
        // D-20/D-45: the head is defined over composites (and Unity) only.
        // Advance past `n`, then walk past every position that is not directly
        // mintable — see `walkHead`. D-189: the walk may stop early and leave
        // `walkPending` set; `advance_head` finishes it.
        meters.compositesMinted += 1;
        if (walkHead(mutate storage, mutate meters, mutate aux2, offHeadBitmap,
                     auxSnapshot.walkLimitN(), n + 1)) {
            aux2Dirty = true;
        }
    }

    // V32: a prime's item is now on its way; see `Aux2.deployingPrimes`.
    if (kind == 1) {
        aux2.deployingPrimes.set(n, true);
        aux2Dirty = true;
    }

    // Written back through `auxSnapshot` — the copy this function already
    // holds — rather than `saveAux2`, which would re-load `storage.aux`.
    if (aux2Dirty) {
        var auxToSave = auxSnapshot;
        auxToSave.aux2 = aux2.toCell();
        storage.aux = auxToSave.toCell();
    }

    // 1. D-117 — THE HELD SPLIT. Every line this mint owes a third party is written
    // into one cell here and paid by `payHeldSplit` when the collection
    // confirms the item deploy — never in this transaction. `heldSplitValue` is the
    // GRAM those lines carry, and it leaves WITH the `MintItem` below, so while
    // the deploy is in flight the money is in the message and on no contract's
    // balance: nothing can sweep it, and nothing is paid for a number whose item
    // never exists. (CONCEPT §4.1, "the held split".)
    var heldSplit = beginCell();
    if (referralValid) { heldSplit.storeUint(1, 1).storeUint(referralKey, 32); } else { heldSplit.storeUint(0, 1); }
    heldSplit.storeUint(hasTributeRecipients ? omega : 0, 4);
    var heldSplitValue: coins = TREASURY_AMOUNT + referralAmount;

    // 2. tribute, up to omega(n) <= 12 entries (CONCEPT §3.2.1). Computed here,
    // PAID on confirmation (D-117): each entry records the prime, its share, and
    // whether the share is credited to the item or forfeited (§6 point 2).
    // D-20 point 4: forfeited tribute (an unsold prime's cited share) is
    // ACCUMULATED here and paid out below — never to the ratchet pool, never to
    // any NFT holder. D-100 point 6 makes the payout TWO sends rather than one
    // (`FORFEIT_TREASURY_BPS` to the governed treasury contract, the remainder
    // to the operator), which is why this is a total and not a per-recipient
    // figure: the split is applied once, to the whole, at the send site.
    if (hasTributeRecipients) {
        // §3.2: 80% divisor line, weighted e·√p = e·s per cited factor.
        var distributed: coins = 0;
        var idx2 = 0;
        var more2 = true;
        while (more2) {
            val look3 = factors.get(idx2);
            if (!look3.isFound) {
                more2 = false;
            } else {
                val f = look3.loadValue();
                // D-102: the x3/2 constellation reslice is DELETED. The divisor
                // line is the plain base weight w(p) = e*s over their sum — the
                // multiplier cancelled out of numerator and denominator alike,
                // so deleting it changes no share and removes omega dictionary
                // reads from the mint's hot path.
                val share: coins = TRIBUTE_DIVISOR_AMOUNT * f.exponent * f.s / sumWeights;
                distributed += share;
                // CONCEPT §6 point 2 (D-20): while a prime is unsold, its
                // tribute is FORFEITED TO THE TREASURY — never held, never
                // accrued on the (nonexistent) item, and never paid to whoever
                // eventually buys the lot. Sending the credit to the item
                // (which is what this path used to do unconditionally) implies
                // the accrue-on-the-unsold-item design §6 explicitly rejects,
                // so the branch is the rule, not an optimization. Routing to
                // the treasury rather than the ratchet pool is D-20's change
                // from the old K-lot design (which forfeited to the pool).
                // D-90.1: an unmarked factor is one the head has not crossed — it has
                // no item to credit and is not in `unsoldPrimes` either, so it forfeits
                // by the same rule: a prime with no owner forfeits its divisor share.
                //
                // D-196: beyond the import frontier "unmarked" no longer means "no
                // owner" — a prime sold that far ahead is marked on its lot block,
                // not here. So such a factor is CREDITED to its item as if owned;
                // if no item exists the credit bounces and the bounce forfeits it
                // (`onBouncedMessage`, `Aux.forfeitHeld`). Short-circuited so a head
                // mint, whose factors are all marked, never computes the frontier.
                val (fMarked, fUnsold) = primeBits(storage, f.primeNumber);
                val forfeits = fUnsold
                            || (!fMarked
                                && bitmapChunkAndBit(f.primeNumber).0 < auxSnapshot.lotFrontier());
                // Decided NOW, against this mint's state, and carried: the
                // confirmation must pay exactly what this transaction priced.
                heldSplit.storeUint(forfeits ? 1 : 0, 1).storeCoins(f.primeNumber as coins).storeCoins(share);
                heldSplitValue += share;
                idx2 += 1;
            }
        }
        // rounding remainder folds into the pool (documented: no dust leak, T
        // absorbs the sub-nanoGRAM-division remainder rather than losing it)
        if (distributed < TRIBUTE_DIVISOR_AMOUNT) {
            storage.T += (TRIBUTE_DIVISOR_AMOUNT - distributed);
            poolToRatchet += (TRIBUTE_DIVISOR_AMOUNT - distributed);
        }
    }
    // PHASE B2: the 80/20 split of TRIBUTE_AMOUNT lands here — 80% down the
    // `e * sqrt(p)`-weighted divisor line above, 20% into `storage.divAcc` as
    // the flat prime dividend (`div_acc += f * 0.10 / pi(n)`), with `entry[p]`
    // stamped at ELIGIBILITY -- the genesis or head-advance walk, not the sale
    // (D-20) -- on the unsold row, then the item (D-188) -- and the claim paying
    // `div_acc - entry[p]` and re-stamping. Both halves of the read
    // surface are already live — `getDivAcc` and `getDivEntry`/
    // `getClaimableDividend` — so the accrual is the only thing missing, and
    // shipping it without the stamp write would leave a get-method that is
    // permanently 0 (CONCEPT.md §3.2 + §9.1; was LATE_GAME_PLAN.md §1.3). The `s`
    // (submitted floor-sqrt) field and its `s*s <= p < (s+1)*(s+1)` check go on
    // FactorEntry. `f` and the divisor exponent are Phase A outputs.

    // 3/4. The referral relay, the 5% treasury line and the forfeit split are in
    // the held split above and are paid by `payHeldSplit` on confirmation
    // (D-117). What stays here is what never leaves as a third party's money:
    // `T`, the flat dividend, the rebate, the pool injection.

    // THE ITEM DEPLOY, carrying the held split. D-106: the item goes STRAIGHT TO THE
    // BENEFICIARY on every path, gift mints included — there is no unclaimed
    // placeholder state and no third delivery address. Sent after the tribute
    // pass only because the held split cell is finished there; nothing it carries
    // depends on the order of this transaction's other sends.
    // V28: the item pays for its `mint_confirmed` receipt out of the held split it
    // returns, so no kind of mint carries more than ITEM_DEPLOY_VALUE.
    val itemValue: coins = ITEM_DEPLOY_VALUE;
    createMessage({
        bounce: BounceMode.RichBounce,
        value: itemValue + heldSplitValue,
        dest: configA.collectionAddr,
        body: (MintItem {
            queryId: queryId,
            n: n,
            owner: beneficiary,
            isPrime: kind as uint8,
            factorization: verified.toLowLevelDict().toCell() ?? beginCell().endCell(),
            rarityFlags: 0, // rarity-class computation deferred beyond v1 scope (CONCEPT §3.1)
            // Post-walk: `storage.head` is already the next COMPOSITE here.
            mintValue: itemValue,
            head: storage.head as uint64,
            heldSplit: heldSplit.endCell(),
            primeInit: primeInit,
        }).toCell(),
    }).send(SEND_MODE_REGULAR);

    // 5. rebate mint (PRIMES to beneficiary)
    if (rebate > 0) {
        createMessage({
            bounce: BounceMode.RichBounce,
            value: REBATE_MINT_GAS, // wallet deploy + notification forward
            dest: configA.jettonMasterAddr,
            // `MINT_NOTIFY_TON`, not 0 — see the constant for why the rebate is
            // invisible in every wallet without it, and why it costs §4.1's gas
            // & ops line nothing. (This read "no transfer_notification is needed
            // for a rebate (the recipient's wallet is theirs either way)" until
            // 2026-09-19. True on-chain, false in every wallet UI.) The earlier
            // action-phase failure that comment recorded was a forward amount
            // below the notification's own forward fee, not a budget ceiling.
            body: (JettonMint { queryId: queryId, to: beneficiary, amount: rebate, forwardTonAmount: MINT_NOTIFY_TON }).toCell(),
        }).send(SEND_MODE_REGULAR);
    }

    // 6. CONCEPT §7: primorial era ceremony — pay the era bounty from the
    //    bounty vault, if one is configured (D4/D12). A failure here must never
    //    unwind the mint (engineering-spec §5 row 6), hence NoBounce + no state
    //    rollback on this leg.
    // ConfigD (era bounty, below) and ConfigB (both §3.4 hops, further down) come
    // out of ONE `aux -> config` deserialization instead of two.
    val cfg = storage.aux.load().config.load();
    val dCfg = cfg.d.load();
    if (dCfg.peersSet == 1 && isPrimorial(n)) {
        createMessage({
            bounce: BounceMode.NoBounce,
            value: 15000000, // 0.015 GRAM, gas for the vault's transfer leg
            dest: dCfg.bountyVaultAddr,
            // `storage.T` / `storage.S` are already this mint's FINAL values
            // (both were incremented above), so the ceremony is priced at the
            // floor the mint that triggered it just established — not at the
            // pre-mint one.
            body: (PayEraBounty {
                queryId: queryId,
                eraBoundary: n,
                beneficiary: beneficiary,
                t: storage.T,
                s: storage.S,
            }).toCell(),
        }).send(SEND_MODE_REGULAR);
    }

    // 6c. D-99 §1.5 — THE VAULT REBATE, and it is not rarity.
    //
    //     Not to be confused with the ratchet's own k(t) emission, which every
    //     head mint of a composite already pays and which nothing here touches.
    //     This is the other one: the one-time bonus the bounty vault's
    //     `puzzles` track pays the first owner. TWO populations get it and
    //     nothing else does.
    //
    //       a composite MINTED AT THE HEAD — per point of D(n), so a plain
    //       composite gets a few percent back and a 50-point one gets a
    //       quarter; an auction-won composite gets nothing (answer 5).
    //
    //       a prime of D-96's rebate family (p > 100,000, p ≡ 1 mod 101),
    //       by whatever route — flat, and the family scores no points and
    //       lifts no price (answer 18; §1.5 strips its rarity meaning).
    //
    //     Evaluated once, from `n` and its verified factors, on every settlement route. No signer,
    //     no voucher. A failure here must never unwind the mint, same NoBounce
    //     discipline as the era bounty leg.
    if (dCfg.peersSet == 1) {
        // ONE score, ONE Miller-Rabin. The class is read out of the flags rather
        // than asked for separately — this leg used to run the 13-witness pass
        // twice on every composite head mint, once for `isPrimeMR(n)` and once
        // inside `scoreOf`, on the hottest path the game has.
        // C15 (signed ADOPT 2026-09-24): the head mint HAS the factorization —
        // it is the proof this very transaction was accepted on, verified by the
        // loop above — so the rebate pays per point of the FULL, factored score,
        // `scoreOfFrom(n, factors)`, the same D(n) `open_lot` prices an auction
        // at. Both legs now read one number. A prime reaches here with an empty
        // list, and `scoreOfFrom` on an empty list is exactly `scoreOf(n)`, so
        // the prime-family branch is unchanged. The second dictionary walk this
        // costs fits D-117's measured 0.20 GRAM gas & ops line.
        val (score, flags) = scoreOfFrom(n, factors);
        var rebateKind: int = -1;
        var rebatePoints: int = 0;
        if (isPrimeFromFlags(flags)) {
            if (n > DIRICHLET_MIN_N && n % DIRICHLET_MOD == 1) { rebateKind = REBATE_PRIME_FAMILY; }
        } else if (headMint && score > 0) {
            rebateKind = REBATE_COMPOSITE_PER_POINT;
            rebatePoints = score;
        }
        if (rebateKind >= 0) {
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 15000000, // 0.015 GRAM, gas for the vault's transfer leg
                dest: dCfg.bountyVaultAddr,
                body: (PaySpecialNumberRebate {
                    queryId: queryId,
                    n: n,
                    kind: rebateKind,
                    points: rebatePoints,
                    beneficiary: beneficiary,
                    t: storage.T,
                    s: storage.S,
                }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }
    }

    // 7. §3.4 B1 hop A — the pool backing leaves for the ratchet, carrying the
    //    post-mint (T, S) snapshot the floor guard prices against. This is the
    //    ONE message hop the decomposition adds to the common mint path
    //    (UPGRADE_PLAN_V5.md §4 B5: measured in GasRegression.spec.ts).
    // ConfigB is loaded ONCE for both §3.4 hops below (it used to be loaded here
    // by `forwardToRatchet` and again for the registrar leg).
    val bCfg = cfg.b.load();
    forwardToRatchet(storage, bCfg, queryId, poolToRatchet);

    // 6b. D-36 (§4.7, §7): the ERA TROPHY — permanent naming rights over the
    //     era's primorial, to the era's single highest recruiter.
    //
    //     Deliberately NOT a slice of the era bounty. The bounty above still
    //     pays 100% to the primorial's minter; the trophy costs the protocol
    //     nothing but one dictionary entry on a contract that holds no GRAM,
    //     which is the whole reason D-36 kept it while dropping the dividend.
    //
    //     Gated on `sinksSet` (the registrar), not on `peersSet` (the bounty
    //     vault): the two ceremony legs are independent, and a deployment
    //     without a vault should still award the trophy.
    //
    //     `eraLeaderCount == 0` means no recruit activated during this era, so
    //     there is no winner and the primorial is simply left unnamed. Nobody
    //     is invented to receive it.
    //
    //     NoBounce and no state rollback, same reasoning as the bounty leg: a
    //     failure on the ceremony must never unwind the mint.
    if (isPrimorial(n)) {
        val season = meters.eraSeason.load();
        if (bCfg.sinksSet == 1 && season.leaderCount > 0) {
            createMessage({
                bounce: BounceMode.NoBounce,
                value: REGISTRAR_HOP_GAS,
                dest: bCfg.registrarAddr,
                body: (AwardEraTrophy {
                    queryId: queryId,
                    primorial: n,
                    winner: season.leader.castToInternal(),
                    recruits: season.leaderCount,
                }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }
    }
    // The season ends whether or not it had a winner: the next era starts every
    // recruiter at zero. Dropping the whole dictionary is one write and costs no
    // per-entry work, which is what keeps the ceremony's gas independent of how
    // many recruiters the era had.
    if (isPrimorial(n)) {
        meters.eraSeason = (EraSeason {
            leader: createAddressNone(),
            leaderCount: 0,
            eraSeq: meters.eraSeason.load().eraSeq + 1,
        }).toCell();
    }

    // 8. (DECISIONS.md D-202 deleted the registrar's `record_mint` hop: its one
    //    reader was the build clock, and builds are gone.)
}

// `handleFlush` moved wholesale to primes_ratchet.tolk (§3.4 B1). The floor
// guard (§4.3.1) replaces its `storeCoins(1)` there.

fun onBouncedMessage(in: InMessageBounced) {
    var storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    val opcode = rich.originalBody.beginParse().loadUint(32);

    if (opcode == 0xc0000001) {
        // mint_item bounced. V1: `head` is touched on NO path here, on any
        // of the four sends that carry this opcode (direct head mint,
        // ascending lot close, prime clearing, ignite/Unity) — see
        // `BounceCoverage.spec.ts`, one case per path.
        //
        // Three of the four never touched `head` to begin with: the lot close
        // and prime clearing are off-head since D-45 (`executeMint`'s
        // `advanceHead` doc above), and `handleIgnite`'s Unity send bypasses
        // `executeMint` entirely. Only the direct head mint (`handleMint`,
        // `advanceHead: true`) advances it.
        //
        // On THAT path, the old code did `storage.head -= 1`, and it was
        // wrong regardless: `head`, `primeBitmap`, `primesCount` and
        // `unsoldPrimes` were already committed by `storage.save()` in
        // the ORIGINAL transaction — the walk and the item deploy are the
        // same transaction; the bounce is a separate, later one. Nothing
        // orders a bounce ahead of other players' mints landing on this
        // ledger in between, so by the time this arm runs there is no way to
        // tell whether `head` still sits exactly where this mint left it or
        // has already advanced past several more successful mints. `-= 1`
        // assumed the former unconditionally; whenever it wasn't, it
        // corrupted a head that real, settled mints had already moved past.
        // No fixed value this arm could write is safe against that race, so
        // it writes none.
        //
        // D-117 (signed 2026-09-22) CLOSES BOTH HALVES, and neither by moving
        // `head`. The split lines no longer leave beside the deploy — they ride
        // IN it (`MintItem.heldSplit`) and are paid only by `MintConfirmed` — so a
        // bounce means none of them was paid, and their GRAM is in this bounce.
        // The number is not orphaned either: the ORIGINAL body is parked in
        // `Aux2.unroutedItems` under `n`, its held split declared in `unroutedHeld`,
        // and the permissionless `retry_item(n)` re-sends it — same owner, same
        // held split — once whatever refused the deploy is fixed. So the number is
        // minted again, to the wallet it was sold to, and every line is paid
        // exactly once. What the mint booked at mint time — `T`, the flat
        // dividend, the rebate `S`, the pool injection — stays booked: the item
        // still comes into existence, so there is nothing to unwind.
        //
        // A second bounce of the same n (a retry that failed again) overwrites
        // nothing it should not: `retry_item` deleted the entry before sending.
        //
        // This arm fires when the COLLECTION refuses `MintItem`. V28: a `Populate`
        // the ITEM refuses bounces to the collection instead, which relays it here
        // as `mint_item_refused`; both land in `parkRefusedMintItem`.
        parkRefusedMintItem(mutate storage, rich.originalBody);
        storage.save();
    } else if (opcode == 0xb0000030) {
        // credit_tribute bounced: record for retry_credit (engineering-spec §5 row 2)
        val original = lazy CreditTribute.fromCell(rich.originalBody);
        // D-196: NO ITEM, AND NONE WAITING TO BE DEPLOYED, IS NO OWNER. The credit
        // never ran (compute skipped: no account), and no bounced `mint_item` for
        // `p` is parked for `retry_item` — so `p` has never been sold, and §6
        // point 2 forfeits its share. Only a factor beyond the import frontier is
        // ever credited without knowing its owner (`executeMint`), so this is
        // where that factor's "unsold" is finally decided. No per-prime row: the
        // sum is `forfeitedBeyondWindow`.
        //
        // An item that EXISTS but was never populated is no owner either: its
        // empty state is public, so anyone can deploy it for ~0.02 GRAM to catch
        // these credits and then win the lot. The item refuses with 307, which
        // lands here exactly like "no account".
        //
        // V32: nor is an item whose deploy is still IN FLIGHT. `retry_item`
        // un-parks the body and `retry_credit` goes one hop to the item while the
        // deploy goes two (via the collection), so the credit routinely lands
        // first; a lot close racing a crediting mint does the same. Forfeiting
        // there paid the operator 42% of tribute a real owner was owed.
        //
        // BUT A SOLD PRIME BEHIND THE FRONTIER HAS AN OWNER, whatever the bounce
        // says: a skipped compute there is that owner's item frozen or deleted
        // for rent, and forfeiting paid their tribute 58/42 away (audit Low). So
        // behind the frontier a bounce forfeits only when the ledger itself says
        // the prime is unowned — still an unsold row, or never marked. The test
        // is made NOW, not against the frontier at the mint: a far prime whose
        // block was imported in between reads unsold here and still forfeits,
        // where a frontier test alone would park it in `unroutedCredits` for good.
        var cAux = storage.aux.load();
        val (pBlock, _pBit) = bitmapChunkAndBit(original.p);
        val (pMarked, pUnsold) = primeBits(storage, original.p);
        val ownedForSure = pBlock < cAux.lotFrontier() && pMarked && !pUnsold;
        val noOwner = (rich.computePhase == null || rich.exitCode == 307) // item_not_populated
                      && !ownedForSure;
        val cAux2 = cAux.aux2.load();
        if (noOwner && !cAux2.unroutedItems.get(original.p).isFound
                    && !cAux2.deployingPrimes.get(original.p).isFound) {
            cAux.forfeitHeld += original.amount;
            var cMeters = cAux.meters.load();
            var cOp = cMeters.operatorMeters.load();
            cOp.forfeitedBeyondWindow += original.amount;
            cMeters.operatorMeters = cOp.toCell();
            cAux.meters = cMeters.toCell();
            storage.aux = cAux.toCell();
            storage.save();
            return;
        }
        // GAUNTLET V17 point 1: `p` now rides the message, so the retry lane is
        // real. This used to store `p = 0` — the opcode carried no prime and the
        // ledger keeps no reverse index, so the amount could never be routed
        // again: `handleRetryCredit` re-sent it to `itemAddress(0)` forever while
        // `getLiabilityBreakdown` still reported it owed. Recovering the prime
        // from the bounced body turns a permanent loss into an ordinary retry,
        // and `unroutedCredits` goes back to being the LANE its name claims
        // rather than a graveyard.
        storage.unroutedCredits.set(original.creditId, UnroutedCredit { p: original.p, amount: original.amount });
        var meters = loadMeters(storage);
        // B-1: the item never ran, so nothing is `owed` on it — the amount
        // moves out of the owed lane and into the retry lane rather than being
        // counted in both. `handleRetryCredit` is the exact inverse.
        meters.unroutedHeld += original.amount;
        meters.tributeOwed -= original.amount;
        saveMeters(mutate storage, meters);
        storage.save();
    } else if (opcode == 0xb0000036) {
        // D-188: credit_dividend bounced — item(p) is not populated (its
        // `MintItem` is still in flight, or waits in `retry_item`'s lane).
        // Nothing was credited and no meter moved; only a bookmark left with it
        // (a parked sold-ahead one, or a flushed prime's from
        // `lot_block_bookmark`), so park it for the next claim.
        val original = lazy CreditDividend.fromCell(rich.originalBody);
        val base = original.base;
        if (base != null) {
            var aux2 = loadAux2(storage);
            aux2.soldAheadEntry.set(original.p, base);
            saveAux2(mutate storage, aux2);
            storage.save();
        }
    } else if (opcode == 0xd0000001) {
        // JettonMint bounced. `S` was incremented BEFORE the send — by
        // `executeMint`'s rebate leg and by `handleDonateFloor` — so what is
        // sitting in `S` right now is emission that no wallet received.
        //
        // WHY `S` IS NOT ROLLED BACK HERE. It is never decremented (§3.3, §5),
        // and that rule is one-directional on purpose: math-note §2's
        // conservatism corollary requires `p_f = T/S` to UNDERSTATE backing, so
        // that a reader who recomputes against circulating supply always gets a
        // BETTER number than the headline. Phantom PRIMES in `S` push `p_f`
        // down, which is the safe side; decrementing would push it up. D-52
        // signed a rollback without weighing that clause (see its own conflict
        // note, gauntlet iter #10), so the emission is PARKED instead.
        //
        // WHY THERE IS NO BLIND RE-SEND. Every way this send can bounce is
        // DETERMINISTIC, not transient: the master throws 400 while the jetton
        // authority is unsealed, 401 if it is wired to a different ledger, and
        // the historic failure was an under-margined value (the master's own
        // header records it). An immediate retry to the same destination with
        // the same value fails for the same reason — and, being fire-and-forget,
        // could never report its own outcome, so it would corrupt this lane's
        // books. `retry_mint` is the deliberate, externally-paid attempt, and it
        // re-enters this arm if it bounces again.
        val original = lazy JettonMint.fromCell(rich.originalBody);
        val mKey = addrKey(original.to);
        val held = storage.unmintedMints.get(mKey);
        // Summed, not replaced: two bounced mints to one wallet are two debts.
        val heldNow: coins = held.isFound ? held.loadValue() : 0;
        storage.unmintedMints.set(mKey, heldNow + original.amount);
        var meters = loadMeters(storage);
        meters.unmintedHeld += original.amount;
        saveMeters(mutate storage, meters);
        storage.save();
    } else if (opcode == 0x9c000004) {
        // D-198: a lot block refused its bookmarks (never expected: the send
        // carries its state init). Put the rows back on this account and REWIND
        // the cursor to the block, so the block is simply flushed again (re-audit:
        // left advanced, systematic refusals would rebuild the unbounded backlog).
        // Re-flushing a later block that already moved is an empty pass.
        //
        // A prime of the block that SOLD while its rows were away was released to
        // a lot block that had nothing to answer with: its bookmark is parked for
        // its item's first claim here, as the release's answer would have, and is
        // never put back as an unsold row.
        val original = lazy LotBlockBookmarks.fromCell(rich.originalBody);
        var aux = storage.aux.load();
        var meters = aux.meters.load();
        var aux2 = aux.aux2.load();
        // The rows carry only n's bit; the block rides in queryId (see the send).
        val block = original.queryId;
        val base = lotBlockFirstN(block);
        var r = original.rows.findFirst();
        while (r.isFound) {
            val p = base + (r.getKey() as int);
            val row = r.loadValue();
            if (isUnsoldPrime(storage, p)) {
                meters.unsoldPrimes.set(p as uint256, row.entry);
            } else {
                aux2.soldAheadEntry.set(p as uint256, row.entry);
            }
            if (row.forfeited > 0) { meters.forfeited.set(p as uint256, row.forfeited); }
            r = original.rows.iterateNext(r);
        }
        if (block < aux.unsoldFlushed) { aux.unsoldFlushed = block; }
        aux.aux2 = aux2.toCell();
        aux.meters = meters.toCell();
        storage.aux = aux.toCell();
        storage.save();
    } else if (opcode == 0x9c000003) {
        // D-196: the lot block refused `lot_block_import` (the request carries its
        // state init, so this is never "no such account"). Its words are still
        // on it: clear the in-flight flag and let the import be retried.
        var aux = storage.aux.load();
        aux.importingBlock = 0;
        storage.aux = aux.toCell();
        storage.save();
    }
    // `forward_to_owner` (0xc1000002) has NO arm, on purpose: a refused referral
    // writes nothing, and its GRAM stays as surplus for `sweep_ops` to pool.
    // The DeDust-swap bounce branch (0xea06185d) moved to primes_ratchet.tolk
    // with `pending`. It is the ONLY bounce path the floor guard rides (§4.3.1):
    // a would-be-above-floor flush and a sandwiched one are indistinguishable
    // at contract level, by construction.
}

// ---------------------------------------------------------------------------
// Get-methods
// ---------------------------------------------------------------------------

get fun getFloorNum(): int {
    val storage = lazy Storage.load();
    return storage.T;
}

get fun getFloorDen(): int {
    val storage = lazy Storage.load();
    return storage.S;
}

// D-156 / §9.1: the ceiling `S` approaches and never reaches. Published so the
// dashboard's max-supply row is a READ rather than a constant compiled into the
// webapp — §9.1 is the rule that every number the UI shows maps to a public
// get-method, and a hardcoded 1.2e9 in the frontend would be exactly the
// invented parameter CLAUDE.md rule 3 forbids.
//
// Loads no storage: `S_MAX` is a constant, which is also why this is free to call.
get fun getMaxSupply(): int {
    return S_MAX;
}

// D-52 / §9.1: the emission `S` counts but no wallet ever received, because the
// `JettonMint` that would have delivered it bounced and has not been retried.
//
// This is the term that makes `S` reconcilable for the first time. `S` is
// cumulative emission and the jetton master's `totalSupply` is current supply,
// so they were never equal — burns separate them (§3.3) — but with this field
// the identity closes across three get-calls and no off-chain bookkeeping:
//
//     S - getUnmintedHeld() == master.totalSupply + sink cumulative burns
//
// It should read 0 for the life of the deployment. A non-zero value is not a
// loss of backing — the GRAM is unaffected and `p_f` is understated, never
// overstated — it is emission owed to a wallet, recoverable by anyone calling
// `retry_mint` for that address once whatever made the mint bounce is fixed.
get fun getUnmintedHeld(): int {
    val storage = lazy Storage.load();
    return loadMeters(storage).unmintedHeld;
}

// D-26 (§5): the `seeded` term of `T = seeded + swapped + pending`. Founder
// capital credited into `T` at genesis, backing `S` from the DeDust LP without
// ever passing through the ratchet's `pending`. Constant after genesis.
//
// It is a get-method and not a documented constant because §9.1 requires the
// dashboard's solvency row to be recomputable from chain state in one pass —
// a reader who has to be told the seed off-chain cannot check the identity.
get fun getSeedT(): int {
    val storage = lazy Storage.load();
    return storage.seedT;
}

// `getPending` / `getSwapped` are on primes_ratchet.tolk now. `T = seedT +
// swapped + pending` is therefore an identity ACROSS the two contracts, which
// is exactly what §5 asks the dashboard to render.

// PHASE B2: the flat prime-dividend accumulator. Exposed now so the backend
// route (`/ledger/counters`, Phase C) and the dashboard can be built against a
// real get-method rather than a fixture, even while the value is still 0.
get fun getDivAcc(): int {
    val storage = lazy Storage.load();
    return storage.divAcc;
}

// D-188 point 4: the bookmark `entry[p]` WHILE THIS LEDGER HOLDS IT — an
// unsold prime's row, or the parked stamp of a prime sold ahead of the head
// that nobody has claimed on yet. Returns -1 when the ledger holds none: either
// the item holds it (`item.getDivEntry()`, every sold prime once handed over)
// or `p` is not an eligible prime at all. D-198: -2 when `p` is UNSOLD and its
// block has been flushed — the bookmark is on the lot block
// `getLotBlockAddress((p - 2) >> 8)`, `getBookmark(p)`.
get fun getDivEntry(p: int): int {
    val storage = lazy Storage.load();
    val row = loadMeters(storage).unsoldPrimes.get(p);
    if (row.isFound) { return row.loadValue(); }
    val parked = loadAux2(storage).soldAheadEntry.get(p);
    if (parked.isFound) { return parked.loadValue(); }
    return isUnsoldPrime(storage, p) ? -2 : -1;
}

// `claimable(p) = div_acc - entry[p]`, in ONE get-call where this ledger holds
// the bookmark, so the dashboard does not perform the subtraction and call it
// chain state. 0 for anything that is not an eligible prime (composite,
// unminted, or sold ahead and not yet crossed by the head). -1 means THE ITEM
// HOLDS THE BOOKMARK (D-188 point 4): read `item(p).getClaimableDividend(
// getDivAcc())`, the same subtraction on the item's own stamp.
get fun getClaimableDividend(p: int): int {
    val storage = lazy Storage.load();
    if (!isMarkedPrime(storage, p) || p >= storage.head) { return 0; }
    var entry: int = -1;
    val row = loadMeters(storage).unsoldPrimes.get(p);
    if (row.isFound) {
        entry = row.loadValue();
    } else {
        val parked = loadAux2(storage).soldAheadEntry.get(p);
        if (parked.isFound) { entry = parked.loadValue(); }
    }
    // D-198: unsold and flushed — the bookmark is on its lot block (`getDivEntry`).
    if (entry < 0 && isUnsoldPrime(storage, p)) { return -2; }
    if (entry < 0) { return -1; }
    return storage.divAcc > entry ? storage.divAcc - entry : 0;
}

// §3.4's load-bearing property, in ONE get-call: (balance, declared liability,
// delta). The declared liability is exactly the money this contract still owes
// NAMED COUNTERPARTIES, and there are three kinds — see `Meters`, and
// `getLiabilityBreakdown` below for the same number itemized:
//
//   1. `tributeOwed`   — §3.2 tribute credited to items as `owed`, custodied
//                        here, payable on `claim_tribute`. THE BIG ONE: 0.08
//                        GRAM per composite mint, and the one B-1 found missing.
//   2. `unroutedHeld`  — credits that bounced, owed to a `retry_credit`.
//   3. `divOutstanding`— flat dividends accrued and not yet claimed.
//
// `delta` must never be negative. Phase D renders this per contract (D7).
//
// `OPS_RESERVE` is deliberately NOT in the liability term, and the distinction is
// worth stating because the first instinct is to put it there. A liability is
// money owed to somebody who can come and ask for it; the reserve is a target
// the contract aims to hold. Folding a target into the liability makes a solvent
// ledger that happens to be under-funded — every ledger, early on — report
// `delta < 0`, which is the one signal this get-method exists to give. So the
// invariant here stays "can this contract cover what it owes", and the reserve
// appears in `getOpsSweep` below, which is where it actually binds.
//
// What keeps `delta` from growing without bound (the §4.1 gas line is a budget
// with a residual) is not the accounting but the sweep: `sweep_ops`
// (0xb0000007) permissionlessly removes everything above `liability +
// OPS_RESERVE`, so the delta settles at roughly the reserve instead of climbing
// forever into an undeclared pot.
get fun getSolvency(): (int, int, int) {
    val storage = lazy Storage.load();
    val meters = loadMeters(storage);
    val balance = contract.getOriginalBalance();
    val liability = meters.tributeOwed + meters.unroutedHeld + meters.divOutstanding + feeHeld(meters);
    return (balance, liability, balance - liability);
}

// The same liability, itemized. §9.1: every number the UI shows maps to a
// public get-method, and after B-1 the ledger's `delta` is no longer
// self-explaining — a reader who sees it move needs to know WHICH obligation
// moved. It also gives the one reconciliation that actually proves the O(1)
// meter honest: `tributeOwed` must equal `Σ_p get_owed(p)` summed over every
// minted prime, which anyone can walk without trusting this contract's
// arithmetic. FuzzInvariants.spec.ts does exactly that walk.
//
// Returns (tributeOwed, unroutedHeld, divOutstanding, treasuryHeld, operatorHeld)
// -- the last two are G81's held fee legs; their sum is
// `getSolvency`'s liability term, by construction and by test.
get fun getLiabilityBreakdown(): (int, int, int, int, int) {
    val storage = lazy Storage.load();
    val meters = loadMeters(storage);
    val opMeters = meters.operatorMeters.load();
    return (meters.tributeOwed, meters.unroutedHeld, meters.divOutstanding,
            opMeters.treasuryHeld, opMeters.operatorHeld);
}

// G81: the fee legs held below `RATCHET_HOP_GAS` (see `OperatorMeters`). Owed to
// the treasury and the operator, so a term of every liability sum in this file.
fun feeHeld(meters: Meters): coins {
    val opMeters = meters.operatorMeters.load();
    return opMeters.treasuryHeld + opMeters.operatorHeld;
}

// V24: what a `retry_item` of this parked body must carry. `ITEM_DEPLOY_VALUE` is the
// deploy's own gas; CLAIM_DIVIDEND_MIN_VALUE, the flat floor this handler always
// charged, covers the three computes (this handler, the collection's refusal, the
// bounce arm); the forward fee is charged TWICE because a refused deploy comes home
// as a rich bounce carrying the whole body again. Sized by the body, so no parked
// message is too large for its own retry to pay for.
fun retryItemMinValue(body: cell): coins {
    val (cells, bits, _) = body.calculateSizeStrict(MAX_MSG_CELLS);
    return MintItem.fromCell(body).mintValue + CLAIM_DIVIDEND_MIN_VALUE + 2 * calculateForwardFee(BASECHAIN, bits, cells);
}

// V24: the value `retry_item(n)` must carry right now, or -1 when nothing is parked
// under `n` (§9.1: the retry's price is a get-method, not a client's guess).
get fun getRetryItemMinValue(n: int): int {
    val storage = lazy Storage.load();
    val look = loadAux2(storage).unroutedItems.get(n as uint256);
    return look.isFound ? retryItemMinValue(look.loadValue()) as int : -1;
}

// G68b / D-117: the retry lane's index. The smallest parked `n >= from`, or -1
// when none is. `Aux2.unroutedItems` is otherwise invisible from outside, so
// nobody could find what `retry_item(n)` is for; a caller walks it with
// `from = last + 1`. The held split those entries hold is `getLiabilityBreakdown`'s
// `unroutedHeld`.
get fun getNextUnroutedItem(from: int): int {
    val storage = lazy Storage.load();
    val aux2 = loadAux2(storage);
    val r = aux2.unroutedItems.findKeyGreaterOrEqual(from as uint256);
    return r.isFound ? r.getKey() as int : -1;
}

// LOW-3: `Aux2.soldAheadEntry`'s index. The smallest `p >= from` whose dividend
// stamp is parked for its item, or -1. The keeper walks it with `from = last + 1`
// and sends `claim_dividend(p)` for each, which hands the stamp over and deletes
// the row; that drain is the map's bound.
get fun getNextSoldAhead(from: int): int {
    val storage = lazy Storage.load();
    val aux2 = loadAux2(storage);
    val r = aux2.soldAheadEntry.findKeyGreaterOrEqual(from as uint256);
    return r.isFound ? r.getKey() as int : -1;
}

// The exact amount `sweep_ops` would return to the ratchet pool right now, and
// the reserve it is measured against (CONCEPT §9.1). D-117 dropped the third
// value, the destination address: it is the ratchet, always.
get fun getOpsSweep(): (int, int) {
    val storage = lazy Storage.load();
    val meters = loadMeters(storage);
    val balance = contract.getOriginalBalance();
    val held = meters.tributeOwed + meters.unroutedHeld + meters.divOutstanding + feeHeld(meters) + OPS_RESERVE;
    val sweepable: coins = balance > held + SWEEP_GAS + RATCHET_HOP_GAS
        ? balance - held - SWEEP_GAS - RATCHET_HOP_GAS : 0 as coins;
    return (sweepable, OPS_RESERVE);
}

// P2.D1 (D-19, §9.1): (operatorPaidTotal, treasuryPaidTotal, opsSweptTotal,
// premiumTreasuryPaidTotal) — CUMULATIVE, never decremented, distinct from
// `getOpsSweep`'s CURRENT sweepable figure. This is what a dashboard's
// operator-position panel, CONCEPT §6 and FAQ.md's runway entry read; none of
// them may show operator revenue from any other source.
//
// D-100 point 6 makes it a triple. The first two used to be one number, on the
// ground that both landed in the same wallet; they no longer do, so §9.1's
// recompute test — can a reader check this row against chain state? — is passed
// only by reporting each destination on its own. Their sum is still the
// meaningful figure it always was (total fee revenue out of the split,
// excluding the ops sweep), and a reader who wants it adds two numbers this
// method already returns.
//
// D-114 makes it a quadruple, for the same reason: `premiumTreasuryPaidTotal`
// is a distinct revenue event (an auction premium's treasury share) from
// `treasuryPaidTotal` (a forfeit's treasury share), so it is its own number
// rather than folded into one that documents itself as "and NOTHING else".
get fun getOperatorTotals(): (int, int, int, int) {
    val storage = lazy Storage.load();
    val meters = loadMeters(storage);
    val opMeters = meters.operatorMeters.load();
    return (
        opMeters.operatorPaidTotal, opMeters.treasuryPaidTotal, opMeters.opsSweptTotal,
        opMeters.premiumTreasuryPaidTotal
    );
}

// D-100 point 6 / §9.1: WHERE the fee lines go and HOW the forfeit divides.
//
// `getOperatorTotals` says how much has been paid; without this a reader cannot
// check WHO was paid, and the 58/42 forfeit split (D-166) would be a number the UI
// states and the chain does not. Both addresses are deploy-fixed and no message
// in this contract can change either, so this get-method is also the proof of
// that: an auditor reads it once and knows the destinations for the life of the
// deployment. Returns (treasuryAddr, operatorAddr, FORFEIT_TREASURY_BPS) —
// the operator's forfeit share is `BPS_DEN - FORFEIT_TREASURY_BPS`, the same
// subtraction the send site does.
get fun getFeeDests(): (slice, slice, int) {
    val storage = lazy Storage.load();
    val feeDests = loadConfigA(storage).feeDests.load();
    return (
        beginCell().storeAddress(feeDests.treasuryAddr).endCell().beginParse(),
        beginCell().storeAddress(feeDests.operatorAddr).endCell().beginParse(),
        FORFEIT_TREASURY_BPS,
    );
}

// §4.1's invite line / §9.1 (D-202): the whole invite line, lifetime, in one
// call. CUMULATIVE and never decremented.
//
// Returns (slotsFunded, transfersSent, slotsToPool, valueDelivered, linePaid):
//   slotsFunded    -- slots minters DECLARED, ever.
//   transfersSent  -- invite transfers actually SENT, ever.
//   slotsToPool    -- their difference: the slots that fell to beta. This is the
//                     number that makes "unspent slots go to the pool, never to
//                     the team" checkable from outside instead of asserted.
//   valueDelivered -- the GRAM invitees RECEIVED, summed at each mint's live value.
//   linePaid       -- what the line took off beta: valueDelivered plus
//                     INVITE_SEND_FEE per transfer, EXACTLY -- integer multiples,
//                     no division, no remainder. The fee part it did not spend is
//                     in `opsSweptTotal`, not here.
get fun getInviteSpend(): (int, int, int, int, int) {
    val storage = lazy Storage.load();
    val opMeters = loadMeters(storage).operatorMeters.load();
    return (
        opMeters.inviteSlotsFunded,
        opMeters.inviteTransfersSent,
        opMeters.inviteSlotsFunded - opMeters.inviteTransfersSent,
        opMeters.inviteValuePaid,
        opMeters.inviteValuePaid + opMeters.inviteTransfersSent * INVITE_SEND_FEE,
    );
}

// §4.1's invite line / §9.1 (D-202, D-215): the live operator-set terms and the
// three fixed bounds they sit inside, so the checkout's "3 x 0.1 GRAM" is read off
// the contract that spends it.
// Returns (count, value, sendFee, lineCap, countCeiling).
get fun getInviteTerms(): (int, coins, coins, coins, int) {
    val storage = lazy Storage.load();
    val config = loadInviteConfig(storage);
    return (config.inviteCount, config.inviteValue, INVITE_SEND_FEE, INVITE_LINE_CAP, INVITE_COUNT_CEILING);
}

// The exact body every invite transfer carries (D-202), so a client can show
// the text before it is sent and an auditor can check it.
get fun getInviteComment(): cell {
    val storage = lazy Storage.load();
    return inviteComment(loadInviteConfig(storage).inviteText);
}

// D-211: the live invite words alone, as `set_invite_terms` last wrote them.
get fun getInviteText(): cell {
    val storage = lazy Storage.load();
    return loadInviteConfig(storage).inviteText;
}

get fun getSinks(): (slice, slice, int) {
    val storage = lazy Storage.load();
    val b = loadConfigB(storage);
    return (
        beginCell().storeAddress(b.ratchetAddr).endCell().beginParse(),
        beginCell().storeAddress(b.registrarAddr).endCell().beginParse(),
        b.sinksSet,
    );
}

get fun getHead(): int {
    val storage = lazy Storage.load();
    return storage.head;
}

// D-189: 1 while a head-advance walk is unfinished — `head` is then a position
// not yet walked, head mints refund, and `advance_head` is what moves it on.
get fun getWalkPending(): int {
    val storage = lazy Storage.load();
    return storage.walkPending;
}

// CONCEPT §6 point 0 / §9.1: is the game running, and how many NFTs exist.
//
// Returns `(launched, itemsMinted)`. D-20: `itemsMinted` can no longer be
// derived from `head` alone, because `head` now skips every prime (it walks
// composites only) — the gap between two composites is not always 1, so
// `head - constant` under-counts. `itemsMinted` is instead the sum of the two
// counters that DO track real items: composites minted via the sequential
// head, plus primes actually sold via the market's Dutch lane, plus Unity once
// it exists. Published as a get-method rather than left for the UI to
// compute, because that arithmetic is exactly what §9.1 forbids leaving
// off-chain.
get fun getLaunch(): (int, int) {
    val storage = lazy Storage.load();
    val meters = loadMeters(storage);
    return (meters.launched, meters.compositesMinted + meters.primesSoldCount + meters.launched);
}

// §3.2 / §9.1: π(n) — the flat dividend's divisor, as a get-method so the
// dashboard's "primes minted" is chain state, not an indexer recount.
get fun getPrimesCount(): int {
    val storage = lazy Storage.load();
    return storage.primesCount;
}

// The origin of `t` for every caller of getK (CONCEPT.md §9.1, ceremony mode).
//
// `getK(n, t)` is pure — it answers "what would k be t seconds after a mint" — so
// without this, the one thing an outside reader cannot reconstruct is the `t` the
// protocol itself is currently on. The mint path already reads `storage.lastMintTime`
// to compute it (see mintSettle), and publishing it is what lets the UI's live rebate
// clock be recomputed from chain state instead of trusted from an indexer, which is the
// §9.1 honesty constraint. Returns 0 when nothing has ever been minted — the same
// sentinel the mint path treats as "cold start", not a timestamp.
get fun getLastMintTime(): int {
    val storage = lazy Storage.load();
    return storage.lastMintTime;
}

// The RANK-0 curve: uplifts excluded, by design — this is the number every
// anonymous reader can recompute from (n, t) alone, and the one the public
// rebate clock renders. A wallet's own ceiling is getKMaxFor below.
get fun getK(n: int, t: int): int {
    return kOfT(n, t, 0);
}

get fun getKMax(n: int): int {
    return kMaxOf(n);
}

// D-191 point 1: WHERE a wallet's standing lives. The per-wallet get-methods
// that were here — `getMinterState`, `getRecruitRank`, `getNewcomerWindow`,
// `getEraRecruits`, `getUpliftLine` — are the card's own now, same shapes less
// the `owner` argument. A card that was never deployed is a wallet with zero
// standing.
get fun getMinterCardAddress(wallet: address): address {
    val storage = lazy Storage.load();
    return cardAddress(loadConfigA(storage).cardCode, wallet);
}

// §5 / §9.1: the wallet-specific curve — kMaxEffective with an uplift line
// summed in and clamped at K_CEIL, exactly as the mint path computes it. The
// sum is the card's `getUpliftLine()` fifth value. Returns (kMaxEffective,
// clampedAtKCeil): the second says whether K_CEIL is eating part of what the
// ladders granted.
get fun getKMaxFor(n: int, upliftSum: int): (int, int) {
    return (kMaxEffective(n, upliftSum), (kMaxOf(n) + upliftSum) > K_CEIL ? 1 : 0);
}

// D-36 (§4.7, §7) / §9.1: the era trophy's live standing — the wallet that
// would take this era's naming rights if the ceremony fired now, the era
// recruit count it is leading with, and `eraSeq`, the ceremony counter. A
// card's `getEraRecruits()` tally counts toward THIS era only when its own seq
// equals this one.
//
// `addr_none` with 0 means nobody recruited this era, and the era's primorial
// will be left unnamed rather than awarded to anybody. The tie-break is visible
// in the pair: the count only moves on a STRICT improvement, so the leader is
// the earliest wallet to reach it.
get fun getEraLeader(): (slice, int, int) {
    val storage = lazy Storage.load();
    val season = loadMeters(storage).eraSeason.load();
    return (beginCell().storeAddressAny(season.leader).endCell().beginParse(),
            season.leaderCount, season.eraSeq);
}

get fun isKnownPrime(n: int): int {
    val storage = lazy Storage.load();
    return isMarkedPrime(storage, n) ? 1 : 0;
}

// D12: lets the market's `mark_off_head` coordination be verified externally (and by
// the invariant/fuzz suites) rather than only inferred from a rejected mint.
//
// D-196: -1 when `n`'s block is at or beyond the import frontier — its marks are
// on the lot block `getLotBlockAddress((n - 2) >> 8)`, whose `getWords()` answers
// at bit `(n - 2) & 255` (an undeployed lot block means no lot has touched it).
get fun isNumberOffHead(n: int): int {
    val storage = lazy Storage.load();
    val aux = storage.aux.load();
    if (n >= 2 && bitmapChunkAndBit(n).0 >= aux.lotFrontier()) { return -1; }
    return isOffHeadIn(aux.offHeadBitmap, n) ? 1 : 0;
}

// D-196: (windowBlocks, frontierBlock, importingBlock, dueNow). `frontierBlock` is
// the first block whose marks are on a lot block; `importingBlock` is 0 or the
// block an import is fetching; `dueNow` is 1 when `import_lot_block` would be
// accepted now. The keeper reads this before it sends.
get fun getLotBlockState(): (int, int, int, int) {
    val storage = lazy Storage.load();
    val aux = storage.aux.load();
    val frontier = aux.lotFrontier();
    val due = aux.importingBlock == 0 && lotBlockFirstN(frontier) < storage.head + LOT_BLOCK_WINDOW_BLOCKS * 256;
    return (LOT_BLOCK_WINDOW_BLOCKS, frontier, aux.importingBlock, due ? 1 : 0);
}

// D-196: where block `block`'s marks live while it is beyond the frontier.
// D-198: (unsoldFlushed, dueNow). `unsoldFlushed` is the first block whose
// unsold rows are still on this ledger; `flush_unsold` is accepted (dueNow = 1)
// once the head has left that block. The walk stops LOT_BLOCK_WINDOW_BLOCKS past
// it, so a keeper that reads dueNow keeps the head moving.
get fun getUnsoldFlush(): (int, int) {
    val storage = lazy Storage.load();
    val block = storage.aux.load().unsoldFlushed;
    return (block, lotBlockFirstN(block + 1) <= storage.head ? 1 : 0);
}

get fun getLotBlockAddress(block: int): address {
    val storage = lazy Storage.load();
    return lotBlockAddress(loadConfigA(storage).lotBlockCode, block);
}

// D-196: §6 point 2's forfeit cited against primes beyond the import frontier,
// summed (per-prime rows exist only below it). Cumulative, nanoton.
get fun getForfeitedBeyondWindow(): int {
    val storage = lazy Storage.load();
    return loadMeters(storage).operatorMeters.load().forfeitedBeyondWindow;
}

get fun getPeers(): (slice, slice, int) {
    val storage = lazy Storage.load();
    val d = loadConfigD(storage);
    return (
        beginCell().storeAddress(d.marketAddr).endCell().beginParse(),
        beginCell().storeAddress(d.bountyVaultAddr).endCell().beginParse(),
        d.peersSet,
    );
}

// CONCEPT §6 point 2 / §9.1 (D-20): the forfeit counter WHILE `p` HAS NO
// OWNER. Returns the nanoGRAM of `p`'s tribute line that has fallen to the
// treasury and operator because `p` had no owner when a mint cited it. D-188
// point 4: the sale moves the row to the item (`item(p).getForfeited()`), so
// a prime's lifetime total is that plus this — and this is 0 for an owned
// prime except in one race: a mint that cited `p` unsold and was CONFIRMED
// (D-117) after the sale records its share here, since the decision was made
// while `p` had no owner. Monotonic across the two, never rewound.
//
// D-198: once p's block is flushed, its counter so far moves to the lot block
// (`getBookmark(p)`'s `forfeited`, frozen there), and later forfeits on it join
// the unattributed aggregate `getForfeitedBeyondWindow()`. This returns 0 then.
get fun getForfeited(p: int): int {
    val storage = lazy Storage.load();
    val meters = loadMeters(storage);
    val look = meters.forfeited.get(p);
    return look.isFound ? look.loadValue() : 0;
}

// D-20 companion to `getForfeited`: is `p` STILL an open, unsold Dutch lot
// right now? Replaces the old fixed six-bit `getUnsoldMask` — under D-20 every
// prime can be open at once, not just a pre-deployed set, so a bitmask no
// longer fits. A dashboard needs both — the counter says how much has been
// lost, this says whether the clock is still running for a given prime.
get fun isPrimeUnsold(p: int): int {
    val storage = lazy Storage.load();
    return isUnsoldPrime(storage, p) ? 1 : 0;
}

// P2.A7: the ONE address `ClearingCleared` is accepted from, and the one
get fun getItemAddress(n: int): slice {
    val storage = lazy Storage.load();
    val configA = loadConfigA(storage);
    return beginCell().storeAddress(itemAddress(configA, n)).endCell().beginParse();
}

// `getVenue` moved to primes_ratchet.tolk with the venue itself.
