/**
 * TON PRIMES — the quest board. EARN_PLAN E3.2, CONCEPT.md §9.4 / §9.5.
 *
 * ---- The split that organises this whole file ----
 *
 * §9.4 divides quests by what a contract can check, and routes each half to a
 * different settlement path. That division is not a nicety; it is §2 principle 5
 * applied to rewards:
 *
 *   CONTRACT settlement — the condition IS a contract fact, so it is verified in
 *     the claim transaction and no server attests to anything. Recruit quests,
 *     prime quests and game quests are all of this kind. §9.4: "these need no
 *     verification layer at all — the quest condition is already a contract
 *     fact." D-106 makes that MORE true, not less: a recruit is now a gift mint
 *     to an address `minterState` has never seen, which is one boolean the
 *     ledger already computes.
 *
 *   VOUCHER settlement — the condition is genuinely off-chain (a story reached
 *     people, a bot got connected, a game was played), so it is scored here and
 *     paid via a §9.5 signed voucher the player redeems themselves.
 *
 * Routing a contract-checkable quest through a voucher would be a silent
 * downgrade from proof to assertion, so `settlement` is derived from the track
 * definition and is not a per-quest field anyone can set by hand.
 *
 * ---- The gate that applies to every voucher quest, without exception ----
 *
 * Owner decision 0.2.1 and §9.4's own reasoning: counted Telegram starts are just
 * Telegram accounts, and those cost cents. So no voucher quest completes on
 * counted reach alone — it completes when the reach includes AT LEAST ONE on-chain
 * mint attributed to it. `VOUCHER_GATE` names that mint per voucher track, and
 * `evaluateQuests` enforces it rather than trusting the definitions — a voucher track
 * with no entry there fails closed.
 *
 * Locked-but-visible is part of the model (§9.4's last bullet), not a UI trick: a
 * locked quest is returned with its unmet prerequisite named, so the board can
 * show the next step honestly instead of hiding it.
 */

import params from "@ton-primes/shared/params.json" with { type: "json" };

import type { Evidence } from "./funnel.js";
import { SOCIAL_CHANNEL, SOCIAL_GROUP } from "./telegram.js";

/** Where a completed quest is paid from. */
//   "contract" — verified in the claim transaction. No signature, no operator, no trust.
//   "voucher"  — scored here, paid by a §9.5 signed voucher the player redeems themselves.
// Declared once in `@ton-primes/shared/wire` with the rest of the `/earn` payload (G64).
import type { QuestStateWire, QuestTrack, Settlement } from "@ton-primes/shared/wire";
export type { QuestTrack, Settlement };

/**
 * §9.4's tracks. D-106 merged `patron` into `recruit`: with patron mode deleted
 * there is one relationship (a gift mint) and not two, so two tracks over the
 * same event would have paid twice for one act.
 */
// (`QuestTrack` is imported above from `@ton-primes/shared/wire`.)

/**
 * Which settlement each track uses. Derived from §9.4 sentence by sentence, and
 * the reason each one is what it is:
 *
 *  prime / recruit / game — every condition is a contract fact (a mint happened,
 *    a rank was reached, a tribute was claimed), so they settle on-chain.
 *    Recruit quests are "gift a fresh address -> they mint -> they spend the
 *    window", all three of which are contract facts; game quests are tribute
 *    claims and lots opened, likewise. Constellations are NOT among them:
 *    `DECISIONS.md` D-102 retired set registration, so the quest that read it
 *    is deleted rather than repointed (see `quest-facts-live.test.ts`).
 *  referral — "first referred mint, N active referees (measured by their on-chain
 *    mints)". Measured on-chain, so on-chain.
 *  story — genuinely off-chain, and one of the two that need §9.5.
 *  social — §9.4's acquisition funnel: Telegram channel and group membership,
 *    membership that SURVIVES, and an invite that ends in a mint. No contract can
 *    see any of it. But note the difference from `story`, because it is the whole
 *    reason this track is allowed to exist: a counted bot-start is something the
 *    player's own client asserts, whereas channel membership is something TELEGRAM
 *    is asked about, with the bot's own token, at the moment of issuance. The
 *    operator is relaying an answer rather than volunteering one. That is still
 *    weaker than a chain fact, which is exactly why the mint gate below applies to
 *    this track too and why every reward is drawn against a
 *    genesis-fixed bucket.
 */
export const TRACK_SETTLEMENT: Record<QuestTrack, Settlement> = {
  referral: "contract",
  recruit: "contract",
  prime: "contract",
  game: "contract",
  story: "voucher",
  social: "voucher",
};

/**
 * G78b / D-171 — which voucher instance PAYS each track. `TRACK_SETTLEMENT` above is the
 * EVIDENCE class (a contract fact or a counted one) and it did not move; this is the payer.
 * No contract ever verified a quest in its own claim transaction, so the contract-fact
 * tracks are paid by the `PQST` instance from `prime_quests`, on totals this service
 * computes from chain facts the event index and the read-proxy observed — never from the
 * request. The off-chain tracks stay on `QSTS`, from `quests`.
 */
export type VoucherProgram = "quests" | "prime_quests";
export const TRACK_PROGRAM: Record<QuestTrack, VoucherProgram> = {
  referral: "prime_quests",
  recruit: "prime_quests",
  prime: "prime_quests",
  game: "prime_quests",
  story: "quests",
  social: "quests",
};

/**
 * DECISIONS.md D-213 — the most wallets any ONE quest ever pays, per voucher instance. Each
 * track's params block says it is divided into exactly `target_wallets` equal rewards "spent to
 * exhaustion, first come first served"; this makes that true PER QUEST, so a farmable quest (the
 * story quest counts self-reported connects) cannot spend the other quests' share of the track.
 * Not a new parameter: the sim's own headcount, read where it lives.
 */
export const QUEST_MAX_WALLETS: Record<VoucherProgram, number> = {
  quests: params.genesis.quest_rewards.target_wallets,
  prime_quests: params.genesis.quest_rewards.prime_quests.target_wallets,
};

/**
 * The facts a quest can be evaluated against. Split by evidence class, because
 * which half a quest reads determines how it can be settled — a quest that reads
 * anything from `offChain` cannot settle on-chain, by construction.
 */
export interface QuestFacts {
  /** Chain facts, each traceable to a get-method named in the quest's `source`. */
  onChain: {
    /** Numbers this wallet has minted. */
    mintCount: number;
    /** Primes minted — `getMinterState().primesMinted`. */
    primesMinted: number;
    /** §4.7.1 prime-rank tier, 0..5. */
    primeRankTier: number;
    /**
     * §4.5 / D-106: fresh addresses this wallet introduced — gift mints whose
     * beneficiary the ledger had never seen. NOT the same as `giftMints` below,
     * which counts every gift including repeats to the same wallet.
     */
    recruitsIntroduced: number;
    /** §4.7 recruit-rank tier, 0..5 — `getRecruitRank().tier`. */
    recruitRankTier: number;
    /** Giftee side: was this wallet's first number a gift from someone else? */
    wasGifted: boolean;
    /** Recruit side: remaining NEWCOMER_UPLIFT window — `getNewcomerWindow().left`. */
    newcomerWindowLeft: number;
    /** Mints made while the newcomer window was open. */
    mintsInsideNewcomerWindow: number;
    /** §3.2: tribute claims settled. */
    tributeClaims: number;
    /** §4.4 lots opened ahead of the head. */
    lotsOpened: number;
    /** §4.5 gift mints paid for. */
    giftMints: number;
    /** Mints by OTHER wallets that paid this wallet's referral line. */
    attributedMints: number;
    /** Distinct referees whose own mints are still arriving. */
    activeReferees: number;
  };
  /** Off-chain tallies. Only the story track may read these. */
  offChain: {
    /** Counted bot starts tagged with this sharer's story source label. */
    countedStarts: number;
    /**
     * THE STORY GATE. Whether the sharer's own key `rN` has ≥1 mint whose referral line
     * the ledger PAID — `DECISIONS.md` D-160 option 2, KEY granularity. It used to be "on
     * that same label", a per-wallet join the event index cannot answer (it publishes
     * counts, not payer lists); so a player with two story cards meets it from either.
     */
    keyPaidMint: boolean;
    /**
     * THE SOCIAL GATE. Whether this wallet PAID for ≥1 mint whose referral line the ledger
     * paid (`mints.payer`, the event index's `paidReferralMints`) — GAUNTLET.md J9 option 1,
     * asked by wallet alone. It used to be the paid count of the wallet's §9.2 frozen key,
     * read from a `frozen_attributions` row nothing ever wrote.
     */
    paidReferralMint: boolean;

    // ---- §9.4 social track. Answered by Telegram, not by the client ----
    //
    // Every field here is filled from a `getChatMember` call the BOT makes with
    // its own token (see `telegram.ts`), against a Telegram user id that arrived
    // inside a `initData` payload Telegram itself HMAC-signed. Neither is a chain
    // fact and neither is labelled `proved`. What they are is un-forgeable by the
    // requester, which is the property the voucher route needs and the property
    // `countedStarts` does not have.

    /** Member of the §9.4 announcement channel right now. */
    channelMember: boolean;
    /** Member of the §9.4 community group right now. */
    groupMember: boolean;
    /**
     * Whole days since the EARLIEST membership this service observed that is
     * still unbroken. Reset to 0 by a leave, which is what makes the 7-day quest
     * a retention quest rather than a second join quest — join, claim, leave and
     * rejoin restarts the clock rather than banking it.
     */
    membershipDays: number;
    /**
     * D-73/D-118's `connect` quest: this wallet has a `wallet_telegram_links` row.
     * Written only by one of D-150's two doors — a Mini App request whose `initData`
     * Telegram signed (the K1 auto-link), or a one-time code the wallet's session
     * minted and the Telegram side CONFIRMED in the bot. `/unlink` deletes the row and
     * this reads false again. Ignores the `enabled` flag on purpose: that is push
     * consent (K1), not "is this account linked".
     */
    telegramLinked: boolean;
  };
}

export interface QuestDef {
  id: string;
  track: QuestTrack;
  title: string;
  /** What the player has to do, in the game's voice. */
  description: string;
  /**
   * What this quest pays, and — the part that matters — WHICH UNIT is the fixed
   * one. Vault-funded either way; see the denomination note below for why the two
   * tracks answer that question differently and what each choice costs.
   */
  reward: QuestReward;
  /** Target for the progress shape. Bounded quantities get a shape, not a digit. */
  target: number;
  /** Reads the facts and returns raw progress toward `target`. */
  progress: (f: QuestFacts) => number;
  /**
   * The get-method (or counting mechanism) a reader checks this against. §9.1:
   * every tile links to its source.
   */
  source: string;
  /** Evidence class of the progress figure. */
  evidence: Evidence;
  /** Named prerequisite that must hold before the quest is even attemptable. */
  prerequisite?: { label: string; met: (f: QuestFacts) => boolean };
  /**
   * Where the player GOES to do this, if the quest is doable somewhere specific.
   *
   * §9.4's social quests are acquisition, and an acquisition funnel that names a
   * chat without opening it is asking the player to retype an @username into
   * another app. Every URL here must point at the same chat `telegram.ts` checks
   * membership of — a card that opens one chat and pays for another is the §9.1
   * problem wearing a different hat.
   */
  actionUrl?: string;
}

/**
 * What a quest pays, in the unit that is held FIXED for it.
 *
 * ---- Why there are two, and why that is not an inconsistency (D-41 / D-42) ----
 *
 * The other unit is always a quote at the current floor, so both variants render
 * a TON figure and a PRIMES figure. What differs is which one moves when `p_f`
 * does, and that follows from what the reward is FOR.
 *
 * `ton` — the seventeen legacy quests. These reward things a player does inside
 * the game (mints, referrals), and the promise is a fixed WORTH.
 * A nominal PRIMES reward would inflate ~45x over year one against a
 * genesis-fixed budget, so the value is fixed and the PRIMES fall out.
 * DENOMINATION_PLAN P4.
 *
 * `primes` — §9.4's social quests, as of D-42. These are ACQUISITION, and the
 * owner's target is a HEADCOUNT (10,000 wallets under D-42; 1,000 since D-204) paid out of a `quests` track
 * whose size is fixed in PRIMES. A fixed headcount out of a fixed PRIMES stock is
 * only arithmetically possible if the per-player draw is fixed in PRIMES too.
 * Under P4's TON denomination the early players were the expensive ones — 0.25 TON
 * cost 3,750 PRIMES at the opening floor and ~10 PRIMES at the sim's end state —
 * so the track funded ~65 players in the first months and the remaining 9,935
 * only years later. That is backwards for a growth programme. Fixing the PRIMES
 * inverts it: the count is guaranteed on day one and the VALUE is what grows.
 *
 * The reason this does not reintroduce the inflation P4 was written to stop is
 * `capShare`. A fixed PRIMES reward appreciates without bound, so it eventually
 * crosses `QUEST_LIFETIME_CAP_TON` on its own — and past that line the programme
 * stops being self-funding. `capShare` is this quest's slice of the board's
 * allowance — its share of `QUEST_LIFETIME_CAP_TON` across both PRIMES boards (the cap was
 * netted of TON-denominated quests until D-118's 2026-11-20 amendment left none) — and `questRewardPrimes` clamps the payout
 * to it at CLAIM time. The shares sum to 1 across the board, so the clamp bounds
 * the wallet's lifetime total and not merely each quest.
 */
export type QuestReward = { denomination: "primes"; primes: number; capShare: number };

/**
 * The genesis floor as PRIMES per TON — `1 / p_f0`, read from the file that owns
 * it. §6 quotes the floor in this direction on purpose (a reciprocal with four
 * leading zeros is not a number anyone can hold in their head), and this is the
 * conversion every reward below is quoted at until the ratchet moves it.
 */
export const GENESIS_PRIMES_PER_TON =
  1 / params.genesis.genesis_floor_price_ton_per_primes;

/**
 * ---- Reward sizing ----
 *
 * These are amounts inside the vault's genesis-fixed `quests` / `prime_quests`
 * buckets (params.json
 * `genesis.era_bounty_schedule.remaining_vault_split.tracks`). They are a
 * DISTRIBUTION of an already-decided budget, not new economic parameters: the
 * vault cannot pay more than its allow-list entry however these are set, and
 * every PRIMES in the vault was pre-counted into `S` at genesis (§3.3/§5), so
 * `p_f` is untouched no matter which of these fires.
 *
 * ---- Why the unit differs by track (DENOMINATION_PLAN P4, then D-42) ----
 *
 * A fixed nominal PRIMES reward is not a fixed reward. `p_f` rises ~45x over year
 * one at baseline demand and rises forever after (§5's ratchet theorem, which is
 * the whole point of the token), so a 100-PRIMES quest worth 0.083 TON at open is
 * worth 3.85 TON at day 365 — a quest board that quietly inflates its own payouts
 * by two orders of magnitude against a genesis-fixed budget. Redenominating `L`
 * alone does not fix that; it only restarts the same climb from a lower base.
 *
 * So for those quests what is fixed is the VALUE, and the PRIMES figure is a quote
 * at the current floor. The board renders `rewardPrimesQuote`; the voucher pays a
 * LOCKED conversion (see `voucherEarnedPrimes`).
 *
 * D-42 goes the other way for §9.4's social board, and the reversal is deliberate
 * rather than an inconsistency: there the owner is buying a headcount out of a
 * PRIMES-fixed stock, so the PRIMES are fixed and `questRewardPrimes` clamps the
 * TON value to keep the inflation P4 warns about from crossing the self-funding
 * ceiling. See `QuestReward` for the full argument.
 *
 * The relative weighting follows §9.4's own instruction that prime quests
 * "should be the most generously funded" — they point at the game's one liveness
 * risk (§5.1) — and that the recruit-side track is aimed squarely at whether a
 * gifted wallet ever mints one of its own.
 */
/**
 * A §9.4 social quest's reward, in PRIMES, read from the sim's own output.
 *
 * These are NOT sized here and must not be. `sim/scripts/run_phase1.py`'s
 * `quest_reward_report` divides the vault's `quests` track by the owner's target
 * player count (D-204: 1,000; D-42 had 10,000) and splits the result across the five quests (D-118: equal fifths since 2026-11-20, story included), and
 * it carries the arithmetic for why a vault-funded programme is bounded the way it
 * is: the vault is pre-counted into `S` with no `T` behind it (§3.3), so its whole
 * worth at the opening floor is `T₀ · pct/(1 + pct)`. Raising the vault fraction
 * DOES raise that worth — D-42's 50% → 100% took it from 67 to 100 TON — and pays
 * for the increase entirely in a lower `p_f0`. What it can never do is pass `T₀`
 * itself, which is why 10,000 players cannot each be paid 0.5 TON at opening
 * prices: that is 5,000 TON against a 200 TON founder seed.
 *
 * `capShare` rides along from the same row so the claim-time clamp and the reward
 * cannot drift apart.
 *
 * A missing id throws rather than defaulting. CLAUDE.md rule 3: a reward that is
 * not traceable to params.json or CONCEPT.md is a bug, and a silent fallback is
 * the exact shape that bug takes.
 */
const socialReward = (id: string): QuestReward => {
  const row = params.genesis.quest_rewards.rewards.find((r) => r.quest_id === id);
  if (!row) throw new Error(`no quest_rewards entry for ${id} in params.json — re-run sim/scripts/run_phase1.py`);
  return { denomination: "primes", primes: row.reward_primes, capShare: row.share_of_cap };
};

/**
 * G78b / D-171 — a contract-fact quest's reward, in PRIMES, from the sim's
 * `quest_rewards.prime_quests` block (the `prime_quests` track over D-42's headcount).
 * `capShare` is the row's share of the ONE lifetime cap both boards live under.
 */
const primeQuestReward = (id: string): QuestReward => {
  const row = params.genesis.quest_rewards.prime_quests.rewards.find((r) => r.quest_id === id);
  if (!row) throw new Error(`no quest_rewards.prime_quests entry for ${id} in params.json — re-run sim/scripts/run_phase1.py`);
  return { denomination: "primes", primes: row.reward_primes, capShare: row.share_of_cap };
};

/**
 * The ceiling on everything one wallet can ever earn from quests, in TON. Owner
 * decision 2026-08-19, and an INVARIANT rather than a budget.
 *
 * It equals `β · MINT_PRICE` — the ratchet injection of the mint that unlocks the
 * reward. The reason that particular number is the bound: a vault payout leaves
 * `S` untouched (§3.3 pre-counts the vault) while the gating mint adds `β` TON to
 * `T`, so every quest-paid wallet strictly RAISES `p_f` as long as it is not paid
 * more than its own mint injected. Cross this line and the program stops being
 * self-funding and starts being a claim on other holders' backing.
 *
 * `questCeilingTon` below asserts the whole board against it.
 */
export const QUEST_LIFETIME_CAP_TON = params.genesis.quest_rewards.lifetime_cap_ton;

/**
 * What one quest pays in PRIMES, at a given floor — and the only place the
 * §9.4 self-funding clamp lives.
 *
 * Every reward is PRIMES-denominated (the last TON one, the story quest, was folded into the
 * social board by D-118's 2026-11-20 amendment). It is `min(nominal, capShare · cap · primesPerTon)`,
 * and the `min` is load-bearing. D-42 fixes the social rewards in PRIMES, which
 * means their TON value climbs with the ratchet forever; left alone, a reward
 * sized at a fraction of a mint today is worth more than `β · MINT_PRICE` in
 * roughly the sim's second year, and from that moment the programme is paying a
 * wallet more than its own gating mint contributed to `T`. That is not a budget
 * overrun, it is §5 stopping being true of quest-paid wallets.
 *
 * This is the same `min(value, stock)` shape `primes_bounty_vault.tolk` already
 * applies to the era schedule, running the other way: there a TON-denominated
 * ceremony is capped in PRIMES so it cannot inflate; here a PRIMES-denominated
 * reward is capped in TON so it cannot either.
 *
 * `params.genesis.quest_rewards.cap_binds_at_floor_price` is where the clamp would
 * bite if the board had the whole cap to itself; the real crossover is lower,
 * because the cap is shared with the contract-fact board. Below it this
 * function is a pure passthrough returning the sim's own whole-PRIMES figure.
 *
 * The clamped branch FLOORS rather than rounds. Rounding could pay one PRIMES over
 * a bound whose whole purpose is to never be crossed, and a bound that is allowed
 * to be crossed by a rounding step is not a bound.
 *
 * Known and accepted: flooring to whole PRIMES loses granularity once the clamp is
 * paying only a handful of them. At ~1,000x the opening floor the board pays 3/3/4
 * PRIMES = 0.50 TON against an allowance of 0.59 — it UNDERPAYS by a sixth. That is
 * the same sub-unit horizon DENOMINATION_PLAN names, it errs in the safe direction,
 * and it sits far beyond the sim's three-year horizon
 * (`shared/params.json` `final_state.floor_appreciation.multiple_over_horizon`,
 * quoted in CLAUDE.md's Measured provenance section). If the floor ever gets
 * there, the fix is another `L` redenomination, not a change here.
 */
export function questRewardPrimes(reward: QuestReward, primesPerTon: number): number {
  const capPrimes = reward.capShare * QUEST_LIFETIME_CAP_TON * primesPerTon;
  return Math.min(reward.primes, Math.floor(capPrimes));
}

/**
 * The TON worth of a reward at a given floor — the display side of `questRewardPrimes`.
 * There is no fixed TON figure (the worth IS the floor path), so this reports the CLAMPED
 * quote; the unclamped nominal is `reward.primes`.
 */
export function questRewardTon(reward: QuestReward, primesPerTon: number): number {
  return questRewardPrimes(reward, primesPerTon) / primesPerTon;
}

export const QUESTS: QuestDef[] = [
  // ---- referral (§9.4: measured by their on-chain mints) ----
  {
    id: "referral-first",
    track: "referral",
    title: "First referred mint",
    description: "Someone minted a number citing your key. The 10% line paid.",
    reward: primeQuestReward("referral-first"),
    target: 1,
    progress: (f) => f.onChain.attributedMints,
    source: "ledger mint events where the rN line paid",
    evidence: "proved",
  },
  {
    id: "referral-five-active",
    track: "referral",
    title: "Five active referees",
    description: "Five different players are minting on your key. Not five clicks — five minters.",
    reward: primeQuestReward("referral-five-active"),
    target: 5,
    progress: (f) => f.onChain.activeReferees,
    source: "ledger mint events, distinct minters on this key",
    evidence: "proved",
  },
  {
    id: "referral-first-gift",
    track: "referral",
    title: "First gift mint",
    description: "You paid for a number and gave it to a named wallet (§4.5).",
    reward: primeQuestReward("referral-first-gift"),
    target: 1,
    progress: (f) => f.onChain.giftMints,
    source: "ledger mint events with a beneficiary",
    evidence: "proved",
  },

  // ---- recruit: BOTH sides of a gift, one track (D-106) ----
  //
  // Four quests where there were seven. The `patron` track's first-mint,
  // first-activation, first-purse and rank-tier quests, and the recruit track's
  // "claim your number", all described steps of a lifecycle D-106 deleted: there
  // is no claim (the number lands owned), no purse, and no activation edge
  // separate from the gift itself. What is left is what actually happens.
  {
    id: "recruit-first",
    track: "recruit",
    title: "Introduce someone",
    description:
      "You minted a number for an address the ledger had never seen. That is a recruit, and it is the only thing that is.",
    reward: primeQuestReward("recruit-first"),
    target: 1,
    progress: (f) => f.onChain.recruitsIntroduced,
    source: "ledger mint events with a beneficiary the ledger had not seen",
    evidence: "proved",
  },
  {
    id: "recruit-rank-tier",
    track: "recruit",
    title: "Recruit rank II",
    description: "Three recruits. Your ceiling rises — §4.7 issues power, not tokens.",
    reward: primeQuestReward("recruit-rank-tier"),
    target: 2,
    progress: (f) => f.onChain.recruitRankTier,
    source: "getRecruitRank(owner).tier",
    evidence: "proved",
  },
  {
    id: "recruit-first-mint",
    track: "recruit",
    title: "Mint your first number",
    description:
      "Your first mint of your own, at the raised ceiling the gift opened. The number you were given cost you nothing; this one is yours.",
    reward: primeQuestReward("recruit-first-mint"),
    target: 1,
    progress: (f) => Math.min(f.onChain.mintsInsideNewcomerWindow, 1),
    source: "getNewcomerWindow(you) — a window unit spent",
    evidence: "proved",
    prerequisite: { label: "be gifted a number first", met: (f) => f.onChain.wasGifted },
  },
  {
    id: "recruit-five-mints",
    track: "recruit",
    title: "Spend the whole newcomer window",
    description:
      "All five of your raised-ceiling mints, used. After this the ceiling is the same as everyone else's — so this is the cheapest the game will ever be for you.",
    reward: primeQuestReward("recruit-five-mints"),
    target: 5,
    progress: (f) => f.onChain.mintsInsideNewcomerWindow,
    source: "getNewcomerWindow(you)",
    evidence: "proved",
    prerequisite: { label: "be gifted a number first", met: (f) => f.onChain.wasGifted },
  },

  // ---- prime (§9.4: "should be the most generously funded") ----
  {
    id: "prime-first",
    track: "prime",
    title: "Find your first prime",
    description: "A prime pays you no rebate at all and ratchets the floor about eleven times harder. You will be named on it forever.",
    reward: primeQuestReward("prime-first"),
    target: 1,
    progress: (f) => f.onChain.primesMinted,
    source: "getMinterState(you).primesMinted",
    evidence: "proved",
  },
  {
    id: "prime-first-tribute",
    track: "prime",
    title: "First tribute on a prime you found",
    description: "Someone factored a composite through your prime and paid you for it.",
    reward: primeQuestReward("prime-first-tribute"),
    target: 1,
    progress: (f) => f.onChain.tributeClaims,
    source: "getOwed(item) credited via claim_tribute",
    evidence: "proved",
    prerequisite: { label: "mint a prime first", met: (f) => f.onChain.primesMinted > 0 },
  },
  {
    id: "prime-rank-tier",
    track: "prime",
    title: "Prime rank II",
    description: "Three primes. Your rebate ceiling rises with them.",
    reward: primeQuestReward("prime-rank-tier"),
    target: 2,
    progress: (f) => f.onChain.primeRankTier,
    source: "getMinterState(you).tier",
    evidence: "proved",
  },

  // ---- game ----
  {
    id: "game-first-tribute-claim",
    track: "game",
    title: "First tribute claim",
    description: "Pull what a prime you own has earned into your wallet.",
    reward: primeQuestReward("game-first-tribute-claim"),
    target: 1,
    progress: (f) => f.onChain.tributeClaims,
    source: "claim_tribute transactions",
    evidence: "proved",
  },
  {
    id: "game-first-lot",
    track: "game",
    // §4.4 / D-45 / D-90: opening a lot takes the number off the sequential line for good,
    // and winning mints it at close -- the head never reaches it.
    title: "Open a lot ahead of the head",
    description: "Bid on a number the line hasn't reached. Win it and it mints to you at close.",
    reward: primeQuestReward("game-first-lot"),
    target: 1,
    progress: (f) => f.onChain.lotsOpened,
    source: "open_lot transactions on the market",
    evidence: "proved",
  },

  // ---- story: voucher-settled, a fifth of the social board (§9.4 / decision 0.2.1, D-118) ----
  {
    id: "story-verified-reach",
    track: "story",
    title: "A story that actually reached someone",
    // D-160: the mint half is checked at KEY granularity, so the copy says "your key",
    // not "one of them" — the index cannot tell which arrival minted.
    description:
      "Twenty arrivals on your story's QR — a bot start or a wallet connected — and at least one paid mint on your key. Reach alone pays nothing here, deliberately: accounts and wallets cost nothing.",
    // D-118 amended 2026-11-20 (owner): a fifth share of the social board's params row, like
    // the four below. It was `ton(legacyPrimes(80))` — a legacy TON figure outside params.json,
    // ~6,191 PRIMES at the genesis floor and unbudgeted in the `quests` track — which the
    // per-wallet voucher cap (audit R2-M2) would have stranded.
    reward: socialReward("story-verified-reach"),
    target: 20,
    progress: (f) => f.offChain.countedStarts,
    // D-213: a QR scan opens the Mini App directly and never sends the bot a /start, so a
    // wallet connected on the label is an arrival too. Farmable, accepted: the mint gate and
    // QUEST_MAX_WALLETS bound it.
    source: "Telegram /start and wallet-connect events tagged with this story's §9.2 source label",
    evidence: "counted",
  },

  // ---- social: §9.4's acquisition funnel, voucher-settled and mint-gated ----
  //
  // These are the quests that exist to bring people in, and they are the ones a
  // farmer would attack, so read the economics before changing a number here.
  // Each pays only after an on-chain mint is attributed to the wallet (the
  // `gateOk` rule in `evaluateQuests`, decision 0.2.1), so the cheapest possible
  // attack is: make a Telegram account, join two chats, spend 1 TON on a mint,
  // and collect a reward the sim sized at a small fraction of that TON. Farming
  // is a loss-making trade by construction, not by policing.
  {
    id: "social-join-channel",
    track: "social",
    title: "Join the announcement channel",
    description:
      `Join ${SOCIAL_CHANNEL}. Checked with Telegram, not taken on your word. Like every social quest, it pays after your first mint through someone's invite link.`,
    reward: socialReward("social-join-channel"),
    target: 1,
    progress: (f) => (f.offChain.channelMember ? 1 : 0),
    source: `Telegram getChatMember on ${SOCIAL_CHANNEL}, called by the bot at issuance`,
    evidence: "counted",
    actionUrl: `https://t.me/${SOCIAL_CHANNEL.slice(1)}`,
  },
  {
    id: "social-join-group",
    track: "social",
    title: "Join the community group",
    description: `Join ${SOCIAL_GROUP}, where the factorizations get argued about.`,
    reward: socialReward("social-join-group"),
    target: 1,
    progress: (f) => (f.offChain.groupMember ? 1 : 0),
    source: `Telegram getChatMember on ${SOCIAL_GROUP}, called by the bot at issuance`,
    evidence: "counted",
    actionUrl: `https://t.me/${SOCIAL_GROUP.slice(1)}`,
  },
  {
    id: "social-stay-7d",
    track: "social",
    title: "Still here a week later",
    description:
      "Stay in both for seven days. Leaving restarts the clock rather than banking it — this one is for people who stayed, not for people who passed through.",
    reward: socialReward("social-stay-7d"),
    target: 7,
    progress: (f) => f.offChain.membershipDays,
    source: "unbroken membership observed by the bot's periodic getChatMember sweep",
    evidence: "counted",
    prerequisite: {
      label: "Join the channel and the group first",
      met: (f) => f.offChain.channelMember && f.offChain.groupMember,
    },
  },
  // D-73 option 3 / D-118: the fourth quarter of the board. Scored from the stored
  // link, not from this request's `initData`, so a browser player who confirmed the
  // link in the bot (D-150) is credited without opening the Mini App.
  {
    id: "connect",
    track: "social",
    title: "Connect Telegram",
    description:
      "Link this wallet to your Telegram account: open PRIMES inside Telegram, or press Connect Telegram on your page and confirm in the bot. Pays on your first mint.",
    reward: socialReward("connect"),
    target: 1,
    progress: (f) => (f.offChain.telegramLinked ? 1 : 0),
    source: "wallet_telegram_links: a verified Mini App request or a link confirmed in the bot (D-150)",
    evidence: "counted",
  },
  // D-41 deliberately has NO "bring a friend" quest here, and the omission is the
  // decision rather than an oversight. §4.1 already pays 10% of every mint to the
  // recruiter, in TON, forever — funded by the FLOW of mints, so it grows with the
  // thing it is buying. A vault-funded bonus on top would spend the scarcest budget
  // in the system (a fixed stock bounded by T₀, see §9.4) duplicating the one reward
  // that needs no budget at all. Recruitment belongs in the UI as the referral line
  // made vivid, not as a second payment for the same event.
];

/** One quest as `/earn` serves it — `@ton-primes/shared/wire`'s shape, the one the webapp reads
 *  (G64). `rewardDenomination` says which of `rewardTon`/`rewardPrimesQuote` is the promise and
 *  which is the quote (D-42); `complete` includes the voucher mint gate; `awaitingAttributedMint`
 *  is the reach-met, no-paid-mint state a naive board would show as a button. */
export type QuestState = QuestStateWire;

/**
 * Each voucher track's mint gate (decision 0.2.1). Two facts, because two signed decisions
 * set two granularities: the story quest is about the SHARER's reach (D-160), the social
 * quests about the player's own mint (J9 option 1).
 */
const VOUCHER_GATE: Partial<Record<QuestTrack, (f: QuestFacts) => boolean>> = {
  story: (f) => f.offChain.keyPaidMint,
  social: (f) => f.offChain.paidReferralMint,
};

/**
 * Evaluate the whole board for one player.
 *
 * The two rules enforced here rather than trusted to the definitions:
 *
 *  1. A voucher-settled quest is never `complete` without its track's on-chain mint
 *     (`VOUCHER_GATE`), however much counted reach it has. Decision 0.2.1.
 *  2. A quest whose prerequisite is unmet reports `lockedBy` and does not report
 *     itself complete, even if its progress figure happens to satisfy the target.
 */
export function evaluateQuests(
  facts: QuestFacts,
  defs: QuestDef[] = QUESTS,
  /**
   * PRIMES per TON to quote rewards at — `S / T` from the ledger's
   * `getRatchetState`. Defaults to the genesis floor so an unauthenticated or
   * chain-less render still shows a real, sourced number rather than a blank.
   * DISPLAY ONLY: nothing that pays money reads it (P4's correctness constraint).
   */
  primesPerTon: number = GENESIS_PRIMES_PER_TON
): QuestState[] {
  return defs.map((def) => {
    const settlement = TRACK_SETTLEMENT[def.track];
    const raw = def.progress(facts);
    const progress = Math.max(0, Math.min(raw, def.target));
    const lockedBy = def.prerequisite && !def.prerequisite.met(facts) ? def.prerequisite.label : undefined;

    const reached = progress >= def.target;
    const gateOk = settlement === "voucher" ? (VOUCHER_GATE[def.track]?.(facts) ?? false) : true;

    // Both figures come from here so they can never disagree, and so the D-42
    // clamp applies to what is DISPLAYED as well as to what is signed for. A
    // board that advertises more than the voucher will pay is the §9.1 problem.
    const rewardPrimesQuote = questRewardPrimes(def.reward, primesPerTon);

    return {
      id: def.id,
      track: def.track,
      title: def.title,
      description: def.description,
      rewardTon: questRewardTon(def.reward, primesPerTon),
      rewardDenomination: def.reward.denomination,
      rewardPrimesQuote,
      quotedAtPrimesPerTon: primesPerTon,
      progress,
      target: def.target,
      complete: reached && !lockedBy && gateOk,
      settlement,
      source: def.source,
      evidence: def.evidence,
      lockedBy,
      awaitingAttributedMint: settlement === "voucher" && reached && !gateOk ? true : undefined,
      actionUrl: def.actionUrl,
    };
  });
}

/**
 * Where a completed voucher quest's TON->PRIMES conversion is FROZEN.
 *
 * ---- Why this interface has to exist (DENOMINATION_PLAN P4) ----
 *
 * The voucher's `cumulative_total` is a HIGH-WATER MARK: primes_voucher.tolk pays
 * `total - paid` and stores the total, so a total that ever decreases pays zero
 * from then on and the difference is STRANDED — not clawed back, stranded.
 *
 * A TON-denominated reward is worth FEWER PRIMES as the floor rises. So if the
 * conversion were done at read time — the obvious implementation, and the one
 * this comment exists to stop — every quest already completed would shrink on
 * every mint, the total would regress, the signer would refuse (correctly), and
 * a player who had earned money would be unable to collect it.
 *
 * Therefore: the conversion happens ONCE, at the moment the quest first reads as
 * complete, and is persisted. `lock` is that write. It is first-write-wins by
 * contract — a later call MUST return the stored figure and ignore its own quote.
 */
export interface QuestRewardLock {
  /**
   * Freeze (or read back) the PRIMES this wallet's completion of `questId` pays.
   *
   * @param quotePrimes the conversion at the CURRENT floor, used only if this is
   *                    the first time this (wallet, quest) pair has completed.
   * @param quotedAtPrimesPerTon the floor that quote was taken at, stored
   *                    alongside it so a reader can check a frozen figure against
   *                    chain state rather than taking the operator's word (§9.1).
   * @returns the persisted amount — the quote on first call, the stored figure
   *          on every call after, whatever the floor has done since.
   */
  lock(
    wallet: string,
    questId: string,
    quotePrimes: number,
    quotedAtPrimesPerTon: number,
    /** The paying voucher instance's raw address: one lock namespace per deployment, so a
     *  fresh genesis starts every wallet clean (review of audit R2-M2). */
    instance: string,
    /** D-213 — the quest's headcount (`QUEST_MAX_WALLETS`). A FIRST lock past it writes nothing
     *  and returns 0; an existing lock always returns its stored figure (a high-water mark
     *  never moves down). */
    maxWallets: number
  ): Promise<number>;
  /** The frozen figure for this (wallet, quest, instance), or undefined if it never completed. */
  lockedPrimes(wallet: string, questId: string, instance: string): Promise<number | undefined>;
}

/**
 * The PRIMES total a player has earned across every VOUCHER-settled quest they
 * have completed. This is the `cumulative_total` a §9.5 voucher carries, and it
 * is deliberately computed from completed quests only — never from progress —
 * because the voucher is a cumulative high-water mark and a total that could ever
 * decrease would strand the difference (primes_voucher.tolk pays `total - paid`
 * and a shrinking total simply pays nothing again).
 *
 * It sums PERSISTED per-quest amounts through `lock`, and never re-derives them
 * from the current floor — see `QuestRewardLock` for what that would cost.
 *
 * `program` picks the instance: `quests` sums the off-chain tracks, `prime_quests` the
 * contract-fact tracks (D-171). The two totals are separate high-water marks, signed
 * under separate tags, and must never be summed into one voucher.
 */
export async function voucherEarnedPrimes(
  wallet: string,
  states: QuestState[],
  lock: QuestRewardLock,
  /** G78b / D-171 — which instance's total this is. Each keeps its own high-water mark. */
  program: VoucherProgram,
  /** That instance's raw address — the lock namespace (see `QuestRewardLock.lock`). */
  instance: string
): Promise<number> {
  // A quest that completed once stays counted even if its live fact has since flipped (left a
  // chat, unlinked, a number transferred away): the signer's high-water mark never moves down,
  // so dropping it made every later total a `total_regressed` refusal — and let a stranger's
  // one-off completion block the wallet's own vouchers (security audit 2026-11-20, lead 5).
  let total = 0;
  for (const q of states) {
    if (TRACK_PROGRAM[q.track] !== program) continue;
    total += q.complete
      ? await lock.lock(wallet, q.id, q.rewardPrimesQuote, q.quotedAtPrimesPerTon, instance, QUEST_MAX_WALLETS[program])
      : ((await lock.lockedPrimes(wallet, q.id, instance)) ?? 0);
  }
  return total;
}

/**
 * The un-persisted version, for RENDERING a board that is not about to be signed
 * for. Same sum, at the floor the board was quoted at, with nothing written.
 *
 * Never pass this to the voucher signer. The name is long on purpose.
 */
export function quotedVoucherPrimes(states: QuestState[], program: VoucherProgram = "quests"): number {
  return states
    .filter((q) => TRACK_PROGRAM[q.track] === program && q.complete)
    .reduce((sum, q) => sum + q.rewardPrimesQuote, 0);
}

/**
 * Everything one wallet can earn from VOUCHER-settled quests, in TON, if it
 * completes every one of them.
 *
 * This is the figure `QUEST_LIFETIME_CAP_TON` bounds, and the test that compares
 * the two is the one thing standing between a future quest addition and a program
 * that pays a wallet more than its own mint put into `T`. Contract-settled quests
 * are excluded because the chain pays those from facts it verifies itself; they
 * are not a claim on the vault and not a claim on anyone's backing.
 */
export function questCeilingTon(
  defs: QuestDef[] = QUESTS,
  /**
   * The floor to evaluate at. Defaults to genesis, but under D-42 the interesting
   * question is what the board is worth at a MUCH higher floor — a PRIMES-
   * denominated reward's TON value is the floor path, so a genesis-only check
   * would pass forever while the real payout climbed past the cap. The test
   * sweeps this argument; that sweep is what the clamp is verified by.
   */
  primesPerTon: number = GENESIS_PRIMES_PER_TON
): number {
  // Every track since D-171: both voucher instances draw on the vault, so both boards
  // count against the one lifetime cap.
  return defs.reduce((sum, d) => sum + questRewardTon(d.reward, primesPerTon), 0);
}

/** Empty facts — the keyless visitor's board, so `/earn` can render it unauthenticated. */
export function emptyQuestFacts(): QuestFacts {
  return {
    onChain: {
      mintCount: 0,
      primesMinted: 0,
      primeRankTier: 0,
      recruitsIntroduced: 0,
      recruitRankTier: 0,
      wasGifted: false,
      newcomerWindowLeft: 0,
      mintsInsideNewcomerWindow: 0,
      tributeClaims: 0,
      lotsOpened: 0,
      giftMints: 0,
      attributedMints: 0,
      activeReferees: 0,
    },
    offChain: {
      countedStarts: 0,
      keyPaidMint: false,
      paidReferralMint: false,
      channelMember: false,
      groupMember: false,
      membershipDays: 0,
      telegramLinked: false,
    },
  };
}
