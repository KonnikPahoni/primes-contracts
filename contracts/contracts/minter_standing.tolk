tolk 1.4

// ============================================================================
// TON PRIMES — a wallet's rebate STANDING: its layout, the two ladders and the
// uplift sum. CONCEPT.md §4.5, §4.7, §4.7.1, §5.1; DECISIONS.md D-191 point 1.
//
// Imported by BOTH primes_ledger.tolk (which prices k off the standing a card
// attaches to a mint) and primes_minter_card.tolk (which holds it, spends its
// windows and answers the per-wallet get-methods). One file so the two can never
// disagree about a threshold, an uplift or a window size; `SimCrossCheck.spec.ts`
// pins the four constants below to shared/params.json.
// ============================================================================

const PRIME_UPLIFT: int = 50000000;    // 0.05 (rebate.PRIME_UPLIFT), live on the beneficiary's next PRIME_WINDOW composite mints (§5.1)
const PRIME_WINDOW: int = 6;           // rebate.PRIME_WINDOW; §5.1's binding constraint PRIME_UPLIFT·PRIME_WINDOW = 0.30 < k_max(n) over the modeled range (params.json invariant_prime_uplift_x_window_lt_kmax)
// §4.5 / D-106: "A wallet's first five mints after receiving its first gifted
// number run at a raised rebate ceiling — k_max + NEWCOMER_UPLIFT, under the
// same hard K_CEIL = 0.95 clamp as rank." Opened by the gift mint itself (D-106)
// (params.json invites.newcomer_lever_sweep.selected, which DELIBERATELY did
// not move them off the incumbent pair: selecting a larger credit needs the
// elasticity of the take-up rate with respect to it, and no such number exists
// before mainnet).
const NEWCOMER_UPLIFT: int = 50000000; // 0.05 (rebate.NEWCOMER_UPLIFT)
const NEWCOMER_WINDOW: int = 5;        // rebate.NEWCOMER_WINDOW

// WS2 §5.1 / §4.7.1: a wallet's rebate standing. Held on the wallet's MINTER
// CARD (D-191 point 1) and ATTACHED to every head mint by it, because the mint
// path must price k off it synchronously and a cross-contract read at mint time
// is impossible on TON. Keyed by the BENEFICIARY — a gift is sent through the
// recipient's card — because §5.1 says the credit and the rank increment follow
// the beneficiary exactly as the rebate does. `card_mint` carries this layout.
struct MinterState {
    primesMinted: uint32   // lifetime count; the §4.7.1 ladder reads off this
    window: uint8          // remaining PRIME_UPLIFT composite mints; a second prime RESETS it, never stacks (§5.1)
    // §4.5 / D-106: "A wallet's first five mints after receiving its first
    // gifted number run at a raised rebate ceiling." Opened by the recruit edge
    // on the card (a gift to a card no accepted event has touched),
    // spent one per clocked composite mint exactly as `window` is.
    newcomerWindow: uint8
    // §4.7 / D-106: lifetime recruits — addresses this wallet introduced with a
    // §4.5 gift mint. The recruit-rank ladder's input, and the era trophy's.
    //
    // It rides in THIS struct because the struct already reaches the ledger on
    // every mint to resolve the prime-rank line, so the recruit-rank term costs
    // nothing more to read.
    recruits: uint32
    // G80: set once, by the recruit edge that opens `newcomerWindow`, and never
    // cleared. `newcomerWindow` counts DOWN to 0, so 0 alone cannot tell "was
    // gifted and spent all five" from "never gifted" — the §9.4 quests
    // "Mint your first number" and "Spend the whole newcomer window" read this.
    newcomerOpened: bool
}

// §4.7.1: the prime-rank ladder. Tiers I–V at 1/3/10/30/100 primes minted,
// uplifts 0.01/0.02/0.035/0.05/0.08 — both arrays verbatim from params.json
// rebate.prime_rank_tiers / rebate.prime_rank_kmax_uplifts (Phase A outputs;
// CLAUDE.md rule 3 — never invent an economic parameter).
fun primeRankTier(primesMinted: int): int {
    if (primesMinted >= 100) { return 5; }
    if (primesMinted >= 30) { return 4; }
    if (primesMinted >= 10) { return 3; }
    if (primesMinted >= 3) { return 2; }
    if (primesMinted >= 1) { return 1; }
    return 0;
}

fun primeRankUplift(primesMinted: int): int {
    val tier = primeRankTier(primesMinted);
    if (tier == 5) { return 80000000; } // 0.08
    if (tier == 4) { return 50000000; } // 0.05
    if (tier == 3) { return 35000000; } // 0.035
    if (tier == 2) { return 20000000; } // 0.02
    if (tier == 1) { return 10000000; } // 0.01
    return 0;
}

// §4.7 / D-106: the RECRUIT-rank ladder. Same shape as the prime ladder above
// and deliberately so — §4.7 issues one kind of thing, power, and two ladders
// that issue it in different shapes would be two mechanics. Tiers at
// 1/3/10/30/100 RECRUITS, uplifts 0.01/0.02/0.035/0.05/0.08, verbatim from
// params.json rebate.recruit_rank_tiers / rebate.recruit_rank_kmax_uplifts.
//
// D-106: a recruit counts on the §4.5 GIFT MINT, and only when the gifted
// wallet's minter card is FRESH (D-191 point 1). This ladder is the whole reward
// for introducing someone.
fun recruitRankTier(recruits: int): int {
    if (recruits >= 100) { return 5; }
    if (recruits >= 30) { return 4; }
    if (recruits >= 10) { return 3; }
    if (recruits >= 3) { return 2; }
    if (recruits >= 1) { return 1; }
    return 0;
}

fun recruitRankUplift(recruits: int): int {
    val tier = recruitRankTier(recruits);
    if (tier == 5) { return 80000000; } // 0.08
    if (tier == 4) { return 50000000; } // 0.05
    if (tier == 3) { return 35000000; } // 0.035
    if (tier == 2) { return 20000000; } // 0.02
    if (tier == 1) { return 10000000; } // 0.01
    return 0;
}

// §5's uplift line for one wallet, now complete:
//   uplift(prime_rank) + PRIME_UPLIFT·1{window} + NEWCOMER_UPLIFT·1{window}
//     + uplift(recruit_rank)
//
// FOUR terms (D-168 deleted D-34's inert fifth, the stake leg). THE INVARIANT
// IS THE POINT: this function returns a SUM, and `kMaxEffective` clamps
// that sum ONCE at K_CEIL. Lighting up two more terms cannot bypass the clamp,
// because there is still exactly one clamp and it is still on the total. A
// wallet holding prime rank V + a live prime window + a live newcomer window +
// recruit rank V sums 0.08 + 0.05 + 0.05 + 0.08 = 0.26 of uplift and still
// cannot make `k` reach 1 — see FuzzInvariants.spec.ts, which stacks exactly
// that.
fun upliftSumFor(state: MinterState): int {
    var sum = primeRankUplift(state.primesMinted);
    if (state.window > 0) { sum += PRIME_UPLIFT; }
    if (state.newcomerWindow > 0) { sum += NEWCOMER_UPLIFT; }
    sum += recruitRankUplift(state.recruits);
    return sum;
}

// The recruit ladder's next rung, so a reader can draw the distance to it
// without hardcoding the thresholds (§9.1). 0 past the top tier.
fun recruitNextTierAt(tier: int): int {
    if (tier == 0) { return 1; }
    if (tier == 1) { return 3; }
    if (tier == 2) { return 10; }
    if (tier == 3) { return 30; }
    if (tier == 4) { return 100; }
    return 0;
}
