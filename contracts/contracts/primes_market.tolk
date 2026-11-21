tolk 1.4

// ============================================================================
// TON PRIMES — THE MARKET (router). One price-discovery mechanism for every
// number in the game.
//
// Spec: CONCEPT.md §4.4's 2026-08-19 SUPERSEDING PREAMBLE first, then §4.4's
// retained derivations, §6, §11.27. Decisions: D-30/D-31/D-33 (which supersede
// D-6 entirely and amend D-3, D-4a, D-11, D-12, D-15, D-21), then D-3..D-8,
// D-11, D-16, D-18, D-20, D-22;
// layout: docs/audit/unified-market-layout.md (SETTLED 2026-08-16 — this file is
// written against that document and nothing else). Schema: shared/schemas/market.tlb.
// Opcodes: shared/opcodes.ts MARKET (0xF2 player messages, 0xE0 ledger callbacks).
//
// D-3 merged the three pre-v5 auction/book contracts into this one; D-90
// deleted the escrow shard — a won lot MINTS AT CLOSE on both kinds.
//
// ---- What this contract prices: TIMING, never the number ----
// The mint is a flat 1 TON at the head for anyone who waits (§2). Every lane
// here prices the position AHEAD of the head, and every lane is bypassable by
// waiting. That is the design, not a leak: the sequential head is §2's fairness
// claim and anything that closes the bypass is a gate on the head, which §12
// forbids at any price. It is also the ceiling on every price this contract can
// fetch — a bid is worth the value of certainty plus the value of timing, never
// the value of the number.
//
// ---- D-90: A WON LOT IS AN NFT, NOT AN IOU ----
// Every close on every lane mints in the same transaction: a composite close
// sends `mint_won_lot` to the ledger, a prime close `settle_prime_clearing`.
// Cited factors not yet in the ledger's prime bitmap are proved there by
// Miller-Rabin (D-90.1).
//
// D-45: the lot and the head are fully decoupled. The ledger marks an opened
// composite off its sequential line the moment `open_lot` runs (`mark_off_head`,
// permanent — see `primes_ledger.tolk`'s D-45 note) and the head skips it
// forever, exactly like a prime. The lot runs its own 7-day clock and mints
// whenever it closes; no lot parks the head and no head arrival truncates a
// lot, so a lot may open at any distance ahead of the head (D-45 deleted the
// `MIN_AUCTION_DISTANCE` gate).
//
// ---- The two lanes, and why they are ONE structure (§11.27, D-16, D-20, D-88) ----
// Exactly two modes, and D-88 makes the split TEMPORAL rather than a property
// of the number:
//
//   MODE_ASCENDING     BEFORE the turn, for EVERY number. Opening IS a paid
//                      first bid at P0(n) and starts a 7-day clock.  (D-88 pt 3)
//   MODE_DUTCH_BUYNOW  AFTER the turn, primes only. Descends from P0(p) to the
//                      lot's own `priceFloor` over 7 days, then PARKS there
//                      until bought; a bid IS the purchase.        (D-88 pt 1)
//
// A composite never reaches the descending lane: once its turn comes it is
// minted sequentially at MINT_PRICE by the ledger, which is the whole of the
// core loop. A prime never reaches the head at all (D-20), which is why the
// descending lane exists for it and for nothing else.
//
// MODE_DUTCH_BUYNOW MUST NOT OPEN A CLOCK, and that is a safety property rather
// than a preference (layout §2): a purchase settles in its own transaction,
// so nothing on this lane can hold a number open.
//
// ---- D-30/D-88: ONE ROUTE TO A NUMBER AHEAD OF THE HEAD, THE SAME FOR EVERY
// NUMBER ----
// EVERY number ahead of the head — prime, composite, special or plain — is
// bought by opening an ASCENDING lot, where opening IS a paid first bid at
// P0(n), with no score gate (D-30) and no distance gate (D-45). A pre-turn prime
// opens at the same P0(p) its descending lot would open at after its turn. A
// primorial is on neither lane at any price. Because a lot record costs a paid
// bid to create, nobody buys permanent storage for the price of gas (D-50).
//
// Primality survives as the answer to a DIFFERENT question — what happens when
// the turn arrives. A composite mints at the head for MINT_PRICE. A prime, which
// the head skips forever (D-20), opens a descending lot instead.
// A won ascending lot MINTS AT CLOSE, whichever kind it is (D-90).
//
// ---- ADMIN SURFACE: none ----
// `open_lot`, `open_head_lot`, `bid`, `close` and `retry_premium_forward` are
// all permissionless. `head_update`, `mark_rejected`, `settle_confirmed` and
// `launch_open` are authenticated against the deploy-fixed ledger address.
// There is no admin message, owner field, reprice, cancel, address setter or
// withdraw path. Value leaves only as a refund to a bidder, or as the
// mint / premium legs to the fixed ledger.
//
// ---- Duplicated code, and why (Tolk 1.4 has no import mechanism) ----
// `isPrimorial`, the D-99 score block and Miller-Rabin are duplicated from
// primes_ledger.tolk (the score and MR blocks are synced by
// tools/sync-score-block.mjs). Each is published through a get-method, and the
// specs compare the get-methods rather than the source.
// ============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// D-11 / D-18: the auctionable range is bounded at 10,000·2³² − 1 ≈ 4.29·10¹³
// (14 digits), a DECLARED cap (its origin, a shard-id width, went with D-90).
// This contract asserts it on every entry point that accepts an `n`.
//
// THE BOUND IS ALSO WHAT MAKES MILLER-RABIN SAFE HERE. `modpow` squares a
// residue: at n < 2⁴⁶ the intermediate is under 2⁹², four orders inside int257.
// The old book ran the same code with `n: uint256`, where a 78-digit argument
// squares to ~2⁵¹⁸ and throws exit 4 — the integer overflow filed as GAUNTLET
// P2.C1. The cap closes it structurally: there is no reachable `n` on this
// contract large enough to overflow.
const AUCTIONABLE_MAX: int = 42949672959999;    // 10000 · 2³² − 1

// GAUNTLET V3: CONCEPT.md §3.2's ω(n) ≤ 12 bound (37# ≈ 7.42e12 is under
// AUCTIONABLE_MAX; 41# ≈ 3.04e14, seven times over, is unreachable). Mirrors
// `primes_ledger.tolk`'s `OMEGA_MAX` — same bound, same reason, two entry
// points (`open_lot` here, the direct mint there) that both walk an
// attacker-submitted `factors` list before it is proven to belong to `n`.
const OMEGA_MAX: int = 12;

const MINT_PRICE: coins = 1000000000;          // 1 TON, §2's flat all-in price

// D-30/D-37: THE FEE IS ONE FIELD. `RES_GAS` is what a won lot pays to fund its
// own mint, which D-90 makes happen in the close transaction. D-90.4 kept its
// value byte-identical, so it keeps its place in `LOT_FLOOR` and in the premium
// subtraction; `SETTLE_GAS` below is the slice of it that rides to the ledger.
//
// It is a params.json output (`off_head.res_gas_ton`), derived by
// `sim/primes_sim/gas.py res_gas_derivation` and retained at
// `RETAINED_RES_GAS_TON`: W8.1 set 0.060 TON, and D-113 raised it to 0.070 to
// cover OPEN_RESERVE_GAS (0.02 TON, paid at open from this contract's float) —
// measured by `PrimesMarket.spec.ts`'s V8 block at ~0.00625 TON per closed
// composite lot, quantum-rounded up.
const RES_GAS: coins = 70000000;               // 0.07 TON, never waivable

// §6 item 2, restated after D-30: an IDENTITY, not an independent constant. A
// lot's opening price can never be below the all-in cost of the mint it buys —
// one mint price plus the RES_GAS the winner must fund. Writing it as a sum keeps
// the boundary a checked equality. params.json `off_head.lane_floor_ton` and
// `trophy_auction.constants.RESERVE_FLOOR_TON` (both 1.07) are this identity.
const LOT_FLOOR: coins = MINT_PRICE + RES_GAS;   // 1.07 TON

// What rides to the LEDGER with every close's mint leg (`MINT_PRICE +
// SETTLE_GAS`, both kinds), carved from `RES_GAS`; the rest of RES_GAS stays here
// as float.
const SETTLE_GAS: coins = 25000000;            // 0.025 TON
const PREMIUM_HOP_GAS: coins = 30000000;       // 0.03 TON — ledger hop, then ratchet
const MIN_CHANGE: coins = 10000000;            // 0.01 TON — below this a refund is not worth a message
// D-45: the open-time `mark_off_head` hop to the ledger, funded from this
// contract's own operational float, not carved from the
// opener's bid — the bid recorded on the lot is the caller's whole attached
// value. On the rare race-loss path the ledger's `mark_rejected` reply
// carries its own gas back (`SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE`);
// the REFUND itself is paid from this contract's own balance, since the bid
// TON never left it — see `MarkRejected`'s handler.
const OPEN_RESERVE_GAS: coins = 20000000;      // 0.02 TON
// What `open_head_lot` must carry. That lane holds no bid and may never close,
// so no RES_GAS ever repays it: its `mark_off_head` hop carries the caller's
// whole remaining value (`SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE`) and this
// contract's float pays nothing. The floor covers the open's own compute and
// still leaves the ledger OPEN_RESERVE_GAS. It is sized from the protocol
// ceiling, not a sample: config 21 caps a transaction at 1,000,000 gas (~0.0667
// TON), so no open that succeeds can cost more; plus the 0.02 hop, rounded up.
// Measured opens near AUCTIONABLE_MAX reach ~680k gas since V34 (`PrimesMarket.spec.ts`
// "open_head_lot is caller-funded"). Mirrored by `shared/messages.ts`
// OPEN_HEAD_LOT_GAS_NANOTON.
const OPEN_HEAD_VALUE: coins = 100000000;      // 0.1 TON
// What a REJECTED open keeps from its refund: the `mark_off_head` hop plus the
// open's and the unwind's own compute, all paid from this contract's balance.
// A closed lot repays its open through RES_GAS (D-113); a rejected one never
// closes, so without this every race loss drained the float, and a stale
// `headHint` made the race loss repeatable at will. D-196 made it repeatable
// for good: a lot that closes ahead of `headHint` sets no sold bit, so a
// claimed far number passes this contract's checks on every retry. So it is
// sized like OPEN_HEAD_VALUE, from the protocol ceiling and not a sample:
// config 21 caps the open at 1,000,000 gas (~0.0667 TON; a prime near
// AUCTIONABLE_MAX measures ~680k since V34), plus the 0.02 hop, plus the
// unwind's own compute — rounded up. At that price a repeated rejection costs
// its sender more than it costs the float, every round.
const REJECT_GAS: coins = 100000000;           // 0.1 TON
// D-200: rows one `park_lots` looks at (and so folds at most). Each fold deletes
// a `lots` row and sets one bit in a `marks` leaf; sized so the worst call stays
// far under config 21's 1,000,000-gas cap (measured in `PrimesMarket.spec.ts`
// "D-200"). The caller pays: the handler asserts no value, the compute is bought
// from the attached value (an internal message's gas limit IS its value), and the
// rest rides back to the sender, so the float pays nothing.
const PARK_SCAN_MAX: int = 16;
// What an ASCENDING raise keeps for its own compute (V23). A raise books
// `in.valueCoins - BID_GAS` as the bid, and `minPaymentOn` adds BID_GAS to what
// a raise must pay, so the published minimum stays the one all-in figure.
// RES_GAS (D-113) is sized for a one-bid lot; without this each raise cost the
// float ~0.00084 TON on a 2-factor lot, ~0.00089 on a 12-factor one (measured
// in @ton/sandbox, `PrimesMarket.spec.ts` V23). Rounded up.
const BID_GAS: coins = 2000000;                // 0.002 TON

// ---- auction format (params.json trophy_auction.constants, all DECLARED) ----
const AUCTION_WINDOW: int = 604800;            // 7 days — D-3, the Fragment-style clock
// D-8, already shipped and retained: the max() form. `closesAt += BID_EXTENSION`
// is the naive implementation that gets this wrong — it lets an early bidder
// inflate the window at will. Under max(), a bid more than 67 minutes out
// changes nothing and a bid inside that window buys a full 67 minutes of quiet.
const BID_EXTENSION: int = 4020;               // 67 minutes. 67 is prime, deliberately.
// No score gate (D-30 deleted `D_MIN`) and no distance gate (D-45 deleted
// `MIN_AUCTION_DISTANCE`): the only requirement is `n > head` at the moment the
// ledger marks it off-head (see `open_lot`'s `mark_off_head` round trip).
// ---- D-33's bid-increment ladder (params.json acquisition.bid_increment_ladder) ----
// Replaces the flat `max(1 TON, 5%)` rule, which at the gate-free floor P0 of
// 1.07 TON is a ~94% raise that ends the auction on the second bid. Both terms
// are derived:
//
//   FLOOR  0.015 TON — the gas of the round trip one competing raise imposes
//          (the bid plus the refund it forces, 0.011275) rounded up to the 0.005
//          quantum. Below it a raise costs the protocol more than it moves the
//          price. The sim emits `min_increment_floor_nanoton` as a 13-entry array
//          and every entry is this same value; `SimCrossCheck.spec.ts` asserts
//          the uniformity rather than assuming it.
//   BPS    per score band, `incrementBpsAt` below — selected under D-21's signed
//          objective over the whole ladder at once, restricted to MONOTONE
//          NON-DECREASING vectors because that is D-33's stated shape ("a rarer
//          number requires larger bid steps"), not a smoothing convenience.
const MIN_INCREMENT_FLOOR: coins = 15000000;   // 0.015 TON
const BPS_DEN: int = 10000;

// D-4 / D-88 point 1: a prime whose turn has passed is sold by descending
// auction that reaches its resting price (`restingPriceOf`) in one week, then
// parks there. The week is DECLARED, like the other format constants.
const PRIME_DUTCH_SECONDS: int = 604800;       // 7 days

// ---- the score→money map (D-2, D-12/D-33 pending) ----
const SCORE_HALVING: int = 10;                 // P0 doubles every 10 points of D(n)
// D-99 DELETES `PRIME_P0_MIN`. It was the number that made the prime lane
// EXIST when primality scored zero; the score now weighs primality itself
// (FORM bit 16, 15 points) plus every prime sub-family, so a plain prime
// prices off the ladder like everything else and a notable one prices high
// because it IS notable, not because a floor was propped under it.
const PRIME_P0_MULT_NUM: int = 3;              // 1.5 × NPV
const PRIME_P0_MULT_DEN: int = 2;
// D-88 point 1 — THE DESCENDING LANE'S FLOOR. A prime's lot no longer
// terminates at MINT_PRICE; it terminates at half the NPV of the tribute
// stream that prime will earn over its life, and parks there until bought.
// Same table, same provenance, same shape as the multiplier above: `p0` opens
// at 1.5 × NPV and the floor rests at 0.5 × NPV, a 3× spread. Like
// `PRIME_P0_MULT_*` this is a SPREAD and not a simulation-derived economic
// parameter, which is why it is a contract constant rather than a
// `shared/params.json` entry (CLAUDE.md rule 3 — the sim owns NPV itself, and
// `getPrimeDutchTerms` publishes this ratio so §9.1 still holds).
const PRIME_FLOOR_MULT_NUM: int = 1;           // 0.5 × NPV
const PRIME_FLOOR_MULT_DEN: int = 2;

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
// `MINT_PRICE · 2^(87/10) = 415.87 TON` — the highest price this game can ask
// for anything, and it lands just under owner answer 9's 420 TON ceiling. (The
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
// pushed the primorial mint from 0.0998 to 0.1000 TON, over §4.1's gas & ops
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
// gas & ops line (0.10 TON when measured; 0.20 since D-117).
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
// TON with the invite fan-out (D-101) at 99.79 of it. D-117 (2026-09-22) resized
// the line to the measured worst case (0.20 TON), which is what this walk must
// still fit inside; the headroom there is ~0.014 TON, not a budget for a second walk.
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

// The from-`n` score: everything the number itself decides, bits 33..39 and 48..51 clear.
// N6's other eight (40..47) ARE decided here, which is why they cost mint gas.
// A LOWER BOUND on what the same number scores with its factorization.
fun scoreOf(n: int): (int, int) {
    val (score, flags) = scoreOfUnclamped(n);
    return (clampScore(score), flags);
}

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

// §3.1's exact integer form:  P0 = ((MINT_PRICE << (D/10)) * FRAC[D%10]) >> 16
// with FRAC[j] = round(2^(j/10) · 2^16). The largest intermediate is at
// D = SCORE_MAX = 87: (1 TON << 8) · 106464 ≈ 2.7·10¹⁶, five orders inside
// int257 — and the table itself is unchanged by D-99, because it interpolates
// the fractional decade and knows nothing about where the score stops. Published by `getFracTable()` because the integer approximation is the
// likeliest place for silent contract/sim drift.
const FRAC_SHIFT: int = 16;
fun fracAt(j: int): int {
    if (j == 0) { return 65536; }
    if (j == 1) { return 70240; }
    if (j == 2) { return 75281; }
    if (j == 3) { return 80684; }
    if (j == 4) { return 86475; }
    if (j == 5) { return 92682; }
    if (j == 6) { return 99334; }
    if (j == 7) { return 106464; }
    if (j == 8) { return 114105; }
    return 122295;
}

// D-33's ladder, in the same form and for the same reason as `fracAt` above: a
// sim-emitted table small enough to be a file constant, written out entry by
// entry so a reader can diff it against `shared/params.json`
// (`acquisition.bid_increment_ladder.min_increment_bps`) line for line rather
// than against a formula that happens to reproduce it.
//
// The band is `D(n) / SCORE_HALVING`, so the rung count is fixed by the clamp:
// D-99 lowers `SCORE_MAX` from 120 to 87, which makes the top reachable band 8
// and the ladder **NINE rungs, not thirteen**. The four rungs above are not
// merely unused, they are unreachable by construction, and publishing them
// would invite a reader to check the contract against a params.json ladder of a
// different length. Anything above the last rung still returns the top rung,
// which is also the monotone reading.
// Published in full by `getIncrementLadder()` so §9.1 holds: a reader can
// recompute the minimum raise on any lot from `n` alone.
fun incrementBpsAt(step: int): int {
    if (step <= 0) { return 500; }
    return 3000;
}

// ---- lot modes (layout §2) ----
// Exactly two modes. Values 1 (D-20's genesis MODE_DUTCH_CLOCK) and 3/4 (D-88's
// deleted special lanes) are retired, never reassigned. Specialness is price,
// not mechanism: it lifts `p0`/`priceFloor` through the D-99 score.
const MODE_ASCENDING: int = 0;
const MODE_DUTCH_BUYNOW: int = 2;


// ---------------------------------------------------------------------------
// Miller-Rabin — the shared PRIME MR block (see below). Safe against overflow
// here only because of the AUCTIONABLE_MAX cap; see the comment on that constant.
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

// D-30/D-88: every `n` in (0, AUCTIONABLE_MAX] is openable except a primorial
// (§7 — a public ceremony is not sold). WHICH lane is `getLotLane`'s question
// (head position, then primality); the score decides only what the lot COSTS
// to open and to raise (`openingPriceOf`, `minIncrementOn`).
fun isOpenable(n: int): bool {
    if (n <= 0 || n > AUCTIONABLE_MAX) { return false; }
    return !isPrimorial(n);
}

// ---------------------------------------------------------------------------
// Storage (layout §4)
// ---------------------------------------------------------------------------

// WIRE-IDENTICAL TO THE LEDGER'S `FactorEntry`, AND THAT IS A HARD CONSTRAINT,
// NOT A STYLE CHOICE.
//
// D-18 narrows `n` to uint64 everywhere in this contract, and the obvious
// extension — a factor of n is smaller than n, so it fits in uint64 too — is
// TRUE about the VALUES and WRONG about the WIRE. This dictionary is not decoded
// and re-encoded on its way to the ledger: `mint_won_lot` forwards
// the cell it was given, byte for byte, and `primes_ledger.tolk` parses it as
// (uint256, uint8, uint128). Narrowing the fields here would leave the two sides
// reading different bit offsets out of the same cell, so a won lot would
// mint with garbage factors — and it would do so SILENTLY on the
// composite path, because a misparsed factor dict still verifies as *some*
// factorization exactly when the ledger's own product check happens to pass.
//
// The rule to carry forward: D-18's narrowing applies to fields this contract
// OWNS, never to a payload it merely relays.
struct FactorEntry {
    primeNumber: uint256
    exponent: uint8
    s: uint128                 // §3.2's ⌊√p⌋
}

// The lot's mint payload. Held as a cell so the lot record stays inside one
// cell's worth of bits. `kind`/`factors` are the opener's proof, written once at
// open and relayed byte-for-byte in `mint_won_lot`; `beneficiary`/`referralKey`
// belong to the current high bid and are rewritten by each `bid`.
@overflow1023_policy("suppress")
struct LotPayload {
    kind: uint1
    // BOUND: ≤ OMEGA_MAX (12) entries — `open_lot` stores `verified`, rebuilt
    // from the keys it checked, never the sender's map (D-188 point 1); every
    // Dutch row's is empty. Counted in the per-row cells beside `lots`.
    factors: map<uint8, FactorEntry>
    beneficiary: address
    referralKey: uint32
}

// 835 bits worst case, 1 ref (layout §4.1). Deliberately NO
// `@overflow1023_policy("suppress")`: it would hide a genuine layout error.
struct Lot {
    mode: uint3                //   3  MODE_ASCENDING | MODE_DUTCH_BUYNOW (1, 3, 4 retired)
    p0: coins                  // 124  opening / starting price
    // D-88 point 1: the price this LOT descends to and then PARKS at, computed
    // ONCE at open time from `n` alone — `max(MINT_PRICE, P0(n)/3, NPV(n)/2)`
    // since D-99 — and stored, like `p0`; no message can set it.
    // MODE_ASCENDING never reads it (`floorOf` returns `p0` on that lane).
    priceFloor: coins          // 124
    // D-33: the score the lot was opened at, so `minIncrementOn` does not walk
    // the digits of `n` again on every bid. Bounded by SCORE_MAX = 87, so a
    // uint8 still holds it with room to spare (D-99 lowered the bound, which
    // cannot widen this field) and the record grows by 8 bits, not by a digit
    // walk on the hot path.
    score: uint8               //   8
    // D-88 point 3: ALWAYS EQUAL TO `openedAt` on a descending lot (it opens
    // only after the turn), 0 on an ascending one, where it is never read.
    // `dutchPriceOf` still branches on 0 defensively.
    decayStart: uint64         //  64  0 on MODE_ASCENDING; == openedAt on MODE_DUTCH_BUYNOW
    highBid: coins             // 124
    highBidder: address        // 267
    openedAt: uint64           //  64
    closesAt: uint64           //  64  0 until the first bid opens the clock
    payload: Cell<LotPayload>  //       ref
    closed: uint1              //   1
}

// P2.A7: what a bounced `ClearingCleared` left behind, per `n`. 124 bits,
// inside a dict value.
struct Unforwarded {
    amount: coins
}

// 945 bits, 1 ref (821 + `heldBids`) — fits in ONE cell only because of D-18. At `uint256` for
// the `unforwardedByN` keys this is 1,013 bits and has to be split, so D-11's
// cap is what buys the single-cell counters block.
struct MarketCounters {
    forceCancels: uint32                // race-loss unwinds; published by getMarketStats

    // ---- auction lane ----
    openLots: uint32
    closedLots: uint32
    lotPremiumTotal: coins              // Σ premium forwarded to the ledger at close (D-114: ledger splits it ratchet/treasury)
    unforwardedPremium: coins           // returned by a bounced premium forward
    // BOUND (V26.2 / D-188): one row per CLOSED lot whose premium forward the
    // ledger bounced — each row a paid sale (≥ MINT_PRICE) — deleted by the
    // permissionless `RetryPremiumForward`. The ledger bounces nothing in normal
    // operation, so this is 0 at rest.
    unforwardedByN: map<uint64, Unforwarded>
    // §3.4: every other TON this contract owes somebody. Σ highBid over open
    // ascending lots (refunded on outbid/reject, spent at close) plus Σ premium
    // of closed lots whose `SettleConfirmed` has not yet arrived (forwarded on
    // confirm, refunded on a settle bounce). `getSolvency` reads it.
    heldBids: coins
    // D-188 point 5 / D-200 — TWO BITS PER NUMBER BEHIND `headHint`, in one
    // 512-bit leaf (`BlockMarks`, still one cell) per 256-number block keyed by
    // `n >> 8` (the ledger's prime-bitmap shape).
    //   * `sold` — THE TOMBSTONE. Set by `closeLot` (and by a refused descending
    //     open) and never cleared, so no number is sold twice; the lot ROW itself
    //     is deleted once the close has settled either way (`SettleConfirmed`, or
    //     the mint leg's bounce refund). D-196: a close AHEAD of `headHint` sets
    //     nothing here — the ledger's claim on `n` (made at open) is that record,
    //     so the buyer of a far lot cannot choose which words this map grows.
    //   * `parked` — D-200: a descending lot that has come to REST. `park_lots`
    //     folds the row into this bit once its decay window is over: every field
    //     a parked row still needs is a function of `n` and this deploy's config
    //     (`parkedLot`), so the row carried one bit of information in 1.83 cells.
    //     Cleared when the prime is bought (its `sold` bit is set instead).
    // BOUND: one leaf per 256-number block below `headHint` (~2 cells per 256
    // numbers) — it grows with the head, as the ledger's prime bitmap does
    // (D-1's ceiling), and never with anything a caller chooses.
    marks: map<uint64, BlockMarks>
}

// D-200: one leaf of `MarketCounters.marks` — 512 bits, one cell.
struct BlockMarks {
    sold: uint256
    parked: uint256
}

fun BlockMarks.at(marks: map<uint64, BlockMarks>, n: int): BlockMarks {
    val look = marks.get(n >> 8);
    return look.isFound ? look.loadValue() : BlockMarks { sold: 0, parked: 0 };
}

fun setSoldBit(mutate counters: MarketCounters, n: int) {
    var leaf = BlockMarks.at(counters.marks, n);
    leaf.sold = leaf.sold | (1 << (n & 255));
    leaf.parked = leaf.parked & ~(1 << (n & 255));   // D-200: bought, no longer resting
    counters.marks.set(n >> 8, leaf);
}

fun setParkedBit(mutate counters: MarketCounters, n: int) {
    var leaf = BlockMarks.at(counters.marks, n);
    leaf.parked = leaf.parked | (1 << (n & 255));
    counters.marks.set(n >> 8, leaf);
}

fun soldBitIn(marks: map<uint64, BlockMarks>, n: int): bool {
    return ((BlockMarks.at(marks, n).sold >> (n & 255)) & 1) == 1;
}

fun parkedBitIn(marks: map<uint64, BlockMarks>, n: int): bool {
    return ((BlockMarks.at(marks, n).parked >> (n & 255)) & 1) == 1;
}

// Fixed at deploy and UNREACHABLE BY ANY MESSAGE. `npvTable` in particular: it
// ships as a dictionary with the pattern ladder as fallback so the closed form
// can replace it later WITHOUT a wire change — but "later" means a fresh deploy,
// not a setter. A setter would be an owner who can reprice every prime lot,
// which is the exact admin surface §6's zero-surface claim exists to deny.
// `npvTable` is the one Phase 1 output held here; `getNpv` publishes it. D-33's
// bid-increment ladder is a file constant (`incrementBpsAt`), checked against
// params.json by `SimCrossCheck.spec.ts`.
struct MarketConfig {
    ledgerAddr: address                 // 267  the only sender of head_update; the premium's first hop
    ratchetAddr: address                // 267  published by getMarketConfig (no send goes to it)
    // BOUND: fixed at deploy from `trophy_auction.npv_ladder.npv_ton_by_prime`
    // (2,000 primes, ~4k cells) and written by no handler.
    npvTable: map<uint64, coins>        //   1 + ref

    // D-139 — THE TEST CLOCK. ONE deploy-time divisor over every wall-clock
    // constant this contract enforces (`AUCTION_WINDOW`, `BID_EXTENSION`,
    // `PRIME_DUTCH_SECONDS`), so a testnet set can run a 7-day auction in an
    // hour without a second set of constants for anything to drift against.
    // MAINNET DEPLOYS 1 AND THE ARITHMETIC IS THE IDENTITY: the declared
    // figures above are unchanged, `shared/params.json` is still checked
    // against them, and the ratios between the three clocks are preserved by
    // construction rather than by three env vars agreeing.
    //
    // It is DEPLOY-TIME AND UNREACHABLE BY ANY MESSAGE, like every other field
    // in this struct: nobody — owner included — can shorten a lot that is
    // already running. A set deployed with a divisor > 1 ANNOUNCES IT, because
    // `getMarketParams` publishes the DIVIDED figures (§9.1: the UI must draw
    // the clock the contract actually enforces, not the one the source
    // declares).
    clockDivisor: uint16                // 1 = mainnet; 168 turns a 7-day lot into a 1-hour lot
}

// D-139's readers. `0` is read as `1`, so a config cell that predates the field
// — or one a careless script left blank — runs at mainnet speed instead of
// dividing by zero.
fun MarketConfig.clockDiv(self): int {
    return self.clockDivisor == 0 ? 1 : self.clockDivisor;
}
fun MarketConfig.auctionWindowSec(self): int { return AUCTION_WINDOW / self.clockDiv(); }
fun MarketConfig.bidExtensionSec(self): int { return BID_EXTENSION / self.clockDiv(); }
fun MarketConfig.primeDutchSec(self): int { return PRIME_DUTCH_SECONDS / self.clockDiv(); }

// Root cell: 65 bits, 3 of 4 refs. Comfortable against 1023 bits / 4 refs with
// one ref spare — deliberately, because the root is the cell every future field
// lands in. `headHint` and `lots` are inline because they are the two things
// read on nearly every message.
struct Storage {
    headHint: uint64                    // lagging cache of ledger.head, SATURATED at the cap
    // CONCEPT §6 point 0. The ledger's `ignite` fans `launch_open` out to every
    // peer that must not accept player money before the game is live; until it
    // arrives, every money-taking entry point here refuses. The ledger sends
    // ONE `launch_open` (0xe0000034); its permissionless `sync_launch` re-sends
    // a lost one.
    launched: uint1
    // BOUND (V26.2 / D-188 / D-200): measured in `PrimesMarket.spec.ts` "V26.2"
    // and "D-200" —
    //   * descending row: 1.83 cells (leaf + fork; every unbought row's payload
    //     is the SAME cell, so it counts once), and only while it DESCENDS. Once
    //     its window is over `park_lots` folds it into a `parked` bit in
    //     `counters.marks` (D-200), so rows here are the lots opened within the
    //     last PRIME_DUTCH_SECONDS plus the keeper's fold lag — bounded by how
    //     many primes the head passes in a week, not by how many go unsold.
    //     (Before D-200 every unsold prime kept its row for ever: ~35k rows,
    //     n ≈ 425k, filled config 43's 65,536-cell cap.)
    //   * closed row, kept only until its close settles (`SettleConfirmed`, or
    //     the mint leg's bounce): one per sale in flight.
    //   * ascending row: 7.75 cells (its own payload + factor map), each a paid
    //     bid ≥ P0 held ≤ 7 days + extensions, deleted at settle. Filling the
    //     account with them alone locks ~8.4k × P0 ≳ 9k TON in bids.
    lots: map<uint64, Lot>
    counters: Cell<MarketCounters>
    cfg: Cell<MarketConfig>
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

// ---- inbound, permissionless: the auction lanes (0xF2) ----

// Opens an ASCENDING lot AND places the opener's own bid, which must be >= P0(n).
// YOU CANNOT OPEN A LOT YOU ARE UNWILLING TO BUY — which deletes the no-bid,
// expiry, reserve-not-met and refund-the-opener states outright.
//
// D-30/D-45: any non-primorial `n <= AUCTIONABLE_MAX` ahead of the head may be
// opened, with no score or distance gate. This is the ONLY route to a number
// ahead of the head.
//
// D-45: opening sends `mark_off_head` to the LEDGER in the same transaction
// (below), which is what takes `n` off the sequential line for the rest of
// this lot's life, however long its own clock runs. The `n > headHint` check
// here is a CHEAP PRE-FILTER only — `headHint` lags — so the authoritative
// check is the ledger's own, and its rejection (`mark_rejected`, handled
// below) is what actually protects a caller from opening a lot on a number a
// direct mint already claimed underneath them.
//
// EVERY NUMBER AHEAD OF THE HEAD (D-88 point 3; reverses D-22's "composites
// only"). `kind` selects which proof the handler demands — 0 a factorization,
// 1 a Miller-Rabin pass — and which ledger message the close mints through
// (`mint_won_lot` or `settle_prime_clearing`); both mint at close (D-90).
@overflow1023_policy("suppress")
struct (0xf2000001) OpenLot {
    queryId: uint64
    n: uint64
    kind: uint1
    factors: map<uint8, FactorEntry>
    beneficiary: any_address     // addr_none = the opener is the beneficiary
    referralKey: uint32
}

// D-4/D-4a/D-88: opens the DESCENDING lot for a prime WHOSE TURN HAS PASSED.
// No bid and NO VALUE beyond gas — a Dutch lot has no opening bid to place, and
// requiring one would put the opener in front of the clock they just started.
//
// D-88 point 3: the `n < headHint` gate makes the two lanes exhaustive and
// disjoint — before the turn a prime is bought on the ASCENDING lane at this
// same `P0(p)` (`OpenLot` with `kind == 1`), after the turn it descends here,
// and the clock always starts at open.
//
// It carries no payload: the number is prime by MR here, so `kind` is known and
// there is no factorization to verify. The BUYER supplies the beneficiary and
// referral key with their purchase.
struct (0xf2000002) OpenHeadLot {
    queryId: uint64
    n: uint64
}

// One message, two meanings, resolved by the lot's mode:
//   MODE_ASCENDING     a raise; must clear high + minIncrementOn(score, high) (D-33)
//   MODE_DUTCH_BUYNOW  THE PURCHASE. Settles in this transaction (D-20/D-88).
//
// `beneficiary` and `referralKey` are the BIDDER'S on BOTH lanes. On BUYNOW the
// bid IS the purchase and they are read straight off this message; on ASCENDING
// they are written into the lot's payload, so the bid that ends up winning is the
// one whose beneficiary the close mints to. `addr_none` means the bidder.
// (Until 2026-09-17 the ascending lane ignored both and minted to whoever OPENED
// the lot — see the handler's own note for what that cost.)
struct (0xf2000003) BidLot {
    queryId: uint64
    n: uint64
    beneficiary: any_address
    referralKey: uint32
}

struct (0xf2000004) CloseLot {
    queryId: uint64
    n: uint64
}

// PERMISSIONLESS, ONE number per call — O(1) by construction.
struct (0xf2000012) RetryPremiumForward {
    queryId: uint64
    n: uint64
}

// D-200: PERMISSIONLESS. Folds every resting descending row among the first
// PARK_SCAN_MAX rows at or above `from` into its `parked` bit. Caller-funded:
// the change rides back to the sender. `getParkScan(from)` answers what a call
// would fold and where the next page starts.
struct (0xf2000013) ParkLots {
    queryId: uint64
    from: uint64
}

// Retired opcodes, never reused (a stale sender hits `wrong_opcode`):
// 0xf2000005/06/07/08 (D-88: StartPrimeDecay, the SS3 composite lane,
// SweepExpiredHeadLot), 0xf2000041 (D-20: BootstrapGenesis), and the whole
// escrowed-claim 0xE0 lane — reserve/settle/release and every `shard_*`
// message (D-30, D-90).
//
// Also retired: 0xb0000022 `MarkUnreserved` (D-45) and 0xb0000073
// `SettleSpecialComposite` (D-88).

// ---- inbound, from the ledger ----

struct (0xe0000031) HeadUpdate {
    queryId: uint64
    head: uint256        // the ledger's head is NOT capped; this contract saturates it
}

struct (0xe0000032) MarkRejected {
    queryId: uint64
    // P2.A7/A8: uint256, NOT D-18's uint64. This message crosses into
    // `primes_ledger.tolk`, whose `n` is genuinely UNCAPPED — the direct mint
    // lane has no AUCTIONABLE_MAX and the head walks past it eventually. A
    // narrowed field here leaves the ledger's parser 192 bits short and the
    // message dies with exit 9 (cell underflow), which is exactly how this was
    // found. D-18 narrows fields this contract OWNS; never a field a peer parses.
    n: uint256
    // The ledger's head at the refusal, so the refusal also corrects the
    // lagging `headHint` that let the open through (same width as HeadUpdate).
    head: uint256
}

struct (0xe0000033) SettleConfirmed {
    queryId: uint64
    // P2.A7/A8: uint256, NOT D-18's uint64. This message crosses into
    // `primes_ledger.tolk`, whose `n` is genuinely UNCAPPED — the direct mint
    // lane has no AUCTIONABLE_MAX and the head walks past it eventually. A
    // narrowed field here leaves the ledger's parser 192 bits short and the
    // message dies with exit 9 (cell underflow), which is exactly how this was
    // found. D-18 narrows fields this contract OWNS; never a field a peer parses.
    n: uint256
}

// CONCEPT §6 point 0 — inbound, from the LEDGER only. Idempotent one-shot: it
// flips `launched` and there is no message that flips it back. The ledger's
// permissionless `sync_launch` re-sends it if the fan-out was lost, so this
// handler must accept a repeat as a no-op rather than throw.
struct (0xe0000034) LaunchOpen {
    queryId: uint64
}

// ---- outbound, to the ledger ----

struct (0xb0000021) MarkOffHead {
    queryId: uint64
    // P2.A7/A8: uint256, NOT D-18's uint64. This message crosses into
    // `primes_ledger.tolk`, whose `n` is genuinely UNCAPPED — the direct mint
    // lane has no AUCTIONABLE_MAX and the head walks past it eventually. A
    // narrowed field here leaves the ledger's parser 192 bits short and the
    // message dies with exit 9 (cell underflow), which is exactly how this was
    // found. D-18 narrows fields this contract OWNS; never a field a peer parses.
    n: uint256
}

// D-90 — outbound, to the LEDGER, on the close of a composite lot: mints it in
// the closing transaction.
@overflow1023_policy("suppress")
struct (0xb0000020) MintWonLot {
    queryId: uint64
    // P2.A7/A8: uint256, NOT D-18's uint64. This message crosses into
    // `primes_ledger.tolk`, whose `n` is genuinely UNCAPPED — the direct mint
    // lane has no AUCTIONABLE_MAX and the head walks past it eventually. A
    // narrowed field here leaves the ledger's parser 192 bits short and the
    // message dies with exit 9 (cell underflow), which is exactly how this was
    // found. D-18 narrows fields this contract OWNS; never a field a peer parses.
    n: uint256
    beneficiary: address
    referralKey: uint32
    kind: uint1
    factors: map<uint8, FactorEntry>
}

// D-7 / D-114 — outbound, to the LEDGER, the premium of every lot close on
// every lane, sent once `SettleConfirmed` arrives. The ledger splits it by
// `PREMIUM_TREASURY_BPS` between the governed treasury and the ratchet's
// `pending` (k = 0 money: `T` rises, `S` untouched). The ratchet's own
// `pool_inject` is not reachable from here and must not be — every injection
// routes through the ledger by construction.
struct (0xb0000009) ClearingCleared {
    queryId: uint64
    prime: uint256
    amount: coins
}

// D-20 / D-88 point 4 — outbound, to the LEDGER, on the close of ANY prime lot
// (`kind == 1`, either lane). The ledger mints the item, runs the ordinary §4.1
// split on the nominal MINT_PRICE and clears `n`'s `unsoldPrimes` entry in the
// same transaction — see the ledger's copy of this struct.
struct (0xb0000024) SettlePrimeClearing {
    queryId: uint64
    // P2.A7/A8: uint256, NOT D-18's uint64, and this is CORRECT rather than the
    // one stray exception inside the market's own namespace. Like the five
    // messages above, this one crosses into `primes_ledger.tolk`, whose `n` is
    // genuinely UNCAPPED. The ledger's own `SettlePrimeClearing` declares
    // `n: uint256`; narrowing here would leave its parser 192 bits short and the
    // prime sale would die with exit 9 (cell underflow), stranding the buyer's
    // payment. D-18 narrows fields this contract OWNS and asserts against
    // `AUCTIONABLE_MAX`; it never narrows a field a peer parses.
    n: uint256
    beneficiary: address
    referralKey: uint32
}

type AllowedMessage =
    OpenLot | OpenHeadLot | BidLot | CloseLot | RetryPremiumForward | ParkLots
    | HeadUpdate | MarkRejected | SettleConfirmed | LaunchOpen;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

// §3.1's ladder: MINT_PRICE · 2^(D/SCORE_HALVING), in exact integer arithmetic.
fun ladderPrice(score: int): coins {
    val whole = score / SCORE_HALVING;
    val frac = score % SCORE_HALVING;
    return ((MINT_PRICE << whole) * fracAt(frac)) >> FRAC_SHIFT;
}

// P0(n) — THE OPENING PRICE ON EVERY LANE, for every number, composite and
// prime alike. D-99 collapses the old `p0Of` + `openingPriceOf` pair into this
// one function: there is no tier lift left to apply on top of the ordinary
// formula, because specialness IS the ordinary formula now. Two terms:
//
//   ladder(D)   MINT_PRICE · 2^(D/SCORE_HALVING), floored at LOT_FLOOR — the
//               score, and therefore every category `n` belongs to, in money.
//   1.5 · NPV   primes only, and only the 930 below 7,297 the table binds on
//               (`params.json` trophy_auction.npv_ladder). It survives the
//               rewrite because it is YIELD, not vanity: it is what the prime
//               will actually earn in tribute (docs/math-note.md, D-89).
//
// D-88 point 3 requires a pre-turn ascending lot to open at exactly the price
// the post-turn descending lot would open at, so BOTH handlers call this and
// neither derives a price of its own.
fun openingPriceOf(cfg: MarketConfig, n: int, score: int, isPrime: bool): coins {
    var best: coins = ladderPrice(score);
    if (best < LOT_FLOOR) { best = LOT_FLOOR; }
    if (isPrime) {
        // A MISS contributes nothing and the ladder governs. The table is finite
        // by construction, so the miss is the common case on the deep number
        // line and must be the cheap one.
        val look = cfg.npvTable.get(n);
        if (look.isFound) {
            val npv: coins = look.loadValue();
            val scaled: coins = npv * PRIME_P0_MULT_NUM / PRIME_P0_MULT_DEN;
            if (best < scaled) { best = scaled; }
        }
    }
    return best;
}

// D-88 point 1 — where a prime's descending lot COMES TO REST, and stays until
// somebody buys it. D-99 §1.2 makes it `max(MINT_PRICE, P0(n)/3, NPV(n)/2)` —
// there is no tier left to lift it to, and the `P0(n)/3` term is what replaced
// that lift. Small primes earn tribute for the whole life of the game and rest
// high on the NPV term; large ones miss the finite table entirely (0.15 TON at
// n≈10⁵, 4.6·10⁻⁶ TON at n≈10⁶) and used to collapse to exactly 1 TON, which
// made D-88's stated 3× open-to-rest spread false for every prime past 7,297.
// The middle term is now what holds that promise everywhere.
fun restingPriceOf(cfg: MarketConfig, n: int, score: int): coins {
    var floorPrice: coins = MINT_PRICE;
    // D-99 §1.2 — `open / 3` keeps D-88's 3× open-to-rest spread for every
    // prime the finite NPV table misses. Without it a 300 TON scored prime
    // would rest at 1 TON, which is not a descent, it is a giveaway.
    val third: coins = openingPriceOf(cfg, n, score, true) / 3;
    if (third > floorPrice) { floorPrice = third; }
    val look = cfg.npvTable.get(n);
    if (look.isFound) {
        val scaled: coins = look.loadValue() * PRIME_FLOOR_MULT_NUM / PRIME_FLOOR_MULT_DEN;
        if (scaled > floorPrice) { floorPrice = scaled; }
    }
    return floorPrice;
}

// INVARIANT MKT-1, RESTATED BY D-88 POINT 1.
//
// The old MKT-1 read `floorOf(MODE_DUTCH_BUYNOW) == MINT_PRICE`, exactly, and
// called itself the load-bearing line in this file. IT IS DELETED. §12's "no
// lane may terminate above 1 TON" goes with it: every prime's lane now
// terminates at `restingPriceOf(n)`, which is above 1 TON wherever the NPV
// table has an entry. The liveness argument that clause used to carry — "the
// head can never park permanently on a prime nobody will pay a premium for" —
// was already vestigial: D-20 defines the head over composites and Unity only,
// so the head does not stop at primes and has nothing to park on. A prime that
// nobody buys is simply unsold, which costs the game nothing and stalls no one.
//
// WHAT SURVIVES, and it is the half that was ever structural: `priceFloor` is
// WRITE-ONCE FROM `n` ALONE. No message struct carries it (`OpenLot` and
// `OpenHeadLot` have no such field), so no caller, owner or operator proposes a
// value; it is computed HERE, by contract code, at the single moment the record
// is created, and neither of the two paths that later update a lot (`closeLot`,
// a bid) touches it. There is no admin path to it because there is no path to
// it. What is NOT structural is "cannot be wrong": a derived floor was one
// value for every lot, a stored one can be right for some `n` and wrong for
// others, which is a test obligation rather than a guarantee. `PrimesMarket`'s
// C6 block is that test.
fun floorOf(cfg: MarketConfig, mode: int, p0: coins, priceFloor: coins): coins {
    if (mode == MODE_DUTCH_BUYNOW) { return priceFloor; }
    return p0;   // MODE_ASCENDING never descends
}

// D-88 point 2: one window for every lane, special or not.
fun decaySecondsOf(cfg: MarketConfig, mode: int): int {
    if (mode == MODE_DUTCH_BUYNOW) { return cfg.primeDutchSec(); }
    return 0;
}

// The DESCENDING pre-bid price: linear from p0 to the mode's floor across the
// mode's decay window, flat on the floor thereafter.
fun dutchPriceOf(cfg: MarketConfig, rec: Lot, nowTs: int): coins {
    if (rec.mode == MODE_ASCENDING) { return rec.p0; }
    // Defensive: `open_head_lot` always writes `decayStart = openedAt` (D-88), so
    // 0 is unreachable on this lane. Falling through with 0 would measure the
    // decay from the UNIX epoch and sell the prime at its floor.
    if (rec.decayStart == 0) { return rec.p0; }
    val floorPrice: coins = floorOf(cfg, rec.mode, rec.p0, rec.priceFloor);
    val span = decaySecondsOf(cfg, rec.mode);
    if (span <= 0 || nowTs <= rec.decayStart) { return rec.p0; }
    val elapsed: int = nowTs - rec.decayStart;
    if (elapsed >= span) { return floorPrice; }
    return rec.p0 - (rec.p0 - floorPrice) * elapsed / span;
}

// D-33's SECOND consumer of the score, WIRED to W8.1's ladder. Verbatim the rule
// params.json emits as `acquisition.bid_increment_ladder._contract_rule`:
//
//     step          = D / SCORE_HALVING
//     min_increment = max(MIN_INCREMENT_FLOOR, high · bps[step] / 10000)
//
// One integer divide, one table lookup, one multiply, one divide — the same cost
// as `ladderPrice` already pays for P0. `high` is the STANDING high bid, which at
// the moment a lot opens is `P0(n)` itself, because under D-30 opening IS the
// first bid.
//
// The floor binds below ~0.1 TON of standing bid, i.e. never on a live lot:
// LOT_FLOOR is 1.07 TON, so on the ascending lane the percentage always governs
// and the floor is there to keep the arithmetic honest, not to price anything.
fun minIncrementOn(score: int, high: coins): coins {
    var inc: coins = high * incrementBpsAt(score / SCORE_HALVING) / BPS_DEN;
    if (inc < MIN_INCREMENT_FLOOR) { inc = MIN_INCREMENT_FLOOR; }
    return inc;
}

// What `bid(n)` must be paid — the ONE number the handler measures
// `in.valueCoins` against, and the one `getLot` publishes.
//
// The value is the ALL-IN payment C on every lane, and it decomposes the same
// way on every lane (see `closeLot`): C = MINT_PRICE + RES_GAS + premium.
//
// THE ONE ASYMMETRY, stated rather than buried. On the ASCENDING lane the
// standing price is already an all-in figure, because P0 >=
// LOT_FLOOR = MINT_PRICE + RES_GAS by construction. On the BUYNOW lane it
// cannot be, because that lane's floor is the NUMBER'S resting price — which
// under D-88 is `max(NPV(n)/2, P0(n)/3, MINT_PRICE)` rather than a flat 1 TON, but is
// still a price for the number and not for its settlement — so RES_GAS is
// added on top. At a floor of 1 TON a head-lot purchase is 1.07 TON all-in (RES_GAS 0.070, D-113);
// the difference is the settlement the buyer funds.
fun minPaymentOn(cfg: MarketConfig, rec: Lot, nowTs: int): coins {
    if (rec.mode == MODE_DUTCH_BUYNOW) {
        return dutchPriceOf(cfg, rec, nowTs) + RES_GAS;
    }
    if (rec.highBid == 0) {
        // Pre-bid on an ASCENDING lot: `dutchPriceOf` returns the flat P0.
        // (D-20 deleted MODE_DUTCH_CLOCK, so no lot reaches here descending.)
        return dutchPriceOf(cfg, rec, nowTs);
    }
    // A raise also funds its own compute (V23) — see BID_GAS.
    return rec.highBid + minIncrementOn(rec.score, rec.highBid) + BID_GAS;
}

// D-200: the lot a `parked` bit stands for, rebuilt from `n` by the SAME helpers
// `open_head_lot` wrote the row with — `restingPriceOf` is still write-once from
// `n` (D-88 point 1): this deploy's config is fixed and no message reaches it, so
// the rebuilt floor is the one the folded row carried, to the nanoton.
// `decayStart = 1` marks the decay as long over (any instant at least one window
// ago reads the floor in `dutchPriceOf`); `openedAt = 0` because the open time is
// in the open's own transaction, not in storage — as a sale's price is (D-188).
fun parkedLot(cfg: MarketConfig, n: int): Lot {
    val (score, _flags) = scoreOf(n);
    return Lot {
        mode: MODE_DUTCH_BUYNOW,
        p0: openingPriceOf(cfg, n, score, true),
        priceFloor: restingPriceOf(cfg, n, score),
        score: score,
        decayStart: 1,
        highBid: 0,
        highBidder: contract.getAddress(),
        openedAt: 0,
        closesAt: 0,
        payload: (LotPayload {
            kind: 1,
            factors: createEmptyMap<uint8, FactorEntry>(),
            beneficiary: contract.getAddress(),
            referralKey: 0,
        }).toCell(),
        closed: 0,
    };
}

// D-200: a descending row whose decay window is over — it can only ever sell at
// its floor now, so `park_lots` may fold it into its `parked` bit.
fun isRestingRow(cfg: MarketConfig, rec: Lot, nowTs: int): bool {
    return rec.mode == MODE_DUTCH_BUYNOW && rec.closed == 0 && rec.decayStart != 0
        && nowTs >= rec.decayStart + cfg.primeDutchSec();
}

// D-200: what one `park_lots { from }` would do — (rows it folds, the first key
// it did NOT look at, or -1 at the end of the map). One scan for the handler and
// the get-method, so the keeper's read cannot disagree with the send.
fun parkScan(lots: map<uint64, Lot>, cfg: MarketConfig, from: int, nowTs: int): (int, int) {
    var folds = 0;
    var seen = 0;
    var r = lots.findKeyGreaterOrEqual(from as uint64);
    while (r.isFound && seen < PARK_SCAN_MAX) {
        if (isRestingRow(cfg, r.loadValue(), nowTs)) { folds += 1; }
        seen += 1;
        r = lots.findKeyGreater(r.getKey());
    }
    return (folds, r.isFound ? r.getKey() as int : -1);
}

// Saturating, like every other counter here: a miscount must under-report the
// liability's decrement, never wrap it.
fun subHeld(held: coins, amount: coins): coins {
    return held > amount ? held - amount : 0 as coins;
}

fun sendRefund(dest: address, amount: coins, queryId: int) {
    // NoBounce: if the destination somehow rejects a plain transfer the value
    // stays here, on a contract with no withdraw path — it can only ever leave
    // along a refund or one of the settlement routes.
    createMessage({
        bounce: BounceMode.NoBounce,
        value: amount,
        dest: dest,
        body: beginCell().storeUint(0, 32).storeUint(queryId, 64).endCell(),
    }).send(SEND_MODE_REGULAR);
}

// ---------------------------------------------------------------------------
// Settlement (D-7). ONE decomposition, reached from every termination on every
// lane, so "a closed lot always places its winner and always injects its
// premium" is one body to read rather than four.
//
//   C = the winning payment
//     RES_GAS 0.070   carved off FIRST (D-90.4 kept it). `SETTLE_GAS` of it rides
//                     to the ledger with the mint leg in this transaction; the
//                     remainder stays here as float.
//     1 TON           to the LEDGER, which runs the ordinary §4.1 five-way split
//                     on it and deploys the item — so the tribute and referral
//                     lines are paid on auctioned numbers too.
//     C − 1.070       the premium, to the LEDGER via `ClearingCleared` once the
//                     mint is confirmed (`SettleConfirmed` below). D-114: the
//                     ledger splits it between the ratchet's `pending` and the
//                     governed treasury.
//
// INVARIANT MKT-3 is DISCHARGED by D-90: there is no second premium counter to
// double-count against `lotPremiumTotal`, and the mint messages carry no premium
// field (G70 deleted `resPremium`). Every lane, prime or composite, mints through
// the SAME ordinary split on the nominal MINT_PRICE — no separate treasury cut.
// ---------------------------------------------------------------------------

fun closeLot(mutate storage: Storage, mutate counters: MarketCounters,
             n: int, rec: Lot, winner: address, price: coins, queryId: int) {
    val cfg = storage.cfg.load();

    var updated = rec;
    updated.closed = 1;
    updated.highBid = price;
    updated.highBidder = winner;
    // Kept only until the close settles (`SettleConfirmed` / the mint leg's
    // bounce): both read the winner and the price back off it. The permanent
    // record is the sold bit.
    storage.lots.set(n, updated);
    // D-196: only BEHIND the market's head. A sale ahead of `headHint` is already
    // recorded by the claim `open_lot` made on the ledger (or on its lot block),
    // which refuses any second lot; a bit here would be a word the buyer of a
    // far lot chooses, on an account with a 65,536-cell cap.
    if (n < storage.headHint) {
        setSoldBit(mutate counters, n);
    }
    counters.openLots = counters.openLots > 0 ? counters.openLots - 1 : 0;
    counters.closedLots += 1;

    val premium: coins = price - MINT_PRICE - RES_GAS;
    counters.lotPremiumTotal += premium;
    // The standing bid (0 on a Dutch lot, which never held one) is spent now;
    // the premium stays here until `SettleConfirmed` forwards it.
    counters.heldBids = subHeld(counters.heldBids, rec.highBid) + (premium > 0 ? premium : 0 as coins);
    storage.counters = counters.toCell();
    storage.save();

    val payload = rec.payload.load();

    if (payload.kind == 1) {
        // ---- D-20/D-88 point 4 / D-90: `kind`, not `mode`, picks the mint
        // message — a prime on EITHER lane mints through `SettlePrimeClearing`
        // (which also clears `unsoldPrimes`), a composite through `MintWonLot`.
        // Both mint in this transaction.
        //
        // The premium is measured against MINT_PRICE, not `rec.priceFloor`: a
        // raised floor changes what the buyer pays, not the ledger's §4.1 split,
        // which runs on the nominal MINT_PRICE for every lane.
        //
        // D-113: funded `MINT_PRICE + SETTLE_GAS`, the same as the composite leg
        // (the ledger asserts only `in.valueCoins >= MINT_PRICE`); the rest of
        // RES_GAS stays here as float. ----
        createMessage({
            bounce: BounceMode.RichBounce,
            value: MINT_PRICE + SETTLE_GAS,
            dest: cfg.ledgerAddr,
            body: (SettlePrimeClearing {
                queryId: queryId,
                n: n,
                beneficiary: payload.beneficiary,
                referralKey: payload.referralKey,
            }).toCell(),
        }).send(SEND_MODE_REGULAR);
    } else {
        // ---- A COMPOSITE, which is always MODE_ASCENDING (D-90). Value
        // `MINT_PRICE + SETTLE_GAS`; the ledger asserts `valueCoins >= MINT_PRICE`.
        // The rest of RES_GAS stays here as float.
        //
        // RichBounce so a ledger-side refusal returns the money HERE, where the
        // bounce handler pays it back to the winner rather than stranding it.
        createMessage({
            bounce: BounceMode.RichBounce,
            value: MINT_PRICE + SETTLE_GAS,
            dest: cfg.ledgerAddr,
            body: (MintWonLot {
                queryId: queryId,
                n: n,
                beneficiary: payload.beneficiary,
                referralKey: payload.referralKey,
                kind: payload.kind,
                factors: payload.factors,
            }).toCell(),
        }).send(SEND_MODE_REGULAR);
    }

    // GAUNTLET V9: the premium is NOT sent here. It stays in this contract's
    // balance (counted in `heldBids`) and is forwarded by the `SettleConfirmed`
    // handler once the ledger has actually minted. If the mint leg bounces
    // instead, `SettleConfirmed` never arrives and `onBouncedMessage` refunds
    // the premium to the winner with the returned leg — both land or neither.
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        // =================================================================
        // The auction lanes
        // =================================================================

        OpenLot => {
            // D-11/D-18, on every entry point that accepts an `n`.
            assert (msg.n <= AUCTIONABLE_MAX) throw 1020;   // mkt_n_above_cap
            // CONCEPT §6 point 0: no player money before `ignite`.
            assert (storage.launched == 1) throw 1022;     // mkt_not_launched
            assert (!isPrimorial(msg.n)) throw 1008;       // mkt_primorial_not_auctionable
            // D-88 point 3: every number ahead of the head, either kind; `kind`
            // selects the proof below and the mint message in `closeLot`.
            // D-45: `n > headHint` is a cheap, non-authoritative pre-filter only —
            // `headHint` LAGS. The real check is the ledger's, on `mark_off_head`
            // below; a race loss is unwound and refunded via `mark_rejected`.
            val cfg = storage.cfg.load();
            assert (msg.n > storage.headHint) throw 1007; // mkt_at_or_behind_head

            val look = storage.lots.get(msg.n);
            if (look.isFound) {
                val existing = look.loadValue();
                assert (existing.closed == 0) throw 1002;  // mkt_lot_already_closed
                throw 1001;                                 // mkt_lot_already_open
            }
            // D-188: a settled close leaves no row, only its sold bit.
            assert (!soldBitIn(storage.counters.load().marks, msg.n)) throw 1002; // mkt_lot_already_closed

            // PROOF VERIFICATION AT OPEN TIME (§4.4 point 1). Verifying at close
            // instead would let a bidder win a lot that can never mint, and
            // verifying twice would charge the winner for the opener's mistake.
            // D-88: which proof, selected by `kind`. A composite submits its
            // factorization (plus ⌊√p⌋ per factor), checked here. A prime submits nothing and is
            // checked by the contract's own Miller-Rabin instead — the same
            // 13-base deterministic test `open_head_lot` runs, so a number
            // cannot be prime on one lane and composite on the other.
            val isPrime = msg.kind == 1;
            // STORAGE CEILING: the lot stores `verified`, rebuilt from the
            // entries this loop actually checked — never `msg.factors` itself.
            // A key lookup walks only its own path, so any branch past the
            // first missing key could carry up to max_msg_cells of unread cells
            // into `lots`, and eight such opens fill config 43's 65,536-cell
            // account cap (~10 TON, all refundable when outbid).
            var verified = createEmptyMap<uint8, FactorEntry>();
            if (isPrime) {
                assert (msg.factors.isEmpty()) throw 201;  // bad_factorization
                // Primality is read off the score below (GAUNTLET V34).
            } else {
                var product = 1;
                var idx = 0;
                var more = true;
                while (more) {
                    val fLook = msg.factors.get(idx);
                    if (!fLook.isFound) {
                        more = false;
                    } else {
                        // GAUNTLET V3: entry-count half of ω(n) ≤ 12 — see
                        // `primes_ledger.tolk`'s `OMEGA_MAX` for the full
                        // reasoning, identical here.
                        assert (idx < OMEGA_MAX) throw 201; // bad_factorization
                        val f = fLook.loadValue();
                        // GAUNTLET V3: distinctness half — refuses the same
                        // prime cited as several separate entries (padding
                        // that `product == n` alone does not catch).
                        var dupIdx = 0;
                        while (dupIdx < idx) {
                            val prior = msg.factors.get(dupIdx).loadValue();
                            assert (prior.primeNumber != f.primeNumber) throw 201; // bad_factorization
                            dupIdx += 1;
                        }
                        assert (f.exponent > 0) throw 201;      // bad_factorization
                        assert (f.primeNumber >= 2 && f.primeNumber < msg.n) throw 201;
                        assert (isPrimeMR(f.primeNumber)) throw 201;
                        assert (f.s > 0 && f.s * f.s <= f.primeNumber) throw 201;
                        assert (f.primeNumber < (f.s + 1) * (f.s + 1)) throw 201;
                        var e = 0;
                        // product <= n and p < n before each multiply: no 257-bit
                        // overflow (exit 4) from a large uint8 exponent.
                        while (e < f.exponent) { product *= f.primeNumber; assert (product <= msg.n) throw 201; e += 1; }
                        verified.set(idx, f);
                        idx += 1;
                    }
                }
                assert (idx > 0) throw 201;
                assert (product == msg.n) throw 201;
            }
            // D-30: every number reaching this line is openable. The score
            // prices the opening bid and the bid increment (D-33).
            // PHASE 3 (PRICING_MODEL_PLAN.md §4): the composite's factor list
            // has just been verified against `msg.n` three lines up, so this
            // lane prices the FULL score — the from-`n` categories plus the
            // five the factorization decides. A prime reaches this line with an
            // empty list and `scoreOfFrom` then returns exactly `scoreOf(n)`,
            // so there is no branch here and no second definition of the price.
            val (score, scoreFlags) = scoreOfFrom(msg.n, verified);
            // GAUNTLET V34: the score already ran Miller-Rabin on `n`; a second
            // pass was ~1/6 of a cap prime's open and pushed it past 1M gas.
            if (isPrime) { assert (isPrimeFromFlags(scoreFlags)) throw 201; } // bad_factorization

            // D-88 point 3: THE SAME OPENING PRICE THE DESCENDING LANE WOULD
            // QUOTE. `openingPriceOf` is shared with `open_head_lot`, so a prime
            // opened here the day before its turn opens at exactly the P0 it
            // would have descended from the day after. Specialness lifts it
            // through the D-99 score, not a separate tier.
            val p0 = openingPriceOf(cfg, msg.n, score, isPrime);
            // The message value IS the opening bid, booked whole, so a caller's
            // fee margin rides into their own bid rather than becoming untracked
            // balance on this contract.
            assert (in.valueCoins >= p0) throw 1003;        // mkt_open_below_p0

            val beneficiary = msg.beneficiary.isNone() ? in.senderAddress : msg.beneficiary.castToInternal();
            val nowTs = blockchain.now();
            storage.lots.set(msg.n, Lot {
                mode: MODE_ASCENDING,
                p0: p0,
                priceFloor: MINT_PRICE,   // unread on this lane (`floorOf` returns p0)
                // ^ an ascending auction never falls below its own opening bid.
                score: score,
                decayStart: 0,
                highBid: in.valueCoins,
                highBidder: in.senderAddress,
                openedAt: nowTs,
                // D-3: the first bid starts the 7-day clock, and `open` IS the
                // first bid on this lane.
                closesAt: nowTs + cfg.auctionWindowSec(),
                payload: (LotPayload {
                    kind: msg.kind,
                    factors: verified,
                    beneficiary: beneficiary,
                    referralKey: msg.referralKey,
                }).toCell(),
                closed: 0,
            });
            var counters = storage.counters.load();
            counters.openLots += 1;
            counters.heldBids += in.valueCoins;
            storage.counters = counters.toCell();
            storage.save();

            // D-45: take `n` off the ledger's sequential line NOW, not at
            // close. `MarkRejected` (handled below) undoes the lot this
            // transaction just created if the ledger finds `n` already minted
            // directly underneath this open.
            //
            // D-196: EITHER KIND. The walk skips a prime anyway, but the ledger
            // (or, beyond its import frontier, the lot block it routes to) is
            // now the one record that a lot ever claimed `n`: this contract keeps
            // no sold bit for a number ahead of its `headHint`, so a second lot
            // on a claimed `n` is refused there, by the same `mark_rejected`.
            createMessage({
                bounce: BounceMode.NoBounce,
                value: OPEN_RESERVE_GAS,
                dest: cfg.ledgerAddr,
                body: (MarkOffHead { queryId: msg.queryId, n: msg.n as uint256 }).toCell(),
            }).send(SEND_MODE_REGULAR);
        }

        OpenHeadLot => {
            // D-4 / D-20 / D-88. PERMISSIONLESS and unpriced: opens the
            // descending lot for a prime WHOSE TURN HAS PASSED. Primes never
            // occupy the head (CONCEPT §6 point 1), so there is nothing to stall.
            assert (msg.n <= AUCTIONABLE_MAX) throw 1020;   // mkt_n_above_cap
            // CONCEPT §6 point 0: no player money before `ignite`.
            assert (storage.launched == 1) throw 1022;     // mkt_not_launched
            assert (!isPrimorial(msg.n)) throw 1008;       // mkt_primorial_not_auctionable
            val cfg = storage.cfg.load();
            // Primes only. A composite at the head has no scarcity story that
            // §5.1's k = 0 bargain is paying for, and it mints at MINT_PRICE the
            // moment its turn comes, which is the core loop and not an auction.
            // (Checked once the score is in hand, below — GAUNTLET V34.)
            // D-88 point 3: ahead of the head a prime is bought on the
            // ASCENDING lane (`open_lot`, kind 1), so this lane starts exactly
            // where that one stops — at the turn. One route per number per moment.
            //
            // `headHint` still means exactly what it meant: it only ever tracks
            // a not-yet-built COMPOSITE (D-20: the head is defined over
            // composites and Unity only) and it advances strictly in order, so
            // the instant it passes some composite `C`, every prime below `C` is
            // by construction "next among not-yet-built numbers" and stays so
            // forever after (D-20: no expiry). It LAGS, never leads, so this can
            // only ever open the lane late — never before the turn.
            assert (msg.n < storage.headHint) throw 1024;  // mkt_decay_not_due
            // D-196: the caller pays this open AND the ledger check below.
            assert (in.valueCoins >= OPEN_HEAD_VALUE) throw 1003; // mkt_open_below_p0

            val look = storage.lots.get(msg.n);
            if (look.isFound) {
                val existing = look.loadValue();
                assert (existing.closed == 0) throw 1002;  // mkt_lot_already_closed
                throw 1001;                                 // mkt_lot_already_open
            }
            // A SOLD prime can never be relisted: `closeLot` sets its sold bit,
            // which nothing clears (D-188), and D-88 deleted the one message
            // (`sweep_expired_head_lot`) that ever deleted an unsold lot. This
            // lane is therefore open-once, permanently.
            val openMarks = storage.counters.load().marks;
            assert (!soldBitIn(openMarks, msg.n)) throw 1002; // mkt_lot_already_closed
            // D-200: a parked lot is still OPEN, only rowless — opening it again
            // would restart its descent from P0 above the price it rests at.
            assert (!parkedBitIn(openMarks, msg.n)) throw 1001; // mkt_lot_already_open

            val nowTs = blockchain.now();
            val (score, scoreFlags) = scoreOf(msg.n);
            // GAUNTLET V34: primes only, read off the score's own Miller-Rabin
            // rather than a second pass (~1/6 of a cap prime's open).
            assert (isPrimeFromFlags(scoreFlags)) throw 1006; // mkt_not_on_auction_lane
            // D-88 points 1 and 2. Both prices come from the shared helpers, so
            // this lane opens at the same P0 the ascending lane would have
            // charged for the same number the day before its turn, and rests at
            // `max(MINT_PRICE, P0(n)/3, NPV(n)/2)` instead of collapsing to
            // exactly 1 TON when the NPV table misses.
            val p0 = openingPriceOf(cfg, msg.n, score, true);
            val priceFloor = restingPriceOf(cfg, msg.n, score);
            // The descent must never be an ascent. Guaranteed termwise by the
            // two helpers (1.5·NPV > 0.5·NPV, and P0 > P0/3 > 0 with
            // P0 >= LOT_FLOOR > MINT_PRICE), asserted because a future edit to
            // either expression is exactly the change that would break it
            // silently.
            assert (p0 >= priceFloor) throw 1028;          // mkt_floor_above_p0
            storage.lots.set(msg.n, Lot {
                mode: MODE_DUTCH_BUYNOW,
                p0: p0,
                priceFloor: priceFloor,
                score: score,
                // D-88: always the open time. The gate above guarantees the turn
                // has passed, so there is no parked-clock state left to express.
                decayStart: nowTs,
                highBid: 0,
                highBidder: contract.getAddress(),
                openedAt: nowTs,
                closesAt: 0,           // this lane NEVER opens a clock
                payload: (LotPayload {
                    kind: 1,
                    factors: createEmptyMap<uint8, FactorEntry>(),
                    beneficiary: contract.getAddress(),   // replaced by the buyer
                    referralKey: 0,
                }).toCell(),
                closed: 0,
            });
            var counters = storage.counters.load();
            counters.openLots += 1;
            storage.counters = counters.toCell();
            storage.save();

            // D-196: the ledger confirms `n` is an UNSOLD prime. A prime sold
            // AHEAD of the head leaves no sold bit here (the ledger's claim is
            // that record), so without this a passed, owned prime could be
            // listed again; `mark_rejected` deletes such a lot and sets its sold
            // bit, so it is tried once. The caller funds the hop: it carries
            // whatever this open's compute left of `in.valueCoins`, so the
            // float pays nothing (a fixed OPEN_RESERVE_GAS here cost it
            // ~0.012 TON per minimum-value open).
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: cfg.ledgerAddr,
                body: (MarkOffHead { queryId: msg.queryId, n: msg.n as uint256 }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        BidLot => {
            assert (msg.n <= AUCTIONABLE_MAX) throw 1020;   // mkt_n_above_cap
            // CONCEPT §6 point 0: no player money before `ignite`.
            assert (storage.launched == 1) throw 1022;     // mkt_not_launched
            val look = storage.lots.get(msg.n);
            val cfg = storage.cfg.load();
            var rec: Lot;
            if (look.isFound) {
                rec = look.loadValue();
            } else {
                val bidMarks = storage.counters.load().marks;
                assert (!soldBitIn(bidMarks, msg.n)) throw 1002; // mkt_lot_already_closed
                // D-200: a parked lot sells exactly as its row did — at its
                // resting price, rebuilt from `n`, with no expiry (D-88 point 1).
                assert (parkedBitIn(bidMarks, msg.n)) throw 1000; // mkt_lot_not_found
                rec = parkedLot(cfg, msg.n);
            }
            assert (rec.closed == 0) throw 1002;           // mkt_lot_already_closed
            val nowTs = blockchain.now();
            val due = minPaymentOn(cfg, rec, nowTs);
            assert (in.valueCoins >= due) throw 1004; // mkt_bid_below_minimum

            if (rec.mode == MODE_DUTCH_BUYNOW) {
                // Layout §9 item 2: A BID ON THIS LANE IS THE PURCHASE,
                // AND IT MINTS IN THIS TRANSACTION. It never opens a clock.
                //
                // The buyer supplies the beneficiary and the referral key here
                // because a head lot is opened by anybody (often a keeper) and
                // carries no payload of its own.
                val beneficiary = msg.beneficiary.isNone() ? in.senderAddress : msg.beneficiary.castToInternal();
                var bought = rec;
                bought.payload = (LotPayload {
                    kind: 1,
                    factors: createEmptyMap<uint8, FactorEntry>(),
                    beneficiary: beneficiary,
                    referralKey: msg.referralKey,
                }).toCell();
                var counters = storage.counters.load();
                // THE PRICE IS THE CLOCK'S, NOT THE ATTACHED VALUE. Every buyer sends
                // price plus a fee margin (the project's own rule), and the price keeps
                // falling until inclusion; booking the whole value made that margin
                // premium, split to the ratchet and treasury and never refunded (audit
                // Low). The ascending lane books its margin into a REFUNDABLE bid; this
                // lane has no later refund, so the change goes back now.
                closeLot(mutate storage, mutate counters, msg.n, bought,
                         in.senderAddress, due, msg.queryId);
                val change = in.valueCoins - due;
                if (change >= MIN_CHANGE) {
                    sendRefund(in.senderAddress, change, msg.queryId);
                }
                return;
            }

            // ---- ascending lanes ----
            // A bid after the window is over is rejected under the same code as a
            // bid on a settled lot: from the bidder's point of view the lot is
            // over either way, and `close(n)` is permissionless so the settled
            // state is one message behind.
            if (rec.closesAt != 0) {
                assert (nowTs < rec.closesAt) throw 1002;  // mkt_lot_already_closed
            }

            val prevBid = rec.highBid;
            val prevBidder = rec.highBidder;
            var updated = rec;
            // V23: the raise's own compute is not the market's to pay. The
            // assert above priced BID_GAS in, so this is still >= high + increment.
            val booked: coins = in.valueCoins - BID_GAS;
            updated.highBid = booked;
            updated.highBidder = in.senderAddress;

            // THE BENEFICIARY BELONGS TO THE WINNING BID, NOT TO THE LOT.
            //
            // This used to be the opener's, written once at `open_lot` and never
            // touched again — so an ascending lot minted to whoever OPENED it
            // however many times it had been outbid, and a winner who paid for
            // the number got nothing. Found on the 2026-09-17 testnet gauntlet:
            // `K` opened 123456792 at the floor, `C` outbid it and won at
            // 1.2279 TON, the close minted, and the item's owner came back `K`.
            // `C` was refunded nothing — it was the high bidder, so its money was
            // the price — and the NFT went to the wallet it had outbid.
            //
            // That contradicts two invariants at once: §4.4/D-90's "winning MINTS
            // the number, in the transaction that closes the lot", and §4.5's
            // "every minted number has a real owner from the transaction that
            // minted it". The auction is the ONLY route to a number ahead of the
            // head, so the whole lane was mispaying.
            //
            // A bidder may still GIFT — `BidLot.beneficiary` is their own field,
            // `addr_none` meaning themselves, exactly as `open_lot` reads it — and
            // the opener's gift survives for as long as the opener is still the
            // high bidder, because the open writes the payload and only a LATER
            // bid overwrites it. `referralKey` moves with it for the same reason:
            // the §4.1 referral line belongs to the mint that actually happens.
            //
            // `kind` and `factors` are deliberately NOT touched. They are the
            // PROOF the lot was opened with, the contract verified them on the
            // way in, and a bidder has no business restating them.
            var payload = rec.payload.load();
            payload.beneficiary = msg.beneficiary.isNone()
                ? in.senderAddress
                : msg.beneficiary.castToInternal();
            payload.referralKey = msg.referralKey;
            updated.payload = payload.toCell();

            if (rec.closesAt == 0) {
                // D-3: THE FIRST BID STARTS THE CLOCK. Only MODE_ASCENDING
                // reaches here — a MODE_DUTCH_BUYNOW bid IS the purchase and
                // settles in this same transaction, never opening a clock
                // (D-20/D-4a/D-88: the head is never parked waiting for a lot).
                updated.closesAt = nowTs + cfg.auctionWindowSec();
            } else {
                // D-8, the max() form.
                val extended = nowTs + cfg.bidExtensionSec();
                if (extended > rec.closesAt) { updated.closesAt = extended; }
            }
            storage.lots.set(msg.n, updated);
            var counters = storage.counters.load();
            counters.heldBids = subHeld(counters.heldBids, prevBid) + booked;
            storage.counters = counters.toCell();
            storage.save();

            // IMMEDIATELY, in this transaction. Never a claimable balance.
            if (prevBid > 0) {
                sendRefund(prevBidder, prevBid, msg.queryId);
            }
        }

        CloseLot => {
            // PERMISSIONLESS.
            assert (msg.n <= AUCTIONABLE_MAX) throw 1020;   // mkt_n_above_cap
            val look = storage.lots.get(msg.n);
            if (!look.isFound) {
                val closeMarks = storage.counters.load().marks;
                assert (!soldBitIn(closeMarks, msg.n)) throw 1002; // mkt_lot_already_closed
                // D-200: a parked lot is a descending one — a purchase ends it, never `close`.
                assert (!parkedBitIn(closeMarks, msg.n)) throw 1005; // mkt_close_too_early
                throw 1000;                                // mkt_lot_not_found
            }
            val rec = look.loadValue();
            assert (rec.closed == 0) throw 1002;           // mkt_lot_already_closed
            var counters = storage.counters.load();

            // D-20/D-88: a MODE_DUTCH_BUYNOW lot has EXACTLY ONE termination,
            // and it is a purchase (`BidLot`, which settles and closes it in the
            // same transaction). The head never reaches it, since a prime is
            // never a position on the sequential line (CONCEPT §6 point 1), so
            // `close` has nothing to do here. The old D-4 void path (head
            // arrives, nobody bought, void the lot) is deleted with it.
            //
            // D-88 point 1 removes the one exception that used to stand here:
            // D-50's `SweepExpiredHeadLot` could delete an unbought descending
            // lot after two decay windows. An unbought lot now PARKS at its
            // resting price until somebody buys it, for as long as that takes,
            // so there is no expiry left on this lane at all.
            assert (rec.mode != MODE_DUTCH_BUYNOW) throw 1005; // mkt_close_too_early

            assert (rec.highBid > 0) throw 1005;           // mkt_close_too_early: no bid to fill
            // D-45 DELETES THE EARLY-CLOSE-ON-HEAD-ARRIVAL DISJUNCT. `n` came
            // off the sequential line the moment this lot opened (see
            // `open_lot`'s `mark_off_head` send), so the head reaching (or
            // passing) `n` is no longer an event this lot needs to react to —
            // it just keeps running its own clock. The ONLY termination left
            // is the clock itself.
            assert (rec.closesAt != 0 && blockchain.now() >= rec.closesAt) throw 1005; // mkt_close_too_early
            closeLot(mutate storage, mutate counters, msg.n, rec,
                     rec.highBidder, rec.highBid, msg.queryId);
        }

        ParkLots => {
            // D-200, PERMISSIONLESS. A resting row's every field is a function of
            // `n` (`parkedLot`), so the row is folded into one `parked` bit and the
            // lot stays open and buyable at the same price. Nothing else changes:
            // `openLots` still counts it, and it still never expires.
            val cfg = storage.cfg.load();
            val nowTs = blockchain.now();
            var counters = storage.counters.load();
            var seen = 0;
            var r = storage.lots.findKeyGreaterOrEqual(msg.from);
            while (r.isFound && seen < PARK_SCAN_MAX) {
                val key = r.getKey();
                val resting = isRestingRow(cfg, r.loadValue(), nowTs);
                r = storage.lots.findKeyGreater(key);
                if (resting) {
                    storage.lots.delete(key);
                    setParkedBit(mutate counters, key);
                }
                seen += 1;
            }
            storage.counters = counters.toCell();
            storage.save();
            // The caller's change. The compute was bought from the attached value,
            // so this contract's float pays neither the scan nor the reply.
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: in.senderAddress,
                body: beginCell().storeUint(0, 32).storeUint(msg.queryId, 64).endCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        }

        RetryPremiumForward => {
            // PERMISSIONLESS. The amount re-sent is what actually came back on
            // the bounce, never a recomputed figure, so a retry can never reach
            // into the standing bids (`heldBids`) of lots that have not closed.
            var counters = storage.counters.load();
            val look = counters.unforwardedByN.get(msg.n);
            assert (look.isFound) throw 104;               // already_processed
            val entry = look.loadValue();
            val returned: coins = entry.amount;
            val cfg = storage.cfg.load();
            // A bounce returns slightly less than was sent (the bounce fee ate
            // the difference), so the retry credits what really came back net of
            // the hop it must pay again.
            val credited: coins = returned > PREMIUM_HOP_GAS ? returned - PREMIUM_HOP_GAS : 0 as coins;
            counters.unforwardedByN.delete(msg.n);
            counters.unforwardedPremium = counters.unforwardedPremium > returned
                ? counters.unforwardedPremium - returned : 0 as coins;
            storage.counters = counters.toCell();
            storage.save();
            if (credited > 0) {
                createMessage({
                    bounce: BounceMode.RichBounce,
                    value: returned,
                    dest: cfg.ledgerAddr,
                    body: (ClearingCleared {
                        queryId: msg.queryId,
                        prime: msg.n as uint256,
                        amount: credited,
                    }).toCell(),
                }).send(SEND_MODE_REGULAR);
            }
        }

        // =================================================================
        // Ledger callbacks
        // =================================================================

        HeadUpdate => {
            val cfg = storage.cfg.load();
            assert (in.senderAddress == cfg.ledgerAddr) throw 100; // wrong_sender
            // D-18: the ledger's head is NOT capped — only the market is — so the
            // hint SATURATES at the cap. `headHint` is documented as a lagging
            // hint that is never authoritative, so saturating is safe: past the
            // cap this contract refuses every `n` anyway, and a saturated hint
            // refuses them for the right reason.
            val capped: int = msg.head > AUCTIONABLE_MAX ? AUCTIONABLE_MAX : msg.head as int;
            if (capped <= storage.headHint) { return; }
            storage.headHint = capped;
            storage.save();
            // No head-collision sweep (D-45): the head never reaches an open
            // lot's number, so a head update triggers nothing else.
        }

        LaunchOpen => {
            // §6 point 0. Idempotent by design: `sync_launch` is permissionless
            // and re-sends this, so a repeat must be a no-op rather than a throw.
            assert (in.senderAddress == storage.cfg.load().ledgerAddr) throw 100;
            if (storage.launched == 0) {
                storage.launched = 1;
                storage.save();
            }
        }

        SettleConfirmed => {
            // The ledger minted the won lot. This ack releases the premium
            // (below) and deletes the closed row (D-188 point 5): the sold bit
            // `closeLot` set is what stops the number being auctioned again.
            val cfg = storage.cfg.load();
            assert (in.senderAddress == cfg.ledgerAddr) throw 100;

            // GAUNTLET V9: the premium leaves here, once the mint is CONFIRMED —
            // see `closeLot`. It is recomputed from `highBid`, which `closeLot`
            // wrote before either send. A bounce on this send is handled by the
            // `0xb0000009` arm and `RetryPremiumForward`.
            val look = storage.lots.get(msg.n as uint64);
            if (look.isFound) {
                val rec = look.loadValue();
                storage.lots.delete(msg.n as uint64);
                val premium: coins = rec.highBid - MINT_PRICE - RES_GAS;
                if (premium > 0) {
                    var counters = storage.counters.load();
                    counters.heldBids = subHeld(counters.heldBids, premium);
                    storage.counters = counters.toCell();
                }
                storage.save();
                if (premium > 0) {
                    createMessage({
                        bounce: BounceMode.RichBounce,
                        value: premium + PREMIUM_HOP_GAS,
                        dest: cfg.ledgerAddr,
                        body: (ClearingCleared {
                            queryId: msg.queryId,
                            prime: msg.n,
                            amount: premium,
                        }).toCell(),
                    }).send(SEND_MODE_REGULAR);
                }
            }
        }

        MarkRejected => {
            // D-45: `mark_off_head` is sent at OPEN, so a rejection means the
            // lot `open_lot` just created never should have existed: some
            // direct mint claimed `n` in the race
            // window between this contract's (lagging) `headHint` check and
            // the ledger's authoritative one. Unwind it here, directly: delete
            // the lot and refund whoever is its CURRENT high bidder (a raise
            // may have landed before this rejection did) the CURRENT high bid,
            // less REJECT_GAS — the auction never actually started, so there is
            // nothing to forfeit, but the market does not pay for the attempt.
            assert (in.senderAddress == storage.cfg.load().ledgerAddr) throw 100;
            val n = msg.n as uint64;    // D-11/D-18: this contract's own `lots` map key width
            val look = storage.lots.get(n);
            if (!look.isFound) {
                // D-200: a descending lot folded before its refusal landed (only a
                // refusal delayed past its whole decay window) — retire the bit.
                var foldCounters = storage.counters.load();
                if (parkedBitIn(foldCounters.marks, n)) {
                    foldCounters.forceCancels += 1;
                    foldCounters.openLots = foldCounters.openLots > 0 ? foldCounters.openLots - 1 : 0;
                    setSoldBit(mutate foldCounters, n);
                    storage.counters = foldCounters.toCell();
                    storage.save();
                }
                return; // else already unwound by an earlier duplicate
            }
            val rec = look.loadValue();
            if (rec.closed != 0) { return; } // already closed; a stale/duplicate reject
            storage.lots.delete(n);
            var counters = storage.counters.load();
            counters.openLots = counters.openLots > 0 ? counters.openLots - 1 : 0;
            counters.forceCancels += 1; // §3.4's published under-report bound
            if (rec.mode == MODE_DUTCH_BUYNOW) {
                // D-196: a descending lot on a prime the ledger says is not
                // unsold — sold ahead of the head. No bid was held. The sold bit
                // makes the refusal permanent, so the lane is tried once.
                setSoldBit(mutate counters, n);
                storage.counters = counters.toCell();
                val cappedHead: int = msg.head > AUCTIONABLE_MAX ? AUCTIONABLE_MAX : msg.head as int;
                if (cappedHead > storage.headHint) { storage.headHint = cappedHead; }
                storage.save();
                return;
            }
            counters.heldBids = subHeld(counters.heldBids, rec.highBid);
            storage.counters = counters.toCell();
            // The refusal carries the ledger's real head: learn it, so the same
            // stale gap cannot be opened into again (saturated as in HeadUpdate).
            val capped: int = msg.head > AUCTIONABLE_MAX ? AUCTIONABLE_MAX : msg.head as int;
            if (capped > storage.headHint) { storage.headHint = capped; }
            storage.save();
            // The BID is returned whole; the gas the failed open burned is not
            // (REJECT_GAS). highBid >= P0 >= LOT_FLOOR, far above REJECT_GAS.
            sendRefund(rec.highBidder, rec.highBid - REJECT_GAS, msg.queryId);
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    var storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    var body = rich.originalBody.beginParse();
    val opcode = body.loadUint(32);

    if (opcode == 0xb0000020) {
        // D-90: a ledger-side refusal of `mint_won_lot` would strand the
        // winner's 1 TON on a contract with no withdraw path, so this refunds
        // the winner, read off the lot record, which is still
        // there: the record is written before the send in `closeLot` and is
        // deleted only here or on `SettleConfirmed`. There is deliberately no
        // retry entrypoint — a refusal that would recur is not worth a
        // permissionless button. What keeps the number from being re-auctioned
        // is the LEDGER'S off-head mark, not a sold bit here: for `n` ahead of
        // `headHint` the market sets none (D-196). That mark is permanent (D-45),
        // so a refused mint on a composite ahead of the head removes it from the
        // game for good — `docs/audit/known-limitations.md` records it.
        //
        // GAUNTLET V9: refunds the PREMIUM too. It is only ever sent on
        // `SettleConfirmed`, which a bounced mint never produces, so it is
        // still in this contract's balance.
        val original = lazy MintWonLot.fromCell(rich.originalBody);
        val look = storage.lots.get(original.n as uint64);
        if (look.isFound && in.valueCoins >= MIN_CHANGE) {
            val rec = look.loadValue();
            val premium: coins = rec.highBid - MINT_PRICE - RES_GAS;
            val owed: coins = premium > 0 ? in.valueCoins + premium : in.valueCoins;
            // D-188: refunded — the row goes, the sold bit stays.
            storage.lots.delete(original.n as uint64);
            if (premium > 0) {
                var counters = storage.counters.load();
                counters.heldBids = subHeld(counters.heldBids, premium);
                storage.counters = counters.toCell();
            }
            storage.save();
            sendRefund(rec.highBidder, owed, original.queryId);
        }
    } else if (opcode == 0xb0000024) {
        // GAUNTLET V9: the prime mint leg's bounce. Mirrors the `0xb0000020`
        // arm exactly; the two mint messages differ only in which ledger
        // opcode they name.
        val original = lazy SettlePrimeClearing.fromCell(rich.originalBody);
        val look = storage.lots.get(original.n as uint64);
        if (look.isFound && in.valueCoins >= MIN_CHANGE) {
            val rec = look.loadValue();
            val premium: coins = rec.highBid - MINT_PRICE - RES_GAS;
            val owed: coins = premium > 0 ? in.valueCoins + premium : in.valueCoins;
            // D-188: refunded — the row goes, the sold bit stays.
            storage.lots.delete(original.n as uint64);
            if (premium > 0) {
                var counters = storage.counters.load();
                counters.heldBids = subHeld(counters.heldBids, premium);
                storage.counters = counters.toCell();
            }
            storage.save();
            sendRefund(rec.highBidder, owed, original.queryId);
        }
    } else if (opcode == 0xb0000009) {
        // The premium forward bounced. The TON came back with it and stays here,
        // on a contract with no other outbound path for it. Book what ACTUALLY
        // returned — not the amount named in the original body, which is larger
        // by the bounce fee — so the permissionless retry can only ever re-send
        // money this contract really holds.
        body.skipBits(64);                 // queryId
        val n = body.loadUint(256);
        var counters = storage.counters.load();
        val prior = counters.unforwardedByN.get(n);
        val had: coins = prior.isFound ? prior.loadValue().amount : 0 as coins;
        counters.unforwardedByN.set(n, Unforwarded {
            amount: had + in.valueCoins,
        });
        counters.unforwardedPremium += in.valueCoins;
        storage.counters = counters.toCell();
        storage.save();
    }
}

// ---------------------------------------------------------------------------
// Get-methods. CONCEPT §9.1: every number the UI shows maps to one of these, and
// the market is a public price-discovery event, so all of it is readable —
// including the "why does 1000 open at 128 TON" breakdown, which is why
// `getLotPrice` returns the SCORE and not only the price.
// ---------------------------------------------------------------------------

// CONCEPT §6 point 0 / §9.1 — WILL THIS CONTRACT TAKE PLAYER MONEY AT ALL?
//
// P2.A8: `launched` gates every money-taking entry point, and §9.1 does not
// allow a state the UI must show — a disabled bid button has to say WHY — to
// exist only as an exit code.
get fun getLaunched(): int {
    val storage = lazy Storage.load();
    return storage.launched;
}

get fun getHeadHint(): int {
    val storage = lazy Storage.load();
    return storage.headHint;
}

// D-11 / D-18, published so the cap is a checkable contract property.
get fun getAuctionableMax(): int {
    return AUCTIONABLE_MAX;
}

// D-30/D-33 — THE quote for opening a lot: one route to a number ahead of the
// head, one price method (plus its factored twin `getLotPriceFrom`).
//
//   p0            what opening the lot costs — and opening IS the first bid, so
//                 this is a payment, not a listing price. Send it PLUS a fee
//                 margin; the contract measures `in.valueCoins >= p0` and the
//                 exact nominal is rejected on a busy block.
//   resGas        the mint cost the winner funds, already inside `p0` on the
//                 ascending lane and added on top of the standing price on the
//                 Dutch lane. Published so the reader can decompose either.
//   minIncrement  D-33's bid step at the opening price: what the SECOND bid must
//                 clear (p0 + minIncrement). Recomputed against the standing
//                 high bid on every raise — `getLot(n).minPayment` is the live
//                 figure once a lot exists.
//   score         D(n). §9.1: the reader must be able to recompute the price,
//                 and `getScoreWeights()` publishes the weights that
//                 produce this number from n alone.
//
// Runs Miller-Rabin itself and never trusts a caller-supplied `kind` — the lane,
// and therefore `p0`'s prime branch, depends on primality.
// The body of both quotes, so the factored read and the from-`n` read cannot
// become two definitions of the price the way D-90 found the tier substitution
// had. Takes the score already computed; computes nothing about `n` itself.
fun lotQuoteOf(cfg: MarketConfig, n: int, score: int, flags: int): (int, int, int, int, int) {
    // The class comes OUT of the score rather than being asked for again: the
    // score walk has already run the 13-witness pass, and running it twice on a
    // read a marketplace crawler hits for every tile is the kind of cost nobody
    // notices.
    val isPrime = isPrimeFromFlags(flags);
    val p0 = openingPriceOf(cfg, n, score, isPrime);
    return (p0, RES_GAS, minIncrementOn(score, p0), score, flags);
}

get fun getLotPrice(n: int): (int, int, int, int, int) {
    // P2.C1: guard BEFORE Miller-Rabin. An unguarded 78-digit argument overflows
    // int257 inside `modpow` and surfaces as exit 4 out of read-proxy instead of
    // a refusal the UI can explain.
    assert (n <= AUCTIONABLE_MAX) throw 1020;   // mkt_n_above_cap
    // GAUNTLET.md C1.4: `open_lot`/`open_head_lot` both refuse a primorial
    // (`throw 1008`) — it is only ever minted at the head, so the era ceremony
    // fires exactly when it mints — and §9.1 forbids quoting a price no lane
    // will ever charge.
    assert (!isPrimorial(n)) throw 1008;       // mkt_primorial_not_auctionable
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    val (score, flags) = scoreOf(n);
    // §9.1: quote the SAME price `open_lot`/`open_head_lot` will actually
    // charge, before the lot exists — by calling the mechanism, never a second
    // definition of the price.
    return lotQuoteOf(cfg, n, score, flags);
}

// PHASE 3 (§4) — THE SAME QUOTE, PRICED OFF A SUBMITTED FACTORIZATION.
//
// `getLotPrice(n)` above is a LOWER BOUND: bits 33..38 and N6's bit 39 are the
// categories `n` alone cannot decide, and it returns them clear. This method takes the
// factor list the caller is about to send to `open_lot` and answers the price
// that call will actually be charged.
//
// WHY A SECOND METHOD AND NOT AN ARGUMENT ON THE FIRST. §4 proposes "an
// optional factorization cell argument", and a TVM get-method has no optional
// arguments — a second declared parameter is a second REQUIRED stack entry, so
// growing `getLotPrice` would break every existing caller (the read-proxy's
// live lane quote among them) to buy nothing a second method does not. The
// lower bound keeps its name and its callers; the full score gets its own.
//
// THE LIST IS NOT VERIFIED HERE. A reader who passes a factorization that does
// not multiply to `n` is quoted a price for a number that is not theirs and
// pays for the read; `open_lot` verifies before it charges anybody, and that is
// the only place the check protects value.
get fun getLotPriceFrom(n: int, factors: map<uint8, FactorEntry>): (int, int, int, int, int) {
    assert (n <= AUCTIONABLE_MAX) throw 1020;   // mkt_n_above_cap
    assert (!isPrimorial(n)) throw 1008;       // mkt_primorial_not_auctionable
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    val (score, flags) = scoreOfFrom(n, factors);
    return lotQuoteOf(cfg, n, score, flags);
}

// (found, mode, p0, standingPrice, minPayment, highBid, highBidder, openedAt,
//  closesAt, closed).
//
// `standingPrice` is the DESCENDING price right now on a Dutch lane and `p0` on
// an ascending one; `minPayment` is exactly what the `bid` handler measures
// `in.valueCoins` against, including the RES_GAS term on the head lane (callers
// still add a fee margin on top — the contract rejects the exact nominal on a
// busy block). `closesAt` is the LIVE value including every snipe extension
// applied so far, and 0 means the clock has not started.
get fun getLot(n: int): (int, int, int, int, int, int, address, int, int, int) {
    val storage = lazy Storage.load();
    val look = storage.lots.get(n);
    val cfg = storage.cfg.load();
    var rec: Lot;
    if (look.isFound) {
        rec = look.loadValue();
    } else {
        val marks = storage.counters.load().marks;
        if (!parkedBitIn(marks, n)) {
            // D-188 point 5: a settled close keeps only its sold bit, so a sold
            // number answers `found = 1, closed = 1` with nothing else — the price
            // and winner are in the close's own transaction, not in storage.
            val sold = soldBitIn(marks, n) ? 1 : 0;
            return (sold, 0, 0, 0, 0, 0, contract.getAddress(), 0, 0, sold);
        }
        // D-200: a parked lot answers as its row did, except `openedAt` = 0.
        rec = parkedLot(cfg, n);
    }
    val nowTs = blockchain.now();
    return (1, rec.mode, rec.p0, dutchPriceOf(cfg, rec, nowTs), minPaymentOn(cfg, rec, nowTs),
            rec.highBid, rec.highBidder, rec.openedAt, rec.closesAt, rec.closed);
}

// D-61 option 2 (GAUNTLET.md C6.2b): (found, floor) for `n`'s lot, running the
// SAME `floorOf` the contract itself prices the lane with — so this cannot
// answer differently from the mechanism by construction. `MODE_ASCENDING`'s
// floor is its own opening bid (an ascending auction never falls below it),
// which does not exist before a lot does, so — like `getLot` — this answers
// (0, 0) for a number with no lot yet rather than guessing one.
get fun getLotFloor(n: int): (int, int) {
    val storage = lazy Storage.load();
    val look = storage.lots.get(n);
    if (!look.isFound) {
        // D-200: a parked lot's floor is the resting price its row carried.
        if (parkedBitIn(storage.counters.load().marks, n)) {
            return (1, parkedLot(storage.cfg.load(), n).priceFloor);
        }
        return (0, 0);
    }
    val rec = look.loadValue();
    val cfg = storage.cfg.load();
    return (1, floorOf(cfg, rec.mode, rec.p0, rec.priceFloor));
}

// D-200: (rows a `park_lots { from }` sent now would fold, the first key it would
// not look at or -1 at the end of `lots`). The keeper pages `from` through the
// map with the second field and sends only when the first is non-zero.
get fun getParkScan(from: int): (int, int) {
    val storage = lazy Storage.load();
    return parkScan(storage.lots, storage.cfg.load(), from, blockchain.now());
}

// D-30: 1 iff a lot may be opened for n at all — the whole of "can I have this
// number ahead of the head". §7 era boundaries mint only at the head and answer
// 0 at any price; so does anything above the D-11 cap. Split out from the price
// so the UI can disable the button with a reason instead of quoting a price
// that throws. The lane is `getLotLane` below.
get fun getIsOpenable(n: int): int {
    return isOpenable(n) ? 1 : 0;
}

// WHICH lane, for a number that is openable. D-88: a rule in TWO terms — where
// the head is, then primality. Specialness changes the PRICE, not the lane.
//
//   -1  not openable at all (primorial, out of range) — see `getIsOpenable`
//    0  MODE_ASCENDING    — ANY number still ahead of the head: `open_lot`,
//       where opening IS a paid first bid at P0(n) and starts a 7-day clock
//    2  MODE_DUTCH_BUYNOW — a PRIME whose turn has passed: `open_head_lot`,
//       then `bid` IS the purchase, descending to `restingPriceOf(n)`
//
// A composite whose turn has passed has no lane at all — it was minted at the
// head for MINT_PRICE, which is the core loop. This answers MODE_ASCENDING for
// it on the same "no lot, nothing to say" basis `getLot` uses; `getIsMinted` on
// the ledger is the authoritative read for that case.
//
// The values are the `mode` values `getLot(n).mode` reports, deliberately, and a
// live lot answers with its OWN mode: an ascending lot opened before the head
// passed it stays ascending, which the head rule alone mis-reported as 2. A prime
// whose sold bit is set has no lane (-1). Lane 2 is still not proof a prime is
// unsold — one sold ahead of the head before the market learned it has no bit
// here; the ledger's ownership read is authoritative (2026-11-08 audit).
get fun getLotLane(n: int): int {
    if (!isOpenable(n)) { return -1; }
    val storage = lazy Storage.load();
    val look = storage.lots.get(n as uint64);
    if (look.isFound) { return look.loadValue().mode; }
    if (!isPrimeMR(n)) { return MODE_ASCENDING; }
    if (n < storage.headHint) {
        return soldBitIn(storage.counters.load().marks, n) ? -1 : MODE_DUTCH_BUYNOW;
    }
    return MODE_ASCENDING;
}

// D-30/D-37: the ONE fee field — what a won lot funds for its mint at close
// (D-90) — and, in `getResFeeSplit`, the `SETTLE_GAS` slice of it that rides to
// the ledger with the mint leg.
get fun getResGas(): int {
    return RES_GAS;
}

get fun getResFeeSplit(): (int, int) {
    return (RES_GAS, SETTLE_GAS);
}

// Every declared format constant, so params.json is checked against the contract
// that actually charges them rather than against a comment. SimCrossCheck.spec.ts
// asserts each field. The prime lane's window is in `getPrimeDutchTerms`, the
// bid ladder in `getIncrementLadder`. `LOT_FLOOR` is params.json's
// `RESERVE_FLOOR` (1.07 TON).
get fun getMarketParams(): (int, int, int, int, int, int, int) {
    // D-139: fields 5 and 6 are the DIVIDED clocks — what this deploy enforces.
    val cfg = lazy Storage.load().cfg.load();
    return (SCORE_HALVING, SCORE_MAX, PRIME_P0_MULT_NUM * 100 / PRIME_P0_MULT_DEN,
            LOT_FLOOR, cfg.auctionWindowSec(), cfg.bidExtensionSec(), MIN_INCREMENT_FLOOR);
}

// D-33's ladder, published entry by entry so §9.1 holds for the bid step the way
// `getFracTable` makes it hold for P0: the minimum raise on any lot is
// recomputable from `n` alone, off chain, with no trust in the UI's arithmetic.
//
// Stack order: the 9 rungs' basis points (band `D(n) / SCORE_HALVING`, 0..8),
// then the shared nanoton floor, then the basis-point denominator. Checked
// against `acquisition.bid_increment_ladder` by `SimCrossCheck.spec.ts`.
get fun getIncrementLadder(): (int, int, int, int, int, int, int, int, int, int, int) {
    return (incrementBpsAt(0), incrementBpsAt(1), incrementBpsAt(2), incrementBpsAt(3),
            incrementBpsAt(4), incrementBpsAt(5), incrementBpsAt(6), incrementBpsAt(7),
            incrementBpsAt(8), MIN_INCREMENT_FLOOR, BPS_DEN);
}

// The descending lane's DECLARED terms (D-88 point 1): the LOWER BOUND on any
// resting price (MINT_PRICE), the window, and the NPV percentage the resting
// price is computed at — enough, with `getNpv(n)` and `getLotPrice(n)`'s p0, to
// recompute `getPrimeFloor(n)` off chain (§9.1). A live lot's own floor is
// `getLotFloor(n)` (D-61 option 2).
get fun getPrimeDutchTerms(): (int, int, int) {
    // D-139: field 2 is the DIVIDED decay window — what this deploy enforces.
    val cfg = lazy Storage.load().cfg.load();
    return (MINT_PRICE, cfg.primeDutchSec(),
            PRIME_FLOOR_MULT_NUM * 100 / PRIME_FLOOR_MULT_DEN);
}

// D-88 point 1, published for §9.1 so the UI can draw the whole descent —
// including where it comes to rest — BEFORE a lot exists. `getLotFloor(n)`
// answers the same number for a lot that already exists and (0, 0) for one that
// does not; this answers it from `n` alone, off the same `restingPriceOf` the
// contract writes into the record, so the two cannot disagree.
get fun getPrimeFloor(n: int): int {
    val storage = lazy Storage.load();
    val (score, _flags) = scoreOf(n);
    return restingPriceOf(storage.cfg.load(), n, score);
}

// D-99 REPLACES `getSpecialNumberTerms(n)`. There are no tiers, no per-tier
// price_max/price_min and no special-only decay window left to publish: a
// number's specialness is its score, its score is its price, and both are in
// `getLotPrice`. What a reader still needs — and §9.1 requires — is the ability
// to recompute that score line by line, so this publishes the SAME
// `(score, flags)` the price was computed from. Sum `pointsForBit(b)` over the
// set bits of `flags`, add `LEN_W · (LEN_REF − digits)`, clamp at `SCORE_MAX`,
// and you must land on `score`. If you do not, the contract is wrong, not you.
get fun getScoreBreakdown(n: int): (int, int) {
    assert (n <= AUCTIONABLE_MAX) throw 1020;   // mkt_n_above_cap
    return scoreOf(n);
}

// PHASE 3 (§4) — the same breakdown with the five factor categories added.
// Same relationship to `getScoreBreakdown` as `getLotPriceFrom` has to
// `getLotPrice`, and the same reason for being a second method. An empty list
// returns exactly what `getScoreBreakdown(n)` returns, so a caller that has no
// factorization loses nothing by calling this one.
get fun getScoreBreakdownFrom(n: int, factors: map<uint8, FactorEntry>): (int, int) {
    assert (n <= AUCTIONABLE_MAX) throw 1020;   // mkt_n_above_cap
    return scoreOfFrom(n, factors);
}

get fun getFracTable(): (int, int, int, int, int, int, int, int, int, int, int) {
    return (fracAt(0), fracAt(1), fracAt(2), fracAt(3), fracAt(4), fracAt(5),
            fracAt(6), fracAt(7), fracAt(8), fracAt(9), FRAC_SHIFT);
}

// D-99's weight table, published entry by entry so a reader can recompute
// `getScoreBreakdown(n).score` from `flags` without trusting this contract's
// arithmetic — the same reason `getFracTable` publishes FRAC and
// `getIncrementLadder` publishes the ladder. Stack order is BIT ORDER
// (`pointsForBit(0..32)`), then the two LEN terms and the clamp, so
// `shared/opcodes.ts` SCORE_BITS and `shared/params.json`'s owner-declared
// block can both be diffed against it position by position.
fun pointsForBit(bit: int): int {
    if (bit == BIT_REPDIGIT) { return W_REPDIGIT; }
    if (bit == BIT_POW10) { return W_POW10; }
    if (bit == BIT_PALINDROME) { return W_PALINDROME; }
    if (bit == BIT_RUN) { return W_RUN; }
    if (bit == BIT_ABAB) { return W_ABAB; }
    if (bit == BIT_TRAILING_ZEROS) { return W_TRAILING_ZEROS; }
    if (bit == BIT_YYYYMMDD) { return W_YYYYMMDD; }
    if (bit == BIT_DMY8) { return W_DMY8; }
    if (bit == BIT_YEAR) { return W_YEAR; }
    if (bit == BIT_YYMMDD) { return W_YYMMDD; }
    if (bit == BIT_MMDD) { return W_MMDD; }
    if (bit == BIT_MERSENNE) { return W_MERSENNE; }
    if (bit == BIT_FERMAT) { return W_FERMAT; }
    if (bit == BIT_PERFECT) { return W_PERFECT; }
    if (bit == BIT_PRIMORIAL) { return W_PRIMORIAL; }
    if (bit == BIT_FACTORIAL) { return W_FACTORIAL; }
    if (bit == BIT_PRIME) { return W_PRIME; }
    if (bit == BIT_POW2) { return W_POW2; }
    if (bit == BIT_FIBONACCI) { return W_FIBONACCI; }
    if (bit == BIT_CUBE) { return W_CUBE; }
    if (bit == BIT_TWIN) { return W_TWIN; }
    if (bit == BIT_SOPHIE_GERMAIN) { return W_SOPHIE_GERMAIN; }
    if (bit == BIT_SAFE_PRIME) { return W_SAFE_PRIME; }
    if (bit == BIT_EMIRP) { return W_EMIRP; }
    if (bit == BIT_SQUARE) { return W_SQUARE; }
    if (bit == BIT_TRIANGULAR) { return W_TRIANGULAR; }
    if (bit == BIT_HARSHAD) { return W_HARSHAD; }
    if (bit == BIT_HAPPY) { return W_HAPPY; }
    if (bit == BIT_DIGITSUM_PRIME) { return W_DIGITSUM_PRIME; }
    if (bit == BIT_ICONIC) { return W_ICONIC; }
    if (bit == BIT_LISTED) { return W_LISTED; }
    if (bit == BIT_LANDMARK) { return W_LANDMARK; }
    if (bit == BIT_CONSTANT) { return W_CONSTANT; }
    if (bit == BIT_SEMIPRIME) { return W_SEMIPRIME; }
    if (bit == BIT_PRIME_POWER) { return W_PRIME_POWER; }
    if (bit == BIT_SQUAREFREE) { return W_SQUAREFREE; }
    if (bit == BIT_SMOOTH) { return W_SMOOTH; }
    if (bit == BIT_ABUNDANT) { return W_ABUNDANT; }
    if (bit == BIT_DEFICIENT) { return W_DEFICIENT; }
    if (bit == BIT_CARMICHAEL) { return W_CARMICHAEL; }
    if (bit == BIT_PANDIGITAL) { return W_PANDIGITAL; }
    if (bit == BIT_NARCISSISTIC) { return W_NARCISSISTIC; }
    if (bit == BIT_AUTOMORPHIC) { return W_AUTOMORPHIC; }
    if (bit == BIT_SQUARE_TRIANGULAR) { return W_SQUARE_TRIANGULAR; }
    if (bit == BIT_KAPREKAR) { return W_KAPREKAR; }
    if (bit == BIT_HIGHLY_COMPOSITE) { return W_HIGHLY_COMPOSITE; }
    if (bit == BIT_KEITH) { return W_KEITH; }
    if (bit == BIT_CATALAN) { return W_CATALAN; }
    if (bit == BIT_SMITH) { return W_SMITH; }
    if (bit == BIT_SPHENIC) { return W_SPHENIC; }
    if (bit == BIT_POWERFUL) { return W_POWERFUL; }
    if (bit == BIT_ACHILLES) { return W_ACHILLES; }
    if (bit == BIT_LUCAS) { return W_LUCAS; }
    if (bit == BIT_PRONIC) { return W_PRONIC; }
    return 0;
}

// PHASE 3 widened this to 39 bits + the four terms, N6 to 48 and D-162 to 54.
// The FACTOR weights are published for the same §9.1 reason the rest are:
// `getLotPriceFrom` can set bits 33..39 and 48..51, and the mint path can set
// 40..47, 52 and 53, so a reader must be able to sum them back to the price it
// was quoted. A reader holding no factorization sees them clear and the sum
// still closes.
get fun getScoreWeights(): (int, int, int, int, int, int, int, int, int, int, int,
                            int, int, int, int, int, int, int, int, int, int, int,
                            int, int, int, int, int, int, int, int, int, int, int,
                            int, int, int, int, int, int, int, int, int, int, int,
                            int, int, int, int, int, int, int, int, int, int, int,
                            int, int, int) {
    return (pointsForBit(0), pointsForBit(1), pointsForBit(2), pointsForBit(3),
            pointsForBit(4), pointsForBit(5), pointsForBit(6), pointsForBit(7),
            pointsForBit(8), pointsForBit(9), pointsForBit(10), pointsForBit(11),
            pointsForBit(12), pointsForBit(13), pointsForBit(14), pointsForBit(15),
            pointsForBit(16), pointsForBit(17), pointsForBit(18), pointsForBit(19),
            pointsForBit(20), pointsForBit(21), pointsForBit(22), pointsForBit(23),
            pointsForBit(24), pointsForBit(25), pointsForBit(26), pointsForBit(27),
            pointsForBit(28), pointsForBit(29), pointsForBit(30), pointsForBit(31),
            pointsForBit(32), pointsForBit(33), pointsForBit(34), pointsForBit(35),
            pointsForBit(36), pointsForBit(37), pointsForBit(38), pointsForBit(39),
            pointsForBit(40), pointsForBit(41), pointsForBit(42), pointsForBit(43),
            pointsForBit(44), pointsForBit(45), pointsForBit(46), pointsForBit(47),
            pointsForBit(48), pointsForBit(49), pointsForBit(50), pointsForBit(51),
            pointsForBit(52), pointsForBit(53),
            LEN_REF, LEN_W, TZ_CAP, SCORE_MAX);
}


// The deploy-fixed peer addresses, published so the zero-admin-surface claim is
// checkable from outside; no message changes either. Value leaves only to the
// ledger or as a bidder's refund — `ratchetAddr` is published, never paid.
get fun getMarketConfig(): (address, address) {
    val storage = lazy Storage.load();
    val cfg = storage.cfg.load();
    return (cfg.ledgerAddr, cfg.ratchetAddr);
}

// NPV(p) as this contract will actually price it, or 0 for a miss.
get fun getNpv(n: int): int {
    val storage = lazy Storage.load();
    return storage.cfg.load().npvTable.get(n).isFound
        ? storage.cfg.load().npvTable.get(n).loadValue() : 0;
}

// (openLots, closedLots, lotPremiumTotal, unforwardedPremium, headHint,
//  forceCancels).
//
// `forceCancels` counts lots unwound by a ledger `mark_rejected` race loss.
//
// `lotPremiumTotal` is the live demand signal: a standing bid can walk back out
// on a cancellation, a booked premium cannot. `unforwardedPremium` is the
// honesty term: premium this contract booked but the ledger has not accepted,
// retryable by anyone.
get fun getMarketStats(): (int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    val c = storage.counters.load();
    return (c.openLots, c.closedLots, c.lotPremiumTotal, c.unforwardedPremium,
            storage.headHint, c.forceCancels);
}

// §3.4's one-call check, same shape as the ledger's, ratchet's and registrar's:
// (balance, declared liability, delta). The liability is every TON this
// contract owes somebody — standing high bids on open lots, premiums awaiting
// `SettleConfirmed`, and premiums parked by a bounced forward. The rest of the
// balance is RES_GAS headroom and rent; delta < 0 is insolvency.
get fun getSolvency(): (int, int, int) {
    val storage = lazy Storage.load();
    val c = storage.counters.load();
    val balance = contract.getOriginalBalance();
    val liability = c.heldBids + c.unforwardedPremium;
    return (balance, liability, balance - liability);
}
